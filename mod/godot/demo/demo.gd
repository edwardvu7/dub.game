extends Control

const LINES := [
	["Narrator", "Rain taps against the observatory windows."],
	["Mira", "You came back! I knew you would find the signal."],
	["Rowan", "Keep your voice down. We are not alone up here."],
	["Mira", "Then let them listen. Tonight, we reach the stars."],
]
var _index := -1
var _speaker: Label
var _dialogue: Label
var _status: Label

func _ready() -> void:
	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	box.offset_left = 64
	box.offset_top = 80
	box.offset_right = -64
	box.offset_bottom = -60
	box.add_theme_constant_override("separation", 24)
	add_child(box)
	var title := Label.new()
	title.text = "dub.game / GODOT DEMO"
	title.add_theme_font_size_override("font_size", 28)
	box.add_child(title)
	_speaker = Label.new()
	_speaker.add_theme_font_size_override("font_size", 24)
	box.add_child(_speaker)
	_dialogue = Label.new()
	_dialogue.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dialogue.custom_minimum_size.y = 100
	_dialogue.add_theme_font_size_override("font_size", 22)
	box.add_child(_dialogue)
	var next := Button.new()
	next.text = "Next line / Restart"
	next.pressed.connect(_next)
	box.add_child(next)
	var stop_button := Button.new()
	stop_button.text = "Stop voice"
	stop_button.pressed.connect(DubGame.stop)
	box.add_child(stop_button)
	_status = Label.new()
	_status.text = "Start dub.game to hear voices. Click Next to begin."
	box.add_child(_status)
	DubGame.delivery_finished.connect(func(_endpoint: String, success: bool) -> void:
		_status.text = "Connected to dub.game" if success else "dub.game offline. Dialogue still works.")
	var cast: Array = []
	for character in ["Mira", "Rowan"]:
		var samples: Array = []
		for line in LINES:
			if line[0] == character:
				samples.append(line[1])
		cast.append({"speaker": character, "samples": samples})
	DubGame.register_characters(cast)
	_speaker.text = "The Observatory"
	_dialogue.text = "Two explorers. One mysterious signal."
	get_tree().auto_accept_quit = false

func _next() -> void:
	_index = (_index + 1) % LINES.size()
	_speaker.text = LINES[_index][0]
	_dialogue.text = LINES[_index][1]
	DubGame.say(_speaker.text, _dialogue.text, str(get_path()))

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		DubGame.stop()
		await get_tree().create_timer(0.15).timeout
		get_tree().quit()
