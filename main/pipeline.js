'use strict';
// The voice pipeline: line in -> profile (once per character) -> cached or fresh TTS -> audio out.
// Everything it touches is passed in, so it runs under `node --test` without Electron or a network.
const ttsModule = require('./tts');
const profiler = require('./profiler');
const { applyMood } = require('./moods');

const NARRATOR = 'Narrator';
const UNKNOWN = 'unknown';
const RESTART_GAP_MS = 3000; // a game restart takes longer than this
const SETTLE_MS = 150; // a line the player skips faster than this is never paid for

/**
 * createPipeline({voices, settings, catalog, cache, emit, usage?, gameName?, speak?,
 *                 profileCharacter?, profileCharacters?, log?})
 * voices is the per-game store (main/voices.js); every line names its game.
 * emit(channel, payload) forwards to the renderer windows (audio:play, line:received, ...).
 * usage (main/usage.js) counts ElevenLabs characters and enforces the monthly limit.
 * gameName(id) turns a game id into a display name (from the Steam scan), or returns null.
 */
function createPipeline(deps) {
  const { voices: store, settings, catalog, cache, emit } = deps;
  const usage = deps.usage || null;
  const settleMs = deps.settleMs === undefined ? SETTLE_MS : deps.settleMs;
  const speaking = new Map(); // cache key -> Promise<audio>: the same line is never bought twice at once
  const gameName = deps.gameName || (() => null);
  const moods = deps.moods || null; // Gemini's per-line direction, prepared ahead (main/moods.js)
  const scenes = new Map(); // game -> last few lines, any speaker: context for ElevenLabs and Gemini
  const speak = deps.speak || ttsModule.speak;
  const profileOne = deps.profileCharacter || profiler.profileCharacter;
  const profileMany = deps.profileCharacters || profiler.profileCharacters;
  const log = deps.log || (() => {});

  let generation = 0;        // bumped by every line/stop/preview: only the newest may play
  let lastLineSeq;           // seq of the newest line from the hook, when it sends one
  let lastLineAt = 0;
  const now = deps.now || Date.now;
  // Keyed by game + speaker, so two games' "Mom" never share a voice or samples.
  const inFlight = new Map(); // key -> Promise<profile>
  const attempted = new Set(); // keys Gemini was already asked about this session
  const recent = new Map();  // key -> last few lines, used as samples
  const lastStatus = new Map();
  const keyOf = (game, speaker) => game + '\u0000' + speaker;
  const gameOf = (x) => String((x && x.game) || store.current() || 'unknown');

  function activate(game) {
    store.setCurrent(game, gameName(game));
    return store.forGame(game);
  }

  function status(level, message) {
    const now = Date.now();
    if (lastStatus.get(message) > now - 10000) return; // do not repeat the same toast every line
    lastStatus.set(message, now);
    log(`${level}: ${message}`);
    emit('app:status', { level, message });
  }

  function remember(game, speaker, text) {
    const k = keyOf(game, speaker);
    const list = recent.get(k) || [];
    if (!list.includes(text)) list.push(text);
    while (list.length > 6) list.shift();
    recent.set(k, list);
  }
  const samplesOf = (game, speaker) => (recent.get(keyOf(game, speaker)) || []).slice();

  function builtinProfile(speaker) {
    // Narration and unknown speakers get one calm voice; Gemini is not asked.
    const voice = catalog.find((v) => /narrator/i.test(v.description)) || catalog[catalog.length - 1];
    return {
      speaker, gender: 'neutral', age_range: 'adult',
      personality: speaker === NARRATOR ? 'Calm narrator.' : 'Speaker not identified by the game.',
      voice_id: voice.voice_id, stability: 0.6, style: 0.1, speed: 1.0,
      reason: speaker === NARRATOR ? 'One calm voice for narration.' : 'Default voice until the speaker is known.',
      locked: false, source: 'builtin',
    };
  }

  function needsProfile(voices, speaker) {
    const existing = voices.get(speaker);
    if (!existing) return true;
    if (existing.locked) return false;
    // A placeholder is upgraded once, as soon as a Gemini key is available.
    return existing.source === 'fallback' && !!settings.getKey('gemini') &&
      !attempted.has(keyOf(voices.game, speaker));
  }

  async function ensureProfile(voices, speaker, samples) {
    if (!needsProfile(voices, speaker)) return voices.get(speaker);
    const k = keyOf(voices.game, speaker);
    if (inFlight.has(k)) return inFlight.get(k);
    const work = (async () => {
      if (speaker === NARRATOR || speaker === UNKNOWN) return voices.setAuto(builtinProfile(speaker));
      const key = settings.getKey('gemini');
      if (!key) {
        status('warn', 'No Gemini key: characters get placeholder voices. Add one in Settings.');
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'no Gemini key'));
      }
      attempted.add(k);
      try {
        if (usage) usage.recordGemini();
        const profile = await profileOne({ speaker, samples }, catalog, key);
        log(`profiled ${speaker} -> ${profile.voice_id}`);
        return voices.setAuto(profile);
      } catch (e) {
        status('error', e.message);
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'Gemini error'));
      }
    })();
    inFlight.set(k, work);
    try { return await work; } finally { inFlight.delete(k); }
  }

  const ttsParams = (profile, text) => ({
    text, voice_id: profile.voice_id, stability: profile.stability, style: profile.style,
    speed: profile.speed, model: ttsModule.MODEL,
  });

  // context: {previous_text, next_text}. It shapes delivery but not the cache key: the same line in
  // the same voice replays from disk.
  async function synthesize(profile, text, game, context = {}) {
    const params = ttsParams(profile, text);
    const cached = cache.get(params);
    if (cached) { if (usage) usage.recordCached(); return cached; }
    const id = cache.key(params);
    if (speaking.has(id)) return speaking.get(id);
    const key = settings.getKey('elevenlabs');
    if (!key) throw new Error('No ElevenLabs key: lines are received but not spoken. Add one in Settings.');
    if (usage && usage.wouldExceed(text.length)) {
      throw new Error('Monthly character limit reached: new lines are not spoken. Raise it in Settings.');
    }
    const work = speak({ ...params, ...context }, key).then((audio) => {
      cache.put(params, audio);
      if (usage) usage.recordSpeech(text.length, game);
      return audio;
    });
    speaking.set(id, work);
    try { return await work; } finally { speaking.delete(id); }
  }

  const play = (speaker, text, audio) =>
    emit('audio:play', { speaker, text, mime: ttsModule.MIME, data: audio.toString('base64') });

  return {
    /** POST /line */
    async handleLine(line) {
      const speaker = line.speaker || NARRATOR;
      const text = line.text;
      const game = gameOf(line);
      // A line older than the newest one (it overtook it on the way here) is dropped. A lower seq
      // after a pause means the game was restarted and counts from 1 again, so it is accepted.
      if (line.seq !== undefined && lastLineSeq !== undefined && line.seq <= lastLineSeq &&
          now() - lastLineAt < RESTART_GAP_MS) return;
      const mine = ++generation;
      if (line.seq !== undefined) { lastLineSeq = line.seq; lastLineAt = now(); }
      const voices = activate(game);
      emit('line:received', { speaker, text, engine: line.engine || 'renpy', game });
      const scene = scenes.get(game) || [];
      const previous = scene.length ? scene[scene.length - 1].text : '';
      scene.push({ speaker, text });
      while (scene.length > 6) scene.shift();
      scenes.set(game, scene);
      // Direct the coming lines now, in the background, so they are ready when reached.
      if (moods && line.upcoming && line.upcoming.length) {
        moods.prepare(game, line.upcoming, scene.slice()).catch(() => {});
      }
      if (speaker === NARRATOR && !settings.narration()) {
        emit('audio:stop'); // the previous character must not keep talking over silent narration
        return;
      }
      remember(game, speaker, text);
      try {
        const base = await ensureProfile(voices, speaker, samplesOf(game, speaker));
        if (base && base.muted) { emit('audio:stop'); return; } // muted in the overlay: free
        const profile = moods ? applyMood(base, moods.get(game, speaker, text)) : base;
        // Lines already on disk play at once. A new line waits a moment: if the player has
        // clicked past it by then, it is never sent to ElevenLabs.
        if (settleMs && !cache.get(ttsParams(profile, text))) {
          await new Promise((r) => setTimeout(r, settleMs));
          if (mine !== generation) return;
        }
        const next = line.upcoming && line.upcoming[0] ? line.upcoming[0].text : '';
        const audio = await synthesize(profile, text, game, { previous_text: previous, next_text: next });
        if (mine === generation) play(speaker, text, audio); // newest line wins
      } catch (e) {
        status('error', e.message);
      }
    },

    /** POST /characters: profile the whole cast before the first line. */
    async handleCharacters(payload = {}) {
      const { characters } = payload;
      const game = gameOf(payload);
      const voices = activate(game);
      for (const c of characters || []) for (const s of c.samples || []) remember(game, c.speaker, s);
      const todo = (characters || []).filter((c) =>
        c.speaker !== NARRATOR && c.speaker !== UNKNOWN && needsProfile(voices, c.speaker) &&
        !inFlight.has(keyOf(game, c.speaker)));
      if (!todo.length) return;
      const key = settings.getKey('gemini');
      if (!key) {
        status('warn', 'No Gemini key: characters get placeholder voices. Add one in Settings.');
        for (const c of todo) {
          if (!voices.has(c.speaker)) voices.setAuto(profiler.fallbackProfile(c.speaker, catalog, 'no Gemini key'));
        }
        return;
      }
      for (const c of todo) attempted.add(keyOf(game, c.speaker));
      const batch = (async () => {
        try {
          if (usage) usage.recordGemini();
          return await profileMany(todo, catalog, key);
        } catch (e) { status('error', e.message); return []; }
      })();
      // Lines that arrive while the batch is running wait for it instead of asking Gemini again.
      const each = todo.map((c) => {
        const p = batch.then((profiles) => {
          const found = profiles.find((x) => x.speaker === c.speaker);
          if (found) return voices.setAuto(found);
          return voices.get(c.speaker) || voices.setAuto(profiler.fallbackProfile(c.speaker, catalog, 'not profiled'));
        });
        inFlight.set(keyOf(game, c.speaker), p);
        return p.finally(() => inFlight.delete(keyOf(game, c.speaker)));
      });
      await Promise.all(each);
      log(`profiled ${todo.length} character(s) at launch`);
    },

    /** POST /stop: the player clicked past the line. Ignored when a newer line already arrived. */
    handleStop(stop = {}) {
      if (stop.seq !== undefined && lastLineSeq !== undefined && stop.seq < lastLineSeq) return;
      generation++;
      emit('audio:stop');
    },

    /** voices:preview */
    async preview({ game, speaker, text } = {}) {
      const g = gameOf({ game });
      const profile = store.forGame(g).get(speaker);
      if (!profile) throw new Error('Unknown character: ' + speaker);
      const mine = ++generation;
      const sample = (typeof text === 'string' && text.trim()) ||
        samplesOf(g, speaker)[0] ||
        (speaker === NARRATOR ? 'The rain had not stopped since morning.' : `Hi, I'm ${speaker}. This is how I sound.`);
      const audio = await synthesize(profile, sample, g);
      if (mine === generation) play(speaker, sample, audio);
      return true;
    },

    /** voices:reroll: ask Gemini again (the player asked, so a lock is released). */
    async reroll({ game, speaker } = {}) {
      const g = gameOf({ game });
      const voices = store.forGame(g);
      const existing = voices.get(speaker);
      if (!existing) throw new Error('Unknown character: ' + speaker);
      const key = settings.getKey('gemini');
      if (!key) throw new Error('Re-roll needs a Gemini key. Add one in Settings.');
      if (usage) usage.recordGemini();
      const profile = await profileOne({ speaker, samples: samplesOf(g, speaker) }, catalog, key,
        { avoidVoiceId: existing.voice_id });
      attempted.add(keyOf(g, speaker));
      voices.unlock(speaker);
      return voices.setAuto(profile);
    },

    /** Kept for callers of the old API: handleCharacters now seeds samples itself. */
    seedSamples() {},
  };
}

module.exports = { createPipeline, NARRATOR, UNKNOWN };
