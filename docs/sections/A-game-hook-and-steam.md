# Section A — Game hook + Steam scan

**Branch:** `section/a-hook-steam` · **Folders:** `mod/`, `main/steam/` · **Contracts:** `CLAUDE.md`

You own everything that touches the game: the injected scripts and finding/installing into games.

## Tasks (in order)
1. **Ren'Py hook** — `mod/renpy/dubgame.rpy` (starter included). On every `say`, POST `{speaker, text, engine:"renpy"}`
   to `/line` on a background thread. Must run on Ren'Py 7 (Python 2) and 8 (Python 3). Strip `{tags}`.
   *Done when:* a real Ren'Py game's lines appear in the app log with correct speaker names. (hour 0–1)
2. **Character list at launch** — in the same `.rpy`, after init, loop over `store` for `Character`
   objects and POST `/characters` once. (hour 3–5)
3. **Steam scan** — `main/steam/scan.js`, exported `scanLibrary({steamPath?}) → Promise<Game[]>`:
   - find Steam (Windows registry `HKCU\Software\Valve\Steam` → `SteamPath`; macOS/Linux default paths),
   - parse `steamapps/libraryfolders.vdf` and every `appmanifest_*.acf` (`main/steam/vdf.js`),
   - detect engine from files (`main/steam/detect.js`, table below), return only supported games.
4. **Install / uninstall** — `main/steam/install.js`: `installHook(game)` copies `mod/renpy/dubgame.rpy`
   into `<installDir>/game/` (also checks `<Game>.app/Contents/Resources/autorun/game` on macOS);
   `uninstallHook(game)` deletes it; `isHookInstalled(game)`. Clear error with folder path on EACCES.
5. **Enabled list + recheck** — `main/steam/state.js`: persist ticked appids in userData; at every launch,
   recheck and report `hookInstalled:false` if a game update removed the file.
6. **Add game folder** — `scanFolder(dir) → Game|null` for non-Steam games (appid = `local:<hash>`).
7. **Launch** — `launchGame(game)`: `shell.openExternal('steam://run/<appid>')`; local games spawn the exe.
8. **Stretch (only after B and C's core works): Godot adapter** — `mod/godot/override.cfg` + `dubgame.gd`
   (starters included), installed beside the exe; mark Godot games `support:"beta"` only once it works.

## Engine detection
| Engine | Files | Support |
|---|---|---|
| Ren'Py | `renpy/` + `game/` with `.rpy`/`.rpyc`/`.rpa` | full |
| Godot | `.pck` beside the exe | beta once adapter works, else hidden |
| RPG Maker MV/MZ | `www/js/rpg_core.js` / `js/rmmz_core.js` | hidden |
| Unity | `UnityPlayer.dll` + `<Game>_Data/` | hidden |
| anything else | — | hidden |

## Tests (`test/steam.*.test.js`)
Build a fake Steam tree in a temp dir (libraryfolders.vdf, two manifests, one Ren'Py game, one Unity game)
and assert only the Ren'Py game is returned; assert install/uninstall round-trips.

## Claude Code kickoff prompts
- "Read CLAUDE.md and docs/sections/A-game-hook-and-steam.md. Plan first. Then finish mod/renpy/dubgame.rpy."
- "Implement main/steam/ (vdf.js, detect.js, scan.js, install.js, state.js) per the section doc, with tests on a fake Steam tree."
