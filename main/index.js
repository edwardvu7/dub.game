'use strict';
// Electron entry point: windows, hotkey, localhost server, and wiring of the testable modules.
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, safeStorage, screen,
  clipboard, Menu } = require('electron');

const { loadEnv } = require('./env');
const { createServer, PORT, HOST } = require('./server');
const { createVoiceStore } = require('./voices');
const { createCache } = require('./cache');
const { createSettings } = require('./settings');
const { createPipeline } = require('./pipeline');
const { createClipboardWatcher } = require('./clipboard');
const { createHandlers, registerIpc } = require('./ipc');
const { createGames } = require('./steam');
const tts = require('./tts');
const profiler = require('./profiler');
const catalog = require('../voices_catalog.json');

const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Shift+F2';
const EXTERNAL_HOSTS = ['elevenlabs.io', 'aistudio.google.com', 'store.steampowered.com'];

let mainWindow = null;
let overlayWindow = null;
let quitting = false;
const pendingStatus = [];

loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(process.cwd(), '.env'));

// Lines arrive while the game has focus: audio must start without a click in our window.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function log(message) {
  console.log(`[dub.game] ${message}`);
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

// Audio plays in the main window only, so a clip is never doubled by the overlay.
function emit(channel, payload) {
  if (channel === 'app:status' && (!mainWindow || mainWindow.webContents.isLoading())) {
    pendingStatus.push(payload);
    return;
  }
  send(mainWindow, channel, payload);
  if (channel !== 'audio:play' && channel !== 'audio:stop') send(overlayWindow, channel, payload);
}

function openExternalSafely(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
      shell.openExternal(u.toString());
    }
  } catch { /* not a URL: ignore */ }
}

function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafely(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) { event.preventDefault(); openExternalSafely(url); }
  });
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false, // keep audio and timers alive while the game has focus
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 780, minWidth: 880, minHeight: 600,
    backgroundColor: '#0b0d10', title: 'dub.game', show: false,
    webPreferences: webPreferences(),
  });
  lockDown(mainWindow);
  mainWindow.loadFile(path.join(ROOT, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => {
    while (pendingStatus.length) send(mainWindow, 'app:status', pendingStatus.shift());
  });
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
    });
  }
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}

// A see-through, always-on-top panel docked to the right edge of the primary display.
// UNVERIFIED: shows over windowed/borderless games; not over exclusive fullscreen.
function createOverlayWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(460, area.width);
  overlayWindow = new BrowserWindow({
    x: area.x + area.width - width, y: area.y, width, height: area.height,
    transparent: true, frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false,
    alwaysOnTop: true, title: 'dub.game overlay',
    webPreferences: webPreferences(),
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  lockDown(overlayWindow);
  overlayWindow.loadFile(path.join(ROOT, 'ui', 'overlay.html'));
  // The overlay's close button calls window.close(): hide instead, so it reopens instantly.
  overlayWindow.on('close', (event) => {
    if (!quitting) { event.preventDefault(); overlayWindow.hide(); }
  });
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
    send(overlayWindow, 'overlay:toggle');
  }
}

async function start() {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');

  const settings = createSettings({
    file: path.join(userData, 'settings.json'),
    safeStorage,
    env: process.env,
    testers: { elevenlabs: (key) => tts.testKey(key), gemini: (key) => profiler.testKey(key) },
  });
  const voices = createVoiceStore({
    file: path.join(userData, 'voices.json'),
    catalogIds: catalog.map((v) => v.voice_id),
  });
  voices.onChange((all) => emit('voices:changed', all));
  const cache = createCache({ dir: path.join(userData, 'cache') });
  const pipeline = createPipeline({ voices, settings, catalog, cache, emit, log });

  const games = createGames({
    userData,
    modDir: path.join(ROOT, 'mod'),
    shell,
    includeBeta: process.env.DUBGAME_BETA === '1',
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Pick the game folder', properties: ['openDirectory'] });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
  });

  const clipboardWatcher = createClipboardWatcher({
    readText: () => clipboard.readText(),
    onLine: (line) => pipeline.handleLine(line),
  });
  if (settings.clipboardMode()) clipboardWatcher.start();

  registerIpc(ipcMain, createHandlers({
    games, voices, settings, pipeline, catalog,
    onClipboardMode: (on) => (on ? clipboardWatcher.start() : clipboardWatcher.stop()),
  }), {
    isTrusted: (event) => {
      const url = event.senderFrame ? event.senderFrame.url : '';
      return url.startsWith('file://');
    },
  });

  const server = createServer({
    log,
    onLine: (line) => pipeline.handleLine(line),
    onCharacters: (payload) => { pipeline.seedSamples(payload.characters); return pipeline.handleCharacters(payload); },
    onStop: (stop) => pipeline.handleStop(stop),
  });
  try {
    await server.listen(PORT, HOST);
    log(`listening on http://${HOST}:${PORT}`);
  } catch (e) {
    const message = e.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use, so games cannot reach dub.game. Close the other program (or a second dub.game) and restart.`
      : `Could not start the local server: ${e.message}`;
    log(message);
    pendingStatus.push({ level: 'error', message });
  }

  createMainWindow();
  createOverlayWindow();

  if (!globalShortcut.register(HOTKEY, toggleOverlay)) {
    pendingStatus.push({ level: 'warn', message: `${HOTKEY} is taken by another program; the overlay hotkey is off.` });
  }

  app.on('before-quit', () => {
    quitting = true;
    clipboardWatcher.stop();
    server.close();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch((e) => {
    console.error(e);
    dialog.showErrorBox('dub.game could not start', String(e && e.stack ? e.stack : e));
    app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
