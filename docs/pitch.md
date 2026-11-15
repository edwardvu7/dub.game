# dubplay: 2-minute pitch and demo checklist

## The pitch (about 2 minutes)

**The problem (15 s).** Thousands of visual novels ship with no voice acting, because recording a
cast costs more than most small studios have. Players read every line in silence.

**What dubplay does (20 s).** dubplay gives every character a voice. It finds the visual novels
in your Steam library, you switch one on, and when you launch it each character speaks in their
own voice, chosen automatically. You don't edit the game or set anything up per character.

**Live demo (60 s).**
1. Open dubplay. It lists only the installed games it supports.
2. Switch on the demo game and click Launch.
3. Advance a few lines. Two or three characters speak, each with a different voice.
4. Press Shift + F2. The overlay opens on top of the game.
5. Change one character's voice or drag a slider, advance, and the next line sounds different.
6. Show Settings for five seconds: players use their own ElevenLabs and Gemini keys.

**How it works (15 s).** A small script inside the game sends each line and the speaker's name to
the app. Gemini reads a character's first lines once and casts a voice. ElevenLabs speaks every
line after that. Audio is cached, so replaying a scene costs nothing.

**What's next (10 s).** The same app works for other engines with a small adapter each: Godot is
next, then RPG Maker and Unity. Longer term, a unique generated voice per character and emotion
per line.

## Demo checklist

Before the demo:
- [ ] Demo machine: Windows, Steam running, demo game installed and switched on in dubplay
- [ ] Both API keys saved, and both Test buttons show a green check
- [ ] Play the demo scene once all the way through, so every line is cached and plays without Wi-Fi
- [ ] Game set to windowed or borderless (the overlay does not show over exclusive fullscreen)
- [ ] Volume checked on the room's speakers
- [ ] A save file placed just before the demo scene
- [ ] 60-second backup video on the desktop, and a phone hotspot ready

If something breaks:
- No sound: check the now-playing bar at the bottom of the main window. If lines arrive but the
  meter never moves, test the ElevenLabs key in Settings.
- No lines arrive: the game was open when it was switched on. Restart the game.
- A game tile says the script is missing: click Reinstall, then restart the game.
- "Port 8000 is already in use": close the other program (or a second dubplay) and restart.
- Overlay does not open: another program owns Shift + F2. Use the Voices tab in the main window.

## Trying the UI without the app

Open `ui/index.html` or `ui/overlay.html` in a browser. `ui/fake-dub.js` supplies sample games,
characters and a line every five seconds. In the console, `dubFake.emit(channel, payload)` fires
any event by hand.
