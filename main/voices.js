'use strict';
// voices.json in userData: one profile per speaker. The player's choices (locked) always win.
const fs = require('node:fs');
const path = require('node:path');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
const PATCHABLE = {
  voice_id: (v, catalogIds) => (typeof v === 'string' && (!catalogIds || catalogIds.includes(v)) ? v : undefined),
  stability: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  style: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  speed: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0.7, 1.2) : undefined),
};

/** createVoiceStore({file, catalogIds?}) */
function createVoiceStore({ file, catalogIds }) {
  let voices = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) voices = raw;
  } catch { /* first launch or corrupt file: start empty */ }
  const listeners = new Set();

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(voices, null, 2));
    fs.renameSync(tmp, file);
    const snapshot = all();
    for (const fn of listeners) { try { fn(snapshot); } catch { /* listener's problem */ } }
  }
  function all() { return JSON.parse(JSON.stringify(voices)); }

  return {
    all,
    get: (speaker) => (Object.prototype.hasOwnProperty.call(voices, speaker) ? { ...voices[speaker] } : null),
    has: (speaker) => Object.prototype.hasOwnProperty.call(voices, speaker),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Save a profile chosen by the app/Gemini. A locked profile is never overwritten. */
    setAuto(profile) {
      const existing = voices[profile.speaker];
      if (existing && existing.locked) return { ...existing };
      voices[profile.speaker] = { ...profile, locked: false };
      save();
      return { ...voices[profile.speaker] };
    },

    /** Player edit from the UI: applies the allowed fields and locks the profile. */
    update(speaker, patch) {
      const existing = voices[speaker];
      if (!existing) throw new Error('Unknown character: ' + speaker);
      const next = { ...existing };
      for (const [k, check] of Object.entries(PATCHABLE)) {
        if (patch && patch[k] !== undefined) {
          const v = check(patch[k], catalogIds);
          if (v === undefined) throw new Error(`Bad value for ${k}`);
          next[k] = v;
        }
      }
      next.locked = true;
      voices[speaker] = next;
      save();
      return { ...next };
    },

    /** Used by Re-roll: the player asked for a new AI pick, so the lock is released. */
    unlock(speaker) {
      if (voices[speaker]) voices[speaker].locked = false;
    },
  };
}

module.exports = { createVoiceStore };
