'use strict';
// Facade used by main/ipc.js for the games:* channels.
const path = require('node:path');
const fs = require('node:fs');
const scan = require('./scan');
const install = require('./install');
const godot = require('./godot-hook');
const { createState } = require('./state');
const { launchGame } = require('./launch');

/**
 * createGames({userData, modDir?, shell, pickFolder?, steamPath?, includeBeta?, scanOptions?,
 *   tagCheck?, onChange?})
 * pickFolder: async () => string|null (the main process passes a dialog wrapper).
 * tagCheck: from ./tags. When given, Steam games on engines other than Ren'Py are listed only if
 *   their Steam tags say they are story-driven. onChange(list) fires when a background tag
 *   lookup changes what is listed.
 */
function createGames(opts) {
  const state = createState({ file: path.join(opts.userData, 'games.json') });
  const includeBeta = !!opts.includeBeta;
  const reports = new Map();
  const launches = new Map();
  let cache = null;   // every detected game, before the story filter
  let generation = 0; // a newer rescan makes an older background lookup's result stale

  // Ren'Py is a visual-novel engine, so its games are always listed. Godot, RPG Maker and Unity
  // also make shooters and platformers, so their Steam games need a story tag. A folder the player
  // added by hand is always listed: they chose it.
  function listed(game) {
    if (!opts.tagCheck || game.engine === 'renpy' || String(game.appid).startsWith('local:')) return true;
    return opts.tagCheck.known(game.appid) === 'story';
  }
  const visible = () => cache.filter(listed).map(decorate);

  function checkTagsInBackground() {
    if (!opts.tagCheck) return;
    const mine = generation;
    const pending = cache.filter((g) => g.engine !== 'renpy' && !String(g.appid).startsWith('local:') &&
      opts.tagCheck.known(g.appid) === undefined).map((g) => g.appid);
    if (!pending.length) return;
    opts.tagCheck.lookup(pending).then((kinds) => {
      if (mine !== generation) return;
      if ([...kinds.values()].includes('story') && opts.onChange) opts.onChange(visible());
    }).catch(() => {});
  }

  function decorate(game) {
    if (game.engine === 'godot') {
      const enabled = state.isEnabled(game.appid);
      const hookInstalled = godot.isInstalled(game);
      const c = godot.config(game) || {};
      const report = reports.get(game.appid);
      const fresh = report && Date.now() - report.at < 6000;
      const launched = launches.get(game.appid);
      const hookStatus = fresh ? (report.selectedPath ? 'connected' : 'no-dialogue')
        : launched && Date.now() - launched < 15000 ? 'waiting' : 'disconnected';
      return { ...game, support: 'beta', voiceMode: 'generic', enabled, hookInstalled,
        hookStatus, labels: fresh ? report.labels : [], limitReached: fresh && report.limitReached,
        godotConfig: { textPath: c.textPath || '', speakerPath: c.speakerPath || '' } };
    }
    const enabled = state.isEnabled(game.appid);
    let hookInstalled = install.isHookInstalled(game);
    if (game.support === 'soon') return { ...game, enabled: false, hookInstalled: false };
    // Keep an enabled game's hook current with the one shipped in this build.
    if (enabled && hookInstalled && install.isHookOutdated(game, { modDir: opts.modDir })) {
      try { install.installHook(game, { modDir: opts.modDir }); } catch { /* keep the old one */ }
    }
    // A game update or "Verify integrity" may have removed the file: the UI shows Reinstall.
    return { ...game, enabled, hookInstalled };
  }

  async function rescan() {
    const steamGames = await scan.scanLibrary({
      ...(opts.scanOptions || {}), steamPath: opts.steamPath, includeBeta });
    const local = [];
    for (const dir of state.folders()) {
      const g = scan.scanFolder(dir);
      if (g) local.push(g);
    }
    cache = [...new Map([...steamGames, ...local].map((g) => [g.appid, g])).values()];
    generation++;
    checkTagsInBackground();
    return visible();
  }

  async function list() {
    if (!cache) return rescan();
    return visible();
  }

  async function find(appid) {
    if (!cache) await rescan();
    const game = cache.find((g) => g.appid === String(appid));
    if (!game) throw new Error('Unknown game: ' + appid);
    return game;
  }

  return {
    list,
    rescan,
    async addFolder() {
      const dir = opts.pickFolder ? await opts.pickFolder() : null;
      if (dir) {
        const game = scan.scanFolder(dir);
        if (!game) {
          throw new Error("That folder doesn't look like a supported game. Pick the folder " +
            "that holds the game's exe (for Ren'Py it also has renpy/ and game/ folders).");
        }
        state.addFolder(game.installDir);
        cache = null;
      }
      return list();
    },
    async setEnabled({ appid, enabled }) {
      const game = await find(appid);
      if (enabled && game.support === 'soon' && game.engine !== 'godot') {
        throw new Error(`Voices for ${game.name} aren't available yet. dub.game supports Ren'Py and RPG Maker MV games for now.`);
      }
      if (enabled) install.installHook(game, { modDir: opts.modDir });
      else install.uninstallHook(game);
      state.setEnabled(game.appid, !!enabled);
      return decorate(game);
    },
    async configureGodot({ appid, textPath, speakerPath }) {
      const game = await find(appid);
      if (game.engine !== 'godot') throw new Error('Not a Godot game.');
      godot.configure(game, { textPath, speakerPath });
      return decorate(game);
    },
    reportGodotHook(payload) {
      const game = cache && cache.find(g => g.appid === payload.appid && g.engine === 'godot');
      if (!game || !state.isEnabled(game.appid)) return false;
      const c = godot.config(game);
      if (!c || !c.token || payload.token !== c.token) return false;
      reports.set(game.appid, { ...payload, token: undefined, at: Date.now() });
      return true;
    },
    async launch({ appid }) {
      const game = await find(appid);
      if (game.engine === 'godot' && state.isEnabled(game.appid)) {
        // Refresh only through the installer, which refuses to overwrite changed overrides.
        godot.install(game, { modDir: opts.modDir });
        reports.delete(game.appid);
        launches.set(game.appid, Date.now());
      }
      let godotExecutable = state.godotExecutable();
      if (game.engine === 'godot' && fs.existsSync(path.join(game.installDir, 'project.godot'))) {
        if (!godotExecutable || !fs.existsSync(godotExecutable)) {
          godotExecutable = opts.pickGodot ? await opts.pickGodot() : null;
          if (!godotExecutable) throw new Error('Select the Godot 4 executable to run a source project.');
          state.setGodotExecutable(godotExecutable);
        }
      }
      try {
        return await launchGame(game, { shell: opts.shell, spawn: opts.spawn,
          platform: opts.platform, godotExecutable, onLaunch: opts.onLaunch });
      } catch (error) {
        if (godotExecutable) state.setGodotExecutable('');
        throw error;
      }
    },
  };
}

module.exports = { createGames, ...scan, ...install, launchGame };
