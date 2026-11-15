'use strict';
// Rotating custom-voice pool, delete-voice call, quality levels, casting guards, recognition, speakable fixes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline, MAX_CUSTOM_PER_GAME } = require('../main/pipeline');
const { createVoiceDesigner } = require('../main/voice-design');
const { createSettings } = require('../main/settings');
const { createHandlers } = require('../main/ipc');
const { speakable } = require('../main/speakable');
const tts = require('../main/tts');
const profiler = require('../main/profiler');
const castMod = require('../main/cast');
const catalog = require('../voices_catalog.json');

const PRESET = catalog[0].voice_id;
const prof = (speaker, extra = {}) => ({ speaker, gender: 'female', age_range: 'adult', personality: 'p', voice_id: PRESET,
  stability: 0.5, style: 0.3, speed: 1, reason: 'r', source: 'grok', ...extra });

function rig({ ranks = {}, researched = false, settleMs = 0, quality, designer } = {}) {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((v) => v.voice_id), catalog });
  const removed = [];
  const events = [];
  const models = [];
  let n = 0;
  const pipeline = createPipeline({
    voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, settleMs, castWaitMs: 50, designBackoffMs: 1, designRetryMs: 5,
    settings: { getKey: () => 'k', narration: () => true, customVoices: () => true, quality: () => quality || 'fast' },
    emit: (ch, p) => events.push([ch, p]), fetch: async () => { throw new Error('offline'); },
    cast: { ensure() {}, resolve: (_g, s) => s, notes: () => '', setting: () => '', detail: () => ({}), rank: (_g, s) => (s in ranks ? ranks[s] : -1), has: () => researched },
    speak: async (params) => { models.push(params.model); return Buffer.from('mp3'); },
    profileCharacter: async (c) => prof(c.speaker),
    designer: designer ? designer(() => 'Cust' + (++n), removed) : { design: async () => ({ voice_id: 'Cust' + (++n), name: 'n' }), remove: async (id) => { removed.push(id); return true; } },
  });
  const voices = store.forGame('g');
  let i = 0;
  const line = (speaker, game = 'g', speaker_id) => pipeline.handleLine({ speaker, text: 'Hello there ' + (++i), game, speaker_id });
  return { pipeline, store, voices, removed, events, models, line, dir };
}

async function fillPool(r, names, times = 1) {
  for (const s of names) for (let k = 0; k < times; k++) { await r.line(s); await r.pipeline.designIdle(); }
}
const poolNames = Array.from({ length: MAX_CUSTOM_PER_GAME }, (_, i) => 'C' + i);

test('rotation: a main character takes the slot of the least valuable voice; the loser falls back to its preset', async () => {
  const r = rig({ ranks: { Main: 0 } });
  await fillPool(r, poolNames);
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME);
  await r.line('Main'); await r.pipeline.designIdle();
  assert.ok(r.voices.get('Main').custom_voice);
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME, 'still at most 8 live');
  assert.deepEqual(poolNames.filter((s) => !r.voices.get(s).custom_voice), ['C0']);
  assert.equal(r.voices.get('C0').voice_id, PRESET, 'preset kept');
  assert.deepEqual(r.removed, ['Cust1'], 'the evicted voice was deleted on ElevenLabs');
  assert.equal(r.voices.get('C0').lines, 1);
  assert.ok(r.voices.get('C0').last_spoken > 0);
});

test('rotation: an equal newcomer does not churn the pool; one with more lines does', async () => {
  const r = rig();
  await fillPool(r, poolNames);
  await fillPool(r, ['New']);
  assert.equal(r.voices.get('New').custom_voice, undefined);
  assert.deepEqual(r.removed, []);
  await fillPool(r, ['New']); // 2 lines now beats a 1-line voice
  assert.ok(r.voices.get('New').custom_voice);
  assert.equal(r.removed.length, 1);
});

test('rotation: never the current speaker, and a locked voice is the last to go', async () => {
  const r = rig();
  await fillPool(r, poolNames.slice(1), 2);
  await fillPool(r, ['C0'], 1); // fewest lines AND the current speaker
  r.voices.update('C1', { stability: 0.9 }); // player-picked: locked
  r.voices.setAuto(prof('Extra'));
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Extra' });
  assert.ok(r.voices.get('C0').custom_voice, 'current speaker keeps its voice');
  assert.ok(r.voices.get('C1').custom_voice, 'locked voice is avoided');
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME);
  assert.equal(r.removed.length, 1);
});

test('rotation: replacing a voice deletes the old one; a voice another profile still uses is kept', async () => {
  const r = rig();
  r.voices.setAuto(prof('A')); r.voices.setAuto(prof('B'));
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'A' });
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'A' });
  await r.pipeline.designIdle();
  assert.deepEqual(r.removed, ['Cust1']);
  r.voices.setCustom('B', { voice_id: r.voices.get('A').custom_voice.voice_id, name: 'n', description: 'd' }); // shared id
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'A' });
  await r.pipeline.designIdle();
  assert.deepEqual(r.removed, ['Cust1'], 'Cust2 is still B\'s');
});

test('clearGame deletes the game\'s designed voices (best effort) and forgets the game', async () => {
  const r = rig();
  r.voices.setAuto(prof('A'));
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'A' });
  assert.equal(r.pipeline.clearGame('g'), true);
  await r.pipeline.designIdle();
  assert.deepEqual(r.removed, ['Cust1']);
  assert.equal(r.store.forGame('g').has('A'), false);
  const h = createHandlers({ games: {}, voices: { clearGame: () => 'store' }, settings: {}, pipeline: { clearGame: (g) => 'pipe:' + g }, catalog });
  assert.equal(h['voices:clearGame']({ game: 'x' }), 'pipe:x');
});

test('rotation: main characters are designed before heavier talkers', async () => {
  const r = rig({ ranks: { Hero: 1 } });
  r.voices.setAuto(prof('Fan')); r.voices.setAuto(prof('Hero'));
  await r.line('Fan'); await r.line('Fan'); await r.line('Fan'); // Fan queued first and designing
  await r.line('Fan'); await r.line('Hero');
  await r.pipeline.designIdle();
  assert.ok(r.voices.get('Hero').custom_voice);
  assert.ok(r.voices.get('Fan').custom_voice);
});

test('persisted counters: lines and last_spoken survive recasts and a reload', async () => {
  const r = rig();
  await r.line('Ann'); await r.line('Ann');
  r.voices.setAuto(prof('Ann', { voice_id: catalog[1].voice_id }));
  assert.equal(r.voices.get('Ann').lines, 2);
  for (let i = 0; i < 4; i++) r.voices.touch('Ann'); // the 6th line flushes to disk
  const again = createVoiceStore({ file: path.join(r.dir, 'voices.json') }).forGame('g').get('Ann');
  assert.ok(again.lines >= 1 && again.last_spoken > 0);
});

test('delete voice: DELETE /v1/voices/{id}, never throws, 404 counts, bad ids and no key are refused', async () => {
  const calls = [];
  const mk = (fetch, key = 'k') => createVoiceDesigner({ settings: { getKey: () => key },
    fetch: async (u, i) => { calls.push([u, i.method, i.headers['xi-api-key']]); return fetch(); } });
  assert.equal(await mk(async () => ({ ok: true, status: 200 })).remove('abc123'), true);
  assert.deepEqual(calls[0], ['https://api.elevenlabs.io/v1/voices/abc123', 'DELETE', 'k']);
  assert.equal(await mk(async () => ({ ok: false, status: 404 })).remove('abc123'), true);
  assert.equal(await mk(async () => ({ ok: false, status: 500 })).remove('abc123'), false);
  assert.equal(await mk(async () => { throw new Error('down'); }).remove('abc123'), false);
  const before = calls.length;
  assert.equal(await mk(async () => ({ ok: true })).remove('../x'), false);
  assert.equal(await mk(async () => ({ ok: true }), '').remove('abc'), false);
  assert.equal(calls.length, before);
});

test('quality: three levels, legacy true/other values, model in the request and the cache key', async () => {
  assert.deepEqual(['fast', 'balanced', 'best', true, false, 'x', undefined].map(tts.normalizeQuality),
    ['fast', 'balanced', 'best', 'best', 'fast', 'fast', 'fast']);
  assert.equal(tts.buildRequest({ text: 'a', voice_id: 'abc', model: tts.BALANCED_MODEL }).body.model_id, 'eleven_turbo_v2_5');
  assert.equal(tts.buildRequest({ text: 'a', voice_id: 'abc', model: tts.BALANCED_MODEL }).body.voice_settings.use_speaker_boost, undefined);
  assert.equal(tts.buildRequest({ text: 'a', voice_id: 'abc', model: tts.BEST_MODEL }).body.voice_settings.use_speaker_boost, true);
  const file = path.join(tmpDir(), 's.json');
  const mkSettings = () => createSettings({ file, safeStorage: { isEncryptionAvailable: () => false }, env: {} });
  const h = createHandlers({ games: {}, voices: {}, settings: mkSettings(), pipeline: {}, catalog });
  assert.equal(h['settings:setQuality']('balanced').quality, 'balanced');
  assert.equal(h['settings:setQuality'](true).quality, 'best');
  assert.equal(h['settings:setQuality']('nonsense').quality, 'fast');
  h['settings:setQuality']('balanced');
  assert.equal(mkSettings().getPublic().quality, 'balanced');
  fs.writeFileSync(file, JSON.stringify({ quality: 'best' }));
  assert.equal(mkSettings().quality(), 'best');
  const used = {};
  for (const q of ['fast', 'balanced', 'best']) {
    const r = rig({ quality: q });
    r.voices.setAuto(prof('A'));
    await r.line('A');
    used[q] = r.models[0];
  }
  assert.deepEqual(used, { fast: tts.MODEL, balanced: tts.BALANCED_MODEL, best: tts.BEST_MODEL });
  const c = createCache({ dir: tmpDir() });
  const base = { voice_id: 'v', text: 't', stability: 0.5, style: 0, speed: 1 };
  assert.notEqual(c.key({ ...base, model: tts.MODEL }), c.key({ ...base, model: tts.BALANCED_MODEL }));
});

test('godot: a crowd/UI label arriving after a real line does not cancel it', async () => {
  const r = rig({ settleMs: 20 });
  r.voices.setAuto(prof('Real'));
  const first = r.pipeline.handleLine({ speaker: 'Real', text: 'I am here.', game: 'g', engine: 'godot' });
  await new Promise((res) => setTimeout(res, 5));
  await r.pipeline.handleLine({ speaker: 'CrowdLabel', text: 'Menu', game: 'g', engine: 'godot' });
  await first;
  assert.equal(r.events.filter(([c]) => c === 'audio:play').length, 1);
  assert.equal(r.events.filter(([c]) => c === 'line:received').length, 1, 'the label is not a line');
});

test('speakable: "I am here" stays; am/pm only after a number; numbers with , . - are untouched', () => {
  assert.equal(speakable('I am here.'), 'I am here.');
  assert.equal(speakable('Am I late? PM me.'), 'Am I late? PM me.');
  assert.equal(speakable('Meet at 3 pm.'), 'Meet at three P M.');
  assert.equal(speakable('At 3:45pm.'), 'At three forty-five P M.');
  assert.equal(speakable('1,000 gold'), '1,000 gold');
  assert.equal(speakable('3.5 miles'), '3.5 miles');
  assert.equal(speakable('Call 555-1234'), 'Call 555-1234');
  assert.equal(speakable('It is $1,000 or 3.5%.'), 'It is $1,000 or 3.5%.');
  assert.equal(speakable('I have 5, then 6.'), 'I have five, then six.');
  assert.equal(speakable('a 10-year-old'), 'a ten-year-old');
  assert.equal(speakable('It costs $20, ok.'), 'It costs twenty dollars, ok.');
});

test('cast recognition: honorifics, protagonist labels and name variables', () => {
  const list = castMod.parseCast(JSON.stringify({ characters: [
    { name: 'Sayori', aliases: ['Sayo'], gender: 'female', age_range: 'teen' },
    { name: 'Monika', gender: 'female', age_range: 'teen' },
    { name: 'Protagonist', protagonist: true, aliases: ['MC', 'Mc'], gender: 'male', age_range: 'teen' }] }));
  const who = (s) => (castMod.match(list, s) || {}).name;
  assert.equal(who('Sayori-chan'), 'Sayori');
  assert.equal(who('Miss Monika'), 'Monika');
  assert.equal(who('Sayo'), 'Sayori');
  assert.equal(who('MC'), 'Protagonist');
  assert.equal(who('[player]'), 'Protagonist');
  assert.equal(who('%(name)s'), 'Protagonist');
  assert.equal(who('Natsuki'), undefined);
});

test('cast book: rank is 0-based for researched characters, -1 for others', () => {
  const file = path.join(tmpDir(), 'cast.json');
  const c = (name) => ({ name, aliases: [], gender: 'female', age_range: 'teen', personality: '', voice: '', origin: '', speech: '' });
  fs.writeFileSync(file, JSON.stringify({ g: { name: 'G', at: 1, setting: {}, characters: [c('Sayori'), c('Monika')] } }));
  const book = castMod.createCastBook({ file, settings: { getKey: () => '' } });
  assert.equal(book.rank('g', 'Sayori'), 0);
  assert.equal(book.rank('g', 'Monika'), 1);
  assert.equal(book.rank('g', 'Stranger'), -1);
});

test('casting: a teen is never left with an older or accented voice for a non-accented setting', () => {
  const byId = (id) => catalog.find((v) => v.voice_id === id);
  const pick = (voice_id, gender, age_range, known) => profiler.sanitizeProfile({ voice_id, gender, age_range }, 'Sayori', catalog, known);
  const idOf = (name) => catalog.find((v) => v.name === name).voice_id;
  const a = pick(idOf('Charlotte'), 'female', 'teen', { setting: 'Japan; modern day' });
  assert.match(byId(a.voice_id).description, /young|girl/);
  assert.doesNotMatch(byId(a.voice_id).description, /Swedish|British|Australian/);
  const b = pick(idOf('Eric'), 'male', 'young_adult', {});
  assert.match(byId(b.voice_id).description, /young|boy/);
  assert.doesNotMatch(byId(b.voice_id).description, /40s/);
  assert.equal(pick(idOf('Lily'), 'female', 'young_adult', { origin: 'British' }).voice_id, idOf('Lily'), 'a British character keeps a British voice');
  const p = profiler.prompt([{ speaker: 'Sayori', samples: [], setting: 'Japan' }], catalog, {});
  assert.match(p, /natural, casual American English/);
  assert.match(p, /only voices described as young/);
});

test('voice design prompt carries setting, era, origin, speech, personality and age', () => {
  const setting = 'Japan (Tokyo); language English; 2010s school';
  const p = profiler.buildVoiceDescriptionPrompt({ speaker: 'S', game: 'G', gender: 'female', age_range: 'young_adult',
    personality: 'Shy', origin: 'Japanese-American', speech: 'soft, casual' }, 'notes', setting);
  for (const s of ['THIS game', setting, 'Japanese-American', 'soft, casual', 'Shy', 'young adult']) assert.ok(p.includes(s), s);
  assert.match(profiler.fallbackVoiceDescription({ gender: 'male', age_range: 'adult', setting: 'Victorian London' }), /Victorian London/);
});

test('custom voices follow the research: Nicole gets one at once, "Student 1" never, a recurring unlisted name is adapted in', async () => {
  const r = rig({ ranks: { Nicole: 0 }, researched: true });
  await r.line('Nicole'); await r.pipeline.designIdle();
  assert.ok(r.voices.get('Nicole').custom_voice, 'researched main character');
  for (let k = 0; k < 20; k++) { await r.line('Student 1'); await r.pipeline.designIdle(); }
  assert.ok(!r.voices.get('Student 1').custom_voice, 'placeholder never earns one');
  for (let k = 0; k < 14; k++) { await r.line('Mr Reyes'); await r.pipeline.designIdle(); }
  assert.ok(r.voices.get('Mr Reyes').custom_voice, 'recurring unlisted character is adapted in');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('DDLC: every character met gets a designed voice after one line, through renames and a transient failure', async () => {
  for (const researched of [false, true]) {
    const asked = [], notices = [];
    let failed = false;
    const r = rig({ researched, ranks: researched ? { Sayori: 0, Monika: 1, Natsuki: 2, Yuri: 3 } : {},
      designer: (id) => ({ design: async (a) => { asked.push(a.name);
        if (!failed && /Girl 2/.test(a.name)) { failed = true; throw new Error('ElevenLabs 500 during Voice Design'); }
        return { voice_id: id(), name: 'n' }; }, remove: async () => true }) });
    const settle = async () => { await sleep(30); await r.pipeline.designIdle(); };
    const met = [['Girl 1', 's'], ['Girl 2', 'm'], ['Girl 3', 'n'], ['m_name', 'mc'], ['Narrator', undefined]];
    for (const [who, id] of met) { await r.line(who, 'g', id); await settle(); }
    for (const [who, id] of [['Sayori', 's'], ['Monika', 'm'], ['Natsuki', 'n'], ['Yuri', 'y'], ['Sayori', 's']]) { await r.line(who, 'g', id); await settle(); }
    for (const name of ['Sayori', 'Monika', 'Natsuki', 'Yuri', 'm_name']) assert.ok(r.voices.get(name) && r.voices.get(name).custom_voice, `${name} designed (researched=${researched})`);
    assert.ok(!r.voices.get('Narrator').custom_voice);
    assert.ok(asked.findIndex((n) => /Girl 1/.test(n)) < asked.findIndex((n) => /Girl 3/.test(n)), 'first met first');
  }
});

test('pool: never above 8 across 12 characters; a 9th main character evicts the least valuable non-main; the evicted can return', async () => {
  const r = rig({ ranks: { Main: 0 }, researched: true });
  for (let k = 0; k < 12; k++) { await r.line('C' + k); await r.pipeline.designIdle(); assert.ok(r.voices.customCount() <= MAX_CUSTOM_PER_GAME); }
  await r.line('Main'); await r.pipeline.designIdle();
  assert.ok(r.voices.get('Main').custom_voice);
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME);
  const gone = Array.from({ length: 12 }, (_, k) => 'C' + k).filter((s) => !r.voices.get(s).custom_voice);
  assert.ok(gone.length >= 4);
  const back = gone[0];
  for (let k = 0; k < 3; k++) { await r.line(back); await r.pipeline.designIdle(); }
  assert.ok(r.voices.get(back).custom_voice, 'an evicted character that keeps talking gets a voice again');
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME);
});

test('design failures stop blocking forever and are announced once', async () => {
  let calls = 0;
  const r = rig({ designer: (id) => ({ design: async () => { if (++calls <= 3) throw new Error('boom'); return { voice_id: id(), name: 'n' }; }, remove: async () => true }) });
  await r.line('Ann'); await sleep(40); await r.pipeline.designIdle();
  assert.ok(!r.voices.get('Ann').custom_voice);
  assert.ok(r.events.some(([c, p]) => c === 'app:status' && /Ann/.test(p.message)), 'visible notice');
  await sleep(10);
  await r.line('Ann'); await sleep(10); await r.pipeline.designIdle();
  assert.ok(r.voices.get('Ann').custom_voice, 'retried later');
});

test('voice design: an avoided name is removed as a word, never from inside another word', () => {
  const { sanitizeDescription } = require('../main/voice-design');
  assert.equal(sanitizeDescription('A calm voice, a Samurai spirit, Sam sounds warm and clear.', ['Sam']).includes('Samurai'), true);
});

test('designPreviews uses the description the player typed, and falls back to Grok/profile text when blank', async () => {
  const seen = [];
  const designer = () => ({ design: async () => ({ voice_id: 'X', name: 'n' }), remove: async () => true,
    previews: async ({ description }) => { seen.push(description); return { description, previews: [{ id: 'p1', mime: 'audio/mpeg', data: 'AA' }] }; } });
  const r = rig({ designer });
  await r.line('Nicole');
  await r.pipeline.designPreviews({ game: 'g', speaker: 'Nicole', description: '  a   gruff old fisherman ' });
  assert.equal(seen[0], 'a gruff old fisherman');
  await r.pipeline.designPreviews({ game: 'g', speaker: 'Nicole', description: '' });
  assert.ok(seen[1] && seen[1] !== 'a gruff old fisherman', 'blank falls back to a generated description');
});

test('describeVoice returns the draft description without making or saving anything', async () => {
  let made = 0;
  const designer = () => ({ design: async () => { made++; return { voice_id: 'X', name: 'n' }; }, remove: async () => true, previews: async () => { made++; return { description: 'd', previews: [] }; } });
  const r = rig({ designer });
  await r.line('Nicole'); await r.pipeline.designIdle(); // the automatic queue may design her; only count what describeVoice does
  made = 0;
  const draft = await r.pipeline.describeVoice({ game: 'g', speaker: 'Nicole' });
  assert.ok(typeof draft === 'string' && draft.length > 10);
  assert.equal(made, 0);
});
