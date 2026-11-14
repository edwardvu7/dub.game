'use strict';
// Tiny .env reader for development keys (ELEVENLABS_API_KEY, GEMINI_API_KEY). No dependency.
const fs = require('node:fs');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    out[key] = value;
  }
  return out;
}

/** loadEnv(file, target = process.env): existing variables win over the file. */
function loadEnv(file, target = process.env) {
  let parsed = {};
  try { parsed = parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  for (const [k, v] of Object.entries(parsed)) {
    if (target[k] === undefined || target[k] === '') target[k] = v;
  }
  return parsed;
}

module.exports = { parseEnv, loadEnv };
