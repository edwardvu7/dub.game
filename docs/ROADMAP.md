> Copied from the "dubplay — 8-Hour Build Roadmap" doc (2026-11-14). Code samples are in the appendix at the end.

dubplay — 8-Hour Build Roadmap
 · 
Summary
In 8 hours, build a desktop app plus a Ren'Py mod. The app scans the player's Steam library, shows only compatible games, and installs a small script into the ones they tick (this is the injection). In game, the script sends every line of dialogue, with the speaker's name, to the app. Gemini builds a voice profile for each new character, and ElevenLabs speaks the line. A see-through overlay, opened with a hotkey on top of the game, lets players retune any voice, like the ReShade menu.
What the demo shows: open dubplay and it lists only the installed Steam games it supports. Tick an unvoiced Ren'Py visual novel and launch it. Every character speaks in their own voice, picked automatically. Press Shift+F2, change a slider, and the next line sounds different.
Why this route: the game hands over exact text and speaker names, so there's no screen reading to get wrong. Other engines (Godot, RPG Maker, Unity) each get their own small adapter that feeds the same app. Textractor and screen capture are the fallbacks.
Stack: an Electron desktop app, JavaScript throughout. Its main process listens for the hook on localhost, scans Steam, and calls the Gemini and ElevenLabs APIs. The main window and the overlay are HTML. All of it can be vibecoded with Claude Code.
Gemini is called once per character. After that, every line goes straight from the server to ElevenLabs.
Desktop app: scan, pick, enable
dubplay ships as an Electron desktop app. On first launch it scans the Steam library and lists only the games it supports. Players tick the ones they want voiced.
What the player does
Install dubplay and open it. It scans every Steam library automatically, which takes a few seconds.

The list shows only compatible games, each with cover art and a checkbox. Unsupported games never appear.

Tick a game and the app copies dubgame.rpy into it. Untick it and the app removes the file. Nothing else in the game changes.

Click Launch and the app starts the game through Steam (steam://run/<appid>).

In game, press Shift+F2 to show or hide the see-through overlay and retune voices while playing.

Why Electron
One language: JavaScript runs the hook listener, the Steam scan, the AI calls and the UI.

More examples than any other desktop framework, so Claude Code writes it well.

See-through, always-on-top windows and global hotkeys are built in, which is what the overlay needs.

electron-builder turns it into a Windows installer.

Alternative: Python + pywebview, if the team prefers Python (weaker overlay). Skip Tauri, which needs Rust.

Limitations and fixes
Limitation
Fix
Windows warns about an unsigned app
For the hackathon, click More info → Run anyway. Pay for code signing later
The overlay doesn't show over exclusive fullscreen
Ren'Py runs windowed by default. Tell players to use windowed or borderless
API keys bundled in the app can be extracted
Never bundle keys. Players paste their own in Settings (see API keys)
Building the installer can take an hour
Build at hour 6. If it fails, demo from npm start
A compatible game is missing from the list
Add "Rescan" and "Add game folder" buttons for non-Steam games and unusual installs
API keys: each player connects their own
Players paste their own ElevenLabs and Gemini API keys into a Settings screen. Neither service offers a "Sign in with..." link that a third-party app can use, so pasted keys are the only direct route. It also means dubplay pays nothing per line and needs no server.
How it works
First launch opens Settings with two fields. Each has a Get a key button that opens the provider's key page in the browser (ElevenLabs: Developers, then API Keys. Gemini: aistudio.google.com/apikey).

A Test button makes one small call per key and shows a green check or the error message.

Keys are saved encrypted with Electron's safeStorage, in the main process only. They never reach the UI code or git.

For development, the app uses keys from .env if they exist, so the team doesn't retype them.

Option
Who pays
Effort
When
Players paste their own keys
The player, on their own free or paid plan
Low: one Settings screen
Hackathon and early releases
Your own server holds your keys; players log in to dubplay
You, for every spoken line
High: a backend, accounts, billing
A real product, later
Your keys bundled inside the app
You, plus anyone who extracts them
None
Never
Limitations and fixes
Limitation
Fix
Getting two keys is friction for new players
Get a key buttons, a Test button, and a 3-line guide on the Settings screen
ElevenLabs' free plan is small (about 10,000 credits a month, roughly 10 minutes of speech, with no commercial license; confirm on their pricing page)
Cache every line, show a usage counter, and let players turn off narration
Gemini's free tier has rate limits
Profile each character once and save it. Normal play makes almost no Gemini calls
Judges won't have keys
Demo with the team's keys already entered. Show the Settings screen for five seconds in the pitch
Before hour 0
Do these before the clock starts. They take about 30 minutes and remove the most common first-hour stalls.
Decide who is Person A (game hook and Steam scan), B (app core and AI) and C (UI and demo)

Pick one person to call scope cuts at each checkpoint

Pick the demo game: Ren'Py, on Steam, free, unvoiced, and short

Pick the demo machine: Windows, with Steam and the game installed

Everyone installs Node.js (LTS), git and Claude Code, and clones one shared GitHub repo

B creates the ElevenLabs and Google AI Studio accounts and shares the keys privately, never in git

Check the hackathon rules: judging criteria, demo length, and whether sponsor tools are required

Build order: start here
Build steps 1–3 in order, as one thin line from game to speaker. Nothing else matters until a real game line is spoken out loud. Then the three of you split up and work in parallel.
If step 3 isn't working by hour 3, all three of you swarm it before starting steps 4–6.
Kickoff prompts for Claude Code (paste one, read the plan it gives back, then let it build)
Everyone: "Read CLAUDE.md. Scaffold an Electron app with folders mod/ (the Ren'Py hook), main/ (main process) and ui/ (main window and overlay), plus a .gitignore that excludes .env. Plan first."

A: "Write mod/dubgame.rpy. On every say statement it posts {speaker, text} to localhost:8000/line on a background thread. It must work on Ren'Py 7 (Python 2) and Ren'Py 8 (Python 3)." B: "In the Electron main process, start a local HTTP server on port 8000 with POST /line that logs the speaker and text."

B: "When a line arrives, call ElevenLabs text-to-speech with one default voice and send the audio to the renderer over IPC." C: "In the renderer, play each clip as it arrives, stopping the one before it. Build the main window against a fake game list first."

B: "When a new speaker arrives, ask Gemini for a voice profile using the schema in CLAUDE.md. Pick from the voices in voices_catalog.json and save the result to voices.json in the app's user-data folder."

A: "In the main process, find the Steam folder, read libraryfolders.vdf and the appmanifest files, detect each game's engine from its files, and return only Ren'Py games. Ticking a game copies dubgame.rpy into its game/ folder; unticking removes it. Add a Launch button that opens steam://run/<appid>."

C: "Use the frontend-design skill. Build a see-through, always-on-top overlay window toggled by Shift+F2, with a card for each character in voices.json: voice dropdown, sliders, Preview, and Re-roll."

Anyone: "Set up electron-builder for a Windows installer and build it." Then: "Use the webapp-testing skill to run the demo flow end to end and list anything broken."

If you fall behind: what to cut
The scope has grown since the first draft (desktop app, Steam scan, overlay, key settings). Treat 8 hours as the target and the rest of the 24 as buffer. Cut from the bottom of this table first.
Priority
Feature
If it's cut
Must
Ren'Py hook to spoken line (steps 1–3)
No demo. Never cut
Must
Auto voices per character (step 4)
Everyone sounds the same. Never cut
Should
Steam scan with checkboxes (step 5)
An "Add game folder" button where the player picks the folder by hand
Should
Character tuning cards (step 6)
Voice dropdown only, no sliders
Could
Overlay on top of the game
The same cards live in the main window; alt-tab to it
Could
Godot adapter (second engine)
One slide: "Godot is next, here's how"
Could
Settings screen for keys
Keys stay in .env
Could
Windows installer
Demo from npm start
Later
RPG Maker and Unity adapters, calibration screen, Textractor mode
One slide in the pitch
Hold a 5-minute check-in at hours 1, 3, 5 and 7. Each person demos what works, pulls the latest code, and the scope caller decides what to cut.
Can we inject like ReShade?
Yes, but not in the same way. A true ReShade-style injection doesn't fit in 8 hours for a beginner team. A Ren'Py script injection does, and it gets better data.
Path
How it works
What you get
8-hour fit
Ren'Py script mod (recommended)
Drop a dubgame.rpy file into the game's game/ folder. Ren'Py runs every .rpy file there at launch. It registers a callback that fires on every line of dialogue.
Exact speaker name and text, timing events, and the option to play audio inside the game
Yes, about 30 lines of Python
Screen capture + Gemini vision
Share the game window in the browser, crop the dialogue box, send frames to Gemini
Works on any engine, but slower (about 1–3 s) and can misread names
Last resort, only if Textractor can't read the game
ReShade add-on (DLL)
A C++ add-on that ReShade loads into the game's graphics pipeline (Direct3D 9–12, OpenGL, Vulkan), drawing its own ImGui panel
A real in-game overlay menu, but it only sees pixels, not text. You'd still need OCR or Gemini
No. C++, Windows builds, graphics debugging. Pitch it as the future version
How the Ren'Py hook works: Ren'Py has a built-in setting, config.all_character_callbacks, that runs a function on every say statement. The function receives a "begin" event and keyword arguments including what, the dialogue text. The character's name comes from the speaking Character object. The callback posts {speaker, text} to localhost on a background thread so the game never freezes.
Caveats
Many Ren'Py games ship their scripts compiled (.rpyc) or packed in .rpa archives. That's fine, because the mod is a new file and doesn't touch theirs.

Pick a game you're allowed to mod for the demo. Free itch.io Ren'Py games or the Ren'Py "The Question" sample are safest.

The add-on build of ReShade is flagged by anti-cheat. Singleplayer games only.

Reading text without screenshots
Hook the game where it draws text and you get the exact words, with no screen reading. Ren'Py is covered above. Godot, RPG Maker and Unity get their own adapters (next section). For everything else, use Textractor plus a clipboard watcher.
Method
Engines
Gives speaker name?
Effort
Engine adapter (a small script per engine)
Ren'Py, Godot, RPG Maker MV/MZ, Unity
Ren'Py and RPG Maker MZ: yes. Others: after calibration
See Engine adapters below
Textractor + clipboard
Most Windows visual novels, mainly Japanese engines such as Kirikiri
Often not, so Gemini guesses
About 1 hour
Memory reading (Cheat Engine–style)
Any
Depends
Skip it: breaks with every game update
Textractor setup (Person A, hours 5–7, replaces the screen-capture stretch goal)
Start the game, attach Textractor to its process, and pick the text thread that shows clean dialogue.

Turn on Textractor's copy-to-clipboard extension.

Have the app watch the clipboard (Electron's clipboard.readText(), checked every 200 ms). Each new line goes into the same pipeline as /line, with speaker set to unknown.

When the speaker is unknown, Gemini guesses from the line, the last few lines, and the names it already knows. Players can fix it in the overlay.

Caveats
Windows only.

It sometimes picks up junk or repeats lines. Drop exact repeats and very short strings.

Some games need a hook code from community lists before Textractor finds the text. Pick the demo game and test it ahead of time.

Get clipboard mode working before writing a custom Textractor extension (a C++ DLL). The extension is only for later.

Engine adapters: one hook per engine
Every engine gets a small adapter that sends the same message to the app: POST /line with {speaker, text, engine}. The app, the voices and the overlay never change. Ren'Py is built first. Godot is the next target, and it can be hooked by adding two files beside the game without opening the game's own files.
Engine
What dubplay installs
How it reads text
Speaker name
Status
Ren'Py
dubgame.rpy in game/
Callback on every say statement
Exact
Build first (hour 0–1)
Godot 3 / 4
override.cfg and dubgame.gd beside the game's exe
An autoload script watches every Label and RichTextLabel on screen
Guessed, exact after calibration
Researched, untested. About 2–3 hours
RPG Maker MV / MZ
DubGame.js in js/plugins/ plus one entry in js/plugins.js
Wraps Window_Message.prototype.startMessage and reads $gameMessage.allText()
MZ: $gameMessage.speakerName(). MV: guessed
From general knowledge, untested. About 1–2 hours
Unity
BepInEx plus XUnity.AutoTranslator, set to a custom endpoint on localhost
XUnity sends each on-screen string to the app by HTTP GET. The app replies with the same text, so the game looks unchanged
Guessed, exact after calibration
Researched, untested. About 2–3 hours, fiddly config
TyranoBuilder
A JavaScript plugin, same idea as RPG Maker
Hooks the message layer
Usually
Later
Kirikiri and other Japanese engines
Nothing. Textractor (or its maintained fork LunaHook) plus the clipboard
Intercepts text drawing
Guessed
See the section above
Unreal and custom engines
Nothing
Screen capture plus Gemini vision
Guessed
Last resort
Godot: how the injection works
At startup, a Godot game reads a file named override.cfg beside its executable and lets it override project settings. Godot mod loaders use this to install themselves without touching the game's source.

dubplay's override.cfg adds one autoload, a script Godot starts automatically and keeps running for the whole session.

That script, dubgame.gd, sits beside the exe too. Five times a second it looks through the scene tree for visible Label and RichTextLabel nodes and posts any new text to the app.

A Label holds its full text even while a typewriter effect is revealing it, so the whole line arrives at once and the voice can start early.

 void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    var timer := Timer.new()
    timer.wait_time = 0.2
    timer.timeout.connect(_scan)
    add_child(timer)
    timer.start()

func _scan() -> void:
    var root := get_tree().root
    for n in root.find_children("*", "RichTextLabel", true, false):
        _check(n, n.get_parsed_text())
    for n in root.find_children("*", "Label", true, false):
        _check(n, n.text)

func _check(n: Node, text: String) -> void:
    if not n.is_visible_in_tree() or text.strip_edges().length() ]]><Calibration: the fix for speaker names and menu noise (Godot and Unity)
A generic watcher sees all text: menus, buttons, phone screens, and dialogue. Each line arrives tagged with its source (the node's path). The first time a game runs, the overlay lists the sources it has seen. The player ticks which one is dialogue and which one is the speaker's name, and dubplay saves that per game. Before calibration, the app skips one-word strings and exact repeats, and Gemini guesses the speaker from context.
Godot limitations and fixes
Limitation
Fix
Newer Godot versions let developers turn off override.cfg
Try the --script launch option (being removed from standard builds in Godot 4.6 and later). After that, Textractor or screen capture
An autoload added by override.cfg always loads last
Fine here. The script only watches; it doesn't need to change game code
Godot 3 and Godot 4 use different script syntax
Ship two versions of dubgame.gd. Ask Claude Code to port the Godot 4 one
Text drawn by custom code instead of Label nodes is invisible to the watcher
Screen capture for that game
On Mac, override.cfg goes inside the app bundle
Place it in <Game>.app/Contents/MacOS/
Patching the game's .pck with GDRE Tools would give deeper hooks
Skip it. It modifies the game's files and is too heavy for the hackathon
Until Then as a test case: it runs on Godot 4.1, so this route should apply, but nobody has tried it. Its dialogue appears in speech bubbles and a phone chat screen, so it needs calibration to sound right. Keep a Ren'Py game as the main demo. If the Godot adapter works by hour 6, show Until Then as the "second engine" moment.
Unity notes: XUnity.AutoTranslator is a translation mod, used here only as a text tap. Its custom endpoint setting and the exact request format come from projects that integrate with it, not from its own README, so read that README before building. Games compiled with IL2CPP need BepInEx 6.
Steam library scan
Detect compatible games by engine, not by the Visual Novel tag. Whether a game works depends on how it's built, not its genre. Plenty of tagged games aren't Ren'Py, and some untagged games are. The scan reads Steam's local files, so it needs no login and no API key.
How the scan works (runs in the app's main process)
Find Steam. On Windows, read SteamPath from the registry key HKCU\Software\Valve\Steam (default C:\Program Files (x86)\Steam). On Mac it's ~/Library/Application Support/Steam, on Linux ~/.steam/steam.

Find every library. Parse steamapps/libraryfolders.vdf, which lists every drive where games are installed. VDF is a simple text format. Use an npm VDF parser, or have Claude write a 30-line one.

List installed games. Each library has appmanifest_<appid>.acf files (same format) holding the app ID, name and installdir.

Detect the engine by looking in steamapps/common/<installdir> for the files below.

Keep only supported games and show them with cover art (loaded from Steam's image server by app ID) and a checkbox. Ticking copies dubgame.rpy into the game; unticking deletes it. Save the ticked list so the app can recheck it at every launch.

Engine
Files that identify it
dubplay support
Ren'Py
a renpy/ folder plus a game/ folder holding .rpy, .rpyc or .rpa files
Full: exact speaker names
Godot
a .pck file beside the exe, or an exe with the pack built in
Beta once the Godot adapter is built
RPG Maker MV / MZ
www/js/rpg_core.js (MV) or js/rmmz_core.js (MZ)
Beta once the RPG Maker adapter is built
Unity
UnityPlayer.dll and a <Game>_Data/ folder
Beta once the Unity adapter is built
Kirikiri
.xp3 archives
Hidden until Textractor mode ships
Anything else
none of the above
Hidden
The app lists a game only when its engine's adapter is built and working. At the hackathon that means Full (Ren'Py) games, plus a Beta badge on any engine whose adapter you finish. Beta means the text is read correctly but speaker names need calibration.
Where tags still help: use them to sort and badge, never to decide compatibility. Steam's official store API returns genres, not community tags like "Visual Novel". If you want tags, SteamSpy's API has them. Add an "Add game folder" button so non-Steam games (itch.io, DRM-free) work too.
Limitations and fixes
Limitation
Fix
A web page can't read the player's files
Solved by the desktop app, which reads and writes files directly
Older Ren'Py games (version 7 and earlier) run Python 2, newer ones Python 3
Write the hook so it runs on both (the code above is updated). Test on one old game and one new one
On Mac, a Ren'Py game's game/ folder is inside the .app bundle
Also check <Game>.app/Contents/Resources/autorun/game
Game updates or "Verify integrity" might remove the mod
Steam normally leaves extra files alone, but recheck at launch and show "Reinstall" if dubgame.rpy is missing
The game is already running when it's ticked
Ren'Py loads scripts at startup. Tell the player to restart the game
Copying fails with permission denied
Show the error and the folder path. Suggest running dubplay as administrator, or copying the file by hand
Libraries on other drives
Read every path in libraryfolders.vdf, not just the default library
Auto character identification with Gemini
Use Gemini to profile characters, not to read text: the Ren'Py hook already gives the name. Profile each character once, cache the result, and live dialogue only ever waits on ElevenLabs.
Step 1 — the hook (starting point; check it against a real game in hour 1)
If the name comes back empty, ask Claude Code to find another way to get the speaker inside a character callback for that Ren'Py version. Expect to tweak this.
Step 2 — profile everyone at launch. On startup the mod can loop over the game's Character objects and send all the names at once. Give Gemini each name plus a few sample lines. Profiling happens before the first line, so there's zero delay during play. A character seen for the first time mid-game gets profiled right then (about 1 s, once).
Step 3 — force JSON back. Use Gemini's structured output (response_mime_type: "application/json" plus a JSON schema) so every reply parses. Suggested schema:
Step 4 — map to a voice. Put about 12 ElevenLabs voices in the prompt, each with a one-line description ("warm young woman, American", "gruff older man, British"). Gemini picks one. That's fast and costs nothing extra. Generating brand-new voices from a text description with ElevenLabs Voice Design is the stretch goal: more unique, but slower and it uses more credits.
Step 5 — let players override it. Save every profile to voices.json. The overlay shows each character's card: voice dropdown, sliders, a Preview button, and a "Re-roll with AI" button. What the player sets always beats Gemini's pick.
Gemini or Grok? Pick one, and make it Gemini: it has a free tier, reads images (needed for the screen-capture fallback), and supports schema-enforced JSON. Grok also works, since xAI's API follows the OpenAI format, but juggling two providers wastes hackathon time.
Narration: when there's no speaker, either skip the line or use one calm narrator voice. Make it a toggle in the panel.
8-hour timeline
Five phases with a checkpoint at the end of each. By hour 3 you hear a game line spoken. By hour 5 every character has their own voice. At hour 7, stop adding features.
Don't start a phase until the checkpoint before it passes. If one slips, cut from Panel + polish, never from the core loop.
Person A — game hook
Install Ren'Py, pick the demo game, confirm it runs (hour 0–1)

Write dubgame.rpy and confirm lines reach the app's log (hour 0–1)

Steam scan that keeps only compatible games, plus tick-to-install and untick-to-remove (hour 3–5)

Send the full character list at launch (hour 3–5)

Stretch: the Godot adapter as a second engine, only after steps 4–6 pass (hour 5–7)

Person B — server and AI
Electron main process with a local server on port 8000 and a /line endpoint, keys in .env (hour 0–1)

ElevenLabs text-to-speech in one default voice, played by the app (hour 1–3)

Pick 12 ElevenLabs voices and write voices_catalog.json with a one-line description of each (hour 1–3)

Gemini profiling with the JSON schema, saved to voices.json (hour 3–5)

Cache audio per line so replays and the demo cost nothing (hour 5–7)

Save player keys with safeStorage and add the Test call (hour 5–7)

Person C — control panel and demo
Main window: compatible-games list with checkboxes and Launch buttons, built against fake data first (hour 1–3)

Overlay window: see-through, always on top, toggled with Shift+F2 (hour 3–5)

Character cards with voice dropdown, sliders, Preview, Re-roll (hour 3–7)

Settings screen: two key fields, Get a key buttons, Test button (hour 5–7)

Build the Windows installer at hour 6, then record the backup video and write the 2-minute pitch (hour 6–8)

Claude skills and workflow
Each person runs Claude Code on their own part. Four skills plus a shared CLAUDE.md keep three beginners from stepping on each other.
Skill or tool
Who
Use it for
frontend-design
C
Make the control panel look intentional (dark, ReShade-like) instead of a default template
webapp-testing (Playwright)
B, C
Have Claude open the panel, send fake /line events, and check that audio plays and sliders save, with no manual clicking. Playwright can drive Electron apps; ask Claude to set that up
skill-creator
Anyone, hour 0
Make a small "dub-game-conventions" skill: endpoint names, JSON shapes, file layout. All three Claude sessions then build to the same contract
ElevenLabs MCP server (optional)
B
Let Claude list voices and generate samples while you curate the 12-voice list
Workflow rules
Hour 0: write CLAUDE.md together. It should hold the architecture, the /line JSON shape {speaker, text}, the voices.json format, and "API keys stay in the main process, never in renderer code".

Ask Claude Code to plan first (plan mode), read the plan, then let it build.

Each person works in their own folder (mod/, main/, ui/), so changes never collide. Each engine's adapter gets a subfolder, such as mod/renpy and mod/godot.

Commit to git every time something works. If Claude breaks it, roll back instead of debugging for an hour.

Fake data unblocks everyone: C can build the windows against a hard-coded game list and character before B's code exists.

Hard parts and fixes
The biggest risk isn't the AI. It's getting the speaker name out of Ren'Py and keeping audio in sync, so test both in hour 1.
Problem
Fix
Speaker name comes back empty
Try _last_say_who first. If that fails, have Claude Code look up the character callback docs for that Ren'Py version. Last resort: have Gemini guess the speaker from the line
Game freezes while waiting on the network
Send from a background thread, as in the hook above. Never wait for a reply inside the callback
Player clicks ahead, voices pile up
When a new line arrives, stop the current audio. Only the newest line plays
Delay between text and voice
Profile characters at launch, use ElevenLabs' fastest model with streaming, and cache audio per line
Gemini picks a bad voice
Players override it in the panel, and their choice is saved. Add "Re-roll" to ask Gemini again
Text tags like {w} or {i} read aloud
Strip anything in {} before sending (done in the hook)
API keys leak
Keys live only in the main process's .env, which is listed in .gitignore
Free credits run out
Cache audio, test with short games, and share the team's free ElevenLabs credits
Demo-day plan
Rehearse on the exact game and save file you'll demo with.

Pre-generate the demo scene's audio so it plays from cache even if Wi-Fi dies.

Keep a 60-second backup video ready.

Bring a phone hotspot.

Stretch goals
Voices inside the game: have the mod play the audio file on Ren'Py's voice channel, so it feels like native voice acting.

Any-engine mode: Textractor plus a clipboard watcher (see Reading text without screenshots). Screen capture plus Gemini vision is the last resort.

Emotion per line: have Gemini tag each line's emotion and adjust the voice's style and stability to match.

Custom voices: ElevenLabs Voice Design generates a unique voice from each character's profile.

The future version: a ReShade add-on that draws the control panel inside the game.

Sources
Ren'Py character callbacks — config.all_character_callbacks, the events, and the what argument

ReShade 5.0 release notes — the add-on API and its singleplayer-only build

Gemini API structured output — JSON schema responses

Improving Structured Outputs in the Gemini API

ElevenLabs API authentication — API keys in the xi-api-key header

Using Gemini API keys — keys created in Google AI Studio

Godot Mod Loader: self setup — installing into a Godot game with override.cfg or the --script flag

godot-override-mod-loader — an override.cfg and a .gd file placed beside the game's exe

Godot issue 71589 — autoloads added by override.cfg load last

Godot Mod Loader issue 583 — --script removal in 4.6+, override.cfg can be disabled, Mac location

GDRE Tools — PCK patching, the heavier route not used here

Until Then FAQ on Steam — Godot Engine 4.1

translator-api-bridge — shows XUnity.AutoTranslator calling a custom endpoint by GET

Steam's file layout (libraryfolders.vdf, appmanifest_*.acf) and the engine file signatures come from general knowledge, not a page opened for this doc. Check them against a real Steam install in step 5.
The RPG Maker function names, the Godot file signatures and both code samples are also unverified. Nothing in this doc has been run against a real game yet.



## Appendix: code samples from the roadmap (untested starting points)

### override.cfg (Godot)

```ini
; override.cfg (beside the game's .exe)
[autoload]
DubGame="*res://dubgame.gd"
```

### dubgame.gd (Godot 4)

```gdscript
# dubgame.gd (beside the game's .exe). Godot 4 syntax. Untested starting point.
extends Node

const URL := "http://127.0.0.1:8000/line"
var seen := {}

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    var timer := Timer.new()
    timer.wait_time = 0.2
    timer.timeout.connect(_scan)
    add_child(timer)
    timer.start()

func _scan() -> void:
    var root := get_tree().root
    for n in root.find_children("*", "RichTextLabel", true, false):
        _check(n, n.get_parsed_text())
    for n in root.find_children("*", "Label", true, false):
        _check(n, n.text)

func _check(n: Node, text: String) -> void:
    if not n.is_visible_in_tree() or text.strip_edges().length() < 2:
        return
    var id := n.get_instance_id()
    if seen.get(id) == text:
        return
    seen[id] = text
    var req := HTTPRequest.new()
    add_child(req)
    req.request_completed.connect(func(_a, _b, _c, _d): req.queue_free())
    var body := JSON.stringify({"speaker": "unknown", "text": text,
        "engine": "godot", "source": str(n.get_path())})
    req.request(URL, ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)
```

### dubgame.rpy (Ren'Py hook)

```python
init python:
    import threading, json, re
    try:  # Ren'Py 8 (Python 3)
        from urllib.request import Request, urlopen
    except ImportError:  # Ren'Py 7 and earlier (Python 2)
        from urllib2 import Request, urlopen

    def _dub_post(path, payload):
        def go():
            try:
                req = Request("http://127.0.0.1:8000" + path,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"})
                urlopen(req, timeout=3)
            except Exception:
                pass  # never crash the game
        t = threading.Thread(target=go)
        t.daemon = True
        t.start()

    def dub_callback(event, interact=True, **kw):
        if event == "begin" and interact:
            who_var = getattr(store, "_last_say_who", None)
            char = getattr(store, who_var, None) if who_var else None
            name = getattr(char, "name", None) or "Narrator"
            text = re.sub(r"\{[^}]*\}", "", kw.get("what", ""))  # strip {w} tags
            _dub_post("/line", {"speaker": name, "text": text})

    config.all_character_callbacks.append(dub_callback)
```

### Gemini voice profile schema

```json
{
  "speaker": "string",
  "gender": "female | male | neutral",
  "age_range": "child | teen | young_adult | adult | elder",
  "personality": "string, 1 sentence",
  "voice_id": "one of the 12 voice IDs listed in the prompt",
  "stability": "0.0-1.0",
  "style": "0.0-1.0",
  "speed": "0.7-1.2",
  "reason": "string, why this voice"
}
```
