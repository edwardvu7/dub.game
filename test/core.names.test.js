'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { canonicalName } = require('../main/speaker-names');
const { isCrowdName } = require('../main/godot-names');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline } = require('../main/pipeline');
const catalog = require('../voices_catalog.json');

const prof = (speaker, extra = {}) => ({ speaker, gender: 'male', age_range: 'adult', personality: 'p',
  voice_id: catalog[0].voice_id, stability: 0.5, style: 0.3, speed: 1, reason: 'r', locked: false, muted: false, ...extra });
const write = (games) => {
  const file = path.join(tmpDir(), 'voices.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, current: null, games }));
  return file;
};

test('same person: Mark absorbs MarkBorja and MarkSprite; sprite words are stripped', () => {
  assert.equal(canonicalName('MarkBorja', ['Mark', 'MarkBorja']), 'Mark');
  assert.equal(canonicalName('MarkSprite', ['Mark']), 'Mark');
  assert.equal(canonicalName('Sylvie_Happy', ['Sylvie']), 'Sylvie');
  assert.equal(canonicalName('MarkSprite', []), 'Mark');
  assert.equal(canonicalName('Mark', ['Mark', 'MarkBorja']), 'Mark');
});

test('no false merges: Market, Annabel, two surnames, narrator', () => {
  assert.equal(canonicalName('Market', ['Mark']), 'Market');
  assert.equal(canonicalName('Annabel', ['Ann']), 'Annabel');
  assert.equal(canonicalName('Mark Borja', ['Mark', 'Mark Borja', 'Mark Santos']), 'Mark Borja');
  assert.equal(canonicalName('Mark Santos', ['Mark', 'Mark Borja', 'Mark Santos']), 'Mark Santos');
  assert.equal(canonicalName('Narrator', ['Narrator']), 'Narrator');
});

test('crowd and UI labels from the real Until Then list are filtered', () => {
  for (const n of ['Classmates', 'PathNpcKids', 'PathNpcTeens', 'StudentWalkingBy', 'SETTINGS_DEBANDING'])
    assert.equal(isCrowdName(n), true, n);
  for (const n of ['Path', 'Mark', 'Menu Lady'.replace('Menu ', '')]) assert.equal(isCrowdName(n), false, n);
});

test('migration: merges duplicates keeping the locked profile and volume, marks the rest spoken, prunes phantoms', () => {
  const file = write({ 'godot:Until Then': { name: 'Until Then', voices: {
    Mark: prof('Mark', { voice_id: 'auto-mark', volume: 1 }),
    MarkBorja: prof('MarkBorja', { voice_id: 'mine', locked: true, volume: 0.4 }),
    MarkSprite: prof('MarkSprite'),
    Classmates: prof('Classmates'), SETTINGS_DEBANDING: prof('SETTINGS_DEBANDING'), PathNpcKids: prof('PathNpcKids'),
    LockedCrowd: prof('LockedCrowd', { locked: true }),
    Nicole: prof('Nicole'),
  } }, 'renpy:Crowd Game': { name: 'x', voices: { Everyone: prof('Everyone') } } });
  const store = createVoiceStore({ file });
  const v = store.all().games['godot:Until Then'].voices;
  assert.deepEqual(Object.keys(v).sort(), ['LockedCrowd', 'Mark', 'Nicole']);
  assert.equal(v.Mark.voice_id, 'mine', 'the locked profile survives');
  assert.equal(v.Mark.locked, true);
  assert.equal(v.Mark.volume, 0.4);
  assert.equal(v.Mark.speaker, 'Mark');
  assert.equal(v.Nicole.spoken, true, 'pre-upgrade entries are kept and marked spoken');
  assert.ok(store.all().games['renpy:Crowd Game'].voices.Everyone, 'only godot games are pruned');
  // It ran once: a new unspoken crowd entry is not pruned on the next load.
  store.forGame('godot:Until Then').setAuto(prof('Extras'));
  const again = createVoiceStore({ file }).all().games['godot:Until Then'].voices;
  assert.ok(again.Extras);
  assert.equal(again.Extras.spoken, false);
});

test('spoken: set when a line is voiced, kept by setAuto, not patchable', async () => {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((c) => c.voice_id) });
  const pipeline = createPipeline({ voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, settleMs: 0,
    settings: { getKey: (p) => (p === 'elevenlabs' ? 'k' : null), narration: () => true }, emit() {},
    speak: async () => Buffer.from('mp3') });
  await pipeline.handleLine({ engine: 'godot', game: 'godot:G', speaker: 'Mark', text: 'Hi' });
  const g = store.forGame('godot:G');
  assert.equal(g.get('Mark').spoken, true);
  assert.equal(g.setAuto(prof('Mark')).spoken, true);
  assert.equal(g.update('Mark', { spoken: false, volume: 0.5 }).spoken, true);
  // Same person under another name goes to the same card.
  await pipeline.handleLine({ engine: 'godot', game: 'godot:G', speaker: 'MarkSprite', text: 'Yo' });
  assert.deepEqual(Object.keys(g.all()), ['Mark']);
  // An unknown crowd label is dropped; a known name containing a crowd word is not.
  await pipeline.handleLine({ engine: 'godot', game: 'godot:G', speaker: 'StudentWalkingBy', text: 'Hm' });
  assert.equal(g.has('StudentWalkingBy'), false);
  g.setAuto(prof('Path Finder', { spoken: true }));
  await pipeline.handleLine({ engine: 'godot', game: 'godot:G', speaker: 'Path Finder', text: 'Hm' });
  assert.equal(g.has('Path Finder'), true);
});
