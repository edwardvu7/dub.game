# Generic Godot 4 adapter. Reads live scene nodes, never pixels or screenshots.
# UNVERIFIED: commercial games/custom export templates require individual compatibility testing.
extends Node

const BASE_URL := "http://127.0.0.1:8000"
const VERSION := 2
const MAX_LABELS := 512
var _labels: Array[WeakRef] = []
var _config: Dictionary = {}
var _http: HTTPRequest
var _pending: Array[Dictionary] = []
var _busy := false
var _tick := 0.0
var _heartbeat := 0.0
var _key := ""
var _stable_since := 0
var _sent := false
var _seq := 0
var _selected := ""

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_seq = int(Time.get_unix_time_from_system() * 1000.0)
	if not _load_config():
		queue_free()
		return
	_http = HTTPRequest.new()
	_http.timeout = 1.0
	add_child(_http)
	_http.request_completed.connect(_completed)
	get_tree().node_added.connect(_added)
	_scan(get_tree().root)

func _load_config() -> bool:
	var file := str(ProjectSettings.get_setting("dubgame_generic/config_path", ""))
	if not FileAccess.file_exists(file):
		return false
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(file))
	if parsed is Dictionary:
		_config = parsed
		return true
	return false

func _scan(node: Node) -> void:
	_added(node)
	for child in node.get_children():
		_scan(child)

func _added(node: Node) -> void:
	if node is Label or node is RichTextLabel:
		_labels = _labels.filter(func(ref: WeakRef) -> bool: return is_instance_valid(ref.get_ref()))
		if _labels.size() < MAX_LABELS:
			_labels.append(weakref(node))

func _text(node: Node) -> String:
	if node is RichTextLabel:
		return node.get_parsed_text().strip_edges()
	return str(node.text).strip_edges()

func _visible(node: CanvasItem) -> bool:
	if not node.is_visible_in_tree():
		return false
	var parent: Node = node
	while parent != null:
		if parent is CanvasItem and (parent.modulate.a <= 0.01 or parent.self_modulate.a <= 0.01 and parent == node):
			return false
		parent = parent.get_parent()
	return true

# Games build a fresh text box per line, so the engine numbers the nodes ("@VBoxContainer@5",
# "Bubble2"). Dropping those numbers lets a node the player picked once match every later copy.
func _stable(node_path: String) -> String:
	var parts := PackedStringArray()
	for part in node_path.split("/"):
		parts.append(part.rstrip("0123456789").rstrip("@"))
	return "/".join(parts)

func _score(node: Node) -> int:
	var context := ""
	var parent := node
	for i in range(4):
		if parent == null:
			break
		context += " " + str(parent.name).to_lower()
		if parent is BaseButton:
			return 0
		parent = parent.get_parent()
	for word in ["menu", "tooltip", "choice", "option", "hud", "inventory", "settings"]:
		if word in context:
			return 0
	var own := str(node.name).to_lower()
	if own in ["name", "title"]:
		return 0
	for word in ["speaker", "charactername", "name_label", "namelabel", "nametag", "name_tag"]:
		if word in own:
			return 0
	for word in ["narrat", "subtitle", "caption", "dialog", "speech", "cutscene", "conversation", "bubble", "balloon", "textbox", "text_box"]:
		if word in context:
			return 10 + mini(_text(node).length(), 200)
	return 0

func _speaker(node: Node, labels: Array) -> String:
	var chosen := str(_config.get("speakerPath", ""))
	if not chosen.is_empty():
		# With several text boxes on screen, the name beside this line wins.
		var found: Node = null
		for other in labels:
			if _stable(str(other.get_path())) == _stable(chosen) and (found == null or other.get_parent() == node.get_parent()):
				found = other
		return _text(found).left(100) if found != null else "Narrator"
	# Only a nearby explicitly named speaker label is evidence of a speaker.
	for other in labels:
		var name_lower := str(other.name).to_lower()
		if other != node and other.get_parent() == node.get_parent() and ("speaker" in name_lower or name_lower in ["name", "namelabel", "charactername", "nametag", "name_tag"]):
			return _text(other).left(100)
	return "Narrator"

func _process(delta: float) -> void:
	_tick += delta
	_heartbeat += delta
	if _tick < 0.1:
		return
	_tick = 0.0
	if _heartbeat >= 1.0 and not _load_config():
		_pending.clear()
		_http.cancel_request()
		_busy = false
		_enqueue("/stop", {"engine": "godot", "seq": _seq})
		set_process(false)
		return
	var visible: Array = []
	var diagnostics: Array = []
	var best: Node = null
	var best_score := 0
	var chosen := str(_config.get("textPath", ""))
	var chosen_stable := _stable(chosen)
	for ref in _labels:
		var node = ref.get_ref()
		if not is_instance_valid(node) or not node.is_inside_tree() or not _visible(node):
			continue
		var text := _text(node)
		if text.is_empty() or text.length() > 8000:
			continue
		visible.append(node)
		var node_path := str(node.get_path())
		var score := _score(node) if chosen.is_empty() else (1001 if node_path == chosen else (1000 if _stable(node_path) == chosen_stable else 0))
		if diagnostics.size() < 80:
			diagnostics.append({"path": node_path, "text": text.left(120), "candidate": score > 0})
		if score > best_score:
			best_score = score
			best = node
	_selected = str(best.get_path()) if best != null else ""
	var next_key := ""
	var text := ""
	var speaker := "Narrator"
	var complete := false
	if best != null:
		text = _text(best)
		speaker = _speaker(best, visible)
		if speaker.is_empty():
			speaker = "Narrator"
		next_key = _selected + "\n" + speaker + "\n" + text
		complete = best.visible_characters < 0 or best.visible_ratio >= 1.0
	# A new reveal of the same full text is also a new utterance.
	if best != null and _sent and not complete:
		_key = ""
	if next_key != _key:
		_key = next_key
		_stable_since = Time.get_ticks_msec()
		_sent = false
		_seq += 1
		# Cancel unsent old lines during rapid skipping. Queue stays bounded offline.
		_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint == "/godot/hook")
		_enqueue("/stop", {"engine": "godot", "seq": _seq})
	if not next_key.is_empty() and complete and not _sent and Time.get_ticks_msec() - _stable_since >= int(_config.get("settleMs", 650)):
		_sent = true
		_enqueue("/line", {"speaker": speaker, "text": text, "engine": "godot", "source": _selected, "seq": _seq})
	if _heartbeat >= 1.0:
		_heartbeat = 0.0
		_enqueue("/godot/hook", {"appid": str(_config.get("appid", "")), "token": str(_config.get("token", "")),
			"version": VERSION, "labels": diagnostics, "selectedPath": _selected, "limitReached": _labels.size() >= MAX_LABELS})

func _enqueue(endpoint: String, payload: Dictionary) -> void:
	payload["game"] = str(_config.get("game", "godot:unknown"))
	_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint != endpoint)
	_pending.append({"endpoint": endpoint, "body": JSON.stringify(payload)})
	_pump()

func _pump() -> void:
	if _busy or _pending.is_empty():
		return
	var item: Dictionary = _pending.pop_front()
	_busy = true
	var error := _http.request(BASE_URL + item.endpoint, ["Content-Type: application/json"], HTTPClient.METHOD_POST, item.body)
	if error != OK:
		_busy = false
		_pending.clear()

func _completed(result: int, code: int, _headers: PackedStringArray, _body: PackedByteArray) -> void:
	_busy = false
	if result != HTTPRequest.RESULT_SUCCESS or code != 204:
		_pending.clear()
	_pump.call_deferred()
