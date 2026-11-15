# Generic Godot 4 adapter. Reads live scene nodes, never pixels or screenshots.
# UNVERIFIED: commercial games/custom export templates require individual compatibility testing.
extends Node

const BASE_URL := "http://127.0.0.1:8000"
const VERSION := 8
const MAX_LABELS := 512
const TYPES := {TYPE_NIL: "null", TYPE_BOOL: "bool", TYPE_INT: "int", TYPE_FLOAT: "float", TYPE_STRING: "String",
	TYPE_STRING_NAME: "StringName", TYPE_NODE_PATH: "NodePath", TYPE_OBJECT: "Object", TYPE_CALLABLE: "Callable",
	TYPE_SIGNAL: "Signal", TYPE_DICTIONARY: "Dictionary", TYPE_ARRAY: "Array", TYPE_VECTOR2: "Vector2", TYPE_COLOR: "Color"}
var _inspect_path := ""
var _inspect_seen := {}      # stable label paths already snapshotted in this run
var _inspect_left := 5       # label snapshots still allowed in this run
var _inspect_idle := true    # no label selected yet, and no no-label snapshot written
var _started := 0
var _report: Dictionary = {}
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
var _inline_name := RegEx.create_from_string("^([^\\s:][^:\\n]{0,23}):\\s+(.+)$") # "Cathy: Not yet."
var _seq := 0
var _selected := ""
var _cast_seen := {}      # character names already announced in this run (at most 60)
var _cast_new: Array = [] # names waiting for the next /characters

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_seq = int(Time.get_unix_time_from_system() * 1000.0)
	_started = Time.get_ticks_msec()
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
		_inspect_path = file.get_basename() + ".inspect.json"
		return true
	return false

func _scan(node: Node) -> void:
	_added(node)
	for child in node.get_children():
		_scan(child)

func _added(node: Node) -> void:
	# A scene keeps its cast under a node named "Characters" (Until Then:
	# /root/Root/Skits/<Skit>/Characters/<Name>). Announcing them while the scene loads lets the app
	# pick their voices before anyone speaks. Only "Characters" is seen in a real game.
	var parent := node.get_parent()
	if parent != null and str(parent.name).to_lower() == "characters" and _cast_seen.size() < 60:
		var who := _person(str(node.name))
		if not who.is_empty() and not _cast_seen.has(who):
			_cast_seen[who] = true
			_cast_new.append({"speaker": who})
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
	# "@Node3D@948" is a name the engine made up for an unnamed node, never a character.
	if clean.length() < 2 or clean.length() > 40 or clean.begins_with("@"):
		return ""
	for word in GENERIC:
		if lower == word or lower.begins_with(word) or lower.ends_with(word):
			return ""
	return clean

# Text that reads like a name: short, one line, no sentence ending, no clock or score.
func _looks_like_name(t: String) -> bool:
	if t.length() < 2 or t.length() > 32 or "\n" in t or ":" in t:
		return false
	if t.split(" ", false).size() > 4 or t.right(1) in [".", "!", "?", ",", ";", "…"]:
		return false
	var first := t.unicode_at(0)
	return (first >= 65 and first <= 90) or (first >= 97 and first <= 122) or first > 127

func _name_plate(node: Node, labels: Array) -> String:
	if not node is Control:
		return ""
	var line: Rect2 = node.get_global_rect()
	var text := _text(node)
	var best := ""
	var best_gap := 1e9
	for other in labels:
		if other == node or not other is Control or other.get_viewport() != node.get_viewport():
			continue
		var t := _text(other)
		if t == text or not _looks_like_name(t):
			continue
		var r: Rect2 = other.get_global_rect()
		var above := line.position.y - r.end.y          # gap between the plate's bottom and the line's top
		var beside := line.position.x - r.end.x         # gap between the plate's right and the line's left
		var gap := 1e9
		if above >= -8 and above <= 80 and r.position.x <= line.position.x + line.size.x * 0.5 and r.end.x >= line.position.x - 80:
			gap = maxf(above, 0.0) + absf(r.position.x - line.position.x) * 0.1
		elif beside >= -8 and beside <= 120 and absf(r.position.y - line.position.y) <= 30:
			gap = maxf(beside, 0.0)
		if gap < best_gap:
			best_gap = gap
			best = t
	return best.left(100)

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
	# The bubble's own script often holds its character in a variable (Until Then: SpeechBubble.gd
	# `alias = "MarkBorja"`). Only `alias` is seen in a real game; the other names are guesses.
	var up := node.get_parent()
	while up != null and up != get_tree().root:
		for key in ["alias", "speaker", "speaker_name", "character_name"]:
			var value = up.get(key)
			if (value is String or value is StringName) and _looks_like_name(str(value)):
				return str(value).left(100)
		up = up.get_parent()
	# A name plate: a short name-like label just above or to the left of the line on screen,
	# whatever the game called the node.
	var plate := _name_plate(node, labels)
	if not plate.is_empty():
		return plate
	# No name label: a bubble that floats over a character usually sits inside that character's
	# node (/root/World/Cathy/Bubble/Text), so the nearest world node with a real name is the speaker.
	up = node.get_parent()
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
	# One request per scene load, 12 names at most (one Gemini call in the app).
	if not _cast_new.is_empty() and not _pending.any(func(item: Dictionary) -> bool: return item.endpoint == "/characters"):
		_enqueue("/characters", {"engine": "godot", "characters": _cast_new.slice(0, 12)})
		_cast_new = _cast_new.slice(12)
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
	if best != null:
		_inspect_idle = false
		if _inspect_left > 0 and not _inspect_seen.has(_stable(_selected)):
			_inspect_seen[_stable(_selected)] = true
			_inspect_left -= 1
			_inspect(best)
	elif _inspect_idle and Time.get_ticks_msec() - _started >= 10000:
		_inspect_idle = false
		_inspect(null)
	var next_key := ""
	var text := ""
	var speaker := "Narrator"
	var complete := false
	if best != null:
		text = _text(best)
		speaker = _speaker(best, visible)
		if speaker.is_empty():
			speaker = "Narrator"
		# Some games print the name inside the line: "Cathy: Not yet." Speak only the line.
		if speaker == "Narrator":
			var inline := _inline_name.search(text)
			if inline != null and _looks_like_name(inline.get_string(1)):
				speaker = inline.get_string(1)
				text = inline.get_string(2)
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
		_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint == "/godot/hook" or item.endpoint == "/characters")
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

# --- Inspection report: what the game's own nodes look like, written to a local file, never sent.
# Reads properties only; never calls the game's methods. Checked in Godot 4.1.4 by smoke:godot-bubbles.
# UNVERIFIED: a real game, writing inside Program Files, GDExtension classes in ClassDB, the 64 KB trim.

func _short(value) -> String:
	if typeof(value) == TYPE_OBJECT:
		if not is_instance_valid(value):
			return "<freed>"
		if value is Node:
			return str(value.get_path()).left(60) if value.is_inside_tree() else "<" + str(value.name).left(50) + ">"
		if value is Resource:
			var out := str(value.resource_path)
			for key in ["name", "display_name", "character_name"]:
				var extra = value.get(key)
				if typeof(extra) != TYPE_NIL:
					out += " " + str(key) + "=" + str(extra).left(30)
			return out.left(60)
		return "<object>"
	if typeof(value) == TYPE_DICTIONARY or typeof(value) >= TYPE_ARRAY:
		return "size " + str(value.size())
	return str(value).left(60)

func _node_info(node: Node) -> Dictionary:
	var groups: Array = []
	for group in node.get_groups():
		if not str(group).begins_with("_"): # "_..." groups are the engine's own
			groups.append(str(group))
	var fields: Array = []
	var sigs: Array = []
	var info := {"name": str(node.name), "class": node.get_class(), "script": "", "groups": groups, "vars": fields, "signals": sigs}
	var scr = node.get_script()
	if not scr is Script:
		return info
	info["script"] = str(scr.resource_path)
	for p in scr.get_script_property_list():
		if fields.size() >= 40:
			break
		if (int(p.usage) & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP)) != 0:
			continue
		var value = node.get(p.name)
		var kind := str(TYPES.get(typeof(value), typeof(value)))
		if typeof(value) == TYPE_OBJECT and is_instance_valid(value):
			kind = str(value.get_class())
		elif typeof(value) == TYPE_NIL and not str(p.get("class_name", "")).is_empty():
			kind = str(p.get("class_name", ""))
		fields.append({"name": str(p.name), "type": kind, "value": _short(value)})
	for s in scr.get_script_signal_list():
		if sigs.size() >= 40:
			break
		var args := PackedStringArray()
		for a in s.args:
			args.append(str(a.name))
		sigs.append(str(s.name) + "(" + ", ".join(args) + ")")
	return info

func _autoloads() -> Array:
	var out: Array = []
	for child in get_tree().root.get_children():
		if child != self and child != get_tree().current_scene and out.size() < 40:
			out.append(child)
	return out

func _string_vars(node: Node, out: Array) -> bool:
	var scr = node.get_script()
	if not scr is Script:
		return false
	for p in scr.get_script_property_list():
		var value = node.get(p.name)
		if value is String and value.length() > 10 and out.size() < 200:
			out.append({"node": str(node.get_path()), "var": str(p.name), "text": value.left(60)})
	return true

# For games that draw text without Label nodes: where long strings sit in script variables.
func _strings() -> Array:
	var out: Array = []
	for auto in _autoloads():
		_string_vars(auto, out)
	var stack: Array = []
	if get_tree().current_scene != null:
		stack.append(get_tree().current_scene)
	var scripted := 0
	var seen := 0
	while not stack.is_empty() and scripted < 300 and seen < 20000:
		var node = stack.pop_back()
		seen += 1
		if not is_instance_valid(node):
			continue
		stack.append_array(node.get_children())
		if _string_vars(node, out):
			scripted += 1
	return out

func _inspect(label: Node) -> void:
	if _inspect_path.is_empty():
		return
	if _report.is_empty():
		var classes: Array = []
		for c in ClassDB.get_class_list():
			var lower: String = str(c).to_lower()
			if "ink" in lower or "dialog" in lower or "story" in lower:
				var methods: Array = []
				for m in ClassDB.class_get_method_list(c, true):
					if methods.size() < 60:
						methods.append(str(m.name))
				classes.append({"class": str(c), "methods": methods})
		var loads: Array = []
		for node in _autoloads():
			loads.append(_node_info(node))
		_report = {"hook": VERSION, "godot": str(Engine.get_version_info().get("string", "")),
			"game": str(_config.get("game", "")), "autoloads": loads, "classes": classes, "snapshots": []}
	var snap := {"time": Time.get_datetime_string_from_system(), "label": "", "text": ""}
	if label != null:
		snap["label"] = str(label.get_path())
		snap["text"] = _text(label).left(60)
		var chain: Array = []
		var up: Node = label
		while up != null and chain.size() < 16:
			chain.append(_node_info(up))
			up = up.get_parent()
		snap["chain"] = chain
	else:
		snap["strings"] = _strings()
	var snapshots: Array = _report["snapshots"]
	var autoloads: Array = _report["autoloads"]
	var classes_kept: Array = _report["classes"]
	snapshots.append(snap)
	var text := JSON.stringify(_report)
	# 64 KB cap: oldest snapshots go first, then autoloads and classes from the end.
	while text.to_utf8_buffer().size() > 65536:
		if snapshots.size() > 1:
			snapshots.pop_front()
		elif not autoloads.is_empty():
			autoloads.pop_back()
		elif not classes_kept.is_empty():
			classes_kept.pop_back()
		else:
			return
		text = JSON.stringify(_report)
	var out := FileAccess.open(_inspect_path, FileAccess.WRITE)
	if out != null:
		out.store_string(text)

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
