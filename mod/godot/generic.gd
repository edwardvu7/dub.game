# Generic Godot 4 adapter. Reads live scene nodes, never pixels or screenshots.
# UNVERIFIED: commercial games/custom export templates require individual compatibility testing.
extends Node

const BASE_URL := "http://127.0.0.1:8000"
const VERSION := 4
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
var _text_now := ""
var _growing := false   # the text itself grows letter by letter (a string typewriter)
var _done_once := false # the current line was fully shown at least once
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

# Steps up from `node` to the nearest parent that also holds `other` (99 when farther than 4).
func _distance(node: Node, other: Node) -> int:
	var up := node.get_parent()
	for i in range(4):
		if up == null:
			break
		if up.is_ancestor_of(other):
			return i
		up = up.get_parent()
	return 99

const GENERIC := ["bubble", "balloon", "speech", "dialog", "text", "label", "panel", "container", "box",
	"ui", "hud", "canvas", "layer", "control", "root", "main", "world", "level", "scene", "stage", "node",
	"anchor", "pivot", "offset", "marker", "position", "head", "body", "sprite", "visual", "model", "mesh",
	"viewport", "character", "characters", "actor", "actors", "npc", "npcs", "entity", "entities", "player",
	"overlay", "popup", "window", "hint", "margin", "vbox", "hbox", "center", "background", "bg"]

# A node name that could be a character: not a layout word like "Bubble" or "VBoxContainer".
func _person(name: String) -> String:
	var clean := _stable(name).replace("_", " ").strip_edges()
	var lower := clean.to_lower().replace(" ", "")
	if clean.length() < 2 or clean.length() > 40:
		return ""
	for word in GENERIC:
		if lower == word or lower.begins_with(word) or lower.ends_with(word):
			return ""
	return clean

func _speaker(node: Node, labels: Array) -> String:
	var chosen := str(_config.get("speakerPath", ""))
	var best: Node = null
	var best_distance := 99
	for other in labels:
		if other == node:
			continue
		var match_it := false
		if not chosen.is_empty():
			match_it = _stable(str(other.get_path())) == _stable(chosen)
		else:
			var n := _stable(str(other.name)).to_lower()
			match_it = "speaker" in n or n in ["name", "namelabel", "charactername", "nametag", "name_tag", "who"]
		# With several text boxes on screen, the name inside this line's box wins.
		var d := _distance(node, other)
		if match_it and d < best_distance and not _text(other).is_empty():
			best = other
			best_distance = d
	if best != null:
		return _text(best).left(100)
	# No name label: a bubble that floats over a character usually sits inside that character's
	# node (/root/World/Cathy/Bubble/Text), so the nearest world node with a real name is the speaker.
	var up := node.get_parent()
	while up != null and up != get_tree().root:
		if up is Node2D or up is Node3D:
			var who := _person(str(up.name))
			if not who.is_empty():
				return who
		up = up.get_parent()
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
	if best != null and _sent and _done_once and not complete:
		_key = ""
	if complete:
		_done_once = true
	if next_key != _key:
		_growing = not _text_now.is_empty() and text.length() > _text_now.length() and text.begins_with(_text_now)
		_text_now = text
		_key = next_key
		_stable_since = Time.get_ticks_msec()
		_done_once = complete
		_sent = false
		_seq += 1
		# Cancel unsent old lines during rapid skipping. Queue stays bounded offline.
		_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint == "/godot/hook")
		_enqueue("/stop", {"engine": "godot", "seq": _seq})
	# Speak while the text is still appearing. A typewriter that reveals hidden letters already holds
	# the whole line, so a short pause is enough. Text that grows letter by letter is only final once
	# it stops changing, so it waits the longer settleMs.
	var settle := int(_config.get("settleMs", 650)) if _growing else 150
	if not next_key.is_empty() and not _sent and Time.get_ticks_msec() - _stable_since >= settle:
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
