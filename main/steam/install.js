'use strict';
// Copies the hook into a game (the "injection") and removes it again. Nothing else is touched.
const fs = require('node:fs');
const path = require('node:path');
const godot = require('./godot-hook');
const { detectEngine } = require('./detect');

const DEFAULT_MOD_DIR = path.join(__dirname, '..', '..', 'mod');

// Files per engine: [source inside mod/, file name in the game].
const HOOK_FILES = {
  renpy: [['renpy/dubgame.rpy', 'dubgame.rpy']],
};
// Compiled leftovers Ren'Py writes next to the hook.
const EXTRA_REMOVE = { renpy: ['dubgame.rpyc', 'dubgame.rpyb'] };

function hookDirFor(game) {
  const detected = detectEngine(game.installDir);
  if (detected && detected.engine === game.engine && detected.hookDir) return detected.hookDir;
  if (game.engine === 'renpy') return path.join(game.installDir, 'game');
  return game.installDir;
}

function friendly(err, dir, action) {
  if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
    const e = new Error(`Permission denied while ${action} the dub.game hook in:\n${dir}\n` +
      'Run dub.game as administrator, or copy the file by hand.');
    e.code = err.code;
    e.folder = dir;
    return e;
  }
  if (err && err.code === 'ENOENT') {
    const e = new Error(`Game folder not found:\n${dir}`);
    e.code = 'ENOENT';
    e.folder = dir;
    return e;
  }
  return err;
}

function isHookInstalled(game) {
  if (game.engine === 'godot') return godot.isInstalled(game);
  const files = HOOK_FILES[game.engine];
  if (!files) return false;
  const dir = hookDirFor(game);
  return files.every(([, name]) => fs.existsSync(path.join(dir, name)));
}

/** True when the installed hook differs from the one shipped with this build. */
function isHookOutdated(game, opts = {}) {
  if (game.engine === 'godot') return godot.isOutdated(game, opts);
  const files = HOOK_FILES[game.engine];
  if (!files) return false;
  const modDir = opts.modDir || DEFAULT_MOD_DIR;
  const dir = hookDirFor(game);
  try {
    return files.some(([src, name]) =>
      !fs.readFileSync(path.join(modDir, src)).equals(fs.readFileSync(path.join(dir, name))));
  } catch { return false; }
}

function installHook(game, opts = {}) {
  if (game.engine === 'godot') return godot.install(game, opts);
  const files = HOOK_FILES[game.engine];
  if (!files) throw new Error(`No dub.game hook for engine "${game.engine}".`);
  const modDir = opts.modDir || DEFAULT_MOD_DIR;
  const dir = hookDirFor(game);
  try {
    for (const [src, name] of files) {
      // read + write (not copyFile) so it also works from inside a packaged app.asar
      fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(modDir, src)));
    }
  } catch (err) {
    throw friendly(err, dir, 'installing');
  }
  return true;
}

function uninstallHook(game) {
  if (game.engine === 'godot') return godot.uninstall(game);
  const files = HOOK_FILES[game.engine];
  if (!files) return true;
  const dir = hookDirFor(game);
  try {
    for (const [, name] of files) {
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) continue;
      fs.unlinkSync(target);
    }
    for (const name of EXTRA_REMOVE[game.engine] || []) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* not there */ }
    }
  } catch (err) {
    throw friendly(err, dir, 'removing');
  }
  return true;
}

module.exports = { installHook, uninstallHook, isHookInstalled, isHookOutdated, hookDirFor,
  DEFAULT_MOD_DIR };
