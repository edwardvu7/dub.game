'use strict';
// voices.json in userData: one profile per speaker, per game. The player's choices (locked) always win.
//
// File format (version 2):
//   { "version": 2, "current": "renpy:DDLC",
//     "games": { "renpy:DDLC": { "name": "Doki Doki Literature Club", "voices": { "Sayori": {...} } } } }
// A version 1 file (speaker -> profile, no games) is kept as "legacy" and handed to the first game
// that is voiced afterwards, so players who already tuned voices keep them.
const fs = require('node:fs');
const path = require('node:path');

const LEGACY = 'legacy';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
const PATCHABLE = {
  voice_id: (v, catalogIds) => (typeof v === 'string' && (!catalogIds || catalogIds.includes(v)) ? v : undefined),
  stability: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  style: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  speed: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0.7, 1.2) : undefined),
  muted: (v) => (typeof v === 'boolean' ? v : undefined),
};
// Changing these is a sound choice by the player, so the profile is locked. Muting is not.
const LOCKS = ['voice_id', 'stability', 'style', 'speed'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function load(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  if (!isObject(raw)) return { version: 2, current: null, games: {} };
  if (raw.version === 2 && isObject(raw.games)) {
    return { version: 2, current: typeof raw.current === 'string' ? raw.current : null, games: raw.games };
  }
  // Version 1: speaker -> profile.
  const voices = {};
  for (const [speaker, p] of Object.entries(raw)) if (isObject(p)) voices[speaker] = p;
  const games = Object.keys(voices).length ? { [LEGACY]: { name: 'Earlier voices', voices } } : {};
  return { version: 2, current: null, games };
}

/** createVoiceStore({file, catalogIds?}) */
function createVoiceStore({ file, catalogIds }) {
  const data = load(file);
  const listeners = new Set();

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    const snapshot = all();
    for (const fn of listeners) { try { fn(snapshot); } catch { /* listener's problem */ } }
  }
  function all() { return JSON.parse(JSON.stringify({ current: data.current, games: data.games })); }

  function bucket(game, create) {
    const id = String(game || 'unknown');
    if (!own(data.games, id)) {
      if (!create) return null;
      // The first game voiced after an upgrade inherits the voices tuned before games were tracked.
      if (id !== LEGACY && own(data.games, LEGACY)) {
        data.games[id] = { name: id, voices: data.games[LEGACY].voices };
        delete data.games[LEGACY];
      } else {
        data.games[id] = { name: id, voices: {} };
      }
    }
    return data.games[id];
  }

  /** The old one-game API, scoped to one game. */
  function forGame(game) {
    const voicesOf = (create) => { const b = bucket(game, create); return b ? b.voices : null; };
    return {
      game: String(game || 'unknown'),
      get(speaker) { const v = voicesOf(false); return v && own(v, speaker) ? { ...v[speaker] } : null; },
      has(speaker) { const v = voicesOf(false); return !!v && own(v, speaker); },
      all() { return JSON.parse(JSON.stringify(voicesOf(false) || {})); },

      /** Save a profile chosen by the app/Gemini. A locked profile is never overwritten. */
      setAuto(profile) {
        const v = voicesOf(true);
        const existing = v[profile.speaker];
        if (existing && existing.locked) return { ...existing };
        v[profile.speaker] = { ...profile, locked: false, muted: !!(existing && existing.muted) };
        save();
        return { ...v[profile.speaker] };
      },

      /** Player edit from the UI: applies the allowed fields; a sound change locks the profile. */
      update(speaker, patch) {
        const v = voicesOf(false);
        if (!v || !v[speaker]) throw new Error('Unknown character: ' + speaker);
        const next = { ...v[speaker] };
        let locks = false;
        for (const [k, check] of Object.entries(PATCHABLE)) {
          if (patch && patch[k] !== undefined) {
            const value = check(patch[k], catalogIds);
            if (value === undefined) throw new Error(`Bad value for ${k}`);
            next[k] = value;
            if (LOCKS.includes(k)) locks = true;
          }
        }
        if (locks) next.locked = true;
        v[speaker] = next;
        save();
        return { ...next };
      },

      /** Used by Re-roll: the player asked for a new AI pick, so the lock is released. */
      unlock(speaker) {
        const v = voicesOf(false);
        if (v && v[speaker]) v[speaker].locked = false;
      },
    };
  }

  return {
    all,
    forGame,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    current: () => data.current,

    /** A game sent a line or its cast: it becomes the one the overlay and Voices tab show. */
    setCurrent(game, name) {
      const b = bucket(game, true);
      let changed = data.current !== String(game);
      data.current = String(game);
      if (name && b.name !== name) { b.name = name; changed = true; }
      if (changed) save();
    },

    /** Forget every voice of one game (the next line profiles them again). */
    clearGame(game) {
      if (!own(data.games, String(game))) return false;
      delete data.games[String(game)];
      if (data.current === String(game)) data.current = null;
      save();
      return true;
    },
  };
}

module.exports = { createVoiceStore, LEGACY };
