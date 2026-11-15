'use strict';
// speaker_id: one character under changing names (Doki Doki's "Girl 1" -> "Sayori"), the protagonist, the narrator.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const { normalizeLine, normalizeCharacters } = require('../main/server');
const profiler = require('../main/profiler');
const castMod = require('../main/cast');
const catalog = require('../voices_catalog.json');

const PRESET = catalog[0].voice_id;
const prof = (speaker, extra = {}) => ({ speaker, gender: 'female', age_range: 'teen', personality: 'p', voice_id: PRESET,
  stability: 0.5, style: 0.3, speed: 1, reason: 'r', source: 'grok', ...extra });

// research: array of {name, aliases, protagonist}, most important first (null = no research)
function rig(research = null) {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((v) => v.voice_id), catalog });
  const asked = [];
  let n = 0;
  const found = (s) => castMod.match(research, s);
  const cast = research && {
    ensure() {}, resolve: (_g, s) => { const c = found(s); return c ? c.name : s; },
    notes: () => '', setting: () => '', detail: () => ({}), has: () => true,
    rank: (_g, s) => { const c = found(s); return c ? research.indexOf(c) : -1; },
    protagonist: (_g, s) => { const c = found(s); return !!(c && c.protagonist); },
  };
  const pipeline = createPipeline({
    voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, settleMs: 0, castWaitMs: 50, designBackoffMs: 1,
    settings: { getKey: () => 'k', narration: () => true, customVoices: () => true },
    emit: () => {}, fetch: async () => { throw new Error('offline'); }, cast: cast || undefined,
    speak: async () => Buffer.from('mp3'),
    profileCharacter: async (c) => { asked.push(c); return prof(c.speaker, c.protagonist ? { gender: 'male', age_range: 'teen' } : {}); },
    designer: { design: async () => ({ voice_id: 'Cust' + (++n), name: 'n' }), remove: async () => true },
  });
  const voices = store.forGame('g');
  const line = (speaker, speaker_id, text = 'Hello there') => pipeline.handleLine({ speaker, speaker_id, text, game: 'g' });
  return { pipeline, voices, asked, line };
}

test('speaker_id rename: Girl 1 becomes Sayori and keeps voice, designed voice and lines', async () => {
  const r = rig([]);
  await r.line('Girl 1', 's');
  await r.pipeline.designIdle(); // early character: designed at once
  const custom = r.voices.get('Girl 1').custom_voice;
  assert.ok(custom);
  await r.line('Sayori', 's');
  assert.equal(r.voices.has('Girl 1'), false, 'the placeholder entry is gone');
  const p = r.voices.get('Sayori');
  assert.equal(p.custom_voice.voice_id, custom.voice_id);
  assert.equal(p.voice_id, PRESET);
  assert.equal(p.lines, 2);
  assert.equal(Object.keys(r.voices.all()).length, 1);
});

test('speaker_id: a placeholder after the reveal files under the real name; no id means no merge', async () => {
  const r = rig();
  await r.line('Sayori', 's');
  await r.line('???', 's');
  assert.deepEqual(Object.keys(r.voices.all()), ['Sayori']);
  await r.line('Girl 7', undefined);
  assert.equal(r.voices.has('Girl 7'), true);
});

test('design: "Girl 1" is an alias of a researched main character and gets a designed voice at once', async () => {
  const r = rig([{ name: 'Sayori', aliases: ['Girl 1'], protagonist: false }]);
  await r.line('Girl 1', 's');
  await r.pipeline.designIdle();
  assert.ok(r.voices.get('Sayori').custom_voice, 'resolved by alias, so it is researched/main');
  assert.equal(r.voices.has('Girl 1'), false);
});

test('design: unresolved placeholders qualify only among the first few ids met; Student 1 never', async () => {
  const r = rig([{ name: 'Sayori', aliases: [], protagonist: false }]);
  await r.line('Girl 2', 'n');
  await r.line('Student 1', undefined);
  for (let i = 0; i < 4; i++) await r.line('Extra ' + i, 'x' + i);
  await r.pipeline.designIdle();
  assert.ok(r.voices.get('Girl 2').custom_voice);
  assert.equal(r.voices.get('Student 1').custom_voice, undefined);
  assert.equal(r.voices.get('Extra 3').custom_voice, undefined, 'the 6th id met is past the early window');
});

test('protagonist: speaker_id mc is cast as a teenage boy even if Grok said otherwise', async () => {
  const r = rig([]);
  await r.line('Alex', 'mc');
  assert.equal(r.asked[0].protagonist, true);
  assert.equal(r.asked[0].gender, 'male');
  assert.equal(r.asked[0].age_range, 'teen');
  // sanitizeProfile and fitVoice enforce it on whatever the model returns
  const p = profiler.sanitizeProfile({ gender: 'female', age_range: 'adult', voice_id: PRESET }, 'Alex', catalog, { protagonist: true });
  assert.equal(p.gender, 'male');
  assert.equal(p.age_range, 'teen');
  assert.match(catalog.find((v) => v.voice_id === p.voice_id).description, /young man/);
  const fb = profiler.fallbackProfile('Alex', catalog, 'test', { protagonist: true });
  assert.match(catalog.find((v) => v.voice_id === fb.voice_id).description, /young man, American/);
  assert.match(profiler.prompt([{ speaker: 'Alex', protagonist: true }], catalog, {}), /teenage boy/);
  assert.match(profiler.buildVoiceDescriptionPrompt({ speaker: 'Alex', protagonist: true }, '', ''), /male player character/);
});

test('protagonist: the research flag and labels like MC resolve to the player character', () => {
  const c = [{ name: 'Hero', aliases: ['You'], protagonist: true, gender: 'male', age_range: 'teen' }];
  assert.equal(castMod.match(c, 'MC').name, 'Hero');
  assert.equal(castMod.isProtagonistName('mc'), true);
});

test('narrator: a builtin older-leaning American man, not British, young or custom', async () => {
  const r = rig([]);
  await r.line('Narrator', undefined, 'It rained.');
  await r.pipeline.designIdle();
  const p = r.voices.get('Narrator');
  assert.match(catalog.find((v) => v.voice_id === p.voice_id).description, /(older|middle-aged) man, American/);
  assert.equal(p.gender, 'male');
  assert.equal(p.custom_voice, undefined);
});

test('server: speaker_id and characters[].id are accepted when valid and ignored otherwise', () => {
  assert.equal(normalizeLine({ text: 'Hi', speaker: 'Sayori', speaker_id: 's' }).speaker_id, 's');
  assert.equal(normalizeLine({ text: 'Hi', speaker_id: 'bad id!' }).speaker_id, undefined);
  assert.equal(normalizeLine({ text: 'Hi', speaker_id: 'x'.repeat(41) }).speaker_id, undefined);
  assert.equal(normalizeLine({ text: 'Hi', speaker_id: 5 }).speaker_id, undefined);
  const out = normalizeCharacters({ characters: [{ id: 'm', speaker: 'Monika', samples: ['a'] }, { id: '../x', speaker: 'Yuri' }] });
  assert.equal(out.characters[0].id, 'm');
  assert.equal('id' in out.characters[1], false);
});

test('research prompt names the wiki, the protagonist and placeholder aliases', () => {
  const p = castMod.prompt('Doki Doki Literature Club', []);
  assert.match(p, /Fandom wiki/);
  assert.match(p, /protagonist: true/);
  assert.match(p, /"Girl 1"/);
  assert.match(p, /first appearance/);
});
