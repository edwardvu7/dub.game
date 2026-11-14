// Main window: Games, Voices and Settings tabs, the audio player and the now-playing bar.
// Talks to the main process only through window.dub (see CLAUDE.md).
(function () {
  'use strict';
  const dub = window.dub;
  const L = window.DubLib;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- Toasts ----------
  const toasts = $('toasts');
  function toast(message, tone) {
    // The same error twice in a row (a held key, a retry loop) shows once.
    const last = toasts.lastElementChild;
    if (last && last.dataset.message === message) return;
    const node = el('div', 'toast toast-' + (tone || 'error'), message);
    node.dataset.message = message;
    const close = el('button', 'toast-close', 'Dismiss');
    close.type = 'button';
    close.addEventListener('click', () => node.remove());
    node.append(close);
    toasts.append(node);
    while (toasts.children.length > 4) toasts.firstElementChild.remove();
    if (tone !== 'error') setTimeout(() => node.remove(), 6000);
  }
  const fail = (e) => toast(L.errorText(e), 'error');

  // ---------- Tabs ----------
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const openers = {}; // view name -> function run the first time the view opens
  function showView(name, focus) {
    for (const tab of tabs) {
      const on = tab.dataset.view === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('view-' + tab.dataset.view).hidden = !on;
      if (on && focus) tab.focus();
    }
    if (openers[name]) { openers[name](); delete openers[name]; }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      showView(tabs[(i + step + tabs.length) % tabs.length].dataset.view, true);
    });
  });

  // ---------- Games ----------
  const gamesHost = $('games');
  const gamesEmpty = $('games-empty');
  const search = $('games-search');
  const tiles = new Map(); // appid -> tile, patched in place so a click never loses its target
  const justEnabled = new Set();
  let games = [];

  function buildTile(appid) {
    const root = el('article', 'game');
    const art = el('div', 'game-art');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => { img.hidden = true; });
    const fallback = el('span', 'game-initials');
    const badge = el('span', 'tag game-badge');
    art.append(fallback, img, badge);

    const body = el('div', 'game-body');
    const name = el('h3', 'game-name');
    const hint = el('p', 'game-hint');

    const row = el('div', 'game-row');
    const toggle = el('label', 'switch switch-compact');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const track = el('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    toggle.append(box, track, el('span', 'switch-text', 'Voices'));
    const repair = el('button', 'btn btn-quiet', 'Reinstall');
    repair.type = 'button';
    const launch = el('button', 'btn btn-primary', 'Launch');
    launch.type = 'button';
    launch.title = 'Turns voices on for this game and starts it in a window, so the overlay can show.';
    row.append(toggle, repair, launch);
    body.append(name, hint, row);
    root.append(art, body);

    const tile = { root, img, fallback, badge, name, hint, box, repair, launch, busy: false };

    async function setEnabled(enabled) {
      if (tile.busy) return;
      tile.busy = true;
      root.classList.add('is-busy');
      try {
        const updated = await dub.invoke('games:setEnabled', { appid, enabled });
        if (enabled) justEnabled.add(appid); else justEnabled.delete(appid);
        games = games.map((g) => (g.appid === appid ? updated : g));
      } catch (e) {
        fail(e);
      } finally {
        tile.busy = false;
        root.classList.remove('is-busy');
        renderGames();
      }
    }
    box.addEventListener('change', () => setEnabled(box.checked));
    repair.addEventListener('click', () => setEnabled(true));
    launch.addEventListener('click', async () => {
      if (tile.busy) return;
      launch.disabled = true;
      try {
        // Launch always means "launch with voices": the dub.game script has to be in the game
        // first. It is also what starts the game in borderless fullscreen so the overlay can show.
        const game = games.find((g) => g.appid === appid);
        if (game && game.support === 'soon') return;
        if (!game || L.gameStatus(game) !== 'on') {
          const updated = await dub.invoke('games:setEnabled', { appid, enabled: true });
          games = games.map((g) => (g.appid === appid ? updated : g));
          renderGames();
        }
        await dub.invoke('games:launch', { appid });
        toast('Starting ' + name.textContent + ' in a window, so the overlay can show. Press Shift + F2 in the game to change voices.', 'note');
      } catch (e) {
        fail(e);
      } finally {
        launch.disabled = false;
      }
    });
    return tile;
  }

  function patchTile(tile, game) {
    const status = L.gameStatus(game);
    const badge = L.supportBadge(game);
    const hint = L.gameHint(game, justEnabled.has(game.appid));
    tile.root.dataset.status = status;
    tile.name.textContent = game.name;
    tile.fallback.textContent = L.initials(game.name);
    if (game.coverUrl) {
      if (tile.img.getAttribute('src') !== game.coverUrl) { tile.img.hidden = false; tile.img.src = game.coverUrl; }
    } else {
      tile.img.hidden = true;
      tile.img.removeAttribute('src');
    }
    tile.badge.textContent = badge.text;
    tile.badge.title = badge.title;
    tile.badge.className = 'tag game-badge tag-' + badge.tone;
    tile.hint.textContent = hint.text;
    tile.hint.dataset.tone = hint.tone;
    if (!tile.busy) tile.box.checked = !!game.enabled;
    tile.box.setAttribute('aria-label', 'Voices for ' + game.name);
    tile.repair.hidden = status !== 'missing';
    // Coming-soon engines are listed so players see them, but nothing can be switched on yet.
    tile.box.closest('.switch').hidden = status === 'soon';
    tile.launch.hidden = status === 'soon';
  }

  function renderGames() {
    const shown = L.sortGames(L.filterGames(games, search.value));
    const keep = new Set(shown.map((g) => g.appid));
    for (const [appid, tile] of tiles) {
      if (!keep.has(appid)) { tile.root.remove(); tiles.delete(appid); }
    }
    shown.forEach((game, index) => {
      if (!tiles.has(game.appid)) tiles.set(game.appid, buildTile(game.appid));
      const tile = tiles.get(game.appid);
      patchTile(tile, game);
      if (gamesHost.children[index] !== tile.root) gamesHost.insertBefore(tile.root, gamesHost.children[index] || null);
    });
    search.hidden = games.length < 7; // a filter box is noise for a short list
    gamesEmpty.hidden = games.length > 0;
    gamesHost.hidden = games.length === 0;
    $('games-summary').textContent = games.length && !shown.length
      ? 'No games match "' + search.value.trim() + '".'
      : L.gamesSummary(games);
  }

  async function loadGames(channel, button) {
    const label = button ? button.textContent : '';
    if (button) { button.disabled = true; if (channel === 'games:rescan') button.textContent = 'Scanning'; }
    try {
      const list = await dub.invoke(channel);
      games = Array.isArray(list) ? list : [];
      renderGames();
    } catch (e) {
      fail(e);
      if (!games.length) $('games-summary').textContent = 'The Steam scan failed. Try Rescan, or add a game folder.';
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  }
  $('games-rescan').addEventListener('click', (e) => loadGames('games:rescan', e.currentTarget));
  $('games-add').addEventListener('click', (e) => loadGames('games:addFolder', e.currentTarget));
  $('games-add-empty').addEventListener('click', (e) => loadGames('games:addFolder', e.currentTarget));
  search.addEventListener('input', renderGames);

  // Steam is scanned when the app opens, and again whenever the player comes back to this window
  // (they may have just installed a game), at most once every 20 seconds.
  let lastScan = Date.now();
  let scanning = false;
  window.addEventListener('focus', async () => {
    if (scanning || Date.now() - lastScan < 20000) return;
    if (Array.from(tiles.values()).some((t) => t.busy)) return;
    scanning = true;
    try {
      const list = await dub.invoke('games:rescan');
      if (Array.isArray(list)) { games = list; renderGames(); }
    } catch { /* a background rescan fails quietly; the Rescan button reports errors */ }
    lastScan = Date.now();
    scanning = false;
  });

  // ---------- Voices ----------
  let cards = null;
  let currentSpeaker = null;
  openers.voices = () => {
    cards = window.DubCards.mount($('cards-host'), { dub, onError: (m) => toast(m, 'error') });
    cards.setCurrent(currentSpeaker);
  };

  // ---------- Settings ----------
  const HAS = { elevenlabs: 'hasElevenLabsKey', gemini: 'hasGeminiKey' };
  const keyrows = Array.from(document.querySelectorAll('.keyrow'));
  let settings = null;

  function paintSettings(next) {
    if (next && typeof next === 'object') settings = next;
    if (!settings) return;
    for (const form of keyrows) {
      const has = !!settings[HAS[form.dataset.provider]];
      const state = L.keyState(has);
      const tag = form.querySelector('[data-role="state"]');
      tag.textContent = state.text;
      tag.className = 'tag tag-' + state.tone;
      form.elements.key.placeholder = state.placeholder;
      form.querySelector('[data-role="remove"]').hidden = !has;
      form.querySelector('[data-role="test"]').disabled = !has;
    }
    $('opt-narration').checked = !!settings.narration;
    $('opt-clipboard').checked = !!settings.clipboardMode;
    $('settings-flag').hidden = !L.needsSetup(settings);
  }

  function showResult(form, tone, text) {
    const out = form.querySelector('[data-role="result"]');
    out.textContent = text;
    out.dataset.tone = tone;
  }

  async function testKey(form) {
    const button = form.querySelector('[data-role="test"]');
    button.disabled = true;
    showResult(form, 'wait', 'Testing');
    try {
      const r = await dub.invoke('settings:test', { provider: form.dataset.provider });
      if (r && r.ok) showResult(form, 'ok', 'Works. This service is ready.');
      else showResult(form, 'bad', (r && r.error) || 'The test failed.');
    } catch (e) {
      showResult(form, 'bad', L.errorText(e));
    } finally {
      button.disabled = !settings || !settings[HAS[form.dataset.provider]];
    }
  }

  for (const form of keyrows) {
    const provider = form.dataset.provider;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = form.elements.key.value.trim();
      if (!key) { showResult(form, 'bad', 'Paste a key first.'); form.elements.key.focus(); return; }
      try {
        paintSettings(await dub.invoke('settings:setKeys', { [provider]: key }));
        form.elements.key.value = ''; // the key never stays in the page
        await testKey(form);           // saving without knowing it works helps nobody
      } catch (err) {
        showResult(form, 'bad', L.errorText(err));
      }
    });
    form.querySelector('[data-role="test"]').addEventListener('click', () => testKey(form));
    form.querySelector('[data-role="remove"]').addEventListener('click', async () => {
      try {
        paintSettings(await dub.invoke('settings:setKeys', { [provider]: '' }));
        // A dev key in .env still counts, so say what is true rather than "Removed".
        showResult(form, 'wait', settings[HAS[provider]]
          ? 'Your saved key was removed. A key from the .env file is still in use.'
          : 'Key removed.');
      } catch (err) {
        showResult(form, 'bad', L.errorText(err));
      }
    });
  }

  function bindSwitch(id, channel) {
    const box = $(id);
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        paintSettings(await dub.invoke(channel, box.checked));
      } catch (e) {
        fail(e);
        paintSettings(); // put the switch back where the app really is
      } finally {
        box.disabled = false;
      }
    });
  }
  bindSwitch('opt-narration', 'settings:setNarration');
  bindSwitch('opt-clipboard', 'settings:setClipboardMode');

  // ---------- Audio and the now-playing bar ----------
  const now = $('now');
  const stopButton = $('now-stop');
  const volume = $('volume');
  const audio = new Audio();
  let clipUrl = null;

  function paintVolume() {
    volume.style.setProperty('--fill', (Number(volume.value) * 100) + '%');
  }
  try {
    const saved = Number(localStorage.getItem('dub.volume'));
    if (localStorage.getItem('dub.volume') !== null && Number.isFinite(saved)) volume.value = L.clamp(saved, 0, 1);
  } catch { /* storage is a convenience only */ }
  audio.volume = Number(volume.value);
  paintVolume();
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    paintVolume();
  });
  volume.addEventListener('change', () => {
    try { localStorage.setItem('dub.volume', volume.value); } catch { /* ignore */ }
  });

  function setPlaying(on) {
    now.classList.toggle('is-playing', on);
    stopButton.hidden = !on;
  }
  function stopAudio() {
    audio.pause();
    audio.removeAttribute('src');
    if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null; }
    setPlaying(false);
  }
  audio.addEventListener('ended', stopAudio);
  audio.addEventListener('error', () => { if (clipUrl) stopAudio(); });
  stopButton.addEventListener('click', stopAudio);

  function showLine(line) {
    if (!line) return;
    currentSpeaker = line.speaker || null;
    $('now-speaker').textContent = line.speaker || 'Unknown';
    $('now-line').textContent = line.text || '';
    if (cards) cards.setCurrent(currentSpeaker);
  }

  dub.on('audio:play', (clip) => {
    stopAudio(); // only the newest line ever plays
    if (!clip || !clip.data) return;
    try {
      clipUrl = URL.createObjectURL(new Blob([L.base64ToBytes(clip.data)], { type: clip.mime || 'audio/mpeg' }));
    } catch {
      toast('A line arrived with audio that could not be read.', 'error');
      return;
    }
    showLine(clip);
    audio.src = clipUrl;
    setPlaying(true);
    const mine = clipUrl;
    audio.play().catch((e) => {
      // AbortError just means a newer line replaced this one.
      if (clipUrl === mine && e && e.name !== 'AbortError') { stopAudio(); fail(e); }
    });
  });
  dub.on('audio:stop', stopAudio);
  // A background Steam tag lookup found more story games to list.
  dub.on('games:changed', (list) => {
    if (!Array.isArray(list)) return;
    games = list;
    renderGames();
  });
  dub.on('line:received', showLine);
  dub.on('app:status', (s) => {
    if (s && s.message) toast(s.message, s.level === 'error' ? 'error' : 'note');
  });

  // ---------- Start ----------
  (async () => {
    try {
      paintSettings(await dub.invoke('settings:get'));
    } catch (e) {
      fail(e);
    }
    // Without keys nothing can speak, so first launch starts on Settings.
    if (settings && L.needsSetup(settings)) showView('settings');
    loadGames('games:list');
  })();
})();
