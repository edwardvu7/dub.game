# Status after integration (Nov 14, 2026)

Sections A, B and C are merged into `main`. They merged with no conflicts.

## Verified
- `npm run smoke`: boots the real `main/index.js` with a stand-in for Electron, a fake Steam library
  and fake ElevenLabs/Gemini, then acts as the game and the UI. Checks windows and pages, the
  Shift+F2 hotkey, IPC wiring, key handling, Steam scan, installing/removing the hook, /characters,
  /line, audio to the main window only, the cache, voice tuning, preview, narration off, /stop, and
  that IPC from other pages is refused. All pass.
- `npm run smoke:hook`: runs `dubgame.rpy` against a stand-in Ren'Py and checks what reaches the app:
  speaker names (including dynamic names and narration), tag stripping, skipping, /stop, never
  blocking the game, and staying silent when the app is closed. All pass.
- `npm test`: 67 pass, 0 fail, 1 skipped (A's permission test only runs on Windows).
- The Ren'Py hook compiles (`npm run check:hook`).
- Every IPC channel the UI uses is allowed by `main/preload.js` (guarded by `test/ui.lib.test.js`).
- The UI pages were clicked through in Chrome against `ui/fake-dub.js`: keys, games, cards, audio, toasts.

## Fixed during integration
- Lines could reach the app out of order when the player clicked fast (one thread per line), and an
  old line then played over the current one. The hook now sends from one thread, in order, and skips
  lines that are already outdated; the app also drops a line older than the newest (hook version 3).

## Overlay (Shift+F2)
- Opens on the monitor under the mouse (the one the game is on), docked to the right edge, sized to
  that screen every time it opens, so resolution changes and second monitors work.
- Re-asserts always-on-top each time it opens, focuses itself, and reloads if its page crashes.
- Exclusive fullscreen check (`main/fullscreen.js`): on Windows, opening the overlay asks Windows
  whether a game is in exclusive (Direct3D) fullscreen. If so, the main window shows how to switch the
  game to windowed or borderless, and a Windows notification appears once the game leaves fullscreen.
  Borderless fullscreen is fine. Checked by unit tests with a stand-in PowerShell; not yet on Windows.

## Changed on the `ui-changes` branch
- Overlay is a compact 340 x 600 panel at the left edge, voice settings only (no title, no last line).
- Launch turns voices on for the game if needed, then starts it. While the app is running, the Ren'Py
  hook (version 4) keeps the game's fullscreen preference off so the overlay can show. UNVERIFIED on
  a real game.
- Godot, RPG Maker and Unity games are listed as "Coming soon" (engine name on the badge, no voices
  switch or Launch). Only Ren'Py games can be voiced.
- Those Godot/RPG Maker/Unity Steam games are listed only when Steam tags them as story-driven
  (Visual Novel, Story Rich, ...), checked with SteamSpy and cached. UNVERIFIED: SteamSpy has not
  been called live yet; the reply format comes from its documentation.
- The Games list rescans Steam when the window regains focus (at most every 20 seconds).

## Not verified yet (needs a real Windows machine)
- The app has never been started in Electron. `npm install` and `npm start` are the first real run.
- Overlay over a real game: windowed, borderless, and the exclusive-fullscreen warning.
- Steam scan against a real library, and installing the hook into a real game.
- The Ren'Py hook against a real game (speaker names, Ren'Py 7 vs 8).
- Real ElevenLabs and Gemini calls, including the model IDs.
- The Windows installer (`npm run dist`).

## Known limitation
Voices are saved per speaker name, not per game (see CLAUDE.md).

## First run
```bash
npm install
npm start
```
Then: Settings (paste both keys, green checks) → Games (switch a game on, Launch) → advance dialogue.
Without a game: `curl -X POST http://127.0.0.1:8000/line -H "Content-Type: application/json" -d '{"speaker":"Sylvie","text":"Hi!","engine":"renpy"}'`
