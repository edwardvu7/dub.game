'use strict';
// Cast lookup: Grok searches the web (game wikis, guides) once per game for its main characters:
// names and nicknames, gender, age, personality and how they should sound. The result is saved in
// userData/cast.json and used two ways:
//   - recognition: "MARK", "Mark Borja" and a Godot node like "MarkSprite" all resolve to "Mark";
//   - casting: Gemini gets the notes when it picks a voice, instead of guessing from a name.
// Optional: without an xAI key nothing is looked up and everything works as before.
// UNVERIFIED: xAI's Responses API and web_search tool are used as documented; not yet called live.
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.x.ai/v1';
const MODEL = process.env.GROK_MODEL || 'grok-4.7';
const TIMEOUT_MS = 90000;            // web search runs several queries: allow time, it is in the background
const RETRY_MS = 60 * 60 * 1000;     // after a failed lookup, try that game again in an hour
const GENDERS = ['female', 'male', 'neutral'];
const AGES = ['child', 'teen', 'young_adult', 'adult', 'elder'];

function prompt(gameName, seen) {
  return [
    `Search the web (wikis, guides, the store page) for the main characters of the video game "${gameName}".`,
    seen.length ? `Names the game has shown so far: ${seen.slice(0, 30).join(', ')}.` : '',
    'Reply with JSON only, no other text, in exactly this shape:',
    '{"characters":[{"name":"Mark","aliases":["Mark Borja"],"gender":"male","age_range":"teen",',
    '"personality":"one sentence","voice":"one sentence on how they sound"}]}',
    `gender is one of ${GENDERS.join(', ')}. age_range is one of ${AGES.join(', ')}.`,
    'aliases: full names, nicknames and titles the game may show instead of the name.',
    'Up to 25 characters, most important first. No plot spoilers in personality or voice.',
    'If you cannot find the game, reply {"characters":[]}.',
  ].filter(Boolean).join('\n');
}

/** The text of a Responses API reply (OpenAI-compatible shape). */
function replyText(json) {
  if (json && typeof json.output_text === 'string') return json.output_text;
  const parts = [];
  for (const item of (json && json.output) || []) {
    for (const c of (item && item.content) || []) if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('');
}

/** Characters from the reply, cleaned: the model's text is never trusted as-is. */
function parseCast(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let raw;
  try { raw = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  const list = raw && Array.isArray(raw.characters) ? raw.characters : [];
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return list.slice(0, 25).map((c) => ({
    name: clean(c && c.name, 60),
    aliases: (Array.isArray(c && c.aliases) ? c.aliases : []).map((a) => clean(a, 60)).filter(Boolean).slice(0, 8),
    gender: GENDERS.includes(c && c.gender) ? c.gender : 'neutral',
    age_range: AGES.includes(c && c.age_range) ? c.age_range : 'adult',
    personality: clean(c && c.personality, 240),
    voice: clean(c && c.voice, 240),
  })).filter((c) => c.name.length >= 2);
}

// "MarkSprite" -> ["mark", "sprite"]; "Mark Borja" -> ["mark", "borja"]
const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The cast member a speaker name refers to, or null. */
function match(characters, speaker) {
  const said = String(speaker || '').trim().toLowerCase();
  if (!said || said === 'narrator' || said === 'unknown') return null;
  // 1. The whole name or an alias, ignoring case.
  for (const c of characters) {
    if (c.name.toLowerCase() === said || c.aliases.some((a) => a.toLowerCase() === said)) return c;
  }
  // 2. The first name as a whole word ("Mark Borja", "MarkSprite"), when only one character fits.
  const tokens = words(speaker);
  const hits = characters.filter((c) => {
    const first = words(c.name)[0];
    return first && first.length >= 3 && tokens.includes(first);
  });
  return hits.length === 1 ? hits[0] : null;
}

const notesOf = (c) => [c.gender, c.age_range.replace('_', ' '), c.personality, c.voice ? 'Sounds: ' + c.voice : '']
  .filter(Boolean).join('; ');

/**
 * createCastBook({file, settings, fetch?, now?, onReady?, log?})
 *   ensure(game, gameName, seen?) -> starts a lookup in the background when none is saved
 *   resolve(game, speaker) -> the cast name for a speaker (unchanged when unknown)
 *   notes(game, speaker) -> one line about the character for Gemini, or ''
 * onReady(game) fires when a lookup finds characters, so voices cast without notes can be redone.
 */
function createCastBook({ file, settings, fetch: doFetch = globalThis.fetch, now = Date.now, onReady = () => {}, log = () => {} }) {
  let book = {};
  try { book = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
  const running = new Set();
  const failedAt = new Map();

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(book, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch { /* the lookup is a bonus: it can run again next time */ }
  }

  async function lookup(game, gameName, seen) {
    const key = settings.getKey('grok');
    const res = await doFetch(`${API}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: [{ role: 'user', content: prompt(gameName, seen) }],
        tools: [{ type: 'web_search' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { /* no body */ }
      throw new Error(`Grok ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
    }
    return parseCast(replyText(await res.json()));
  }

  function ensure(game, gameName, seen = []) {
    if (!game || !gameName || game === 'clipboard' || book[game] || running.has(game)) return;
    if (!settings.getKey('grok')) return;
    if (failedAt.has(game) && now() - failedAt.get(game) < RETRY_MS) return;
    running.add(game);
    lookup(game, gameName, seen).then((characters) => {
      book[game] = { name: gameName, at: now(), characters };
      save();
      log(`cast of ${gameName}: ${characters.map((c) => c.name).join(', ') || 'not found'}`);
      if (characters.length) onReady(game);
    }).catch((e) => {
      failedAt.set(game, now());
      log('cast lookup failed: ' + e.message);
    }).finally(() => running.delete(game));
  }

  const characters = (game) => (book[game] && book[game].characters) || [];
  return {
    ensure,
    has: (game) => characters(game).length > 0,
    resolve(game, speaker) {
      const c = match(characters(game), speaker);
      return c ? c.name : speaker;
    },
    notes(game, speaker) {
      const c = match(characters(game), speaker);
      return c ? notesOf(c) : '';
    },
  };
}

/** testKey(key, {fetch?}) -> {ok, error?}: lists models, spends nothing. */
async function testKey(key, deps = {}) {
  if (!key) return { ok: false, error: 'No key saved.' };
  try {
    const res = await (deps.fetch || globalThis.fetch)(`${API}/models`, { headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000) });
    return res.ok ? { ok: true } : { ok: false, error: `Grok ${res.status}${res.status === 401 || res.status === 403 ? ': the key was refused.' : ''}` };
  } catch (e) {
    return { ok: false, error: 'Could not reach xAI: ' + e.message };
  }
}

module.exports = { createCastBook, parseCast, replyText, match, testKey, prompt, MODEL };
