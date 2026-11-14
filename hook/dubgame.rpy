# dub.game hook for Ren'Py 8 (Python 3).
#
# Drop this file into a game's `game/` folder. Ren'Py loads it automatically.
# It sends every line of dialogue to the dub.game app on localhost.
# The game keeps running normally if the app isn't open.
#
# Not yet tested against a real game; check the speaker/text lookup with the
# Ren'Py version of the game you demo with.

init -999 python:
    import json
    import threading
    import urllib.request

    DUBGAME_URL = "http://127.0.0.1:8765"

    def _dubgame_game():
        # Read lazily: config.name is set later in init than this file runs.
        return config.name or config.save_directory or "unknown-game"

    def _dubgame_post(path, payload):
        def send():
            try:
                req = urllib.request.Request(
                    DUBGAME_URL + path,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                urllib.request.urlopen(req, timeout=2).read()
            except Exception:
                pass  # app not running; stay silent
        threading.Thread(target=send, daemon=True).start()

    def _dubgame_speaker():
        """Display name of whoever is speaking, or None for narration."""
        who = getattr(store, "_last_say_who", None)
        if who is None:
            return None
        try:
            char = renpy.eval_who(who)
        except Exception:
            return str(who)
        name = getattr(char, "name", None)
        if callable(name):
            name = name()
        if name:
            try:
                name = renpy.substitute(name)
            except Exception:
                pass
        return name or None

    def _dubgame_callback(event, interact=True, **kwargs):
        if not interact:
            return
        if event == "begin":
            if renpy.config.skipping:
                return  # player is fast-forwarding
            what = kwargs.get("what") or getattr(store, "_last_say_what", None)
            if not what:
                return
            try:
                what = renpy.substitute(what)
            except Exception:
                pass
            _dubgame_post("/line", {
                "game": _dubgame_game(),
                "character": _dubgame_speaker(),
                "text": what,
                "event": "begin",
            })
        elif event == "end":
            _dubgame_post("/stop", {})  # player clicked past the line

    config.all_character_callbacks.append(_dubgame_callback)
