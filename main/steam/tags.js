'use strict';
// Is a Steam game story-driven? Godot, RPG Maker and Unity are also used for shooters and
// platformers that have no dialogue to voice, so those games are listed only when their Steam
// community tags say "Visual Novel", "Story Rich" or similar.
//
// Steam's own store API returns broad genres, not community tags. SteamSpy (steamspy.com) is the
// public, keyless source that returns tags by app id. Its documented rate is about one appdetails
// request per second, so lookups run one at a time with a gap, and every answer is cached on disk.
// UNVERIFIED: response format checked against documentation and examples only; not yet fetched
// live from the app (the build sandboxes cannot reach steamspy.com).
const fs = require('node:fs');
const path = require('node:path');

const STORY_TAGS = ['Visual Novel', 'Story Rich', 'Interactive Fiction', 'Choose Your Own Adventure',
  'Dating Sim', 'Otome'];
const ENDPOINT = (appid) => `https://steamspy.com/api.php?request=appdetails&appid=${appid}`;

/**
 * Tag names from a SteamSpy appdetails reply. SteamSpy sends an object of tag -> votes, and an
 * empty array when a game has no tags; arrays of names or {name} objects are accepted too.
 */
function tagNames(reply) {
  const t = reply && reply.tags;
  if (Array.isArray(t)) return t.map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
  if (t && typeof t === 'object') return Object.keys(t);
  return [];
}

/** 'story' when any tag is a story tag, otherwise 'other'. */
function classify(names) {
  const want = new Set(STORY_TAGS.map((s) => s.toLowerCase()));
  return names.some((n) => want.has(String(n).trim().toLowerCase())) ? 'story' : 'other';
}

/**
 * createTagCheck({file, fetch?, now?, gapMs?, ttlMs?, retryMs?, timeoutMs?})
 *   known(appid) -> 'story' | 'other' | undefined   (from the cache, no network)
 *   lookup(appids) -> Promise<Map<appid, 'story'|'other'|'unknown'>>   (fetches what is missing)
 */
function createTagCheck(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const gapMs = opts.gapMs === undefined ? 1100 : opts.gapMs;
  const ttlMs = opts.ttlMs || 30 * 24 * 3600 * 1000;   // tags rarely change
  const retryMs = opts.retryMs || 10 * 60 * 1000;      // after a failed lookup
  const timeoutMs = opts.timeoutMs || 10000;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(opts.file, 'utf8')) || {}; } catch { /* first run */ }
  const failedAt = new Map();
  let chain = Promise.resolve();
  let lastCall = 0;

  function save() {
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      const tmp = opts.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, opts.file);
    } catch { /* the cache is a speed-up, not a requirement */ }
  }

  function known(appid) {
    const hit = cache[appid];
    return hit && now() - hit.at < ttlMs ? hit.kind : undefined;
  }

  async function fetchOne(appid) {
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(ENDPOINT(appid), { headers: { Accept: 'application/json' }, signal: ctrl && ctrl.signal });
      if (!res.ok) throw new Error('SteamSpy ' + res.status);
      const reply = await res.json();
      // SteamSpy answers unknown ids with an empty record; treat "no name" as no data.
      if (!reply || (!reply.name && !tagNames(reply).length)) throw new Error('no data');
      const names = tagNames(reply);
      const kind = classify(names);
      cache[appid] = { kind, at: now(), tags: names.slice(0, 20) };
      save();
      return kind;
    } catch {
      failedAt.set(appid, now());
      return 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function lookup(appids) {
    const out = new Map();
    const todo = [];
    for (const id of new Set(appids.map(String))) {
      const k = known(id);
      if (k) out.set(id, k);
      else if (failedAt.has(id) && now() - failedAt.get(id) < retryMs) out.set(id, 'unknown');
      else todo.push(id);
    }
    if (!todo.length) return Promise.resolve(out);
    // One queue for the whole app, so two rescans never double the request rate.
    const run = chain.then(async () => {
      for (const id of todo) out.set(id, known(id) || await fetchOne(id));
      return out;
    });
    chain = run.catch(() => {});
    return run;
  }

  return { known, lookup };
}

module.exports = { createTagCheck, tagNames, classify, STORY_TAGS, ENDPOINT };
