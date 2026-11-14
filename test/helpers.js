'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir(prefix = 'dubgame-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const vdfPath = (p) => p.replace(/\\/g, '\\\\');

function manifest(appid, name, installdir) {
  return `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"${name}"\n` +
    `\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"${installdir}"\n\t"UserConfig"\n\t{\n\t\t"language"\t\t"english"\n\t}\n}\n`;
}

/**
 * Fake Steam install: main library (Ren'Py game 1001, Unity game 1002) and a second library
 * on "another drive" (Ren'Py game 2001, Godot game 2002, RPG Maker MZ game 2003).
 */
function fakeSteam() {
  const root = tmpDir('dubgame-steam-');
  const steam = path.join(root, 'Steam');
  const lib2 = path.join(root, 'SteamLibrary2');
  const common1 = path.join(steam, 'steamapps', 'common');
  const common2 = path.join(lib2, 'steamapps', 'common');

  write(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steam)}"\n\t\t"label"\t\t""\n` +
    `\t\t"apps"\n\t\t{\n\t\t\t"1001"\t\t"123"\n\t\t}\n\t}\n` +
    `\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(lib2)}"\n\t}\n}\n`);

  write(path.join(steam, 'steamapps', 'appmanifest_1001.acf'), manifest(1001, 'Sakura Demo VN', 'SakuraDemo'));
  write(path.join(common1, 'SakuraDemo', 'renpy', '__init__.py'));
  write(path.join(common1, 'SakuraDemo', 'game', 'script.rpyc'));
  write(path.join(common1, 'SakuraDemo', 'SakuraDemo.exe'));

  write(path.join(steam, 'steamapps', 'appmanifest_1002.acf'), manifest(1002, 'Unity Thing', 'UnityThing'));
  write(path.join(common1, 'UnityThing', 'UnityPlayer.dll'));
  write(path.join(common1, 'UnityThing', 'UnityThing.exe'));
  write(path.join(common1, 'UnityThing', 'UnityThing_Data', 'globalgamemanagers'));

  write(path.join(lib2, 'steamapps', 'appmanifest_2001.acf'), manifest(2001, 'Archive VN', 'ArchiveVN'));
  write(path.join(common2, 'ArchiveVN', 'renpy', 'common', '00start.rpy'));
  write(path.join(common2, 'ArchiveVN', 'game', 'archive.rpa'));

  write(path.join(lib2, 'steamapps', 'appmanifest_2002.acf'), manifest(2002, 'Godot Story', 'GodotStory'));
  write(path.join(common2, 'GodotStory', 'GodotStory.exe'));
  write(path.join(common2, 'GodotStory', 'GodotStory.pck'));

  write(path.join(lib2, 'steamapps', 'appmanifest_2003.acf'), manifest(2003, 'RPG Thing', 'RPGThing'));
  write(path.join(common2, 'RPGThing', 'js', 'rmmz_core.js'));

  // A manifest whose game folder is gone must not break the scan.
  write(path.join(lib2, 'steamapps', 'appmanifest_2004.acf'), manifest(2004, 'Ghost', 'Ghost'));
  // A broken manifest must not break the scan either.
  write(path.join(lib2, 'steamapps', 'appmanifest_2005.acf'), '"AppState" { "appid" ');

  return { root, steam, lib2, common1, common2 };
}

module.exports = { tmpDir, write, fakeSteam, manifest };
