'use strict';
// Runs the generic Godot hook (mod/godot/generic.gd) inside a tiny story game that, like real
// games, builds a fresh speech bubble per line with engine-numbered node names.
// Needs Godot 4: GODOT_BIN=/path/to/godot npm run smoke:godot-generic
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createServer } = require('../main/server');
const hook = require('../main/steam/godot-hook');

const GAME = `extends Node
var lines := [["Mark", "Hey, did you finish the homework?"], ["Cathy", "Not yet. Let's do it together."], ["", "The bell rang."]]
func _ready() -> void:
	var layer := CanvasLayer.new(); layer.name = "UI"; add_child(layer)
	var hud := Label.new(); hud.name = "Clock"; hud.text = "7:45 AM"; layer.add_child(hud)
	for l in lines:
		var bubble := PanelContainer.new(); bubble.name = "%s"
		var who := Label.new(); who.name = "%s"; who.text = l[0]
		var text := RichTextLabel.new(); text.name = "Text"; text.bbcode_enabled = true
		text.text = "[b]" + l[1] + "[/b]"; text.visible_characters = 0
		var box := VBoxContainer.new(); box.add_child(who); box.add_child(text); bubble.add_child(box)
		layer.add_child(bubble)
		for i in range(l[1].length() + 1):
			text.visible_characters = i
			await get_tree().create_timer(0.02).timeout
		await get_tree().create_timer(1.2).timeout
		bubble.queue_free()
		await get_tree().create_timer(0.3).timeout
	get_tree().quit()
`;

// Bubbles float over characters in the world and have no name label. The previous bubble is still
// fading out when the next one appears, so two are on screen at once.
const WORLD = `extends Node
var lines := [["Mark", "Hey, did you finish the homework?"], ["Cathy", "Not yet. Let's do it together."], ["Mark", "Deal."]]
func _ready() -> void:
	var world := Node2D.new(); world.name = "World"; add_child(world)
	for who in ["Mark", "Cathy"]:
		var c := Node2D.new(); c.name = who; world.add_child(c)
	var old: Node = null
	for l in lines:
		var bubble := Node2D.new(); bubble.name = "SpeechBubble"
		var panel := PanelContainer.new(); bubble.add_child(panel)
		var text := RichTextLabel.new(); text.name = "Text"; text.text = l[1]; text.visible_characters = 0
		text.custom_minimum_size = Vector2(200, 40); panel.add_child(text)
		world.get_node(l[0]).add_child(bubble)
		for i in range(l[1].length() + 1):
			text.visible_characters = i
			await get_tree().create_timer(0.02).timeout
		if old != null: old.queue_free()
		old = bubble
		await get_tree().create_timer(1.2).timeout
	get_tree().quit()
`;

async function play({ bubble, name, pick, source }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-godot-generic-'));
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n');
  fs.writeFileSync(path.join(dir, 'main.gd'), source || GAME.replace('%s', bubble).replace('%s', name));
  fs.writeFileSync(path.join(dir, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
  const game = { appid: 'local:test', installDir: dir, engine: 'godot' };
  hook.install(game, { modDir: path.join(__dirname, '..', 'mod') });
  if (pick) hook.configure(game, pick);
  const lines = [];
  const server = createServer({ onLine: (l) => lines.push([l.speaker, l.text]) });
  await server.listen(); // fails if dub.game is running: never talk to a live session
  try {
    const out = await new Promise((resolve) => execFile(process.env.GODOT_BIN || 'godot', ['--headless', '--path', dir],
      { timeout: 40000 }, (_e, stdout, stderr) => resolve(stdout + stderr)));
    assert.ok(!/SCRIPT ERROR|Parse Error/.test(out), out);
  } finally { await server.close(); }
  return lines;
}

(async () => {
  const want = [['Mark', 'Hey, did you finish the homework?'], ['Cathy', "Not yet. Let's do it together."], ['Narrator', 'The bell rang.']];
  assert.deepEqual(await play({ bubble: 'Bubble', name: 'NameTag' }), want, 'automatic: speech bubbles are found');
  // Names the hook cannot guess: the player picks the first bubble's nodes once, and every later
  // bubble (numbered differently by the engine) must still be voiced.
  assert.deepEqual(await play({ bubble: 'Thing', name: 'Who', pick: {
    textPath: '/root/Main/UI/Thing/@VBoxContainer@5/Text', speakerPath: '/root/Main/UI/Thing/@VBoxContainer@5/Who' } }), want,
  'picked once: later copies of the node are voiced too');
  assert.deepEqual(await play({ source: WORLD }), [['Mark', 'Hey, did you finish the homework?'],
    ['Cathy', "Not yet. Let's do it together."], ['Mark', 'Deal.']], 'bubbles over characters: the character is the speaker');
  console.log('PASS: generic Godot hook: automatic, picked-once, and speakers from the character a bubble floats over.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
