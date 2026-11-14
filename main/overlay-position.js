'use strict';
// Remembers where the player dragged the overlay, one spot per screen, and keeps it on screen.
// Positions are stored relative to the screen's work area, so they survive a resolution change.
const fs = require('node:fs');
const path = require('node:path');

function displayKey(display) {
  if (display && display.id != null) return String(display.id);
  const a = display.workArea;
  return `${a.x},${a.y},${a.width},${a.height}`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function createOverlayPosition({ file } = {}) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { saved = {}; }

  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(saved, null, 2)); } catch { /* best effort */ }
  }

  return {
    /** The saved top-left for this screen, kept fully on it, or null when there is none. */
    place(display, width, height) {
      const spot = saved[displayKey(display)];
      if (!spot || !Number.isFinite(spot.dx) || !Number.isFinite(spot.dy)) return null;
      const a = display.workArea;
      return {
        x: a.x + clamp(Math.round(spot.dx), 0, Math.max(0, a.width - width)),
        y: a.y + clamp(Math.round(spot.dy), 0, Math.max(0, a.height - height)),
      };
    },
    /** Called after the player drags the overlay. */
    remember(display, bounds) {
      const a = display.workArea;
      saved[displayKey(display)] = { dx: bounds.x - a.x, dy: bounds.y - a.y };
      save();
    },
  };
}

module.exports = { createOverlayPosition, displayKey };

// All coordinates are Electron DIP, after converting the native game client rectangle.
function constrainToGame(area, desired = {}) {
  const width = Math.max(1, Math.min(Math.round(desired.width || 340), area.width));
  const height = Math.max(1, Math.min(Math.round(desired.height || 600), area.height));
  const x = Number.isFinite(desired.x) ? desired.x : area.x + 16;
  const y = Number.isFinite(desired.y) ? desired.y : area.y + (area.height - height) / 2;
  return { x: Math.round(clamp(x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - height)), width, height };
}
module.exports.constrainToGame = constrainToGame;
