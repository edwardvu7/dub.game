'use strict';
// Grok voice casting: one call per character (or one batched call for the launch list).
// Grok never reads game text live; it only builds profiles. It is asked for JSON in the prompt and
// sanitizeProfile is the validator: nothing it says is trusted as-is.
const crypto = require('node:crypto');
const { callGrokJson } = require('./xai');

const TIMEOUT_MS = 20000; // a stalled call must not silence a character for minutes
const GENDERS = ['female', 'male', 'neutral'];
const AGES = ['child', 'teen', 'young_adult', 'adult', 'elder'];
const BATCH = 12;

const clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : dflt);
const round2 = (n) => Math.round(n * 100) / 100;

const SHAPE = '{"speaker":"","gender":"","age_range":"","personality":"","voice_id":"","stability":0.5,"style":0.3,"speed":1.0,"reason":""}';

function prompt(characters, catalog, opts) {
  const voices = catalog.map((v) => `- ${v.voice_id}: ${v.name} - ${v.description}`).join('\n');
  const cast = characters.map((c) => {
    const lines = (c.samples || []).slice(0, 6).map((s) => `    "${s}"`).join('\n');
    // notes: what is known about the character (from the Grok cast lookup), trusted over guesses.
    const known = (c.notes ? `    Known about them: ${c.notes}\n` : '') + (c.origin ? `    Origin: ${c.origin}\n` : '') +
      (c.speech ? `    How they speak: ${c.speech}\n` : '');
    return `- ${c.speaker}\n${known}${lines || '    (no sample lines; judge from the name)'}`;
  }).join('\n');
  const game = characters.find((c) => c.game);
  const setting = (characters.find((c) => c.setting) || {}).setting;
  const avoid = opts.avoidVoiceId ? `\nThe player disliked voice ${opts.avoidVoiceId}; pick a different one.\n` : '';
  const many = characters.length > 1;
  return [
    'You are casting voice actors for a visual novel.',
    // Grok often knows popular games already: naming the game helps even without a lookup.
    game ? `The characters are from the game "${game.game}". Use what you know about it and them.` : '',
    setting ? `Researched setting of the game: ${setting}` : '',
    setting ? 'Choose the catalog voice whose accent and description best match this setting and each character\'s origin. Do NOT default to British or Australian voices unless the setting or that character is British or Australian. If nothing matches closely, choose the most neutral or American-sounding voice, never an accent that contradicts the setting. In "reason", say how the voice fits the researched setting or origin.' : '',
    many
      ? 'For each character below, infer a profile from the name and sample lines and pick the best voice. Return one profile per character, with "speaker" copied exactly. Give different characters different voices where the catalog allows.'
      : 'Infer a profile for the character below from the name and sample lines and pick the best voice. Copy "speaker" exactly.',
    'Pick the catalog voice that best matches the character\'s gender, age and personality; "Known about them" notes beat guesses.',
    'voice_id must be one of the catalog IDs. stability 0.3-0.7, style 0.0-0.6, speed 0.9-1.1 unless the character clearly calls for more.',
    `gender is one of ${GENDERS.join(', ')}. age_range is one of ${AGES.join(', ')}. personality and reason are one sentence each.`,
    'Reply with JSON only, no other text, in exactly this shape:',
    many ? `{"profiles":[${SHAPE}]}` : SHAPE,
    avoid,
    'Voice catalog:', voices, '',
    many ? 'Characters:' : 'Character:', cast,
  ].join('\n');
}

// Deterministic pick so a character keeps the same voice when Grok is unavailable.
function fallbackVoice(speaker, catalog) {
  const h = crypto.createHash('sha1').update(String(speaker)).digest();
  return catalog[h.readUInt32BE(0) % catalog.length];
}

function fallbackProfile(speaker, catalog, why) {
  const v = fallbackVoice(speaker, catalog);
  return {
    speaker, gender: 'neutral', age_range: 'adult', personality: 'Not profiled yet.',
    voice_id: v.voice_id, stability: 0.5, style: 0.3, speed: 1.0,
    reason: `Placeholder voice (${why || 'Grok unavailable'}). Re-roll once a Grok key is set.`,
    locked: false, source: 'fallback',
  };
}

/** Force a raw model object into a valid profile for `speaker`. Never trusts voice_id blindly. */
const short = (v, n) => String(v == null || typeof v === 'object' ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** origin/speech come from the cast research (`known`), never from the model's reply. */
function noteFields(known) {
  const out = {};
  const origin = short(known && known.origin, 80);
  const speech = short(known && known.speech, 160);
  if (origin) out.origin = origin;
  if (speech) out.speech = speech;
  return out;
}

function sanitizeProfile(raw, speaker, catalog, known) {
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
    source: 'grok',
    ...noteFields(known),
  };
}

const ask = (characters, catalog, key, opts, doFetch) => callGrokJson({
  key, input: prompt(characters, catalog, opts), timeout: TIMEOUT_MS, fetch: doFetch,
});

/** profileCharacter({speaker, samples}, catalog, key, {fetch?, avoidVoiceId?}) -> Promise<profile> */
async function profileCharacter(character, catalog, key, deps = {}) {
  const raw = await ask([character], catalog, key, { avoidVoiceId: deps.avoidVoiceId }, deps.fetch);
  return sanitizeProfile(raw, character.speaker, catalog, character);
}

/**
 * profileCharacters([{speaker, samples}], catalog, key, {fetch?}) -> Promise<profile[]>
 * Batched (12 per call) so a whole cast fits inside one reply.
 * A character the model skipped is simply missing from the result.
 */
async function profileCharacters(characters, catalog, key, deps = {}) {
  const out = [];
  for (let i = 0; i < characters.length; i += BATCH) {
    const chunk = characters.slice(i, i + BATCH);
    let raw;
    try {
      raw = await ask(chunk, catalog, key, { batch: true }, deps.fetch);
    } catch (e) {
      if (!out.length) throw e;
      break; // keep the batches that worked; the rest get placeholders
    }
    const list = raw && Array.isArray(raw.profiles) ? raw.profiles : [];
    for (const c of chunk) {
      const match = list.find((p) => p && p.speaker === c.speaker) ||
        list.find((p) => p && String(p.speaker || '').trim().toLowerCase() === c.speaker.toLowerCase());
      if (match) out.push(sanitizeProfile(match, c.speaker, catalog, c));
    }
  }
  return out;
}

const VOICE_DESC_MAX = 600;

/** Prompt asking Grok for an ElevenLabs Voice Design description. profile: gender/age_range/personality/origin/speech. */
function buildVoiceDescriptionPrompt(profile, notes, setting) {
  const p = profile || {};
  return [
    'Write a text description of a voice for an AI voice designer (a text-to-voice tool). It is for a visual novel character.',
    `Character: ${short(p.speaker, 80)}${p.game ? ` from "${short(p.game, 80)}"` : ''}`,
    `Gender: ${short(p.gender, 20) || 'unknown'}. Age: ${short(p.age_range, 20) || 'adult'}.`,
    p.personality ? `Personality: ${short(p.personality, 300)}` : '',
    p.origin ? `Origin: ${short(p.origin, 80)}` : '',
    p.speech ? `How they speak: ${short(p.speech, 160)}` : '',
    notes ? `Known about them: ${short(notes, 400)}` : '',
    setting ? `Setting of the game: ${short(setting, 300)}` : '',
    'Describe age, gender, accent, tone, pitch, pacing and emotional color in one or two sentences, 150-400 characters.',
    'The accent must fit the character\'s origin and the game\'s setting. Do NOT use a British or Australian accent unless that fits; if unknown, use a neutral American accent.',
    'Never name a real person, actor or celebrity and never ask for a soundalike.',
    'Do not mention the character\'s name, the game\'s title, or any age under 18: describe young characters as a young adult with a light, youthful voice.',
    'Reply with JSON only: {"description": "..."}',
  ].filter(Boolean).join('\n');
}

/** Deterministic description from the profile alone (Grok failed). */
function fallbackVoiceDescription(profile) {
  const p = profile || {};
  // Children and teens are described as young adults with a light voice: voices of minors may be refused.
  const age = { child: 'young adult', teen: 'young adult', young_adult: 'young adult', adult: 'adult', elder: 'elderly' }[p.age_range] || 'adult';
  const light = p.age_range === 'child' || p.age_range === 'teen' ? ' with a light, youthful voice' : '';
  const g = (p.gender === 'female' ? 'woman' : p.gender === 'male' ? 'man' : 'person') + light;
  const accent = p.origin ? `with an accent fitting ${short(p.origin, 60)}` : 'with a neutral American accent';
  const tone = p.speech ? short(p.speech, 160) : p.personality ? short(p.personality, 160) : 'natural, conversational tone';
  const t = /[.!?]$/.test(tone) ? tone : tone + '.';
  return `A ${age} ${g} ${accent}. Tone and manner: ${t} Clear, natural pacing.`.slice(0, VOICE_DESC_MAX);
}

/** Parse Grok's reply; null when unusable (not an object, too short or too long to be useful). */
function parseVoiceDescription(raw) {
  const d = short(raw && raw.description, VOICE_DESC_MAX + 1);
  return d.length >= 20 && d.length <= VOICE_DESC_MAX ? d : null;
}

/** voiceDescription(profile, notes, setting, key, {fetch?}) -> {description, source: 'grok'|'fallback'} */
async function voiceDescription(profile, notes, setting, key, deps = {}) {
  try {
    const raw = await callGrokJson({ key, input: buildVoiceDescriptionPrompt(profile, notes, setting), timeout: TIMEOUT_MS, fetch: deps.fetch });
    const d = parseVoiceDescription(raw);
    if (d) return { description: d, source: 'grok' };
  } catch { /* fall through */ }
  return { description: fallbackVoiceDescription(profile), source: 'fallback' };
}

module.exports = { buildVoiceDescriptionPrompt, parseVoiceDescription, fallbackVoiceDescription, voiceDescription, profileCharacter, profileCharacters, sanitizeProfile, fallbackProfile, prompt, GENDERS, AGES };
