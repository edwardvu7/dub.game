'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeSteam, tmpDir, write } = require('./helpers');
const scan = require('../main/steam/scan');
const { detectEngine } = require('../main/steam/detect');
const install = require('../main/steam/install');
const { createState } = require('../main/steam/state');
const { launchGame, findExecutable } = require('../main/steam/launch');
const { createGames } = require('../main/steam');

test('scan: finds Ren\'Py games across every library', async () => {
  const t = fakeSteam();
  const games = await scan.scanLibrary({ steamPath: t.steam });
  assert.deepEqual(games.filter((g) => g.support === 'full').map((g) => g.appid).sort(), ['1001', '2001']);
  const g = games.find((x) => x.appid === '1001');
  assert.deepEqual(g, {
    appid: '1001', name: 'Sakura Demo VN', installDir: path.join(t.common1, 'SakuraDemo'),
    engine: 'renpy', support: 'full', enabled: false, hookInstalled: false,
    coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1001/header.jpg',
  });
});

test('scan: Godot, RPG Maker and Unity games are listed as "soon"; Godot is "beta" only when asked', async () => {
  const t = fakeSteam();
  const games = await scan.scanLibrary({ steamPath: t.steam });
  const by = Object.fromEntries(games.map((g) => [g.engine, g.support]));
  assert.equal(by.renpy, 'full');
  assert.equal(by.godot, 'soon');
  assert.equal(by.unity, 'soon');
  assert.equal(by['rpgmaker-mz'], 'soon');
  const beta = await scan.scanLibrary({ steamPath: t.steam, includeBeta: true });
  assert.equal(beta.find((g) => g.engine === 'godot').support, 'beta');
  assert.ok(!games.some((g) => g.engine === 'kirikiri'), 'engines not asked for stay hidden');
});

test('scan: no Steam found gives an empty list, not a crash', async () => {
  const empty = tmpDir();
  for (const platform of ['win32', 'darwin', 'linux']) {
    const games = await scan.scanLibrary({ platform, env: {}, home: empty, exec: async () => '' });
    assert.deepEqual(games, []);
  }
});

test('findSteamPath: Windows reads SteamPath from `reg query` output', async () => {
  const t = fakeSteam();
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return args[1].startsWith('HKCU')
      ? `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${t.steam}\r\n\r\n` : '';
  };
  const found = await scan.findSteamPath({ platform: 'win32', env: {}, home: t.root, exec });
  assert.equal(found, path.normalize(t.steam));
  assert.deepEqual(calls[0], ['reg', 'query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
});

test('findSteamPath: macOS and Linux default locations', async () => {
  const home = tmpDir();
  write(path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'x'));
  write(path.join(home, '.local', 'share', 'Steam', 'steamapps', 'x'));
  assert.equal(await scan.findSteamPath({ platform: 'darwin', env: {}, home }),
    path.join(home, 'Library', 'Application Support', 'Steam'));
  assert.equal(await scan.findSteamPath({ platform: 'linux', env: {}, home }),
    path.join(home, '.local', 'share', 'Steam'));
});

test('parseRegValue: handles spaces in the path', () => {
  assert.equal(scan.parseRegValue('    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', 'SteamPath'),
    'c:/program files (x86)/steam');
  assert.equal(scan.parseRegValue('ERROR: The system was unable to find the key', 'SteamPath'), null);
});

test('detect: engine table', () => {
  const t = fakeSteam();
  assert.equal(detectEngine(path.join(t.common1, 'SakuraDemo')).engine, 'renpy');
  assert.equal(detectEngine(path.join(t.common1, 'UnityThing')).support, 'soon');
  assert.equal(detectEngine(path.join(t.common2, 'RPGThing')).engine, 'rpgmaker-mz');
  assert.equal(detectEngine(path.join(t.common2, 'Ghost')), null);
  // renpy/ folder without any script files in game/ is not a Ren'Py game
  const d = tmpDir();
  write(path.join(d, 'renpy', 'x.py'));
  write(path.join(d, 'game', 'readme.txt'));
  assert.equal(detectEngine(d), null);
});

test('detect + install: macOS app bundle layout', () => {
  const d = tmpDir();
  const inner = path.join(d, 'Game.app', 'Contents', 'Resources', 'autorun');
  write(path.join(inner, 'renpy', 'x.py'));
  write(path.join(inner, 'game', 'script.rpy'));
  const game = scan.scanFolder(d);
  assert.equal(game.engine, 'renpy');
  install.installHook(game);
  assert.ok(fs.existsSync(path.join(inner, 'game', 'dubgame.rpy')));
});

test('install: round trip copies the shipped hook and removes it (and compiled leftovers)', () => {
  const t = fakeSteam();
  const game = { appid: '1001', engine: 'renpy', installDir: path.join(t.common1, 'SakuraDemo') };
  const target = path.join(game.installDir, 'game', 'dubgame.rpy');
  assert.equal(install.isHookInstalled(game), false);
  install.installHook(game);
  assert.equal(install.isHookInstalled(game), true);
  assert.deepEqual(fs.readFileSync(target),
    fs.readFileSync(path.join(__dirname, '..', 'mod', 'renpy', 'dubgame.rpy')));
  assert.equal(install.isHookOutdated(game), false);
  fs.writeFileSync(target, '# old version');
  assert.equal(install.isHookOutdated(game), true);
  write(path.join(game.installDir, 'game', 'dubgame.rpyc'), 'compiled');
  install.uninstallHook(game);
  assert.equal(install.isHookInstalled(game), false);
  assert.deepEqual(fs.readdirSync(path.join(game.installDir, 'game')), ['script.rpyc']);
  install.uninstallHook(game); // removing twice is fine
});

test('install: missing folder gives a clear error naming the folder', () => {
  const game = { appid: '9', engine: 'renpy', installDir: path.join(tmpDir(), 'nope') };
  assert.throws(() => install.installHook(game), (e) => e.code === 'ENOENT' && e.message.includes('nope'));
});

test('install: permission denied names the folder', { skip: process.platform === 'win32' || process.getuid() === 0 }, () => {
  const t = fakeSteam();
  const game = { appid: '1001', engine: 'renpy', installDir: path.join(t.common1, 'SakuraDemo') };
  fs.chmodSync(path.join(game.installDir, 'game'), 0o555);
  try {
    assert.throws(() => install.installHook(game),
      (e) => e.code === 'EACCES' && e.message.includes(path.join(game.installDir, 'game')));
  } finally { fs.chmodSync(path.join(game.installDir, 'game'), 0o755); }
});

test('install: Godot beta files, and a game\'s own override.cfg is never overwritten or deleted', () => {
  const t = fakeSteam();
  const game = { appid: '2002', engine: 'godot', installDir: path.join(t.common2, 'GodotStory') };
  install.installHook(game);
  assert.ok(fs.existsSync(path.join(game.installDir, 'dubgame.gd')));
  assert.ok(install.isHookInstalled(game));
  install.uninstallHook(game);
  assert.ok(!fs.existsSync(path.join(game.installDir, 'override.cfg')));
  write(path.join(game.installDir, 'override.cfg'), '[application]\nconfig/name="Theirs"\n');
  assert.throws(() => install.installHook(game), /will not overwrite/);
  install.uninstallHook(game);
  assert.ok(fs.existsSync(path.join(game.installDir, 'override.cfg')));
});

test('scanFolder: local id is stable and unsupported folders give null', () => {
  const t = fakeSteam();
  const dir = path.join(t.common1, 'SakuraDemo');
  const a = scan.scanFolder(dir);
  assert.match(a.appid, /^local:[0-9a-f]{10}$/);
  assert.equal(a.appid, scan.scanFolder(dir).appid);
  assert.equal(a.name, 'SakuraDemo');
  assert.equal(a.coverUrl, '');
  assert.equal(scan.scanFolder(path.join(t.common1, 'UnityThing')).support, 'soon');
  assert.equal(scan.scanFolder(path.join(t.common2, 'Ghost')), null);
  assert.equal(scan.scanFolder(path.join(t.root, 'missing')), null);
});

test('state: enabled list and folders persist', () => {
  const file = path.join(tmpDir(), 'sub', 'games.json');
  const s = createState({ file });
  s.setEnabled('1001', true);
  s.setEnabled('1001', true);
  s.setEnabled('7', true);
  s.setEnabled('7', false);
  s.addFolder('/x');
  const again = createState({ file });
  assert.equal(again.isEnabled('1001'), true);
  assert.equal(again.isEnabled('7'), false);
  assert.deepEqual(again.folders(), ['/x']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, ['1001']);
});

test('games facade: tick installs, recheck reports a removed hook, untick removes', async () => {
  const t = fakeSteam();
  const userData = tmpDir();
  const opened = [];
  const extra = tmpDir();
  write(path.join(extra, 'renpy', 'a.py'));
  write(path.join(extra, 'game', 'script.rpy'));
  let pick = extra;
  const make = () => createGames({ userData, steamPath: t.steam,
    shell: { openExternal: async (u) => { opened.push(u); } }, pickFolder: async () => pick });
  let games = make();
  const listed = await games.list();
  assert.equal(listed.filter((g) => g.support === 'full').length, 2);
  const soon = listed.find((g) => g.support === 'soon');
  await assert.rejects(() => games.setEnabled({ appid: soon.appid, enabled: true }), /aren't available yet/);
  assert.equal(listed.find((g) => g.appid === soon.appid).enabled, false);

  const on = await games.setEnabled({ appid: '1001', enabled: true });
  assert.deepEqual([on.enabled, on.hookInstalled], [true, true]);

  // a game update deletes the hook; a fresh launch must report it
  fs.unlinkSync(path.join(t.common1, 'SakuraDemo', 'game', 'dubgame.rpy'));
  games = make();
  let g = (await games.list()).find((x) => x.appid === '1001');
  assert.deepEqual([g.enabled, g.hookInstalled], [true, false]);
  g = await games.setEnabled({ appid: '1001', enabled: true }); // "Reinstall"
  assert.equal(g.hookInstalled, true);

  // an outdated hook on an enabled game is refreshed on list
  fs.writeFileSync(path.join(t.common1, 'SakuraDemo', 'game', 'dubgame.rpy'), '# old');
  await games.list();
  assert.notEqual(fs.readFileSync(path.join(t.common1, 'SakuraDemo', 'game', 'dubgame.rpy'), 'utf8'), '# old');

  const off = await games.setEnabled({ appid: '1001', enabled: false });
  assert.deepEqual([off.enabled, off.hookInstalled], [false, false]);

  const before = listed.length;
  const withLocal = await games.addFolder();
  assert.equal(withLocal.length, before + 1);
  assert.ok(withLocal.some((x) => x.appid.startsWith('local:')));
  assert.equal((await make().list()).length, before + 1, 'added folder persists');

  pick = tmpDir(); // a folder with no recognised engine
  await assert.rejects(() => games.addFolder(), /supported game/);
  pick = null; // cancelled picker
  assert.equal((await games.addFolder()).length, before + 1);

  assert.equal(await games.launch({ appid: '1001' }), true);
  assert.deepEqual(opened, ['steam://run/1001']);
  await assert.rejects(() => games.launch({ appid: 'nope' }), /Unknown game/);
});

test('launch: local games spawn their executable; odd appids are refused', async () => {
  const d = path.join(tmpDir(), 'My Game');
  write(path.join(d, 'My Game.exe'));
  write(path.join(d, 'My Game-32.exe'));
  write(path.join(d, 'unins000.exe'));
  write(path.join(d, 'My Game.sh'));
  assert.equal(findExecutable(d, 'win32'), path.join(d, 'My Game.exe'));
  const spawned = [];
  const spawn = (cmd, args, o) => { spawned.push([cmd, args, o.detached]); return { unref() {}, on() {} }; };
  await launchGame({ appid: 'local:abc', installDir: d }, { spawn, platform: 'win32', shell: {} });
  await launchGame({ appid: 'local:abc', installDir: d }, { spawn, platform: 'linux', shell: {} });
  assert.deepEqual(spawned[0], [path.join(d, 'My Game.exe'), [], true]);
  assert.deepEqual(spawned[1], ['sh', [path.join(d, 'My Game.sh')], true]);
  await assert.rejects(() => launchGame({ appid: '12; rm', installDir: d }, { shell: {} }), /Bad appid/);
});
