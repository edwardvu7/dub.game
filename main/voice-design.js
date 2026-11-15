'use strict';
// EXPERIMENTAL: create a custom ElevenLabs voice from a text description (Voice Design).
// Two calls: POST /v1/text-to-voice/design (previews) then POST /v1/text-to-voice (keep the first one).
// Main process only; the key never leaves it and is never logged.
// Sources: elevenlabs.io/docs/api-reference/text-to-voice/design and .../text-to-voice/create.
const { OUTPUT_FORMAT } = require('./tts');
const API = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 60000;
// UNVERIFIED: 20-1000 characters comes from a search summary of the docs; the fetched reference page lists no limit.
const DESC_MIN = 20;
const DESC_MAX = 1000;
const NAME_MAX = 100; // UNVERIFIED: the API documents no limit for voice_name; kept short on purpose

const clean = (s) => String(s == null || typeof s === 'object' ? '' : s).replace(/\s+/g, ' ').trim();

// Words that describe a minor. ElevenLabs does not allow child-like voices in its library and may
// refuse such prompts, so ages are lifted to young adult. UNVERIFIED: that Voice Design refuses them.
const MINOR_WORDS = [
  [/\b(?:teen(?:age|aged)?|adolescent|high[- ]school(?:er)?|school ?(?:girl|boy)|underage|minor)\b/gi, 'young adult'],
  [/\blittle (girl|sister|daughter)\b/gi, 'young woman'], [/\blittle (boy|brother|son)\b/gi, 'young man'],
  [/\b(?:girl)s?\b/gi, 'young woman'], [/\b(?:boy)s?\b/gi, 'young man'],
  [/\b(?:child|children|kid|kids|childlike|child-like|toddler|baby)\b/gi, 'youthful'],
];

/**
 * A description the API accepts: no minor-age words, no character or game names (avoid), whitespace
 * folded, capped, padded when too short.
 */
function sanitizeDescription(raw, avoid = []) {
  let d = clean(raw);
  for (const [re, to] of MINOR_WORDS) d = d.replace(re, to);
  for (const name of avoid) {
    const n = clean(name);
    if (n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "named Sayori", "from the game "Title"", or the bare name: dropped with its lead-in word.
    d = d.replace(new RegExp(`\\s*\\b(?:named|called|from|in|of)?\\s*(?:the game\\s*)?["'“]?${esc}["'”]?${/\w$/.test(n) ? '\\b' : ''}`, 'gi'), '');
  }
  d = d.replace(/\byoung adult (young (?:woman|man))\b/gi, '$1')
    .replace(/\b(young adult|youthful)( (?:young adult|youthful))+\b/gi, '$1')
    .replace(/\s+([,.;])/g, '$1').replace(/\s+/g, ' ').trim()
    .replace(/^(is|has|speaks|sounds|talks)\b/i, 'This character $1').slice(0, DESC_MAX);
  if (d.length < DESC_MIN) d = (d + ' Clear, natural speaking voice.').trim().slice(0, DESC_MAX);
  return d;
}

/** "dubplay <Game> - <Speaker>", capped. */
function voiceName(game, speaker) {
  const g = clean(game), s = clean(speaker) || 'Character';
  return (`dubplay ${g ? g + ' - ' : ''}${s}`).slice(0, NAME_MAX);
}

const STEP = { 1: 'Voice Design (step 1/2)', 2: 'saving the voice (step 2/2)' };

async function errorText(res, step = 1) {
  let detail = '';
  let code = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      const d = j.detail;
      // detail.code (current) or detail.status (legacy) names the cause: missing_permissions, feature_not_available...
      code = String((d && (d.code || d.status)) || '');
      detail = (d && d.message) || (typeof d === 'string' ? d : '') ||
        (Array.isArray(d) && d[0] && d[0].msg) || j.message || '';
    } catch { detail = raw.slice(0, 200); }
  } catch { /* no body */ }
  detail = String(detail).slice(0, 200).replace(/\.$/, '');
  const why = detail || code ? ` ElevenLabs says: ${[code, detail].filter(Boolean).join(': ')}.` : '';
  let msg;
  let hard = true; // the same call will keep failing: stop retrying
  if (/permission/i.test(code + ' ' + detail)) {
    // A restricted key: speech works, Voice Design does not.
    msg = `Your ElevenLabs API key is not allowed to design voices (${res.status}).${why} In ElevenLabs, open Developers > API Keys, edit this key and turn on Voice Generation and Voices (write), or make it unrestricted. Then save the key here again.`;
  } else if (res.status === 401 || res.status === 403) {
    // The cause cannot be known without a live call. Our requests follow the documented shape (xi-api-key,
    // JSON body, voice_description 20-1000 chars), so the likeliest causes are plan and key.
    // UNVERIFIED: that Voice Design needs a paid plan, and the dashboard names of key permissions.
    msg = `ElevenLabs refused ${STEP[step]} (${res.status}).${why} Check that your ElevenLabs plan includes Voice Design / text-to-voice (free and some lower tiers may not) and that you have a free custom-voice slot. If the key is restricted, it also needs Voices (write) permission.`;
  } else if (res.status === 402 || res.status === 429 || /quota|limit|slot|subscription|upgrade/i.test(detail)) {
    msg = `ElevenLabs ${res.status} during ${STEP[step]}.${why} Your ElevenLabs plan may not allow more custom voices or credits. Check your plan and voice slots.`;
  } else {
    msg = `ElevenLabs ${res.status} during ${STEP[step]}${detail ? ': ' + detail : ''}`;
    hard = false;
  }
  return Object.assign(new Error(msg), { hard, status: res.status, code });
}

function createVoiceDesigner({ settings, fetch: doFetch = globalThis.fetch, log = () => {} }) {
  async function post(url, key, body, step) {
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? 'ElevenLabs did not answer within 60 seconds.'
        : 'Could not reach ElevenLabs: ' + (e && e.message));
    }
    if (!res.ok) throw await errorText(res, step);
    return res.json();
  }

  /**
   * previews({description, avoid?}) -> {description, previews: [{id, mime, data}]}: ElevenLabs makes a
   * few versions of the voice (step 1). Nothing is saved yet; data is base64 audio to audition.
   */
  async function previews({ description, avoid = [] } = {}) {
    const key = settings.getKey('elevenlabs');
    if (!key) throw Object.assign(new Error('No ElevenLabs API key. Add one in Settings.'), { hard: true });
    const voice_description = sanitizeDescription(description, avoid);
    log(`voice design prompt: ${voice_description}`); // printed so a refused prompt can be read
    const designed = await post(`${API}/v1/text-to-voice/design?output_format=${OUTPUT_FORMAT}`, key, {
      voice_description,
      auto_generate_text: true, // the API writes a sample line that suits the voice
      // Quality over variety, and a fuller prompt: designed voices sounded thin with the defaults.
      // UNVERIFIED: how much each helps; documented as "better output, less variety" and "expands the description".
      quality: 0.6,
      should_enhance: true,
      loudness: 0.5, // the documented default, sent explicitly so every designed voice starts level
    }, 1);
    const list = (designed && Array.isArray(designed.previews) ? designed.previews : [])
      .filter((p) => p && typeof p.generated_voice_id === 'string' && p.generated_voice_id)
      .slice(0, 3)
      .map((p) => ({ id: p.generated_voice_id, mime: p.media_type || 'audio/mpeg',
        data: typeof p.audio_base_64 === 'string' ? p.audio_base_64 : '' }));
    if (!list.length) throw new Error('ElevenLabs returned no voice preview.');
    return { description: voice_description, previews: list };
  }

  /** save({id, description, name}) -> {voice_id, name, description}: keeps one preview as a voice (step 2). */
  async function save({ id, description, name } = {}) {
    const key = settings.getKey('elevenlabs');
    if (!key) throw Object.assign(new Error('No ElevenLabs API key. Add one in Settings.'), { hard: true });
    const voice_name = clean(name).slice(0, NAME_MAX) || 'dubplay voice';
    const voice_description = sanitizeDescription(description);
    const created = await post(`${API}/v1/text-to-voice`, key, {
      voice_name, voice_description, generated_voice_id: String(id),
    }, 2);
    if (!created || typeof created.voice_id !== 'string' || !/^[A-Za-z0-9]+$/.test(created.voice_id)) {
      throw new Error('ElevenLabs did not return a voice id.');
    }
    log(`designed voice ${voice_name} -> ${created.voice_id}`);
    return { voice_id: created.voice_id, name: voice_name, description: voice_description };
  }

  /** design({description, name, avoid?}): automatic path, keeps the first preview without asking. */
  async function design({ description, name, avoid = [] } = {}) {
    const made = await previews({ description, avoid });
    return save({ id: made.previews[0].id, description: made.description, name });
  }

  /**
   * remove(voice_id) -> boolean: DELETE /v1/voices/{id}, freeing a custom-voice slot. Best effort: never
   * throws; true when the voice is gone (404 counts). UNVERIFIED against a live account.
   */
  async function remove(voiceId) {
    const key = settings.getKey('elevenlabs');
    if (!key || typeof voiceId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(voiceId)) return false;
    try {
      const res = await doFetch(`${API}/v1/voices/${voiceId}`, {
        method: 'DELETE', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok || res.status === 404) { log(`deleted voice ${voiceId}`); return true; }
      log(`could not delete voice ${voiceId}: ElevenLabs ${res.status}`);
    } catch (e) { log(`could not delete voice ${voiceId}: ${e && e.message}`); }
    return false;
  }

  return { design, previews, save, remove };
}

module.exports = { createVoiceDesigner, sanitizeDescription, voiceName, DESC_MIN, DESC_MAX, NAME_MAX };
