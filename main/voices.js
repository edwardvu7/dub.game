'use strict';
// voices.json in userData: one profile per speaker, per game. The player's choices (locked) always win.
//
// File format (version 2):
//   { "version": 2, "current": "renpy:DDLC",
//     "games": { "renpy:DDLC": { "name": "Doki Doki Literature Club", "voices": { "Sayori": {...} } } } }
// Per-profile counters for custom-voice rotation (pipeline.js): `lines` (lines voiced, all sessions) and
// `last_spoken` (ms since epoch). Written by touch(); flushed to disk every few lines, not on every one.
// A version 1 file (speaker -> profile, no games) is kept as "legacy" and handed to the first game
// that is voiced afterwards, so players who already tuned voices keep them.
const fs = require('node:fs');
const path = require('node:path');
const { canonicalName } = require('./speaker-names');
const { isCrowdName } = require('./godot-names');
const profiler = require('./profiler');

const LEGACY = 'legacy';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
const PATCHABLE = {
  voice_id: (v, catalogIds) => (typeof v === 'string' && (!catalogIds || catalogIds.includes(v)) ? v : undefined),
  stability: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  style: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined),
  speed: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0.7, 1.2) : undefined),
  muted: (v) => (typeof v === 'boolean' ? v : undefined),
  volume: (v) => (Number.isFinite(Number(v)) ? clamp(v, 0, 1) : undefined), // playback only, not a sound choice
  use_preset: (v) => (typeof v === 'boolean' ? v : undefined), // which of the two voice sets plays; not a sound choice
};

/**
 * The voice that actually speaks. Two sets live on one profile: the preset (`voice_id`) and the
 * designed one (`custom_voice`). The designed one plays only while the Custom voices setting is on, the
 * profile has one, and the player has not picked a preset for this character (`use_preset`).
 */
function effectiveVoiceId(profile, customOn) {
  const c = profile && profile.custom_voice;
  return customOn && c && c.voice_id && !profile.use_preset ? c.voice_id : profile && profile.voice_id;
}
// Changing these is a sound choice by the player, so the profile is locked. Muting and volume are not.
const LOCKS = ['voice_id', 'stability', 'style', 'speed'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** {voice_id, name, description} with string fields of sane length, or null. */
function validCustom(c) {
  if (!isObject(c) || [c.voice_id, c.name, c.description].some((s) => typeof s !== 'string')) return null;
  if (!/^[A-Za-z0-9]{1,64}$/.test(c.voice_id)) return null;
  return { voice_id: c.voice_id, name: c.name.slice(0, 100), description: c.description.slice(0, 1000) };
}

/**
 * Fold entries that are the same person (see speaker-names.js) into one, in place. The surviving
 * profile is the player's locked one if any, else the one already under the canonical name; it keeps
 * its voice, and picks up a volume the player set and `spoken` from the others. Returns true if changed.
 */
function consolidate(voices) {
  const names = Object.keys(voices);
  const groups = new Map();
  for (const n of names) {
    const c = canonicalName(n, names);
    groups.set(c, [...(groups.get(c) || []), n]);
  }
  let changed = false;
  for (const [c, members] of groups) {
    if (members.length === 1 && members[0] === c) continue;
    const profiles = members.map((m) => voices[m]);
    const pick = profiles.find((p) => p.locked) || voices[c] || profiles[0];
    const merged = { ...pick, speaker: c };
    if (!Number.isFinite(merged.volume) || merged.volume === 1) {
      const v = profiles.find((p) => Number.isFinite(p.volume) && p.volume !== 1);
      if (v) merged.volume = v.volume;
    }
    if (profiles.some((p) => p.spoken)) merged.spoken = true;
    merged.lines = profiles.reduce((n, p) => n + (Number.isFinite(p.lines) ? p.lines : 0), 0) || undefined;
    if (merged.lines === undefined) delete merged.lines;
    const ls = Math.max(0, ...profiles.map((p) => (Number.isFinite(p.last_spoken) ? p.last_spoken : 0)));
    if (ls) merged.last_spoken = ls;
    if (profiles.some((p) => p.muted)) merged.muted = true;
    for (const m of members) delete voices[m];
    voices[c] = merged;
    changed = true;
  }
  return changed;
}

/**
 * One-time upgrade (flag `migrated`): voices.json did not record who had spoken. Godot entries that
 * look like crowds or UI labels and were never customised are dropped; every other entry is
 * marked spoken so no real character disappears; then duplicate people are merged.
 */
function migrate(data) {
  if (data.migrated) return false;
  for (const [id, game] of Object.entries(data.games)) {
    if (!isObject(game) || !isObject(game.voices)) continue;
    const isGodot = id.startsWith('godot:');
    for (const [name, p] of Object.entries(game.voices)) {
      const untouched = !p.locked && !p.muted && !(Number.isFinite(p.volume) && p.volume !== 1) && !p.spoken;
      if (isGodot && untouched && isCrowdName(name)) delete game.voices[name];
      else if (isObject(p) && p.spoken === undefined) p.spoken = true;
    }
    consolidate(game.voices);
  }
  data.migrated = true;
  return Object.keys(data.games).length > 0; // nothing to write for a brand-new install
}

/** Catalog voice whose description fits the profile's gender, then age; ties broken per name. */
function closestVoice(name, p, catalog) {
  const gender = { female: /\b(woman|female|girl)\b/i, male: /\b(man|male|boy)\b/i }[p.gender];
  const age = { child: /child|kid/i, teen: /teen/i, young_adult: /young/i, elder: /old|elder|aged/i }[p.age_range];
  let pool = catalog;
  for (const re of [gender, age]) {
    const hit = re && pool.filter((v) => re.test(v.description || ''));
    if (hit && hit.length) pool = hit;
  }
  return profiler.fallbackProfile(name, pool, 'restored').voice_id;
}

/**
 * Profiles made by the first custom-voice version had voice_id overwritten with the designed id and were
 * locked, so no preset survives. Give them a catalog voice by gender/age (a placeholder: Grok casts it
 * properly the next time that character speaks and a Grok key exists) and release the lock, which the
 * designing, not the player, had set. Idempotent: new profiles never have voice_id === custom_voice.voice_id.
 */
function restorePresets(data, catalog) {
  let changed = false;
  for (const game of Object.values(data.games)) {
    if (!isObject(game) || !isObject(game.voices)) continue;
    for (const [name, p] of Object.entries(game.voices)) {
      if (!isObject(p) || !isObject(p.custom_voice) || p.voice_id !== p.custom_voice.voice_id) continue;
      if (!catalog || !catalog.length) continue;
      game.voices[name] = { ...p, voice_id: closestVoice(name, p, catalog), locked: false, source: 'fallback' };
      changed = true;
    }
  }
  return changed;
}

function load(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  if (!isObject(raw)) return { version: 2, current: null, games: {} };
  if (raw.version === 2 && isObject(raw.games)) {
    return { version: 2, current: typeof raw.current === 'string' ? raw.current : null, games: raw.games,
      migrated: raw.migrated === true };
  }
  // Version 1: speaker -> profile.
  const voices = {};
  for (const [speaker, p] of Object.entries(raw)) if (isObject(p)) voices[speaker] = p;
  const games = Object.keys(voices).length ? { [LEGACY]: { name: 'Earlier voices', voices } } : {};
  return { version: 2, current: null, games };
}

/** createVoiceStore({file, catalogIds?}) */
function createVoiceStore({ file, catalogIds, catalog }) {
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
  if (migrate(data) | restorePresets(data, catalog)) save();

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
      /** The name this speaker is filed under (same person, other spelling). */
      canonical(speaker) { return canonicalName(speaker, Object.keys(voicesOf(false) || {})); },
      get(speaker) { const v = voicesOf(false); return v && own(v, speaker) ? { ...v[speaker] } : null; },
      has(speaker) { const v = voicesOf(false); return !!v && own(v, speaker); },
      all() { return JSON.parse(JSON.stringify(voicesOf(false) || {})); },

      /** Save a profile chosen by the app/Grok. A locked profile is never overwritten. */
      setAuto(profile) {
        const v = voicesOf(true);
        const existing = v[profile.speaker];
        if (existing && existing.locked) return { ...existing };
        v[profile.speaker] = { ...profile, locked: false, spoken: !!(existing && existing.spoken), muted: !!(existing && existing.muted),
          volume: existing && Number.isFinite(existing.volume) ? existing.volume : 1 };
        // A designed voice record survives recasts and re-rolls (kept so the player can switch back to it).
        if (existing && Number.isFinite(existing.lines)) v[profile.speaker].lines = existing.lines;
        if (existing && Number.isFinite(existing.last_spoken)) v[profile.speaker].last_spoken = existing.last_spoken;
        if (existing && existing.custom_voice) {
          v[profile.speaker].custom_voice = existing.custom_voice;
          if (existing.use_preset) v[profile.speaker].use_preset = true;
        }
        if (!existing) consolidate(v); // a new short name ("Mark") may absorb earlier "MarkBorja"
        save();
        return { ...v[profile.speaker] };
      },

      /** A line from this speaker was voiced: they are a real character, shown in the UI. */
      markSpoken(speaker) {
        const v = voicesOf(false);
        if (!v || !v[speaker] || v[speaker].spoken) return;
        v[speaker].spoken = true;
        save();
      },

      /** Count one voiced line (rotation priority). Kept in memory; written to disk every 5th line. */
      touch(speaker, at = Date.now()) {
        const v = voicesOf(false);
        if (!v || !v[speaker]) return;
        v[speaker].lines = (Number.isFinite(v[speaker].lines) ? v[speaker].lines : 0) + 1;
        v[speaker].last_spoken = at;
        if (v[speaker].lines % 5 === 1) save();
      },

      /** Rotation: drop a designed voice. The profile falls back to its preset (voice_id and sliders are untouched). */
      clearCustom(speaker) {
        const v = voicesOf(false);
        if (!v || !v[speaker] || !v[speaker].custom_voice) return null;
        const old = v[speaker].custom_voice;
        delete v[speaker].custom_voice;
        delete v[speaker].use_preset;
        save();
        return old;
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

      /**
       * EXPERIMENTAL: store the voice designed on ElevenLabs as the second voice set. Only the pipeline calls
       * this (it is not in PATCHABLE). The preset (voice_id, sliders) and the lock are untouched; which set
       * plays is decided by effectiveVoiceId. A fresh design clears use_preset (the player asked for it).
       */
      setCustom(speaker, custom) {
        const v = voicesOf(false);
        if (!v || !v[speaker]) throw new Error('Unknown character: ' + speaker);
        const c = validCustom(custom);
        if (!c) throw new Error('Bad custom voice');
        v[speaker] = { ...v[speaker], custom_voice: c };
        delete v[speaker].use_preset;
        save();
        return { ...v[speaker] };
      },

      /** How many distinct designed voices this game has (the voice-slot cap counts these). */
      customCount() {
        const v = voicesOf(false) || {};
        return new Set(Object.values(v).filter((p) => p && p.custom_voice).map((p) => p.custom_voice.voice_id)).size;
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

    /** True when any profile of any game still points at this ElevenLabs voice (so it must not be deleted). */
    usesVoice(voiceId) {
      return Object.values(data.games).some((g) => isObject(g) && isObject(g.voices) && Object.values(g.voices)
        .some((p) => p && (p.voice_id === voiceId || (p.custom_voice && p.custom_voice.voice_id === voiceId))));
    },

    /** The designed voices of one game (for deleting them on ElevenLabs when the game is cleared). */
    customVoiceIds(game) {
      const b = own(data.games, String(game)) ? data.games[String(game)] : null;
      return [...new Set(Object.values((b && b.voices) || {}).filter((p) => p && p.custom_voice).map((p) => p.custom_voice.voice_id))];
    },

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

module.exports = { createVoiceStore, effectiveVoiceId, LEGACY };
