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
  'rpgmaker-mv': [['rpgmaker/dubgame.js', 'js/dubgame.js']],
};
// RPG Maker MV loads only the scripts index.html names, so the hook also needs one tag there.
// Removing this exact text restores the file byte for byte, so no backup copy can go stale.
const HTML_TAG = { 'rpgmaker-mv': '<script type="text/javascript" src="js/dubgame.js"></script>' };
// latin1 keeps every byte of the game's file as it is.
const readHtml = (dir) => fs.readFileSync(path.join(dir, 'index.html'), 'latin1');
const writeHtml = (dir, html) => fs.writeFileSync(path.join(dir, 'index.html'), html, 'latin1');
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
  if (!files.every(([, name]) => fs.existsSync(path.join(dir, name)))) return false;
  const tag = HTML_TAG[game.engine];
  // A Steam update or "Verify integrity" restores index.html without the tag: not installed.
  try { return !tag || readHtml(dir).includes(tag); } catch { return false; }
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
    const tag = HTML_TAG[game.engine];
    const html = tag ? readHtml(dir) : '';
    const at = html.toLowerCase().lastIndexOf('</body>');
    if (tag && at < 0) throw new Error(`Could not find </body> in:
${path.join(dir, 'index.html')}`);
    for (const [src, name] of files) {
      // read + write (not copyFile) so it also works from inside a packaged app.asar
      fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(modDir, src)));
    }
    if (tag && !html.includes(tag)) writeHtml(dir, html.slice(0, at) + tag + html.slice(at));
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
    const tag = HTML_TAG[game.engine];
    if (tag) {
      let html = '';
      try { html = readHtml(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (html.includes(tag)) writeHtml(dir, html.split(tag).join(''));
    }
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
