# Status after integration (Nov 14, 2026)

Sections A, B and C are merged into `main`. They merged with no conflicts.

## Verified
- `npm run smoke`: boots the real `main/index.js` with a stand-in for Electron, a fake Steam library
  and fake ElevenLabs/Grok, then acts as the game and the UI. Checks windows and pages, the
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
  hook (version 5) switches the game to fullscreen once at launch. Ren'Py's fullscreen is the
  borderless kind (SDL fullscreen-desktop), so the overlay can still show on top. If the player then
  picks windowed, that choice is kept. The Godot adapter does the same with Godot 4's borderless
  WINDOW_MODE_FULLSCREEN. UNVERIFIED on a real game.
- The overlay can be dragged by the strip along its top. It reopens where it was last dragged on that
  screen (saved in `userData/overlay-position.json`, pulled back on screen if the resolution shrank);
  on a screen it was never dragged on, it starts at the left edge.
- Godot, RPG Maker MZ and Unity games are listed as "Coming soon" (engine name on the badge, no voices
  switch or Launch). Ren'Py and RPG Maker MV games can be voiced.
- Those Godot/RPG Maker/Unity Steam games are listed only when Steam tags them as story-driven
  (Visual Novel, Story Rich, ...), checked with SteamSpy and cached. UNVERIFIED: SteamSpy has not
  been called live yet; the reply format comes from its documentation.
- The Games list rescans Steam when the window regains focus (at most every 20 seconds).

## Voices per game and cost control
- Hooks (Ren'Py v6, Godot) send `game`: `<engine>:<folder>`. voices.json keeps one cast per game, so
  two games' "Mom" never share a voice. Voices saved before this change move to the first game voiced.
  The Voices tab has a game picker (defaults to the game playing now) and "Reset voices". The overlay
  shows the game playing now.
- Usage (Settings): ElevenLabs characters this session and month, lines replayed free from the cache,
  the ElevenLabs plan quota (Check button; UNVERIFIED: needs the key's "User: read" permission), and a
  monthly character limit. Over the limit new lines are skipped; cached lines still play.
- Mute per character (cards in the overlay and Voices tab): a muted character is not sent to ElevenLabs.

## Not verified yet (needs a real Windows machine)
- The app has never been started in Electron. `npm install` and `npm start` are the first real run.
- Overlay over a real game: windowed, borderless, and the exclusive-fullscreen warning.
- Steam scan against a real library, and installing the hook into a real game.
- The Ren'Py hook against a real game (speaker names, Ren'Py 7 vs 8).
- Real ElevenLabs and Grok calls, including the model IDs.
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

## Generic Godot hook (checked on Godot 4.1.4, the version Until Then reports)
- Run in a packed game with `override.cfg`: the hook loads, connects and reports labels.
- Fixed: text boxes named Bubble/Balloon/TextBox are found automatically, and a node the player picks
  once keeps matching when the game re-creates it under an engine-numbered name (`@VBoxContainer@5`).
  `npm run smoke:godot-generic` (needs `GODOT_BIN`) covers both.
- Inspection report (`_dubgame_generic.inspect.json`, see `docs/GODOT-GENERIC.md`): run on Windows with
  Godot 4.1.4, all three Godot smoke tests pass. UNVERIFIED: a real game and writing inside Program Files.
- UNVERIFIED on Until Then itself: its node names are unknown, and text drawn without Label/RichTextLabel
  nodes cannot be read. Games with the pack embedded in the .exe are now detected (UNVERIFIED on a real one).

## Cost and first run (0.1.2)
- Audio is 64 kbps. A new line waits 150 ms before ElevenLabs is called, so lines the player skips are
  not paid for; cached lines play at once. The same line requested twice at once is bought once.
- First launch: Settings opens with a welcome title; when the second key tests OK the app moves to Games.

## Acting (0.1.4)
- Every line goes to ElevenLabs with the line before and after it (`previous_text`/`next_text`), so
  delivery follows the conversation. UNVERIFIED against the live API.
- Ren'Py hook v7 sends the next lines of the script with each line. Grok marks each one with an
  emotion and intensity ahead of time, in batches of up to 20; a line's mood shifts the character's
  stability/style/speed for that line only. Settings > "Act out scenes" (on by default) turns it off.
  The first line after a choice has no mood yet and uses the base voice. Godot games get only the
  surrounding-lines context. UNVERIFIED: Ren'Py's context().current and script.lookup() on a real game.

## Cast lookup with Grok (0.1.6)
- Optional xAI key in Settings. Once per game, Grok searches the web for the main characters (names,
  aliases, gender, age, personality, how they sound); saved in `userData/cast.json`.
- Speaker names resolve to the cast ("MARK", "Mark Borja", Godot's "MarkSprite" -> Mark), so one
  character never gets several voices. Grok gets the notes and the game's name when casting;
  unlocked voices are recast once when the lookup arrives. Grok is required now (it casts and directs); it always gets the
  game's name. xAI API: request/response shape, `web_search` tool and research model `grok-4.7` (GROK_MODEL) confirmed from docs.x.ai; casting/acting model is `grok-4.20-0309-non-reasoning` (GROK_FAST_MODEL; `grok-4-fast-non-reasoning` is no longer listed). UNVERIFIED: not called live, and the docs don't say the non-reasoning model accepts /v1/responses. A SuperGrok subscription is billed separately from API credits (console.x.ai).

## RPG Maker MV (OMORI)
- RPG Maker MV games are now `support: "full"`: the Voices switch copies `mod/rpgmaker/dubgame.js` to
  `www/js/dubgame.js` and adds one script tag at the end of `www/index.html`. Switching off removes
  the tag (the file is byte-for-byte what it was) and the script. If Steam restores `index.html`, the
  game shows "script is missing, Reinstall". Checked on a copy of OMORI's real `index.html`.
- Read from the OMORI install: plugins, data and text are encrypted (key comes from Steam's launch
  arguments), the engine files and `plugins.js` are plain. `plugins.js` shows YEP_MessageCore 1.19 and
  message macros that expand to name-box codes (`aub` -> `
<
[2]>`, `mar` -> `
<MARI>`). So the
  hook wraps the plain `Window_Message.startMessage`/`terminateMessage` after all plugins loaded, and
  records the name YEP hands to `Window_NameBox.refresh`. No name box = "Narrator".
- Not sent: choices, battle log, menus, scrolling text (other windows). No `/characters` at launch and
  no `upcoming` lines, so no ahead-of-time moods. The hook does not switch the game to fullscreen.
- UNVERIFIED, nothing was run inside OMORI: that `require('http')` works from the page, that OMORI's
  encrypted plugins leave the name box on `Window_NameBox.refresh(text)` and the text in
  `_textState.text`, that no custom escape code leaks into spoken text, and that names inside the
  name box arrive already resolved (`
[2]` -> AUBREY). Tested only with stand-ins (`test/rpgmaker.test.js`).
  Also untested: other MV games (without YEP_MessageCore every line is "Narrator"), OneLoader mods,
  macOS app bundles, MV games listed from Steam need a story tag from SteamSpy like other engines.

## Voice catalog (24 entries)
- Added 12 premade voices. UNVERIFIED: IDs came from a third-party list (wavespeed.ai/docs-api/elevenlabs/elevenlabs-voice-id,
  taken from ElevenLabs preview URLs), not a live `GET /v1/voices`. Accent/age labels for the added voices are
  from memory of ElevenLabs' labels, not checked. All are English with no Asian/Indian/Irish accents.
  Check with the API; real accent variety needs the Voice Library.
