'use strict';
// Is a game in exclusive fullscreen? The overlay (an always-on-top window) can't appear over
// exclusive (Direct3D) fullscreen, only over windowed and borderless games. Windows reports this
// through SHQueryUserNotificationState, the same signal it uses to hold back notifications.
// Called from PowerShell so no native module is needed. Other platforms answer 'unknown'.
// UNVERIFIED: not yet run on a Windows machine; check that Shift+F2 over a fullscreen game warns.
const childProcess = require('node:child_process');

// QUERY_USER_NOTIFICATION_STATE values (shellapi.h).
const STATES = {
  1: 'windowed',   // QUNS_NOT_PRESENT: screensaver/locked, nothing fullscreen
  2: 'fullscreen', // QUNS_BUSY: a fullscreen app (borderless counts) or presentation settings
  3: 'exclusive',  // QUNS_RUNNING_D3D_FULL_SCREEN: Direct3D exclusive fullscreen
  4: 'fullscreen', // QUNS_PRESENTATION_MODE
  5: 'windowed',   // QUNS_ACCEPTS_NOTIFICATIONS: normal desktop
  6: 'windowed',   // QUNS_QUIET_TIME
  7: 'fullscreen', // QUNS_APP: a fullscreen Store app
};

const SCRIPT = [
  "Add-Type -Namespace Dub -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);'",
  '$s = 0',
  '[void][Dub.Shell]::SHQueryUserNotificationState([ref]$s)',
  '$s',
].join('; ');

/** '3' -> 'exclusive'. Anything unexpected -> 'unknown'. */
function parseState(stdout) {
  const n = parseInt(String(stdout || '').trim(), 10);
  return STATES[n] || 'unknown';
}

/**
 * createFullscreenCheck({platform?, execFile?, now?, cacheMs?, timeoutMs?}) -> check()
 * check() -> Promise<'exclusive'|'fullscreen'|'windowed'|'unknown'>. Never rejects.
 * One PowerShell call at a time; the answer is reused for cacheMs.
 */
function createFullscreenCheck(opts = {}) {
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile || childProcess.execFile;
  const now = opts.now || Date.now;
  const cacheMs = opts.cacheMs === undefined ? 5000 : opts.cacheMs;
  const timeoutMs = opts.timeoutMs || 6000; // the first Add-Type compiles C#: about a second
  let cached = null; // { at, state }
  let running = null;

  function query() {
    return new Promise((resolve) => {
      try {
        // -EncodedCommand (UTF-16LE base64) sidesteps Windows command-line quoting entirely.
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, timeout: timeoutMs }, (err, stdout) => resolve(err ? 'unknown' : parseState(stdout)));
      } catch {
        resolve('unknown');
      }
    });
  }

  return function check() {
    if (platform !== 'win32') return Promise.resolve('unknown');
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.state);
    if (!running) {
      running = query().then((state) => {
        cached = { at: now(), state };
        running = null;
        return state;
      });
    }
    return running;
  };
}

const EXCLUSIVE_MESSAGE =
  "Windows reports your game as exclusive fullscreen (it also does for some borderless ones), so the overlay may not appear over it. " +
  'If it does not, switch the game to windowed (in most Ren\'Py games: Preferences, then Display, then Window), ' +
  'or tune voices in the Voices tab of the dubplay window.';

module.exports = { createFullscreenCheck, parseState, STATES, SCRIPT, EXCLUSIVE_MESSAGE };
