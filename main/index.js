'use strict';
// Electron entry point: windows, hotkey, localhost server, and wiring of the testable modules.
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, safeStorage, screen,
  clipboard, Menu, Notification } = require('electron');

const { loadEnv } = require('./env');
const { createServer, PORT, HOST } = require('./server');
const { createVoiceStore } = require('./voices');
const { createCache } = require('./cache');
const { createSettings } = require('./settings');
const { createUsage } = require('./usage');
const { createOverlayPosition, constrainToGame } = require('./overlay-position');
const { createPipeline } = require('./pipeline');
const { createMoods } = require('./moods');
const { createVoiceDesigner } = require('./voice-design');
const castLookup = require('./cast');
const { createClipboardWatcher } = require('./clipboard');
const { createHandlers, registerIpc } = require('./ipc');
const { createGames } = require('./steam');
const { createGameWindowTracker } = require('./game-window');
const { createTagCheck } = require('./steam/tags');
const tts = require('./tts');
const profiler = require('./profiler');
const { createFullscreenCheck, EXCLUSIVE_MESSAGE } = require('./fullscreen');
const catalog = require('../voices_catalog.json');

const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Shift+F2';
const BACKUP_HOTKEYS = ['Control+Alt+F2']; // also registered, in case a game or tool swallows Shift+F2
const EXTERNAL_HOSTS = ['elevenlabs.io', 'aistudio.google.com', 'store.steampowered.com', 'console.x.ai'];

let mainWindow = null;
const APP_ICON = path.join(ROOT, 'ui', 'logo.png');
let overlayWindow = null;
let quitting = false;
const pendingStatus = [];

loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(process.cwd(), '.env'));

// Lines arrive while the game has focus: audio must start without a click in our window.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function log(message) {
  // Timed (UTC): "line" to "audio" is the wait before a voice; a line with no "audio" was never played.
  console.log(`[dub.game ${new Date().toISOString().slice(11, 23)}] ${message}`);
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
  if (channel === 'audio:play') log(`audio ${payload.speaker}: ${payload.text}`);
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
    icon: APP_ICON, // taskbar; the installed .exe gets build/icon.png
    // No title bar: the app fills the window. Windows keeps its own minimise/maximise/close
    // buttons on the right end of the app's own title bar (.titlebar in ui/index.html).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#13171c', symbolColor: '#99a0ab', height: 33 }, // same colour as .titlebar (ui/styles.css); 33 leaves its 1px bottom line showing
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

// A see-through, always-on-top panel on the screen the player is using; the player can drag it.
// UNVERIFIED: shows over windowed/borderless games; not over exclusive fullscreen (see fullscreen.js).
const OVERLAY = { width: 340, height: 600, margin: 16 };
const fullscreenCheck = createFullscreenCheck();
let lastFullscreenWarning = 0;

let overlayPosition = null; // created in start(), once userData is known

let gameFrame = null;
let overlayWanted = false;
let gameLaunched = false;
let gameTracker = null;
let applyingOverlayBounds = false;
let overlayOffset = null;

// When game-window tracking has not found the window (Ren'Py's splash window, a launcher process,
// an unreadable elevated game), Shift+F2 still opens the overlay on the screen the cursor is on.
let fallbackArea = null;
function gameArea() {
  if (!gameFrame && fallbackArea) return fallbackArea;
  if (!gameFrame || gameFrame.minimized) return null;
  const rect = { x: gameFrame.x, y: gameFrame.y, width: gameFrame.width, height: gameFrame.height };
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}
function overlayBounds() {
  const area = gameArea();
  if (!area) return { x: 0, y: 0, width: OVERLAY.width, height: OVERLAY.height };
  const display = { id: gameFrame ? 'game:' + gameFrame.gameId : 'screen', workArea: area };
  const spot = overlayOffset ? { x: area.x + overlayOffset.dx, y: area.y + overlayOffset.dy }
    : overlayPosition && overlayPosition.place(display, OVERLAY.width, OVERLAY.height);
  return constrainToGame(area, { ...spot, width: OVERLAY.width, height: OVERLAY.height });
}
function placeOverlay(bounds) {
  const current = overlayWindow.getBounds();
  if (['x', 'y', 'width', 'height'].every(k => current[k] === bounds[k])) return;
  applyingOverlayBounds = true;
  try { overlayWindow.setBounds(bounds); } finally { applyingOverlayBounds = false; }
}
// Re-assert the top-most level: a game that takes the foreground (or a fullscreen switch) can push
// a window below it, and Windows drops the level of windows shown without activation.
function raiseOverlay() {
  try {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.moveTop();
  } catch { /* cosmetic */ }
}
function syncOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const area = gameArea();
  const overlayFocused = overlayWindow.isFocused && overlayWindow.isFocused();
  // Without a tracked game window (fallback) the overlay stays until Shift+F2 hides it.
  if (!overlayWanted || !area || (gameFrame && !gameFrame.focused && !overlayFocused)) {
    overlayWindow.hide();
    return;
  }
  placeOverlay(overlayBounds());
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  raiseOverlay();
}
function rememberOverlaySpot() {
  if (applyingOverlayBounds || !overlayWindow || overlayWindow.isDestroyed()) return;
  const area = gameArea();
  if (!area) return;
  const bounds = constrainToGame(area, overlayWindow.getBounds());
  overlayOffset = { dx: bounds.x - area.x, dy: bounds.y - area.y };
  placeOverlay(bounds);
  if (overlayPosition) overlayPosition.remember({ id: gameFrame ? 'game:' + gameFrame.gameId : 'screen', workArea: area }, bounds);
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    ...overlayBounds(),
    transparent: true, frame: false, resizable: false, movable: true, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false,
    alwaysOnTop: true, title: 'dub.game overlay',
    webPreferences: webPreferences(),
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(overlayWindow);
  overlayWindow.loadFile(path.join(ROOT, 'ui', 'overlay.html'));
  overlayWindow.on('move', rememberOverlaySpot);
  overlayWindow.on('will-move', (event, proposed) => {
    const area = gameArea();
    if (!area) { event.preventDefault(); return; }
    const clamped = constrainToGame(area, proposed);
    if (clamped.x !== proposed.x || clamped.y !== proposed.y) {
      event.preventDefault();
      overlayOffset = { dx: clamped.x - area.x, dy: clamped.y - area.y };
      placeOverlay(clamped);
      rememberOverlaySpot();
    }
  });
  overlayWindow.on('close', (event) => {
    if (!quitting) { event.preventDefault(); hideOverlay(); }
  });
  // If the overlay page ever crashes, reload it so Shift+F2 keeps working.
  overlayWindow.webContents.on('render-process-gone', () => {
    if (!quitting && overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.reload();
  });
}

function warnIfExclusiveFullscreen() {
  fullscreenCheck().then((state) => {
    if (state !== 'exclusive' || Date.now() - lastFullscreenWarning < 60000) return;
    lastFullscreenWarning = Date.now();
    emit('app:status', { level: 'warn', message: EXCLUSIVE_MESSAGE });
    // Windows holds notifications back during exclusive fullscreen and shows them afterwards.
    try {
      if (Notification.isSupported()) new Notification({ title: 'dub.game overlay is hidden', body: EXCLUSIVE_MESSAGE }).show();
    } catch { /* the main-window message is enough */ }
  });
}

// Hiding a focused window does not give focus back to the game on Windows, so the game stopped
// counting as focused and the next Shift+F2 was refused. blur() hands focus to the window behind.
function hideOverlay() {
  overlayWanted = false;
  fallbackArea = null;
  if (overlayWindow.isFocused && overlayWindow.isFocused()) overlayWindow.blur();
  overlayWindow.hide();
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWanted) { hideOverlay(); return; }
  // Shift+F2 is a global hotkey: a running, visible game is enough, whichever window has focus.
  fallbackArea = null;
  if (!gameArea()) {
    if (!gameFrame && gameLaunched) {
      // Tracking has not found the game window: show on the screen under the cursor instead of nothing.
      fallbackArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    } else {
      emit('app:status', { level: 'warn', message: 'Launch a game from dub.game, then press Shift+F2. Game-window tracking requires Windows.' });
      return;
    }
  }
  overlayWanted = true;
  placeOverlay(overlayBounds());
  // Shown without taking focus so the game keeps running (Ren'Py/SDL fullscreen minimizes or pauses
  // when it loses focus). Clicking a card activates the panel as usual.
  overlayWindow.showInactive();
  raiseOverlay();
  send(overlayWindow, 'overlay:toggle');
  warnIfExclusiveFullscreen();
}

async function start() {
  if (process.platform === 'win32') app.setAppUserModelId('game.dub.app');
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  overlayPosition = createOverlayPosition({ file: path.join(userData, 'overlay-position.json') });

  const settings = createSettings({
    file: path.join(userData, 'settings.json'),
    safeStorage,
    env: process.env,
    testers: { elevenlabs: (key) => tts.testKey(key),
      grok: (key) => castLookup.testKey(key) },
  });
  const voices = createVoiceStore({
    file: path.join(userData, 'voices.json'),
    catalogIds: catalog.map((v) => v.voice_id),
    catalog,
  });
  voices.onChange((all) => emit('voices:changed', all));
  const usage = createUsage({ file: path.join(userData, 'usage.json') });
  usage.onChange((snap) => emit('usage:changed', snap));
  const cache = createCache({ dir: path.join(userData, 'cache') });
  cache.prune(60 * 24 * 3600 * 1000); // clips not played for 60 days
  // Hooks name a game "<engine>:<folder>"; the Steam scan knows the folder's real name.
  let knownGames = [];
  const remember = (list) => { if (Array.isArray(list)) knownGames = list; return list; };
  const gameName = (id) => {
    const [engine, ...rest] = String(id).split(':');
    const folder = rest.join(':').toLowerCase();
    if (!folder) return null;
    const hit = knownGames.find((g) => g.installDir && path.basename(g.installDir).toLowerCase() === folder &&
      (!engine || g.engine === engine || String(g.engine).startsWith(engine)));
    return hit ? hit.name : null;
  };
  const moods = createMoods({ settings, usage, emitStatus: (message) => emit('app:status', { level: 'warn', message }) });
  let pipeline = null;
  const cast = castLookup.createCastBook({ file: path.join(userData, 'cast.json'), settings, log,
    onReady: (game) => { if (pipeline) pipeline.recast(game).catch(() => {}); } });
  pipeline = createPipeline({ voices, settings, catalog, cache, emit, log, usage, gameName, moods, cast,
    designer: createVoiceDesigner({ settings, log }) });

  gameTracker = createGameWindowTracker({
    onFrame: (frame) => {
      if (!frame || !gameFrame || frame.gameId !== gameFrame.gameId) overlayOffset = null;
      gameFrame = frame;
      syncOverlay();
    },
    onError: (message) => emit('app:status', { level: 'warn', message }),
  });

  const games = createGames({
    userData,
    modDir: path.join(ROOT, 'mod'),
    onLaunch: (game, pid) => {
      overlayWanted = false;
      fallbackArea = null;
      gameLaunched = true;
      gameTracker.start(game, pid);
    },
    pickGodot: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select the Godot 4 executable (not your game)',
        properties: ['openFile'],
        ...(process.platform === 'win32' ? { filters: [{ name: 'Godot executable', extensions: ['exe'] }] } : {}),
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    shell,
    includeBeta: process.env.DUBGAME_BETA === '1',
    // Godot/RPG Maker/Unity games are listed only when Steam tags them as story-driven.
    tagCheck: createTagCheck({ file: path.join(userData, 'steam-tags.json') }),
    onChange: (list) => emit('games:changed', remember(list)),
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

  const trackedGames = {
    ...games,
    list: () => games.list().then(remember),
    rescan: () => games.rescan().then(remember),
    addFolder: () => games.addFolder().then(remember),
  };

  registerIpc(ipcMain, createHandlers({
    games: trackedGames, voices, settings, pipeline, catalog, usage,
    plan: () => tts.subscription(settings.getKey('elevenlabs')),
    onClipboardMode: (on) => (on ? clipboardWatcher.start() : clipboardWatcher.stop()),
  }), {
    isTrusted: (event) => {
      const url = event.senderFrame ? event.senderFrame.url : '';
      return url.startsWith('file://');
    },
  });

  const server = createServer({
    log,
    onGodotHook: (payload) => games.reportGodotHook(payload),
    onLine: (line) => pipeline.handleLine(line),
    onCharacters: (payload) => pipeline.handleCharacters(payload),
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

  const hotkeys = [HOTKEY, ...BACKUP_HOTKEYS].filter((key) => {
    try { return globalShortcut.register(key, toggleOverlay); } catch { return false; }
  });
  if (!hotkeys.length) {
    pendingStatus.push({ level: 'warn', message: `${HOTKEY} is taken by another program; the overlay hotkey is off.` });
  } else if (hotkeys[0] !== HOTKEY) {
    pendingStatus.push({ level: 'warn', message: `${HOTKEY} is taken by another program; use ${hotkeys[0]} for the overlay.` });
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
  app.on('will-quit', () => {
    if (gameTracker) gameTracker.stop();
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => app.quit());
}
