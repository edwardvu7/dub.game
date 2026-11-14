'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fakeSteam, tmpDir } = require('./helpers');
const { createTagCheck, tagNames, classify } = require('../main/steam/tags');
const { createGames } = require('../main/steam');

// SteamSpy's documented reply: tags is an object of tag name -> votes ([] when there are none).
const reply = (name, tags) => ({ appid: 1, name, developer: 'x', tags });
const fakeFetch = (byId, calls = []) => async (url) => {
  calls.push(url);
  const id = new URL(url).searchParams.get('appid');
  const body = byId[id];
  if (body === 'down') throw new Error('network down');
  return { ok: true, status: 200, json: async () => body || {} };
};

test('tagNames reads the SteamSpy object form, arrays, and nothing', () => {
  assert.deepEqual(tagNames({ tags: { 'Visual Novel': 900, Anime: 400 } }), ['Visual Novel', 'Anime']);
  assert.deepEqual(tagNames({ tags: [] }), []);
  assert.deepEqual(tagNames({ tags: ['Story Rich'] }), ['Story Rich']);
  assert.deepEqual(tagNames({ tags: [{ name: 'Otome' }] }), ['Otome']);
  assert.deepEqual(tagNames(null), []);
});

test('classify: story tags, case-insensitive', () => {
  assert.equal(classify(['Action', 'visual novel']), 'story');
  assert.equal(classify(['Story Rich']), 'story');
  assert.equal(classify(['Dating Sim']), 'story');
  assert.equal(classify(['FPS', 'Shooter', 'Multiplayer']), 'other');
  assert.equal(classify([]), 'other');
});

test('lookup: classifies, caches to disk, and never re-asks for a known game', async () => {
  const file = path.join(tmpDir(), 'steam-tags.json');
  const calls = [];
  const check = createTagCheck({ file, gapMs: 0, fetch: fakeFetch({
    10: reply('Until Then', { Adventure: 500, 'Story Rich': 300 }),
    20: reply('Some Shooter', { FPS: 900, Action: 800 }),
  }, calls) });
  const kinds = await check.lookup(['10', '20']);
  assert.equal(kinds.get('10'), 'story');
  assert.equal(kinds.get('20'), 'other');
  assert.equal(calls.length, 2);
  await check.lookup(['10', '20']);
  assert.equal(calls.length, 2, 'cached in memory');
  const again = createTagCheck({ file, gapMs: 0, fetch: fakeFetch({}, calls) });
  assert.equal(again.known('10'), 'story', 'cached on disk across restarts');
  assert.equal(calls.length, 2);
});

test('lookup: failures are "unknown", not cached, and retried only after a pause', async () => {
  let t = 0;
  const calls = [];
  const byId = { 30: 'down', 40: {} /* SteamSpy's empty record for an unknown id */ };
  const check = createTagCheck({ file: path.join(tmpDir(), 't.json'), gapMs: 0, now: () => t, retryMs: 1000,
    fetch: fakeFetch(byId, calls) });
  const kinds = await check.lookup(['30', '40']);
  assert.equal(kinds.get('30'), 'unknown');
  assert.equal(kinds.get('40'), 'unknown');
  await check.lookup(['30']);
  assert.equal(calls.length, 2, 'no retry straight away');
  t += 2000;
  byId[30] = reply('Back up', { 'Visual Novel': 5 });
  assert.equal((await check.lookup(['30'])).get('30'), 'story');
});

test('lookup: requests are spaced out to respect the rate limit', async () => {
  const stamps = [];
  const check = createTagCheck({ file: path.join(tmpDir(), 't.json'), gapMs: 60,
    fetch: async () => { stamps.push(Date.now()); return { ok: true, json: async () => reply('x', {}) }; } });
  await Promise.all([check.lookup(['1', '2']), check.lookup(['3'])]);
  assert.equal(stamps.length, 3, 'two concurrent rescans share one queue');
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 50, 'gap between requests');
});

test('games: non-Ren\'Py Steam games appear only once their tags say story; Ren\'Py always', async () => {
  const t = fakeSteam();
  const ids = {};
  for (const g of await createGames({ userData: tmpDir(), steamPath: t.steam }).list()) ids[g.engine] = g.appid;
  assert.ok(ids.renpy && ids.unity && ids.godot && ids['rpgmaker-mz'], 'fixture has all four engines');

  const byId = {
    [ids.unity]: reply('Story Unity Game', { 'Story Rich': 50 }),
    [ids.godot]: reply('Godot Platformer', { Platformer: 90 }),
    [ids['rpgmaker-mz']]: 'down',
  };
  const changes = [];
  const games = createGames({ userData: tmpDir(), steamPath: t.steam,
    tagCheck: createTagCheck({ file: path.join(tmpDir(), 'tags.json'), gapMs: 0, fetch: fakeFetch(byId) }),
    onChange: (list) => changes.push(list) });

  const first = await games.list();
  assert.ok(first.every((g) => g.engine === 'renpy'), 'before tags are known only Ren\'Py games show');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes.length, 1, 'the list refreshes once the lookup finds a story game');
  const engines = changes[0].map((g) => g.engine);
  assert.ok(engines.includes('unity'), 'Unity game tagged Story Rich is listed');
  assert.ok(!engines.includes('godot'), 'Godot platformer is not');
  assert.ok(!engines.includes('rpgmaker-mz'), 'lookup failed: not listed yet');
  assert.ok(engines.includes('renpy'));
});

test('games: a folder added by hand is listed whatever its engine', async () => {
  const t = fakeSteam();
  const unityDir = path.join(t.common1, 'UnityThing');
  assert.ok(fs.existsSync(unityDir));
  const games = createGames({ userData: tmpDir(), steamPath: t.steam, pickFolder: async () => unityDir,
    tagCheck: createTagCheck({ file: path.join(tmpDir(), 'tags.json'), gapMs: 0, fetch: fakeFetch({}) }) });
  const list = await games.addFolder();
  assert.ok(list.some((g) => g.appid.startsWith('local:') && g.engine === 'unity'));
});
