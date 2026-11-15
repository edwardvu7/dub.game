'use strict';
// Own only our sidecar files and a precisely recorded override.cfg revision.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCRIPT = '_dubgame_generic.gd';
const CONFIG = '_dubgame_generic.json';
const RECORD = '_dubgame_generic.install.json';
// Written by the running hook (generic.gd _inspect). Not part of the "owned files match" checks.
const INSPECT = '_dubgame_generic.inspect.json';
const MARKER = '; DUBGAME_GENERIC_V1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const target = (game, name) => path.join(game.installDir, name);
const read = p => { try { return fs.readFileSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function safeFile(p) {
  try { if (!fs.lstatSync(p).isFile()) throw new Error(`Refusing to modify non-regular file: ${p}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function record(game) {
  try { const r = JSON.parse(fs.readFileSync(target(game, RECORD), 'utf8')); return r.format === 1 ? r : null; }
  catch { return null; }
}
function config(game) {
  try { return JSON.parse(fs.readFileSync(target(game, CONFIG), 'utf8')); } catch { return null; }
}
/**
 * Godot major version of a resource pack: a .pck file, or an executable with the pack embedded
 * (Godot ends such a file with the pack's size and the letters GDPC). null when it is neither.
 * UNVERIFIED: the embedded layout comes from Godot's source, not from a real embedded game.
 */
function packMajor(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const at = (pos) => { const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, pos) === 16 ? b : null; };
    let head = at(0);
    if (!head || head.toString('ascii', 0, 4) !== 'GDPC') {
      const size = fs.fstatSync(fd).size;
      const tail = size >= 28 ? at(size - 16) : null;
      if (!tail || tail.toString('ascii', 12, 16) !== 'GDPC') return null;
      const start = size - 12 - Number(tail.readBigUInt64LE(4));
      head = start >= 0 ? at(start) : null;
      if (!head || head.toString('ascii', 0, 4) !== 'GDPC') return null;
    }
    return head.readUInt32LE(8);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function verifyVersion(game) {
  const project = read(target(game, 'project.godot'));
  if (project) {
    if (!/^config_version\s*=\s*5\s*$/m.test(project.toString())) throw new Error('Generic hook requires Godot 4. Godot 3 projects are not supported.');
    if (/^DubGame\s*=/m.test(project.toString())) throw new Error('This project already has a DubGame autoload. Use its source integration instead of installing a second hook.');
    return;
  }
  const versions = fs.readdirSync(game.installDir).filter(n => /\.(pck|exe|x86_64)$/i.test(n))
    .map(n => packMajor(target(game, n)));
  if (!versions.includes(4) || versions.some(v => v !== null && v !== 4)) {
    throw new Error('Could not verify a Godot 4 resource pack. Godot 3 games are not supported by this hook.');
  }
}
function isInstalled(game) {
  const r = record(game);
  if (!r) return false;
  const override = read(target(game, 'override.cfg'));
  return !!override && hash(override) === r.overrideHash &&
    !!read(target(game, SCRIPT)) && hash(read(target(game, SCRIPT))) === r.scriptHash && !!config(game);
}
function isOutdated(game, opts = {}) {
  const r = record(game);
  if (!r || !isInstalled(game)) return false;
  return hash(fs.readFileSync(path.join(opts.modDir || path.join(__dirname, '../../mod'), 'godot/generic.gd'))) !== r.scriptHash;
}
function install(game, opts = {}) {
  verifyVersion(game);
  const names = [SCRIPT, CONFIG, 'override.cfg', RECORD];
  names.forEach(n => safeFile(target(game, n)));
  const previous = Object.fromEntries(names.map(n => [n, read(target(game, n))]));
  const r = record(game);
  if (!r && [SCRIPT, CONFIG, RECORD].some(n => previous[n])) throw new Error('Unrecognized dubplay sidecar files exist. Restore or move them before enabling the generic hook.');
  if (r && (!previous['override.cfg'] || hash(previous['override.cfg']) !== r.overrideHash)) {
    throw new Error('override.cfg changed since hook installation. Refusing to overwrite your changes. Restore the recorded version or remove the hook block manually.');
  }
  const original = r ? (r.originalOverride === null ? null : Buffer.from(r.originalOverride, 'base64')) : previous['override.cfg'];
  const text = original ? original.toString('utf8') : '';
  if (original && !Buffer.from(text, 'utf8').equals(original)) throw new Error('override.cfg is not UTF-8. No files were changed.');
  if (/DubGameGenericHook|DUBGAME_GENERIC_V1|DUBGAME_MARKER/.test(text)) throw new Error('A generic hook entry already exists in override.cfg. Resolve it before installing.');
  const source = fs.readFileSync(path.join(opts.modDir || path.join(__dirname, '../../mod'), 'godot/generic.gd'));
  const quotePath = n => JSON.stringify(path.resolve(target(game, n)).replace(/\\/g, '/'));
  const override = Buffer.from(text + '\n' + MARKER + '\n[autoload]\nDubGameGenericHook=' +
    JSON.stringify('*' + path.resolve(target(game, SCRIPT)).replace(/\\/g, '/')) +
    '\n[dubgame_generic]\nconfig_path=' + quotePath(CONFIG) + '\n');
  const settings = config(game) || { appid: String(game.appid), game: 'godot:' + path.basename(game.installDir),
    token: crypto.randomBytes(24).toString('hex'), textPath: '', speakerPath: '', settleMs: 650 };
  const next = { [SCRIPT]: source, [CONFIG]: Buffer.from(JSON.stringify(settings, null, 2)),
    'override.cfg': override, [RECORD]: Buffer.from(JSON.stringify({ format: 1,
      originalOverride: original === null ? null : original.toString('base64'),
      overrideHash: hash(override), scriptHash: hash(source) }, null, 2)) };
  const written = [];
  try {
    for (const n of names) { written.push(n); fs.writeFileSync(target(game, n), next[n]); }
  } catch (error) {
    for (const n of written.reverse()) {
      try { if (previous[n] === null) fs.unlinkSync(target(game, n)); else fs.writeFileSync(target(game, n), previous[n]); } catch { /* preserve original error */ }
    }
    throw error;
  }
  return true;
}
function uninstall(game) {
  const r = record(game);
  if (!r) return true;
  [SCRIPT, CONFIG, RECORD, INSPECT, 'override.cfg'].forEach(n => safeFile(target(game, n)));
  const current = read(target(game, 'override.cfg'));
  if (!current || hash(current) !== r.overrideHash) throw new Error('override.cfg changed after installation. Refusing to discard those changes; restore or manually remove the hook entry first.');
  if (r.originalOverride === null) fs.unlinkSync(target(game, 'override.cfg'));
  else fs.writeFileSync(target(game, 'override.cfg'), Buffer.from(r.originalOverride, 'base64'));
  for (const n of [SCRIPT, CONFIG, RECORD, INSPECT]) if (fs.existsSync(target(game, n))) fs.unlinkSync(target(game, n));
  return true;
}
function configure(game, patch) {
  const c = config(game);
  if (!record(game) || !c) throw new Error('Enable the Godot hook first.');
  for (const key of ['textPath', 'speakerPath']) {
    if (typeof patch[key] !== 'string' || patch[key].length > 1024 || (patch[key] && !patch[key].startsWith('/root/'))) throw new Error('Choose a visible game node, or leave automatic selection enabled.');
    c[key] = patch[key];
  }
  safeFile(target(game, CONFIG));
  const temporary = target(game, CONFIG + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(c, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, target(game, CONFIG));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { textPath: c.textPath, speakerPath: c.speakerPath };
}
module.exports = { install, uninstall, isInstalled, isOutdated, config, configure, verifyVersion, packMajor,
  SCRIPT, CONFIG, RECORD, INSPECT, MARKER };
