'use strict';
// Clipboard mode (stretch): Textractor copies each line of a non-Ren'Py game to the clipboard;
// this watcher feeds new text into the same pipeline as /line with speaker "unknown".
// UNVERIFIED: never run with a real Textractor session.

/**
 * createClipboardWatcher({readText, onLine, intervalMs?, timers?}) -> {start(), stop(), running()}
 * Drops exact repeats and strings shorter than 2 characters. Whatever is on the clipboard when
 * watching starts is treated as already seen (it is not game text).
 */
function createClipboardWatcher({ readText, onLine, intervalMs = 200, timers = globalThis }) {
  let handle = null;
  let last = null;

  function tick() {
    let text = '';
    try { text = String(readText() || ''); } catch { return; }
    text = text.replace(/\s+/g, ' ').trim();
    if (text === last) return;
    last = text;
    if (text.length < 2 || text.length > 2000) return;
    onLine({ speaker: 'unknown', text, engine: 'clipboard', game: 'clipboard' });
  }

  return {
    start() {
      if (handle) return;
      try { last = String(readText() || '').replace(/\s+/g, ' ').trim(); } catch { last = null; }
      handle = timers.setInterval(tick, intervalMs);
      if (handle && handle.unref) handle.unref();
    },
    stop() {
      if (handle) timers.clearInterval(handle);
      handle = null;
    },
    running: () => !!handle,
    tick,
  };
}

module.exports = { createClipboardWatcher };
