# Status after integration (Nov 14, 2026)

Sections A, B and C are merged into `main`. They merged with no conflicts.

## Verified
- `npm test`: 62 pass, 0 fail, 1 skipped (A's permission test only runs on Windows).
- The Ren'Py hook compiles (`npm run check:hook`).
- Every IPC channel the UI uses is allowed by `main/preload.js` (guarded by `test/ui.lib.test.js`).
- The UI pages were clicked through in Chrome against `ui/fake-dub.js`: keys, games, cards, audio, toasts.

## Not verified yet (needs a real Windows machine)
- The app has never been started in Electron. `npm install` and `npm start` are the first real run.
- Overlay: transparency, always-on-top over a game, and the Shift+F2 hotkey.
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
