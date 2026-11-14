'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

// Pick the thing to run for a non-Steam game folder.
// UNVERIFIED: heuristics; checked only against fake folders in tests.
function findExecutable(dir, platform = process.platform) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '');
  const rank = (name) => {
    const n = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');
    return (n === base ? 0 : base.includes(n) || n.includes(base) ? 1 : 2) + (/32$/.test(n) ? 0.5 : 0);
  };
  let picks = [];
  if (platform === 'win32') {
    picks = entries.filter((e) => e.isFile() && /\.exe$/i.test(e.name) &&
      !/^(unins|uninstall|crashpad|unitycrash|python|pythonw|zsync)/i.test(e.name));
  } else if (platform === 'darwin') {
    picks = entries.filter((e) => e.isDirectory() && /\.app$/i.test(e.name));
    if (/\.app$/i.test(dir)) return dir;
  } else {
    picks = entries.filter((e) => e.isFile() && /\.(sh|x86_64|x86|arm64)$/i.test(e.name));
  }
  picks.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return picks.length ? path.join(dir, picks[0].name) : null;
}

/**
 * launchGame(game, {shell, spawn?, platform?}) -> Promise<true>
 * Steam games start through Steam (steam://run/<appid>); local games spawn their executable.
 */
async function launchGame(game, deps = {}) {
  const platform = deps.platform || process.platform;
  if (!String(game.appid).startsWith('local:')) {
    if (!/^\d+$/.test(String(game.appid))) throw new Error('Bad appid: ' + game.appid);
    await deps.shell.openExternal('steam://run/' + game.appid);
    if (deps.onLaunch) deps.onLaunch(game, 0);
    return true;
  }
  const project = game.engine === 'godot' && fs.existsSync(path.join(game.installDir, 'project.godot'));
  const exe = project ? deps.godotExecutable : findExecutable(game.installDir, platform);
  if (!exe) throw new Error(`Could not find the game's executable in:\n${game.installDir}`);
  const spawn = deps.spawn || childProcess.spawn;
  const [cmd, args] = project ? [exe, ['--path', game.installDir]]
    : platform === 'darwin' ? ['open', [exe]]
    : platform !== 'win32' && /\.sh$/i.test(exe) ? ['sh', [exe]] : [exe, []];
  const child = spawn(cmd, args, { cwd: game.installDir, detached: true, stdio: 'ignore' });
  // Real processes must confirm spawn; report missing/invalid executables to the UI.
  if (child && child.once) {
    await new Promise((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`Could not launch ${exe}: ${error.message}`)));
      child.once('spawn', resolve);
    });
  }
  if (deps.onLaunch) deps.onLaunch(game, project && child && child.pid || 0);
  if (child && child.unref) child.unref();
  return true;
}

module.exports = { launchGame, findExecutable };
