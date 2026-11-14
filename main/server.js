'use strict';
// Localhost server the game hooks talk to. Replies 204 at once, then hands the payload on:
// the game must never wait on Gemini or ElevenLabs.
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = 8000;
const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeLine(body) {
  if (!body || typeof body.text !== 'string') return null;
  const text = body.text.trim();
  if (!text) return null;
  const speaker = typeof body.speaker === 'string' && body.speaker.trim() ? body.speaker.trim() : 'Narrator';
  const line = { speaker, text, engine: typeof body.engine === 'string' && body.engine ? body.engine : 'renpy' };
  if (typeof body.source === 'string') line.source = body.source;
  if (Number.isFinite(body.seq)) line.seq = body.seq;
  return line;
}

function normalizeCharacters(body) {
  if (!body || !Array.isArray(body.characters)) return null;
  const seen = new Set();
  const characters = [];
  for (const c of body.characters) {
    if (!c || typeof c.speaker !== 'string' || !c.speaker.trim()) continue;
    const speaker = c.speaker.trim();
    if (seen.has(speaker)) continue;
    seen.add(speaker);
    const samples = Array.isArray(c.samples)
      ? c.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8).map((s) => s.trim().slice(0, 300)) : [];
    characters.push({ speaker, samples });
  }
  return { engine: typeof body.engine === 'string' && body.engine ? body.engine : 'renpy', characters };
}

/**
 * createServer({onLine, onCharacters, onStop, log}) -> { listen(port?, host?), close(), server }
 * Handlers are called after the 204 has been sent; their errors are logged, never returned.
 */
function createServer(handlers = {}) {
  const log = handlers.log || (() => {});
  const later = (fn, arg) => {
    if (!fn) return;
    setImmediate(() => {
      try {
        const r = fn(arg);
        if (r && typeof r.catch === 'function') r.catch((e) => log('handler error: ' + (e && e.message)));
      } catch (e) { log('handler error: ' + (e && e.message)); }
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const end = (status, body) => {
      res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.method === 'GET' && (url === '/' || url === '/health')) return end(200, { ok: true, app: 'dub.game' });
    if (req.method !== 'POST') return end(405, { error: 'POST only' });
    if (!['/line', '/characters', '/stop'].includes(url)) return end(404, { error: 'unknown path' });

    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return end(e.status || 400, { error: e.status ? e.message : 'invalid JSON' });
    }
    if (url === '/line') {
      const line = normalizeLine(body);
      if (!line && !(body && typeof body.text === 'string')) return end(400, { error: 'text is required' });
      end(204);
      if (line) { log(`line  ${line.speaker}: ${line.text}`); later(handlers.onLine, line); }
    } else if (url === '/characters') {
      const payload = normalizeCharacters(body);
      if (!payload) return end(400, { error: 'characters must be an array' });
      end(204);
      log(`characters  ${payload.characters.map((c) => c.speaker).join(', ')}`);
      later(handlers.onCharacters, payload);
    } else {
      end(204);
      later(handlers.onStop, { engine: (body && body.engine) || 'renpy',
        seq: body && Number.isFinite(body.seq) ? body.seq : undefined });
    }
  });

  return {
    server,
    listen(port = PORT, host = HOST) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createServer, normalizeLine, normalizeCharacters, HOST, PORT };
