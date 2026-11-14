# Section C — UI + demo

**Branch:** `section/c-ui-demo` · **Folders:** `ui/`, `build/`, `docs/pitch.md` · **Contracts:** `CLAUDE.md`

You own everything the player sees. Build against fake data first (`ui/fake-dub.js` stands in for
`window.dub` when it's missing), so you never wait on A or B.

## Tasks (in order)
1. **Main window** — `ui/index.html` + `ui/app.js` + `ui/styles.css`: compatible-games grid (cover art,
   name, Full/Beta badge, checkbox, Launch), Rescan and Add game folder buttons, "Reinstall" when
   `hookInstalled` is false. Dark, ReShade-like look (use the frontend-design skill). (hour 1–3)
2. **Audio player** — in the main window: on `audio:play`, stop the current clip and play the new one.
3. **Overlay window** — `ui/overlay.html` + `ui/overlay.js`: see-through, always on top, toggled with
   Shift+F2 (B creates the window/hotkey; you build the page). Shows the last line spoken. (hour 3–5)
4. **Character cards** — `ui/cards.js`, shared by overlay and main window "Voices" tab: voice dropdown
   (from `voices:catalog`), sliders for stability/style/speed, Preview, Re-roll with AI, locked badge;
   live-updates on `voices:changed`. (hour 3–7)
5. **Settings screen** — two key fields, "Get a key" buttons (elevenlabs.io → Developers → API Keys;
   aistudio.google.com/apikey), Test buttons with green check / error, narration toggle, 3-line guide.
   Opens automatically on first launch if keys are missing. (hour 5–7)
6. **Installer + demo** — `electron-builder` config for a Windows NSIS installer at hour 6 (fallback:
   demo from `npm start`); write `docs/pitch.md` (2-minute pitch) and the demo checklist. (hour 6–8)

## Tests
`test/ui.*.test.js`: pure helpers (badge text, slider formatting, filtering) are testable with `node --test`.
Optional: Playwright driving Electron (webapp-testing skill) for the full flow.

## Claude Code kickoff prompts
- "Read CLAUDE.md and docs/sections/C-ui-and-demo.md. Use the frontend-design skill. Plan first, then build ui/ against ui/fake-dub.js."
