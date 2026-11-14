// Stand-in for window.dub (see CLAUDE.md IPC table) so the UI can be built before main/ exists.
(function () {
  if (window.dub) return;
  const listeners = {};
  let games = [
    { appid: "1234", name: "Demo Visual Novel", installDir: "C:/Games/Demo VN", engine: "renpy",
      support: "full", enabled: true, hookInstalled: true,
      coverUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/1234/header.jpg" },
    { appid: "5678", name: "Until Then", installDir: "C:/Games/Until Then", engine: "godot",
      support: "beta", enabled: false, hookInstalled: false, coverUrl: "" }
  ];
  const catalog = [
    { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "soft, warm young woman, American" },
    { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", description: "deep, steady adult man, American" }
  ];
  let voices = {
    Sylvie: { speaker: "Sylvie", gender: "female", age_range: "young_adult", personality: "Gentle childhood friend.",
      voice_id: "EXAVITQu4vr4xnSDxMaL", stability: 0.5, style: 0.3, speed: 1.0, reason: "Warm and soft.", locked: false }
  };
  let settings = { hasElevenLabsKey: false, hasGeminiKey: false, narration: true };
  const emit = (ch, p) => (listeners[ch] || []).forEach((f) => f(p));
  window.dub = {
    invoke: async (ch, a) => ({
      "games:list": () => games, "games:rescan": () => games, "games:addFolder": () => games,
      "games:setEnabled": () => { const g = games.find((x) => x.appid === a.appid); g.enabled = g.hookInstalled = a.enabled; return g; },
      "games:launch": () => true, "voices:get": () => voices, "voices:catalog": () => catalog,
      "voices:update": () => { voices[a.speaker] = { ...voices[a.speaker], ...a.patch, locked: true }; emit("voices:changed", voices); return voices[a.speaker]; },
      "voices:reroll": () => voices[a.speaker], "voices:preview": () => true,
      "settings:get": () => settings, "settings:setKeys": () => { settings = { ...settings, hasElevenLabsKey: settings.hasElevenLabsKey || !!a.elevenlabs, hasGeminiKey: settings.hasGeminiKey || !!a.gemini }; return settings; },
      "settings:test": () => ({ ok: true }), "settings:setNarration": () => { settings.narration = a; return settings; }
    })[ch]?.(),
    on: (ch, f) => { (listeners[ch] ||= []).push(f); return () => (listeners[ch] = listeners[ch].filter((x) => x !== f)); }
  };
  setInterval(() => emit("line:received", { speaker: "Sylvie", text: "Hey, you made it!", engine: "renpy" }), 5000);
})();
