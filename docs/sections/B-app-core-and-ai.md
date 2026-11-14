# Section B — App core + AI

**Branch:** `section/b-core-ai` · **Folders:** `main/` (not `main/steam/`), `voices_catalog.json` · **Contracts:** `CLAUDE.md`

You own the Electron main process: the localhost server, the voice pipeline, keys, and IPC.

## Tasks (in order)
1. **Electron main + server** — `main/index.js` creates windows (C's HTML in `ui/`), `main/server.js` starts
   `http://127.0.0.1:8000` with `POST /line` and `POST /characters` (reply 204 at once, then process).
   Load `.env` for dev keys. *Done when:* curl to `/line` logs speaker + text. (hour 0–1)
2. **ElevenLabs TTS** — `main/tts.js`: `speak({text, voice_id, stability, style, speed}, key) → Buffer (mp3)`
   via `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with header `xi-api-key`, fastest
   model (`eleven_flash_v2_5`). Send `audio:play` to the renderer. Newest line wins. (hour 1–3)
3. **Voice catalog** — `voices_catalog.json`: ~12 ElevenLabs premade voices with one-line descriptions
   spanning gender/age/accent (starter included — verify IDs with the API or ElevenLabs MCP). (hour 1–3)
4. **Gemini profiling** — `main/profiler.js`: `profileCharacter({speaker, samples}, catalog, key)` calls
   `gemini-3.8-flash` (2.5 Flash was retired for new keys) `generateContent` with `responseMimeType:"application/json"` + `responseSchema`
   (schema in ROADMAP appendix), constrains `voice_id` to catalog IDs, saves to `voices.json`
   (`main/voices.js`). Once per character; `/characters` profiles everyone up front. Never overwrite
   `locked` profiles. Narrator: one calm voice, or skipped when narration is off. (hour 3–5)
5. **Audio cache** — `main/cache.js`: key = sha1(voice_id+settings+text), files in userData/cache. (hour 5–7)
6. **Keys** — `main/settings.js`: store player keys with `safeStorage` (fall back to `.env` in dev);
   `settings:test` makes one tiny call per provider. Keys never cross IPC. (hour 5–7)
7. **IPC + preload** — `main/preload.js` exposes `window.dub` exactly per the table in CLAUDE.md;
   `main/ipc.js` wires handlers (calls A's `main/steam/*` for `games:*`).
8. **Clipboard mode (stretch)** — watch clipboard every 200 ms for Textractor; feed `/line` pipeline with
   `speaker:"unknown"`; drop repeats and strings < 2 chars.

## Tests (`test/core.*.test.js`)
Mock `fetch`: server returns 204 and emits a line; profiler output parses and respects catalog IDs and
`locked`; cache hits skip TTS.

## Claude Code kickoff prompts
- "Read CLAUDE.md and docs/sections/B-app-core-and-ai.md. Plan first. Build main/index.js and main/server.js."
- "Add main/tts.js and main/profiler.js with mocked-fetch tests."
