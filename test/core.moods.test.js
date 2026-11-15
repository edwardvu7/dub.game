'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createMoods, applyMood, buildPrompt, EMOTIONS, SHIFT, MOOD_STRENGTH, MAX_SHIFT } = require('../main/moods');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const tts = require('../main/tts');
const catalog = require('../voices_catalog.json');

const base = { speaker: 'Mark', voice_id: catalog[0].voice_id, stability: 0.5, style: 0.3, speed: 1, locked: true };

test('applyMood: shifts the voice a little per line, stays in range, never touches the voice itself', () => {
  assert.equal(applyMood(base, null), base);
  assert.equal(applyMood(base, { emotion: 'neutral', intensity: 1 }), base);
  const scared = applyMood(base, { emotion: 'scared', intensity: 1 });
  assert.ok(scared.stability < base.stability && scared.speed > base.speed);
  assert.equal(scared.voice_id, base.voice_id);
  assert.equal(scared.locked, true, 'the player\'s voice stays the base');
  const half = applyMood(base, { emotion: 'scared', intensity: 0.5 });
  assert.ok(half.stability > scared.stability, 'intensity scales the shift');
  const edge = applyMood({ ...base, stability: 0.05, speed: 1.19 }, { emotion: 'shout', intensity: 9 });
  assert.equal(edge.stability, 0);
  assert.ok(edge.speed <= 1.2);
  assert.equal(applyMood(base, { emotion: 'made-up', intensity: 1 }), base);
});

test('applyMood: strength is halved and max intensity stays within the bounds of the players values', () => {
  assert.equal(MOOD_STRENGTH, 0.5);
  const scared = applyMood(base, { emotion: 'scared', intensity: 1 });
  assert.equal(scared.stability, 0.35, '-0.3 halved is -0.15');
  assert.equal(scared.speed, 1.04, '+0.08 halved is +0.04');
  for (const stability of [0.2, 0.5, 0.8]) for (const speed of [0.8, 1, 1.15]) {
    const user = { ...base, stability, style: 0.4, speed, volume: 0.85 };
    for (const emotion of EMOTIONS) {
      const o = applyMood(user, { emotion, intensity: 1 });
      assert.ok(Math.abs(o.stability - stability) <= MAX_SHIFT.stability + 0.011, emotion);
      assert.ok(Math.abs(o.style - 0.4) <= MAX_SHIFT.style + 0.011, emotion);
      assert.ok(Math.abs(o.speed - speed) <= speed * MAX_SHIFT.speedRel + 0.011, emotion);
      assert.equal(o.volume, 0.85, 'moods never touch volume');
    }
  }
  assert.ok(Object.keys(SHIFT).length === EMOTIONS.length);
});

test('moods: prompt asks Grok to be restrained', () => {
  assert.match(buildPrompt([{ speaker: 'A', text: 'hi' }], []), /restrained/);
});

test('moods: one Grok call directs the coming lines; no call while enough are ready', async () => {
  const calls = [];
  const settings = { getKey: () => 'k', acting: () => true };
  const usage = { n: 0, recordAI() { this.n++; } };
  const moods = createMoods({ settings, usage, callGrok: async (req) => {
    calls.push(req);
    const n = (req.input.match(/^\d+\. /gm) || []).length;
    return { lines: Array.from({ length: n }, (_, i) => ({ i, emotion: i % 2 ? 'sad' : 'happy', intensity: 2 })) };
  } });
  const lines = Array.from({ length: 25 }, (_, i) => ({ speaker: 'Mark', text: 'Line ' + i }));
  await moods.prepare('g', lines.slice(0, 20), [{ speaker: 'Cathy', text: 'Hi.' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /Cathy: Hi\./, 'the scene so far is sent as context');
  assert.deepEqual(moods.get('g', 'Mark', 'Line 1'), { emotion: 'sad', intensity: 1 }, 'intensity is clamped');
  await moods.prepare('g', lines.slice(1, 21), []);
  assert.equal(calls.length, 1, 'the next 5 lines are ready: no call');
  await moods.prepare('g', lines.slice(18, 25), []);
  assert.equal(calls.length, 2, 'running low: one more call');
  assert.equal((calls[1].input.match(/^\d+\. /gm) || []).length, 5, 'only the missing lines are asked for');
  assert.equal(usage.n, 2, 'Grok calls are counted');
  assert.equal(moods.get('other', 'Mark', 'Line 1'), null, 'moods are per game');
});

test('moods: off without a key or when acting is switched off; errors are reported, not thrown', async () => {
  let calls = 0;
  const on = { v: true };
  const statuses = [];
  const moods = createMoods({ settings: { getKey: () => 'k', acting: () => on.v }, emitStatus: (m) => statuses.push(m),
    callGrok: async () => { calls++; throw new Error('Grok 429'); } });
  on.v = false;
  await moods.prepare('g', [{ speaker: 'A', text: 'x' }], []);
  assert.equal(calls, 0);
  on.v = true;
  await moods.prepare('g', [{ speaker: 'A', text: 'x' }], []);
  assert.equal(calls, 1);
  assert.match(statuses[0], /429/);
  const noKey = createMoods({ settings: { getKey: () => '', acting: () => true }, callGrok: async () => { calls++; } });
  await noKey.prepare('g', [{ speaker: 'A', text: 'y' }], []);
  assert.equal(calls, 1);
});

test('moods: prompt asks for JSON with the emotion list', () => {
  const p = buildPrompt([{ speaker: 'Mark', text: 'Run!' }], []);
  for (const e of EMOTIONS) assert.ok(p.includes(e));
  assert.match(p, /JSON only/);
  assert.match(p, /0\. Mark: Run!/);
});

test('tts: surrounding lines go to ElevenLabs as previous_text/next_text, trimmed', () => {
  const body = tts.buildRequest({ text: 'Hi', voice_id: 'abc', stability: 0.5, style: 0, speed: 1,
    previous_text: 'x'.repeat(900), next_text: 'Then what?' }).body;
  assert.equal(body.previous_text.length, 500);
  assert.equal(body.next_text, 'Then what?');
  const plain = tts.buildRequest({ text: 'Hi', voice_id: 'abc' }).body;
  assert.ok(!('previous_text' in plain) && !('next_text' in plain));
});

test('pipeline: a directed line is spoken with its mood and the lines around it; Grok is never waited on', async () => {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json') });
  store.forGame('g').setAuto({ ...base, locked: false });
  const spoken = [];
  const known = new Map([['Run!', { emotion: 'scared', intensity: 1 }]]);
  const prepared = [];
  const moods = { get: (_g, _s, text) => known.get(text) || null, prepare: async (...a) => { prepared.push(a); } };
  const p = createPipeline({ voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, moods,
    settings: { getKey: () => 'k', narration: () => true }, emit: () => {}, settleMs: 0,
    speak: async (params) => { spoken.push(params); return Buffer.from('mp3'); } });
  await p.handleLine({ speaker: 'Mark', text: 'Hello.', game: 'g', upcoming: [{ speaker: 'Mark', text: 'Run!' }] });
  await p.handleLine({ speaker: 'Mark', text: 'Run!', game: 'g', upcoming: [{ speaker: 'Cathy', text: 'Why?' }] });
  assert.equal(spoken[0].stability, 0.5, 'no mood yet: the base voice');
  assert.equal(spoken[0].next_text, 'Run!');
  assert.ok(spoken[1].stability < 0.5, 'the directed line is acted');
  assert.equal(spoken[1].previous_text, 'Hello.');
  assert.equal(spoken[1].next_text, 'Why?');
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[1][1], [{ speaker: 'Cathy', text: 'Why?' }]);
});
