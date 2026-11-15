'use strict';
// Steam library scan. Reads Steam's local files only: no login, no API key.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const vdf = require('./vdf');
const { detectEngine } = require('./detect');

const COVER = (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function defaultExec(file, args) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

// `reg query` prints lines like:  "    SteamPath    REG_SZ    c:/program files (x86)/steam"
function parseRegValue(output, valueName) {
  const re = new RegExp('^\\s*' + valueName + '\\s+REG_\\w+\\s+(.+?)\\s*$', 'im');
  const m = re.exec(output || '');
  return m ? m[1] : null;
}

/**
 * findSteamPath({platform, env, home, exec}) -> Promise<string|null>
 * UNVERIFIED: registry keys and default paths are from general knowledge; check on the demo PC.
 */
async function findSteamPath(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const exec = opts.exec || defaultExec;
  const candidates = [];

  if (env.DUBGAME_STEAM_PATH) candidates.push(env.DUBGAME_STEAM_PATH);

  if (platform === 'win32') {
    const queries = [
      ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
      ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
      ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
    ];
    for (const [key, value] of queries) {
      let out = '';
      try { out = await exec('reg', ['query', key, '/v', value]); } catch { out = ''; }
      const found = parseRegValue(out, value);
      if (found) candidates.push(found);
    }
    candidates.push(
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Steam'));
  } else if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Steam'));
  } else {
    candidates.push(
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
      path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'));
  }
  for (const c of candidates) {
    if (c && exists(path.join(c, 'steamapps'))) return path.normalize(c);
  }
  return null;
}

// Every library folder listed in steamapps/libraryfolders.vdf, plus the Steam folder itself.
function listLibraries(steamPath) {
  const libs = [steamPath];
  let parsed = null;
  for (const name of ['libraryfolders.vdf', 'LibraryFolders.vdf']) {
    try {
      parsed = vdf.parse(fs.readFileSync(path.join(steamPath, 'steamapps', name), 'utf8'));
      break;
    } catch { /* try the next spelling */ }
  }
  if (parsed) {
    const root = parsed.libraryfolders || parsed.LibraryFolders || {};
    for (const [key, value] of Object.entries(root)) {
      if (!/^\d+$/.test(key)) continue;
      // New format: "0" { "path" "..." }. Old format: "1" "D:\\SteamLibrary".
      const p = typeof value === 'string' ? value : value && value.path;
      if (p) libs.push(p);
    }
  }
  const seen = new Set();
  return libs.map((p) => path.normalize(p)).filter((p) => {
    const k = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(k) || !exists(path.join(p, 'steamapps'))) return false;
    seen.add(k);
    return true;
  });
}

function readManifests(library) {
  const dir = path.join(library, 'steamapps');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
    try {
      const state = vdf.parse(fs.readFileSync(path.join(dir, f), 'utf8')).AppState || {};
      const appid = String(state.appid || state.appID || f.match(/\d+/)[0]);
      if (!state.installdir) continue;
      out.push({ appid, name: state.name || state.installdir,
        installDir: path.join(dir, 'common', state.installdir) });
    } catch { /* unreadable manifest: skip that game, keep scanning */ }
  }
  return out;
}

// Ren'Py and RPG Maker MV work. Godot, RPG Maker MZ and Unity are listed as "soon" so players see them, but voices
// can't be switched on yet. Godot's untested adapter is offered as "beta" only when asked for.
function listing(detected, includeBeta) {
  if (!detected) return null;
  if (detected.support === 'launch') return 'launch';
  if (detected.support === 'full') return 'full';
  if (detected.support === 'beta') return includeBeta ? 'beta' : 'soon';
  if (detected.support === 'soon') return 'soon';
  return null;
}

/**
 * scanLibrary({steamPath?, includeBeta?, platform?, env?, home?, exec?}) -> Promise<Game[]>
 * Returns Ren'Py games and RPG Maker MV games, plus Godot/RPG Maker MZ/Unity games marked "soon" (contract shape minus enabled/hookInstalled, which state.js adds).
 * includeBeta lists engines whose adapter exists but is untested (Godot). Off by default.
 */
async function scanLibrary(opts = {}) {
  const steamPath = opts.steamPath || await findSteamPath(opts);
  if (!steamPath) return [];
  const games = new Map();
  for (const lib of listLibraries(steamPath)) {
    for (const m of readManifests(lib)) {
      if (games.has(m.appid)) continue;
      const detected = detectEngine(m.installDir);
      const support = listing(detected, opts.includeBeta);
      if (!support) continue;
      games.set(m.appid, {
        appid: m.appid, name: m.name, installDir: m.installDir,
        engine: detected.engine, support,
        enabled: false, hookInstalled: false, coverUrl: COVER(m.appid),
      });
    }
  }
  return [...games.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function localId(dir) {
  return 'local:' + crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10);
}

/** scanFolder(dir, {includeBeta?}) -> Game|null for non-Steam games (itch.io, DRM-free). */
function scanFolder(dir, opts = {}) {
  if (!dir) return null;
  const detected = detectEngine(dir);
  // A folder the player picked by hand may show beta engines: they asked for this game.
  const support = listing(detected, opts.includeBeta !== false);
  if (!support) return null;
  let name = path.basename(path.resolve(dir));
  if (/\.app$/i.test(name)) name = name.slice(0, -4);
  return {
    appid: localId(dir), name, installDir: path.resolve(dir),
    engine: detected.engine, support,
    enabled: false, hookInstalled: false, coverUrl: '',
  };
}

module.exports = { scanLibrary, scanFolder, findSteamPath, listLibraries, readManifests,
  parseRegValue, localId };
