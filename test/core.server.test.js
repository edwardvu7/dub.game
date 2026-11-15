'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../main/server');

async function withServer(handlers, fn) {
  const s = createServer(handlers);
  const addr = await s.listen(0, '127.0.0.1');
  try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await s.close(); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 20));

test('server: POST /line replies 204 and emits a normalized line', async () => {
  const lines = [];
  await withServer({ onLine: (l) => lines.push(l) }, async (base) => {
    const res = await post(base + '/line', { speaker: ' Sylvie ', text: ' Hi! ', seq: 3 });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    await post(base + '/line', { text: 'No speaker here.', engine: 'godot', source: '/root/Label' });
    await tick();
  });
  assert.deepEqual(lines, [
    { speaker: 'Sylvie', text: 'Hi!', engine: 'renpy', seq: 3 },
    { speaker: 'Narrator', text: 'No speaker here.', engine: 'godot', source: '/root/Label' },
  ]);
});

test('server: replies before a slow handler finishes, and survives a throwing handler', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let finished = false;
  const logs = [];
  await withServer({
    log: (m) => logs.push(m),
    onLine: async () => { await gate; finished = true; },
    onCharacters: () => { throw new Error('boom'); },
  }, async (base) => {
    const res = await post(base + '/line', { speaker: 'A', text: 'slow' });
    assert.equal(res.status, 204);
    assert.equal(finished, false, 'the game got its reply while processing was still running');
    release();
    assert.equal((await post(base + '/characters', { characters: [] })).status, 204);
    await tick();
    assert.equal((await post(base + '/line', { speaker: 'A', text: 'still alive' })).status, 204);
  });
  assert.ok(logs.some((m) => m.includes('boom')));
});

test('server: POST /characters cleans the list', async () => {
  const got = [];
  await withServer({ onCharacters: (p) => got.push(p) }, async (base) => {
    const res = await post(base + '/characters', { characters: [
      { speaker: 'Sylvie', samples: ['a', '', 5, 'b'] }, { speaker: 'Sylvie' }, { nope: 1 }, { speaker: 'Me' }] });
    assert.equal(res.status, 204);
    await tick();
  });
  assert.deepEqual(got, [{ engine: 'renpy', characters: [
    { speaker: 'Sylvie', samples: ['a', 'b'] }, { speaker: 'Me', samples: [] }] }]);
});

test('server: /stop, empty text, bad input and other routes', async () => {
  const stops = [];
  const lines = [];
  await withServer({ onStop: (s) => stops.push(s), onLine: (l) => lines.push(l) }, async (base) => {
    assert.equal((await post(base + '/stop', { engine: 'renpy', seq: 4 })).status, 204);
    assert.equal((await post(base + '/stop', '')).status, 204);
    assert.equal((await post(base + '/line', { speaker: 'A', text: '   ' })).status, 204);
    assert.equal((await post(base + '/line', '{not json')).status, 400);
    assert.equal((await post(base + '/line', { speaker: 'A' })).status, 400);
    assert.equal((await post(base + '/characters', { characters: 'x' })).status, 400);
    assert.equal((await post(base + '/nope', {})).status, 404);
    assert.equal((await fetch(base + '/line')).status, 405);
    assert.equal((await post(base + '/line', 'x'.repeat(1024 * 1024 + 10)).catch(() => ({ status: 413 }))).status, 413);
    const health = await fetch(base + '/health');
    assert.deepEqual(await health.json(), { ok: true, app: 'dubplay' });
    await tick();
  });
  assert.deepEqual(stops, [{ engine: 'renpy', seq: 4 }, { engine: 'renpy', seq: undefined }]);
  assert.deepEqual(lines, [], 'blank text is acknowledged but never spoken');
});

test('server: game id is passed on for per-game voices, and optional', () => {
  const { normalizeLine, normalizeCharacters } = require('../main/server');
  assert.equal(normalizeLine({ text: 'Hi', game: ' renpy:DDLC ' }).game, 'renpy:DDLC');
  assert.equal(normalizeLine({ text: 'Hi' }).game, undefined, 'old hooks still work');
  assert.equal(normalizeLine({ text: 'Hi', game: 42 }).game, undefined);
  assert.equal(normalizeCharacters({ game: 'godot:X', characters: [] }).game, 'godot:X');
});

test('server: hook diagnostics are bounded and malformed reports rejected', async () => {
  const reports = [];
  await withServer({ onGodotHook: x => reports.push(x) }, async base => {
    assert.equal((await post(base + '/godot/hook', { labels: [] })).status, 400);
    assert.equal((await post(base + '/godot/hook', { appid: 'x', token: 't', labels:
      Array.from({ length: 90 }, () => ({ path: '/root/X', text: 'a'.repeat(500), candidate: true })) })).status, 204);
    await tick();
  });
  assert.equal(reports[0].labels.length, 80);
  assert.equal(reports[0].labels[0].text.length, 120);
});

test('server: web pages are refused (Origin or foreign Host), and long lines are cut', async () => {
  const lines = [];
  await withServer({ onLine: (l) => lines.push(l) }, async (base) => {
    const evil = await fetch(base + '/line', { method: 'POST', headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'spend credits' }) });
    assert.equal(evil.status, 403);
    // fetch cannot set Host, so the rebinding case goes through http.request
    const status = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = require('node:http').request({ host: u.hostname, port: u.port, path: '/line', method: 'POST',
        headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{"text":"x"}');
    });
    assert.equal(status, 403);
    assert.equal((await post(base + '/line', { text: 'a'.repeat(5000) })).status, 204);
    await tick();
  });
  assert.equal(lines.length, 1, 'only the game hook request got through');
  assert.equal(lines[0].text.length, 2000);
});
