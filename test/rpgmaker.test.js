'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tmpDir, write } = require('./helpers');
const scan = require('../main/steam/scan');
const install = require('../main/steam/install');

const HOOK = path.join(__dirname, '..', 'mod', 'rpgmaker', 'dubgame.js');
// Same shape as OMORI's www/index.html: CRLF line ends, main.js last.
const INDEX = '<!DOCTYPE html>\r\n<html>\r\n<body style="background-color: black">\r\n' +
  '    <script type="text/javascript" src="js/rpg_windows.js"></script>\r\n' +
  '    <script type="text/javascript" src="js/main.js"></script>\r\n</body>\r\n\r\n</html>';

function mvGame() {
  const dir = path.join(tmpDir(), 'OMORI');
  write(path.join(dir, 'www', 'js', 'rpg_core.js'));
  write(path.join(dir, 'www', 'index.html'), INDEX);
  return scan.scanFolder(dir);
}

test('rpgmaker-mv install: one tag after main.js, exact restore, a restored index.html reads as not installed', () => {
  const game = mvGame();
  assert.equal(game.engine, 'rpgmaker-mv');
  assert.equal(game.support, 'full');
  const www = path.join(game.installDir, 'www');
  const html = () => fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  assert.equal(install.isHookInstalled(game), false);

  install.installHook(game);
  install.installHook(game); // twice: still one tag
  assert.equal(install.isHookInstalled(game), true);
  assert.equal(html().split('js/dubgame.js').length, 2);
  assert.ok(html().indexOf('js/dubgame.js') > html().indexOf('js/main.js'));
  assert.deepEqual(fs.readFileSync(path.join(www, 'js', 'dubgame.js')), fs.readFileSync(HOOK));

  fs.writeFileSync(path.join(www, 'index.html'), INDEX); // Steam put its own file back
  assert.equal(install.isHookInstalled(game), false);
  install.installHook(game);

  install.uninstallHook(game);
  assert.equal(html(), INDEX);
  assert.ok(!fs.existsSync(path.join(www, 'js', 'dubgame.js')));
  assert.equal(install.isHookInstalled(game), false);
  install.uninstallHook(game); // removing twice is fine
});

// Runs the real hook against small stand-ins for RPG Maker MV + YEP_MessageCore.
function runHook() {
  const sent = [];
  const http = { request(opts, onResponse) {
    assert.equal(opts.host, '127.0.0.1');
    assert.equal(opts.port, 8000);
    return { on() {}, destroy() {}, end(body) {
      sent.push({ path: opts.path, ...JSON.parse(body.toString('utf8')) });
      onResponse({ resume() {}, on(event, fn) { if (event === 'end') fn(); } });
    } };
  } };
  function Window_NameBox() {}
  Window_NameBox.prototype.refresh = function () { return ''; };
  const nameBox = new Window_NameBox();
  function Window_Message() {}
  // What YEP_MessageCore does: backslash codes become \x1b, macros expand, \n<NAME> goes to the name box.
  Window_Message.prototype.convertEscapeCharacters = function (text) {
    return text.replace(/\\/g, '\x1b').replace(/\x1bkel/g, '\x1bN<KEL>').replace(/\x1bV\[1\]/gi,'3')
      .replace(/\x1bN<(.*?)>/gi, (m, name) => nameBox.refresh(name, 1));
  };
  const ctx = { raw: '' };
  Window_Message.prototype.startMessage = function () {
    this._textState = { index: 0, text: this.convertEscapeCharacters(ctx.raw) };
  };
  Window_Message.prototype.terminateMessage = function () {};
  vm.runInNewContext(fs.readFileSync(HOOK, 'utf8'), {
    Window_Message, Window_NameBox, Buffer, require: (name) => { assert.equal(name, 'http'); return http; },
    document: { readyState: 'complete' }, window: {},
    location: { pathname: '/C:/Program%20Files%20(x86)/Steam/steamapps/common/OMORI/www/index.html' },
  });
  const win = new Window_Message();
  return { sent, say(raw) { ctx.raw = raw; win.startMessage(); }, close() { win.terminateMessage(); } };
}

test('rpgmaker-mv hook: speaker from the name box, clean text, Narrator, /stop', () => {
  const g = runHook();
  g.say('\\n<SPACE EX-HUSBAND>\\c[4]Oh...\\! \\{hello\\} there,\\. \\sinv[1]friend\\sinv[0]!\\com[12]\n<br>Take \\v[1].\\^');
  g.say('\\kelHey!');
  g.say('\\c[2]You found a key.\\|');
  g.say('\\c[0]\\!');          // nothing to say: not sent
  g.close();
  g.close();                   // no second /stop
  const game = 'rpgmaker-mv:OMORI';
  assert.deepEqual(g.sent, [
    { path: '/line', speaker: 'SPACE EX-HUSBAND', text: 'Oh... hello there, friend! Take 3.', engine: 'rpgmaker-mv', game, seq: 1 },
    { path: '/line', speaker: 'KEL', text: 'Hey!', engine: 'rpgmaker-mv', game, seq: 2 },
    { path: '/line', speaker: 'Narrator', text: 'You found a key.', engine: 'rpgmaker-mv', game, seq: 3 },
    { path: '/stop', engine: 'rpgmaker-mv', game, seq: 3 },
  ]);
});

test('rpgmaker-mv hook: a game without the engine globals or Node is left alone', () => {
  vm.runInNewContext(fs.readFileSync(HOOK, 'utf8'), { document: { readyState: 'complete' }, window: {}, location: {} });
});
