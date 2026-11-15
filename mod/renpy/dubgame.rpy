# dub.game hook for Ren'Py 7 (Python 2) and Ren'Py 8 (Python 3).
#
# dub.game copies this file into a game's `game/` folder. Ren'Py loads every .rpy file there at
# launch. It sends each line of dialogue to the dub.game app on localhost and nothing else:
# it never changes the game's own files, and the game runs normally when the app is closed.
#
# Contract (see CLAUDE.md):
#   POST /line        {speaker, speaker_id?, text, engine: "renpy", game, seq, upcoming: [{speaker, text}]}
#   POST /stop        {engine: "renpy", game, seq}      (player clicked past the line)
#   POST /characters  {engine: "renpy", game, characters: [{speaker, id?, samples}]}   (once, at launch)
#   game is "renpy:<game folder name>", so each game keeps its own voices in the app.
#   GET  /health      (once, at launch) is the app running? If so, start windowed (first run only).
#
# Display mode: the dub.game overlay can sit on top of a windowed or borderless game, but not
# an exclusive-fullscreen one (Ren'Py 6.99, DDLC, may use one). So the first time the game runs
# with the app open, the hook switches it to windowed (preferences.fullscreen = False) and records
# that in persistent.dubgame_windowed. After that the player's own choice wins: they can go
# fullscreen again and it stays. With the app closed the game is left as the player set it.
#
# speaker_id / id: DynamicCharacter names change (Girl 1 -> Sayori), so /line carries the optional
# speaker_id (the variable holding the Character, else its image tag) and /characters entries an id.
#
# UNVERIFIED: not yet run inside a real Ren'Py game. The speaker lookup (_last_say_who) and the
# script walk used for sample lines are the two things to check first against the demo game.
# UNVERIFIED (DDLC, Ren'Py 6.99 / Python 2): DynamicCharacter names (s_name), [player] substitution via
# renpy.substitute (if missing on 6.99 the text keeps "[player]"), garbled glitch text sent as is, and
# `extend` lines (Ren'Py passes the whole accumulated text). The hook binds no keys, so Shift+F2 is never eaten.
# DUBGAME_HOOK_VERSION 9

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

    def _dubgame_game_id():
        # The folder the game is installed in (config.basedir), the same name Steam uses.
        try:
            import os as _os
            path = _os.path.normpath(config.basedir)
            # macOS: <Steam folder>/<Game>.app/Contents/Resources/autorun. Steam's folder name is the
            # one above the .app, which is what the app matches against.
            parts = path.replace("\\", "/").split("/")
            for i, part in enumerate(parts):
                if i > 0 and part.lower().endswith(".app") and parts[i + 1:i + 4] == ["Contents", "Resources", "autorun"]:
                    path = "/".join(parts[:i])
                    break
            base = _os.path.basename(path)
            if base:
                return u"renpy:" + (base if isinstance(base, type(u"")) else base.decode("utf-8", "replace"))
        except Exception:
            pass
        return u"renpy:unknown"

    _dubgame_game = _dubgame_game_id()

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
        return _dubgame_name_of(getattr(store, "_last_say_who", None))

    def _dubgame_char_of(who):
        if who is None:
            return None
        try:
            ast = _dubgame_sys.modules.get("renpy.ast")
            return ast.eval_who(who)
        except Exception:
            try:
                return eval(who, vars(store))  # a variable name, or a quoted literal name
            except Exception:
                return None

    def _dubgame_name_of(who):
        if who is None:
            return u"Narrator"
        return _dubgame_char_name(_dubgame_char_of(who)) or u"Narrator"

    def _dubgame_speaker_id():
        who = getattr(store, "_last_say_who", None)
        return _dubgame_id_of(who, _dubgame_char_of(who))

    def _dubgame_windowed():
        """Main thread only. The first time the game runs with the app open, start it windowed."""
        # UNVERIFIED: relies on Ren'Py re-reading preferences.fullscreen at the next interaction,
        # which is how its own Display > Window preference works (6.99 and 7/8 alike).
        try:
            if not _dubgame_state["app_running"] or _dubgame_state.get("display_set"):
                return
            _dubgame_state["display_set"] = True
            pers = getattr(store, "persistent", None)
            if pers is None or getattr(pers, "dubgame_windowed", False):
                return  # already done once: the player's own choice wins from now on
            pers.dubgame_windowed = True
            prefs = getattr(_dubgame_sys.modules.get("renpy.game"), "preferences", None)
            if prefs is None:
                prefs = getattr(store, "_preferences", None)
            if prefs is not None and getattr(prefs, "fullscreen", False):
                prefs.fullscreen = False
        except Exception:
            pass

    _dubgame_ID = _dubgame_re.compile(r"^[A-Za-z0-9_]{1,40}$")

    def _dubgame_id_of(who, char):
        """Stable per-character id: the variable holding the Character (DDLC: s, m, n, y, mc), else its image tag."""
        try:
            if who is None:
                return None
            if isinstance(who, (_dubgame_text_type, str)) and _dubgame_ID.match(who) and char is not None:
                return str(who)
            tag = getattr(char, "image_tag", None)
            if tag and _dubgame_ID.match(tag):
                return str(tag)
        except Exception:
            pass
        return None

    _dubgame_STOPS = ("Menu", "Jump", "Call", "Return", "If", "While")

    def _dubgame_upcoming():
        """The next lines of the script, up to the next choice or jump, for the app to direct ahead."""
        out = []
        try:
            game_mod = _dubgame_sys.modules.get("renpy.game")
            ast = _dubgame_sys.modules.get("renpy.ast")
            stops = tuple(t for t in (getattr(ast, n, None) for n in _dubgame_STOPS) if t)
            # UNVERIFIED: context().current is the say statement being shown, per Ren'Py's source.
            node = game_mod.script.lookup(game_mod.context().current)
            node = getattr(node, "next", None)
            steps = 0
            while node is not None and len(out) < 20 and steps < 300:
                steps += 1
                if stops and isinstance(node, stops):
                    break  # the story branches here: what follows is not known yet
                if isinstance(node, ast.Say):
                    text = _dubgame_clean(getattr(node, "what", u""))[:300]
                    if text:
                        out.append({"speaker": _dubgame_name_of(getattr(node, "who", None)), "text": text})
                node = getattr(node, "next", None)
        except Exception:
            pass
        return out

    def _dubgame_callback(event, interact=True, **kwargs):
        try:
            if not interact:
                return
            if event == "begin":
                _dubgame_windowed()
                if config.skipping:
                    return  # player is fast-forwarding; do not voice skipped lines
                what = kwargs.get("what") or getattr(store, "_last_say_what", None)
                text = _dubgame_clean(what)
                if not text:
                    return
                _dubgame_state["seq"] += 1
                payload = {
                    "speaker": _dubgame_speaker(),
                    "text": text,
                    "engine": "renpy",
                    "game": _dubgame_game,
                    "seq": _dubgame_state["seq"],
                    "upcoming": _dubgame_upcoming(),
                }
                sid = _dubgame_speaker_id()
                if sid:
                    payload["speaker_id"] = sid
                _dubgame_post("/line", payload)
            elif event == "end":
                # The player moved on. The app ignores this if a newer line already arrived.
                _dubgame_post("/stop", {"engine": "renpy", "game": _dubgame_game, "seq": _dubgame_state["seq"]})
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
        ids = {}
        for key, name in by_var.items():
            if _dubgame_ID.match(key):
                ids.setdefault(name, key)
        out = []
        for n in names[:60]:
            entry = {"speaker": n, "samples": samples.get(n, [])}
            if n in ids:
                entry["id"] = ids[n]
            out.append(entry)
        return out

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
                            {"engine": "renpy", "game": _dubgame_game, "characters": characters}).encode("utf-8"),
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
        # Every interaction (menus included), so the first-run windowed switch happens before the first line.
        config.interact_callbacks.append(_dubgame_windowed)
    except Exception:
        pass
    try:
        # Runs after the init phase, when every Character has been defined.
        config.start_callbacks.append(_dubgame_send_characters)
    except Exception:
        pass
