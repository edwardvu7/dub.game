// dub.game hook for RPG Maker MV games running in NW.js (written against OMORI).
//
// dub.game copies this file to <game>/www/js/dubgame.js and adds one <script> tag for it at the
// end of www/index.html. It sends each message-window line to the dub.game app on localhost and
// nothing else. Choices, battle log and menus are other windows and are never sent.
//
// Contract (see CLAUDE.md):
//   POST /line  {speaker, text, engine: "rpgmaker-mv", game, seq}
//   POST /stop  {engine: "rpgmaker-mv", game, seq}      (the message window closed the line)
//   game is "rpgmaker-mv:<game folder name>".
//
// Speaker: the YEP_MessageCore name box (\n<NAME> and its \n1<..>, \nc<..>, \nr<..> variants, or a
// macro that expands to one, like OMORI's \aub). No name box means "Narrator".
//
// UNVERIFIED: not yet run inside OMORI. Its plugins are encrypted, so this hooks the plain engine
// layer (Window_Message) and YEP_MessageCore's documented Window_NameBox.refresh(text, position).
// DUBGAME_HOOK_VERSION 1
(function () {
  'use strict';
  var ENGINE = 'rpgmaker-mv';

  function gameId() {
    try {
      // /C:/Games/OMORI/www/index.html -> OMORI
      var parts = decodeURIComponent(location.pathname).split('/').filter(Boolean);
      parts.pop();
      if (parts[parts.length - 1] === 'www') parts.pop();
      if (parts.length) return ENGINE + ':' + parts[parts.length - 1];
      // NW.js may serve the page as chrome-extension://<id>/www/index.html, with no folder in
      // the URL: the game's exe sits in the game folder.
      var p = require('path');
      return ENGINE + ':' + p.basename(p.dirname(process.execPath));
    } catch (e) { /* fall through */ }
    return ENGINE + ':unknown';
  }

  // Text as Window_Message holds it: escape codes already start with \x1b, variables and names
  // are already filled in. Codes are read the way the engine reads them (a symbol, or letters
  // with an optional [..] or <..> argument).
  function clean(text) {
    return String(text == null ? '' : text)
      .replace(/\x1b(?:[A-Za-z]+(?:\[[^\]]*\]|<[^>]*>)?|[^A-Za-z])/g, '')
      .replace(/<(?:br|line break|\/?wordwrap)>/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // One request at a time, in order: Node's http sends no Origin header, which the app requires.
  var queue = [];
  var busy = false;
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift();
    var done = false;
    var next = function () { if (done) return; done = true; busy = false; pump(); };
    try {
      var body = Buffer.from(JSON.stringify(job[1]), 'utf8');
      var req = require('http').request({
        host: '127.0.0.1', port: 8000, method: 'POST', path: job[0], agent: false, timeout: 1000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, function (res) { res.resume(); res.on('end', next); res.on('error', next); });
      req.on('timeout', function () { req.destroy(); next(); });
      req.on('error', next); // app closed: stay silent
      req.end(body);
    } catch (e) { next(); }
  }
  function post(path, payload) {
    if (path === '/line') queue.length = 0; // a newer line makes anything still unsent obsolete
    queue.push([path, payload]);
    pump();
  }

  function install() {
    if (typeof Window_Message !== 'function' || typeof require !== 'function') return;
    var game = gameId();
    var seq = 0;
    var name = null;   // set by the name box while the current message is being prepared
    var open = false;  // a line was sent and not yet stopped

    if (typeof Window_NameBox === 'function' && Window_NameBox.prototype.refresh) {
      var refresh = Window_NameBox.prototype.refresh;
      Window_NameBox.prototype.refresh = function (text) {
        name = text;
        return refresh.apply(this, arguments);
      };
    }

    var start = Window_Message.prototype.startMessage;
    Window_Message.prototype.startMessage = function () {
      name = null;
      var result = start.apply(this, arguments);
      try {
        var text = clean(this._textState && this._textState.text);
        if (text) {
          open = true;
          // The name box gets raw backslash codes (colours), the message text gets \x1b ones.
          post('/line', { speaker: clean(String(name || '').replace(/\\/g, '\x1b')) || 'Narrator',
            text: text, engine: ENGINE, game: game, seq: ++seq });
        }
      } catch (e) { /* never crash the game */ }
      return result;
    };

    var terminate = Window_Message.prototype.terminateMessage;
    Window_Message.prototype.terminateMessage = function () {
      var result = terminate.apply(this, arguments);
      try {
        // The app ignores this if a newer line already arrived.
        if (open) { open = false; post('/stop', { engine: ENGINE, game: game, seq: seq }); }
      } catch (e) { /* never crash the game */ }
      return result;
    };
  }

  // Plugins replace and wrap these methods while they load, so wrap last: after every script.
  try {
    if (document.readyState === 'complete') install();
    else window.addEventListener('load', function () { try { install(); } catch (e) { /* silent */ } });
  } catch (e) { /* silent */ }
})();
