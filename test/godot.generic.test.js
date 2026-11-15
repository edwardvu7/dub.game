'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, write } = require('./helpers');
const hook = require('../main/steam/godot-hook');
const { createGames } = require('../main/steam');
function game() {
  const installDir = tmpDir('generic ü ');
  write(path.join(installDir, 'project.godot'), 'config_version=5\n');
  return { appid: 'test', engine: 'godot', installDir };
}

test('installer restores original bytes, preserves configuration across repair, never edits project', () => {
  const g = game(), original = Buffer.from('; mine\r\n[application]\r\nconfig/name="Original"\r\n');
  const cfg = path.join(g.installDir, 'override.cfg');
  fs.writeFileSync(cfg, original);
  hook.install(g);
  assert.ok(hook.isInstalled(g));
  assert.equal(hook.isOutdated(g), false);
  hook.configure(g, { textPath: '/root/Story/Line', speakerPath: '' });
  const token = hook.config(g).token;
  hook.install(g);
  assert.equal(hook.config(g).token, token);
  assert.equal(hook.config(g).textPath, '/root/Story/Line');
  assert.match(fs.readFileSync(cfg, 'utf8'), /DubGameGenericHook="\*/);
  hook.uninstall(g);
  assert.ok(fs.readFileSync(cfg).equals(original));
  assert.equal(fs.readFileSync(path.join(g.installDir, 'project.godot'), 'utf8'), 'config_version=5\n');
  assert.ok(!fs.existsSync(path.join(g.installDir, hook.SCRIPT)));
});

test('installer refuses unknown sidecars, source integration, legacy hook, changed override and Godot 3', () => {
  let g = game(); write(path.join(g.installDir, hook.SCRIPT), 'mine');
  assert.throws(() => hook.install(g), /Unrecognized/);
  g = game(); write(path.join(g.installDir, 'project.godot'), 'config_version=5\n[autoload]\nDubGame="*res://bridge.gd"');
  assert.throws(() => hook.install(g), /already has/);
  g = game(); write(path.join(g.installDir, 'override.cfg'), '; DUBGAME_MARKER');
  assert.throws(() => hook.install(g), /already exists/);
  g = game(); hook.install(g);
  fs.appendFileSync(path.join(g.installDir, 'override.cfg'), '\n; user change');
  assert.equal(hook.isInstalled(g), false);
  assert.throws(() => hook.install(g), /changed/);
  assert.throws(() => hook.uninstall(g), /changed/);
  assert.match(fs.readFileSync(path.join(g.installDir, 'override.cfg'), 'utf8'), /user change/);
  g = game(); write(path.join(g.installDir, 'project.godot'), 'config_version=4');
  assert.throws(() => hook.install(g), /Godot 4/);
});

test('inspection report never blocks install or repair, and uninstall deletes it', () => {
  const g = game(), report = path.join(g.installDir, hook.INSPECT);
  write(report, '{}'); // left over from an earlier install
  hook.install(g);
  assert.ok(hook.isInstalled(g));
  assert.equal(hook.isOutdated(g), false);
  hook.install(g);
  assert.ok(fs.existsSync(report));
  hook.uninstall(g);
  assert.ok(!fs.existsSync(report));
});

test('pack header gate rejects Godot 3 and unknown packs', () => {
  const g = game(); fs.unlinkSync(path.join(g.installDir, 'project.godot'));
  const header = Buffer.alloc(16); header.write('GDPC'); header.writeUInt32LE(3, 8);
  fs.writeFileSync(path.join(g.installDir, 'Story.pck'), header);
  assert.throws(() => hook.install(g), /Godot 4/);
  header.writeUInt32LE(4, 8); fs.writeFileSync(path.join(g.installDir, 'Story.pck'), header);
  hook.install(g); assert.ok(hook.isInstalled(g)); hook.uninstall(g);
});

test('symlink destinations cannot redirect installer writes', { skip: process.platform === 'win32' }, () => {
  const g = game(), outside = path.join(tmpDir(), 'outside'); write(outside, 'untouched');
  fs.symlinkSync(outside, path.join(g.installDir, 'override.cfg'));
  assert.throws(() => hook.install(g), /non-regular/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('launcher distinguishes installation, authenticated connection, and text detection', async () => {
  const g = game();
  const games = createGames({ userData: tmpDir(), steamPath: tmpDir(), pickFolder: async () => g.installDir });
  const [found] = await games.addFolder();
  const enabled = await games.setEnabled({ appid: found.appid, enabled: true });
  assert.equal(enabled.hookInstalled, true);
  assert.equal(enabled.hookStatus, 'disconnected');
  const report = { appid: found.appid, token: 'wrong', labels: [], selectedPath: '' };
  assert.equal(games.reportGodotHook(report), false);
  report.token = hook.config(g).token;
  assert.equal(games.reportGodotHook(report), true);
  assert.equal((await games.list())[0].hookStatus, 'no-dialogue');
  report.selectedPath = '/root/CutsceneNarration';
  games.reportGodotHook(report);
  assert.equal((await games.list())[0].hookStatus, 'connected');
  assert.ok(!JSON.stringify(await games.list()).includes(report.token));
  await games.configureGodot({ appid: found.appid, textPath: '/root/Line', speakerPath: '' });
  await assert.rejects(games.configureGodot({ appid: found.appid, textPath: '../bad', speakerPath: '' }));
  await games.setEnabled({ appid: found.appid, enabled: false });
  assert.equal(games.reportGodotHook(report), false);
});

test('failed installation rolls back a partial file write and all prior writes', () => {
  const g = game(), cfg = path.join(g.installDir, 'override.cfg');
  write(cfg, '; original');
  const realWrite = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).endsWith(hook.CONFIG) && !failed) {
      failed = true; realWrite(file, 'partial'); throw new Error('disk full');
    }
    return realWrite(file, ...args);
  };
  try { assert.throws(() => hook.install(g), /disk full/); }
  finally { fs.writeFileSync = realWrite; }
  assert.equal(fs.readFileSync(cfg, 'utf8'), '; original');
  for (const n of [hook.SCRIPT, hook.CONFIG, hook.RECORD]) assert.ok(!fs.existsSync(path.join(g.installDir, n)));
});
