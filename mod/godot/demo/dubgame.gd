# Godot 4 source integration. Add this script as an autoload named DubGame.
extends Node

signal delivery_finished(endpoint: String, success: bool)

const BASE_URL := "http://127.0.0.1:8000"
var _request: HTTPRequest
var _pending: Array[Dictionary] = []
var _busy := false
var _seq := 0
var _active_endpoint := ""

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_request = HTTPRequest.new()
	_request.timeout = 1.0
	add_child(_request)
	_request.request_completed.connect(_completed)
	_pump()

# Submit complete dialogue, once, before starting any typewriter animation.
# Repeated identical lines are intentional and are not deduplicated.
func say(speaker: String, text: String, source: String = "") -> void:
	if text.strip_edges().is_empty():
		stop()
		return
	_seq += 1
	# Drop unsent dialogue during rapid skipping; keep character registration.
	_drop_dialogue()
	_enqueue("/stop", {"engine": "godot", "seq": _seq})
	_enqueue("/line", {"speaker": speaker.strip_edges() if not speaker.strip_edges().is_empty() else "Narrator",
		"text": text.strip_edges(), "engine": "godot", "source": source, "seq": _seq})

func stop() -> void:
	_drop_dialogue()
	_enqueue("/stop", {"engine": "godot", "seq": _seq})

func register_characters(characters: Array) -> void:
	# Only the newest unsent cast is needed. Bounds the queue even when offline.
	_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint != "/characters")
	_enqueue("/characters", {"engine": "godot", "characters": characters})

func _drop_dialogue() -> void:
	_pending = _pending.filter(func(item: Dictionary) -> bool: return item.endpoint == "/characters")

func _enqueue(endpoint: String, payload: Dictionary) -> void:
	_pending.append({"endpoint": endpoint, "body": JSON.stringify(payload)})
	_pump()

func _pump() -> void:
	if _busy or _pending.is_empty() or not is_instance_valid(_request):
		return
	_busy = true
	var item: Dictionary = _pending.pop_front()
	_active_endpoint = item.endpoint
	var error := _request.request(BASE_URL + item.endpoint,
		["Content-Type: application/json"], HTTPClient.METHOD_POST, item.body)
	if error != OK:
		_finish(false)

func _completed(result: int, code: int, _headers: PackedStringArray, _body: PackedByteArray) -> void:
	_finish(result == HTTPRequest.RESULT_SUCCESS and code == 204)

func _finish(success: bool) -> void:
	var endpoint := _active_endpoint
	_active_endpoint = ""
	_busy = false
	delivery_finished.emit(endpoint, success)
	_pump.call_deferred()
