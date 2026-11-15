'use strict';
// The voice pipeline: line in -> profile (once per character) -> cached or fresh TTS -> audio out.
// Everything it touches is passed in, so it runs under `node --test` without Electron or a network.
const ttsModule = require('./tts');
const profiler = require('./profiler');
const { applyMood } = require('./moods');
const { isCrowdName } = require('./godot-names');
const { voiceName } = require('./voice-design');

const { effectiveVoiceId } = require('./voices');

const MAX_CUSTOM_PER_GAME = 8; // ElevenLabs voice slots are limited per plan; automatic design stops here
const DESIGN_ATTEMPTS = 3;     // automatic design: transient failures retry this many times per character
const DESIGN_BACKOFF_MS = 30000; // ... waiting attempt * this long

const NARRATOR = 'Narrator';
const UNKNOWN = 'unknown';
const RESTART_GAP_MS = 3000; // a game restart takes longer than this
const SETTLE_MS = 150; // a line the player skips faster than this is never paid for
const CAST_WAIT_MS = 2000; // a line waits this long for Grok's casting, then speaks in a placeholder voice

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
  const castWaitMs = deps.castWaitMs === undefined ? CAST_WAIT_MS : deps.castWaitMs;
  const speaking = new Map(); // cache key -> Promise<audio>: the same line is never bought twice at once
  const gameName = deps.gameName || (() => null);
  const moods = deps.moods || null; // Grok's per-line direction, prepared ahead (main/moods.js)
  const cast = deps.cast || null;   // Grok's cast lookup per game (main/cast.js): names and notes
  const scenes = new Map(); // game -> last few lines, any speaker: context for ElevenLabs and Grok
  const speak = deps.speak || ttsModule.speak;
  const profileOne = deps.profileCharacter || profiler.profileCharacter;
  const profileMany = deps.profileCharacters || profiler.profileCharacters;
  const log = deps.log || (() => {});
  const designer = deps.designer || null; // main/voice-design.js createVoiceDesigner(...); experimental
  const designing = new Map(); // key -> Promise<profile>: one custom-voice design per character at a time
  // Automatic design (Custom voices on): one background queue, one design at a time, never awaited by a line.
  const pending = new Map();   // key -> {game, speaker, notBefore}
  const attempts = new Map();  // key -> failed tries; at DESIGN_ATTEMPTS the character keeps its preset this session
  const lineCount = new Map(); // key -> lines voiced this session (priority)
  const backoffMs = deps.designBackoffMs === undefined ? DESIGN_BACKOFF_MS : deps.designBackoffMs;
  let hardStop = null;         // message of the failure that stopped automatic design for the session
  let pump = null;             // Promise of the running queue loop
  let wake = null;             // timer for the next backed-off job
  let lastSpeaker = null;      // key of the newest voiced line
  const customOn = () => typeof settings.customVoices === 'function' && settings.customVoices() === true;
  // The profile with the voice that plays now (preset or designed); sliders are shared.
  const withEffectiveVoice = (p) => (p ? { ...p, voice_id: effectiveVoiceId(p, customOn()) } : p);

  let generation = 0;        // bumped by every line/stop/preview: only the newest may play
  let lastLineSeq;           // seq of the newest line from the hook, when it sends one
  let lastLineAt = 0;
  const now = deps.now || Date.now;
  // Keyed by game + speaker, so two games' "Mom" never share a voice or samples.
  const inFlight = new Map(); // key -> Promise<profile>
  const attempted = new Set(); // keys Grok was already asked about this session
  const recent = new Map();  // key -> last few lines, used as samples
  const lastStatus = new Map();
  const keyOf = (game, speaker) => game + '\u0000' + speaker;
  const gameOf = (x) => String((x && x.game) || store.current() || 'unknown');

  // Display name, or the folder part of "renpy:<folder>" when the Steam scan does not know it.
  const titleOf = (game) => gameName(game) || String(game).split(':').slice(1).join(':') || '';
  const nameIn = (game, speaker) => (cast ? cast.resolve(game, speaker) : speaker);
  // What Grok gets about a character: the game it is from and, when looked up, what it is like.
  const describe = (game, c) => {
    const out = { ...c };
    const title = titleOf(game);
    const notes = cast ? cast.notes(game, c.speaker) : '';
    if (title) out.game = title;
    if (notes) out.notes = notes;
    if (cast) {
      const setting = cast.setting(game);
      const d = cast.detail(game, c.speaker);
      if (setting) out.setting = setting;
      if (d.origin) out.origin = d.origin;
      if (d.speech) out.speech = d.speech;
    }
    return out;
  };

  function activate(game) {
    store.setCurrent(game, gameName(game));
    const voices = store.forGame(game);
    if (cast) cast.ensure(game, titleOf(game), Object.keys(voices.all()));
    return voices;
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
    // Narration and unknown speakers get one calm voice; Grok is not asked.
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
    // A placeholder is upgraded once, as soon as a Grok key is available.
    return existing.source === 'fallback' && !!settings.getKey('grok') &&
      !attempted.has(keyOf(voices.game, speaker));
  }

  async function ensureProfile(voices, speaker, samples) {
    if (!needsProfile(voices, speaker)) return voices.get(speaker);
    const k = keyOf(voices.game, speaker);
    if (inFlight.has(k)) return inFlight.get(k);
    const work = (async () => {
      if (speaker === NARRATOR || speaker === UNKNOWN) return voices.setAuto(builtinProfile(speaker));
      const key = settings.getKey('grok');
      if (!key) {
        status('warn', 'No Grok key: characters get placeholder voices. Add one in Settings.');
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'no Grok key'));
      }
      attempted.add(k);
      try {
        if (usage) usage.recordAI();
        const asked = describe(voices.game, { speaker, samples });
        const profile = await profileOne(asked, catalog, key);
        log(`profiled ${speaker} -> ${profile.voice_id}`);
        return voices.setAuto({ ...profile, cast: !!asked.notes, researched: !!asked.setting }); // cast: picked with looked-up notes
      } catch (e) {
        status('error', e.message);
        return voices.get(speaker) || voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'Grok error'));
      }
    })();
    inFlight.set(k, work);
    try { return await work; } finally { inFlight.delete(k); }
  }

  const ttsParams = (profile, text) => ({
    text, voice_id: profile.voice_id, stability: profile.stability, style: profile.style,
    speed: profile.speed,
    model: settings.quality && settings.quality() === 'best' ? ttsModule.BEST_MODEL : ttsModule.MODEL,
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

  // volume is playback-only (never in the cache key); the renderer applies it.
  const play = (speaker, text, audio, profile) =>
    emit('audio:play', { speaker, text, mime: ttsModule.MIME, data: audio.toString('base64'),
      volume: profile && Number.isFinite(profile.volume) ? Math.min(1, Math.max(0, profile.volume)) : 1 });

  // Design (or redo) one character's custom voice. The preset and the lock are never touched.
  async function designVoice(g, speaker) {
    const voices = store.forGame(g);
    const existing = voices.get(speaker);
    if (!existing) throw new Error('Unknown character: ' + speaker);
    if (!designer) throw new Error('Custom voices are not available.');
    const k = keyOf(g, speaker);
    if (designing.has(k)) return designing.get(k);
    if (!existing.custom_voice && voices.customCount() >= MAX_CUSTOM_PER_GAME) {
      throw new Error(`This game already has ${MAX_CUSTOM_PER_GAME} custom voices (ElevenLabs limits voice slots). Delete some on ElevenLabs and pick catalog voices instead.`);
    }
    const work = (async () => {
      const grokKey = settings.getKey('grok');
      const asked = describe(g, { ...existing, samples: samplesOf(g, speaker) });
      if (grokKey && usage) usage.recordAI();
      const { description } = grokKey
        ? await profiler.voiceDescription(asked, asked.notes, asked.setting, grokKey, { fetch: deps.fetch })
        : { description: profiler.fallbackVoiceDescription(asked) };
      // Names stay out of the prompt: the voice is described, never identified.
      const made = await designer.design({ description, name: voiceName(titleOf(g), speaker), avoid: [speaker, titleOf(g)] });
      return voices.setCustom(speaker, { voice_id: made.voice_id, name: made.name, description: made.description || description });
    })();
    designing.set(k, work);
    try { return await work; } finally { designing.delete(k); }
  }

  function wantsDesign(game, speaker) {
    const voices = store.forGame(game);
    const p = voices.get(speaker);
    return !!p && !p.custom_voice && !p.muted && speaker !== NARRATOR && speaker !== UNKNOWN &&
      voices.customCount() < MAX_CUSTOM_PER_GAME;
  }

  /** Queue a character for automatic design (no-op unless the setting is on and it needs one). */
  function enqueueDesign(game, speaker) {
    const k = keyOf(game, speaker);
    if (!designer || !customOn() || hardStop || pending.has(k) || designing.has(k) ||
        (attempts.get(k) || 0) >= DESIGN_ATTEMPTS || !settings.getKey('elevenlabs') || !wantsDesign(game, speaker)) return;
    pending.set(k, { game, speaker, notBefore: 0 });
    startPump();
  }

  function nextJob() {
    const t = now();
    let best = null, bestScore = -1;
    for (const [k, j] of pending) {
      if (j.notBefore > t) continue;
      const score = k === lastSpeaker ? Infinity : (lineCount.get(k) || 0);
      if (score > bestScore) { best = [k, j]; bestScore = score; }
    }
    return best;
  }

  function startPump() {
    if (pump) return;
    pump = (async () => {
      await null; // never finish before `pump` is assigned (the finally below clears it)
      try {
        for (;;) {
          if (!customOn() || hardStop) { pending.clear(); return; }
          const job = nextJob();
          if (!job) {
            if (pending.size && !wake) { // everything left is backing off: wake for the earliest
              const at = Math.min(...[...pending.values()].map((j) => j.notBefore));
              wake = setTimeout(() => { wake = null; startPump(); }, Math.max(1, at - now()));
              if (wake.unref) wake.unref();
            }
            return;
          }
          const [k, j] = job;
          pending.delete(k);
          if (!wantsDesign(j.game, j.speaker)) continue; // muted, capped or designed meanwhile
          try {
            await designVoice(j.game, j.speaker);
          } catch (e) {
            if (e && e.hard) {
              hardStop = e.message;
              pending.clear();
              status('error', `${e.message} Automatic custom voices are paused until you turn Custom voices off and on again; preset voices are used.`);
              return;
            }
            const n = (attempts.get(k) || 0) + 1;
            attempts.set(k, n);
            log(`custom voice for ${j.speaker} failed (${n}/${DESIGN_ATTEMPTS}): ${e && e.message}`);
            if (n < DESIGN_ATTEMPTS) pending.set(k, { ...j, notBefore: now() + backoffMs * n });
          }
        }
      } finally { pump = null; }
    })();
  }

  return {
    /** The Custom voices setting changed: off clears the queue; on starts fresh (a new key may have been added). */
    customVoicesChanged(on) {
      pending.clear();
      if (wake) { clearTimeout(wake); wake = null; }
      if (on === true) {
        hardStop = null;
        attempts.clear();
        const g = store.current();
        if (g) for (const [name, p] of Object.entries(store.forGame(g).all())) if (p.spoken) enqueueDesign(g, name);
      }
    },
    /** Resolves when the automatic design queue is idle (tests). */
    designIdle: async () => { while (pump) await pump; },

    /** POST /line */
    async handleLine(line) {
      const text = line.text;
      const game = gameOf(line);
      const heard = line.speaker || NARRATOR;
      // A line older than the newest one (it overtook it on the way here) is dropped. A lower seq
      // after a pause means the game was restarted and counts from 1 again, so it is accepted.
      if (line.seq !== undefined && lastLineSeq !== undefined && line.seq <= lastLineSeq &&
          now() - lastLineAt < RESTART_GAP_MS) return;
      const mine = ++generation;
      if (line.seq !== undefined) { lastLineSeq = line.seq; lastLineAt = now(); }
      const voices = activate(game);
      // Cast aliases first, then the offline same-person rule (Mark / MarkBorja / MarkSprite).
      const resolved = nameIn(game, heard);
      const speaker = voices.canonical(resolved);
      // Godot names come from scene nodes: a crowd or UI label that never matched a known character
      // is not a speaker. A known (or cast-resolved) name is kept even if it holds a crowd word.
      if (line.engine === 'godot' && resolved === heard && !voices.has(speaker) && isCrowdName(heard)) return;
      if (line.upcoming) {
        line = { ...line, upcoming: line.upcoming.map((u) => ({ ...u, speaker: voices.canonical(nameIn(game, u.speaker)) })) };
      }
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
        const casting = needsProfile(voices, speaker);
        const profiled = ensureProfile(voices, speaker, samplesOf(game, speaker));
        // Slow casting must not silence a character (Grok may take 20 s to fail): the placeholder
        // is saved, so her next lines speak at once, and Grok's answer replaces it when it lands.
        const base = await (!casting ? profiled : Promise.race([profiled, new Promise((resolve) => {
          const timer = setTimeout(() => resolve(voices.get(speaker) ||
            voices.setAuto(profiler.fallbackProfile(speaker, catalog, 'Grok is slow'))), castWaitMs);
          if (timer.unref) timer.unref();
        })]));
        voices.markSpoken(speaker);
        if (base && base.muted) { emit('audio:stop'); return; } // muted in the overlay: free
        const k = keyOf(game, speaker);
        lineCount.set(k, (lineCount.get(k) || 0) + 1);
        lastSpeaker = k;
        enqueueDesign(game, speaker); // background; this line speaks with whatever voice exists now
        const effective = withEffectiveVoice(base);
        const profile = moods ? applyMood(effective, moods.get(game, speaker, text)) : effective;
        // Lines already on disk play at once. A new line waits a moment: if the player has
        // clicked past it by then, it is never sent to ElevenLabs.
        if (settleMs && !cache.get(ttsParams(profile, text))) {
          await new Promise((r) => setTimeout(r, settleMs));
          if (mine !== generation) return;
        }
        const next = line.upcoming && line.upcoming[0] ? line.upcoming[0].text : '';
        const audio = await synthesize(profile, text, game, { previous_text: previous, next_text: next });
        if (mine === generation) play(speaker, text, audio, profile); // newest line wins
      } catch (e) {
        status('error', e.message);
      }
    },

    /** POST /characters: profile the whole cast before the first line. */
    async handleCharacters(payload = {}) {
      const game = gameOf(payload);
      const voices = activate(game);
      // The same person under two names ("MARK", "Mark Borja") is one character.
      const merged = new Map();
      for (const c of payload.characters || []) {
        const speaker = voices.canonical(nameIn(game, c.speaker));
        const prev = merged.get(speaker);
        merged.set(speaker, { speaker, samples: [...(prev ? prev.samples : []), ...(c.samples || [])] });
      }
      const characters = [...merged.values()];
      for (const c of characters || []) for (const s of c.samples || []) remember(game, c.speaker, s);
      // Godot names come from scanning the screen and include crowd/UI labels: only remember their
      // samples. An entry (and a Grok call) is made when the character actually speaks (handleLine).
      if (payload.engine === 'godot') return;
      const todo = (characters || []).filter((c) =>
        c.speaker !== NARRATOR && c.speaker !== UNKNOWN && needsProfile(voices, c.speaker) &&
        !inFlight.has(keyOf(game, c.speaker)));
      if (!todo.length) return;
      const key = settings.getKey('grok');
      if (!key) {
        status('warn', 'No Grok key: characters get placeholder voices. Add one in Settings.');
        for (const c of todo) {
          if (!voices.has(c.speaker)) voices.setAuto(profiler.fallbackProfile(c.speaker, catalog, 'no Grok key'));
        }
        return;
      }
      for (const c of todo) attempted.add(keyOf(game, c.speaker));
      const asked = todo.map((c) => describe(game, c));
      const withNotes = new Set(asked.filter((c) => c.notes).map((c) => c.speaker));
      const withSetting = new Set(asked.filter((c) => c.setting).map((c) => c.speaker));
      const batch = (async () => {
        try {
          if (usage) usage.recordAI();
          return await profileMany(asked, catalog, key);
        } catch (e) { status('error', e.message); return []; }
      })();
      // Lines that arrive while the batch is running wait for it instead of asking Grok again.
      const each = todo.map((c) => {
        const p = batch.then((profiles) => {
          const found = profiles.find((x) => x.speaker === c.speaker);
          if (found) return voices.setAuto({ ...found, cast: withNotes.has(c.speaker), researched: withSetting.has(c.speaker) });
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
      const profile = withEffectiveVoice(store.forGame(g).get(speaker));
      if (!profile) throw new Error('Unknown character: ' + speaker);
      const mine = ++generation;
      const sample = (typeof text === 'string' && text.trim()) ||
        samplesOf(g, speaker)[0] ||
        (speaker === NARRATOR ? 'The rain had not stopped since morning.' : `Hi, I'm ${speaker}. This is how I sound.`);
      const audio = await synthesize(profile, sample, g);
      if (mine === generation) play(speaker, sample, audio, profile);
      return true;
    },

    /** voices:reroll: ask Grok again (the player asked, so a lock is released). */
    async reroll({ game, speaker } = {}) {
      const g = gameOf({ game });
      const voices = store.forGame(g);
      const existing = voices.get(speaker);
      if (!existing) throw new Error('Unknown character: ' + speaker);
      const key = settings.getKey('grok');
      if (!key) throw new Error('Re-roll needs a Grok key. Add one in Settings.');
      if (usage) usage.recordAI();
      const profile = await profileOne(describe(g, { speaker, samples: samplesOf(g, speaker) }), catalog, key,
        { avoidVoiceId: existing.voice_id })
        .catch((e) => { throw new Error(`No new voice was picked; ${speaker} keeps the current one. ${e.message}`); });
      attempted.add(keyOf(g, speaker));
      voices.unlock(speaker);
      return voices.setAuto(profile);
    },

    /**
     * EXPERIMENTAL: design a custom ElevenLabs voice for one character (Grok writes the description).
     * On any failure the profile is untouched. One call per character at a time.
     */
    async customizeVoice({ game, speaker } = {}) {
      const out = await designVoice(gameOf({ game }), speaker);
      hardStop = null; // a manual success proves the key works again
      return out;
    },

    /**
     * The cast lookup for `game` just finished: recast the voices Grok picked without it, in one
     * batch. Voices the player set (locked) and built-in narrator voices are left alone.
     */
    async recast(game) {
      const voices = store.forGame(game);
      // Casting that started before the lookup finished must land first, or it would be skipped.
      const prefix = game + '\u0000';
      await Promise.all([...inFlight].filter(([k]) => k.startsWith(prefix)).map(([, w]) => w.catch(() => {})));
      const key = settings.getKey('grok');
      const all = voices.all();
      const todo = Object.values(all).filter((p) => !p.locked && (!p.cast || (!p.researched && cast && cast.setting(game))) && p.source !== 'builtin' &&
        p.speaker !== NARRATOR && p.speaker !== UNKNOWN)
        .map((p) => describe(game, { speaker: p.speaker, samples: samplesOf(game, p.speaker) }));
      if (!key || !todo.length) return 0;
      if (usage) usage.recordAI();
      let profiles = [];
      try { profiles = await profileMany(todo, catalog, key); } catch (e) { status('error', e.message); return 0; }
      for (const p of profiles) voices.setAuto({ ...p, cast: true, researched: !!cast.setting(game) });
      log(`recast ${profiles.length} character(s) of ${game} with the looked-up cast`);
      return profiles.length;
    },

    /** Kept for callers of the old API: handleCharacters now seeds samples itself. */
    seedSamples() {},
  };
}

module.exports = { createPipeline, MAX_CUSTOM_PER_GAME, NARRATOR, UNKNOWN };
