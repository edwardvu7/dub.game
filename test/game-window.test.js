'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createGameWindowTracker, validFrame } = require('../main/game-window');
const { constrainToGame } = require('../main/overlay-position');

test('overlay is constrained on negative-origin monitors and shrinks to a small client', () => {
  assert.deepEqual(constrainToGame({ x: -1920, y: -200, width: 1920, height: 1080 },
    { x: 500, y: -500, width: 340, height: 600 }), { x: -340, y: -200, width: 340, height: 600 });
  assert.deepEqual(constrainToGame({ x: 20, y: 50, width: 200, height: 100 }),
    { x: 20, y: 50, width: 200, height: 100 });
});

test('frame validation excludes invalid dimensions and incomplete focus state', () => {
  assert.equal(validFrame({ x: 0, y: 0, width: 1920, height: 1080, focused: true, minimized: false }), true);
  assert.equal(validFrame({ x: 0, y: 0, width: 0, height: 0 }), false);
});

test('worker tracks only current game, handles split output, and stops on exit', () => {
  const children = [], frames = [], errors = [], calls = [];
  const tracker = createGameWindowTracker({ platform: 'win32', onFrame: f => frames.push(f),
    onError: e => errors.push(e), spawnWorker: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.kill = () => { c.killed = true; }; children.push(c); return c;
    } });
  tracker.start({ appid: 'a', installDir: 'C:\\Games\\A' }, 123);
  assert.equal(calls[0].opts.env.DUB_TRACK_PID, '123');
  assert.equal(calls[0].opts.env.DUB_TRACK_DIR, 'C:\\Games\\A');
  const frame = { x: -100, y: 20, width: 800, height: 600, focused: true, minimized: false };
  const json = JSON.stringify(frame);
  children[0].stdout.emit('data', json.slice(0, 20));
  children[0].stdout.emit('data', json.slice(20) + '\n');
  assert.equal(frames.at(-1).gameId, 'a');
  tracker.start({ appid: 'b', installDir: 'C:\\Games\\B' });
  assert.equal(children[0].killed, true);
  children[0].stdout.emit('data', json + '\n');
  assert.equal(frames.at(-1), null);
  children[1].stdout.emit('data', JSON.stringify({ ...frame, minimized: true }) + '\n');
  assert.equal(frames.at(-1).minimized, true);
  children[1].emit('exit', 0);
  assert.equal(frames.at(-1), null);
  assert.deepEqual(errors, []);
});

test('unsupported platform hides game overlay rather than guessing screen bounds', () => {
  const frames = [], errors = [];
  createGameWindowTracker({ platform: 'linux', onFrame: f => frames.push(f), onError: e => errors.push(e) })
    .start({ installDir: '/games/a' });
  assert.deepEqual(frames, [null]);
  assert.match(errors[0], /Windows/);
});

test('worker failure clears its frame and reports an error', () => {
  let child;
  const frames = [], errors = [];
  const tracker = createGameWindowTracker({ platform: 'win32', onFrame: f => frames.push(f),
    onError: e => errors.push(e), spawnWorker: () => {
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => {}; return child;
    } });
  tracker.start({ appid: 'a', installDir: 'C:\\Games\\A' });
  child.stderr.emit('data', 'Access denied');
  child.emit('exit', 1);
  assert.equal(frames.at(-1), null);
  assert.match(errors[0], /Access denied/);
});
