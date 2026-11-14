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
    { appid: 'folder:the-question', name: 'The Question', installDir: 'C:/Games/the_question',
      engine: 'renpy', support: 'full', enabled: false, hookInstalled: false, coverUrl: '' },
    { appid: '1574820', name: 'Until Then', installDir: 'C:/Steam/common/Until Then',
      engine: 'godot', support: 'soon', enabled: false, hookInstalled: false, coverUrl: cover('1574820') },
    { appid: '1150690', name: 'OMORI', installDir: 'C:/Steam/common/OMORI',
      engine: 'rpgmaker-mv', support: 'soon', enabled: false, hookInstalled: false, coverUrl: cover('1150690') },
    { appid: '1407200', name: 'MECCHA CHAMELEON', installDir: 'C:/Steam/common/MECCHA CHAMELEON',
      engine: 'unity', support: 'soon', enabled: false, hookInstalled: false, coverUrl: cover('1407200') },
  ];
  const catalog = [
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'calm young woman, American' },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'soft, warm young woman, American' },
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'deep, steady adult man, American' },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'warm older man, British' },
  ];
  const voices = {
    Sylvie: { speaker: 'Sylvie', gender: 'female', age_range: 'young_adult', personality: 'Gentle and shy childhood friend.',
      voice_id: 'EXAVITQu4vr4xnSDxMaL', stability: 0.5, style: 0.3, speed: 1.0, reason: 'Soft, warm voice fits her.', locked: false },
    Marcus: { speaker: 'Marcus', gender: 'male', age_range: 'adult', personality: 'Dry, tired detective who has seen it all.',
      voice_id: 'pNInz6obpgDQGcFmaJgB', stability: 0.7, style: 0.15, speed: 0.95, reason: 'Low and steady.', locked: true },
    Narrator: { speaker: 'Narrator', gender: 'neutral', age_range: 'adult', personality: '',
      voice_id: 'JBFqnCBsd6RMkjVDRZzb', stability: 0.6, style: 0.1, speed: 1.0, reason: 'One calm voice for narration.', locked: false },
  };
  let settings = { hasElevenLabsKey: false, hasGeminiKey: false, narration: true, clipboardMode: false };
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
    'games:launch': (a) => { game(a); return true; },
    'voices:get': () => copy(voices),
    'voices:catalog': () => copy(catalog),
    'voices:update': (a) => {
      voices[a.speaker] = { ...voices[a.speaker], ...a.patch, locked: true };
      emit('voices:changed', copy(voices));
      return copy(voices[a.speaker]);
    },
    'voices:reroll': async (a) => {
      await wait(700);
      const pick = catalog[Math.floor(Math.random() * catalog.length)];
      voices[a.speaker] = { ...voices[a.speaker], voice_id: pick.voice_id, locked: false, reason: 'Re-rolled.' };
      emit('voices:changed', copy(voices));
      return copy(voices[a.speaker]);
    },
    'voices:preview': async () => { await wait(300); return true; },
    'settings:get': () => copy(settings),
    'settings:setKeys': (a) => {
      if (typeof a.elevenlabs === 'string') settings.hasElevenLabsKey = !!a.elevenlabs.trim();
      if (typeof a.gemini === 'string') settings.hasGeminiKey = !!a.gemini.trim();
      return copy(settings);
    },
    'settings:test': async (a) => {
      await wait(500);
      const has = a.provider === 'elevenlabs' ? settings.hasElevenLabsKey : settings.hasGeminiKey;
      return has ? { ok: true } : { ok: false, error: 'No key saved yet.' };
    },
    'settings:setNarration': (a) => { settings.narration = a === true; return copy(settings); },
    'settings:setClipboardMode': (a) => { settings.clipboardMode = a === true; return copy(settings); },
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
  setInterval(() => emit('line:received', { ...script[i++ % script.length], engine: 'renpy' }), 5000);
})();
