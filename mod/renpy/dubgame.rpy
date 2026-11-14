# dub.game hook for Ren'Py. Drop into <game>/game/. UNVERIFIED: starting point from the roadmap.
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
