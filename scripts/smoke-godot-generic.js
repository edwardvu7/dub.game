'use strict';
// Real engine test, no voice APIs, screen capture, or explicit dialogue bridge calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createServer } = require('../main/server');
const hook = require('../main/steam/godot-hook');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub generic ü '));
const source = path.join(dir, 'source');
const packed = path.join(dir, 'packed');
fs.mkdirSync(source); fs.mkdirSync(packed);
const events = [], reports = [], stops = [];
let activeGame;
const server = createServer({
  onLine: x => events.push(x),
  onStop: x => stops.push(x),
  onGodotHook: x => {
    reports.push(x);
    if (x.labels.some(l => l.text === 'Unusual node text.'))
      hook.configure(activeGame, { textPath: '/root/Test/Unusual', speakerPath: '' });
  },
});
const script = `extends Node
func wait(seconds: float) -> void:
    await get_tree().create_timer(seconds).timeout
func _ready() -> void:
    if get_node_or_null("/root/Original") == null:
        push_error("Original autoload lost")
        get_tree().quit(2)
        return
    var menu := Button.new()
    menu.name = "Menu"
    add_child(menu)
    var menu_label := Label.new()
    menu_label.text = "Do not speak this menu"
    menu.add_child(menu_label)
    var narration := Label.new()
    narration.name = "CutsceneNarration"
    narration.text = "The night was quiet."
    add_child(narration)
    await wait(1.7)
    narration.hide()
    await wait(0.3)
    narration.show()
    await wait(1.0)
    narration.queue_free()
    await wait(0.3)
    var dialog := Control.new()
    dialog.name = "Dialogue"
    add_child(dialog)
    var speaker := Label.new()
    speaker.name = "Speaker"
    speaker.text = "Mira"
    dialog.add_child(speaker)
    var line := RichTextLabel.new()
    line.name = "Body"
    line.bbcode_enabled = true
    line.text = "[b]Hello again.[/b]"
    line.visible_characters = 0
    dialog.add_child(line)
    for i in range(1, 13):
        line.visible_characters = i
        await wait(0.12)
    line.visible_characters = -1
    await wait(1.0)
    line.text = ""
    for ch in "Dynamic text.":
        line.text += ch
        await wait(0.1)
    await wait(1.0)
    dialog.queue_free()
    await wait(0.3)
    var unusual := Label.new()
    unusual.name = "Unusual"
    unusual.text = "Unusual node text."
    add_child(unusual)
    await wait(3.0)
    unusual.queue_free()
    await wait(0.3)
    get_tree().quit()
`;
const project = 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n';
const originalOverride = '[autoload]\nOriginal="*res://original.gd"\n[application]\nconfig/name="Preserved"\n';
function run(args, timeout = 25000, executable = process.env.GODOT_BIN || 'godot') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--headless', ...args]);
    let output = '';
    child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Engine timed out\n' + output)); }, timeout);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer);
      if (code || /SCRIPT ERROR|Parse Error|ERROR:/.test(output)) reject(new Error(output)); else resolve(output);
    });
  });
}
(async () => {
  fs.writeFileSync(path.join(source, 'project.godot'), project);
  fs.writeFileSync(path.join(source, 'fixture.gd'), script);
  fs.writeFileSync(path.join(source, 'original.gd'), 'extends Node\n');
  fs.writeFileSync(path.join(source, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://fixture.gd" id="1"]\n[node name="Test" type="Node"]\nscript = ExtResource("1")\n');
  // PCKPacker proves external autoload loading with res:// in a pack, not loose source.
  fs.writeFileSync(path.join(source, 'pack.gd'), `extends SceneTree
func _initialize() -> void:
    var pack := PCKPacker.new()
    pack.pck_start(${JSON.stringify(path.join(packed, 'Story.pck').replaceAll('\\', '/'))})
    for file in ["project.godot", "main.tscn", "fixture.gd", "original.gd"]:
        pack.add_file("res://" + file, "res://" + file)
    pack.flush()
    quit()
`);
  await run(['--path', source, '--script', 'res://pack.gd']);
  const engine = process.env.GODOT_BIN || execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['godot'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const packedBinary = path.join(packed, process.platform === 'win32' ? 'Story.exe' : 'Story.x86_64');
  fs.copyFileSync(engine, packedBinary);
  fs.chmodSync(packedBinary, 0o755);
  const packBefore = fs.readFileSync(path.join(packed, 'Story.pck'));
  await server.listen();
  try {
    for (const folder of [source, packed]) {
      events.length = 0; reports.length = 0; stops.length = 0;
      activeGame = { appid: 'test', engine: 'godot', installDir: folder };
      fs.writeFileSync(path.join(folder, 'override.cfg'), originalOverride);
      hook.install(activeGame);
      const args = folder === source ? ['--path', folder] : [];
      await run(args, 25000, folder === source ? (process.env.GODOT_BIN || 'godot') : packedBinary);
      assert.deepEqual(events.map(x => [x.speaker, x.text]), [
        ['Narrator', 'The night was quiet.'], ['Narrator', 'The night was quiet.'],
        ['Mira', 'Hello again.'], ['Mira', 'Dynamic text.'], ['Narrator', 'Unusual node text.'],
      ]);
      assert.ok(stops.length >= events.length, 'changed/hidden text cancels prior audio');
      assert.ok(stops.at(-1).seq > events.at(-1).seq, 'hiding final dialogue sends a newer stop');
      assert.ok(events.every(x => x.game === 'godot:' + path.basename(folder)));
      assert.ok(reports.length > 3 && reports.every(x => x.token === hook.config(activeGame).token));
      assert.ok(reports.some(x => x.labels.some(l => l.text === 'Do not speak this menu')));
      hook.uninstall(activeGame);
      assert.equal(fs.readFileSync(path.join(folder, 'override.cfg'), 'utf8'), originalOverride);
      console.log('PASS: ' + path.basename(folder) + ' narration, repeat, typewriter, BBCode, speaker, menu exclusion, live calibration, heartbeat, safe restore');
    }
    assert.ok(packBefore.equals(fs.readFileSync(path.join(packed, 'Story.pck'))));
  } finally { await server.close(); }
  activeGame = { appid: 'test', engine: 'godot', installDir: source };
  hook.install(activeGame);
  await run(['--path', source]); // Offline: process still exits normally, without script errors.
  console.log('PASS: offline game stays responsive; original resource pack unchanged.');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
