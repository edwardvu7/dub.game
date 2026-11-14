'use strict';
// Runs the actual Godot adapter against the production HTTP server, without paid APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('../main/server');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-godot-'));
const events = [];
const server = createServer({
  onLine: x => events.push(['line', x]),
  onCharacters: x => events.push(['characters', x]),
  onStop: x => events.push(['stop', x]),
});
const script = `extends SceneTree
var delivered := 0
func _initialize() -> void:
    run.call_deferred()
func run() -> void:
    var bridge = root.get_node("DubGame")
    bridge.delivery_finished.connect(func(_endpoint, _ok): delivered += 1)
    bridge.register_characters([{"speaker": "Mira", "samples": ["Hello!"]}])
    await create_timer(0.2).timeout
    bridge.say("Mira", "Hello!", "/root/Test")
    await create_timer(0.2).timeout
    bridge.say("Mira", "Hello!", "/root/Test")
    await create_timer(0.2).timeout
    bridge.say("", "A quiet night.")
    await create_timer(0.2).timeout
    # The first stop may be in flight; unsent intermediate lines must be dropped.
    for i in range(100):
        bridge.say("Mira", "Skipped " + str(i))
    bridge.say("Rowan", "Latest line")
    await create_timer(0.2).timeout
    bridge.stop()
    await create_timer(0.2).timeout
    if bridge._pending.size() != 0 or bridge._busy or delivered == 0:
        push_error("Adapter did not drain requests")
        quit(1)
    else:
        quit(0)
`;
async function runGodot() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GODOT_BIN || 'godot', ['--headless', '--path', dir, '--script', 'res://smoke.gd']);
    let output = '';
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', x => output += x);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Godot timed out\n' + output)); }, 15000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || /SCRIPT ERROR|Parse Error|ERROR:/.test(output)) reject(new Error(output));
      else resolve();
    });
  });
}
(async () => {
  fs.copyFileSync(path.join(__dirname, '../mod/godot/bridge.gd'), path.join(dir, 'dubgame.gd'));
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n[autoload]\nDubGame="*res://dubgame.gd"\n');
  fs.writeFileSync(path.join(dir, 'smoke.gd'), script);
  await server.listen(); // Fails if dub.game is running: never talk to a user's live session.
  try {
    await runGodot();
    assert.equal(events[0][0], 'characters');
    assert.equal(events[0][1].characters[0].speaker, 'Mira');
    const lines = events.filter(x => x[0] === 'line').map(x => x[1]);
    assert.deepEqual(lines.map(x => [x.speaker, x.text]), [
      ['Mira', 'Hello!'], ['Mira', 'Hello!'], ['Narrator', 'A quiet night.'], ['Rowan', 'Latest line'],
    ]);
    assert.ok(lines.every(x => x.engine === 'godot'));
    assert.equal(lines[0].source, '/root/Test');
    assert.ok(lines.every((x, i) => i === 0 || x.seq > lines[i - 1].seq));
    assert.equal(events.at(-1)[0], 'stop');
    assert.equal(events.at(-1)[1].seq, lines.at(-1).seq);
  } finally { await server.close(); }
  await runGodot(); // Offline transport must fail quietly and leave the game responsive.
  console.log('PASS: Godot HTTP integration, cast, repeated lines, narration, rapid skip, stop, offline.');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
