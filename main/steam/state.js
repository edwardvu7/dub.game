'use strict';
// Persists which games are ticked and which extra folders the player added (userData/games.json).
const fs = require('node:fs');
const path = require('node:path');

function createState({ file }) {
  let data = { enabled: [], folders: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      enabled: Array.isArray(raw.enabled) ? raw.enabled.map(String) : [],
      folders: Array.isArray(raw.folders) ? raw.folders.map(String) : [],
    };
  } catch { /* first launch or unreadable file: start empty */ }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    isEnabled: (appid) => data.enabled.includes(String(appid)),
    setEnabled(appid, on) {
      const id = String(appid);
      data.enabled = data.enabled.filter((x) => x !== id);
      if (on) data.enabled.push(id);
      save();
    },
    folders: () => data.folders.slice(),
    addFolder(dir) {
      if (!data.folders.includes(dir)) { data.folders.push(dir); save(); }
    },
    removeFolder(dir) {
      data.folders = data.folders.filter((x) => x !== dir);
      save();
    },
  };
}

module.exports = { createState };
