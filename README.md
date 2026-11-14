# dub.game
AI voice-over for visual novels. Casts a unique voice for every character with Gemini and speaks their lines live with ElevenLabs.

## How the work is split
Three sections, one owner each, all building against the contracts in [`CLAUDE.md`](CLAUDE.md):

| Section | Branch | Task list |
|---|---|---|
| A — game hook + Steam scan | `section/a-hook-steam` | [docs/sections/A-game-hook-and-steam.md](docs/sections/A-game-hook-and-steam.md) |
| B — app core + AI | `section/b-core-ai` | [docs/sections/B-app-core-and-ai.md](docs/sections/B-app-core-and-ai.md) |
| C — UI + demo | `section/c-ui-demo` | [docs/sections/C-ui-and-demo.md](docs/sections/C-ui-and-demo.md) |

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).
