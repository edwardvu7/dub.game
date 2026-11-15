'use strict';
// Gemini voice casting: one call per character (or one batched call for the launch list).
// Gemini never reads game text live; it only builds profiles.
const crypto = require('node:crypto');

// gemini-2.5-flash was retired for new API keys (Nov 2026). A GEMINI_MODEL environment variable
// overrides this without a code change if Google retires this one too.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const TIMEOUT_MS = 20000; // a stalled call must not silence a character for minutes
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GENDERS = ['female', 'male', 'neutral'];
const AGES = ['child', 'teen', 'young_adult', 'adult', 'elder'];
const BATCH = 12;

const clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : dflt);
const round2 = (n) => Math.round(n * 100) / 100;

function profileSchema(catalog) {
  return {
    type: 'OBJECT',
    properties: {
      speaker: { type: 'STRING' },
      gender: { type: 'STRING', enum: GENDERS },
      age_range: { type: 'STRING', enum: AGES },
      personality: { type: 'STRING', description: 'One sentence.' },
      voice_id: { type: 'STRING', enum: catalog.map((v) => v.voice_id) },
      stability: { type: 'NUMBER', description: '0.0-1.0. Lower is more expressive.' },
      style: { type: 'NUMBER', description: '0.0-1.0. Higher is more dramatic.' },
      speed: { type: 'NUMBER', description: '0.7-1.2. 1.0 is normal pace.' },
      reason: { type: 'STRING', description: 'One sentence: why this voice.' },
    },
    required: ['speaker', 'gender', 'age_range', 'personality', 'voice_id', 'stability', 'style', 'speed', 'reason'],
    propertyOrdering: ['speaker', 'gender', 'age_range', 'personality', 'voice_id', 'stability', 'style', 'speed', 'reason'],
  };
}

function prompt(characters, catalog, opts) {
  const voices = catalog.map((v) => `- ${v.voice_id}: ${v.name} - ${v.description}`).join('\n');
  const cast = characters.map((c) => {
    const lines = (c.samples || []).slice(0, 6).map((s) => `    "${s}"`).join('\n');
    // notes: what is known about the character (from the Grok cast lookup), trusted over guesses.
    const known = c.notes ? `    Known about them: ${c.notes}\n` : '';
    return `- ${c.speaker}\n${known}${lines || '    (no sample lines; judge from the name)'}`;
  }).join('\n');
  const game = characters.find((c) => c.game);
  const avoid = opts.avoidVoiceId ? `\nThe player disliked voice ${opts.avoidVoiceId}; pick a different one.\n` : '';
  const many = characters.length > 1;
  return [
    'You are casting voice actors for a visual novel.',
    // Gemini often knows popular games already: naming the game helps even without a lookup.
    game ? `The characters are from the game "${game.game}". Use what you know about it and them.` : '',
    many
      ? 'For each character below, infer a profile from the name and sample lines and pick the best voice. Return one profile per character, with "speaker" copied exactly. Give different characters different voices where the catalog allows.'
      : 'Infer a profile for the character below from the name and sample lines and pick the best voice. Copy "speaker" exactly.',
    'voice_id must be one of the catalog IDs. stability 0.3-0.7, style 0.0-0.6, speed 0.9-1.1 unless the character clearly calls for more.',
    avoid,
    'Voice catalog:', voices, '',
    many ? 'Characters:' : 'Character:', cast,
  ].join('\n');
}

/** buildRequest(characters[], catalog, {batch?, avoidVoiceId?}) -> {url, body} */
function buildRequest(characters, catalog, opts = {}) {
  const single = profileSchema(catalog);
  const responseSchema = opts.batch
    ? { type: 'OBJECT', properties: { profiles: { type: 'ARRAY', items: single } }, required: ['profiles'] }
    : single;
  return {
    url: ENDPOINT,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt(characters, catalog, opts) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
        // Ignored by Gemini 3.x models (Google's docs); kept for older models set via GEMINI_MODEL.
        temperature: opts.avoidVoiceId ? 1.0 : 0.6,
        // UNVERIFIED: "low" is the fastest thinking level on Gemini 3.x; profiling needs little reasoning.
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
  };
}

// Deterministic pick so a character keeps the same voice when Gemini is unavailable.
function fallbackVoice(speaker, catalog) {
  const h = crypto.createHash('sha1').update(String(speaker)).digest();
  return catalog[h.readUInt32BE(0) % catalog.length];
}

function fallbackProfile(speaker, catalog, why) {
  const v = fallbackVoice(speaker, catalog);
  return {
    speaker, gender: 'neutral', age_range: 'adult', personality: 'Not profiled yet.',
    voice_id: v.voice_id, stability: 0.5, style: 0.3, speed: 1.0,
    reason: `Placeholder voice (${why || 'Gemini unavailable'}). Re-roll once a Gemini key is set.`,
    locked: false, source: 'fallback',
  };
}

/** Force a raw model object into a valid profile for `speaker`. Never trusts voice_id blindly. */
function sanitizeProfile(raw, speaker, catalog) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ids = catalog.map((v) => v.voice_id);
  return {
    speaker,
    gender: GENDERS.includes(r.gender) ? r.gender : 'neutral',
    age_range: AGES.includes(r.age_range) ? r.age_range : 'adult',
    personality: String(r.personality || '').slice(0, 300),
    voice_id: ids.includes(r.voice_id) ? r.voice_id : fallbackVoice(speaker, catalog).voice_id,
    stability: round2(clamp(r.stability, 0, 1, 0.5)),
    style: round2(clamp(r.style, 0, 1, 0.3)),
    speed: round2(clamp(r.speed, 0.7, 1.2, 1)),
    reason: String(r.reason || '').slice(0, 300),
    locked: false,
    source: 'gemini',
  };
}

async function callGemini(request, key, doFetch) {
  if (!key) throw new Error('No Gemini API key. Add one in Settings.');
  const res = await doFetch(request.url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* no body */ }
    throw new Error(`Gemini ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const json = await res.json();
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
  if (!text) throw new Error('Gemini returned no text' +
    (json && json.promptFeedback && json.promptFeedback.blockReason ? ` (${json.promptFeedback.blockReason})` : ''));
  try { return JSON.parse(text); } catch { throw new Error('Gemini returned invalid JSON'); }
}

/** profileCharacter({speaker, samples}, catalog, key, {fetch?, avoidVoiceId?}) -> Promise<profile> */
async function profileCharacter(character, catalog, key, deps = {}) {
  const request = buildRequest([character], catalog, { avoidVoiceId: deps.avoidVoiceId });
  const raw = await callGemini(request, key, deps.fetch || globalThis.fetch);
  return sanitizeProfile(raw, character.speaker, catalog);
}

/**
 * profileCharacters([{speaker, samples}], catalog, key, {fetch?}) -> Promise<profile[]>
 * Batched (12 per call) so a whole cast fits inside Gemini's free-tier rate limit.
 * A character the model skipped is simply missing from the result.
 */
async function profileCharacters(characters, catalog, key, deps = {}) {
  const out = [];
  for (let i = 0; i < characters.length; i += BATCH) {
    const chunk = characters.slice(i, i + BATCH);
    let raw;
    try {
      raw = await callGemini(buildRequest(chunk, catalog, { batch: true }), key, deps.fetch || globalThis.fetch);
    } catch (e) {
      if (!out.length) throw e;
      break; // keep the batches that worked; the rest get placeholders
    }
    const list = raw && Array.isArray(raw.profiles) ? raw.profiles : [];
    for (const c of chunk) {
      const match = list.find((p) => p && p.speaker === c.speaker) ||
        list.find((p) => p && String(p.speaker || '').trim().toLowerCase() === c.speaker.toLowerCase());
      if (match) out.push(sanitizeProfile(match, c.speaker, catalog));
    }
  }
  return out;
}

/** testKey(key, {fetch?}) -> {ok, error?}. Lists one model: no tokens spent. */
async function testKey(key, deps = {}) {
  if (!key) return { ok: false, error: 'No key saved.' };
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`,
      { headers: { 'x-goog-api-key': key } });
    if (res.ok) return { ok: true };
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* no body */ }
    return { ok: false, error: `Gemini ${res.status}${detail ? ': ' + detail : ''}` };
  } catch (e) {
    return { ok: false, error: 'Could not reach Gemini: ' + e.message };
  }
}

module.exports = { profileCharacter, profileCharacters, buildRequest, sanitizeProfile, fallbackProfile,
  profileSchema, testKey, callGemini, prompt, MODEL, ENDPOINT, GENDERS, AGES };
