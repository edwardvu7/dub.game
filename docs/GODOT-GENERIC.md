# Generic Godot hook: setup and review

This beta reads live `Label` and `RichTextLabel` nodes in a Godot 4 scene tree. It
uses no screenshots, OCR, clipboard polling, memory offsets or game-specific patch.
The same hook can work across games with standard text nodes. It cannot guarantee
support for every Godot game. Until Then has not been tested with this build.

## Run it

1. Close the game. Start dub.game from `start.bat` or `npm start`.
2. Configure your API keys. Turn **Narration** on in Settings for unnamed text.
3. Add the game's folder, containing its executable and a separate `.pck`, or
   `project.godot` for a source project. Steam story games can also appear automatically.
4. Turn **Voices** on. The app verifies a Godot 4 project/pack before installing.
5. Launch the game. An exported game uses its own executable, not your Godot editor.
6. Show dialogue or the cutscene. Check the status in dub.game:
   - **Connected** means a recent hook heartbeat and a selected dialogue node.
   - **Connected, but no dialogue candidate** means loading worked, but selection
     needs help. Expand **Choose dialogue text**, select the node containing the
     visible sentence, optionally select its speaker node, and save. It applies
     within a second. Automatic selection is available in both dropdowns.
   - **Installed; no live connection** means installation alone did not prove it
     loaded. Restart the game. If it persists, inspect the game's Godot error log
     for autoload/script errors; its export may not support this approach.
7. Confirm the received line appears, then test audio. If text arrives but speech
   does not, check Narration, character mute, API key tests and the monthly limit.

Do not install on top of an existing source-level DubGame integration. Legacy
`DUBGAME_MARKER` overrides are refused; restore the original game configuration
before enabling. No old script is silently deleted. Never remove an override
belonging to the game just to bypass an error.

Turn Voices off to restore the exact original `override.cfg` and remove owned
sidecars. The running hook stops when it notices its missing configuration (within
about a second). Restart the game after enabling again. Close the game before
installing/updating files. If the game or user changes override.cfg after install,
removal and repair refuse to overwrite it; keep the install record as a backup.

## How it works

The installer appends an autoload with an **absolute external script path**. This
avoids assuming a loose `res://` script is included in the game's resource pack.
It never edits the PCK, executable or project.godot. It records the original
configuration bytes and installed hashes in `_dubgame_generic.install.json`.
Two other owned files are `_dubgame_generic.gd` and `_dubgame_generic.json`.
Do not move the game while installed: paths are absolute. Disable first, move,
then add and enable its new folder.

The hook observes new scene nodes and scans at most 512 labels every 100 ms. It
prefers dialogue, narration, subtitle and cutscene names, excludes menu/button
contexts, and chooses one candidate. Automatic speaker detection uses, in order: the speaker node the
player picked, a name label (Name, Speaker, NameTag, Who) inside the same text box, a script variable named `alias`, `speaker`, `speaker_name` or `character_name`
on a node above the text (Until Then's bubbles hold `alias`), a name plate (a
short name-like label just above or left of the line on screen, whatever its node name), then the nearest
world node (Node2D/Node3D) above the text whose name is not a layout word, which is the character a
speech bubble floats over. Otherwise it uses Narrator, unless the line itself starts with a name
("Cathy: Not yet."): then the name is the speaker and only the rest is spoken. Rich text is
converted to plain text. A typewriter that reveals hidden letters already holds the whole line, so it is sent after
150 ms, while the text is still appearing. Text that grows letter by letter is sent once it has
stopped changing for 650 ms. Hidden/changed text stops prior audio.
An identical line can play again after hiding/clearing or a new typewriter reveal.

Voices ahead of time (hook v8): when a node enters the scene under a parent named `Characters`
(Until Then: `/root/Root/Skits/<Skit>/Characters/<Name>`), its name is sent once in
`POST /characters`, so the app picks the voice while the scene loads instead of on the character's
first line. At most 12 names per request and 60 per run. The hook filters crowd words, and the app
only remembers a Godot cast announcement's samples: no voices.json entry (and no Grok call) is made
until that character actually speaks a line. Checked by `npm run smoke:godot-bubbles`. UNVERIFIED on the real game: that the cast
nodes exist well before the first line and that every child of `Characters` is a person.

HTTP requests go only to 127.0.0.1:8000, asynchronously, with a one-second timeout.
Unsent requests are coalesced by endpoint, so offline use cannot grow an unbounded
queue. Failed lines are not retried. Heartbeats contain up to 80 visible label
paths and short previews, verified against a random per-install token. The UI
never receives that token or provider API keys. Game IDs preserve upstream
per-game voices and usage. One game should be connected at a time because audio
playback and sequencing are shared.

## Inspection report

To write an exact speaker rule for one game, the hook describes that game's own nodes in
`_dubgame_generic.inspect.json`, in the game's folder next to `_dubgame_generic.json`. The file stays
on disk: nothing in it is sent over HTTP, and turning Voices off deletes it.

It holds up to 5 snapshots per run, one the first time the selected dialogue node sits at a place in
the scene not seen before in this run (Mark, Cathy, Mark is two snapshots): the time, the first 60 characters of the line, and every node from the label up
to `/root` (name, class, script path, groups, script variables with type and a short value, script
signals). Once per file it lists the autoloads the same way, and the engine classes whose name
contains "ink", "dialog" or "story" with their method names. If no dialogue node is found in the
first 10 seconds, one snapshot instead lists script variables holding text longer than 10 characters
(for games that draw text without labels). The hook only reads properties, never calls the game's
methods, and keeps the file under 64 KB (oldest snapshots are dropped first).

To produce one:

1. Close the game. Turn **Voices** off and on again for it, so the current script is copied.
2. Launch the game. Stay a few seconds on a speech-bubble line, on a phone chat message and on a
   narration line.
3. Quit and send `_dubgame_generic.inspect.json` from the game's folder.

Checked in Godot 4.1.4 on Windows by `npm run smoke:godot-bubbles` (needs `GODOT_BIN`): the node chain,
script variables and signals, autoloads, short values, the two-places rule and the no-label snapshot.
UNVERIFIED: a real game, writing the file inside Program Files, GDExtension classes in the class
list, and the 64 KB trimming (no test report was that large). The class filter also matches engine
names containing "link" or "dialog" (LinkButton, FileDialog), which is harmless noise.

## Compatibility boundaries

- Requires Godot 4 and an export that allows external autoload scripts and reads
  override.cfg. Custom/stripped builds, protections or alternate resource-loading
  rules can prevent injection. A separate valid Godot 4 PCK is required for exports.
- Godot 3, embedded-only packs, web/mobile exports, and macOS app bundles are not
  supported by this installation path.
- Custom drawing, text baked into videos/textures, and nonstandard text nodes are
  not exposed by this hook. A source/plugin integration is needed for those.
- Automatic selection is heuristic. Text previews make wrong selection visible;
  explicit node paths improve one game's behavior but can change between scenes.
- Visibility is based on node visibility/alpha, not pixel occlusion. A covered
  label may still appear. Short lines displayed for less than 650 ms can be skipped.
- A long pause in a string-building typewriter can look like a complete line.
  Identical text with no observable state change cannot be recognized as new dialogue.
- The node cap limits overhead; crowded scenes may omit nodes. Diagnostics report
  when the 512-node limit is reached. This is beta compatibility, not universal support.

## Lead developer and project readiness review

| Check | Evidence / result |
| --- | --- |
| No screen capture | Hook uses only scene nodes and localhost HTTP; no image pipeline added |
| Loader works with packed resources | Real Godot 4.6.3 Linux run with adjacent Story.pck and a renamed standalone engine binary; no source project or --path needed |
| Text extraction | Real-engine fixture verifies narrator, sibling speaker, BBCode, property and string typewriters, repeated lines, menu exclusion and live manual selection |
| Game remains responsive offline | Same fixture completes with server absent and no script errors |
| Configuration preservation | Existing autoload remains active in real runtime; exact original override restored; PCK bytes unchanged |
| Installer failures | Tests cover partial-write rollback, changed overrides, reserved files, legacy hook, Godot 3 rejection and symlink destinations |
| Launcher/API wiring | Tests cover enable/disable, token validation, connection vs installation, bounded diagnostics and IPC allowlists |
| Packaging | npm ci and Linux unpacked Electron build passed; packaged archive contains the installer and unpacked Godot hook |
| Existing app | 109-test unit suite and mock Electron smoke checks include upstream per-game voices, usage and overlay behavior |
| Not validated here | Until Then; native Windows runtime/installer; commercial export templates; paid live Grok/ElevenLabs audio; performance on large commercial scenes |

**Release decision:** ready for a local compatibility trial, not a claim that
Until Then or all Godot games are supported. Acceptance on your PC is: hook
connects, the cutscene text appears in diagnostics, the correct node is selected,
narration is audible once per line, skipping stops speech, and disabling restores
the original configuration. If no connection arrives, text-selection changes
cannot fix the loader; use the game's logs to determine its export restrictions.

## Reproduce checks

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
# Stop dub.game first so the smoke tests can bind port 8000.
$env:GODOT_BIN = "C:\path\to\Godot.exe"
npm.cmd run smoke:godot
npm.cmd run smoke:godot-generic
```

The generic fixture is generated in a temporary folder and removed afterward. No
demo game is shipped in the launcher. The packed test uses the installed Godot
editor-capable binary as the standalone runtime, not a commercial release template.
Live voice APIs are mocked in the Electron smoke test; generic engine tests check
actual HTTP text delivery without incurring API charges.

References: [Godot ProjectSettings / override.cfg](https://docs.godotengine.org/en/stable/classes/class_projectsettings.html),
[autoloads](https://docs.godotengine.org/en/stable/tutorials/scripting/singletons_autoload.html),
[RichTextLabel](https://docs.godotengine.org/en/stable/classes/class_richtextlabel.html).
