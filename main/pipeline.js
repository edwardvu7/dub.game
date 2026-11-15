'use strict';
// The voice pipeline: line in -> profile (once per character) -> cached or fresh TTS -> audio out.
// Everything it touches is passed in, so it runs under `node --test` without Electron or a network.
const ttsModule = require('./tts');
const profiler = require('./profiler');
const { applyMood } = require('./moods');
const { isCrowdName } = require('./godot-names');
const { voiceName } = require('./voice-design');

const { effectiveVoiceId } = require('./voices');
const { isProtagonistName } = require('./cast');

// ElevenLabs voice slots are limited per plan: each game keeps at most this many designed voices live. When the pool
// is full, a character that matters more takes the slot of the one that matters least (see pickVictim).
const MAX_CUSTOM_PER_GAME = 8;
const DESIGN_ATTEMPTS = 3;     // automatic design: transient failures retry this many times per character
const DESIGN_BACKOFF_MS = 30000; // ... waiting attempt * this long
const DESIGN_RETRY_LATER_MS = 5 * 60 * 1000; // after DESIGN_ATTEMPTS failures a character is tried again on its next line after this
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
  const attempts = new Map();  // key -> failed tries in a row
  const blockedUntil = new Map(); // key -> time: after DESIGN_ATTEMPTS failures the character waits (not forever) before its next try
  const renamedTo = new Map(); // key of an old name -> new name (a design finishing after a rename lands on the new name)
  const retryLaterMs = deps.designRetryMs === undefined ? DESIGN_RETRY_LATER_MS : deps.designRetryMs;
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
  // Stable ids from the hook (Ren'Py character tag, e.g. "s", "mc"): game -> {names: id -> current name, met: ids in first-heard order}.
  const idTable = new Map();
  const heroes = new Map(); // game -> Set of names of the player character (speaker_id "mc")
  const tableOf = (game) => idTable.get(game) || idTable.set(game, { names: new Map(), met: [] }).get(game);
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
    if (isHero(game, c.speaker)) { // the player character is a teenage boy, whatever the name or an earlier guess says
      out.protagonist = true; out.gender = 'male';
      if (out.age_range !== 'young_adult') out.age_range = 'teen';
    }
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

  const isHero = (game, speaker) => (heroes.has(game) && heroes.get(game).has(speaker)) ||
    !!(cast && typeof cast.protagonist === 'function' && cast.protagonist(game, speaker)) || isProtagonistName(String(speaker).trim().toLowerCase());
  const fallbackFor = (game, speaker, why) => profiler.fallbackProfile(speaker, catalog, why, { protagonist: isHero(game, speaker) });
  // "Girl 1" and "???" before a reveal; the same test that keeps "Student 2" from earning a designed voice.
  const isPlaceholder = (n) => /^[?\s]+$/.test(n) || GENERIC_SPEAKER.test(String(n).trim());

  /**
   * A line or /characters entry carried a stable speaker_id. The same id under a new name (Girl 1 -> Sayori) is one
   * character: the profile (voice, designed voice, lock, lines) moves to the new name. Returns the name to file it under.
   */
  function trackId(game, id, name, met) {
    if (!id || name === NARRATOR || name === UNKNOWN) return name;
    const t = tableOf(game);
    if (met && !t.met.includes(id)) t.met.push(id);
    const prev = t.names.get(id);
    if (id === 'mc') heroes.set(game, new Set([...(heroes.get(game) || []), name]));
    if (!prev || prev === name) { t.names.set(id, name); return name; }
    if (isPlaceholder(name) && !isPlaceholder(prev)) return prev; // "???" again after the reveal
    t.names.set(id, name);
    // Two researched, different characters under one id are not a rename (a hook that reuses ids).
    if (rankOf(game, prev) >= 0 && rankOf(game, name) >= 0) return name;
    moveProfile(game, prev, name);
    return name;
  }
  // The profile `prev` is the same character as `name`: merge it (voices.rename) and carry the pipeline state with it.
  function moveProfile(game, prev, name) {
    const voices = store.forGame(game);
    if (!voices.has(prev)) return;
    voices.rename(prev, name);
    const a = keyOf(game, prev), b = keyOf(game, name);
    renamedTo.set(a, name);
    for (const m of [attempts, blockedUntil]) if (m.has(a)) { m.set(b, m.get(a)); m.delete(a); }
    if (pending.has(a)) { pending.set(b, { ...pending.get(a), speaker: name }); pending.delete(a); }
    if (lastSpeaker === a) lastSpeaker = b;
    const t = idTable.get(game);
    if (t) for (const [id, n] of t.names) if (n === prev) t.names.set(id, name);
    if (rankOf(game, name) >= 0) { voices.requeue(name); attempted.delete(keyOf(game, name)); } // cast again with the research
  }

  // Placeholder labels the game shows before a reveal, plus name variables that leaked ("m_name").
  const isLabel = (n) => isPlaceholder(n) || /^\w+_name$/i.test(String(n).trim());
  const learned = new Map();   // game -> Map(label -> real name) found by reconcile: the label keeps resolving this session
  const reconciled = new Map(); // game -> {at, sig}: rate limit (3 min, only when the unresolved labels changed)
  const RECONCILE_GAP_MS = 3 * 60 * 1000;
  const reconciling = new Set();

  /**
   * Fold placeholder entries ("Girl 1", "???", "m_name") into the researched characters they really are.
   * Order: research aliases (free), then one Grok wiki call for the rest. Silent no-op without a key or research;
   * never throws. `force` skips the 3-minute gap (research just arrived). Returns how many entries were merged.
   */
  async function reconcile(game, force = false) {
    if (!cast || typeof cast.reconcile !== 'function' || !settings.getKey('grok') || reconciling.has(game)) return 0;
    const researched = cast.characters(game);
    if (!researched.length) return 0;
    const voices = store.forGame(game);
    const labels = Object.values(voices.all()).map((p) => p.speaker)
      .filter((n) => n !== NARRATOR && n !== UNKNOWN && isLabel(n) && !isHero(game, n));
    const sig = labels.slice().sort().join('|');
    const last = reconciled.get(game);
    if (!labels.length || (last && (last.sig === sig || (!force && now() - last.at < RECONCILE_GAP_MS)))) return 0;
    reconciling.add(game);
    reconciled.set(game, { at: now(), sig });
    let done = 0;
    try {
      const merge = (label, to) => {
        const target = researched.find((c) => c.name === to);
        const g = voices.get(label) && voices.get(label).gender;
        const known = (x) => x === 'male' || x === 'female';
        if (!target || target.protagonist || (known(g) && known(target.gender) && g !== target.gender)) return; // shortcut: gender clash = skip
        if (!learned.has(game)) learned.set(game, new Map());
        learned.get(game).set(label, to);
        moveProfile(game, label, to);
        done++;
      };
      const rest = [];
      for (const l of labels) {
        const c = cast.resolve(game, l);
        if (c !== l) merge(l, c); else rest.push(l);
      }
      if (rest.length) {
        if (usage) usage.recordAI();
        const map = await cast.reconcile(game, rest.map((l) => ({ label: l, samples: samplesOf(game, l) })));
        for (const l of rest) if (map[l]) merge(l, map[l]);
      }
      if (done) log(`reconcile ${game}: merged ${done} placeholder speaker(s) into researched characters`);
    } catch (e) {
      log('reconcile failed: ' + e.message);
    } finally {
      reconciling.delete(game);
    }
    return done;
  }
  // A speaker the hook gave a stable id ("s", "mc"): a defined character, even when its name looks like a placeholder.
  function hasId(game, speaker) {
    const t = idTable.get(game);
    return !!t && [...t.names.values()].includes(speaker);
  }

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
    // An older-leaning adult American man; never British or Australian, never a young or female voice.
    const voice = [/\b(older|middle-aged) man, American/i, /\badult man, American/i, /\bman\b.*American/i]
      .reduce((hit, re) => hit || catalog.find((v) => re.test(v.description)), null) || catalog[catalog.length - 1];
    return {
      speaker, gender: 'male', age_range: 'adult',
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
    // A builtin narrator saved with an older choice of voice is moved to the current one.
    if (speaker === NARRATOR && existing.source === 'builtin' && existing.voice_id !== builtinProfile(speaker).voice_id) return true;
    // The player character cast as anything but a boy is cast once more (as a boy).
    if (existing.gender !== 'male' && isHero(voices.game, speaker)) return !attempted.has(keyOf(voices.game, speaker));
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
        const cur = voices.get(speaker);
        return cur && (cur.gender === 'male' || !isHero(voices.game, speaker)) ? cur : voices.setAuto(fallbackFor(voices.game, speaker, 'no Grok key'));
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
        return voices.get(speaker) || voices.setAuto(fallbackFor(voices.game, speaker, 'Grok error'));
      }
    })();
    inFlight.set(k, work);
    try { return await work; } finally { inFlight.delete(k); }
  }

  const ttsParams = (profile, text) => ({
    text, voice_id: profile.voice_id, stability: profile.stability, style: profile.style,
    speed: profile.speed,
    // Designed voices always use the best model; presets follow Settings > Voice quality (fast | balanced | best).
    model: playsCustom(profile) ? ttsModule.BEST_MODEL : ttsModule.modelFor(settings.quality && settings.quality()),
  });
  // Designed voices sound thin on the fast model, so they always use the better one (few characters,
  // so the extra cost and ~1 s delay stay small).
  const playsCustom = (p) => !!(p && p.custom_voice && p.voice_id === p.custom_voice.voice_id);

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

  // The prompt Grok writes for a character's designed voice (fallback: built from the profile).
  async function voicePrompt(g, speaker, existing) {
    const grokKey = settings.getKey('grok');
    const asked = describe(g, { ...existing, samples: samplesOf(g, speaker) });
    if (grokKey && usage) usage.recordAI();
    if (grokKey) { // a slow or failing Grok must not cost the character its voice
      try { return (await profiler.voiceDescription(asked, asked.notes, asked.setting, grokKey, { fetch: deps.fetch })).description; }
      catch (e) { log(`voice description for ${speaker} failed, using the profile: ${e && e.message}`); }
    }
    return profiler.fallbackVoiceDescription(asked);
  }
  // The one rule for "can this character get a designed voice": it exists and a designer is available.
  function checkCanDesign(voices, speaker, existing) {
    if (!existing) throw new Error('Unknown character: ' + speaker);
    if (!designer) throw new Error('Custom voices are not available.');
  }
  const PREVIEW_TTL_MS = 30 * 60 * 1000; // UNVERIFIED how long ElevenLabs keeps unsaved previews; 30 min is cautious
  const auditions = new Map(); // key -> {description, ids, at}: previews shown to the player, not saved yet

  // ---- Rotating pool of designed voices (at most MAX_CUSTOM_PER_GAME live per game) ----
  const removals = new Set(); // in-flight ElevenLabs deletions (designIdle waits for them)
  const rankOf = (game, speaker) => (cast && typeof cast.rank === 'function' ? cast.rank(game, speaker) : -1);

  /** Delete a designed voice on ElevenLabs to free its slot. Best effort, never throws, never while a profile still uses it. */
  function removeRemote(voiceId) {
    if (!designer || typeof designer.remove !== 'function' || !voiceId || (store.usesVoice && store.usesVoice(voiceId))) return;
    const job = Promise.resolve().then(() => designer.remove(voiceId)).catch(() => {}).finally(() => removals.delete(job));
    removals.add(job);
  }

  // Standing of a character in the pool: main characters (researched, ranked first) beat the rest; then lines
  // voiced (persisted \`lines\` in voices.json), then who spoke last.
  const standing = (game, name, p) => {
    const rank = rankOf(game, name) >= 0 ? rankOf(game, name) : isHero(game, name) ? 0 : -1; // the protagonist is protected like a main
    return { name, locked: !!p.locked, main: rank >= 0, rank, lines: Number.isFinite(p.lines) ? p.lines : 0,
      at: Number.isFinite(p.last_spoken) ? p.last_spoken : 0 };
  };
  const priority = (game, speaker) => {
    const p = store.forGame(game).get(speaker);
    if (!p) return 0;
    const st = standing(game, speaker, p);
    return (st.main ? 1e6 - st.rank * 1000 : 0) + st.lines;
  };

  /**
   * The designed voice to give up, or null. Never the current speaker or \`speaker\` itself; characters the player
   * locked go last; then main characters; then fewest lines, then least recently spoken.
   */
  function pickVictim(game, speaker) {
    const pool = Object.entries(store.forGame(game).all())
      .filter(([name, p]) => p.custom_voice && name !== speaker && keyOf(game, name) !== lastSpeaker)
      .map(([name, p]) => standing(game, name, p));
    pool.sort((x, y) => (x.locked - y.locked) || (x.main - y.main) || (y.rank - x.rank) || (x.lines - y.lines) ||
      (x.at - y.at) || (x.name < y.name ? -1 : 1));
    return pool[0] || null;
  }

  /**
   * Room for \`speaker\`'s designed voice: {} when the pool has space, {victim} when someone must go, null when
   * nobody should (automatic design only evicts for a character that matters more: main beats non-main, a
   * better-ranked main beats a lower one, otherwise more lines; a locked voice is only taken by a main character
   * from a non-main one). \`force\` (the player asked) takes the least valuable voice regardless.
   */
  function roomFor(game, speaker, force) {
    const voices = store.forGame(game);
    if (voices.customCount() < MAX_CUSTOM_PER_GAME) return {};
    const victim = pickVictim(game, speaker);
    if (!victim) return null;
    if (force) return { victim };
    const me = standing(game, speaker, voices.get(speaker) || {});
    const better = me.main !== victim.main ? me.main
      : me.main ? me.rank < victim.rank : me.lines > victim.lines;
    if (victim.locked && !(me.main && !victim.main)) return null;
    return better ? { victim } : null;
  }

  /** Save a freshly designed voice; the one it replaces and the evicted one are deleted on ElevenLabs. */
  function keepCustom(game, speaker, custom, victim) {
    const voices = store.forGame(game);
    const old = (voices.get(speaker) || {}).custom_voice;
    const out = voices.setCustom(speaker, custom);
    if (old && old.voice_id !== custom.voice_id) removeRemote(old.voice_id);
    const gone = victim && voices.clearCustom(victim.name);
    if (gone) {
      log(`custom voice of ${victim.name} (${victim.lines} lines) given up for ${speaker}; it falls back to its preset`);
      removeRemote(gone.voice_id);
    }
    return out;
  }

  /** The voice to give up for `speaker` right now: only when the pool is full and `speaker` has none yet. */
  function victimFor(game, speaker) {
    const voices = store.forGame(game);
    const p = voices.get(speaker);
    return p && !p.custom_voice && voices.customCount() >= MAX_CUSTOM_PER_GAME ? pickVictim(game, speaker) : null;
  }

  async function designVoice(g, speaker, { force = true } = {}) {
    const voices = store.forGame(g);
    const existing = voices.get(speaker);
    checkCanDesign(voices, speaker, existing);
    const k = keyOf(g, speaker);
    if (designing.has(k)) return designing.get(k);
    const work = (async () => {
      const room = existing.custom_voice ? {} : roomFor(g, speaker, force);
      if (!room) throw new Error(`This game's ${MAX_CUSTOM_PER_GAME} custom voices all belong to characters that matter more.`);
      const description = await voicePrompt(g, speaker, existing);
      // Names stay out of the prompt: the voice is described, never identified.
      const made = await designer.design({ description, name: voiceName(titleOf(g), speaker), avoid: [speaker, titleOf(g)] });
      // The slot is given up only now that the new voice exists: a failed design costs nobody their voice.
      let who = speaker; // renamed while the design ran (Girl 1 -> Sayori): it belongs to the new name
      while (!voices.has(who) && renamedTo.has(keyOf(g, who))) who = renamedTo.get(keyOf(g, who));
      if (!voices.has(who)) { removeRemote(made.voice_id); throw new Error('The character is gone.'); }
      return keepCustom(g, who, { voice_id: made.voice_id, name: made.name, description: made.description || description }, victimFor(g, who));
    })();
    designing.set(k, work);
    try { return await work; } finally { designing.delete(k); }
  }

  // Placeholder speakers ("Student 1", "Guard", "Voice 2") never earn a designed voice by themselves.
  const GENERIC_SPEAKER = /^(?:the\s+)?(?:student|classmate|guy|girl|man|woman|boy|person|kid|child|npc|extra|voice|customer|villager|stranger|waiter|waitress|guard|crowd|everyone|all|both|someone|somebody|teacher|worker|clerk|passerby|male|female)s?(?:[\s_-]*[a-z]?\d+[a-z]?)?$|[\s_-]\d+$/i;
  /**
   * Who gets a designed voice, after ONE spoken line: any real character. Placeholders ("Student 1", "???") only
   * with a research match or a speaker_id (DDLC's "Girl 1" is Sayori). The pool and eviction decide who keeps one.
   */
  function qualifiesForDesign(game, speaker) {
    if (rankOf(game, speaker) >= 0 || isHero(game, speaker) || hasId(game, speaker)) return true;
    return !isPlaceholder(speaker);
  }

  function wantsDesign(game, speaker) {
    const p = store.forGame(game).get(speaker);
    return !!p && !p.custom_voice && !p.muted && speaker !== NARRATOR && speaker !== UNKNOWN &&
      qualifiesForDesign(game, speaker) && !!roomFor(game, speaker, false);
  }

  /** Queue a character for automatic design (no-op unless the setting is on and it needs one). */
  function enqueueDesign(game, speaker) {
    const k = keyOf(game, speaker);
    if (!designer || !customOn() || hardStop || pending.has(k) || designing.has(k) ||
        (blockedUntil.get(k) || 0) > now() || !settings.getKey('elevenlabs') || !wantsDesign(game, speaker)) return;
    pending.set(k, { game, speaker, notBefore: 0 });
    startPump();
  }

  function nextJob() {
    const t = now();
    let best = null, bestScore = -1;
    for (const [k, j] of pending) {
      if (j.notBefore > t) continue;
      const score = k === lastSpeaker ? Infinity : priority(j.game, j.speaker);
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
            else {
              attempts.delete(k);
              blockedUntil.set(k, now() + retryLaterMs); // tried again on a later line, not given up for the session
              status('error', `Could not make a custom voice for ${j.speaker}: ${e && e.message} It speaks with its preset voice for now and will be tried again.`);
            }
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
        blockedUntil.clear();
        const g = store.current();
        if (g) for (const [name, p] of Object.entries(store.forGame(g).all())) if (p.spoken) enqueueDesign(g, name);
      }
    },
    reconcile,
    /** Resolves when the automatic design queue is idle (tests). */
    designIdle: async () => { while (pump || removals.size) await Promise.all([pump, ...removals]); },

    /** voices:clearGame: forget a game's voices and delete its designed voices on ElevenLabs (best effort). */
    clearGame(game) {
      const ids = store.customVoiceIds ? store.customVoiceIds(game) : [];
      const out = store.clearGame(game);
      for (const id of ids) removeRemote(id);
      return out;
    },

    /** POST /line */
    async handleLine(line) {
      const text = line.text;
      const game = gameOf(line);
      const heard = line.speaker || NARRATOR;
      // A line older than the newest one (it overtook it on the way here) is dropped. A lower seq
      // after a pause means the game was restarted and counts from 1 again, so it is accepted.
      if (line.seq !== undefined && lastLineSeq !== undefined && line.seq <= lastLineSeq &&
          now() - lastLineAt < RESTART_GAP_MS) return;
      // Cast aliases first, then the offline same-person rule (Mark / MarkBorja / MarkSprite).
      let resolved = nameIn(game, heard);
      const was = learned.get(game) && learned.get(game).get(resolved);
      if (was && !line.speaker_id) resolved = was; // reconcile already placed this label
      resolved = trackId(game, line.speaker_id, resolved, true);
      const known = store.forGame(game);
      const speaker = known.canonical(resolved);
      // Godot names come from scene nodes: a crowd or UI label that never matched a known character
      // is not a speaker. A known (or cast-resolved) name is kept even if it holds a crowd word. This
      // runs before the line counts as the newest one, so a label cannot cancel the real line before it.
      if (line.engine === 'godot' && resolved === heard && !known.has(speaker) && isCrowdName(heard)) return;
      const mine = ++generation;
      if (line.seq !== undefined) { lastLineSeq = line.seq; lastLineAt = now(); }
      const voices = activate(game);
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
      if (isLabel(speaker) && cast && typeof cast.reconcile === 'function') reconcile(game).catch(() => {}); // background, never awaited
      try {
        const casting = needsProfile(voices, speaker);
        const profiled = ensureProfile(voices, speaker, samplesOf(game, speaker));
        // Slow casting must not silence a character (Grok may take 20 s to fail): the placeholder
        // is saved, so her next lines speak at once, and Grok's answer replaces it when it lands.
        const base = await (!casting ? profiled : Promise.race([profiled, new Promise((resolve) => {
          const timer = setTimeout(() => resolve(voices.get(speaker) ||
            voices.setAuto(fallbackFor(game, speaker, 'Grok is slow'))), castWaitMs);
          if (timer.unref) timer.unref();
        })]));
        voices.markSpoken(speaker);
        if (base && base.muted) { emit('audio:stop'); return; } // muted in the overlay: free
        voices.touch(speaker, now());
        lastSpeaker = keyOf(game, speaker);
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
        const speaker = voices.canonical(trackId(game, c.id, nameIn(game, c.speaker), false));
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
          if (!voices.has(c.speaker)) voices.setAuto(fallbackFor(game, c.speaker, 'no Grok key'));
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
          return voices.get(c.speaker) || voices.setAuto(fallbackFor(game, c.speaker, 'not profiled'));
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

    /** The description Grok (or the profile, offline) would use for this character; nothing is made or saved. */
    async describeVoice({ game, speaker } = {}) {
      const g = gameOf({ game });
      const existing = store.forGame(g).get(speaker);
      checkCanDesign(store.forGame(g), speaker, existing);
      return voicePrompt(g, speaker, existing);
    },

    /**
     * Manual design, step 1: ElevenLabs makes up to 3 versions of the character's voice for the player
     * to audition. Nothing is saved and no voice slot is used until pickPreview.
     */
    async designPreviews({ game, speaker, description: own } = {}) {
      const g = gameOf({ game });
      const voices = store.forGame(g);
      const existing = voices.get(speaker);
      checkCanDesign(voices, speaker, existing);
      // The player's own words win; blank means Grok writes it. (sanitizeDescription pads/cleans it later.)
      const typed = String(own || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const description = typed || await voicePrompt(g, speaker, existing);
      const made = await designer.previews({ description, avoid: [speaker, titleOf(g)] });
      auditions.set(keyOf(g, speaker), { description: made.description, ids: made.previews.map((p) => p.id), at: now() });
      return made.previews;
    },

    /** Manual design, step 2: keep the version the player picked. */
    async pickPreview({ game, speaker, id } = {}) {
      const g = gameOf({ game });
      const voices = store.forGame(g);
      const existing = voices.get(speaker);
      checkCanDesign(voices, speaker, existing);
      const k = keyOf(g, speaker);
      const a = auditions.get(k);
      if (!a || !a.ids.includes(id) || now() - a.at > PREVIEW_TTL_MS) {
        throw new Error('That preview is no longer available. Click Custom voice to make new ones.');
      }
      const made = await designer.save({ id, description: a.description, name: voiceName(titleOf(g), speaker) });
      auditions.delete(k);
      hardStop = null; // a manual success proves the key works again
      return keepCustom(g, speaker, { voice_id: made.voice_id, name: made.name, description: made.description }, victimFor(g, speaker));
    },

    /**
     * EXPERIMENTAL: design a custom ElevenLabs voice for one character (Grok writes the description).
     * On any failure the profile is untouched. One call per character at a time. A full pool gives up its
     * least valuable voice (the player asked for this one).
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
      await reconcile(game, true); // research just arrived (and on startup data): fold placeholders in before recasting
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
  };
}

module.exports = { createPipeline, MAX_CUSTOM_PER_GAME, NARRATOR, UNKNOWN };
