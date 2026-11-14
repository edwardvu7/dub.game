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

  /** Full = exact speaker names; Beta = text is right but speakers need calibration. */
  function supportBadge(game) {
    return game && game.support === 'beta'
      ? { text: 'Beta', tone: 'beta', title: 'Lines are read correctly, but speaker names may be guessed.' }
      : { text: 'Full', tone: 'full', title: 'Exact text and speaker names.' };
  }

  /** off: not voiced. on: hook in place. missing: ticked, but the hook file is gone. */
  function gameStatus(game) {
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

  /** Voiced games first, then by name. Does not mutate. */
  function sortGames(games) {
    return (Array.isArray(games) ? games.slice() : []).sort((a, b) =>
      (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) ||
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
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
    return !settings || !settings.hasElevenLabsKey || !settings.hasGeminiKey;
  }

  /** One sentence under the Games heading. */
  function gamesSummary(games) {
    const list = Array.isArray(games) ? games : [];
    if (!list.length) return 'No supported games found yet.';
    const voiced = list.filter((g) => g.enabled).length;
    const found = list.length === 1 ? '1 supported game' : list.length + ' supported games';
    if (!voiced) return found + '. Switch one on to give it voices.';
    return found + ', ' + voiced + ' voiced.';
  }

  /** The line under a game's name: what the player should know or do next. */
  function gameHint(game, justEnabled) {
    const status = gameStatus(game);
    if (status === 'missing') return { tone: 'warn', text: 'The dub.game script is missing from this game. Reinstall it.' };
    if (status === 'on' && justEnabled) return { tone: 'note', text: 'Voices are on. If the game is open, restart it.' };
    if (status === 'on') return { tone: 'on', text: 'Voices are on.' };
    return { tone: 'off', text: 'Voices are off.' };
  }

  return { SLIDERS, clamp, formatSlider, supportBadge, gameStatus, filterGames, sortGames,
    sortSpeakers, initials, voiceLabel, errorText, base64ToBytes, keyState, needsSetup,
    gamesSummary, gameHint };
});
