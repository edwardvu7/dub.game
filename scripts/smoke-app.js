// npm run smoke. Boots the real main/index.js with a stand-in for Electron, a fake Steam library,
// and fake ElevenLabs/Grok, then plays the part of a game and of the UI.
'use strict';
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const EventEmitter = require('node:events');

const REPO = process.argv[2] || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dubsmoke-'));
const log = (...a) => console.log('  ', ...a);
const problems = [];
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) problems.push(what); };

// ---- fake Steam library with one Ren'Py game ----
const steam = path.join(tmp, 'Steam');
const game = path.join(steam, 'steamapps', 'common', 'Demo VN');
fs.mkdirSync(path.join(game, 'renpy'), { recursive: true });
fs.mkdirSync(path.join(game, 'game'), { recursive: true });
fs.writeFileSync(path.join(game, 'game', 'script.rpyc'), 'x');
fs.writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
  `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_424242.acf'),
  `"AppState"\n{\n\t"appid"\t\t"424242"\n\t"name"\t\t"Demo Visual Novel"\n\t"installdir"\t\t"Demo VN"\n}\n`);
for (const [id, name, tags] of [['515151', 'Story Unity', { 'Story Rich': 40, Adventure: 30 }], ['616161', 'Shooter Unity', { FPS: 90 }]]) {
  const dir = path.join(steam, 'steamapps', 'common', name);
  fs.mkdirSync(path.join(dir, name + '_Data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'UnityPlayer.dll'), 'x');
  fs.writeFileSync(path.join(dir, name + '.exe'), 'x');
  fs.writeFileSync(path.join(steam, 'steamapps', `appmanifest_${id}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${name}"\n}\n`);
  (globalThis.__spyTags = globalThis.__spyTags || {})[id] = { name, tags };
}
process.env.DUBGAME_STEAM_PATH = steam;
process.env.ELEVENLABS_API_KEY = 'test-eleven';
process.env.XAI_API_KEY = 'test-xai';

// ---- fake network: ElevenLabs returns bytes, Grok returns a profile ----
const calls = [];
const bodies = []; // [url, parsed body] of POSTs
globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  if (init.body) try { bodies.push([String(url), JSON.parse(init.body)]); } catch { /* not JSON */ }
  const ok = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type } });
  if (url.includes('api.elevenlabs.io/v1/text-to-speech')) return ok(Buffer.from('ID3fakeaudio'), 'audio/mpeg');
  if (url.includes('api.elevenlabs.io/v1/user')) return ok('{}', 'application/json');
  if (url === 'https://api.x.ai/v1/models') return ok('{}', 'application/json');
  if (url === 'https://api.x.ai/v1/responses') {
    const req = JSON.parse(init.body);
    const reply = (obj) => ok(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }] }), 'application/json');
    if (req.tools) { // the cast lookup for the demo game (web_search)
      return reply({ characters: [{ name: 'Sylvie', aliases: ['Sylvie Ray'], gender: 'female', age_range: 'young_adult',
        personality: 'Shy artist.', voice: 'Soft.' }] });
    }
    const prompt = req.input[0].content;
    if (/directing voice actors/.test(prompt)) { // acting: direct every numbered line as scared
      const n = (prompt.match(/^\d+\. /gm) || []).length;
      return reply({ lines: Array.from({ length: n }, (_, i) => ({ i, emotion: 'scared', intensity: 1 })) });
    }
    const cat = require(path.join(REPO, 'voices_catalog.json'));
    const names = ['Sylvie', 'Marcus'].filter((n) => prompt.includes(n));
    const one = (n) => ({ speaker: n, gender: 'female', age_range: 'young_adult', personality: n + ' is kind.',
      voice_id: cat[1].voice_id, stability: 0.4, style: 0.3, speed: 1.05, reason: 'Fits.' });
    return reply(names.length > 1 || /"profiles":\[/.test(prompt) ? { profiles: names.map(one) } : one(names[0] || 'Sylvie'));
  }
  if (url.includes('steamspy.com/api.php')) {
    const id = new URL(url).searchParams.get('appid');
    return ok(JSON.stringify(globalThis.__spyTags[id] || {}), 'application/json');
  }
  throw new Error('unexpected fetch ' + url);
};

// ---- stand-in for electron ----
const sent = []; // [windowTitle, channel, payload]
const windows = [];
class FakeWebContents extends EventEmitter {
  constructor(win) { super(); this.win = win; this.url = ''; }
  send(ch, p) { sent.push([this.win.opts.title, ch, p]); }
  isDestroyed() { return false; }
  isLoading() { return false; }
  getURL() { return this.url; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  toggleDevTools() {}
}
class FakeWindow extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }; this.visible = false; this.focused = false; this.webContents = new FakeWebContents(this); windows.push(this); }
  loadFile(f) { this.file = f; this.webContents.url = 'file://' + f; setImmediate(() => { this.emit('ready-to-show'); this.webContents.emit('did-finish-load'); }); return Promise.resolve(); }
  show() { this.visible = true; } showInactive() { this.visible = true; } isFocused() { return this.focused; } hide() { this.visible = false; this.focused = false; } isVisible() { return this.visible; }
  isDestroyed() { return false; } isMinimized() { return false; } restore() {}
  setAlwaysOnTop() {} setIgnoreMouseEvents() {} setVisibleOnAllWorkspaces() {}
  blur() { this.focused = false; this.blurred = (this.blurred || 0) + 1; } setBounds(b) { this.bounds = b; } getBounds() { return this.bounds; } reload() { this.reloaded = (this.reloaded || 0) + 1; } focus() { this.focused = true; }
}
const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }];
let cursor = { x: 100, y: 100 };
const handlers = {};
const shortcuts = {};
const app = new EventEmitter();
Object.assign(app, {
  isPackaged: false,
  getPath: (n) => path.join(tmp, n),
  commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  quit: () => log('app.quit() called'),
  setAppUserModelId() {},
});
const electron = {
  app, BrowserWindow: FakeWindow,
  globalShortcut: { register: (k, fn) => { shortcuts[k] = fn; return true; }, unregisterAll() {} },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  shell: { openExternal: (u) => calls.push('openExternal ' + u) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: (t, m) => problems.push('ERROR BOX ' + m) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) },
  screen: {
    screenToDipRect: (_w, r) => r,
    getPrimaryDisplay: () => displays[0],
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: (p) => displays.find((d) => p.x >= d.workArea.x && p.x < d.workArea.x + d.workArea.width) || displays[0],
  },
  Notification: Object.assign(function () { return { show() {} }; }, { isSupported: () => true }),
  clipboard: { readText: () => '' },
  Menu: { setApplicationMenu() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron' : origResolve.call(this, req, ...rest); };
require.cache.electron = { id: 'electron', filename: 'electron', loaded: true, exports: electron };

let trackerCallbacks;
const trackerFile = path.join(REPO, 'main', 'game-window.js');
require.cache[trackerFile] = { id: trackerFile, filename: trackerFile, loaded: true, exports: {
  createGameWindowTracker: (opts) => { trackerCallbacks = opts; return {
    start: () => opts.onFrame(null), stop: () => opts.onFrame(null),
  }; },
} };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: 8000, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
  (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end(data);
});
const trusted = { senderFrame: { url: 'file://' + path.join(REPO, 'ui', 'index.html') } };
const invoke = (ch, arg) => handlers[ch](trusted, arg);
const events = (ch) => sent.filter((s) => s[1] === ch);

(async () => {
  require(path.join(REPO, 'main', 'index.js'));
  await wait(400);

  // 1. Windows and pages
  const main = windows.find((w) => w.opts.title === 'dub.game');
  const overlay = windows.find((w) => w.opts.title === 'dub.game overlay');
  check(main && fs.existsSync(main.file), 'main window loads an existing page: ' + (main && path.relative(REPO, main.file)));
  check(overlay && fs.existsSync(overlay.file), 'overlay loads an existing page: ' + (overlay && path.relative(REPO, overlay.file)));
  check(main && main.visible, 'main window is shown');
  check(overlay && overlay.opts.transparent && overlay.opts.alwaysOnTop, 'overlay is transparent and always on top');
  const prefs = main.opts.webPreferences;
  check(prefs.contextIsolation && !prefs.nodeIntegration && fs.existsSync(prefs.preload), 'secure webPreferences with an existing preload');

  // 2. Every channel the preload allows has a handler, and the UI only uses allowed channels
  const preload = fs.readFileSync(prefs.preload, 'utf8');
  const allowedInvoke = (preload.match(/const INVOKE = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  check(allowedInvoke.every((c) => handlers[c]), 'every preload invoke channel has an ipcMain handler (' + allowedInvoke.length + ')');

  // 3. Hotkey is tied to the tracked game, never the cursor's monitor.
  check(typeof shortcuts['Shift+F2'] === 'function', 'Shift+F2 is registered');
  shortcuts['Shift+F2']();
  check(!overlay.visible, 'overlay stays hidden without a tracked game');
  let frame = { x: -1920, y: -100, width: 1920, height: 1080,
    focused: true, minimized: false, gameId: '424242' };
  trackerCallbacks.onFrame(frame);
  shortcuts['Shift+F2']();
  check(overlay.visible && events('overlay:toggle').length === 1, 'hotkey shows overlay over tracked game');
  check(overlay.bounds.x === -1904 && overlay.bounds.y === 140, 'negative monitor origin is respected');
  cursor = { x: 3000, y: 500 };
  trackerCallbacks.onFrame(frame);
  check(overlay.bounds.x === -1904, 'moving cursor to another monitor does not move overlay');
  let prevented = false;
  overlay.emit('will-move', { preventDefault: () => { prevented = true; } },
    { x: 5000, y: 5000, width: 340, height: 600 });
  check(prevented && overlay.bounds.x === -340 && overlay.bounds.y === 380, 'drag stays inside game bounds');
  frame = { ...frame, x: 100, y: 50, width: 250, height: 200 };
  trackerCallbacks.onFrame(frame);
  check(overlay.bounds.x === 100 && overlay.bounds.y === 50 && overlay.bounds.width === 250 && overlay.bounds.height === 200,
    'overlay follows and shrinks to a smaller game window');
  overlay.focused = false;
  trackerCallbacks.onFrame({ ...frame, focused: false });
  check(!overlay.visible, 'Alt+Tab hides overlay');
  trackerCallbacks.onFrame(frame);
  check(overlay.visible && !overlay.focused, 'returning to game restores overlay without stealing focus');
  trackerCallbacks.onFrame({ ...frame, minimized: true });
  check(!overlay.visible, 'minimized game hides overlay');
  trackerCallbacks.onFrame(frame);
  shortcuts['Shift+F2']();
  trackerCallbacks.onFrame(frame);
  check(!overlay.visible, 'explicit toggle off stays off');
  // Open and close several times. Windows may not hand focus back to the game after a hide.
  let opened = 0;
  for (let i = 0; i < 4; i++) {
    trackerCallbacks.onFrame({ ...frame, focused: false });
    shortcuts['Shift+F2']();
    if (overlay.visible) opened++;
    shortcuts['Shift+F2']();
  }
  check(opened === 4, 'overlay opens every time, even when the game did not get focus back (' + opened + '/4)');
  check(overlay.blurred > 0, 'hiding the overlay hands focus back (blur)');
  overlay.focused = true; overlay.emit('close', { preventDefault() {} });
  shortcuts['Shift+F2']();
  check(overlay.visible, 'after Esc (close), Shift+F2 opens it again');
  shortcuts['Shift+F2']();
  trackerCallbacks.onFrame(null);
  check(!overlay.visible, 'game exit hides overlay');
  check(fs.existsSync(path.join(tmp, 'userData', 'overlay-position.json')), 'game-relative drag position is saved');
  overlay.webContents.emit('render-process-gone');
  check(overlay.reloaded === 1, 'a crashed overlay page reloads itself');

  // 4. Settings: env keys count, no key ever leaves main
  const s = await invoke('settings:get');
  check(s.hasElevenLabsKey && s.hasGrokKey && !JSON.stringify(s).includes('test-'), 'settings:get reports keys without exposing them');
  check((await invoke('settings:test', { provider: 'elevenlabs' })).ok, 'ElevenLabs key test works');
  check((await invoke('settings:test', { provider: 'grok' })).ok, 'Grok key test works');

  // 5. Steam scan finds the fake Ren'Py game; switching it on installs the hook
  const games = await invoke('games:list');
  log('games:list ->', JSON.stringify(games));
  check(!games.some((g) => g.engine === 'unity'), 'Unity games wait for their Steam tags before showing');
  await wait(2600); // two SteamSpy lookups, spaced about a second apart
  const changed = events('games:changed').pop();
  const names = changed ? changed[2].map((g) => g.name) : [];
  check(names.includes('Story Unity') && !names.includes('Shooter Unity'),
    'games:changed lists the Unity game tagged Story Rich, not the shooter: ' + JSON.stringify(names));
  check(changed && changed[2].find((g) => g.name === 'Story Unity').support === 'soon', 'it is marked coming soon');
  const demo = games.find((g) => g.appid === '424242');
  check(demo && demo.engine === 'renpy' && demo.support === 'full', 'scan finds the Ren\'Py game in the fake library');
  const on = await invoke('games:setEnabled', { appid: '424242', enabled: true });
  const hook = path.join(game, 'game', 'dubgame.rpy');
  check(on.enabled && on.hookInstalled && fs.existsSync(hook), 'switching the game on copies dubgame.rpy into game/');
  check(fs.readFileSync(hook, 'utf8') === fs.readFileSync(path.join(REPO, 'mod', 'renpy', 'dubgame.rpy'), 'utf8'), 'installed hook is identical to mod/renpy/dubgame.rpy');

  // 6. Act as the game: characters at launch, then lines
  const GAME = 'renpy:Demo VN'; // what the hook sends: engine + the game's folder name
  check(await post('/characters', { engine: 'renpy', game: GAME, characters: [{ speaker: 'Sylvie', samples: ['Hi there!'] }, { speaker: 'Marcus', samples: ['Hm.'] }] }) < 300, 'POST /characters accepted');
  await wait(300);
  const before = sent.length;
  check(await post('/line', { speaker: 'Sylvie', text: 'Hey, you made it!', engine: 'renpy', game: GAME }) < 300, 'POST /line accepted immediately');
  await wait(400);
  const line = events('line:received').pop();
  check(line && line[2].speaker === 'Sylvie', 'line:received sent to the windows');
  const play = sent.slice(before).filter((x) => x[1] === 'audio:play');
  check(play.length === 1 && play[0][0] === 'dub.game', 'audio:play goes to the main window only (once)');
  check(play[0] && Buffer.from(play[0][2].data, 'base64').toString() === 'ID3fakeaudio' && play[0][2].mime, 'audio payload is the ElevenLabs bytes as base64 with a mime type');
  const store = await invoke('voices:get');
  const voices = (store.games[GAME] || {}).voices || {};
  check(voices.Sylvie && voices.Sylvie.source === 'grok', 'Sylvie was cast by Grok: ' + (voices.Sylvie && voices.Sylvie.voice_id));
  check(store.current === GAME && store.games[GAME].name === 'Demo Visual Novel', 'voices are saved under the game, named from the Steam scan: ' + (store.games[GAME] || {}).name);
  let usage = await invoke('usage:get');
  check(usage.session.chars === 'Hey, you made it!'.length && usage.byGame[GAME] === usage.session.chars, 'ElevenLabs characters are counted per game: ' + usage.session.chars);

  // 7. Cache: the same line again does not call ElevenLabs
  const ttsBefore = calls.filter((c) => c.includes('text-to-speech')).length;
  await post('/line', { speaker: 'Sylvie', text: 'Hey, you made it!', engine: 'renpy', game: GAME }); await wait(300);
  check(calls.filter((c) => c.includes('text-to-speech')).length === ttsBefore, 'a repeated line plays from the cache');
  usage = await invoke('usage:get');
  check(usage.session.cached === 1 && usage.session.chars === 'Hey, you made it!'.length, 'a cached line costs nothing');

  // 7. Cast lookup: one Grok search for the game; a full name the game shows maps to the same Sylvie
  await wait(200);
  check(bodies.filter(([u, b]) => u === 'https://api.x.ai/v1/responses' && b.tools).length === 1, 'Grok looks up the game\'s cast once');
  const castFile = path.join(tmp, 'userData', 'cast.json');
  check(fs.existsSync(castFile) && JSON.parse(fs.readFileSync(castFile, 'utf8'))[GAME].characters[0].name === 'Sylvie', 'the cast is saved to userData/cast.json');
  const grokPrompts = bodies.filter(([u, b]) => u === 'https://api.x.ai/v1/responses' && !b.tools).map(([, b]) => b.input[0].content);
  check(grokPrompts.some((t) => /Known about them: female; young adult; Shy artist/.test(t) && /from the game "Demo Visual Novel"/.test(t)),
    'Grok recasts with the game name and the looked-up notes');
  await post('/line', { speaker: 'Sylvie Ray', text: 'It is me, Sylvie.', engine: 'renpy', game: GAME }); await wait(300);
  const castStore = await invoke('voices:get');
  check(!castStore.games[GAME].voices['Sylvie Ray'], 'a full name from the game resolves to the same Sylvie');

  // 7a. Acting: the hook sends the next lines; Grok directs them ahead; the line is then acted
  const grokBefore = bodies.filter(([u, b]) => u === 'https://api.x.ai/v1/responses' && !b.tools).length;
  await post('/line', { speaker: 'Sylvie', text: 'Did you hear that?', engine: 'renpy', game: GAME,
    upcoming: [{ speaker: 'Marcus', text: 'Get behind me.' }] });
  await wait(400);
  check(bodies.filter(([u, b]) => u === 'https://api.x.ai/v1/responses' && !b.tools).length === grokBefore + 1, 'one Grok call directs the coming lines ahead of time');
  const asked = bodies.filter(([u]) => u.includes('text-to-speech')).pop()[1];
  check(asked.previous_text === 'It is me, Sylvie.' && asked.next_text === 'Get behind me.', 'ElevenLabs gets the lines around this one');
  await post('/line', { speaker: 'Marcus', text: 'Get behind me.', engine: 'renpy', game: GAME, upcoming: [] });
  await wait(400);
  const acted = bodies.filter(([u]) => u.includes('text-to-speech')).pop()[1];
  check(acted.text === 'Get behind me.' && acted.voice_settings.stability < 0.4, 'the directed line is acted (scared: less stable)');

  // 7b. A second game with a character of the same name gets its own voice
  await post('/line', { speaker: 'Sylvie', text: 'Different game, same name.', engine: 'renpy', game: 'renpy:Other Game' }); await wait(400);
  const both = await invoke('voices:get');
  check(both.current === 'renpy:Other Game' && both.games['renpy:Other Game'].voices.Sylvie && both.games[GAME].voices.Sylvie, 'a second game keeps its own Sylvie');
  check(events('usage:changed').length > 0, 'usage changes are broadcast to the windows');
  await invoke('usage:setLimit', 5);
  const ttsAtLimit = calls.filter((c) => c.includes('text-to-speech')).length;
  await post('/line', { speaker: 'Sylvie', text: 'Over the monthly limit now.', engine: 'renpy', game: GAME }); await wait(300);
  check(calls.filter((c) => c.includes('text-to-speech')).length === ttsAtLimit, 'over the monthly limit, new lines are not sent to ElevenLabs');
  await invoke('usage:setLimit', 0);

  // 8. UI actions: tune a voice, preview, narration off
  const tuned = await invoke('voices:update', { game: GAME, speaker: 'Sylvie', patch: { speed: 1.15 } });
  check(tuned.locked && tuned.speed === 1.15 && events('voices:changed').length > 0, 'voices:update locks the profile and broadcasts voices:changed');
  const pBefore = events('audio:play').length;
  await invoke('voices:preview', { game: GAME, speaker: 'Sylvie' }); await wait(300);
  check(events('audio:play').length === pBefore + 1, 'Preview plays a clip');
  await invoke('settings:setNarration', false);
  const nBefore = events('audio:play').length;
  await post('/line', { speaker: 'Narrator', text: 'The rain kept falling.', engine: 'renpy' }); await wait(300);
  check(events('audio:play').length === nBefore, 'narration off: narrator lines are not spoken');
  await post('/stop', { engine: 'renpy' }); await wait(100);
  check(events('audio:stop').length > 0, 'POST /stop sends audio:stop');

  // 9. Untrusted senders are refused
  let refused = false;
  try { await handlers['settings:get']({ senderFrame: { url: 'https://evil.example' } }); } catch { refused = true; }
  check(refused, 'IPC from a non-app page is refused');

  // 10. Switching the game off removes the hook
  await invoke('games:setEnabled', { appid: '424242', enabled: false });
  check(!fs.existsSync(hook), 'switching the game off removes dubgame.rpy');

  const statuses = events('app:status').map((x) => x[2].message);
  if (statuses.length) log('app:status messages:', statuses);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL CHECKS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
