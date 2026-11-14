'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { tmpDir, write } = require('./helpers');
const { createGames, scanFolder, launchGame } = require('../main/steam');
const L = require('../ui/lib');

function project() {
  const dir = tmpDir('godot project ');
  write(path.join(dir, 'project.godot'), 'config_version=5');
  return dir;
}
function fakeSpawn(calls, error) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit(error ? 'error' : 'spawn', error));
    return child;
  };
}

test('Godot source project is detected without a pck', () => {
  const game = scanFolder(project());
  assert.equal(game.engine, 'godot');
  assert.equal(game.support, 'launch');
});

test('no demo is injected; added project picks Godot once and never writes a hook', async () => {
  const dir = project();
  const userData = tmpDir();
  const exe = path.join(tmpDir(), 'Godot 4.exe');
  write(exe);
  const calls = [];
  let picks = 0;
  const opts = { userData, steamPath: tmpDir(), platform: 'win32',
    pickFolder: async () => dir, pickGodot: async () => { picks++; return exe; }, spawn: fakeSpawn(calls) };
  const games = createGames(opts);
  assert.deepEqual(await games.list(), []);
  const [game] = await games.addFolder();
  assert.equal(game.voiceMode, 'generic');
  assert.equal(L.gameStatus(game), 'off');
  assert.equal((await games.addFolder()).length, 1);
  await games.launch({ appid: game.appid });
  await createGames(opts).launch({ appid: game.appid });
  assert.equal(picks, 1, 'Godot path persists across app restarts');
  assert.deepEqual(calls[0], { cmd: exe, args: ['--path', dir] });
  // Launch alone never opts the user into injection.

  assert.equal(fs.existsSync(path.join(dir, 'override.cfg')), false);
});

test('user-added Godot project is launchable without claiming automatic voices', async () => {
  const games = createGames({ userData: tmpDir(), steamPath: tmpDir(), pickFolder: async () => project() });
  const [game] = await games.addFolder();
  assert.equal(game.voiceMode, 'generic');
  assert.equal(game.enabled, false);
  assert.equal(L.gameStatus(game), 'off');
  assert.match(L.gameHint(game).text, /Enable before launching/);
  await assert.rejects(games.launch({ appid: game.appid }), /Select the Godot 4 executable/);
});

test('exported Godot game launches its exe without requiring Godot editor', async () => {
  const dir = tmpDir();
  write(path.join(dir, 'Story.exe'));
  write(path.join(dir, 'Story.pck'));
  const calls = [];
  await launchGame(scanFolder(dir), { platform: 'win32', spawn: fakeSpawn(calls) });
  assert.deepEqual(calls, [{ cmd: path.join(dir, 'Story.exe'), args: [] }]);
});

test('failed process spawn reaches the UI instead of reporting success', async () => {
  const game = scanFolder(project());
  await assert.rejects(launchGame(game, { godotExecutable: '/missing/godot',
    spawn: fakeSpawn([], new Error('ENOENT')) }), /Could not launch.*ENOENT/);
});

test('Linux Godot binary is executed directly, not passed to sh', async () => {
  const dir = tmpDir();
  write(path.join(dir, 'Story.x86_64'));
  write(path.join(dir, 'Story.pck'));
  const calls = [];
  await launchGame(scanFolder(dir), { platform: 'linux', spawn: fakeSpawn(calls) });
  assert.deepEqual(calls, [{ cmd: path.join(dir, 'Story.x86_64'), args: [] }]);
});

test('source launch passes the spawned PID to game-window tracking', async () => {
  const game = scanFolder(project());
  const calls = [];
  let tracked;
  await launchGame(game, { godotExecutable: '/godot', spawn: (cmd, args) => {
    const child = fakeSpawn(calls)(cmd, args); child.pid = 321; return child;
  }, onLaunch: (g, pid) => { tracked = { game: g, pid }; } });
  assert.equal(tracked.game.appid, game.appid);
  assert.equal(tracked.pid, 321);
});

test('Steam launch tracks the install directory without guessing a process id', async () => {
  const game = { appid: '123', installDir: '/games/story' };
  let tracked;
  await launchGame(game, { shell: { openExternal: async () => {} }, onLaunch: (g, pid) => { tracked = [g, pid]; } });
  assert.deepEqual(tracked, [game, 0]);
});
