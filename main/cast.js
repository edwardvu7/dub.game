'use strict';
// Cast lookup: Grok searches the web (game wikis, guides) once per game for its main characters:
// names and nicknames, gender, age, personality and how they should sound. The result is saved in
// userData/cast.json and used two ways:
//   - recognition: "MARK", "Mark Borja" and a Godot node like "MarkSprite" all resolve to "Mark";
//   - casting: Grok gets the notes when it picks a voice, instead of guessing from a name.
// Optional: without an xAI key nothing is looked up and everything works as before.
// Request shape, `web_search` tool type and model `grok-4.7` confirmed from docs.x.ai (not yet called live).
const fs = require('node:fs');
const path = require('node:path');
const { callGrok, replyText, extractJson, API } = require('./xai');


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
    '{"setting":{"country":"Philippines","region":"Manila","language":"Filipino-English","era":"modern day","notes":"one sentence on the world and how people talk"},',
    '"characters":[{"name":"Mark","aliases":["Mark Borja"],"gender":"male","age_range":"teen",',
    '"personality":"one sentence","voice":"one sentence on how they sound",',
    '"origin":"nationality or ethnic background if known, else empty","speech":"short: formal or slang, regional English, tone, pace"}]}',
    'setting: where and when the game takes place and what language the characters speak; leave a field empty if unknown.',
    `gender is one of ${GENDERS.join(', ')}. age_range is one of ${AGES.join(', ')}.`,
    'aliases: full names, nicknames and titles the game may show instead of the name.',
    'Up to 25 characters, most important first. No plot spoilers in personality or voice.',
    'If you cannot find the game, reply {"setting":{},"characters":[]}.',
  ].filter(Boolean).join('\n');
}

const clean = (v, n) => String(v == null || typeof v === 'object' ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** The game's setting from the reply: {country, region, language, era, notes}; '' when unknown. */
function parseSetting(text) {
  const raw = extractJson(text);
  const s = raw && raw.setting && typeof raw.setting === 'object' && !Array.isArray(raw.setting) ? raw.setting : {};
  return { country: clean(s.country, 60), region: clean(s.region, 60), language: clean(s.language, 60),
    era: clean(s.era, 60), notes: clean(s.notes, 240) };
}

/** One line for the casting prompt, e.g. "Philippines (Manila); language Filipino-English; modern day. notes", or ''. */
function settingLine(s) {
  if (!s || typeof s !== 'object') return '';
  const region = clean(s.region, 60);
  const place = [clean(s.country, 60), region && `(${region})`].filter(Boolean).join(' ');
  const out = [place, clean(s.language, 60) && 'language ' + clean(s.language, 60), clean(s.era, 60)].filter(Boolean).join('; ');
  return [out, clean(s.notes, 240)].filter(Boolean).join('. ');
}

/** Characters from the reply, cleaned: the model's text is never trusted as-is. */
function parseCast(text) {
  const raw = extractJson(text);
  const list = raw && Array.isArray(raw.characters) ? raw.characters : [];
  return list.slice(0, 25).map((c) => ({
    name: clean(c && c.name, 60),
    aliases: (Array.isArray(c && c.aliases) ? c.aliases : []).map((a) => clean(a, 60)).filter(Boolean).slice(0, 8),
    gender: GENDERS.includes(c && c.gender) ? c.gender : 'neutral',
    age_range: AGES.includes(c && c.age_range) ? c.age_range : 'adult',
    personality: clean(c && c.personality, 240),
    voice: clean(c && c.voice, 240),
    origin: clean(c && c.origin, 80),
    speech: clean(c && c.speech, 160),
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

const notesOf = (c) => [c.gender, c.age_range.replace('_', ' '), c.origin ? 'Origin: ' + c.origin : '', c.personality,
  c.voice ? 'Sounds: ' + c.voice : '', c.speech ? 'Speech: ' + c.speech : '']
  .filter(Boolean).join('; ');

/**
 * createCastBook({file, settings, fetch?, now?, onReady?, log?})
 *   ensure(game, gameName, seen?) -> starts a lookup in the background when none is saved
 *   resolve(game, speaker) -> the cast name for a speaker (unchanged when unknown)
 *   notes(game, speaker) -> one line about the character for Grok, or ''
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
    const text = await callGrok({ key: settings.getKey('grok'), model: MODEL, timeout: TIMEOUT_MS, fetch: doFetch,
      input: prompt(gameName, seen), tools: [{ type: 'web_search' }] });
    return { characters: parseCast(text), setting: parseSetting(text) };
  }

  function ensure(game, gameName, seen = []) {
    // Entries saved before `setting` existed are researched once more: a lookup always writes
    // `setting` (empty if unknown), so it cannot repeat. A failure retries hourly like any other.
    if (!game || !gameName || game === 'clipboard' || (book[game] && book[game].setting !== undefined) || running.has(game)) return;
    if (!settings.getKey('grok')) return;
    if (failedAt.has(game) && now() - failedAt.get(game) < RETRY_MS) return;
    running.add(game);
    lookup(game, gameName, seen).then(({ characters, setting }) => {
      const old = book[game] && book[game].characters;
      // A refresh that finds no characters keeps the ones already saved.
      book[game] = { name: gameName, at: now(), characters: characters.length || !old ? characters : old, setting };
      save();
      log(`cast of ${gameName}: ${characters.map((c) => c.name).join(', ') || 'not found'}`);
      if (characters.length || settingLine(setting)) onReady(game);
    }).catch((e) => {
      failedAt.set(game, now());
      log('cast lookup failed: ' + e.message);
    }).finally(() => running.delete(game));
  }

  const characters = (game) => (book[game] && book[game].characters) || [];
  return {
    ensure,
    has: (game) => characters(game).length > 0,
    /** The researched setting as one line for Grok, or ''. */
    setting: (game) => settingLine(book[game] && book[game].setting),
    /** {origin, speech} of a speaker (short strings, maybe empty). */
    detail(game, speaker) {
      const c = match(characters(game), speaker);
      return { origin: clean(c && c.origin, 80), speech: clean(c && c.speech, 160) };
    },
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

module.exports = { createCastBook, parseCast, parseSetting, settingLine, replyText, match, testKey, prompt, MODEL };
