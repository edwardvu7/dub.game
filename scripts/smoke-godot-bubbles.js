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
		print("REVEALED ", int(Time.get_unix_time_from_system() * 1000.0))
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

// A classic dialogue box: the name plate is a plain "Label" above the text, found by where it sits
// on screen. The last line has no name plate and prints the name inside the line.
const PLATE = `extends Node
var lines := [["Mark", "Hey, did you finish the homework?"], ["Cathy", "Not yet. Let's do it together."], ["", "Cathy: Then again, maybe later."]]
func _ready() -> void:
	var layer := CanvasLayer.new(); layer.name = "UI"; add_child(layer)
	var hud := Label.new(); hud.name = "Clock"; hud.text = "7:45 AM"; layer.add_child(hud)
	var box := Control.new(); box.name = "DialogueBox"; box.position = Vector2(100, 500); box.size = Vector2(800, 200); layer.add_child(box)
	var plate := Label.new(); plate.position = Vector2(20, 10); plate.size = Vector2(200, 30); box.add_child(plate)
	var text := RichTextLabel.new(); text.name = "Body"; text.position = Vector2(20, 50); text.size = Vector2(760, 140); box.add_child(text)
	for l in lines:
		plate.text = l[0]
		text.text = l[1]
		text.visible_characters = 0
		for i in range(l[1].length() + 1):
			text.visible_characters = i
			await get_tree().create_timer(0.02).timeout
		await get_tree().create_timer(1.2).timeout
	get_tree().quit()
`;

// Until Then (from its inspection report): one bubble per character under $DialogueHandler, the first
// named "SpeechBubble", later ones unnamed ("@Node3D@948"). The character is the script variable `alias`.
const ALIAS = `extends Node
var lines := [["RyanSoriano", "You like her too, don't you?"], ["MarkBorja", "Who? Louise?"], ["Cathy", "He means Louise."]]
func _ready() -> void:
	var code := GDScript.new(); code.source_code = 'extends Node3D\\nvar alias := ""\\n'; code.reload()
	var services := Node.new(); services.name = "Services"; add_child(services)
	var handler := Node.new(); handler.name = "$DialogueHandler"; services.add_child(handler)
	var old: Control = null
	for l in lines:
		var bubble := Node3D.new(); bubble.set_script(code); bubble.set("alias", l[0])
		if old == null: bubble.name = "SpeechBubble"
		handler.add_child(bubble)
		var layer := CanvasLayer.new(); layer.name = "CanvasLayer"; bubble.add_child(layer)
		var control := Control.new(); control.name = "Control"; layer.add_child(control)
		var panel := PanelContainer.new(); panel.name = "Bubble"; control.add_child(panel)
		var text := RichTextLabel.new(); text.name = "Label"; text.text = l[1]; text.visible_characters = 0
		text.custom_minimum_size = Vector2(200, 40); panel.add_child(text)
		if old != null: old.visible = false
		old = control
		for i in range(l[1].length() + 1):
			text.visible_characters = i
			await get_tree().create_timer(0.02).timeout
		await get_tree().create_timer(1.2).timeout
	get_tree().quit()
`;

// Until Then, whole scene: the skit's cast stands under Skits/<Skit>/Characters before anyone speaks
// (Louise never does), then the aliased bubbles appear. The hook must announce the cast first.
const SKIT = ALIAS.replace('["Cathy", "He means Louise."]', '["RyanSoriano", "Her."]').replace('func _ready() -> void:', `func _ready() -> void:
	var skits := Node3D.new(); skits.name = "Skits"; add_child(skits)
	var skit := Node3D.new(); skit.name = "LouiseReport"; skits.add_child(skit)
	var cast := Node3D.new(); cast.name = "Characters"; skit.add_child(cast)
	for who in ["RyanSoriano", "MarkBorja", "Louise"]:
		var c := Node3D.new(); c.name = who; cast.add_child(c)
		var sprite := Node3D.new(); sprite.name = "Sprite"; c.add_child(sprite)
	await get_tree().create_timer(0.5).timeout`).replace('handler.add_child(bubble)',
  'handler.add_child(bubble); print("SHOWN ", int(Time.get_unix_time_from_system() * 1000.0))');

// Draws its text without any Label, so the report lists script variables holding text instead.
const NOLABEL = `extends Node
var caption := "A line drawn by hand on a canvas."
func _ready() -> void:
	await get_tree().create_timer(10.6).timeout
	get_tree().quit()
`;

// An autoload of the game's own, for the report: a long value, a typed empty variable, a resource, a node.
const STATE = `extends Node
signal said(who, line)
var note := "0123456789".repeat(10)
var portrait: Texture2D
var style := Gradient.new()
@onready var me: Node = self
`;

let report; // the inspection report of the last game played
let announced; // [{names, at}] of the last game played: every /characters the hook sent
let firstLineAt; // when the app heard the last game's first line, and when that bubble was added
let firstShownAt;

async function play({ bubble, name, pick, source }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-godot-generic-'));
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nState="*res://state.gd"\n');
  fs.writeFileSync(path.join(dir, 'state.gd'), STATE);
  fs.writeFileSync(path.join(dir, 'main.gd'), source || GAME.replace('%s', bubble).replace('%s', name));
  fs.writeFileSync(path.join(dir, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
  const game = { appid: 'local:test', installDir: dir, engine: 'godot' };
  hook.install(game, { modDir: path.join(__dirname, '..', 'mod') });
  if (pick) hook.configure(game, pick);
  const lines = [];
  const heardAt = [];
  announced = [];
  const server = createServer({ onLine: (l) => { lines.push([l.speaker, l.text]); heardAt.push(Date.now()); },
    onCharacters: (p) => announced.push({ names: p.characters.map((c) => c.speaker), at: Date.now() }) });
  await server.listen(); // fails if dub.game is running: never talk to a live session
  try {
    const out = await new Promise((resolve) => execFile(process.env.GODOT_BIN || 'godot', ['--headless', '--path', dir],
      { timeout: 40000 }, (_e, stdout, stderr) => resolve(stdout + stderr)));
    assert.ok(!/SCRIPT ERROR|Parse Error|ERROR:|Invalid (call|get index)/.test(out), out);
    firstLineAt = heardAt[0];
    firstShownAt = Number((out.match(/SHOWN (\d+)/) || [])[1]);
    const revealed = [...out.matchAll(/REVEALED (\d+)/g)].map((m) => Number(m[1]));
    // Speaking starts while the typewriter is still revealing the line, not after it.
    if (revealed.length) assert.ok(heardAt[0] < revealed[0], `line 1 sent ${heardAt[0] - revealed[0]} ms after it finished appearing`);
  } finally { await server.close(); }
  const file = path.join(dir, hook.INSPECT);
  assert.ok(fs.statSync(file).size <= 65536, 'inspection report stays under 64 KB');
  report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (source !== NOLABEL) {
    const main = report.snapshots[0].chain.find((n) => n.script === 'res://main.gd');
    assert.ok(main && main.vars.some((v) => v.name === 'lines' && v.value === 'size 3'), 'inspection report: ancestor chain with script variables');
  }
  assert.deepEqual(report.autoloads, [{ name: 'State', class: 'Node', script: 'res://state.gd', groups: [], signals: ['said(who, line)'], vars: [
    { name: 'note', type: 'String', value: '0123456789'.repeat(6) }, { name: 'portrait', type: 'Texture2D', value: '<null>' },
    { name: 'style', type: 'Gradient', value: '' }, { name: 'me', type: 'Node', value: '/root/State' }] }],
  'inspection report: autoloads with signals and short values');
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
  assert.deepEqual(await play({ source: PLATE }), [['Mark', 'Hey, did you finish the homework?'],
    ['Cathy', "Not yet. Let's do it together."], ['Cathy', 'Then again, maybe later.']],
  'dialogue box: name plate found by position, and "Name: line" split');
  assert.deepEqual(await play({ source: WORLD }), [['Mark', 'Hey, did you finish the homework?'],
    ['Cathy', "Not yet. Let's do it together."], ['Mark', 'Deal.']], 'bubbles over characters: the character is the speaker');
  assert.deepEqual(report.snapshots.map((s) => s.label.split('/')[4]), ['Mark', 'Cathy'],
    'inspection report: Mark, Cathy, Mark is two places, so two snapshots');
  assert.deepEqual(await play({ source: ALIAS }), [['RyanSoriano', "You like her too, don't you?"],
    ['MarkBorja', 'Who? Louise?'], ['Cathy', 'He means Louise.']], 'Until Then bubbles: the script variable `alias` is the speaker');
  assert.equal(announced.length, 0, 'no node named Characters: nobody is announced');
  const spoke = await play({ source: SKIT });
  assert.deepEqual(announced.map((a) => a.names), [['RyanSoriano', 'MarkBorja', 'Louise']], 'skit cast: announced once, in one request');
  assert.ok(announced[0].at < firstLineAt, 'skit cast: announced before the first line');
  for (const [who] of spoke) assert.ok(announced[0].names.includes(who), `skit cast: the line's speaker "${who}" is a name that was announced`);
  console.log(`skit cast announced ${firstLineAt - announced[0].at} ms before the first line; that line reached the app ${firstLineAt - firstShownAt} ms after its bubble was added`);
  assert.deepEqual(await play({ source: NOLABEL }), [], 'no labels: nothing is spoken');
  assert.deepEqual(report.snapshots[0].strings, [{ node: '/root/State', var: 'note', text: '0123456789'.repeat(6) },
    { node: '/root/Main', var: 'caption', text: 'A line drawn by hand on a canvas.' }],
    'inspection report: text held in script variables when there is no label');
  console.log('PASS: generic Godot hook: automatic, picked-once, and speakers from name plates, "Name: line" text, and the character a bubble floats over.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
