'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vdf = require('../main/steam/vdf');

test('vdf: parses nested blocks, escapes and comments', () => {
  const out = vdf.parse(`
    // a comment
    "libraryfolders"
    {
      "0"
      {
        "path"    "C:\\\\Program Files (x86)\\\\Steam"
        "apps" { "228980" "1024" }
      }
      "1" { "path" "D:\\\\Games \\"Quoted\\"" }
    }`);
  assert.equal(out.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.equal(out.libraryfolders['0'].apps['228980'], '1024');
  assert.equal(out.libraryfolders['1'].path, 'D:\\Games "Quoted"');
});

test('vdf: bare tokens, BOM and old flat library format', () => {
  const out = vdf.parse('\uFEFFLibraryFolders { TimeNextStatsReport 123 "1" "D:\\\\SteamLibrary" }');
  assert.equal(out.LibraryFolders.TimeNextStatsReport, '123');
  assert.equal(out.LibraryFolders['1'], 'D:\\SteamLibrary');
});

test('vdf: malformed input throws instead of returning garbage', () => {
  assert.throws(() => vdf.parse('"a" { "b" "c"'));
  assert.throws(() => vdf.parse('"a" }'));
  assert.throws(() => vdf.parse('"lonely"'));
  assert.deepEqual(vdf.parse(''), {});
});
