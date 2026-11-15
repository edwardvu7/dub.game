'use strict';
// Godot scene nodes are not speakers: a "Characters" folder also holds crowds and placeholders.
// Whole-word match after splitting CamelCase/underscores, so "StudentsInHallway" is a crowd but
// "Student Council" or "Crowley" are not. Add words here; plural/group words only, never first names.
const CROWD_WORDS = new Set(['students', 'classmates', 'customers', 'crowd', 'crowds', 'everyone',
  'everybody', 'voices', 'villagers', 'townspeople', 'people', 'audience', 'bystanders', 'passersby',
  'extras', 'mob', 'group', 'others', 'kids', 'children', 'background', 'placeholder',
  // UI/engine labels and walk-on extras. Not "path": it could be part of a real name.
  'npc', 'npcs', 'walking', 'passing', 'extra', 'settings', 'debanding', 'menu']);
const ENGINE_LABEL = /^[A-Z0-9]+(_[A-Z0-9]+)+$/; // SETTINGS_DEBANDING: a constant, not a person

function words(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isCrowdName(name) {
  return ENGINE_LABEL.test(String(name).trim()) || words(name).some((w) => CROWD_WORDS.has(w));
}

module.exports = { isCrowdName, CROWD_WORDS };
