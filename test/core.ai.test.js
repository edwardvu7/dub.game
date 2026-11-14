'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const profiler = require('../main/profiler');
const tts = require('../main/tts');
const catalog = require('../voices_catalog.json');

const KEY = 'test-key-not-real';
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });
const gemini = (obj) => jsonRes(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
function recorder(respond) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null }); return respond(calls.length); };
  fn.calls = calls;
  return fn;
}

test('catalog: about 12 unique, well-formed voices', () => {
  assert.ok(catalog.length >= 10 && catalog.length <= 14);
  assert.equal(new Set(catalog.map((v) => v.voice_id)).size, catalog.length);
  for (const v of catalog) {
    assert.match(v.voice_id, /^[A-Za-z0-9]{20}$/);
    assert.ok(v.name && v.description);
  }
  assert.ok(catalog.some((v) => /narrator/i.test(v.description)));
});

test('profiler: request shape (model, header, JSON mode, schema with catalog enum)', async () => {
  const fetch = recorder(() => gemini({ speaker: 'Sylvie', gender: 'female', age_range: 'young_adult',
    personality: 'Shy.', voice_id: catalog[1].voice_id, stability: 0.45, style: 0.3, speed: 1.0, reason: 'Soft.' }));
  const profile = await profiler.profileCharacter({ speaker: 'Sylvie', samples: ['Um... hi.'] }, catalog, KEY, { fetch });

  const call = fetch.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-goog-api-key'], KEY);
  assert.ok(!call.url.includes(KEY), 'key travels in a header, not the URL');
  const cfg = call.body.generationConfig;
  assert.equal(cfg.responseMimeType, 'application/json');
  assert.deepEqual(cfg.responseSchema.properties.voice_id.enum, catalog.map((v) => v.voice_id));
  assert.deepEqual(cfg.responseSchema.properties.gender.enum, ['female', 'male', 'neutral']);
  assert.deepEqual(cfg.responseSchema.required.sort(),
    ['age_range', 'gender', 'personality', 'reason', 'speaker', 'speed', 'stability', 'style', 'voice_id']);
  const prompt = call.body.contents[0].parts[0].text;
  assert.ok(prompt.includes('Sylvie') && prompt.includes('Um... hi.'));
  for (const v of catalog) assert.ok(prompt.includes(v.voice_id) && prompt.includes(v.description));

  assert.deepEqual(profile, { speaker: 'Sylvie', gender: 'female', age_range: 'young_adult', personality: 'Shy.',
    voice_id: catalog[1].voice_id, stability: 0.45, style: 0.3, speed: 1, reason: 'Soft.', locked: false, source: 'gemini' });
});

test('profiler: output is forced into the contract (bad voice_id, ranges, enums, speaker)', async () => {
  const fetch = recorder(() => gemini({ speaker: 'Someone Else', gender: 'robot', age_range: 'ancient',
    voice_id: 'not-in-catalog', stability: 7, style: -1, speed: 3, locked: true }));
  const p = await profiler.profileCharacter({ speaker: 'Rin', samples: [] }, catalog, KEY, { fetch });
  assert.equal(p.speaker, 'Rin');
  assert.ok(catalog.some((v) => v.voice_id === p.voice_id));
  assert.deepEqual([p.gender, p.age_range, p.stability, p.style, p.speed, p.locked],
    ['neutral', 'adult', 1, 0, 1.2, false]);
});

test('profiler: batch profiles a cast in one call; errors are readable and never contain the key', async () => {
  const cast = [{ speaker: 'A', samples: ['x'] }, { speaker: 'B', samples: [] }, { speaker: 'C', samples: [] }];
  const fetch = recorder(() => gemini({ profiles: [
    { speaker: 'B', voice_id: catalog[2].voice_id }, { speaker: 'a', voice_id: catalog[3].voice_id }] }));
  const out = await profiler.profileCharacters(cast, catalog, KEY, { fetch });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.generationConfig.responseSchema.properties.profiles.type, 'ARRAY');
  assert.deepEqual(out.map((p) => [p.speaker, p.voice_id]), [['A', catalog[3].voice_id], ['B', catalog[2].voice_id]]);

  const big = Array.from({ length: 30 }, (_, i) => ({ speaker: 'N' + i, samples: [] }));
  const many = recorder(() => gemini({ profiles: [] }));
  await profiler.profileCharacters(big, catalog, KEY, { fetch: many });
  assert.equal(many.calls.length, 3, '12 per call');

  const failing = recorder(() => jsonRes(429, { error: { message: 'Quota exceeded' } }));
  await assert.rejects(() => profiler.profileCharacter(cast[0], catalog, KEY, { fetch: failing }),
    (e) => /Gemini 429: Quota exceeded/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(() => profiler.profileCharacter(cast[0], catalog, '', { fetch: failing }), /No Gemini API key/);
  const junk = recorder(() => jsonRes(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }));
  await assert.rejects(() => profiler.profileCharacter(cast[0], catalog, KEY, { fetch: junk }), /invalid JSON/);
});

test('profiler: fallback profile is deterministic and marked', () => {
  const a = profiler.fallbackProfile('Mika', catalog);
  assert.deepEqual(a, profiler.fallbackProfile('Mika', catalog));
  assert.equal(a.source, 'fallback');
  assert.ok(catalog.some((v) => v.voice_id === a.voice_id));
});

test('tts: request shape (URL, xi-api-key, flash model, clamped settings) and Buffer result', async () => {
  const bytes = Uint8Array.from([0x49, 0x44, 0x33, 1, 2]);
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }; };
  const audio = await tts.speak({ text: 'Hi!', voice_id: 'EXAVITQu4vr4xnSDxMaL', stability: 0.4, style: 0.2, speed: 5 }, KEY, { fetch });
  assert.ok(Buffer.isBuffer(audio));
  assert.deepEqual([...audio], [...bytes]);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128');
  assert.equal(calls[0].init.headers['xi-api-key'], KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hi!', model_id: 'eleven_flash_v2_5',
    voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2, speed: 1.2 } });
});

test('tts: errors are readable; missing key and bad voice ids are refused before any request', async () => {
  let called = 0;
  const fetch = async () => { called++; return { ok: false, status: 401,
    text: async () => JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }) }; };
  await assert.rejects(() => tts.speak({ text: 'x', voice_id: 'abc' }, KEY, { fetch }),
    (e) => e.message === 'ElevenLabs 401: Invalid API key');
  await assert.rejects(() => tts.speak({ text: 'x', voice_id: 'abc' }, '', { fetch }), /No ElevenLabs API key/);
  await assert.rejects(() => tts.speak({ text: 'x', voice_id: '../v1/user' }, KEY, { fetch }), /bad voice_id/);
  assert.equal(called, 1);
});

test('testKey: ok, restricted-but-valid, invalid, offline', async () => {
  const res = (status, detail) => ({ ok: status === 200, status, text: async () => JSON.stringify({ detail }), json: async () => ({ error: { message: 'API key not valid' } }) });
  assert.deepEqual(await tts.testKey(KEY, { fetch: async () => res(200) }), { ok: true });
  assert.deepEqual(await tts.testKey(KEY, { fetch: async () => res(401, { status: 'missing_permissions', message: 'missing_permissions: user_read' }) }), { ok: true });
  assert.deepEqual(await tts.testKey(KEY, { fetch: async () => res(401, { status: 'invalid_api_key', message: 'Invalid API key' }) }),
    { ok: false, error: 'ElevenLabs 401: Invalid API key' });
  const offline = await tts.testKey(KEY, { fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(offline.ok, false);
  assert.deepEqual(await profiler.testKey(KEY, { fetch: async () => res(200) }), { ok: true });
  assert.deepEqual(await profiler.testKey(KEY, { fetch: async () => res(400) }), { ok: false, error: 'Gemini 400: API key not valid' });
  assert.equal((await profiler.testKey('', {})).ok, false);
});

test('tts.subscription: reads the plan quota, and explains a key without permission', async () => {
  const { subscription } = require('../main/tts');
  const ok = await subscription('k', { fetch: async (url) => {
    assert.match(url, /\/v1\/user\/subscription$/);
    return { ok: true, json: async () => ({ character_count: 1200, character_limit: 10000, next_character_count_reset_unix: 1796000000, tier: 'free' }) };
  } });
  assert.deepEqual(ok, { ok: true, used: 1200, limit: 10000, tier: 'free', resetAt: 1796000000000 });
  const denied = await subscription('k', { fetch: async () => ({ ok: false, status: 401,
    text: async () => JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing_permissions' } }) }) });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /User: read/);
  assert.equal((await subscription('')).ok, false);
});

test('profiler: a failed later batch keeps the batches that worked; calls carry a timeout', async () => {
  const { profileCharacters } = require('../main/profiler');
  const cast = Array.from({ length: 14 }, (_, i) => ({ speaker: 'C' + i, samples: [] }));
  let n = 0;
  const fetchStub = async (_url, init) => {
    assert.ok(init.signal, 'request has an abort signal');
    if (++n === 2) return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) };
    const names = cast.slice(0, 12).map((c) => c.speaker);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      profiles: names.map((speaker) => ({ speaker, voice_id: catalog[0].voice_id })) }) }] } }] }) };
  };
  const out = await profileCharacters(cast, catalog, 'k', { fetch: fetchStub });
  assert.equal(out.length, 12);
  await assert.rejects(() => profileCharacters(cast.slice(0, 2), catalog, 'k',
    { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), /Gemini 500/);
});

test('cache.prune removes only clips not played recently; a cache hit counts as played', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const { createCache } = require('../main/cache');
  const dir = path.join(require('./helpers').tmpDir(), 'cache');
  const cache = createCache({ dir });
  const a = { voice_id: 'v', stability: 0.5, style: 0, speed: 1, text: 'old', model: 'm' };
  const b = { ...a, text: 'old but replayed' };
  cache.put(a, Buffer.from('1')); cache.put(b, Buffer.from('2'));
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), longAgo, longAgo);
  cache.get(b);
  assert.equal(cache.prune(60 * 24 * 3600 * 1000), 1);
  assert.equal(cache.get(a), null);
  assert.equal(cache.get(b).toString(), '2');
});
