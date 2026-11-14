'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const catalog = require('../voices_catalog.json');

const profileFor = (speaker, i = 0) => ({ speaker, gender: 'female', age_range: 'adult', personality: 'p',
  voice_id: catalog[i].voice_id, stability: 0.5, style: 0.3, speed: 1, reason: 'r', locked: false, source: 'gemini' });

function rig(over = {}) {
  const dir = tmpDir();
  const keys = { elevenlabs: 'el-test', gemini: 'gm-test', ...(over.keys || {}) };
  const state = { narration: true };
  const events = [];
  const calls = { speak: [], one: [], many: [] };
  const voices = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((v) => v.voice_id) });
  const cache = createCache({ dir: path.join(dir, 'cache') });
  const pipeline = createPipeline({
    voices, cache, catalog,
    settings: { getKey: (p) => keys[p], narration: () => state.narration },
    emit: (channel, payload) => events.push({ channel, payload }),
    speak: over.speak || (async (params, key) => { calls.speak.push({ params, key }); return Buffer.from('mp3:' + params.text); }),
    profileCharacter: over.profileCharacter || (async (c, _cat, key, opts) => { calls.one.push({ c, key, opts }); return profileFor(c.speaker, opts && opts.avoidVoiceId ? 4 : 1); }),
    profileCharacters: over.profileCharacters || (async (list) => { calls.many.push(list); return list.map((c, i) => profileFor(c.speaker, i + 2)); }),
  });
  const of = (channel) => events.filter((e) => e.channel === channel).map((e) => e.payload);
  return { dir, keys, state, events, calls, voices, cache, pipeline, of };
}

test('pipeline: first line profiles the character once, speaks, and emits audio:play', async () => {
  const r = rig();
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi!', engine: 'renpy' });
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Again.', engine: 'renpy' });
  assert.equal(r.calls.one.length, 1, 'Gemini is asked once per character');
  assert.deepEqual(r.calls.one[0].c, { speaker: 'Sylvie', samples: ['Hi!'] });
  assert.deepEqual(r.of('line:received')[0], { speaker: 'Sylvie', text: 'Hi!', engine: 'renpy' });
  assert.deepEqual(r.of('audio:play')[0], { speaker: 'Sylvie', text: 'Hi!', mime: 'audio/mpeg',
    data: Buffer.from('mp3:Hi!').toString('base64') });
  assert.equal(r.calls.speak[0].key, 'el-test');
  assert.equal(r.calls.speak[0].params.voice_id, catalog[1].voice_id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'voices.json'), 'utf8')).Sylvie.voice_id, catalog[1].voice_id);
  assert.ok(r.of('voices:changed').length === 0, 'store change events are wired by main/index.js, not the pipeline');
});

test('pipeline: cache hit skips TTS (even with no ElevenLabs key)', async () => {
  const r = rig();
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi!' });
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi!' });
  assert.equal(r.calls.speak.length, 1);
  assert.equal(r.of('audio:play').length, 2);
  r.keys.elevenlabs = '';
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi!' });
  assert.equal(r.of('audio:play').length, 3, 'cached demo scene plays offline');
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Brand new line.' });
  assert.equal(r.of('audio:play').length, 3);
  assert.match(r.of('app:status').at(-1).message, /No ElevenLabs key/);
  // a changed setting is a different cache entry
  r.keys.elevenlabs = 'el-test';
  r.voices.update('Sylvie', { speed: 1.1 });
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi!' });
  assert.equal(r.calls.speak.length, 2);
});

test('pipeline: newest line wins when an older line finishes late', async () => {
  const gates = {};
  const r = rig({ speak: (params) => new Promise((resolve) => { gates[params.text] = () => resolve(Buffer.from(params.text)); }) });
  r.voices.setAuto(profileFor('A'));
  const first = r.pipeline.handleLine({ speaker: 'A', text: 'old' });
  await new Promise((s) => setImmediate(s));
  const second = r.pipeline.handleLine({ speaker: 'A', text: 'new' });
  await new Promise((s) => setImmediate(s));
  gates.new(); await second;
  gates.old(); await first;
  assert.deepEqual(r.of('audio:play').map((p) => p.text), ['new']);
  assert.ok(r.cache.get({ ...profileFor('A'), text: 'old', model: 'eleven_flash_v2_5' }), 'the late clip is still cached');
});

test('pipeline: /stop silences, but a stale stop (older seq) is ignored', async () => {
  const r = rig();
  r.voices.setAuto(profileFor('A'));
  await r.pipeline.handleLine({ speaker: 'A', text: 'one', seq: 1 });
  await r.pipeline.handleLine({ speaker: 'A', text: 'two', seq: 2 });
  r.pipeline.handleStop({ seq: 1 });
  assert.equal(r.of('audio:stop').length, 0, 'stop for line 1 arrived after line 2 started');
  r.pipeline.handleStop({ seq: 2 });
  r.pipeline.handleStop({});
  assert.equal(r.events.filter((e) => e.channel === 'audio:stop').length, 2);
});

test('pipeline: locked profiles are never sent to Gemini or overwritten', async () => {
  const r = rig();
  r.voices.setAuto(profileFor('Sylvie', 0));
  r.voices.update('Sylvie', { voice_id: catalog[5].voice_id });
  await r.pipeline.handleCharacters({ characters: [{ speaker: 'Sylvie', samples: [] }, { speaker: 'Rin', samples: ['yo'] }] });
  assert.deepEqual(r.calls.many[0].map((c) => c.speaker), ['Rin']);
  assert.equal(r.voices.get('Sylvie').voice_id, catalog[5].voice_id);
  assert.equal(r.voices.get('Sylvie').locked, true);
  assert.equal(r.voices.setAuto(profileFor('Sylvie', 7)).voice_id, catalog[5].voice_id, 'store itself refuses too');
  await r.pipeline.handleLine({ speaker: 'Sylvie', text: 'Hi' });
  assert.equal(r.calls.one.length, 0);
});

test('pipeline: /characters profiles the cast in one batch; lines arriving meanwhile wait for it', async () => {
  let release;
  const r = rig({ profileCharacters: (list) => new Promise((resolve) => { release = () => resolve(list.map((c, i) => profileFor(c.speaker, i + 2))); }) });
  const batch = r.pipeline.handleCharacters({ characters: [{ speaker: 'A', samples: [] }, { speaker: 'B', samples: [] }, { speaker: 'Narrator', samples: [] }] });
  const line = r.pipeline.handleLine({ speaker: 'B', text: 'early' });
  await new Promise((s) => setImmediate(s));
  release();
  await Promise.all([batch, line]);
  assert.equal(r.calls.one.length, 0, 'no second Gemini call for B');
  assert.equal(r.voices.get('B').voice_id, catalog[3].voice_id);
  assert.equal(r.calls.speak[0].params.voice_id, catalog[3].voice_id);
  assert.equal(r.voices.has('Narrator'), false);
  await r.pipeline.handleCharacters({ characters: [{ speaker: 'A', samples: [] }] });
  assert.equal(r.calls.speak.length, 1, 'second launch: nothing to profile');
});

test('pipeline: no Gemini key or a Gemini error gives a placeholder that is upgraded later', async () => {
  const r = rig({ keys: { gemini: '' } });
  await r.pipeline.handleLine({ speaker: 'Mika', text: 'Hello' });
  assert.equal(r.voices.get('Mika').source, 'fallback');
  assert.equal(r.of('audio:play').length, 1, 'still speaks with the placeholder voice');
  r.keys.gemini = 'gm-test';
  await r.pipeline.handleLine({ speaker: 'Mika', text: 'Hello again' });
  assert.equal(r.voices.get('Mika').source, 'gemini');

  const failing = rig({ profileCharacter: async () => { throw new Error('Gemini 429: Quota exceeded'); } });
  await failing.pipeline.handleLine({ speaker: 'Mika', text: 'Hello' });
  await failing.pipeline.handleLine({ speaker: 'Mika', text: 'Two' });
  assert.equal(failing.voices.get('Mika').source, 'fallback');
  assert.equal(failing.of('audio:play').length, 2);
  assert.equal(failing.of('app:status').filter((s) => /429/.test(s.message)).length, 1, 'asked once, reported once');
});

test('pipeline: narrator uses one calm built-in voice, or is skipped when narration is off', async () => {
  const r = rig();
  await r.pipeline.handleLine({ speaker: 'Narrator', text: 'It was raining.' });
  assert.equal(r.calls.one.length, 0, 'Gemini is not asked about the narrator');
  assert.match(catalog.find((v) => v.voice_id === r.voices.get('Narrator').voice_id).description, /narrator/i);
  r.state.narration = false;
  await r.pipeline.handleLine({ speaker: 'Narrator', text: 'Still raining.' });
  assert.equal(r.of('audio:play').length, 1);
  assert.equal(r.of('line:received').length, 2, 'the overlay still shows the line');
  await r.pipeline.handleLine({ speaker: 'unknown', text: 'Clipboard text', engine: 'clipboard' });
  assert.equal(r.voices.get('unknown').source, 'builtin');
});

test('pipeline: preview and re-roll', async () => {
  const r = rig();
  await assert.rejects(() => r.pipeline.preview({ speaker: 'Nobody' }), /Unknown character/);
  r.voices.setAuto(profileFor('Sylvie', 1));
  r.voices.update('Sylvie', { stability: 0.2 });
  assert.equal(await r.pipeline.preview({ speaker: 'Sylvie' }), true);
  assert.match(r.of('audio:play')[0].text, /Sylvie/);
  await r.pipeline.preview({ speaker: 'Sylvie', text: 'Custom.' });
  assert.equal(r.of('audio:play')[1].text, 'Custom.');

  const next = await r.pipeline.reroll({ speaker: 'Sylvie' });
  assert.equal(r.calls.one[0].opts.avoidVoiceId, catalog[1].voice_id);
  assert.deepEqual([next.voice_id, next.locked], [catalog[4].voice_id, false]);
  r.keys.gemini = '';
  await assert.rejects(() => r.pipeline.reroll({ speaker: 'Sylvie' }), /Gemini key/);
});
