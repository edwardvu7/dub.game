# dub.game — shared contract

AI voice-over for visual novels. An Electron desktop app scans the Steam library, installs a tiny
hook script into compatible games, receives every line of dialogue over localhost, casts a voice
per character with Grok, and speaks each line with ElevenLabs. A see-through overlay (Shift+F2)
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
- `game` is `<engine>:<game folder name>` (Ren'Py: `config.basedir`; Godot: the .exe's folder; RPG Maker MV: the folder above `www/`;
  clipboard mode: `"clipboard"`). Voices are saved per game. Optional for old hooks: a line without
  it goes to the game that spoke last. `/characters` and `/stop` carry the same field.
- `upcoming` (optional, Ren'Py hook v7+): `[{speaker, text}]`, the next lines of the script up to the
  next choice or jump (max 20). The app has Grok direct them ahead of time (`main/moods.js`): one
  call per ~15 lines, never waited on. Each line's mood shifts stability/style/speed for that line
  only. The previous and next line also go to ElevenLabs as `previous_text`/`next_text`.
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
          "voice_id": "EXAVITQu4vr4xnSDxMaL", "stability": 0.5, "style": 0.3, "speed": 1.0, "volume": 1.0,
          "reason": "Soft, warm voice fits her personality.", "locked": false, "muted": false, "spoken": true
        }
      }
    }
  }
}
```
One cast per game. `current` is the game that sent the last line (what the overlay shows); `name`
comes from the Steam scan. `locked: true` means the player set it; Grok must never overwrite a
locked profile. `muted: true` skips the character (nothing is sent to ElevenLabs); muting does not
lock. `volume` (0 to 1, default 1) is playback-only: applied by the renderer to the playing clip, not in the audio cache key, never locks. A version 1 file (speaker to profile) is moved to the first game voiced after the upgrade.
Profiles also carry `lines` (lines voiced, all sessions) and `last_spoken` (ms timestamp), written by main (`touch()`, saved every 5th line, never patchable); the custom-voice pool uses them to pick the least valuable voice to evict.
`spoken: true` is set by main when a line from that character is voiced (never patchable); the UI lists only
characters that have spoken (or are locked/muted) and counts the rest. Names of one person (`Mark`, `MarkBorja`,
`MarkSprite`, `Sylvie_Happy`) share one entry, keyed by the short name (`main/speaker-names.js`); a one-time
migration (`migrated: true` at the top of the file, not returned by `voices:get`) merged old duplicates, marked
existing entries `spoken` and dropped unlocked crowd/UI-label Godot entries. A Godot `/line` whose speaker is a
crowd/UI label (`main/godot-names.js`) and matches no known character is dropped.
`voices:get` and `voices:changed` return `{current, games}` (the file without `version`).
Optional `custom_voice: {voice_id, name, description}` is set by the backend when a designed voice was created (`voices:customize` or `voices:pickPreview`). It does not touch `voice_id` or `locked` (see "Two voice sets" below). It is not in the catalog, so the UI adds it to the dropdown as "Custom: <name>".

### Two voice sets per character (Custom voices setting)
A profile keeps its preset voice (`voice_id` + sliders, cast by Gemini/Grok or picked by the player) and, optionally,
a designed one: `custom_voice: {voice_id, name, description}` (ElevenLabs Voice Design). Designing never touches
`voice_id` or `locked`. The voice that speaks (and is previewed and cache-keyed) is `effectiveVoiceId(profile, customVoices)`
in `main/voices.js`: `custom_voice.voice_id` when `settings.customVoices` is on, the profile has one and `use_preset` is not
true; otherwise `voice_id`. Flipping the setting switches every character at once and loses nothing. `use_preset: true`
(patchable through `voices:update`, never locks) means the player picked a preset for that character while custom was on;
`use_preset: false` returns to the designed voice; a fresh design clears it. Sliders, mute, volume and lock are shared by both sets.
With the setting on, the card's Voice list starts with "Custom: <name>"; picking a catalog voice there sends
`{voice_id, use_preset: true}`. With it off, the list edits the preset.
Profiles from the first version (voice_id overwritten by the designed id) are repaired on load: the preset becomes the
catalog voice closest in gender/age, `locked` is released and `source` is `fallback`, so Grok recasts it once.
When the setting is on, characters that speak and have no `custom_voice` are designed automatically in one serialized
background queue (`pipeline.js`): current speaker first, then most lines this session; at most `MAX_CUSTOM_PER_GAME` (8) live per game (rolling, see below);
muted, Narrator and unknown skipped; needs an ElevenLabs key. Lines never wait: they speak with the preset until the
custom voice exists. Hard failures (401/402/403/429, quota/slot/plan) stop the queue for the session and send one
`app:status` `error` notice; transient errors retry 3 times with backoff. Turning the setting off clears the queue; turning it on
resets the stop. The card's "Custom voice" button uses the two preview channels: `voices:designPreviews` (audition up to 3 versions, nothing saved) then `voices:pickPreview` (saves the chosen one); `voices:customize` (one-shot design) remains for the automatic queue/legacy callers. Saving a pick clears a queue stop on success.
Custom voices are a rolling pool of `MAX_CUSTOM_PER_GAME` (8) live designed voices per game, not a hard cap: when a new one is needed and the pool is full, the least valuable live one is evicted (that character falls back to its preset voice and the ElevenLabs voice is deleted to free the slot). Main characters from the cast research (`cast.json`) are protected from eviction.
`settings:setCustomVoices` also calls `pipeline.customVoicesChanged(on)`.

### `cast.json` (in `userData`, main/cast.js)
Needs an xAI key (the same Grok key that casts and directs). The first time a game is voiced, Grok searches the web (xAI Responses API,
`web_search` tool) for its setting and main characters: `{ [game]: {name, at, setting: {country, region,
language, era, notes}, characters: [{name, aliases, gender, age_range, personality, voice, origin, speech}]} }`
(`origin` = nationality/background, `speech` = how they talk; all optional strings, trimmed and capped). The file
persists across restarts and a game is researched once; a failed lookup retries after an hour. Entries saved before
`setting` existed are researched once more (the lookup always writes `setting`, `{}` fields empty if unknown; saved
characters are kept if the refresh finds none). Setting and origin/speech go into every casting prompt, which tells
Grok to match the voice to the setting and not default to British/Australian voices. Used to resolve speaker names (case, full names, aliases, a
Godot node like "MarkSprite") to one character, and as notes for Grok's casting. When it arrives,
unlocked voices picked without it are recast once (profiles get `cast: true`; `researched: true` once cast with the
setting, so a setting arriving later recasts them once more). Cast voices also copy the researched `origin`/`speech`
(short strings, from the research, never patchable) into their voices.json profile; the expanded card shows them as a
read-only "Notes" line. Grok is always told
the game's name. Grok never picks voices or touches ElevenLabs.

### `usage.json` (in `userData`, main/usage.js)
Characters sent to ElevenLabs this session, this month (per game too) and in total; Grok calls (`monthAI`, `session.ai`; old `monthGemini` is still read);
and an optional monthly character limit. Cache hits are free and not counted. Over the limit, new
lines are not sent (cached lines still play).

### Steam scan result (A → UI)
```json
[{ "appid": "1234", "name": "Some VN", "installDir": "C:/.../common/Some VN",
   "engine": "renpy", "support": "full", "enabled": true, "hookInstalled": true,
   "coverUrl": "https://cdn.cloudflare.steamstatic.com/steam/apps/1234/header.jpg" }]
```
`support` is `"full"` (Ren'Py, RPG Maker MV), `"beta"` (Godot adapter, only with `DUBGAME_BETA=1`) or `"soon"`
(Godot, RPG Maker MZ, Unity: listed so players see them, but voices can't be switched on and
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
| `games:godotConfig` | invoke | `{appid, textPath, speakerPath}` → updated Godot game |
| `voices:get` | invoke | → `{current, games}` (see voices.json) |
| `voices:catalog` | invoke | → catalog array |
| `voices:update` | invoke | `{game?, speaker, patch}` → profile (sound changes set `locked: true`; `muted` and `volume` do not) |
| `voices:reroll` | invoke | `{game?, speaker}` → new profile from Grok |
| `voices:customize` | invoke | `{game?, speaker}` → profile. Experimental: Grok writes a description, ElevenLabs Voice Design makes a voice (costs credits and a voice slot, max 8 per game). Refuses with a readable error when `customVoices` is off, a key is missing, the plan/quota/slots fail, or the cap is reached |
| `voices:designPreviews` | invoke | `{game?, speaker}` → `[{id, mime, data /* base64 */}]`, up to 3 versions of a designed voice to audition. Nothing is saved, no voice slot used. Same refusals as `voices:customize` |
| `voices:pickPreview` | invoke | `{game?, speaker, id}` → profile with that version saved as `custom_voice` (one voice slot). Previews expire after 30 min |
| `voices:preview` | invoke | `{game?, speaker, text?}` → plays a sample |
| `voices:clearGame` | invoke | `{game}` → `true`; forgets that game's voices |
| `usage:get` | invoke | → `{session, month, monthChars, monthAI, totalChars, limit, byGame, overLimit}` |
| `usage:setLimit` | invoke | `number` (0 = none) → same as get |
| `usage:plan` | invoke | → `{ok, used, limit, resetAt?}` from ElevenLabs, or `{ok:false, error}` |
| `settings:get` | invoke | → `{hasElevenLabsKey, hasGrokKey, narration, clipboardMode, acting, customVoices, quality}` (never the keys). `quality` is the string `'fast'`, `'balanced'` or `'best'` |
| `settings:setKeys` | invoke | `{elevenlabs?, grok?}` → same shape as get |
| `settings:test` | invoke | `{provider}` → `{ok, error?}` |
| `settings:setNarration` | invoke | `boolean` |
| `settings:setActing` | invoke | `boolean`: Grok directs each line ahead of time (default on) |
| `settings:setQuality` | invoke | `'fast'` (Flash v2.5, default) | `'balanced'` | `'best'` (Multilingual v2 with speaker boost: richer, ~1 s slower, 1 credit/char); returns the `settings:get` shape. Legacy `true` means `'best'`, anything else `'fast'`. A character speaking with its designed (custom) voice always uses Multilingual v2. The model is part of the audio cache key. `balanced` is Turbo v2.5 (UNVERIFIED against the live API). |
| `settings:setClipboardMode` | invoke | `boolean`: clipboard mode (lines copied to the clipboard are voiced, game `"clipboard"`); → `settings:get` shape; also starts/stops the clipboard watcher in main |
| `settings:setCustomVoices` | invoke | `boolean` (anything else is an error): Experimental custom ElevenLabs voices (default off) |
| `audio:play` | main → renderer event | `{speaker, text, mime, data /* base64 */, volume /* 0..1, that character's own */}` |
| `line:received` | main → renderer event | `{speaker, text, engine, game}` |
| `audio:stop` | main → renderer event | no payload: stop the playing clip (muted character, narration off, a newer silent line). Not sent to the overlay |
| `app:status` | main → renderer event | `{level: 'warn'|'error', message}`: a one-line notice for the main window (queue stopped, exclusive fullscreen, missing key, ...). Buffered until the main window has loaded |
| `voices:changed` | main → renderer event | `{current, games}` |
| `usage:changed` | main → renderer event | same as `usage:get` |
| `overlay:toggle` | main → overlay event | — |
| `games:changed` | main → renderer event | scan result array (after a background Steam tag lookup) |

Audio plays in a hidden renderer (or the main window); a new clip always stops the previous one.

## Rules
- **API keys stay in the main process.** Never in renderer code, never in git. Dev keys come from
  `.env` (`ELEVENLABS_API_KEY`, `XAI_API_KEY`); player keys are stored with `safeStorage`.
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

## Generic Godot hook

Godot games are decorated with `voiceMode: "generic"`, `support: "beta"`, and can be
explicitly enabled without DUBGAME_BETA. Launch does not enable a disabled Godot hook.
`hookInstalled` means owned files match; `hookStatus` reports a recent heartbeat separately.
`POST /godot/hook` carries appid, install token, version, visible labels and selectedPath.
Only the main process validates the token; it is omitted from renderer game objects.
See `docs/GODOT-GENERIC.md` for coverage and limitations.

## RPG Maker MV hook

`engine: "rpgmaker-mv"`, `support: "full"`. Installing copies `mod/rpgmaker/dubgame.js` to
`<game>/www/js/dubgame.js` and adds one `<script>` tag before `</body>` in `www/index.html`;
uninstalling removes exactly that tag and the file. `hookInstalled` needs both. The hook wraps
`Window_Message` (start = `/line`, terminate = `/stop`), takes the speaker from the
YEP_MessageCore name box (none = "Narrator") and posts with Node's `http` (no Origin header).
It sends no `/characters` and no `upcoming`. Written against OMORI; see `docs/STATUS.md`.
