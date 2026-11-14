'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
function validFrame(frame) {
  return frame && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) &&
    frame.width > 0 && frame.height > 0 && typeof frame.focused === 'boolean' && typeof frame.minimized === 'boolean';
}
function createGameWindowTracker({ onFrame, onError = () => {}, platform = process.platform, spawnWorker = spawn } = {}) {
  let worker = null;
  function stop() {
    const old = worker; worker = null;
    if (old) old.kill();
    onFrame(null);
  }
  return {
    stop,
    start(game, pid = 0) {
      stop();
      if (platform !== 'win32') { onError('Game-bounded overlay currently requires Windows.'); return; }
      const script = path.join(__dirname.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'), 'windows', 'game-window.ps1');
      try {
        const child = spawnWorker('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fs.readFileSync(script, 'utf8'), 'utf16le').toString('base64')], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DUB_TRACK_DIR: game.installDir, DUB_TRACK_PID: String(pid || 0), DUB_APP_PID: String(process.pid) },
        });
        worker = child;
        let buffer = '', error = '';
        child.stdout.on('data', chunk => {
          if (worker !== child) return;
          buffer += chunk;
          if (buffer.length > 65536) { stop(); onError('Invalid game-window tracking response.'); return; }
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (validFrame(frame)) onFrame({ ...frame, gameId: game.appid });
              else if (frame.error) onError(frame.error);
              else onFrame(null);
            } catch { /* ignore non-JSON PowerShell startup output */ }
          }
        });
        child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
        child.on('error', e => {
          if (worker === child) { stop(); onError('Game-window tracking failed: ' + e.message); }
        });
        child.on('exit', code => {
          if (worker !== child) return;
          worker = null; onFrame(null);
          if (code) onError('Game-window tracking stopped. ' + error);
        });
      } catch (e) { stop(); onError('Game-window tracking failed: ' + e.message); }
    },
  };
}
module.exports = { createGameWindowTracker, validFrame };
