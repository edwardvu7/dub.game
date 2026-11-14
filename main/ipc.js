'use strict';
// IPC handlers for the channels in CLAUDE.md. createHandlers is plain JS (testable);
// registerIpc attaches it to Electron's ipcMain.

const INVOKE_CHANNELS = [
  'games:list', 'games:rescan', 'games:addFolder', 'games:setEnabled', 'games:launch',
  'voices:get', 'voices:catalog', 'voices:update', 'voices:reroll', 'voices:preview',
  'settings:get', 'settings:setKeys', 'settings:test', 'settings:setNarration',
  'settings:setClipboardMode',
];
const EVENT_CHANNELS = ['audio:play', 'audio:stop', 'line:received', 'voices:changed',
  'overlay:toggle', 'app:status'];

/** createHandlers({games, voices, settings, pipeline, catalog, onClipboardMode?}) */
function createHandlers({ games, voices, settings, pipeline, catalog, onClipboardMode }) {
  const need = (arg, field) => {
    if (!arg || typeof arg !== 'object' || arg[field] === undefined) throw new Error(`Missing "${field}"`);
    return arg;
  };
  return {
    'games:list': () => games.list(),
    'games:rescan': () => games.rescan(),
    'games:addFolder': () => games.addFolder(),
    'games:setEnabled': (arg) => games.setEnabled({ appid: String(need(arg, 'appid').appid), enabled: !!arg.enabled }),
    'games:launch': (arg) => games.launch({ appid: String(need(arg, 'appid').appid) }),

    'voices:get': () => voices.all(),
    'voices:catalog': () => catalog,
    'voices:update': (arg) => voices.update(String(need(arg, 'speaker').speaker), arg.patch || {}),
    'voices:reroll': (arg) => pipeline.reroll({ speaker: String(need(arg, 'speaker').speaker) }),
    'voices:preview': (arg) => pipeline.preview({ speaker: String(need(arg, 'speaker').speaker), text: arg.text }),

    'settings:get': () => settings.getPublic(),
    'settings:setKeys': (arg) => settings.setKeys(arg || {}),
    'settings:test': (arg) => settings.test(arg),
    'settings:setNarration': (arg) => settings.setNarration(arg === true),
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
