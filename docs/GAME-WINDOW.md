# Game-bound overlay (Windows)

Launch the game from dubplay, focus the game and wait a few seconds for Windows
tracking to initialize. The launcher removes the caption/resize border and positions
the window at the full bounds of the monitor containing it, including monitors with
negative desktop coordinates. It applies this once; later player-selected window
sizes are respected. This is a window-style change, not a guarantee that an engine
has exited exclusive fullscreen. Use the game's own borderless setting if necessary.

Ren'Py games start windowed the first time they run through dubplay (hook v9), so the overlay always
shows; the player can switch to fullscreen afterwards and it stays. The overlay is always-on-top
(screen-saver level), so it also works over a borderless fullscreen SDL window.

Shift+F2 opens/closes the overlay. Its bounds use the game's **client rectangle**,
converted from physical pixels to Electron DIP. Dragging is clamped to that rectangle;
the panel shrinks for smaller game windows and follows the game when it moves. The
saved offset is per game, relative to its window. Alt+Tab and minimization hide the
panel; returning to the game restores it if you left it enabled. Closing the panel
explicitly disables it until the next hotkey press. Launching another game resets it.

Only a game launched by this app is eligible. Source Godot projects use the spawned
PID. Exports and Steam games match a foreground process executable inside the chosen
installation directory (including subdirectories). Unrelated foreground apps are
never resized. A game executable outside that directory, an elevated game whose
process cannot be read, or an external launcher may prevent detection. A splash
window that closes after acquisition requires relaunching from dubplay. Tracking
waits up to two minutes for initial focus and uses one PowerShell worker, not a new
process per frame. Worker failures are shown in the app; no screen-wide overlay is
shown when tracking is unavailable. The worker stops when the app or target exits.

macOS/Linux: launching still works, but game-bound native tracking is not implemented;
the app's Voices tab remains available. On Windows, allow the game to take focus
before using the hotkey. Godot itself must be installed for source projects.

## Verification

`npm test` covers bounds, negative monitor origins, small windows, relative offsets,
worker parsing and lifecycle, and launcher callbacks. `npm run smoke` checks app
wiring with Electron/API substitutes; `npm run smoke:godot` checks the real Godot
voice adapter headlessly. These checks do **not** execute user32.dll.

UNVERIFIED: native Windows positioning, game rendering after style changes, installed
builds, elevated games, fullscreen transitions, multi-monitor DPI and focus behavior.
Rehearse on the actual Windows machine:

1. Launch on each monitor (including one left/above primary); check all four edges.
2. Press Shift+F2. Drag the overlay toward every edge; it must stay inside the game.
3. Switch the game to windowed mode, resize and move it; the overlay must follow.
4. Alt+Tab, minimize, restore and close the game. The overlay must not cover other apps.
5. Repeat at 100%, 125% and 150% scaling. Check voice controls remain accessible.

References: Electron screen.screenToDipRect and BrowserWindow will-move;
Microsoft MonitorFromWindow, GetMonitorInfo, ClientToScreen and SetWindowPos.
