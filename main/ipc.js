'use strict';
// IPC handlers for the channels in CLAUDE.md. createHandlers is plain JS (testable);
// registerIpc attaches it to Electron's ipcMain.

const INVOKE_CHANNELS = [
  'games:list', 'games:rescan', 'games:addFolder', 'games:setEnabled', 'games:launch', 'games:godotConfig',
  'voices:get', 'voices:catalog', 'voices:update', 'voices:reroll', 'voices:preview', 'voices:clearGame',
  'usage:get', 'usage:setLimit', 'usage:plan',
  'settings:get', 'settings:setKeys', 'settings:test', 'settings:setNarration',
  'settings:setClipboardMode', 'settings:setActing',
];
const EVENT_CHANNELS = ['audio:play', 'audio:stop', 'line:received', 'voices:changed', 'games:changed',
  'usage:changed', 'overlay:toggle', 'app:status'];

/**
 * createHandlers({games, voices, settings, pipeline, catalog, usage?, plan?, onClipboardMode?})
 * voices is the per-game store; voice channels take an optional `game` (default: the current game).
 * plan() asks ElevenLabs how much of the account's monthly quota is used.
 */
function createHandlers({ games, voices, settings, pipeline, catalog, usage, plan, onClipboardMode }) {
  const gameArg = (arg) => (arg && typeof arg.game === 'string' && arg.game ? arg.game : (voices.current() || 'unknown'));
  const need = (arg, field) => {
    if (!arg || typeof arg !== 'object' || arg[field] === undefined) throw new Error(`Missing "${field}"`);
    return arg;
  };
  return {
    'games:list': () => games.list(),
    'games:rescan': () => games.rescan(),
    'games:addFolder': () => games.addFolder(),
    'games:setEnabled': (arg) => games.setEnabled({ appid: String(need(arg, 'appid').appid), enabled: !!arg.enabled }),
    'games:godotConfig': (arg) => games.configureGodot({ ...need(arg, 'appid'), appid: String(arg.appid) }),
    'games:launch': (arg) => games.launch({ appid: String(need(arg, 'appid').appid) }),

    'voices:get': () => voices.all(),
    'voices:catalog': () => catalog,
    'voices:update': (arg) => voices.forGame(gameArg(arg)).update(String(need(arg, 'speaker').speaker), arg.patch || {}),
    'voices:reroll': (arg) => pipeline.reroll({ game: gameArg(arg), speaker: String(need(arg, 'speaker').speaker) }),
    'voices:preview': (arg) => pipeline.preview({ game: gameArg(arg), speaker: String(need(arg, 'speaker').speaker), text: arg.text }),
    'voices:clearGame': (arg) => voices.clearGame(String(need(arg, 'game').game)),

    'usage:get': () => (usage ? usage.get() : null),
    'usage:setLimit': (arg) => {
      if (!usage) throw new Error('Usage tracking is off.');
      return usage.setLimit(Number(arg));
    },
    'usage:plan': () => (plan ? plan() : { ok: false, error: 'Not available.' }),

    'settings:get': () => settings.getPublic(),
    'settings:setKeys': (arg) => settings.setKeys(arg || {}),
    'settings:test': (arg) => settings.test(arg),
    'settings:setNarration': (arg) => settings.setNarration(arg === true),
    'settings:setActing': (arg) => settings.setActing(arg === true),
    'settings:setClipboardMode': (arg) => {
      const out = settings.setClipboardMode(arg === true);
      if (onClipboardMode) onClipboardMode(out.clipboardMode);
      return out;
    },
  };
}

/** registerIpc(ipcMain, handlers, {isTrusted?}): isTrusted(event) rejects foreign frames. */
function registerIpc(ipcMain, handlers, opts = {}) {
  for (const channel of INVOKE_CHANNELS) {
    const fn = handlers[channel];
    if (!fn) throw new Error('No handler for ' + channel);
    ipcMain.handle(channel, async (event, arg) => {
      if (opts.isTrusted && !opts.isTrusted(event)) throw new Error('Untrusted sender');
      return fn(arg);
    });
  }
}

module.exports = { createHandlers, registerIpc, INVOKE_CHANNELS, EVENT_CHANNELS };
