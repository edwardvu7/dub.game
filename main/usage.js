'use strict';
// Cost control: counts the characters dub.game sends to ElevenLabs (it bills per character) and
// the Grok calls, and enforces an optional monthly character limit. Lines replayed from the
// audio cache are free and are not counted. Saved in userData/usage.json.
const fs = require('node:fs');
const path = require('node:path');

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7); // "2026-11" (UTC)

/** createUsage({file, now?}) */
function createUsage({ file, now = Date.now } = {}) {
  let data = { month: monthOf(now()), monthChars: 0, monthAI: 0, totalChars: 0, limit: 0, byGame: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      data = { ...data, ...raw, byGame: raw.byGame || {} };
      // back-compat: older files counted Gemini calls as monthGemini
      if (raw.monthAI === undefined && Number.isFinite(raw.monthGemini)) data.monthAI = raw.monthGemini;
      delete data.monthGemini;
    }
  } catch { /* first run */ }
  const session = { chars: 0, ai: 0, lines: 0, cached: 0 };
  const listeners = new Set();

  function rollMonth() {
    const m = monthOf(now());
    if (data.month !== m) { data.month = m; data.monthChars = 0; data.monthAI = 0; data.byGame = {}; }
  }
  function save() {
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch { /* counting is best effort */ }
    }
    notify();
  }
  function notify() {
    const snap = get();
    for (const fn of listeners) { try { fn(snap); } catch { /* ignore */ } }
  }
  function get() {
    rollMonth();
    return {
      session: { ...session },
      month: data.month, monthChars: data.monthChars, monthAI: data.monthAI,
      totalChars: data.totalChars, limit: data.limit,
      byGame: { ...data.byGame },
      overLimit: data.limit > 0 && data.monthChars >= data.limit,
    };
  }

  return {
    get,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** True when speaking `chars` more characters would go past the monthly limit. */
    wouldExceed(chars) {
      rollMonth();
      return data.limit > 0 && data.monthChars + chars > data.limit;
    },
    /** A line was spoken by ElevenLabs (not from the cache). */
    recordSpeech(chars, game) {
      rollMonth();
      const n = Math.max(0, Math.round(chars));
      session.chars += n; session.lines += 1;
      data.monthChars += n; data.totalChars += n;
      if (game) data.byGame[game] = (data.byGame[game] || 0) + n;
      save();
    },
    /** A line was replayed from the cache: free. */
    recordCached() { session.cached += 1; notify(); }, // session-only: nothing to write
    recordAI() { rollMonth(); session.ai += 1; data.monthAI += 1; save(); },
    /** Monthly character limit; 0 means no limit. */
    setLimit(limit) {
      const n = Number(limit);
      data.limit = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
      save();
      return get();
    },
  };
}

module.exports = { createUsage, monthOf };
