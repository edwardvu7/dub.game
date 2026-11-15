// Pure helpers shared by the main window and the overlay. No DOM, no window.dub, so they run
// under `node --test` as well as in the renderer (plain <script>, no bundler).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DubLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The three per-character controls. Ranges match what main/voices.js accepts.
  const SLIDERS = [
    { key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.05,
      hint: 'Lower is more expressive, higher is more even.' },
    { key: 'style', label: 'Style', min: 0, max: 1, step: 0.05,
      hint: "How strongly the voice's own character comes through." },
    { key: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05,
      hint: 'How fast the line is spoken.' },
    { key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05,
      hint: 'How loud this character is. Does not change the voice.' },
  ];

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  /** "45%" for stability/style, "1.05x" for speed. */
  function formatSlider(key, value) {
    const def = SLIDERS.find((s) => s.key === key);
    if (!def) return String(value);
    const v = clamp(value, def.min, def.max);
    return key === 'speed' ? v.toFixed(2) + 'x' : Math.round(v * 100) + '%';
  }

  const ENGINES = { renpy: "Ren'Py", godot: 'Godot', 'rpgmaker-mv': 'RPG Maker MV',
    'rpgmaker-mz': 'RPG Maker MZ', unity: 'Unity', kirikiri: 'Kirikiri' };

  function engineName(engine) {
    return ENGINES[engine] || String(engine || 'Unknown engine');
  }

  /** The badge on a game's cover: which engine, and whether voices work there yet. */
  function supportBadge(game) {
    const engine = engineName(game && game.engine);
    if (game && game.voiceMode === 'generic') return { text: 'Godot · Generic hook beta', tone: 'beta', title: 'Reads live Godot 4 text nodes. Compatibility varies by game.' };
    if (game && game.voiceMode) return { text: 'Godot · ' + (game.voiceMode === 'integrated' ? 'Demo voices' : 'Launch available'),
      tone: 'beta', title: game.voiceMode === 'integrated' ? 'Dialogue integration included.' : 'Launching is supported. Voices require a game integration.' };
    if (game && game.support === 'soon') {
      return { text: engine + ' \u00b7 Coming soon', tone: 'soon', title: "Voices for " + engine + " games aren't available yet." };
    }
    if (game && game.support === 'beta') {
      return { text: engine + ' \u00b7 Beta', tone: 'beta', title: 'Lines are read correctly, but speaker names may be guessed.' };
    }
    return { text: engine, tone: 'full', title: 'Exact text and speaker names.' };
  }

  /** off: not voiced. on: hook in place. missing: ticked, but the hook file is gone. */
  function gameStatus(game) {
    if (game && game.voiceMode && game.voiceMode !== 'generic') return game.voiceMode === 'integrated' ? 'integrated' : 'launch';
    if (game && game.support === 'soon') return 'soon';
    if (!game || !game.enabled) return 'off';
    return game.hookInstalled ? 'on' : 'missing';
  }

  function filterGames(games, query) {
    const q = String(query || '').trim().toLowerCase();
    const list = Array.isArray(games) ? games : [];
    if (!q) return list.slice();
    return list.filter((g) => String(g.name || '').toLowerCase().includes(q) ||
      String(g.engine || '').toLowerCase().includes(q));
  }

  /** Voiced games first, then other playable games, coming-soon engines last; then by name. */
  /** Grouped by engine (A to Z by its shown name: Godot, Ren'Py, RPG Maker, Unity), then by game name. */
  function sortGames(games) {
    const az = (x, y) => String(x || '').localeCompare(String(y || ''), undefined, { sensitivity: 'base' });
    return (Array.isArray(games) ? games.slice() : []).sort((a, b) =>
      az(engineName(a.engine), engineName(b.engine)) || az(a.name, b.name));
  }

  /** Speakers in a stable order: whoever is talking first, Narrator last, the rest A to Z. */
  function sortSpeakers(voices, current) {
    const names = Object.keys(voices || {});
    const rank = (n) => (n === current ? 0 : n === 'Narrator' ? 2 : 1);
    return names.sort((a, b) => rank(a) - rank(b) ||
      a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
    return letters.toUpperCase();
  }

  function voiceLabel(entry) {
    if (!entry) return 'Unknown voice';
    return entry.description ? entry.name + ' (' + entry.description + ')' : entry.name;
  }

  /** Dropdown label for a voice that is not in the catalog but was designed for this character. */
  function customVoiceLabel(custom) {
    return 'Custom: ' + String((custom && custom.name) || 'designed voice');
  }

  /** Electron wraps handler errors as "Error invoking remote method 'x': Error: real message". */
  function errorText(err) {
    const raw = err && err.message !== undefined ? String(err.message) : String(err || '');
    const cleaned = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:[A-Za-z]*Error):\s*/, '')
      .trim();
    return cleaned || 'Something went wrong.';
  }

  /** base64 -> bytes, for turning an audio:play payload into a Blob. */
  function base64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** What the Settings screen says about one key. */
  function keyState(hasKey) {
    return hasKey
      ? { text: 'Key saved', tone: 'ok', placeholder: 'Saved. Paste a new key to replace it' }
      : { text: 'No key yet', tone: 'none', placeholder: 'Paste your key' };
  }

  /** True when the app cannot speak yet, so Settings should open first. */
  function needsSetup(settings) {
    return !settings || !settings.hasElevenLabsKey || !settings.hasGrokKey;
  }

  /** One sentence under the Games heading. */
  function gamesSummary(games) {
    const n = Array.isArray(games) ? games.length : 0;
    if (!n) return 'No supported games found yet.';
    return n === 1 ? '1 game found.' : n + ' games found.';
  }

  /** The line under a game's name: what the player should know or do next. */
  function gameHint(game, justEnabled) {
    const status = gameStatus(game);
    if (game && game.voiceMode === 'generic') {
      if (!game.enabled) return { tone: 'off', text: 'Voices turn on when you launch. Godot 4 games only.' };
      if (!game.hookInstalled) return { tone: 'warn', text: 'Hook files are missing or changed. Reinstall with the game closed.' };
      const messages = {
        connected: 'Connected. Dialogue node detected. Narration must be enabled for unnamed text.',
        'no-dialogue': 'Connected. Waiting for dialogue to show up in the game.',
        waiting: 'Waiting for the game hook to connect…',
        disconnected: 'Installed; no live connection. Start or restart the game. If this persists, this build may not support the hook.',
      };
      return { tone: game.hookStatus === 'connected' ? 'on' : 'note', text: messages[game.hookStatus] || messages.disconnected };
    }
    if (status === 'integrated') return { tone: 'on', text: 'Demo voices included. Select Godot 4 on first launch.' };
    if (status === 'launch') return { tone: 'off', text: 'Ready to launch. Voices require a dub.game integration in this game.' };
    if (status === 'soon') return { tone: 'off', text: 'Voices for ' + engineName(game.engine) + " games aren't available yet." };
    if (status === 'missing') return { tone: 'warn', text: 'The dub.game script is missing from this game. Reinstall it.' };
    if (status === 'on' && justEnabled) return { tone: 'note', text: 'Voices are on. If the game is open, restart it.' };
    if (status === 'on') return { tone: 'on', text: 'Voices are on.' };
    return { tone: 'off', text: 'Voices are off.' };
  }

  // ---------- Voices per game (voices:get -> {current, games: {id: {name, voices}}}) ----------

  /** A readable name for a game id like "renpy:DDLC" when the scan did not name it. */
  function gameLabel(id, entry) {
    if (entry && entry.name && entry.name !== id) return entry.name;
    if (id === 'clipboard') return 'Clipboard (other games)';
    if (id === 'unknown' || !id) return 'Unknown game';
    const rest = String(id).split(':').slice(1).join(':');
    return rest && rest !== 'unknown' ? rest : 'Unknown game';
  }

  /** Game ids to offer in a picker: the current game first, then by name. */
  function gameIds(store) {
    const games = (store && store.games) || {};
    const current = store && store.current;
    return Object.keys(games).sort((a, b) => {
      if (a === current) return -1;
      if (b === current) return 1;
      return gameLabel(a, games[a]).localeCompare(gameLabel(b, games[b]));
    });
  }

  /** speaker -> profile for one game ({} when it has none). */
  function voicesFor(store, id) {
    const g = store && store.games && id && store.games[id];
    return (g && g.voices) || {};
  }

  /**
   * The voices id of a scanned game, or null when it has no saved voices. Hooks send
   * "<engine>:<install folder name>"; matched the way gameName() in main/index.js does.
   */
  function savedGameId(store, game) {
    const folder = String((game && game.installDir) || '').split(/[\\/]/).filter(Boolean).pop();
    if (!folder) return null;
    return Object.keys((store && store.games) || {}).find((id) => {
      const [engine, ...rest] = id.split(':');
      return rest.join(':').toLowerCase() === folder.toLowerCase() && String(game.engine).startsWith(engine);
    }) || null;
  }

  /** 12345 -> "12,345" */
  function formatCount(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  /** "Used 1,200 of 10,000 characters (12%)" for the ElevenLabs plan. */
  function planSummary(plan) {
    if (!plan || !plan.ok) return (plan && plan.error) || 'Unknown.';
    const pct = plan.limit > 0 ? Math.round((plan.used / plan.limit) * 100) : 0;
    let text = 'Used ' + formatCount(plan.used) + ' of ' + formatCount(plan.limit) + ' characters (' + pct + '%)';
    if (plan.resetAt) text += ', resets ' + new Date(plan.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return text + '.';
  }

  return { SLIDERS, clamp, formatSlider, supportBadge, gameStatus, filterGames, sortGames,
    sortSpeakers, initials, voiceLabel, customVoiceLabel, errorText, base64ToBytes, keyState, needsSetup,
    gamesSummary, gameHint, engineName, gameLabel, gameIds, voicesFor, savedGameId, formatCount, planSummary };
});
