'use strict';
// Reconcile: "Girl 1", "???", "m_name" are the researched characters; Grok (mocked) maps them, safely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const { createCastBook } = require('../main/cast');
const catalog = require('../voices_catalog.json');

const PRESET = catalog[0].voice_id;
const prof = (speaker, extra = {}) => ({ speaker, gender: 'female', age_range: 'teen', personality: 'p', voice_id: PRESET,
  stability: 0.5, style: 0.3, speed: 1, reason: 'r', source: 'grok', ...extra });
const girl = (name, gender = 'female') => ({ name, aliases: [], protagonist: false, gender, age_range: 'teen',
  personality: '', voice: '', origin: '', speech: '' });
const RESEARCH = [girl('Sayori'), girl('Natsuki'), girl('Yuri'), girl('Monika'), { ...girl('MC', 'male'), protagonist: true }];

// answer: what Grok says ({label: name|null}); key: Grok key or ''. Returns calls count and the pieces.
function rig(answer, { key = 'k', labels = ['Girl 1', 'Girl 2', 'Girl 3', '???', 'Sayori', 'Natsuki', 'Yuri', 'Monika'], gender } = {}) {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((v) => v.voice_id), catalog });
  fs.writeFileSync(path.join(dir, 'cast.json'), JSON.stringify({ g: { name: 'DDLC', at: 1, setting: {}, characters: RESEARCH } }));
  const calls = { grok: 0, ai: 0 };
  const settings = { getKey: () => key, narration: () => true, customVoices: () => false };
  const fetch = async () => {
    calls.grok++;
    return { ok: true, json: async () => ({ output_text: JSON.stringify(answer) }) };
  };
  let t = 1000;
  const cast = createCastBook({ file: path.join(dir, 'cast.json'), settings, fetch });
  const pipeline = createPipeline({
    voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, settleMs: 0, castWaitMs: 50, settings, cast,
    emit: () => {}, speak: async () => Buffer.from('mp3'), now: () => t, usage: { recordAI: () => { calls.ai++; } },
    profileCharacter: async (c) => prof(c.speaker), profileCharacters: async () => [],
  });
  const voices = store.forGame('g');
  for (const n of labels) voices.setAuto(prof(n, gender && gender[n] ? { gender: gender[n] } : {}));
  if (voices.has('Girl 1')) voices.update('Girl 1', { muted: true }); // untouched by the merge: muted carries over
  return { pipeline, voices, calls, tick: (ms) => { t += ms; } };
}

test('reconcile: Girl 1/2/3 and ??? fold into the four real characters, keeping custom voice, lines and lock', async () => {
  const r = rig({ 'Girl 1': 'Sayori', 'Girl 2': 'natsuki', 'Girl 3': 'Yuri', '???': 'Monika' });
  r.voices.touch('Girl 1', 1); r.voices.touch('Sayori', 2);
  r.voices.setAuto(prof('Girl 2', { custom_voice: { voice_id: 'C2', name: 'n', description: 'd' } })); // a designed voice survives
  r.voices.update('Monika', { stability: 0.9 }); // locks Monika
  const n = await r.pipeline.reconcile('g', true);
  assert.equal(n, 4);
  assert.deepEqual(Object.keys(r.voices.all()).sort(), ['Monika', 'Natsuki', 'Sayori', 'Yuri']);
  assert.equal(r.voices.get('Sayori').lines, 2);
  assert.equal(r.voices.get('Sayori').muted, true);
  assert.equal(r.voices.get('Natsuki').custom_voice.voice_id, 'C2');
  assert.equal(r.voices.get('Monika').locked, true);
  assert.equal(r.voices.get('Monika').stability, 0.9);
  assert.equal(r.calls.ai, 1);
});

test('reconcile: a name that was not researched is ignored', async () => {
  const r = rig({ 'Girl 1': 'Hatsune', 'Girl 2': null }, { labels: ['Girl 1', 'Girl 2', 'Sayori'] });
  assert.equal(await r.pipeline.reconcile('g', true), 0);
  assert.equal(r.voices.has('Girl 1'), true);
});

test('reconcile: a crowd label mapped to null stays', async () => {
  const r = rig({ 'Student 4': null, 'Girl 1': 'Sayori' }, { labels: ['Student 4', 'Girl 1'] });
  assert.equal(await r.pipeline.reconcile('g', true), 1);
  assert.equal(r.voices.has('Student 4'), true);
  assert.equal(r.voices.has('Girl 1'), false);
});

test('reconcile: gender mismatch is skipped; the protagonist and Narrator are never targets or sources', async () => {
  const r = rig({ 'Girl 1': 'Yuri', 'Girl 2': 'MC' }, { labels: ['Girl 1', 'Girl 2', 'Narrator'], gender: { 'Girl 1': 'male' } });
  assert.equal(await r.pipeline.reconcile('g', true), 0);
  assert.deepEqual(Object.keys(r.voices.all()).sort(), ['Girl 1', 'Girl 2', 'Narrator']);
});

test('reconcile: rate limited to once per 3 minutes and only when the labels change', async () => {
  const r = rig({ 'Student 4': null }, { labels: ['Student 4'] });
  await r.pipeline.reconcile('g', true);
  assert.equal(r.calls.grok, 1);
  await r.pipeline.reconcile('g', true);
  assert.equal(r.calls.grok, 1, 'same labels: no new call even when forced');
  r.voices.setAuto(prof('Girl 9'));
  await r.pipeline.reconcile('g');
  assert.equal(r.calls.grok, 1, 'labels changed but under 3 minutes');
  r.tick(3 * 60 * 1000 + 1);
  await r.pipeline.reconcile('g');
  assert.equal(r.calls.grok, 2);
});

test('reconcile: no Grok key is a silent no-op', async () => {
  const r = rig({ 'Girl 1': 'Sayori' }, { key: '' });
  assert.equal(await r.pipeline.reconcile('g', true), 0);
  assert.equal(r.calls.grok, 0);
  assert.equal(r.voices.has('Girl 1'), true);
});
