# Godot 4 adapters

The launcher now offers a generic scene-node hook (`generic.gd`). See
[setup and compatibility](../../docs/GODOT-GENERIC.md). It uses external absolute
script paths and preserves the original override.cfg. No screenshot or OCR code is used.

`bridge.gd` remains available when you own the game source and want exact dialogue
events. Use one adapter at a time. No demo game is bundled.

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
new stop/line. On game exit, send a best-effort stop before quitting; delivery is not guaranteed. Run one connected game at a time: playback and sequence state are shared. The
source bridge does not yet send a game identifier; the generic hook does.

Export the integrated project normally for a desktop target. The autoload is
included in the game pack. No external override file is required.

## Verification

With Godot on PATH, stop the desktop app and run `npm run smoke:godot` from the
repository root. Set `GODOT_BIN` to your executable path if needed. The test uses
port 8000 and refuses to proceed if it is occupied. It starts the real HTTP server,
launches Godot headlessly, and verifies cast registration, speakers, narration,
repeated lines, ordering, rapid skip cancellation, stop events, and offline use.
Run `npm test` for the existing desktop app tests.

Source bridge verified with Godot 4.6.3 on Linux. See the generic hook guide for its separate results. UNVERIFIED: live Grok/ElevenLabs audio,
Windows execution, exported desktop binaries, Godot 3, and browser/mobile exports.
For rehearsal, run the Windows build with your keys, confirm two distinct
character voices, toggle narration, and skip a line while speech is playing.
