'use strict';
// Audio cache: every spoken line is paid for once. Files live in userData/cache/<sha1>.mp3.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function cacheKey({ voice_id, stability, style, speed, text, model }) {
  const settings = [Number(stability).toFixed(2), Number(style).toFixed(2), Number(speed).toFixed(2)].join('|');
  return crypto.createHash('sha1').update([voice_id, model || '', settings, text].join('\n')).digest('hex');
}

/** createCache({dir}) -> {get(params), put(params, buffer), key(params)} */
function createCache({ dir }) {
  const fileFor = (params) => path.join(dir, cacheKey(params) + '.mp3');
  return {
    key: cacheKey,
    get(params) {
      try {
        const file = fileFor(params);
        const buf = fs.readFileSync(file);
        if (!buf.length) return null;
        try { fs.utimesSync(file, new Date(), new Date()); } catch { /* read-only cache still plays */ }
        return buf;
      } catch { return null; }
    },
    /** Delete clips not played for maxAgeMs. Run once at startup so the cache cannot grow forever. */
    prune(maxAgeMs, now = Date.now()) {
      let removed = 0;
      try {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed++; }
        }
      } catch { /* no cache yet */ }
      return removed;
    },
    put(params, buffer) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = fileFor(params);
        fs.writeFileSync(file + '.tmp', buffer);
        fs.renameSync(file + '.tmp', file);
      } catch { /* a cache that cannot write is only slower */ }
    },
  };
}

module.exports = { createCache, cacheKey };
