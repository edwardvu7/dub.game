'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCrowdName } = require('../main/godot-names');
const { normalizeCharacters } = require('../main/server');

test('crowd and placeholder labels are not characters', () => {
  for (const n of ['StudentsInHallway', 'Students', 'Crowd', 'CrowdBackground', 'Everyone', 'Customers_Cafe',
    'Voices', 'villagers', 'Background_People']) assert.equal(isCrowdName(n), true, n);
});

test('real names survive', () => {
  for (const n of ['Nicole', 'Mark Borja', 'Cathy', 'Student Council President', 'Crowley', 'Everett', 'Kidd', 'Groupie'])
    assert.equal(isCrowdName(n), false, n);
});

test('godot /characters drops crowds; other engines untouched', () => {
  const list = [{ speaker: 'Nicole' }, { speaker: 'StudentsInHallway' }];
  assert.deepEqual(normalizeCharacters({ engine: 'godot', characters: list }).characters.map((c) => c.speaker), ['Nicole']);
  assert.equal(normalizeCharacters({ engine: 'renpy', characters: list }).characters.length, 2);
});
