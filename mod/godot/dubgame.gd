# dub.game hook for Godot 4 (beside the game's .exe, loaded by override.cfg as an autoload).
# UNVERIFIED: beta. Never run against a real Godot game. Godot 3 needs a ported copy
# (different signal/typing syntax). Speaker names are not known here ("unknown"); every line is
# tagged with its node path in `source` so the app can calibrate per game later.
extends Node

const URL := "http://127.0.0.1:8000/line"
const HEALTH := "http://127.0.0.1:8000/health"
var seen := {}
# "godot:<folder the game's .exe is in>", so each game keeps its own voices in the app.
var game_id := "godot:" + OS.get_executable_path().get_base_dir().get_file()

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    var timer := Timer.new()
    timer.wait_time = 0.2
    timer.timeout.connect(_scan)
    add_child(timer)
    timer.start()
    _go_borderless_if_app_running()

# The overlay can't sit over exclusive fullscreen. Godot 4's WINDOW_MODE_FULLSCREEN is the
# borderless kind, so when the app is running the game switches to it once at launch.
# With the app closed nothing changes. UNVERIFIED: not yet run against a real Godot game.
func _go_borderless_if_app_running() -> void:
    var req := HTTPRequest.new()
    req.timeout = 1.0
    add_child(req)
    req.request_completed.connect(func(result, code, _h, _b):
        req.queue_free()
        if result == HTTPRequest.RESULT_SUCCESS and code == 200:
            DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN)
    )
    if req.request(HEALTH) != OK:
        req.queue_free()

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
    req.timeout = 2.0
    add_child(req)
    req.request_completed.connect(func(_a, _b, _c, _d): req.queue_free())
    var body := JSON.stringify({"speaker": "unknown", "text": text,
        "engine": "godot", "game": game_id, "source": str(n.get_path())})
    if req.request(URL, ["Content-Type: application/json"], HTTPClient.METHOD_POST, body) != OK:
        req.queue_free()
