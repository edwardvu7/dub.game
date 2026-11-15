'use strict';
// One person, one speaker. Games name the same character several ways ("Mark", "MarkBorja",
// "MarkSprite", "Sylvie_Happy"). This offline rule is deliberately conservative; cast.json aliases
// (main/cast.js) still win when Grok's research arrived.

// Trailing words that name a sprite or an emotion, never a different person.
const SUFFIX_WORDS = new Set(['sprite', 'happy', 'sad', 'angry', 'neutral', 'smile', 'smiling', 'surprised',
  'idle', 'talk', 'talking', 'npc', 'blush', 'cry', 'crying', 'mad', 'laugh', 'shy', 'worried', 'serious', 'annoyed']);
const KEEP = new Set(['Narrator', 'unknown']);

// Words with their original case: "MarkBorja" -> ["Mark", "Borja"].
function tokens(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
}
const lower = (name) => tokens(name).map((w) => w.toLowerCase());
// Lowercase words without trailing sprite/emotion words ("MarkSprite" -> ["mark"]).
function core(name) {
  const w = lower(name);
  while (w.length > 1 && SUFFIX_WORDS.has(w[w.length - 1])) w.pop();
  return w;
}

/**
 * canonicalName(speaker, known) -> the name this speaker should be filed under.
 * 1. Trailing sprite/emotion words are dropped ("MarkSprite" -> "Mark"; "Mark Npc" -> "Mark").
 * 2. A multi-word name whose first word is a known one-word name merges into it, but only when that
 *    short name is the only one and no other known name shares the first word. So "Mark" absorbs
 *    "MarkBorja" when he is the only Mark-something, while "Mark Borja" and "Mark Santos" stay apart,
 *    "Market" never joins "Mark" (whole words only) and "Annabel" never joins "Ann".
 */
function canonicalName(speaker, known = []) {
  if (typeof speaker !== 'string' || KEEP.has(speaker)) return speaker;
  let toks = tokens(speaker);
  if (!toks.length) return speaker;
  let name = speaker;
  const kept = [...toks];
  while (kept.length > 1 && SUFFIX_WORDS.has(kept[kept.length - 1].toLowerCase())) kept.pop();
  if (kept.length !== toks.length) {
    const key = kept.map((w) => w.toLowerCase()).join(' ');
    name = known.find((k) => lower(k).join(' ') === key) || kept.join(' ');
    toks = kept;
  }
  if (toks.length > 1) {
    const first = toks[0].toLowerCase();
    const others = known.filter((k) => k !== name && !KEEP.has(k));
    const shorts = others.filter((k) => { const w = lower(k); return w.length === 1 && w[0] === first; });
    const longs = others.filter((k) => { const w = core(k); return w.length > 1 && w[0] === first; });
    if (shorts.length === 1 && !longs.length) return shorts[0];
  }
  return name;
}

module.exports = { canonicalName, SUFFIX_WORDS };
