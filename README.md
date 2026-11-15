# dub.game

Real-time voice acting for unvoiced visual novels, hooked directly at the game engine.

**[Website](https://edwardvu7.github.io/dub.game/)** · **[Download Latest Release](https://github.com/edwardvu7/dub.game/releases/latest)**

---

## How It Works

Instead of relying on screen capture or OCR, **dub.game** reads exact dialogue straight from the engine runtime and streams spoken audio locally:

1. **Steam Library Scan:** Parses local Steam manifests (`libraryfolders.vdf` and `appmanifest_*.acf`) to detect compatible visual novels and toggle engine hooks on or off cleanly.
2. **Engine Callback Hook:** Injects a lightweight callback script (such as `game/dubgame.rpy` via `config.all_character_callbacks`) that strips text tags and dispatches `{ speaker, text }` payloads to `POST http://127.0.0.1:8000/line`.
3. **One-Time Character Profiling:** New speakers are profiled once using xAI Grok (JSON requested in the prompt, validated in code) against `voices_catalog.json` to assign gender, age range, personality, and voice parameters, then cached locally in `voices.json`.
4. **ElevenLabs Streaming & Live Overlay:** Streams dialogue audio in real time and provides an always-on-top Electron overlay (`Shift + F2`) to swap voices, adjust stability/style/speed sliders mid-scene, or re-roll casting.

---

## Supported Engines

| Engine | Status | Hook Mechanism |
| :--- | :--- | :--- |
| **Ren'Py 7 & 8** | Full | `game/dubgame.rpy` character callback |
| **Godot 3 & 4** | Beta | `override.cfg` + scene `Label` hook |
| **RPG Maker MV / MZ** | Beta | `Window_Message.startMessage` hook |
| **Unity** | Beta | BepInEx + XUnity endpoint |

---

## Getting Started

### Prerequisites
- **Node.js `>= 22.12.0`** (required by Electron `v45+`)
- An **ElevenLabs API key** and an **xAI (Grok) API key** (stored encrypted in the Electron main process via `safeStorage`, or configured via `.env` for local development)

### Local Development

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/edwardvu7/dub.game.git](https://github.com/edwardvu7/dub.game.git)
   cd dub.game
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables (optional):**
   ```bash
   cp .env.example .env
   ```

4. **Launch the application:**
   ```bash
   npm start
   ```

> **Windows Note:** If PowerShell blocks `npm` scripts, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force` once, or launch via `npm.cmd start`.

---

## In-Game Controls & Local API

- **`Shift + F2`**: Toggle the always-on-top voice tuning overlay over windowed or borderless games.
- **`POST http://127.0.0.1:8000/line`**: Local HTTP endpoint receiving dialogue events from hooked games:
  ```json
  {
    "speaker": "Sylvie",
    "text": "Did you hear footsteps on the stairs?"
  }
  ```

---

## Project Structure

```text
dub.game/
├── main/                 # Electron main process, HTTP server (:8000), Mastra profiler, TTS pipeline
├── mod/                  # Engine hook scripts and adapters (Ren'Py, Godot, RPG Maker, Unity)
├── ui/                   # Electron renderer UI & Shift+F2 in-game overlay
├── docs/                 # GitHub Pages landing page (edwardvu7.github.io/dub.game)
├── scripts/              # Build and packaging utilities
├── test/                 # Pipeline and hook tests
└── voices_catalog.json   # Curated ElevenLabs voice definitions for character casting
```

---

## Team

- **Edward Vu** ([@edwardvu7](https://github.com/edwardvu7))
- **Alexander Miller** ([@chadscheeks](https://github.com/chadscheeks))
- **Matthew** ([@Craz33matt](https://github.com/Craz33matt))

---

## License

See [LICENSE](LICENSE) for details.steam.md) |
| B — app core + AI | `section/b-core-ai` | [docs/sections/B-app-core-and-ai.md](docs/sections/B-app-core-and-ai.md) |
| C — UI + demo | `section/c-ui-demo` | [docs/sections/C-ui-and-demo.md](docs/sections/C-ui-and-demo.md) |

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

When all three sections are done, Fable 5 merges them into `main`. It only combines; it doesn't build the sections. See [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Godot launcher and game overlay

Use **Add Folder** for a Godot source project (`project.godot`) or exported desktop
game (executable plus `.pck`). Select the Godot 4 executable on first source-project
launch. There is no bundled demo game. For Godot 4, enable **Voices** with the game
closed, then launch it. The generic hook reads live Label/RichTextLabel nodes, with
no screen capture. Check for **Connected**; if automatic detection misses text, use
**Choose dialogue text** while the dialogue is visible. Enable Narration in Settings
for unnamed cutscene text. Compatibility varies by game; Until Then is unverified.
See [setup, compatibility and review](docs/GODOT-GENERIC.md).

On Windows, games launched here are tracked when their window takes focus. The
launcher requests borderless positioning on that window's actual monitor. Shift+F2
opens an overlay constrained to the game client area, following movement and size
changes. The overlay hides while the game is minimized or another app has focus.
Windows behavior, mixed-DPI monitors and individual engines require local rehearsal.
See [Godot integration](mod/godot/README.md) and [window tracking](docs/GAME-WINDOW.md).
