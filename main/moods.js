'use strict';
// Acting: Gemini reads the next lines of the scene ahead of time and marks how each one should be
// said (emotion and intensity). When a line is spoken, its mood shifts the character's voice
// settings for that line only. Gemini is asked in batches, before the lines are reached, so a
// line never waits for it. Only Ren'Py hooks send upcoming lines; other engines speak as before.
const profiler = require('./profiler');

const EMOTIONS = ['neutral', 'happy', 'excited', 'tender', 'sad', 'angry', 'scared', 'nervous', 'whisper', 'shout'];
const LOOKAHEAD = 20;   // lines per Gemini call
const REFILL_AT = 5;    // ask again when fewer than this many upcoming lines have a mood
const MAX_KEPT = 3000;  // moods remembered per session (oldest dropped first)

// How each emotion moves stability, style and speed at full intensity. Lower stability is more
// expressive; style adds drama; speed 1.0 is normal. Small on purpose: the character's own voice
// (Gemini's pick or the player's) stays the base.
const SHIFT = {
  neutral: { stability: 0, style: 0, speed: 0 },
  happy: { stability: -0.1, style: 0.15, speed: 0.04 },
  excited: { stability: -0.25, style: 0.3, speed: 0.08 },
  tender: { stability: 0.1, style: 0.1, speed: -0.06 },
  sad: { stability: -0.1, style: 0.2, speed: -0.1 },
  angry: { stability: -0.3, style: 0.35, speed: 0.06 },
  scared: { stability: -0.3, style: 0.25, speed: 0.08 },
  nervous: { stability: -0.2, style: 0.15, speed: 0.05 },
  whisper: { stability: 0.15, style: 0, speed: -0.08 },
  shout: { stability: -0.35, style: 0.4, speed: 0.04 },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;
const keyOf = (game, speaker, text) => game + '\u0000' + speaker + '\u0000' + text;

/** The profile with the line's mood applied. No mood (or neutral) returns the profile unchanged. */
function applyMood(profile, mood) {
  if (!profile || !mood || !SHIFT[mood.emotion] || mood.emotion === 'neutral') return profile;
  const k = clamp(Number(mood.intensity) || 0, 0, 1);
  const s = SHIFT[mood.emotion];
  return {
    ...profile,
    stability: round2(clamp(profile.stability + s.stability * k, 0, 1)),
    style: round2(clamp(profile.style + s.style * k, 0, 1)),
    speed: round2(clamp(profile.speed + s.speed * k, 0.7, 1.2)),
  };
}

function buildRequest(lines, context) {
  const before = context.map((l) => `${l.speaker}: ${l.text}`).join('\n') || '(scene start)';
  const ahead = lines.map((l, i) => `${i}. ${l.speaker}: ${l.text}`).join('\n');
  return {
    url: profiler.ENDPOINT,
    body: {
      contents: [{ role: 'user', parts: [{ text: [
        'You are directing voice actors for a visual novel. For each numbered line below, say how it',
        'should be delivered, judging from the character and the situation in the scene so far.',
        `emotion is one of: ${EMOTIONS.join(', ')}. intensity is 0.0 (barely) to 1.0 (as strong as`,
        'it gets). Most lines are neutral or mild; save high intensity for real peaks. Return every line',
        'number exactly once.', '',
        'Scene so far:', before, '',
        'Lines to direct:', ahead,
      ].join('\n') }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', required: ['lines'], properties: { lines: { type: 'ARRAY', items: {
          type: 'OBJECT', required: ['i', 'emotion', 'intensity'],
          properties: { i: { type: 'INTEGER' }, emotion: { type: 'STRING', enum: EMOTIONS }, intensity: { type: 'NUMBER' } },
        } } } },
        // UNVERIFIED: "low" is the fastest thinking level on Gemini 3.x (same as voice casting).
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
  };
}

/**
 * createMoods({settings, usage?, emitStatus?, callGemini?})
 *   get(game, speaker, text) -> {emotion, intensity} | null   (never waits)
 *   prepare(game, upcoming, context) -> Promise   (asks Gemini when the next lines lack moods)
 * Off when the player turns acting off in Settings, or there is no Gemini key.
 */
function createMoods({ settings, usage, emitStatus = () => {}, callGemini = profiler.callGemini }) {
  const known = new Map();
  const asking = new Set(); // keys in a Gemini call right now

  function remember(key, mood) {
    known.set(key, mood);
    if (known.size > MAX_KEPT) known.delete(known.keys().next().value);
  }

  async function prepare(game, upcoming, context = []) {
    const key = settings.getKey('gemini');
    if (!key || !settings.acting() || !Array.isArray(upcoming) || !upcoming.length) return;
    const lines = upcoming.slice(0, LOOKAHEAD);
    const keys = lines.map((l) => keyOf(game, l.speaker, l.text));
    const missing = (k) => !known.has(k) && !asking.has(k);
    if (!keys.slice(0, REFILL_AT).some(missing)) return; // enough is ready: no call
    const todo = lines.filter((_, i) => missing(keys[i]));
    const todoKeys = todo.map((l) => keyOf(game, l.speaker, l.text));
    todoKeys.forEach((k) => asking.add(k));
    try {
      if (usage) usage.recordGemini();
      const req = buildRequest(todo, context.slice(-6));
      const raw = await callGemini(req, key, globalThis.fetch);
      const out = raw && Array.isArray(raw.lines) ? raw.lines : [];
      for (const m of out) {
        const i = Number(m && m.i);
        if (!Number.isInteger(i) || !todo[i] || !EMOTIONS.includes(m.emotion)) continue;
        remember(todoKeys[i], { emotion: m.emotion, intensity: round2(clamp(Number(m.intensity) || 0, 0, 1)) });
      }
    } catch (e) {
      emitStatus('Acting is paused for these lines: ' + e.message);
    } finally {
      todoKeys.forEach((k) => asking.delete(k));
    }
  }

  return {
    get: (game, speaker, text) => (settings.acting() ? known.get(keyOf(game, speaker, text)) || null : null),
    prepare,
  };
}

module.exports = { createMoods, applyMood, buildRequest, EMOTIONS, SHIFT, LOOKAHEAD, REFILL_AT };
