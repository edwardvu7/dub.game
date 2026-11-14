'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFullscreenCheck, parseState } = require('../main/fullscreen');

test('parseState maps Windows notification states', () => {
  assert.equal(parseState('3\r\n'), 'exclusive');
  assert.equal(parseState('2'), 'fullscreen');
  assert.equal(parseState('7'), 'fullscreen');
  assert.equal(parseState('5'), 'windowed');
  assert.equal(parseState(''), 'unknown');
  assert.equal(parseState('nonsense'), 'unknown');
  assert.equal(parseState('99'), 'unknown');
});

test('off Windows it answers unknown without running anything', async () => {
  let ran = false;
  const check = createFullscreenCheck({ platform: 'darwin', execFile: () => { ran = true; } });
  assert.equal(await check(), 'unknown');
  assert.equal(ran, false);
});

test('on Windows: runs PowerShell once, caches, and shares an in-flight call', async () => {
  let t = 0;
  const runs = [];
  const execFile = (cmd, args, opts, cb) => { runs.push({ cmd, args, opts }); setTimeout(() => cb(null, '3\r\n'), 5); };
  const check = createFullscreenCheck({ platform: 'win32', execFile, now: () => t, cacheMs: 1000 });
  const [a, b] = await Promise.all([check(), check()]);
  assert.equal(a, 'exclusive');
  assert.equal(b, 'exclusive');
  assert.equal(runs.length, 1, 'two checks at once share one PowerShell call');
  assert.equal(runs[0].cmd, 'powershell.exe');
  assert.equal(runs[0].opts.windowsHide, true, 'no console window flashes over the game');
  const encoded = runs[0].args[runs[0].args.indexOf('-EncodedCommand') + 1];
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /SHQueryUserNotificationState/);
  assert.equal(await check(), 'exclusive');
  assert.equal(runs.length, 1, 'cached');
  t += 2000;
  await check();
  assert.equal(runs.length, 2, 'cache expires');
});

test('errors and crashes become unknown, never a rejection', async () => {
  const failing = createFullscreenCheck({ platform: 'win32', execFile: (c, a, o, cb) => cb(new Error('timeout')) });
  assert.equal(await failing(), 'unknown');
  const throwing = createFullscreenCheck({ platform: 'win32', execFile: () => { throw new Error('ENOENT'); } });
  assert.equal(await throwing(), 'unknown');
});
