'use strict';
// Section C: pure UI helpers, and a guard that the UI only uses IPC channels that exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../ui/lib.js');

const UI = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

test('formatSlider: percent for stability and style, multiplier for speed, clamped', () => {
  assert.equal(L.formatSlider('stability', 0.45), '45%');
  assert.equal(L.formatSlider('style', 7), '100%');
  assert.equal(L.formatSlider('speed', 1.05), '1.05x');
  assert.equal(L.formatSlider('speed', 0.1), '0.70x');
  assert.equal(L.formatSlider('stability', 'nonsense'), '0%');
});

test('slider ranges match what main/voices.js accepts', () => {
  const byKey = Object.fromEntries(L.SLIDERS.map((s) => [s.key, [s.min, s.max]]));
  assert.deepEqual(byKey, { stability: [0, 1], style: [0, 1], speed: [0.7, 1.2] });
});

test('supportBadge and gameStatus', () => {
  assert.equal(L.supportBadge({ support: 'full', engine: 'renpy' }).text, "Ren'Py");
  assert.equal(L.supportBadge({ support: 'beta', engine: 'godot' }).tone, 'beta');
  assert.equal(L.supportBadge({ support: 'soon', engine: 'unity' }).text, 'Unity \u00b7 Coming soon');
  assert.equal(L.supportBadge({ support: 'soon', engine: 'rpgmaker-mz' }).text, 'RPG Maker MZ \u00b7 Coming soon');
  assert.equal(L.gameStatus({ support: 'soon', enabled: true, hookInstalled: true }), 'soon');
  assert.equal(L.gameStatus({ enabled: false, hookInstalled: true }), 'off');
  assert.equal(L.gameStatus({ enabled: true, hookInstalled: true }), 'on');
  assert.equal(L.gameStatus({ enabled: true, hookInstalled: false }), 'missing');
  assert.equal(L.gameStatus(null), 'off');
});

test('gameHint tells the player what to do next', () => {
  assert.equal(L.gameHint({ enabled: true, hookInstalled: false }).tone, 'warn');
  assert.match(L.gameHint({ enabled: true, hookInstalled: true }, true).text, /restart/i);
  assert.equal(L.gameHint({ enabled: true, hookInstalled: true }, false).tone, 'on');
  assert.equal(L.gameHint({ enabled: false }).tone, 'off');
  assert.match(L.gameHint({ support: 'soon', engine: 'godot' }).text, /Godot games aren't available yet/);
});

test('filterGames and sortGames do not mutate, voiced games come first', () => {
  const games = [
    { appid: '1', name: 'zeta', engine: 'renpy', enabled: false },
    { appid: '2', name: 'Alpha', engine: 'godot', enabled: false },
    { appid: '3', name: 'Mid', engine: 'renpy', enabled: true },
  ];
  assert.deepEqual(L.sortGames(games).map((g) => g.appid), ['3', '2', '1']);
  assert.deepEqual(L.sortGames([{ appid: 's', name: 'A', support: 'soon' }, { appid: 'r', name: 'Z', enabled: false }])
    .map((g) => g.appid), ['r', 's'], 'coming-soon games go last');
  assert.equal(games[0].appid, '1');
  assert.deepEqual(L.filterGames(games, ' GODOT ').map((g) => g.appid), ['2']);
  assert.equal(L.filterGames(games, '').length, 3);
  assert.deepEqual(L.filterGames(null, 'x'), []);
});

test('gamesSummary', () => {
  assert.match(L.gamesSummary([]), /No supported games/);
  assert.equal(L.gamesSummary([{ enabled: false }]), '1 game ready for voices. Switch one on or click Launch.');
  assert.equal(L.gamesSummary([{ enabled: true }, { enabled: false }]), '2 games ready for voices, 1 voiced.');
  assert.equal(L.gamesSummary([{ support: 'soon' }, { support: 'soon' }]),
    "No Ren'Py games yet. 2 more games use an engine that is coming soon.");
  assert.equal(L.gamesSummary([{ enabled: true }, { support: 'soon' }]),
    '1 game ready for voices, 1 voiced. 1 more game uses an engine that is coming soon.');
});

test('sortSpeakers: current speaker first, Narrator last', () => {
  const voices = { Narrator: {}, bob: {}, Alice: {}, Zed: {} };
  assert.deepEqual(L.sortSpeakers(voices, 'Zed'), ['Zed', 'Alice', 'bob', 'Narrator']);
  assert.deepEqual(L.sortSpeakers(voices, null), ['Alice', 'bob', 'Zed', 'Narrator']);
  assert.deepEqual(L.sortSpeakers(null), []);
});

test('initials, voiceLabel, keyState, needsSetup', () => {
  assert.equal(L.initials('Doki Doki Literature Club'), 'DD');
  assert.equal(L.initials('Until'), 'UN');
  assert.equal(L.initials(''), '?');
  assert.equal(L.voiceLabel({ name: 'Sarah', description: 'warm' }), 'Sarah (warm)');
  assert.equal(L.voiceLabel(null), 'Unknown voice');
  assert.equal(L.keyState(true).tone, 'ok');
  assert.equal(L.needsSetup({ hasElevenLabsKey: true, hasGeminiKey: false }), true);
  assert.equal(L.needsSetup({ hasElevenLabsKey: true, hasGeminiKey: true }), false);
  assert.equal(L.needsSetup(null), true);
});

test('errorText strips Electron IPC wrapping', () => {
  const wrapped = new Error("Error invoking remote method 'games:setEnabled': Error: Permission denied: C:\\Games");
  assert.equal(L.errorText(wrapped), 'Permission denied: C:\\Games');
  assert.equal(L.errorText('plain'), 'plain');
  assert.equal(L.errorText(null), 'Something went wrong.');
});

test('base64ToBytes round-trips audio bytes', () => {
  const bytes = L.base64ToBytes(Buffer.from([0, 255, 16, 32]).toString('base64'));
  assert.deepEqual(Array.from(bytes), [0, 255, 16, 32]);
  assert.equal(L.base64ToBytes('').length, 0);
});

// ---- Contract guards: the UI must only talk on channels that exist ----
function channelsUsed() {
  const invoke = new Set();
  const events = new Set();
  for (const f of ['app.js', 'cards.js', 'overlay.js']) {
    const src = read(f);
    for (const m of src.matchAll(/invoke\('([a-z]+:[A-Za-z]+)'/g)) invoke.add(m[1]);
    for (const m of src.matchAll(/\.on\('([a-z]+:[A-Za-z]+)'/g)) events.add(m[1]);
    // Channels passed indirectly, e.g. loadGames('games:rescan') or bindSwitch(id, 'settings:x').
    for (const m of src.matchAll(/'((?:games|settings):[A-Za-z]+)'/g)) invoke.add(m[1]);
  }
  for (const ch of events) invoke.delete(ch); // e.g. games:changed is an event, not an invoke
  return { invoke, events };
}

test('every invoke channel the UI uses is answered by fake-dub.js', () => {
  const fake = read('fake-dub.js');
  for (const ch of channelsUsed().invoke) assert.ok(fake.includes(`'${ch}'`), `fake-dub.js has no handler for ${ch}`);
});

test('every channel the UI uses is allowed by main/preload.js (once sections are merged)', (t) => {
  const preload = path.join(__dirname, '..', 'main', 'preload.js');
  if (!fs.existsSync(preload)) return t.skip('main/preload.js is on the section B branch');
  const src = fs.readFileSync(preload, 'utf8');
  const { invoke, events } = channelsUsed();
  for (const ch of [...invoke, ...events]) assert.ok(src.includes(`'${ch}'`), `preload.js does not allow ${ch}`);
});

test('pages load their scripts in dependency order and ship no inline script or style', () => {
  for (const page of ['index.html', 'overlay.html']) {
    const html = read(page);
    const order = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
    assert.deepEqual(order.slice(0, 3), ['fake-dub.js', 'lib.js', 'cards.js'], page);
    for (const f of order) assert.ok(fs.existsSync(path.join(UI, f)), `${page} loads missing ${f}`);
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), `${page} has an inline script (blocked by the CSP)`);
    assert.ok(!/\sstyle="/.test(html), `${page} has an inline style (blocked by the CSP)`);
    assert.ok(fs.existsSync(path.join(UI, 'styles.css')));
  }
});
