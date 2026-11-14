# dub.game hook for Ren'Py 7 (Python 2) and Ren'Py 8 (Python 3).
#
# dub.game copies this file into a game's `game/` folder. Ren'Py loads every .rpy file there at
# launch. It sends each line of dialogue to the dub.game app on localhost and nothing else:
# it never changes the game's own files, and the game runs normally when the app is closed.
#
# Contract (see CLAUDE.md):
#   POST /line        {speaker, text, engine: "renpy", seq}
#   POST /stop        {engine: "renpy", seq}            (player clicked past the line)
#   POST /characters  {engine: "renpy", characters: [{speaker, samples}]}   (once, at launch)
#   GET  /health      (once, at launch) is the app running? If so, keep the game windowed.
#
# Windowed mode: the dub.game overlay cannot appear over a fullscreen game. While the app is
# running, the hook keeps the game's own "fullscreen" preference off. With the app closed the
# game is left exactly as the player set it.
#
# UNVERIFIED: not yet run inside a real Ren'Py game. The speaker lookup (_last_say_who) and the
# script walk used for sample lines are the two things to check first against the demo game.
# DUBGAME_HOOK_VERSION 4

init -999 python:
    import json as _dubgame_json
    import re as _dubgame_re
    import sys as _dubgame_sys
    import threading as _dubgame_threading

    try:  # Ren'Py 8 (Python 3)
        from urllib.request import Request as _dubgame_Request, urlopen as _dubgame_urlopen
    except ImportError:  # Ren'Py 7 and earlier (Python 2)
        from urllib2 import Request as _dubgame_Request, urlopen as _dubgame_urlopen

    _dubgame_URL = "http://127.0.0.1:8000"
    _dubgame_TIMEOUT = 2
    _dubgame_text_type = type(u"")
    _dubgame_state = {"seq": 0, "sent_characters": False, "app_running": False}

    # One sender thread, in order. Separate threads per line could reach the app out of order
    # when the player clicks fast, and an old line would then play over the current one.
    _dubgame_queue = []
    _dubgame_cv = _dubgame_threading.Condition()
    _dubgame_worker = {"thread": None}

    def _dubgame_send_now(path, payload):
        try:
            req = _dubgame_Request(
                _dubgame_URL + path,
                data=_dubgame_json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            _dubgame_urlopen(req, timeout=_dubgame_TIMEOUT).read()
        except Exception:
            pass  # app not running, port busy, anything: stay silent

    def _dubgame_run():
        while True:
            with _dubgame_cv:
                while not _dubgame_queue:
                    _dubgame_cv.wait()
                path, payload = _dubgame_queue.pop(0)
            _dubgame_send_now(path, payload)

    def _dubgame_post(path, payload):
        """Queue a POST for the sender thread. Never blocks or raises into the game."""
        try:
            with _dubgame_cv:
                if path == "/line":
                    del _dubgame_queue[:]  # a newer line makes anything still unsent obsolete
                _dubgame_queue.append((path, payload))
                del _dubgame_queue[:-20]
                _dubgame_cv.notify()
                t = _dubgame_worker["thread"]
                if t is None or not t.is_alive():
                    t = _dubgame_threading.Thread(target=_dubgame_run)
                    t.daemon = True
                    t.start()
                    _dubgame_worker["thread"] = t
        except Exception:
            pass

    def _dubgame_clean(text):
        """Interpolate [variables], then strip {text tags} so they are not read aloud."""
        if text is None:
            return u""
        if not isinstance(text, _dubgame_text_type):
            try:
                text = text.decode("utf-8")
            except Exception:
                text = _dubgame_text_type(text)
        try:
            text = renpy.substitute(text)
        except Exception:
            pass
        text = text.replace(u"{{", u"\x00")           # {{ is an escaped literal brace
        text = _dubgame_re.sub(u"\\{[^}]*\\}", u"", text)
        text = text.replace(u"\x00", u"{")
        return u" ".join(text.split())

    def _dubgame_char_name(char):
        """Display name of a Character object, or None when it has no name (narration)."""
        if char is None:
            return None
        if isinstance(char, (_dubgame_text_type, str)):
            return _dubgame_clean(char) or None       # `"Name" "line"` form
        name = getattr(char, "name", None)
        if name is None:
            return None
        try:
            if getattr(char, "dynamic", False):
                name = eval(name, vars(store))        # dynamic=True: the name is an expression
            if callable(name):
                name = name()
        except Exception:
            pass
        return _dubgame_clean(name) or None

    def _dubgame_speaker():
        who = getattr(store, "_last_say_who", None)
        if who is None:
            return u"Narrator"
        char = None
        try:
            ast = _dubgame_sys.modules.get("renpy.ast")
            char = ast.eval_who(who)
        except Exception:
            try:
                char = getattr(store, who, None)
            except Exception:
                char = None
        return _dubgame_char_name(char) or u"Narrator"

    def _dubgame_keep_windowed():
        """Main thread only. Turns the fullscreen preference off while the app is running."""
        # UNVERIFIED: relies on Ren'Py re-reading preferences.fullscreen at the next interaction,
        # which is how its own Display > Window preference works.
        try:
            if not _dubgame_state["app_running"]:
                return
            prefs = getattr(_dubgame_sys.modules.get("renpy.game"), "preferences", None)
            if prefs is None:
                prefs = getattr(store, "_preferences", None)
            if prefs is not None and getattr(prefs, "fullscreen", False):
                prefs.fullscreen = False
        except Exception:
            pass

    def _dubgame_callback(event, interact=True, **kwargs):
        try:
            if not interact:
                return
            if event == "begin":
                _dubgame_keep_windowed()
                if config.skipping:
                    return  # player is fast-forwarding; do not voice skipped lines
                what = kwargs.get("what") or getattr(store, "_last_say_what", None)
                text = _dubgame_clean(what)
                if not text:
                    return
                _dubgame_state["seq"] += 1
                _dubgame_post("/line", {
                    "speaker": _dubgame_speaker(),
                    "text": text,
                    "engine": "renpy",
                    "seq": _dubgame_state["seq"],
                })
            elif event == "end":
                # The player moved on. The app ignores this if a newer line already arrived.
                _dubgame_post("/stop", {"engine": "renpy", "seq": _dubgame_state["seq"]})
        except Exception:
            pass  # never crash the game

    def _dubgame_collect_characters():
        """[{speaker, samples}] for every named Character, with a few lines of their dialogue."""
        character_mod = _dubgame_sys.modules.get("renpy.character")
        ast = _dubgame_sys.modules.get("renpy.ast")
        base = getattr(character_mod, "ADVCharacter", None)
        if base is None:
            return []
        by_var = {}
        for key, value in list(vars(store).items()):
            if key.startswith("_") or not isinstance(value, base):
                continue
            name = _dubgame_char_name(value)
            if name and u"[" not in name:
                by_var[key] = name
        samples = {}
        try:
            script = _dubgame_sys.modules.get("renpy.game").script
            say_type = getattr(ast, "Say", None)
            for node in list(script.namemap.values()):
                if say_type is None or not isinstance(node, say_type):
                    continue
                name = by_var.get(getattr(node, "who", None))
                if not name:
                    continue
                lines = samples.setdefault(name, [])
                if len(lines) < 4:
                    line = _dubgame_clean(getattr(node, "what", u""))[:200]
                    if line:
                        lines.append(line)
        except Exception:
            pass
        names = sorted(set(by_var.values()))
        if samples:
            names = [n for n in names if n in samples]  # drop characters that never speak
        return [{"speaker": n, "samples": samples.get(n, [])} for n in names[:60]]

    def _dubgame_send_characters():
        if _dubgame_state["sent_characters"]:
            return
        _dubgame_state["sent_characters"] = True
        def work():
            try:
                _dubgame_urlopen(_dubgame_URL + "/health", timeout=_dubgame_TIMEOUT).read()
                _dubgame_state["app_running"] = True  # applied on the main thread, see below
            except Exception:
                return  # app closed: nothing to send, and the game's display mode is left alone
            try:
                characters = _dubgame_collect_characters()
                if characters:
                    req = _dubgame_Request(
                        _dubgame_URL + "/characters",
                        data=_dubgame_json.dumps(
                            {"engine": "renpy", "characters": characters}).encode("utf-8"),
                        headers={"Content-Type": "application/json"})
                    _dubgame_urlopen(req, timeout=_dubgame_TIMEOUT).read()
            except Exception:
                pass
        try:
            t = _dubgame_threading.Thread(target=work)
            t.daemon = True
            t.start()
        except Exception:
            pass

    try:
        config.all_character_callbacks.append(_dubgame_callback)
    except Exception:
        pass
    try:
        # Every interaction (menus included), so the game is windowed before the first line.
        config.interact_callbacks.append(_dubgame_keep_windowed)
    except Exception:
        pass
    try:
        # Runs after the init phase, when every Character has been defined.
        config.start_callbacks.append(_dubgame_send_characters)
    except Exception:
        pass
