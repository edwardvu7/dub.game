# Godot 4 demo and integration

The supported demo path is a **source-level integration**: a Godot autoload sends
complete dialogue events to the existing dub.game desktop app. No API keys go in
Godot. The app handles Gemini casting, ElevenLabs speech, caching, and playback.

## Launch from dub.game

Use **Add Folder** for Godot projects (the folder with `project.godot`) or desktop
exports (the folder containing the executable and `.pck`). Click Launch. For source
projects, select the extracted Godot 4 executable when prompted; the path is saved.
Exports use their own executable; Steam games use Steam. Embedded-pack exports
without a separate `.pck` are not detected. No demo game is shipped or auto-added.

On Windows the launcher tracks the game's foreground window and requests borderless
placement on its current monitor. Shift+F2 opens the game-bounded overlay. See
[window tracking](../../docs/GAME-WINDOW.md) for limitations and verification.

Launching does not automatically add voices. The launcher never installs or removes
the experimental Godot override hook. If previously installed, restore the game's
original files before adding an integration. Godot runs separately from Electron.

## Add to your own Godot 4 project

Copy `bridge.gd` (rename it `dubgame.gd`) into the project. Under Project Settings > Globals > Autoload
(the tab location varies by Godot version), add it with the name **DubGame**.
Register your cast at startup:

```gdscript
DubGame.register_characters([
    {"speaker": "Mira", "samples": ["You came back!", "Tonight, we reach the stars."]},
    {"speaker": "Rowan", "samples": ["Keep your voice down."]},
])
```

When your dialogue controller displays a new line:

```gdscript
DubGame.say("Mira", "You came back!", str(get_path()))
```

Pass the complete plain-text line once, before a typewriter animation begins.
Do not call this per letter or per frame. Strip BBCode in your dialogue controller
if necessary. An empty speaker means `Narrator`; an empty line stops playback.
Call `DubGame.stop()` when closing dialogue, changing scenes, or skipping to a
choice. Repeated identical dialogue is supported. Each new line stops prior
playback before submitting the new one.

Requests are asynchronous, serialized, and time out after one second. Rapid
skipping retains only the latest unsent dialogue and cast. Failures do not retry,
block the game, or accumulate an unbounded backlog. If the app starts later, the
next line reconnects; call `register_characters` again if you want startup casting.
A request already sent cannot be recalled; it may briefly reach the app before the
new stop/line. On game exit, send a best-effort stop before quitting; delivery is not guaranteed. Run one connected game at a time: the existing server shares speaker
profiles and sequence state across games.

Export the integrated project normally for a desktop target. The autoload is
included in the game pack. No external override file is required.

## Verification

With Godot on PATH, stop the desktop app and run `npm run smoke:godot` from the
repository root. Set `GODOT_BIN` to your executable path if needed. The test uses
port 8000 and refuses to proceed if it is occupied. It starts the real HTTP server,
launches Godot headlessly, and verifies cast registration, speakers, narration,
repeated lines, ordering, rapid skip cancellation, stop events, and offline use.
Run `npm test` for the existing desktop app tests.

Verified with Godot 4.6.3 on Linux. UNVERIFIED: live Gemini/ElevenLabs audio,
Windows execution, exported desktop binaries, Godot 3, and browser/mobile exports.
For rehearsal, run the Windows build with your keys, confirm two distinct
character voices, toggle narration, and skip a line while speech is playing.

## Existing experimental injection hook

The sibling `dubgame.gd` and `override.cfg` predate this demo. They attempt to scan
visible labels in arbitrary exported Godot games. They are **not** the integration
above and remain unverified. A loose `res://dubgame.gd` beside an executable is not
a reliable way to insert an autoload into a packed game. Do not advertise universal
Godot game support based on this demo. Supporting a third-party game requires
verifying its version, resource loading, and dialogue system separately.

References: [Godot autoloads](https://docs.godotengine.org/en/stable/tutorials/scripting/singletons_autoload.html)
and [HTTPRequest](https://docs.godotengine.org/en/stable/classes/class_httprequest.html).
