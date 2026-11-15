'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { createVoiceStore } = require('../main/voices');
const { createCache } = require('../main/cache');
const { createPipeline, MAX_CUSTOM_PER_GAME } = require('../main/pipeline');
const { createVoiceDesigner, sanitizeDescription, voiceName, DESC_MAX, DESC_MIN } = require('../main/voice-design');
const profiler = require('../main/profiler');
const catalog = require('../voices_catalog.json');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeEl(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = replies[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}
const designer = (fetch, key = 'el-key') => createVoiceDesigner({ settings: { getKey: () => key }, fetch });

test('designer: design then create, headers and bodies', async () => {
  const { fetch, calls } = fakeEl([json(200, { previews: [{ generated_voice_id: 'gen1' }, { generated_voice_id: 'gen2' }], text: 't' }),
    json(200, { voice_id: 'NewVoice123' })]);
  const out = await designer(fetch).design({ description: 'A young woman with a soft Midwestern accent.', name: 'dub.game X - Y' });
  assert.deepEqual(out, { voice_id: 'NewVoice123', name: 'dub.game X - Y', description: 'A young woman with a soft Midwestern accent.' });
  assert.match(calls[0].url, /\/v1\/text-to-voice\/design/);
  assert.match(calls[1].url, /\/v1\/text-to-voice$/);
  assert.equal(calls[0].init.headers['xi-api-key'], 'el-key');
  assert.equal(calls[0].body.auto_generate_text, true);
  assert.deepEqual(calls[1].body, { voice_name: 'dub.game X - Y', voice_description: 'A young woman with a soft Midwestern accent.', generated_voice_id: 'gen1' });
});

test('designer: API errors are readable and keyless is refused', async () => {
  await assert.rejects(designer(async () => json(402, { detail: { message: 'Free users cannot use this' } })).design({ description: 'x', name: 'n' }),
    /ElevenLabs 402 during Voice Design \(step 1\/2\)\. ElevenLabs says: Free users cannot use this.*plan/);
  await assert.rejects(designer(async () => json(401, { detail: { status: 'invalid_api_key' } })).design({ description: 'x', name: 'n' }), /ElevenLabs refused Voice Design \(step 1\/2\) \(401\).*invalid_api_key/);
  const e403 = await designer(async () => json(403, { detail: { status: 'missing_permissions' } })).design({ description: 'x', name: 'n' }).catch((e) => e);
  assert.match(e403.message, /^Your ElevenLabs API key is not allowed to design voices \(403\)\. ElevenLabs says: missing_permissions\./);
  assert.match(e403.message, /Voice Generation and Voices \(write\)/);
  const plan403 = await designer(async () => json(403, { detail: { code: 'subscription_required', message: 'Upgrade' } })).design({ description: 'x', name: 'n' }).catch((e) => e);
  assert.match(plan403.message, /^ElevenLabs refused Voice Design \(step 1\/2\) \(403\)\. ElevenLabs says: subscription_required: Upgrade\..*plan includes Voice Design/);
  const step2 = await designer(async (u) => (/design/.test(u) ? json(200, { previews: [{ generated_voice_id: 'g' }] }) : json(403, { detail: { message: 'nope' } }))).design({ description: 'x', name: 'n' }).catch((e) => e);
  assert.match(step2.message, /refused saving the voice \(step 2\/2\) \(403\)\. ElevenLabs says: nope/);
  assert.equal(e403.hard, true);
  assert.equal((await designer(async () => json(500, {})).design({ description: 'x', name: 'n' }).catch((e) => e)).hard, false);
  await assert.rejects(designer(async () => json(422, { detail: [{ msg: 'too short' }] })).design({ description: 'x', name: 'n' }), /ElevenLabs 422 during Voice Design \(step 1\/2\): too short/);
  const t = new Error('t'); t.name = 'TimeoutError';
  await assert.rejects(designer(async () => { throw t; }).design({ description: 'x', name: 'n' }), /within 60 seconds/);
  await assert.rejects(designer(async () => json(200, { previews: [] })).design({ description: 'x', name: 'n' }), /no voice preview/);
  await assert.rejects(designer(async () => json(200, {}), '').design({ description: 'x' }), /No ElevenLabs API key/);
});

test('designer: description and name are sanitized and capped', () => {
  assert.equal(sanitizeDescription('a'.repeat(5000)).length, DESC_MAX);
  assert.ok(sanitizeDescription('hi').length >= DESC_MIN);
  assert.equal(sanitizeDescription('a  b\n c'), 'a b c Clear, natural speaking voice.');
  assert.ok(voiceName('G'.repeat(300), 'S').length <= 100);
  assert.equal(voiceName('The Question', 'Sylvie'), 'dub.game The Question - Sylvie');
});

test('profiler: voice description prompt, parser, fallback', async () => {
  const p = { speaker: 'Sylvie', gender: 'female', age_range: 'young_adult', personality: 'Shy.', origin: 'Japan' };
  assert.match(profiler.buildVoiceDescriptionPrompt(p, 'notes', 'rural Japan'), /rural Japan[\s\S]*Do NOT use a British/);
  assert.equal(profiler.parseVoiceDescription({ description: 'short' }), null);
  assert.equal(profiler.parseVoiceDescription({ description: 'x'.repeat(2000) }), null);
  assert.ok(profiler.parseVoiceDescription({ description: 'A calm young woman, soft voice.' }));
  const fb = profiler.fallbackVoiceDescription(p);
  assert.ok(fb.length >= 20 && /young adult woman/.test(fb) && /Japan/.test(fb));
  const bad = await profiler.voiceDescription(p, '', '', 'k', { fetch: async () => json(500, {}) });
  assert.equal(bad.source, 'fallback');
  const good = await profiler.voiceDescription(p, '', '', 'k', { fetch: async () => json(200, { output_text: '{"description":"A calm young woman with a soft voice."}' }) });
  assert.equal(good.source, 'grok');
});

function rig({ designFn, speakers = ['Sylvie'] } = {}) {
  const dir = tmpDir();
  const store = createVoiceStore({ file: path.join(dir, 'voices.json'), catalogIds: catalog.map((v) => v.voice_id) });
  const voices = store.forGame('g');
  for (const s of speakers) voices.setAuto({ speaker: s, gender: 'female', age_range: 'adult', personality: 'p', voice_id: catalog[0].voice_id, stability: 0.5, style: 0.3, speed: 1, reason: 'r', source: 'grok' });
  const events = [];
  let ai = 0;
  store.onChange((a) => events.push(a));
  const grokFetch = async () => json(200, { output_text: '{"description":"A calm young woman with a soft voice."}' });
  const pipeline = createPipeline({
    voices: store, cache: createCache({ dir: path.join(dir, 'c') }), catalog, usage: { recordAI: () => { ai++; } },
    settings: { getKey: () => 'k', narration: () => true }, emit: () => {}, fetch: grokFetch,
    designer: { design: designFn || (async ({ name }) => ({ voice_id: 'Custom' + Math.random().toString(36).slice(2, 8), name })) },
  });
  return { pipeline, voices, events, ai: () => ai };
}

test('customizeVoice: stores custom_voice, keeps preset and lock state, counts AI, emits change', async () => {
  const r = rig();
  const p = await r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  assert.equal(p.locked, false);
  assert.equal(p.voice_id, catalog[0].voice_id);
  assert.notEqual(p.voice_id, p.custom_voice.voice_id);
  assert.match(p.custom_voice.name, /^dub\.game .*Sylvie$/);
  assert.equal(p.custom_voice.description, 'A calm young woman with a soft voice.');
  assert.equal(r.ai(), 1);
  assert.ok(r.events.length >= 1);
  // survives a recast-style setAuto? locked, so untouched; and survives unlock + setAuto (re-roll)
  r.voices.unlock('Sylvie');
  const again = r.voices.setAuto({ speaker: 'Sylvie', voice_id: catalog[1].voice_id, source: 'grok' });
  assert.equal(again.custom_voice.voice_id, p.custom_voice.voice_id);
  // not settable through the UI patch path
  const upd = r.voices.update('Sylvie', { custom_voice: { voice_id: 'evil', name: 'x', description: 'y' } });
  assert.equal(upd.custom_voice.voice_id, p.custom_voice.voice_id);
});

test('customizeVoice: failure leaves the profile untouched; unknown character is refused', async () => {
  const r = rig({ designFn: async () => { throw new Error('ElevenLabs 402: nope'); } });
  const before = r.voices.get('Sylvie');
  await assert.rejects(r.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' }), /402/);
  assert.deepEqual(r.voices.get('Sylvie'), before);
  await assert.rejects(r.pipeline.customizeVoice({ game: 'g', speaker: 'Nobody' }), /Unknown character/);
});

test('customizeVoice: per-game cap and concurrency guard', async () => {
  const names = Array.from({ length: MAX_CUSTOM_PER_GAME + 1 }, (_, i) => 'C' + i);
  const r = rig({ speakers: names });
  for (const n of names.slice(0, MAX_CUSTOM_PER_GAME)) await r.pipeline.customizeVoice({ game: 'g', speaker: n });
  await assert.rejects(r.pipeline.customizeVoice({ game: 'g', speaker: names[MAX_CUSTOM_PER_GAME] }), /already has 8 custom voices/);
  await r.pipeline.customizeVoice({ game: 'g', speaker: 'C0' }); // redo is allowed at the cap

  let n = 0, release;
  const gate = new Promise((res) => { release = res; });
  const r2 = rig({ designFn: async () => { n++; await gate; return { voice_id: 'V1', name: 'n' }; } });
  const a = r2.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  const b = r2.pipeline.customizeVoice({ game: 'g', speaker: 'Sylvie' });
  await new Promise((res) => setTimeout(res, 10));
  release();
  await Promise.all([a, b]);
  assert.equal(n, 1);
});

test('voice design prompt: no minor-age words and no character or game names', () => {
  const d = sanitizeDescription('A teenage girl named Sayori from Doki Doki Literature Club, cheerful high-schooler, childlike giggle.',
    ['Sayori', 'Doki Doki Literature Club']);
  assert.doesNotMatch(d, /teen|girl|child|high-school|Sayori|Doki/i);
  assert.match(d, /young woman/);
  assert.equal(sanitizeDescription('Sayori is a bubbly teen.', ['Sayori']), 'This character is a bubbly young adult.');
  assert.equal(sanitizeDescription('A gravelly elderly man, slow and kind.'), 'A gravelly elderly man, slow and kind.', 'adults untouched');
  for (const age of ['child', 'teen']) {
    const fb = profiler.fallbackVoiceDescription({ gender: 'female', age_range: age, personality: 'Shy' });
    assert.doesNotMatch(fb, /teen|child/i);
    assert.match(fb, /young adult woman with a light, youthful voice/);
    assert.match(fb, /Shy\. Clear/, 'sentence ends before the pacing note');
  }
});

test('voice design errors: a key without Voice Generation permission says how to fix it', async () => {
  const designer = createVoiceDesigner({ settings: { getKey: () => 'k' },
    fetch: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ detail: { code: 'insufficient_permissions', message: 'The API key is missing the permission voice_generation' } }) }) });
  await assert.rejects(() => designer.design({ description: 'A calm man with a warm low voice.' }), (e) => {
    assert.equal(e.hard, true);
    assert.equal(e.code, 'insufficient_permissions');
    assert.match(e.message, /Voice Generation/);
    assert.match(e.message, /insufficient_permissions: The API key is missing/);
    return true;
  });
  const other = createVoiceDesigner({ settings: { getKey: () => 'k' },
    fetch: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ detail: { code: 'feature_not_available', message: 'Not on your plan' } }) }) });
  await assert.rejects(() => other.design({ description: 'A calm man with a warm low voice.' }), /feature_not_available: Not on your plan/);
});

test('quality: Best uses Multilingual v2 with speaker boost; designs ask for quality and an enhanced prompt', async () => {
  const tts = require('../main/tts');
  const fast = tts.buildRequest({ text: 'Hi', voice_id: 'abc' });
  const best = tts.buildRequest({ text: 'Hi', voice_id: 'abc', model: tts.BEST_MODEL });
  assert.equal(fast.body.model_id, 'eleven_flash_v2_5');
  assert.ok(!('use_speaker_boost' in fast.body.voice_settings));
  assert.equal(best.body.model_id, 'eleven_multilingual_v2');
  assert.equal(best.body.voice_settings.use_speaker_boost, true);
  assert.match(fast.url, /mp3_44100_128/);
  const { fetch, calls } = fakeEl([json(200, { previews: [{ generated_voice_id: 'g' }] }), json(200, { voice_id: 'V1' })]);
  await designer(fetch).design({ description: 'A calm man with a warm low voice.', name: 'n' });
  assert.equal(calls[0].body.should_enhance, true);
  assert.equal(calls[0].body.quality, 0.6);
  assert.equal(calls[0].body.loudness, 0.5);
});
