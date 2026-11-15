'use strict';
// The only bridge between renderer windows and the main process: window.dub (see CLAUDE.md).
// Channel names are allow-listed here; keep in sync with INVOKE_CHANNELS / EVENT_CHANNELS in
// main/ipc.js (a sandboxed preload can only require 'electron', so the lists are repeated).
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
  'games:list', 'games:rescan', 'games:addFolder', 'games:setEnabled', 'games:launch', 'games:godotConfig',
  'voices:get', 'voices:catalog', 'voices:update', 'voices:reroll', 'voices:customize', 'voices:preview', 'voices:clearGame',
  'usage:get', 'usage:setLimit', 'usage:plan',
  'settings:get', 'settings:setKeys', 'settings:test', 'settings:setNarration',
  'settings:setClipboardMode', 'settings:setActing', 'settings:setCustomVoices', 'settings:setQuality',
];
const EVENTS = ['audio:play', 'audio:stop', 'line:received', 'voices:changed', 'overlay:toggle', 'games:changed',
  'usage:changed', 'app:status'];

contextBridge.exposeInMainWorld('dub', {
  invoke(channel, arg) {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error('Unknown channel: ' + channel));
    return ipcRenderer.invoke(channel, arg);
  },
  on(channel, fn) {
    if (!EVENTS.includes(channel) || typeof fn !== 'function') return () => {};
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
