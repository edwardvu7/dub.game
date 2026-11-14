'use strict';
// The voice pipeline: line in -> profile (once per character) -> cached or fresh TTS -> audio out.
// Everything it touches is passed in, so it runs under `node --test` without Electron or a network.
const ttsModule = require('./tts');
const profiler = require('./profiler');

const NARRATOR = 'Narrator';
const UNKNOWN = 'unknown';
const RESTART_GAP_MS = 3000; // a game restart takes longer than this

/**
 * createPipeline({voices, settings, catalog, cache, emit, speak?, profileCharacter?,
 *                 profileCharacters?, log?})
 * emit(channel, payload) forwards to the renderer windows (audio:play, line:received, ...).
 */
function createPipeline(deps) {
  const { voices, settings, catalog, cache, emit } = deps;
  const speak = deps.speak || ttsModule.speak;
  const profileOne = deps.profileCharacter || profiler.profileCharacter;
  const profileMany = deps.profileCharacters || profiler.profileCharacters;
  const log = deps.log || (() => {});

  let generation = 0;        // bumped by every line/stop/preview: only the newest may play
  let lastLineSeq;           // seq of the newest line from the hook, when it sends one
  let lastLineAt = 0;
  const now = deps.now || Date.now;
  const inFlight = new Map(); // speaker -> Promise<profile>
  const attempted = new Set(); // speakers Gemini was already asked about this session
  const recent = new Map();  // speaker -> last few lines, used as samples
  const lastStatus = new Map();

  function status(level, message) {
    const now = Date.now();
    if (lastStatus.get(message) > now - 10000) return; // do not repeat the same toast every line
    lastStatus.set(message, now);
    log(`${level}: ${message}`);
    emit('app:status', { level, message });
  }

  function remember(speaker, text) {
    const list = recent.get(speaker) || [];
    if (!list.includes(text)) list.push(text);
    while (list.length > 6) list.shift();
    recent.set(speaker, list);
  }

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

  function needsProfile(speaker) {
    const existing = voices.get(speaker);
    if (!existing) return true;
    if (existing.locked) return false;
    // A placeholder is upgraded once, as soon as a Gemini key is available.
    return existing.source === 'fallback' && !!settings.getKey('gemini') && !attempted.has(speaker);
  }

  async function ensureProfile(speaker, samples) {
    if (!needsProfile(speaker)) return voices.get(speaker);
    if (inFlight.has(speaker)) return inFlight.get(speaker);
    const work = (async () => {
      if (speaker === NARRATOR || speaker === UNKNOWN) return voices.setAuto(builtinProfile(speaker));
      const key = settings.getKey('gemini');
      if (!key) {
        status('warn', 'No Gemini key: characters get placeholder voices. Add one in Settings.');
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'no Gemini key'));
      }
      attempted.add(speaker);
      try {
        const profile = await profileOne({ speaker, samples }, catalog, key);
        log(`profiled ${speaker} -> ${profile.voice_id}`);
        return voices.setAuto(profile);
      } catch (e) {
        status('error', e.message);
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'Gemini error'));
      }
    })();
    inFlight.set(speaker, work);
    try { return await work; } finally { inFlight.delete(speaker); }
  }

  const ttsParams = (profile, text) => ({
    text, voice_id: profile.voice_id, stability: profile.stability, style: profile.style,
    speed: profile.speed, model: ttsModule.MODEL,
  });

  async function synthesize(profile, text) {
    const params = ttsParams(profile, text);
    const cached = cache.get(params);
    if (cached) return cached;
    const key = settings.getKey('elevenlabs');
    if (!key) throw new Error('No ElevenLabs key: lines are received but not spoken. Add one in Settings.');
    const audio = await speak(params, key);
    cache.put(params, audio);
    return audio;
  }

  const play = (speaker, text, audio) =>
    emit('audio:play', { speaker, text, mime: ttsModule.MIME, data: audio.toString('base64') });

  return {
    /** POST /line */
    async handleLine(line) {
      const speaker = line.speaker || NARRATOR;
      const text = line.text;
      // A line older than the newest one (it overtook it on the way here) is dropped. A lower seq
      // after a pause means the game was restarted and counts from 1 again, so it is accepted.
      if (line.seq !== undefined && lastLineSeq !== undefined && line.seq <= lastLineSeq &&
          now() - lastLineAt < RESTART_GAP_MS) return;
      const mine = ++generation;
      if (line.seq !== undefined) { lastLineSeq = line.seq; lastLineAt = now(); }
      emit('line:received', { speaker, text, engine: line.engine || 'renpy' });
      if (speaker === NARRATOR && !settings.narration()) {
        emit('audio:stop'); // the previous character must not keep talking over silent narration
        return;
      }
      remember(speaker, text);
      try {
        const profile = await ensureProfile(speaker, (recent.get(speaker) || []).slice());
        const audio = await synthesize(profile, text);
        if (mine === generation) play(speaker, text, audio); // newest line wins
      } catch (e) {
        status('error', e.message);
      }
    },

    /** POST /characters: profile the whole cast before the first line. */
    async handleCharacters({ characters }) {
      const todo = (characters || []).filter((c) =>
        c.speaker !== NARRATOR && c.speaker !== UNKNOWN && needsProfile(c.speaker) && !inFlight.has(c.speaker));
      if (!todo.length) return;
      const key = settings.getKey('gemini');
      if (!key) {
        status('warn', 'No Gemini key: characters get placeholder voices. Add one in Settings.');
        for (const c of todo) {
          if (!voices.has(c.speaker)) voices.setAuto(profiler.fallbackProfile(c.speaker, catalog, 'no Gemini key'));
        }
        return;
      }
      for (const c of todo) attempted.add(c.speaker);
      const batch = (async () => {
        try { return await profileMany(todo, catalog, key); } catch (e) { status('error', e.message); return []; }
      })();
      // Lines that arrive while the batch is running wait for it instead of asking Gemini again.
      const each = todo.map((c) => {
        const p = batch.then((profiles) => {
          const found = profiles.find((x) => x.speaker === c.speaker);
          if (found) return voices.setAuto(found);
          return voices.get(c.speaker) || voices.setAuto(profiler.fallbackProfile(c.speaker, catalog, 'not profiled'));
        });
        inFlight.set(c.speaker, p);
        return p.finally(() => inFlight.delete(c.speaker));
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
    async preview({ speaker, text } = {}) {
      const profile = voices.get(speaker);
      if (!profile) throw new Error('Unknown character: ' + speaker);
      const mine = ++generation;
      const sample = (typeof text === 'string' && text.trim()) ||
        (recent.get(speaker) || [])[0] ||
        (speaker === NARRATOR ? 'The rain had not stopped since morning.' : `Hi, I'm ${speaker}. This is how I sound.`);
      const audio = await synthesize(profile, sample);
      if (mine === generation) play(speaker, sample, audio);
      return true;
    },

    /** voices:reroll: ask Gemini again (the player asked, so a lock is released). */
    async reroll({ speaker } = {}) {
      const existing = voices.get(speaker);
      if (!existing) throw new Error('Unknown character: ' + speaker);
      const key = settings.getKey('gemini');
      if (!key) throw new Error('Re-roll needs a Gemini key. Add one in Settings.');
      const profile = await profileOne({ speaker, samples: (recent.get(speaker) || []).slice() }, catalog, key,
        { avoidVoiceId: existing.voice_id });
      attempted.add(speaker);
      voices.unlock(speaker);
      return voices.setAuto(profile);
    },

    /** Lets /characters samples seed previews and re-rolls. */
    seedSamples(characters) {
      for (const c of characters || []) for (const s of c.samples || []) remember(c.speaker, s);
    },
  };
}

module.exports = { createPipeline, NARRATOR, UNKNOWN };
