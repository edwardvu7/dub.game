'use strict';
// EXPERIMENTAL: create a custom ElevenLabs voice from a text description (Voice Design).
// Two calls: POST /v1/text-to-voice/design (previews) then POST /v1/text-to-voice (keep the first one).
// Main process only; the key never leaves it and is never logged.
// Sources: elevenlabs.io/docs/api-reference/text-to-voice/design and .../text-to-voice/create.
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
    d = d.replace(new RegExp(`\\s*\\b(?:named|called|from|in|of)?\\s*(?:the game\\s*)?["'“]?${esc}["'”]?`, 'gi'), '');
  }
  d = d.replace(/\byoung adult (young (?:woman|man))\b/gi, '$1')
    .replace(/\b(young adult|youthful)( (?:young adult|youthful))+\b/gi, '$1')
    .replace(/\s+([,.;])/g, '$1').replace(/\s+/g, ' ').trim()
    .replace(/^(is|has|speaks|sounds|talks)\b/i, 'This character $1').slice(0, DESC_MAX);
  if (d.length < DESC_MIN) d = (d + ' Clear, natural speaking voice.').trim().slice(0, DESC_MAX);
  return d;
}

/** "dub.game <Game> - <Speaker>", capped. */
function voiceName(game, speaker) {
  const g = clean(game), s = clean(speaker) || 'Character';
  return (`dub.game ${g ? g + ' - ' : ''}${s}`).slice(0, NAME_MAX);
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

  /** design({description, name, avoid?}) -> {voice_id, name, description}. avoid: names kept out of the prompt. */
  async function design({ description, name, avoid = [] } = {}) {
    const key = settings.getKey('elevenlabs');
    if (!key) throw Object.assign(new Error('No ElevenLabs API key. Add one in Settings.'), { hard: true });
    const voice_description = sanitizeDescription(description, avoid);
    const voice_name = clean(name).slice(0, NAME_MAX) || 'dub.game voice';
    log(`voice design prompt: ${voice_description}`); // printed so a refused prompt can be read
    const designed = await post(`${API}/v1/text-to-voice/design?output_format=mp3_44100_64`, key, {
      voice_description,
      auto_generate_text: true, // the preview sample is never played here; the API writes its own
    }, 1);
    const first = designed && Array.isArray(designed.previews) && designed.previews[0];
    if (!first || typeof first.generated_voice_id !== 'string' || !first.generated_voice_id) {
      throw new Error('ElevenLabs returned no voice preview.');
    }
    const created = await post(`${API}/v1/text-to-voice`, key, {
      voice_name, voice_description, generated_voice_id: first.generated_voice_id,
    }, 2);
    if (!created || typeof created.voice_id !== 'string' || !/^[A-Za-z0-9]+$/.test(created.voice_id)) {
      throw new Error('ElevenLabs did not return a voice id.');
    }
    log(`designed voice ${voice_name} -> ${created.voice_id}`);
    return { voice_id: created.voice_id, name: voice_name, description: voice_description };
  }

  return { design };
}

module.exports = { createVoiceDesigner, sanitizeDescription, voiceName, DESC_MIN, DESC_MAX, NAME_MAX };
