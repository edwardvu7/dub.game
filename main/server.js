'use strict';
// Localhost server the game hooks talk to. Replies 204 at once, then hands the payload on:
// the game must never wait on Grok or ElevenLabs.
const http = require('node:http');
const { isCrowdName } = require('./godot-names');

const HOST = '127.0.0.1';
const PORT = 8000;
const MAX_BODY = 1024 * 1024;
const MAX_TEXT = 2000; // same cap as clipboard mode; ElevenLabs bills per character

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

// Stable id for per-game voices, e.g. "renpy:DDLC" (engine + game folder name). Hooks older than
// this field leave it out; the pipeline then uses the game that was active last.
function normalizeGame(body) {
  const g = body && typeof body.game === 'string' ? body.game.trim().slice(0, 200) : '';
  return g || undefined;
}

// Stable per-character id from the hook (Ren'Py character tag/variable: "s", "mc"); anything else is ignored.
const normalizeId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : undefined);

function normalizeLine(body) {
  if (!body || typeof body.text !== 'string') return null;
  const text = body.text.trim().slice(0, MAX_TEXT);
  if (!text) return null;
  const speaker = typeof body.speaker === 'string' && body.speaker.trim() ? body.speaker.trim() : 'Narrator';
  const line = { speaker, text, engine: typeof body.engine === 'string' && body.engine ? body.engine : 'renpy' };
  if (typeof body.source === 'string') line.source = body.source;
  const game = normalizeGame(body);
  if (game) line.game = game;
  const id = normalizeId(body.speaker_id);
  if (id) line.speaker_id = id;
  if (Number.isFinite(body.seq)) line.seq = body.seq;
  // The next lines of the script (Ren'Py only), so Grok can direct them before they are reached.
  if (Array.isArray(body.upcoming)) {
    line.upcoming = body.upcoming.slice(0, 20)
      .filter((u) => u && typeof u.text === 'string' && u.text.trim())
      .map((u) => ({ speaker: typeof u.speaker === 'string' && u.speaker.trim() ? u.speaker.trim().slice(0, 100) : 'Narrator',
        text: u.text.trim().slice(0, 300) }));
  }
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
    const id = normalizeId(c.id);
    characters.push(id ? { id, speaker, samples } : { speaker, samples });
  }
  const engine = typeof body.engine === 'string' && body.engine ? body.engine : 'renpy';
  const out = { engine, characters: engine === 'godot' ? characters.filter((c) => !isCrowdName(c.speaker)) : characters };
  const game = normalizeGame(body);
  if (game) out.game = game;
  return out;
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
    // Browsers send Origin on cross-site requests and game hooks never do: keeps web pages out.
    // The Host check stops a site that points its own domain at 127.0.0.1 (DNS rebinding).
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) {
      return end(403, { error: 'local game hooks only' });
    }
    if (req.method === 'GET' && (url === '/' || url === '/health')) return end(200, { ok: true, app: 'dubplay' });
    if (req.method !== 'POST') return end(405, { error: 'POST only' });
    if (!['/line', '/characters', '/stop', '/godot/hook'].includes(url)) return end(404, { error: 'unknown path' });

    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return end(e.status || 400, { error: e.status ? e.message : 'invalid JSON' });
    }
    if (url === '/godot/hook') {
      if (!body || typeof body.appid !== 'string' || typeof body.token !== 'string' ||
          !Array.isArray(body.labels)) return end(400, { error: 'Invalid hook report' });
      const report = { appid: body.appid.slice(0, 1024), token: body.token.slice(0, 100),
        version: body.version, selectedPath: String(body.selectedPath || '').slice(0, 1024),
        limitReached: body.limitReached === true,
        labels: body.labels.slice(0, 80).filter(x => x && typeof x.path === 'string' && typeof x.text === 'string')
          .map(x => ({ path: x.path.slice(0, 1024), text: x.text.slice(0, 120), candidate: x.candidate === true })) };
      end(204);
      later(handlers.onGodotHook, report);
    } else if (url === '/line') {
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

module.exports = { createServer, normalizeLine, normalizeCharacters, normalizeGame, HOST, PORT };
