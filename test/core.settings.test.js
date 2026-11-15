'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, write } = require('./helpers');
const { createSettings } = require('../main/settings');
const { createVoiceStore } = require('../main/voices');
const { createCache, cacheKey } = require('../main/cache');
const { createHandlers, registerIpc, INVOKE_CHANNELS, EVENT_CHANNELS } = require('../main/ipc');
const { createClipboardWatcher } = require('../main/clipboard');
const { parseEnv, loadEnv } = require('../main/env');
const catalog = require('../voices_catalog.json');

// Stand-in for Electron safeStorage: reversible, and the plaintext never appears in the output.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
  decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString('utf8'),
});
const SECRET_EL = 'sk_player_elevenlabs_secret';
const SECRET_GM = 'xai_player_grok_secret';

test('settings: public shape never contains a key, and the file on disk is encrypted', async () => {
  const file = path.join(tmpDir(), 'settings.json');
  const seen = [];
  const s = createSettings({ file, safeStorage: fakeSafeStorage(), env: {},
    testers: { elevenlabs: async (k) => { seen.push(k); return { ok: true }; }, grok: async () => ({ ok: false, error: 'bad' }) } });
  assert.deepEqual(s.getPublic(), { hasElevenLabsKey: false, hasGrokKey: false, narration: true, clipboardMode: false, acting: true, customVoices: false, quality: 'fast' });

  const out = s.setKeys({ elevenlabs: `  ${SECRET_EL} `, grok: SECRET_GM });
  assert.deepEqual(out, { hasElevenLabsKey: true, hasGrokKey: true, narration: true, clipboardMode: false, acting: true, customVoices: false, quality: 'fast' });
  for (const value of [out, s.getPublic(), s.setNarration(false), await s.test({ provider: 'elevenlabs' }), await s.test({ provider: 'grok' })]) {
    const text = JSON.stringify(value);
    assert.ok(!text.includes(SECRET_EL) && !text.includes(SECRET_GM));
  }
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(SECRET_EL) && !disk.includes(SECRET_GM), 'no plaintext key on disk');
  assert.equal(s.getKey('elevenlabs'), SECRET_EL, 'main process can still read it');
  assert.deepEqual(seen, [SECRET_EL]);
  assert.deepEqual(await s.test({ provider: 'grok' }), { ok: false, error: 'bad' });
  assert.deepEqual(await s.test({ provider: 'nope' }), { ok: false, error: 'Unknown provider.' });

  const reopened = createSettings({ file, safeStorage: fakeSafeStorage(), env: {} });
  assert.equal(reopened.getKey('grok'), SECRET_GM);
  assert.equal(reopened.narration(), false);
  reopened.setKeys({ grok: '' });
  assert.equal(reopened.getPublic().hasGrokKey, false);
  assert.equal(reopened.getPublic().hasElevenLabsKey, true, 'omitted key is left alone');
});

test('settings: .env keys are the dev fallback; player keys win', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const env = { ELEVENLABS_API_KEY: 'dev-el', XAI_API_KEY: '' };
  const s = createSettings({ file, safeStorage: fakeSafeStorage(), env });
  assert.deepEqual([s.getPublic().hasElevenLabsKey, s.getPublic().hasGrokKey], [true, false]);
  assert.equal(s.getKey('elevenlabs'), 'dev-el');
  s.setKeys({ elevenlabs: 'player-el' });
  assert.equal(s.getKey('elevenlabs'), 'player-el');
  assert.equal(s.getKey('constructor'), '');
});

test('settings: without OS encryption a key is kept in memory only, never written in plaintext', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const s = createSettings({ file, safeStorage: fakeSafeStorage(false), env: {} });
  s.setKeys({ elevenlabs: SECRET_EL });
  assert.equal(s.getKey('elevenlabs'), SECRET_EL);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET_EL));
  assert.equal(createSettings({ file, safeStorage: fakeSafeStorage(false), env: {} }).getKey('elevenlabs'), '');
});

test('env: parses .env without overriding real environment variables', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=\nD=x # note\nbad line\n'), { A: '1', B: 'two words', C: '', D: 'x' });
  const file = path.join(tmpDir(), '.env');
  write(file, 'A=file\nB=file\n');
  const target = { A: 'real', B: '' };
  loadEnv(file, target);
  assert.deepEqual(target, { A: 'real', B: 'file' });
  assert.deepEqual(loadEnv(path.join(tmpDir(), 'missing'), {}), {});
});

test('voices store: update locks and validates; setAuto respects the lock; changes are announced', () => {
  const file = path.join(tmpDir(), 'voices.json');
  const root = createVoiceStore({ file, catalogIds: catalog.map((v) => v.voice_id) });
  const store = root.forGame('renpy:Test');
  const changes = [];
  root.onChange((all) => changes.push(all.games['renpy:Test'].voices));
  store.setAuto({ speaker: 'Sylvie', voice_id: catalog[0].voice_id, stability: 0.5, style: 0.3, speed: 1, locked: true });
  assert.equal(store.get('Sylvie').locked, false, 'auto profiles are never born locked');
  const p = store.update('Sylvie', { stability: 3, speed: 0.1, voice_id: catalog[2].voice_id, speaker: 'Hacked', personality: 'x' });
  assert.deepEqual([p.speaker, p.stability, p.speed, p.voice_id, p.locked, p.personality],
    ['Sylvie', 1, 0.7, catalog[2].voice_id, true, undefined]);
  assert.throws(() => store.update('Sylvie', { voice_id: 'not-in-catalog' }), /Bad value/);
  assert.throws(() => store.update('Ghost', {}), /Unknown character/);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].Sylvie.locked, true);
  assert.equal(store.get('toString'), null);
  assert.equal(createVoiceStore({ file }).forGame('renpy:Test').get('Sylvie').locked, true, 'persists');
  assert.equal(store.update('Sylvie', { muted: true }).muted, true, 'muting is allowed');
  write(file, '{broken');
  assert.deepEqual(createVoiceStore({ file }).all(), { current: null, games: {} });
});

test('cache: key depends on voice, settings and text; round trip on disk', () => {
  const base = { voice_id: 'v1', stability: 0.5, style: 0.3, speed: 1, text: 'Hi', model: 'm' };
  assert.match(cacheKey(base), /^[0-9a-f]{40}$/);
  assert.equal(cacheKey(base), cacheKey({ ...base, stability: 0.5000001 }));
  for (const change of [{ voice_id: 'v2' }, { stability: 0.6 }, { style: 0.4 }, { speed: 1.1 }, { text: 'Hi!' }]) {
    assert.notEqual(cacheKey(base), cacheKey({ ...base, ...change }));
  }
  const dir = path.join(tmpDir(), 'cache');
  const cache = createCache({ dir });
  assert.equal(cache.get(base), null);
  cache.put(base, Buffer.from('audio'));
  assert.equal(cache.get(base).toString(), 'audio');
  assert.deepEqual(fs.readdirSync(dir), [cacheKey(base) + '.mp3']);
});

test('ipc: every contract channel has a handler and settings handlers never return keys', async () => {
  const file = path.join(tmpDir(), 'settings.json');
  const settings = createSettings({ file, safeStorage: fakeSafeStorage(), env: {}, testers: { elevenlabs: async () => ({ ok: true }) } });
  const calls = [];
  const track = (name, value) => (arg) => { calls.push([name, arg]); return value; };
  const clip = [];
  const handlers = createHandlers({
    settings, catalog,
    games: { list: track('list', []), rescan: track('rescan', []), addFolder: track('addFolder', []), setEnabled: track('setEnabled', {}), launch: track('launch', true) },
    voices: { all: track('all', {}), current: () => 'renpy:Test', clearGame: track('clearGame', true),
      forGame: (g) => ({ update: (s, p) => { calls.push(['update', g, s, p]); return { speaker: s, locked: true }; } }) },
    pipeline: { reroll: track('reroll', {}), preview: track('preview', true) },
    onClipboardMode: (on) => clip.push(on),
  });
  const contract = ['games:list', 'games:rescan', 'games:addFolder', 'games:setEnabled', 'games:launch', 'voices:get',
    'voices:catalog', 'voices:update', 'voices:reroll', 'voices:preview', 'settings:get', 'settings:setKeys',
    'settings:test', 'settings:setNarration'];
  for (const c of contract) assert.equal(typeof handlers[c], 'function', c);
  for (const c of ['audio:play', 'line:received', 'voices:changed', 'overlay:toggle']) assert.ok(EVENT_CHANNELS.includes(c));

  const registered = {};
  registerIpc({ handle: (c, fn) => { registered[c] = fn; } }, handlers, { isTrusted: (e) => e.ok });
  assert.deepEqual(Object.keys(registered).sort(), [...INVOKE_CHANNELS].sort());
  await assert.rejects(() => registered['settings:get']({ ok: false }), /Untrusted/);

  const out = await registered['settings:setKeys']({ ok: true }, { elevenlabs: SECRET_EL });
  assert.deepEqual(Object.keys(out).sort(), ['acting', 'clipboardMode', 'customVoices', 'hasElevenLabsKey', 'hasGrokKey', 'narration', 'quality']);
  for (const c of ['settings:get', 'settings:setNarration', 'settings:test']) {
    const value = await registered[c]({ ok: true }, c === 'settings:test' ? { provider: 'elevenlabs' } : true);
    assert.ok(!JSON.stringify(value).includes(SECRET_EL), c);
  }
  await registered['games:setEnabled']({ ok: true }, { appid: 1001, enabled: 1 });
  assert.deepEqual(calls.at(-1), ['setEnabled', { appid: '1001', enabled: true }]);
  await registered['voices:update']({ ok: true }, { speaker: 'Sylvie', patch: { speed: 1.1 } });
  assert.deepEqual(calls.at(-1), ['update', 'renpy:Test', 'Sylvie', { speed: 1.1 }], 'no game: the current one');
  await registered['voices:update']({ ok: true }, { game: 'renpy:Other', speaker: 'Sylvie', patch: {} });
  assert.equal(calls.at(-1)[1], 'renpy:Other');
  await assert.rejects(() => registered['games:launch']({ ok: true }, {}), /Missing "appid"/);
  assert.equal((await registered['settings:setClipboardMode']({ ok: true }, true)).clipboardMode, true);
  assert.deepEqual(clip, [true]);
  assert.equal(await registered['voices:catalog']({ ok: true }), catalog);
});

test('preload: exposes exactly window.dub.invoke/on with the same channel lists as ipc.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const exposed = {};
  const sent = [];
  const listeners = {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (c, a) => { sent.push([c, a]); return 'ok'; },
      on: (c, fn) => { listeners[c] = fn; },
      removeListener: (c) => { delete listeners[c]; },
    },
  };
  new Function('require', src)((name) => { assert.equal(name, 'electron'); return fakeElectron; });
  assert.deepEqual(Object.keys(exposed), ['dub']);
  assert.deepEqual(Object.keys(exposed.dub).sort(), ['invoke', 'on']);
  for (const c of INVOKE_CHANNELS) assert.ok(src.includes(`'${c}'`), c);
  for (const c of EVENT_CHANNELS) assert.ok(src.includes(`'${c}'`), c);

  return (async () => {
    assert.equal(await exposed.dub.invoke('games:list'), 'ok');
    await assert.rejects(() => exposed.dub.invoke('shell:exec', 'x'), /Unknown channel/);
    assert.equal(sent.length, 1);
    const got = [];
    const off = exposed.dub.on('line:received', (p) => got.push(p));
    listeners['line:received']({ sender: 'event object must not leak' }, { text: 'hi' });
    assert.deepEqual(got, [{ text: 'hi' }]);
    off();
    assert.equal(listeners['line:received'], undefined);
    exposed.dub.on('not:a:channel', () => {});
    assert.equal(listeners['not:a:channel'], undefined);
  })();
});

test('clipboard mode: new text becomes an "unknown" line; repeats, short strings and the starting clipboard are dropped', () => {
  let current = 'already on the clipboard';
  const lines = [];
  let tickFn = null;
  const w = createClipboardWatcher({ readText: () => current, onLine: (l) => lines.push(l),
    timers: { setInterval: (fn, ms) => { tickFn = fn; assert.equal(ms, 200); return 1; }, clearInterval: () => { tickFn = null; } } });
  w.start();
  tickFn();
  for (const text of ['First line.', 'First line.', 'a', '  Second\n line. ', '']) { current = text; tickFn(); }
  assert.deepEqual(lines, [
    { speaker: 'unknown', text: 'First line.', engine: 'clipboard', game: 'clipboard' },
    { speaker: 'unknown', text: 'Second line.', engine: 'clipboard', game: 'clipboard' }]);
  w.stop();
  assert.equal(w.running(), false);
});

test('customVoices: off by default, persists, only accepts a boolean', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const make = () => createSettings({ file, safeStorage: fakeSafeStorage(), env: {} });
  const s = make();
  assert.equal(s.customVoices(), false);
  assert.equal(s.setCustomVoices(true).customVoices, true);
  assert.equal(make().customVoices(), true);
  for (const bad of ['true', 1, undefined, null]) assert.throws(() => s.setCustomVoices(bad), /true or false/);
  assert.equal(make().customVoices(), true);
});

test('ipc voices:customize: refuses when off, without keys or pipeline fn; succeeds otherwise', async () => {
  const file = path.join(tmpDir(), 'settings.json');
  const settings = createSettings({ file, safeStorage: fakeSafeStorage(), env: {} });
  const calls = [];
  const pipeline = {};
  const h = createHandlers({ settings, catalog, games: {}, voices: { current: () => 'g:cur' }, pipeline });
  const arg = { speaker: 'Sylvie' };
  await assert.rejects(() => h['voices:customize'](arg), /off/);
  settings.setCustomVoices(true);
  await assert.rejects(() => h['voices:customize'](arg), /ElevenLabs key and a Grok key/);
  settings.setKeys({ elevenlabs: 'a', grok: 'b' });
  await assert.rejects(() => h['voices:customize'](arg), /not available/);
  pipeline.customizeVoice = async (a) => { calls.push(a); return { speaker: a.speaker, locked: true }; };
  assert.deepEqual(await h['voices:customize'](arg), { speaker: 'Sylvie', locked: true });
  assert.deepEqual(calls, [{ game: 'g:cur', speaker: 'Sylvie' }]);
  await h['voices:customize']({ game: 'g:x', speaker: 'Bo' });
  assert.equal(calls[1].game, 'g:x');
  await assert.rejects(() => h['voices:customize']({}), /Missing "speaker"/);
  assert.equal((await h['settings:setCustomVoices'](false)).customVoices, false);
  assert.throws(() => h['settings:setCustomVoices']('yes'), /true or false/);
});
