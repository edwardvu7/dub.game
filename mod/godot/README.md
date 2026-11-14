# Godot 4 demo and integration

The supported demo path is a **source-level integration**: a Godot autoload sends
complete dialogue events to the existing dub.game desktop app. No API keys go in
Godot. The app handles Gemini casting, ElevenLabs speech, caching, and playback.

## Launch from dub.game

The Games screen now includes **dub.game Godot Demo** automatically. Click Launch
and select your downloaded **Godot 4 executable** when prompted (on Windows,
select the extracted `Godot_v4...exe`, not a ZIP or the game executable).
The launcher remembers this path. The game opens in its own window while Electron
continues providing speech. Godot itself is not bundled with dub.game.

Use **Add Folder** for other Godot projects (select the folder with `project.godot`)
or desktop exports (select the folder containing the executable and `.pck`).
Source projects use the selected Godot executable. Exported games use their own
executable; Steam games use Steam. Embedded-pack exports without a separate `.pck`
are not detected yet. Steam discovery still filters for story-driven games; Add
Folder bypasses that filter for a game you choose yourself.

Only the bundled demo is labeled as having voice integration. Other Godot games
can launch without automatic dubbing. Add the source integration below to provide
voices. The launcher never installs or removes the experimental Godot override
hook, and it never offers a misleading voice-enable switch for these games.
If you installed that old experimental hook previously, its files are not modified
by this update; restore your game's original files before testing an integration.

Installed builds copy the shipped demo into the app's writable user-data folder
at startup; edit the source demo in the repository when developing your own version.
UNVERIFIED: Windows installed-build launch and macOS executable selection; launcher
logic is tested with fixtures, and the real Godot adapter is tested headlessly on Linux.

## Run the demo manually

1. At the repository root, run `npm ci`, then `npm start`.
2. Configure ElevenLabs and Gemini in the app's Settings. ElevenLabs is required
   for speech; without Gemini the app uses placeholder character voices.
3. Import `mod/godot/demo/project.godot` in Godot 4 and press F6 with `demo.tscn`
   open, or F5 to run the project. Alternatively, from the repository root:
   `godot --path mod/godot/demo`.
4. Click **Next line / Restart** to cycle through narration, Mira, and Rowan.
   **Stop voice** stops playback. The app receives the cast at game startup.
   Start dub.game before the demo so the cast can be registered.

The demo appears automatically in Games; you can also run it manually. Its autoload
is already built in, so it connects directly while the desktop app is open. Leave dub.game running
in the background for voice playback. Menu and button labels are never voiced.
The connection indicator confirms HTTP delivery, not completion of AI generation.

## Add to your own Godot 4 project

Copy `demo/dubgame.gd` into the project. Under Project Settings > Globals > Autoload
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
new stop/line. Closing the demo allows 150 ms for a best-effort stop, not a delivery
guarantee. Run one connected game at a time: the existing server shares speaker
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
For demo rehearsal, run the Windows build with your keys, confirm two distinct
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
