# dub.game

AI voice-over for visual novels. Casts a unique voice for every character with Gemini and speaks their lines live with ElevenLabs.

dub.game reads the dialogue from a visual novel as you play, uses an LLM to cast a fitting voice for each character, and speaks every line with ElevenLabs. Every voice can be retuned from a settings panel, and your choices are saved per game. Think ReShade, but for audio: a layer you add on top of a game you already own.

## Features

- **Automatic casting** – each character gets their own voice the first time they speak, chosen by an LLM from their name and opening lines.
- **Live voice-over** – lines are spoken as they appear, and playback stops when the player advances.
- **Tunable** – change a character's voice, pitch of delivery, pace and expressiveness, then hear a preview.
- **Per-game profiles** – casting is saved, so a character sounds the same every session and profiles can be shared.
- **Cached audio** – a line is only generated once.

## Architecture

```
┌────────────┐  line event   ┌──────────────────────────────────────────┐
│   Game     │ ────────────► │  dub.game companion app (localhost:8765) │
│ + hook.rpy │               │                                          │
└────────────┘               │  capture ─► casting ─► tts ─► player     │
                             │               │         │                │
                             │           profiles    cache              │
                             │               ▲                          │
                             │           tuning UI (browser)            │
                             └──────────────────────────────────────────┘
                                    │                    │
                                Gemini API         ElevenLabs API
```

The game side stays tiny (one script). Everything else runs in a local companion app, so the same app can later take lines from other sources (OCR, other engines) without changing the pipeline.

### 1. Capture

Goal: for each line, know **who** said **what**.

**MVP: Ren'Py hook.** Ren'Py games load any `.rpy` file in their `game/` folder. `hook/dubgame.rpy` registers a character callback through `config.all_character_callbacks`, which Ren'Py runs for every character's dialogue. On the `"begin"` event it reads the current speaker and text and POSTs them to the companion app on a background thread, so the game never stalls. On `"end"` it tells the app to stop playback.

Line event sent by the hook:

```json
{
  "game": "doki-doki-example",
  "character": "Eileen",
  "text": "Ren'Py is a language and engine for visual novels.",
  "event": "begin"
}
```

Things to handle: strip Ren'Py text tags (`{b}`, `{w}`, `{color=...}`), treat narration (no speaker) as a `Narrator` character, skip lines when the player is fast-forwarding.

**Stretch: OCR mode.** Capture a screen region, OCR it, and send changed text as a line event. Works on any game but is slower and can't reliably tell who is speaking.

### 2. Casting

The first time a character appears, the app buffers their first few lines and asks Gemini for a voice profile. The request asks for JSON only, in this shape:

```json
{
  "character": "Eileen",
  "gender": "female",
  "age": "young adult",
  "tone": "warm, upbeat",
  "pace": "medium",
  "accent": "american",
  "description": "A friendly young woman with a bright, clear voice who explains things patiently."
}
```

The profile is then turned into an ElevenLabs voice in one of two ways:

- **Library match (MVP, implemented):** score every voice on the ElevenLabs account by its labels (gender, age, accent, description) against the profile and take the best. No extra API cost. Starting voice settings come from the profile too: more expressive characters get lower stability and more style, and pace sets speed.
- **Voice Design (stretch):** send `description` to ElevenLabs' text-to-voice design endpoint, which returns preview voices; save the chosen one and use its voice ID. Gives truly unique voices per character.

Until casting finishes, lines play in a default voice so there is no silent gap.

### 3. Speech

`tts.py` calls ElevenLabs text-to-speech (`POST /v1/text-to-speech/{voice_id}`) with the character's voice ID and settings:

| Setting | Range | Effect |
|---|---|---|
| `stability` | 0–1 | lower = more expressive and varied, higher = more consistent |
| `similarity_boost` | 0–1 | how closely output sticks to the base voice |
| `style` | 0–1 | exaggerates the voice's style |
| `speed` | about 0.7–1.2 | speaking rate |

Use a low-latency model for live play and a higher-quality one for pre-generated audio; confirm current model IDs in the ElevenLabs docs.

**Cache:** audio is saved to `cache/<sha256(voice_id + settings + text)>.mp3`. Replaying a scene, or rolling back, costs nothing.

**Playback:** one line plays at a time. A new line event or an `"end"` event cuts off the current audio.

### 4. Tuning UI

A web page served by the app at `http://localhost:8765`:

- list of characters seen so far in the current game
- per character: voice picker, sliders for the four settings above, "preview" button, "recast" button (ask the LLM again)
- mute toggle per character (e.g. silence the narrator)
- global volume and on/off

Changes are written to the game's profile immediately.

### Profile file

`profiles/<game>.json`:

```json
{
  "game": "doki-doki-example",
  "characters": {
    "Eileen": {
      "voice_id": "abc123",
      "settings": { "stability": 0.45, "similarity_boost": 0.75, "style": 0.3, "speed": 1.0 },
      "profile": { "gender": "female", "age": "young adult", "tone": "warm, upbeat" },
      "muted": false,
      "locked": true
    }
  }
}
```

`locked` means the user has tuned this character, so automatic recasting must not overwrite it.

## Local API

| Method | Path | Purpose |
|---|---|---|
| POST | `/line` | hook sends a line event |
| POST | `/stop` | stop current playback |
| GET | `/characters` | characters and voice settings for the current game |
| PUT | `/characters/{name}` | update voice or settings |
| POST | `/characters/{name}/recast` | re-run LLM casting |
| POST | `/characters/{name}/preview` | speak a sample line |
| GET | `/voices` | available ElevenLabs voices |

## Project structure

```
dub.game/
├── README.md
├── LICENSE
├── .gitignore
├── .env.example          # copy to .env and add your API keys
├── requirements.txt
├── pyproject.toml        # pytest config
├── hook/
│   └── dubgame.rpy       # Ren'Py hook: sends line events to the app
├── app/
│   ├── main.py           # FastAPI server, routes, pipeline
│   ├── config.py         # settings from .env
│   ├── capture.py        # line parsing, Ren'Py tag stripping
│   ├── casting.py        # Gemini prompt -> voice profile -> voice + settings
│   ├── tts.py            # ElevenLabs calls and audio cache
│   ├── profiles.py       # load/save per-game profiles
│   └── player.py         # playback, cut off on new line
├── ui/
│   ├── index.html        # tuning panel
│   ├── app.js
│   └── style.css
├── profiles/             # saved profiles, one JSON per game
├── cache/                # generated audio (gitignored)
└── tests/
    ├── test_core.py      # unit tests (no API keys needed)
    ├── sample_lines.json # fake dialogue
    └── send_sample.py    # plays fake dialogue through a running app
```

## Setup

Requirements: Python 3.10+, an ElevenLabs API key, a Gemini API key, a Ren'Py visual novel to test with.

```bash
git clone https://github.com/<your-username>/dub.game.git
cd dub.game
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then add your API keys
python -m app.main
```

Then:

1. Copy `hook/dubgame.rpy` into the `game/` folder of a Ren'Py visual novel.
2. Launch the game. Dialogue should start being spoken.
3. Open `http://localhost:8765` to tune voices.

To test without a game, start the app and in a second terminal run:

```bash
python tests/send_sample.py        # sends a few fake lines, 4 seconds apart
```

Run the unit tests (no API keys needed) with `pytest`.

## Build order

Each step is demoable on its own. Steps 1–6 have starter code in this repo, but only the pure-logic parts are covered by tests so far. Work through them in order with real API keys and a real game, and fix what breaks.

1. **Speak a line** – `/line` endpoint plays text in one fixed ElevenLabs voice. Test with `tests/send_sample.py`.
2. **Hook** – Ren'Py script sends real lines; game is voiced in one voice.
3. **Cache + interrupt** – cached audio, playback cut off on next line.
4. **Casting** – Gemini profile per character, matched to the voice list.
5. **Profiles** – casting saved and reloaded per game.
6. **Tuning UI** – character list, sliders, preview.
7. **Stretch** – per-line emotion, Voice Design, OCR mode, in-game overlay.

## Suggested split for the team

| Area | Files |
|---|---|
| Game hook and capture | `hook/`, `app/capture.py` |
| LLM casting | `app/casting.py` |
| TTS, cache, playback | `app/tts.py`, `app/player.py` |
| Tuning UI and API routes | `ui/`, `app/main.py`, `app/profiles.py` |

## Known risks

- **Latency:** generation takes a moment, so a line may start after the text appears. Mitigations: low-latency model, streaming, cache.
- **API credits:** visual novels have a lot of text. Develop against the cache and `tests/sample_lines.json`, and save live generation for the demo.
- **Ren'Py versions:** callback details differ between Ren'Py 7 and 8. Pick one test game early and build against it.
- **Packed games:** some games ship compiled scripts only; the hook still loads, but pick a game known to work for the demo.

## Team

- 

## Notes

- API keys live in `.env`, which is gitignored. Never commit them.
- For personal use with games you own. Generated audio is not for redistribution.

## License

MIT
