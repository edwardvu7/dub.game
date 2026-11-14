# dub.game — shared contract

AI voice-over for visual novels. An Electron desktop app scans the Steam library, installs a tiny
hook script into compatible games, receives every line of dialogue over localhost, casts a voice
per character with Gemini, and speaks each line with ElevenLabs. A see-through overlay (Shift+F2)
lets players retune voices while playing. Full plan: `docs/ROADMAP.md`.

## Ownership (one folder per person, so work never collides)

| Section | Owner | Folders | Task list |
|---|---|---|---|
| A — game hook + Steam scan | Person A | `mod/`, `main/steam/` | `docs/sections/A-game-hook-and-steam.md` |
| B — app core + AI | Person B | `main/` (except `main/steam/`), `voices_catalog.json` | `docs/sections/B-app-core-and-ai.md` |
| C — UI + demo | Person C | `ui/`, `build/`, `docs/pitch.md` | `docs/sections/C-ui-and-demo.md` |

Each section lives on its own branch (`section/a-hook-steam`, `section/b-core-ai`,
`section/c-ui-demo`). When all three are done, Fable 5 combines them into `main`
(see `docs/INTEGRATION.md`); it does not build sections. If you need something from another section,
code against the contracts below (or fake data), never edit their folder.

## Stack

- Electron, plain JavaScript (CommonJS in `main/`, no bundler). Node 20+.
- `npm start` runs the app. `npm test` runs `node --test` (picks up `test/*.test.js`).
- Windows is the demo target; code must not crash on macOS/Linux (dev machines).

## Contracts

### Hook → app: `POST http://127.0.0.1:8000/line`
```json
{ "speaker": "Sylvie", "text": "Hi!", "engine": "renpy", "game": "renpy:The Question", "source": "optional node path" }
```
- `game` is `<engine>:<game folder name>` (Ren'Py: `config.basedir`; Godot: the .exe's folder;
  clipboard mode: `"clipboard"`). Voices are saved per game. Optional for old hooks: a line without
  it goes to the game that spoke last. `/characters` and `/stop` carry the same field.
- `speaker` is `"Narrator"` when Ren'Py gives no name, `"unknown"` when the engine can't tell.
- `engine` defaults to `"renpy"` if missing. Reply `204` immediately; never make the game wait.

### Hook → app: `POST http://127.0.0.1:8000/characters`
```json
{ "engine": "renpy", "game": "renpy:The Question", "characters": [{ "speaker": "Sylvie", "samples": ["line 1", "line 2"] }] }
```
Sent once at game launch so every character is profiled before the first line.

### `voices_catalog.json` (repo root, curated by B)
```json
[{ "voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "description": "warm young woman, American" }]
```
About 12 entries.

### `voices.json` (in `app.getPath('userData')`, written by B, read/edited by C's UI)
```json
{
  "version": 2,
  "current": "renpy:The Question",
  "games": {
    "renpy:The Question": {
      "name": "The Question",
      "voices": {
        "Sylvie": {
          "speaker": "Sylvie", "gender": "female", "age_range": "young_adult",
          "personality": "Gentle and shy childhood friend.",
          "voice_id": "EXAVITQu4vr4xnSDxMaL", "stability": 0.5, "style": 0.3, "speed": 1.0,
          "reason": "Soft, warm voice fits her personality.", "locked": false, "muted": false
        }
      }
    }
  }
}
```
One cast per game. `current` is the game that sent the last line (what the overlay shows); `name`
comes from the Steam scan. `locked: true` means the player set it; Gemini must never overwrite a
locked profile. `muted: true` skips the character (nothing is sent to ElevenLabs); muting does not
lock. A version 1 file (speaker to profile) is moved to the first game voiced after the upgrade.
`voices:get` and `voices:changed` return `{current, games}` (the file without `version`).

### `usage.json` (in `userData`, main/usage.js)
Characters sent to ElevenLabs this session, this month (per game too) and in total; Gemini calls;
and an optional monthly character limit. Cache hits are free and not counted. Over the limit, new
lines are not sent (cached lines still play).

### Steam scan result (A → UI)
```json
[{ "appid": "1234", "name": "Some VN", "installDir": "C:/.../common/Some VN",
   "engine": "renpy", "support": "full", "enabled": true, "hookInstalled": true,
   "coverUrl": "https://cdn.cloudflare.steamstatic.com/steam/apps/1234/header.jpg" }]
```
`support` is `"full"` (Ren'Py), `"beta"` (Godot adapter, only with `DUBGAME_BETA=1`) or `"soon"`
(Godot, RPG Maker MV/MZ, Unity: listed so players see them, but voices can't be switched on and
`games:setEnabled` refuses them). Other engines are never returned.
Steam games on Godot, RPG Maker and Unity are listed only when their Steam community tags include
Visual Novel, Story Rich, Interactive Fiction, Choose Your Own Adventure, Dating Sim or Otome
(`main/steam/tags.js`, via SteamSpy's public API, cached in `userData/steam-tags.json`). Ren'Py games
and folders added by hand are always listed. Lookups run in the background; when they change the
list, main sends `games:changed` with the new list.

### IPC (renderer ↔ main) — exposed through `main/preload.js` as `window.dub`
`window.dub.invoke(channel, arg) → Promise` and `window.dub.on(channel, fn) → unsubscribe`.

| Channel | Direction | Payload |
|---|---|---|
| `games:list` | invoke | → scan result array |
| `games:rescan` | invoke | → scan result array |
| `games:addFolder` | invoke | → scan result array (opens a folder picker) |
| `games:setEnabled` | invoke | `{appid, enabled}` → updated game |
| `games:launch` | invoke | `{appid}` → `true` |
| `voices:get` | invoke | → `{current, games}` (see voices.json) |
| `voices:catalog` | invoke | → catalog array |
| `voices:update` | invoke | `{game?, speaker, patch}` → profile (sound changes set `locked: true`; `muted` does not) |
| `voices:reroll` | invoke | `{game?, speaker}` → new profile from Gemini |
| `voices:preview` | invoke | `{game?, speaker, text?}` → plays a sample |
| `voices:clearGame` | invoke | `{game}` → `true`; forgets that game's voices |
| `usage:get` | invoke | → `{session, month, monthChars, monthGemini, totalChars, limit, byGame, overLimit}` |
| `usage:setLimit` | invoke | `number` (0 = none) → same as get |
| `usage:plan` | invoke | → `{ok, used, limit, resetAt?}` from ElevenLabs, or `{ok:false, error}` |
| `settings:get` | invoke | → `{hasElevenLabsKey, hasGeminiKey, narration}` (never the keys) |
| `settings:setKeys` | invoke | `{elevenlabs?, gemini?}` → same shape as get |
| `settings:test` | invoke | `{provider}` → `{ok, error?}` |
| `settings:setNarration` | invoke | `boolean` |
| `audio:play` | main → renderer event | `{speaker, text, mime, data /* base64 */}` |
| `line:received` | main → renderer event | `{speaker, text, engine}` |
| `voices:changed` | main → renderer event | `{current, games}` |
| `usage:changed` | main → renderer event | same as `usage:get` |
| `overlay:toggle` | main → overlay event | — |
| `games:changed` | main → renderer event | scan result array (after a background Steam tag lookup) |

Audio plays in a hidden renderer (or the main window); a new clip always stops the previous one.

## Rules
- **API keys stay in the main process.** Never in renderer code, never in git. Dev keys come from
  `.env` (`ELEVENLABS_API_KEY`, `GEMINI_API_KEY`); player keys are stored with `safeStorage`.
- Renderer windows use `contextIsolation: true`, `nodeIntegration: false`, and talk only via `window.dub`.
- Hooks must never crash or freeze the game: background thread, short timeout, swallow errors.
- Plan first, then build. Commit every time something works.
- Anything unverified against a real game/API gets a `// UNVERIFIED:` comment.

## Git: who gets credit
- **Commit as the person you are working for, never as Claude.** Before your first commit, run
  `git config user.name` and `git config user.email`. If they show Claude or a noreply address, stop
  and ask the person for their name and GitHub email, then set both for this repo.
- **No `Co-Authored-By: Claude` and no `Claude-Session:` lines** in commit messages, and no
  "Generated with Claude Code" line in pull requests. This overrides Claude Code's default.
- Never force-push and never rewrite commits that are already on GitHub.
