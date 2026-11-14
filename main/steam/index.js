'use strict';
// Facade used by main/ipc.js for the games:* channels.
const path = require('node:path');
const scan = require('./scan');
const install = require('./install');
const { createState } = require('./state');
const { launchGame } = require('./launch');

/**
 * createGames({userData, modDir?, shell, pickFolder?, steamPath?, includeBeta?, scanOptions?})
 * pickFolder: async () => string|null (the main process passes a dialog wrapper).
 */
function createGames(opts) {
  const state = createState({ file: path.join(opts.userData, 'games.json') });
  const includeBeta = !!opts.includeBeta;
  let cache = null;

  function decorate(game) {
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
    cache = [...steamGames, ...local];
    return cache.map(decorate);
  }

  async function list() {
    if (!cache) return rescan();
    return cache.map(decorate);
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
      if (enabled && game.support === 'soon') {
        throw new Error(`Voices for ${game.name} aren't available yet. dub.game supports Ren'Py games for now.`);
      }
      if (enabled) install.installHook(game, { modDir: opts.modDir });
      else install.uninstallHook(game);
      state.setEnabled(game.appid, !!enabled);
      return decorate(game);
    },
    async launch({ appid }) {
      return launchGame(await find(appid), { shell: opts.shell, spawn: opts.spawn });
    },
  };
}

module.exports = { createGames, ...scan, ...install, launchGame };
