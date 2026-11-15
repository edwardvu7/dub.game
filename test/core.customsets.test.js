'use strict';
// Two voice sets per character (preset + designed), the effective-voice rule, and the automatic design queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore, effectiveVoiceId } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline, MAX_CUSTOM_PER_GAME } = require('../main/pipeline');
const catalog = require('../voices_catalog.json');

const PRESET = catalog[0].voice_id;
const prof = (speaker, extra = {}) => ({ speaker, gender: 'female', age_range: 'adult', personality: 'p', voice_id: PRESET,
  stability: 0.5, style: 0.3, speed: 1, reason: 'r', source: 'grok', ...extra });

test('effectiveVoiceId: on/off, with and without custom_voice, use_preset', () => {
  const c = { voice_id: 'Cust1', name: 'n', description: 'd' };
  assert.equal(effectiveVoiceId({ voice_id: 'P', custom_voice: c }, true), 'Cust1');
  assert.equal(effectiveVoiceId({ voice_id: 'P', custom_voice: c }, false), 'P');
  assert.equal(effectiveVoiceId({ voice_id: 'P' }, true), 'P');
  assert.equal(effectiveVoiceId({ voice_id: 'P', custom_voice: c, use_preset: true }, true), 'P');
  assert.equal(effectiveVoiceId({ voice_id: 'P', custom_voice: c, use_preset: false }, true), 'Cust1');
});

function rig({ designFn, custom = false, elKey = 'el', speakers = [], seed } = {}) {
  const dir = tmpDir();
  const file = path.join(dir, 'voices.json');
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  const store = createVoiceStore({ file, catalogIds: catalog.map((v) => v.voice_id), catalog });
  const flags = { custom };
  const spoken = [];
  const events = [];
  const designs = [];
  let active = 0, maxActive = 0;
  const pipeline = createPipeline({
    voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, settleMs: 0, castWaitMs: 50, designBackoffMs: 1,
    settings: { getKey: (k) => (k === 'elevenlabs' ? elKey : 'gk'), narration: () => true, customVoices: () => flags.custom },
    emit: (ch, p) => events.push([ch, p]), fetch: async () => { throw new Error('offline'); },
    speak: async (params) => { spoken.push(params.voice_id); return Buffer.from('mp3'); },
    profileCharacter: async (c) => prof(c.speaker),
    designer: { design: async ({ name }) => {
      active++; maxActive = Math.max(maxActive, active);
      designs.push(name);
      try {
        if (designFn) return await designFn(name, designs.length);
        await new Promise((r) => setTimeout(r, 2));
        return { voice_id: 'Cust' + designs.length, name };
      } finally { active--; }
    } },
  });
  const voices = store.forGame('g');
  for (const s of speakers) voices.setAuto(prof(s));
  let n = 0;
  const line = (speaker, text = 'Hello there ' + (++n)) => pipeline.handleLine({ speaker, text, game: 'g' });
  return { pipeline, store, voices, flags, spoken, events, designs, line, maxActive: () => maxActive,
    statuses: () => events.filter(([c]) => c === 'app:status').map(([, p]) => p) };
}

test('flipping the setting switches the voice that speaks and loses nothing', async () => {
  const r = rig({ speakers: ['Sylvie'] });
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  const p = r.voices.get('Sylvie');
  assert.equal(p.voice_id, PRESET);
  assert.equal(p.custom_voice.voice_id, 'Cust1');
  await r.line('Sylvie', 'one');
  r.flags.custom = true;
  await r.line('Sylvie', 'two');
  r.flags.custom = false;
  await r.line('Sylvie', 'three');
  assert.deepEqual(r.spoken, [PRESET, 'Cust1', PRESET]);
  const after = r.voices.get('Sylvie');
  assert.equal(after.voice_id, PRESET);
  assert.equal(after.custom_voice.voice_id, 'Cust1');
  assert.equal(after.locked, false); // the switch never locks
});

test('preview uses the effective voice', async () => {
  const r = rig({ speakers: ['Sylvie'], custom: true });
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  await r.pipeline.preview({ game: 'g', speaker: 'Sylvie', text: 'hi' });
  r.flags.custom = false;
  await r.pipeline.preview({ game: 'g', speaker: 'Sylvie', text: 'hi' });
  assert.deepEqual(r.spoken, ['Cust1', PRESET]);
});

test('use_preset: player picks a preset while custom is on; the designed set is kept', async () => {
  const r = rig({ speakers: ['Sylvie'], custom: true });
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  const u = r.voices.update('Sylvie', { voice_id: catalog[1].voice_id, use_preset: true });
  assert.equal(u.locked, true); // picking a catalog voice is a player choice
  await r.line('Sylvie');
  assert.deepEqual(r.spoken, [catalog[1].voice_id]);
  assert.equal(r.voices.update('Sylvie', { use_preset: false }).locked, true); // already locked, switch alone adds nothing
  const r2 = rig({ speakers: ['Bo'] });
  await r2.pipeline.customizeVoice({ game: 'g', speaker: 'Bo' });
  assert.equal(r2.voices.update('Bo', { use_preset: true }).locked, false);
  // redesign clears the override
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  assert.equal(r.voices.get('Sylvie').use_preset, undefined);
});

test('migration: profiles whose voice_id was overwritten get a catalog preset, unlocked, custom kept', () => {
  const female = catalog.find((v) => /woman|female|girl/i.test(v.description));
  const seed = { version: 2, current: 'g', migrated: true, games: { g: { name: 'g', voices: {
    Sylvie: { ...prof('Sylvie', { voice_id: 'Cust9', locked: true, spoken: true }), custom_voice: { voice_id: 'Cust9', name: 'n', description: 'd' } },
    Ok: { ...prof('Ok', { locked: true, spoken: true }), custom_voice: { voice_id: 'Cust8', name: 'n', description: 'd' } },
  } } } };
  const r = rig({ seed });
  const s = r.voices.get('Sylvie');
  assert.notEqual(s.voice_id, 'Cust9');
  assert.ok(catalog.some((v) => v.voice_id === s.voice_id));
  if (female) assert.match(catalog.find((v) => v.voice_id === s.voice_id).description, /woman|female|girl/i);
  assert.equal(s.locked, false);
  assert.equal(s.source, 'fallback'); // Grok recasts it the next time she speaks
  assert.equal(s.custom_voice.voice_id, 'Cust9');
  assert.equal(r.voices.get('Ok').voice_id, PRESET); // a healthy profile is untouched
  assert.equal(r.voices.get('Ok').locked, true);
});

test('queue: designs speakers automatically, one at a time, most-heard first, line never waits', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = rig({ custom: true, designFn: async (name, n) => { if (n === 1) await gate; return { voice_id: 'Cust' + n, name }; } });
  const t0 = Date.now();
  await r.line('Ann'); // first design starts and blocks
  await r.line('Bea'); await r.line('Bea'); await r.line('Cy'); await r.line('Bea'); await r.line('Cy');
  assert.ok(Date.now() - t0 < 1000); // lines were spoken while the design was pending
  assert.equal(r.spoken.length, 6);
  assert.ok(r.spoken.every((v) => v === PRESET), JSON.stringify(r.spoken)); // preset until a custom voice exists
  release();
  await r.pipeline.designIdle();
  assert.equal(r.maxActive(), 1);
  // Ann first (already running), then the most heard: Bea (3) before Cy... but the current speaker wins: Cy spoke last.
  assert.deepEqual(r.designs.map((n) => n.split(' ').pop()), ['Ann', 'Cy', 'Bea']);
  await r.line('Ann');
  assert.equal(r.spoken[r.spoken.length - 1], 'Cust1');
});

test('queue: never designs twice, skips muted, Narrator and characters with a voice', async () => {
  const r = rig({ custom: true, speakers: ['Ann'] });
  r.voices.setAuto(prof('Mute')); r.voices.update('Mute', { muted: true });
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'Ann' });
  r.designs.length = 0;
  await r.line('Ann'); await r.line('Narrator'); await r.line('Mute');
  await r.pipeline.designIdle();
  assert.deepEqual(r.designs, []);
  await r.line('Bo'); await r.line('Bo'); await r.line('Bo');
  await r.pipeline.designIdle();
  await r.line('Bo');
  await r.pipeline.designIdle();
  assert.equal(r.designs.filter((n) => /Bo$/.test(n)).length, 1);
});

test('queue: respects the per-game cap; manual redo still works', async () => {
  const names = Array.from({ length: MAX_CUSTOM_PER_GAME + 2 }, (_, i) => 'C' + i);
  const r = rig({ custom: true });
  for (const n of names) { await r.line(n); await r.pipeline.designIdle(); }
  assert.equal(r.designs.length, MAX_CUSTOM_PER_GAME);
  assert.equal(r.voices.customCount(), MAX_CUSTOM_PER_GAME);
});

test('queue: a hard failure stops it for the session with one notice; manual success resumes', async () => {
  let fail = true;
  const msg = 'ElevenLabs refused Voice Design (step 1/2) (403). ElevenLabs says: x.';
  const r = rig({ custom: true, designFn: async (name, n) => { if (fail) throw Object.assign(new Error(msg), { hard: true }); return { voice_id: 'Cust' + n, name }; } });
  for (const s of ['A', 'B', 'C']) { await r.line(s); await r.pipeline.designIdle(); }
  assert.equal(r.designs.length, 1); // no retry per line
  const errs = r.statuses().filter((s) => s.level === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /ElevenLabs refused Voice Design \(step 1\/2\) \(403\)/);
  assert.match(errs[0].message, /paused/);
  assert.equal(r.spoken.length, 3); // speech was never blocked
  fail = false;
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'A' }); // manual retry works after the stop
  await r.line('B'); await r.pipeline.designIdle();
  assert.ok(r.voices.get('B').custom_voice); // and cleared the stop
});

test('queue: transient errors retry with backoff, bounded', async () => {
  let n = 0;
  const r = rig({ custom: true, designFn: async (name) => { n++; throw new Error('Could not reach ElevenLabs: down'); } });
  await r.line('A');
  await r.pipeline.designIdle();
  await new Promise((res) => setTimeout(res, 40));
  await r.pipeline.designIdle();
  assert.equal(n, 3); // DESIGN_ATTEMPTS, then it waits (retried on a later line) and says so once
  assert.equal(r.statuses().filter((s) => s.level === 'error').length, 1);
  const r2 = rig({ custom: true, designFn: async (name, k) => { if (k === 1) throw new Error('Could not reach ElevenLabs: x'); return { voice_id: 'Cust' + k, name }; } });
  await r2.line('A'); await r2.pipeline.designIdle();
  await new Promise((res) => setTimeout(res, 20)); await r2.pipeline.designIdle();
  assert.equal(r2.voices.get('A').custom_voice.voice_id, 'Cust2');
});

test('queue: off clears it and nothing is designed; on designs already-heard characters', async () => {
  const r = rig({ custom: false, speakers: ['A', 'B'] });
  await r.line('A');
  await r.pipeline.designIdle();
  assert.equal(r.designs.length, 0);
  r.flags.custom = true;
  r.pipeline.customVoicesChanged(true);
  await r.pipeline.designIdle();
  assert.equal(r.designs.length, 1); // only A has spoken
  r.flags.custom = false;
  r.pipeline.customVoicesChanged(false);
  await r.line('B'); await r.pipeline.designIdle();
  assert.equal(r.designs.length, 1);
});

test('queue: no ElevenLabs key means nothing is queued', async () => {
  const r = rig({ custom: true, elKey: '' });
  await r.line('A'); await r.pipeline.designIdle();
  assert.equal(r.designs.length, 0);
});

test('error text names the service for 403', async () => {
  const { callGrok } = require('../main/xai');
  const e = await callGrok({ key: 'k', input: 'x', fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'no credits' }) }) }).catch((x) => x);
  assert.match(e.message, /^xAI refused the request \(403\): check the key and that the team has API credits at console\.x\.ai\./);
  const tts = require('../main/tts');
  const t = await tts.speak({ text: 'a', voice_id: 'abc' }, 'k', { fetch: async () => ({ ok: false, status: 403, text: async () => '{}' }) }).catch((x) => x);
  assert.match(t.message, /^ElevenLabs refused the request \(403\)/);
});

test('custom voices always speak with the better model; preset voices keep the fast one', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createVoiceStore } = require('../main/voices');
  const { createCache } = require('../main/cache');
  const { createPipeline } = require('../main/pipeline');
  const tts = require('../main/tts');
  const catalog = require('../voices_catalog.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-best-'));
  const store = createVoiceStore({ file: path.join(dir, 'voices.json') });
  const v = store.forGame('g');
  v.setAuto({ speaker: 'A', voice_id: catalog[0].voice_id, stability: 0.5, style: 0, speed: 1, source: 'grok' });
  v.setAuto({ speaker: 'B', voice_id: catalog[1].voice_id, stability: 0.5, style: 0, speed: 1, source: 'grok' });
  v.setCustom('B', { voice_id: 'Designed1', name: 'dubplay - B', description: 'x' });
  const models = {};
  const p = createPipeline({ voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, emit: () => {}, settleMs: 0,
    settings: { getKey: () => 'k', narration: () => true, customVoices: () => true, quality: () => 'fast' },
    speak: async (params) => { models[params.voice_id] = params.model; return Buffer.from('mp3'); } });
  await p.handleLine({ speaker: 'A', text: 'Preset line.', game: 'g' });
  await p.handleLine({ speaker: 'B', text: 'Custom line.', game: 'g' });
  assert.equal(models[catalog[0].voice_id], tts.MODEL);
  assert.equal(models.Designed1, tts.BEST_MODEL);
});
