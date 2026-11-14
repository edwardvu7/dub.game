'use strict';
// Minimal parser for Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf).
// Handles quoted and bare tokens, nested { } blocks, // comments and backslash escapes.
// Duplicate keys: the last one wins (enough for the files we read).

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '{' || c === '}') {
      tokens.push({ type: c });
      i++;
    } else if (c === '"') {
      let out = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          out += text[i++];
        }
      }
      i++; // closing quote
      tokens.push({ type: 'str', value: out });
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let out = '';
      while (i < n && !/[\s{}"]/.test(text[i])) out += text[i++];
      tokens.push({ type: 'str', value: out });
    }
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(String(text || '').replace(/^\uFEFF/, ''));
  let pos = 0;
  function block(top) {
    const obj = {};
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t.type === '}') {
        if (top) throw new Error('VDF: unexpected }');
        return obj;
      }
      if (t.type !== 'str') throw new Error('VDF: expected a key');
      const next = tokens[pos++];
      if (!next) throw new Error('VDF: key "' + t.value + '" has no value');
      if (next.type === '{') obj[t.value] = block(false);
      else if (next.type === 'str') obj[t.value] = next.value;
      else throw new Error('VDF: unexpected } after key "' + t.value + '"');
    }
    if (!top) throw new Error('VDF: missing }');
    return obj;
  }
  return block(true);
}

module.exports = { parse };
