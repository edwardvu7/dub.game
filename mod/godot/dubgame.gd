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
