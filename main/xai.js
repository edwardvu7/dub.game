'use strict';
// One door to xAI Grok (Responses API) for casting, acting and the cast lookup.
const API = 'https://api.x.ai/v1';
// Verified against docs.x.ai/docs/models (2026-11): `grok-4-fast-non-reasoning` is no longer listed; the only
// listed non-reasoning model is `grok-4.20-0309-non-reasoning` ($1.25/$2.50 per 1M tokens). GROK_FAST_MODEL overrides.
// UNVERIFIED: that this model accepts /v1/responses (the docs page does not say); not called live.
const FAST_MODEL = process.env.GROK_FAST_MODEL || 'grok-4.20-0309-non-reasoning';

/** The text of a Responses API reply. Documented shape: output[] message items whose content[] entries are
 * {type:"output_text", text}; reasoning items are skipped. A top-level output_text is not documented (kept as a bonus). */
function replyText(json) {
  if (json && typeof json.output_text === 'string') return json.output_text;
  const parts = [];
  for (const item of (json && json.output) || []) {
    for (const c of (item && item.content) || []) if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('');
}

/** The first JSON object in model text (it may be wrapped in prose or code fences), or null. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/**
 * callGrok({key, input, model?, timeout?, fetch?, tools?}) -> Promise<string> (the reply text)
 * `input` is a prompt string or a Responses API message array.
 */
async function callGrok({ key, input, model = FAST_MODEL, timeout = 20000, fetch: doFetch = globalThis.fetch, tools }) {
  if (!key) throw new Error('No Grok API key. Add one in Settings.');
  const body = { model, input: typeof input === 'string' ? [{ role: 'user', content: input }] : input };
  if (tools) body.tools = tools;
  let res;
  try {
    res = await doFetch(`${API}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    // fetch's own words ("fetch failed", "The operation was aborted due to timeout") reach the player's screen.
    throw new Error(e && e.name === 'TimeoutError' ? `Grok did not answer within ${Math.round(timeout / 1000)} seconds.`
      : 'Could not reach Grok: ' + (e && e.message));
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { /* no body */ }
    if (res.status === 403) throw new Error('xAI refused the request (403): check the key and that the team has API credits at console.x.ai.' + (detail ? ` (${String(detail).slice(0, 200)})` : ''));
    throw new Error(`Grok ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
  }
  const text = replyText(await res.json());
  if (!text) throw new Error('Grok returned no text');
  return text;
}

/** callGrokJson(opts) -> parsed object; throws when the reply holds no JSON. */
async function callGrokJson(opts) {
  const obj = extractJson(await callGrok(opts));
  if (!obj) throw new Error('Grok returned invalid JSON');
  return obj;
}

module.exports = { callGrok, callGrokJson, replyText, extractJson, API, FAST_MODEL };
