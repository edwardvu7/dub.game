// Stand-in for window.dub (see CLAUDE.md IPC table and main/preload.js) so the UI runs in a plain
// browser with no main process. Inside Electron the preload defines window.dub first and this
// file does nothing.
(function () {
  if (window.dub) return;
  const listeners = {};
  const emit = (ch, p) => (listeners[ch] || []).slice().forEach((f) => f(p));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cover = (id) => 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + id + '/header.jpg';

  const games = [
    { appid: '698780', name: 'Doki Doki Literature Club!', installDir: 'C:/Steam/common/Doki Doki Literature Club',
      engine: 'renpy', support: 'full', enabled: true, hookInstalled: true, coverUrl: cover('698780') },
    { appid: '1895350', name: 'I Wani Hug that Gator!', installDir: 'C:/Steam/common/Gator',
      engine: 'renpy', support: 'full', enabled: true, hookInstalled: false, coverUrl: cover('1895350') },
    { appid: '1421250', name: 'Tiny Bunny', installDir: 'C:/Steam/common/Tiny Bunny',
      engine: 'renpy', support: 'full', enabled: false, hookInstalled: false, coverUrl: cover('1421250') },
    { appid: 'folder:the-question', name: 'The Question', installDir: 'C:/Games/The Question',
      engine: 'renpy', support: 'full', enabled: false, hookInstalled: false, coverUrl: '' },
    { appid: '1574820', name: 'Until Then', installDir: 'C:/Steam/common/Until Then',
      engine: 'godot', support: 'soon', enabled: false, hookInstalled: false, coverUrl: cover('1574820') },
    { appid: '1150690', name: 'OMORI', installDir: 'C:/Steam/common/OMORI',
      engine: 'rpgmaker-mv', support: 'full', enabled: false, hookInstalled: false, coverUrl: cover('1150690') },
    { appid: '1407200', name: 'MECCHA CHAMELEON', installDir: 'C:/Steam/common/MECCHA CHAMELEON',
      engine: 'unity', support: 'soon', enabled: false, hookInstalled: false, coverUrl: cover('1407200') },
  ];
  const catalog = [
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'calm young woman, American' },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'soft, warm young woman, American' },
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'deep, steady adult man, American' },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'warm older man, British' },
  ];
  const cast = {
    Sylvie: { speaker: 'Sylvie', gender: 'female', age_range: 'young_adult', personality: 'Gentle and shy childhood friend.',
      voice_id: 'EXAVITQu4vr4xnSDxMaL', stability: 0.5, style: 0.3, speed: 1.0, reason: 'Soft, warm voice fits her.', locked: false },
    Marcus: { speaker: 'Marcus', gender: 'male', age_range: 'adult', personality: 'Dry, tired detective who has seen it all.',
      voice_id: 'pNInz6obpgDQGcFmaJgB', stability: 0.7, style: 0.15, speed: 0.95, reason: 'Low and steady.', locked: true },
    Narrator: { speaker: 'Narrator', gender: 'neutral', age_range: 'adult', personality: '',
      voice_id: 'JBFqnCBsd6RMkjVDRZzb', stability: 0.6, style: 0.1, speed: 1.0, reason: 'One calm voice for narration.', locked: false },
  };
  const store = { current: 'renpy:The Question', games: {
    'renpy:The Question': { name: 'The Question', voices: cast },
    'renpy:DDLC': { name: 'Doki Doki Literature Club', voices: {
      Sayori: { speaker: 'Sayori', gender: 'female', age_range: 'teen', personality: 'Cheerful and clumsy.',
        voice_id: '21m00Tcm4TlvDq8ikWAM', stability: 0.4, style: 0.5, speed: 1.05, reason: 'Bright and quick.', locked: false } } },
  } };
  const voicesOf = (a) => store.games[(a && a.game) || store.current].voices;
  const usage = { session: { chars: 1840, gemini: 2, lines: 31, cached: 6 }, month: '2026-11', monthChars: 12650,
    monthGemini: 9, totalChars: 40210, limit: 0, byGame: {}, overLimit: false };
  let settings = { hasElevenLabsKey: false, hasGeminiKey: false, hasGrokKey: false, narration: true, clipboardMode: false, acting: true };
  const game = (a) => {
    const g = games.find((x) => x.appid === String(a.appid));
    if (!g) throw new Error('Unknown game: ' + a.appid);
    return g;
  };
  const copy = (x) => JSON.parse(JSON.stringify(x));

  const handlers = {
    'games:list': () => copy(games),
    'games:rescan': async () => { await wait(600); return copy(games); },
    'games:addFolder': () => copy(games),
    'games:setEnabled': (a) => {
      const g = game(a);
      if (a.enabled && g.support === 'soon') throw new Error("Voices for " + g.name + " aren't available yet.");
      g.enabled = g.hookInstalled = !!a.enabled;
      return copy(g);
    },
    'games:godotConfig': (a) => { const g = game(a); g.godotConfig = { textPath: a.textPath, speakerPath: a.speakerPath }; return g; },
    'games:launch': (a) => { game(a); return true; },
    'voices:get': () => copy(store),
    'voices:catalog': () => copy(catalog),
    'voices:update': (a) => {
      const voices = voicesOf(a);
      const locks = Object.keys(a.patch || {}).some((k) => k !== 'muted');
      voices[a.speaker] = { ...voices[a.speaker], ...a.patch, locked: voices[a.speaker].locked || locks };
      emit('voices:changed', copy(store));
      return copy(voices[a.speaker]);
    },
    'voices:reroll': async (a) => {
      await wait(700);
      const pick = catalog[Math.floor(Math.random() * catalog.length)];
      const voices = voicesOf(a);
      voices[a.speaker] = { ...voices[a.speaker], voice_id: pick.voice_id, locked: false, reason: 'Re-rolled.' };
      emit('voices:changed', copy(store));
      return copy(voices[a.speaker]);
    },
    'voices:preview': async () => { await wait(300); return true; },
    'voices:clearGame': (a) => {
      delete store.games[a.game];
      if (store.current === a.game) store.current = null;
      emit('voices:changed', copy(store));
      return true;
    },
    'usage:get': () => copy(usage),
    'usage:setLimit': (n) => { usage.limit = Number(n) > 0 ? Math.round(Number(n)) : 0; usage.overLimit = !!usage.limit && usage.monthChars >= usage.limit; return copy(usage); },
    'usage:plan': async () => { await wait(400); return { ok: true, used: 12650, limit: 30000, tier: 'starter', resetAt: Date.parse('2026-12-01') }; },
    'settings:get': () => copy(settings),
    'settings:setKeys': (a) => {
      if (typeof a.elevenlabs === 'string') settings.hasElevenLabsKey = !!a.elevenlabs.trim();
      if (typeof a.gemini === 'string') settings.hasGeminiKey = !!a.gemini.trim();
      if (typeof a.grok === 'string') settings.hasGrokKey = !!a.grok.trim();
      return copy(settings);
    },
    'settings:test': async (a) => {
      await wait(500);
      const has = a.provider === 'elevenlabs' ? settings.hasElevenLabsKey : settings.hasGeminiKey;
      return has ? { ok: true } : { ok: false, error: 'No key saved yet.' };
    },
    'settings:setNarration': (a) => { settings.narration = a === true; return copy(settings); },
    'settings:setClipboardMode': (a) => { settings.clipboardMode = a === true; return copy(settings); },
    'settings:setActing': (a) => { settings.acting = a === true; return copy(settings); },
  };

  window.dub = {
    invoke: async (ch, a) => {
      if (!handlers[ch]) throw new Error('Unknown channel: ' + ch);
      return handlers[ch](a);
    },
    on: (ch, f) => {
      (listeners[ch] = listeners[ch] || []).push(f);
      return () => { listeners[ch] = listeners[ch].filter((x) => x !== f); };
    },
  };
  window.dubFake = { emit }; // lets you fire events by hand from the browser console

  const script = [
    { speaker: 'Sylvie', text: 'Hey, you made it! I was starting to think you forgot.' },
    { speaker: 'Marcus', text: "Nobody forgets. They just hope you will." },
    { speaker: 'Narrator', text: 'The rain had not let up since morning.' },
  ];
  let i = 0;
  setInterval(() => emit('line:received', { ...script[i++ % script.length], engine: 'renpy', game: 'renpy:The Question' }), 5000);
})();
