'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOverlayPosition } = require('../main/overlay-position');

const screenA = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const screenB = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test('nothing saved: no position, so main uses the left-edge default', () => {
  const pos = createOverlayPosition({ file: path.join(os.tmpdir(), 'nope-' + Date.now() + '.json') });
  assert.strictEqual(pos.place(screenA, 340, 600), null);
});

test('remembers one spot per screen and survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dub-')), 'overlay-position.json');
  createOverlayPosition({ file }).remember(screenB, { x: 1920 + 500, y: 100, width: 340, height: 600 });
  const pos = createOverlayPosition({ file });
  assert.deepStrictEqual(pos.place(screenB, 340, 600), { x: 2420, y: 100 });
  assert.strictEqual(pos.place(screenA, 340, 600), null);
});

test('a spot that no longer fits (smaller resolution) is pulled back on screen', () => {
  const pos = createOverlayPosition({});
  pos.remember(screenB, { x: 1920 + 2200, y: 1300, width: 340, height: 600 });
  const smaller = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } };
  assert.deepStrictEqual(pos.place(smaller, 340, 600), { x: 1920 + 1280 - 340, y: 120 });
});

test('a broken file is ignored', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dub-')), 'overlay-position.json');
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(createOverlayPosition({ file }).place(screenA, 340, 600), null);
});
