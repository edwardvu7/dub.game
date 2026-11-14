'use strict';
// Engine detection from files on disk. Compatibility is decided by engine, never by store tags.
const fs = require('node:fs');
const path = require('node:path');

function ls(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

const RENPY_FILE = /\.(rpy|rpyc|rpa)$/i;

function isRenpyRoot(root) {
  if (!isDir(path.join(root, 'renpy'))) return false;
  return ls(path.join(root, 'game')).some((e) => e.isFile() && RENPY_FILE.test(e.name));
}

// Where a Ren'Py game keeps renpy/ and game/: the install folder itself, or inside a macOS
// app bundle at <Game>.app/Contents/Resources/autorun.
function findRenpyRoot(installDir) {
  if (isRenpyRoot(installDir)) return installDir;
  for (const e of ls(installDir)) {
    if (e.isDirectory() && e.name.toLowerCase().endsWith('.app')) {
      const inner = path.join(installDir, e.name, 'Contents', 'Resources', 'autorun');
      if (isRenpyRoot(inner)) return inner;
    }
  }
  return null;
}

/**
 * detectEngine(installDir) -> { engine, support, hookDir } | null
 * support: "full" (Ren'Py), "beta" (adapter exists, untested), "hidden" (recognised, no adapter).
 * hookDir: the folder the hook files are copied into.
 */
function detectEngine(installDir) {
  if (!installDir || !isDir(installDir)) return null;

  const renpyRoot = findRenpyRoot(installDir);
  if (renpyRoot) return { engine: 'renpy', support: 'full', hookDir: path.join(renpyRoot, 'game') };

  const entries = ls(installDir);
  const names = entries.map((e) => e.name);

  // UNVERIFIED: the signatures below come from general knowledge, not a real Steam install.
  if (names.some((n) => /\.pck$/i.test(n))) {
    // Games that embed the pack inside the exe are not detected.
    return { engine: 'godot', support: 'beta', hookDir: installDir };
  }
  if (isFile(path.join(installDir, 'www', 'js', 'rpg_core.js')) ||
      isFile(path.join(installDir, 'js', 'rpg_core.js'))) {
    return { engine: 'rpgmaker-mv', support: 'hidden', hookDir: null };
  }
  if (isFile(path.join(installDir, 'js', 'rmmz_core.js'))) {
    return { engine: 'rpgmaker-mz', support: 'hidden', hookDir: null };
  }
  if (names.includes('UnityPlayer.dll') ||
      entries.some((e) => e.isDirectory() && /_Data$/.test(e.name) &&
        names.some((n) => n.toLowerCase() === e.name.slice(0, -5).toLowerCase() + '.exe'))) {
    return { engine: 'unity', support: 'hidden', hookDir: null };
  }
  if (names.some((n) => /\.xp3$/i.test(n))) {
    return { engine: 'kirikiri', support: 'hidden', hookDir: null };
  }
  return null;
}

module.exports = { detectEngine, findRenpyRoot };
