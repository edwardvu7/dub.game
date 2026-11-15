# npm run smoke:hook. Runs the init block of mod/renpy/dubgame.rpy with a stand-in for Ren'Py, then plays a short
# scene and checks what reaches a local server on port 8000.
import sys, types, json, threading, time, re, textwrap
from http.server import BaseHTTPRequestHandler, HTTPServer

got = []
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        got.append((self.path, json.loads(body)))
        self.send_response(204); self.end_headers()
    def do_GET(self):
        got.append((self.path, None))
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
srv = HTTPServer(("127.0.0.1", 8000), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

# --- stand-in Ren'Py ---
class ADVCharacter:
    def __init__(self, name, dynamic=False): self.name = name; self.dynamic = dynamic
class Say:
    def __init__(self, who, what): self.who = who; self.what = what; self.next = None
class Menu:
    next = None
store = types.SimpleNamespace()
store.player_name = "Ana"
store.s = ADVCharacter("Sylvie")
store.m = ADVCharacter("Marcus")
store.p = ADVCharacter("player_name", dynamic=True)
store.extra = ADVCharacter("Never Speaks")
store.m_name = "Girl 3"                          # DDLC: the name is a variable, its value changes
store.mo = ADVCharacter("m_name", dynamic=True)
store.mo2 = ADVCharacter("m_name")               # dynamic flag not visible: still resolved
store.gone = ADVCharacter("zz_name", dynamic=True)  # unresolvable: must never send the variable name
ast = types.ModuleType("renpy.ast"); ast.Say = Say; ast.Menu = Menu
def eval_who(who):
    return getattr(store, who) if isinstance(who, str) and hasattr(store, who) else who
ast.eval_who = eval_who
character_mod = types.ModuleType("renpy.character"); character_mod.ADVCharacter = ADVCharacter
game_mod = types.ModuleType("renpy.game")
namemap = {1: Say("s", "Hi {b}there{/b}, [player_name]!"), 2: Say("m", "Hm."), 3: Say("p", "Hello."), 4: Menu(), 5: Say(None, "After the choice.")}
for a, b in [(1, 2), (2, 3), (3, 4), (4, 5)]: namemap[a].next = namemap[b]
game_mod.script = types.SimpleNamespace(namemap=namemap, lookup=lambda name: namemap[name])
game_mod.context = lambda: types.SimpleNamespace(current=1)  # the player is on line 1 of the script
for name, mod in [("renpy.ast", ast), ("renpy.character", character_mod), ("renpy.game", game_mod)]:
    sys.modules[name] = mod
def substitute(t): return re.sub(r"\[(\w+)\]", lambda m: str(getattr(store, m.group(1), m.group(0))), t)
renpy = types.SimpleNamespace(substitute=substitute)
config = types.SimpleNamespace(all_character_callbacks=[], start_callbacks=[], interact_callbacks=[], skipping=None, basedir="/games/The Question/")
game_mod.preferences = types.SimpleNamespace(fullscreen=True)
store.persistent = types.SimpleNamespace()

import os
src = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "mod", "renpy", "dubgame.rpy"), encoding="utf-8").read()
block = src.split("init -999 python:", 1)[1]
code = textwrap.dedent(block)
env = {"store": store, "renpy": renpy, "config": config, "__builtins__": __builtins__}
exec(compile(code, "dubgame.rpy", "exec"), env)

ok_all = True
def check(ok, what):
    global ok_all
    print(("PASS " if ok else "FAIL ") + what); ok_all = ok_all and ok

check(len(config.all_character_callbacks) == 1 and len(config.start_callbacks) == 1, "hook registers its say callback and start callback")
cb = config.all_character_callbacks[0]

# game start: characters
config.start_callbacks[0](); time.sleep(0.5)
check(game_mod.preferences.fullscreen is True, "the display mode is not touched from the background thread")
config.interact_callbacks[0]()
check(game_mod.preferences.fullscreen is False and store.persistent.dubgame_windowed, "with the app running, the first run starts windowed")
chars = [b for p, b in got if p == "/characters"]
check(len(chars) == 1, "sends /characters once at launch")
names = sorted(c["speaker"] for c in chars[0]["characters"]) if chars else []
check(names == ["Ana", "Marcus", "Sylvie"], "characters: " + str(names) + " (silent one dropped, dynamic name resolved)")
syl = [c for c in chars[0]["characters"] if c["speaker"] == "Sylvie"] if chars else []
check(syl and syl[0]["samples"] == ["Hi there, Ana!"], "sample lines are cleaned: " + str(syl and syl[0]["samples"]))

def say(who, what, **kw):
    store._last_say_who = who; store._last_say_what = what
    cb("begin", interact=True, what=what, **kw); cb("show"); time.sleep(0.15); cb("end", interact=True)
    time.sleep(0.15)  # the player reads, then clicks

got.clear()
game_mod.preferences.fullscreen = True  # the player goes fullscreen after the first run
say("s", "Welcome back, [player_name]. {w}I missed you{{really}}.")
say(None, "The rain kept falling.")
say("p", "Thanks.")
say("m", "Ignore me", )  # normal
config.skipping = "fast"; say("m", "skipped line"); config.skipping = None
cb("begin", interact=False, what="no interaction")
time.sleep(0.3)
check(game_mod.preferences.fullscreen is True, "the player's own fullscreen choice is kept")
lines = [b for p, b in got if p == "/line"]
stops = [b for p, b in got if p == "/stop"]
got.clear()
store._last_say_who = "m"
start = time.time()
for i in range(50): cb("begin", interact=True, what="burst %d" % i)
elapsed = time.time() - start
time.sleep(0.8)
burst = [b for p, b in got if p == "/line"]
seqs = [b["seq"] for b in burst]
check(burst and burst[-1]["text"] == "burst 49", "a burst of 50 clicks always ends on the newest line (%d of 50 sent)" % len(burst))
check(seqs == sorted(seqs), "lines reach the app in order")
check({k: v for k, v in lines[0].items() if k not in ("upcoming", "speaker_id")} == {"speaker": "Sylvie", "text": "Welcome back, Ana. I missed you{really}}.", "engine": "renpy", "game": "renpy:The Question", "seq": 1}, "line 1: " + json.dumps(lines[0]))
check(chars and chars[0].get("game") == "renpy:The Question", "the cast is tagged with the game too")
check(stops and all(b.get("game") == "renpy:The Question" for b in stops), "so is /stop")
check(lines[1]["speaker"] == "Narrator", "narration is sent as Narrator")
check(lines[0].get("upcoming") == [{"speaker": "Marcus", "text": "Hm."}, {"speaker": "Ana", "text": "Hello."}],
      "the next lines are sent ahead, up to the next choice: " + json.dumps(lines[0].get("upcoming")))
check(lines[0].get("speaker_id") == "s" and "speaker_id" not in lines[1] and lines[2].get("speaker_id") == "p", "speaker_id is the character variable, none for the narrator")
check(sorted(c.get("id") for c in chars[0]["characters"]) == ["m", "p", "s"], "characters carry their id")
check(len(lines) == 4, "all 4 lines at reading pace arrive: %d" % len(lines))
check(lines[2]["speaker"] == "Ana", "dynamic player name resolved for a line")
check(not any(b["text"] in ("skipped line", "no interaction") for b in lines), "skipped and non-interactive lines are not sent")
check(len(stops) >= 4, "player advancing sends /stop (%d)" % len(stops))
check(elapsed < 0.2, "callback never blocks the game (50 calls in %.0f ms)" % (elapsed * 1000))

nm = env["_dubgame_char_name"]
check(nm(store.mo) == "Girl 3" and nm(store.mo2) == "Girl 3", "DynamicCharacter 'm_name' resolves to the variable's value, flag or not")
store.m_name = "Monika"
check(nm(store.mo) == "Monika", "the name is read again on every line (Girl 3 -> Monika)")
check(nm(store.gone) is None and env["_dubgame_name_of"]("gone") == "Narrator", "an unresolvable variable name is never sent")
store._last_say_who = "mo"; got.clear(); cb("begin", interact=True, what="Just Monika."); time.sleep(0.3)
dl = [b for p, b in got if p == "/line"]
check(dl and dl[0]["speaker"] == "Monika" and dl[0].get("speaker_id") == "mo", "/line speaker is Monika, speaker_id the variable")

srv.shutdown(); srv.server_close()
# app not running: must stay silent and fast
start = time.time(); cb("begin", interact=True, what="nobody listening"); time.sleep(0.3)
check(time.time() - start < 0.5, "no crash and no stall when the app is closed")
# A fresh game start with the app closed: the display mode must be left alone.
config.all_character_callbacks[:] = []; config.start_callbacks[:] = []; config.interact_callbacks[:] = []
game_mod.preferences.fullscreen = True
store.persistent = types.SimpleNamespace()
exec(compile(code, "dubgame.rpy", "exec"), env)
config.start_callbacks[0](); time.sleep(0.4); config.interact_callbacks[0]()
config.all_character_callbacks[0]("begin", interact=True, what="hello")
check(game_mod.preferences.fullscreen is True, "with the app closed, the game keeps its own display setting")
print("\nALL HOOK CHECKS PASSED" if ok_all else "\nHOOK PROBLEMS")
sys.exit(0 if ok_all else 1)
