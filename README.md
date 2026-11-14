# dub.game
AI voice-over for visual novels. Casts a unique voice for every character with Gemini and speaks their lines live with ElevenLabs.

## Install (players)

1. Open the repo's **Releases** page and download `dub.game-Setup-<version>.exe`.
2. Run it. Windows may say "Windows protected your PC" because the app isn't code-signed yet:
   click **More info**, then **Run anyway**.
3. dub.game opens on Settings. Paste your ElevenLabs and Gemini keys (each has a **Get a key** button).
4. Your Ren'Py games appear under Games. Click **Launch**, then press **Shift + F2** in the game.

## Run from the code (team)

Install [Node.js](https://nodejs.org/en/download) (LTS) once, then double-click **`start.bat`** in this
folder. The first run installs everything (a few minutes); after that it just starts the app.
Your dev API keys can go in a `.env` file (copy `.env.example`).

Terminal equivalent: `npm install`, then `npm start`. Tests: `npm test`, `npm run smoke`.

## Make a new installer

Installers are built by GitHub on a Windows machine, so nobody needs to build locally.

1. Bump `"version"` in `package.json` (for example `0.1.0` to `0.2.0`) and commit it to `main`.
2. Tag that commit and push the tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. Wait about 10 minutes. The installer appears on the Releases page under `v0.2.0`.

For a test build without a release: Actions tab, **Build Windows installer**, **Run workflow**. The
installer is attached to that run.

## How the work is split
Three sections, one owner each, all building against the contracts in [`CLAUDE.md`](CLAUDE.md):

| Section | Branch | Task list |
|---|---|---|
| A — game hook + Steam scan | `section/a-hook-steam` | [docs/sections/A-game-hook-and-steam.md](docs/sections/A-game-hook-and-steam.md) |
| B — app core + AI | `section/b-core-ai` | [docs/sections/B-app-core-and-ai.md](docs/sections/B-app-core-and-ai.md) |
| C — UI + demo | `section/c-ui-demo` | [docs/sections/C-ui-and-demo.md](docs/sections/C-ui-and-demo.md) |

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

When all three sections are done, Fable 5 merges them into `main`. It only combines; it doesn't build the sections. See [docs/INTEGRATION.md](docs/INTEGRATION.md).
