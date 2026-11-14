'use strict';
// ElevenLabs text-to-speech. Runs in the main process only; the key never leaves it.
const API = 'https://api.elevenlabs.io';
const MODEL = 'eleven_flash_v2_5'; // fastest model
const OUTPUT_FORMAT = 'mp3_44100_128';
const MIME = 'audio/mpeg';

const clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : dflt);

function buildRequest({ text, voice_id, stability, style, speed }) {
  if (!voice_id || !/^[A-Za-z0-9]+$/.test(voice_id)) throw new Error('tts: bad voice_id');
  return {
    url: `${API}/v1/text-to-speech/${voice_id}?output_format=${OUTPUT_FORMAT}`,
    body: {
      text: String(text),
      model_id: MODEL,
      // UNVERIFIED: flash v2.5 is believed to ignore `style`; `speed` is accepted in 0.7-1.2.
      voice_settings: {
        stability: clamp(stability, 0, 1, 0.5),
        similarity_boost: 0.75,
        style: clamp(style, 0, 1, 0),
        speed: clamp(speed, 0.7, 1.2, 1),
      },
    },
  };
}

async function errorText(res) {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      const d = j.detail;
      detail = (d && (d.message || d.status)) || (typeof d === 'string' ? d : '') || j.message || '';
    } catch { detail = raw.slice(0, 200); }
  } catch { /* no body */ }
  return `ElevenLabs ${res.status}${detail ? ': ' + detail : ''}`;
}

/** speak({text, voice_id, stability, style, speed}, key, {fetch?}) -> Promise<Buffer> (mp3) */
async function speak(params, key, deps = {}) {
  if (!key) throw new Error('No ElevenLabs API key. Add one in Settings.');
  const doFetch = deps.fetch || globalThis.fetch;
  const { url, body } = buildRequest(params);
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: MIME },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return Buffer.from(await res.arrayBuffer());
}

/** testKey(key, {fetch?}) -> {ok, error?}. One tiny call that spends no credits. */
async function testKey(key, deps = {}) {
  if (!key) return { ok: false, error: 'No key saved.' };
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    // UNVERIFIED: /v1/user needs the "user read" permission; a key restricted to text-to-speech
    // answers 401 "missing_permissions", which still proves the key itself is valid.
    const res = await doFetch(`${API}/v1/user`, { headers: { 'xi-api-key': key } });
    if (res.ok) return { ok: true };
    const msg = await errorText(res);
    if (res.status === 401 && /missing_permissions/i.test(msg)) return { ok: true };
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: 'Could not reach ElevenLabs: ' + e.message };
  }
}

/**
 * subscription(key, {fetch?}) -> {ok, used, limit, resetAt?} | {ok:false, error}
 * How many characters of the account's quota are used this billing period. Free to call.
 * UNVERIFIED: needs the key's "user read" permission; a text-to-speech-only key gets 401.
 */
async function subscription(key, deps = {}) {
  if (!key) return { ok: false, error: 'No ElevenLabs key.' };
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const res = await doFetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': key } });
    if (!res.ok) {
      const msg = await errorText(res);
      if (res.status === 401 && /missing_permissions/i.test(msg)) {
        return { ok: false, error: 'This key cannot read your plan. Give it the "User: read" permission on ElevenLabs to see it here.' };
      }
      return { ok: false, error: msg };
    }
    const j = await res.json();
    const used = Number(j.character_count);
    const limit = Number(j.character_limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) return { ok: false, error: 'Unexpected reply from ElevenLabs.' };
    const reset = Number(j.next_character_count_reset_unix);
    return { ok: true, used, limit, tier: j.tier || null, resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  } catch (e) {
    return { ok: false, error: 'Could not reach ElevenLabs: ' + e.message };
  }
}

module.exports = { speak, testKey, subscription, buildRequest, MODEL, MIME };
