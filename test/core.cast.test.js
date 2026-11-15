'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createCastBook, parseCast, parseSetting, settingLine, replyText, match, testKey } = require('../main/cast');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const profiler = require('../main/profiler');
const catalog = require('../voices_catalog.json');

const CAST = { characters: [
  { name: 'Mark', aliases: ['Mark Borja'], gender: 'male', age_range: 'teen', personality: 'Easygoing slacker.', voice: 'Relaxed, a bit sleepy.' },
  { name: 'Cathy', aliases: ['Catherine Portillo'], gender: 'female', age_range: 'teen', personality: 'Bright and caring.', voice: 'Warm.' },
  { name: 'Ridel', aliases: [], gender: 'male', age_range: 'teen', personality: 'Loud best friend.', voice: 'Energetic.' },
] };
const grokReply = (cast) => ({ output: [{ type: 'web_search_call' }, { type: 'message', content: [
  { type: 'output_text', text: 'Here you go:\n```json\n' + JSON.stringify(cast) + '\n```' }] }] });

test('cast: the reply is read from the Responses shape and cleaned', () => {
  assert.equal(replyText({ output_text: 'x' }), 'x');
  const list = parseCast(replyText(grokReply({ characters: [...CAST.characters,
    { name: 'X' }, { name: 'Odd', gender: 'robot', age_range: 'ancient', aliases: 'nope' }] })));
  assert.deepEqual(list.map((c) => c.name), ['Mark', 'Cathy', 'Ridel', 'Odd'], 'one-letter names dropped');
  assert.equal(list[3].gender, 'neutral');
  assert.equal(list[3].age_range, 'adult');
  assert.deepEqual(list[3].aliases, []);
  assert.deepEqual(parseCast('no json here'), []);
});

test('cast: names the game shows resolve to one character', () => {
  const cast = parseCast(JSON.stringify(CAST));
  const name = (s) => (match(cast, s) || { name: null }).name;
  assert.equal(name('MARK'), 'Mark');
  assert.equal(name('Mark Borja'), 'Mark');
  assert.equal(name('Catherine Portillo'), 'Cathy');
  assert.equal(name('MarkSprite'), 'Mark', 'a Godot node name');
  assert.equal(name('ridel_bubble'), 'Ridel');
  assert.equal(name('Narrator'), null);
  assert.equal(name('Marky'), null, 'not a whole word');
  assert.equal(name('Mark and Cathy'), null, 'two people: not guessed');
});

test('cast book: one Grok search per game, saved; resolve and notes; no key means no lookup', async () => {
  const file = path.join(tmpDir(), 'cast.json');
  const calls = [];
  const ready = [];
  const keys = { grok: 'xai-test' };
  const book = createCastBook({ file, settings: { getKey: (p) => keys[p] }, onReady: (g) => ready.push(g),
    fetch: async (url, init) => { calls.push([url, JSON.parse(init.body), init.headers]); return { ok: true, json: async () => grokReply(CAST) }; } });
  book.ensure('godot:Until Then', 'Until Then', ['MARK']);
  book.ensure('godot:Until Then', 'Until Then');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'one lookup while one is running');
  assert.match(calls[0][0], /api\.x\.ai\/v1\/responses$/);
  assert.deepEqual(calls[0][1].tools, [{ type: 'web_search' }]);
  assert.match(calls[0][1].input[0].content, /"Until Then"[\s\S]*MARK/);
  assert.equal(calls[0][2].Authorization, 'Bearer xai-test');
  assert.deepEqual(ready, ['godot:Until Then']);
  assert.equal(book.resolve('godot:Until Then', 'Mark Borja'), 'Mark');
  assert.equal(book.resolve('renpy:Other', 'Mark Borja'), 'Mark Borja', 'casts are per game');
  assert.match(book.notes('godot:Until Then', 'MARK'), /male; teen; Easygoing slacker\.; Sounds: Relaxed/);
  const again = createCastBook({ file, settings: { getKey: () => 'k' }, fetch: async () => { throw new Error('should not fetch'); } });
  again.ensure('godot:Until Then', 'Until Then');
  assert.equal(again.resolve('godot:Until Then', 'CATHY'), 'Cathy', 'saved to disk: no second lookup');
  keys.grok = '';
  book.ensure('renpy:New', 'New Game');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'no Grok key: nothing is looked up');
});

test('cast book: a failed lookup is not retried for an hour', async () => {
  let t = 0;
  let calls = 0;
  const book = createCastBook({ file: path.join(tmpDir(), 'c.json'), settings: { getKey: () => 'k' }, now: () => t,
    fetch: async () => { calls++; return { ok: false, status: 429, json: async () => ({ error: 'rate limited' }) }; } });
  book.ensure('g', 'Game'); await new Promise((r) => setTimeout(r, 10));
  book.ensure('g', 'Game'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  t = 61 * 60 * 1000;
  book.ensure('g', 'Game'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);
});

test('Grok casting gets the game name and the looked-up notes', () => {
  const text = profiler.prompt([{ speaker: 'Mark', samples: ['Hm.'], game: 'Until Then', notes: 'male; teen; Easygoing.' }], catalog, {});
  assert.match(text, /from the game "Until Then"/);
  assert.match(text, /Known about them: male; teen; Easygoing\./);
  assert.doesNotMatch(profiler.prompt([{ speaker: 'Mark', samples: [] }], catalog, {}), /from the game/);
});

test('pipeline: names resolve to the cast, Grok gets notes, and the cast arriving recasts unlocked voices', async () => {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json') });
  const asked = [];
  let castReady = false;
  const cast = {
    ensure() {}, has: () => castReady,
    resolve: (_g, s) => (castReady && /^mark/i.test(s) ? 'Mark' : s),
    notes: (_g, s) => (castReady && s === 'Mark' ? 'male; teen' : ''),
    setting: () => (castReady ? 'Philippines (Manila); modern day' : ''),
    detail: (_g, s) => (castReady && s === 'Mark' ? { origin: 'Filipino', speech: 'casual Taglish' } : {}),
  };
  const pick = (c, i) => ({ speaker: c.speaker, voice_id: catalog[i].voice_id, stability: 0.5, style: 0.3, speed: 1 });
  const p = createPipeline({ voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, cast,
    settings: { getKey: () => 'k', narration: () => true }, emit: () => {}, settleMs: 0, gameName: () => 'Until Then',
    speak: async () => Buffer.from('mp3'),
    profileCharacter: async (c) => { asked.push(c); return profiler.sanitizeProfile(pick(c, 1), c.speaker, catalog); },
    profileCharacters: async (list) => { asked.push(...list); return list.map((c) => profiler.sanitizeProfile(pick(c, 2), c.speaker, catalog, c)); } });
  await p.handleLine({ speaker: 'Cathy', text: 'Hi.', game: 'godot:Until Then' });
  assert.equal(asked[0].game, 'Until Then', 'Grok is told which game, even before any lookup');
  assert.equal(asked[0].notes, undefined);
  store.forGame('godot:Until Then').update('Cathy', { speed: 1.1 }); // the player tuned Cathy
  await p.handleLine({ speaker: 'Mark', text: 'Yo.', game: 'godot:Until Then' });
  castReady = true;
  assert.equal(await p.recast('godot:Until Then'), 1, 'only Mark is recast: Cathy is the player\'s');
  const mark = store.forGame('godot:Until Then').get('Mark');
  assert.equal(mark.voice_id, catalog[2].voice_id);
  assert.equal(mark.cast, true);
  assert.equal(asked.at(-1).notes, 'male; teen');
  assert.equal(asked.at(-1).setting, 'Philippines (Manila); modern day');
  assert.equal(mark.origin, 'Filipino', 'research notes copied into the profile');
  assert.equal(mark.speech, 'casual Taglish');
  assert.equal(mark.researched, true);
  assert.equal(store.forGame('godot:Until Then').get('Cathy').origin, undefined, 'locked profile untouched');
  store.forGame('godot:Until Then').update('Mark', { speed: 1.05 });
  assert.equal(store.forGame('godot:Until Then').get('Mark').origin, 'Filipino', 'a manual edit keeps the notes');
  assert.equal(await p.recast('godot:Until Then'), 0, 'not twice');
  await p.handleLine({ speaker: 'MarkSprite', text: 'Later.', game: 'godot:Until Then' });
  assert.ok(!store.forGame('godot:Until Then').has('MarkSprite'), 'a node name resolves to Mark, no new voice');
});

test('cast: setting and origin/speech are parsed, capped and tolerant', () => {
  const reply = JSON.stringify({ setting: { country: ' Philippines ', region: 'Manila', language: 'Filipino-English', era: 'modern day',
    notes: 'x'.repeat(500), extra: 'ignored' },
  characters: [{ name: 'Mark', origin: 'Filipino', speech: 'y'.repeat(500) }, { name: 'Odd', origin: { a: 1 }, speech: 5 }] });
  const s = parseSetting(reply);
  assert.equal(s.country, 'Philippines');
  assert.equal(s.notes.length, 240);
  assert.equal(s.extra, undefined);
  const list = parseCast(reply);
  assert.equal(list[0].origin, 'Filipino');
  assert.equal(list[0].speech.length, 160);
  assert.equal(list[1].origin, '', 'object ignored');
  assert.equal(list[1].speech, '5');
  assert.deepEqual(parseSetting('{"setting":"nope","characters":[]}'), { country: '', region: '', language: '', era: '', notes: '' });
  assert.deepEqual(parseSetting('garbage'), { country: '', region: '', language: '', era: '', notes: '' });
  assert.equal(settingLine(s).startsWith('Philippines (Manila); language Filipino-English; modern day.'), true);
  assert.equal(settingLine({}), '');
  assert.equal(settingLine(undefined), '');
});

test('cast book: old entries without setting are researched once more, keeping their characters', async () => {
  const file = path.join(tmpDir(), 'cast.json');
  fs.writeFileSync(file, JSON.stringify({ g: { name: 'Game', at: 1, characters: [{ name: 'Mark', aliases: [], gender: 'male', age_range: 'teen', personality: 'p', voice: 'v' }] } }));
  let calls = 0;
  const ready = [];
  const reply = { setting: { country: 'Philippines' }, characters: [] }; // refresh finds no characters
  const book = createCastBook({ file, settings: { getKey: () => 'k' }, onReady: (g) => ready.push(g),
    fetch: async () => { calls++; return { ok: true, json: async () => grokReply(reply) }; } });
  assert.equal(book.setting('g'), '');
  assert.match(book.notes('g', 'Mark'), /male; teen; p; Sounds: v/, 'old entry works without origin/speech');
  book.ensure('g', 'Game'); await new Promise((r) => setTimeout(r, 20));
  book.ensure('g', 'Game'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'once only');
  assert.equal(book.setting('g'), 'Philippines');
  assert.ok(book.has('g'), 'saved characters kept');
  assert.deepEqual(ready, ['g']);
  const again = createCastBook({ file, settings: { getKey: () => 'k' }, fetch: async () => { throw new Error('should not fetch'); } });
  again.ensure('g', 'Game');
  assert.equal(again.setting('g'), 'Philippines', 'persisted');
});

test('Grok casting prompt carries the setting and refuses a British default', () => {
  const text = profiler.prompt([{ speaker: 'Mark', samples: [], game: 'Until Then', setting: 'Philippines (Manila); modern day',
    origin: 'Filipino', speech: 'casual Taglish' }], catalog, {});
  assert.match(text, /Researched setting of the game: Philippines \(Manila\); modern day/);
  assert.match(text, /Origin: Filipino/);
  assert.match(text, /How they speak: casual Taglish/);
  assert.match(text, /Do NOT default to British or Australian/);
  assert.match(text, /neutral or American/);
  assert.doesNotMatch(profiler.prompt([{ speaker: 'Mark', samples: [] }], catalog, {}), /Researched setting|Do NOT default/);
});

test('profiler: origin/speech come from the research, not the model reply', () => {
  const p = profiler.sanitizeProfile({ voice_id: catalog[0].voice_id, origin: 'Mars' }, 'Mark', catalog, { origin: ' Filipino ', speech: { x: 1 } });
  assert.equal(p.origin, 'Filipino');
  assert.equal('speech' in p, false);
  assert.equal('origin' in profiler.sanitizeProfile({ origin: 'Mars' }, 'Mark', catalog), false);
});

test('grok testKey: ok, refused, offline', async () => {
  assert.deepEqual(await testKey('k', { fetch: async (u) => { assert.match(u, /\/v1\/models$/); return { ok: true }; } }), { ok: true });
  assert.match((await testKey('k', { fetch: async () => ({ ok: false, status: 401 }) })).error, /refused/);
  assert.match((await testKey('k', { fetch: async () => { throw new Error('ENOTFOUND'); } })).error, /Could not reach/);
  assert.equal((await testKey('')).ok, false);
});
