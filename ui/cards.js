// Character cards: one per speaker of one game in voices.json. Shared by the overlay and the main
// window's Voices tab. Cards are keyed by speaker and patched in place, so a voices:changed event
// never rebuilds a card the player is in the middle of adjusting. Voices are saved per game: the
// cards show the game that is playing (follow: true, the overlay) or only the game the host picks
// with setGame() (follow: false, the main window's Voices tab).
(function () {
  'use strict';
  const { SLIDERS, formatSlider, sortSpeakers, voiceLabel, customVoiceLabel, errorText, voicesFor } = window.DubLib;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * mount(container, { dub, onError, emptyText, pickText?, follow?, scene?, onStore }) -> { refresh, setCurrent, setGame, game, destroy }
   * scene (the overlay): list only the characters of the current scene, meaning whoever spoke in
   * this game's last SCENE_LINES lines since dub.game started, newest first. Everyone else is one
   * click away ("Show all").
   * follow (default true): with no game picked, show the game that spoke last. pickText: shown
   * instead of emptyText while no game is picked.
   * dub: window.dub. onError(message): how the host window shows a failure.
   * onStore(store): called with every new {current, games} snapshot (for a game picker).
   */
  function mount(container, opts) {
    const dub = opts.dub;
    const onError = opts.onError || (() => {});
    const onStore = opts.onStore || (() => {});
    const cards = new Map(); // speaker -> { root, controls... }
    let catalog = [];
    let store = { current: null, games: {} };
    const follow = opts.follow !== false;
    let pinned = null; // a game the host picked; null follows the game that is playing (if follow)
    let voices = {};
    const gameId = () => pinned || (follow ? store.current : null);
    const target = (speaker) => ({ game: gameId(), speaker });
    let current = null; // speaker of the line being spoken
    let destroyed = false;
    const openCards = new Set(); // speakers whose cards the player opened (kept across re-renders)
    const spoken = new Set();    // speakers heard since this window opened (before the store catches up)
    const sceneOnly = opts.scene === true;
    const SCENE_LINES = 40;      // about one scene: a character quiet for longer drops off the list
    const heardAt = new Map();   // game -> Map(speaker -> line number when last heard)
    const lineNo = new Map();    // game -> lines heard this session
    let showAll = false;
    let cardSeq = 0;

    const emptyText = opts.emptyText || 'No characters yet. Voices appear here as soon as a game sends its first line.';
    const empty = el('p', 'cards-empty', emptyText);
    const list = el('div', 'cards');
    const unheard = sceneOnly ? el('button', 'btn btn-quiet cards-more') : el('p', 'cards-empty cards-unheard');
    unheard.hidden = true;
    if (sceneOnly) {
      unheard.type = 'button';
      unheard.addEventListener('click', () => { showAll = !showAll; render(); });
    }
    container.replaceChildren(empty, list, unheard);

    let customOn = false; // Settings > Custom voices (experimental)

    // Two voice sets per character: the preset (voice_id) and the designed one (custom_voice). With Custom
    // voices on and a designed voice present, the list starts with "Custom: <name>" and shows whichever set
    // plays (the designed one unless the player picked a preset: use_preset). Otherwise it edits the preset.
    const CUSTOM = '__custom__';
    const usesCustom = (p) => customOn && !!p.custom_voice && !p.use_preset;
    function fillVoices(select, profile) {
      select.replaceChildren();
      const selected = profile.voice_id;
      const known = catalog.some((v) => v.voice_id === selected);
      if (customOn && profile.custom_voice) {
        const opt = el('option', null, customVoiceLabel(profile.custom_voice));
        opt.value = CUSTOM;
        select.append(opt);
      }
      if (!known && selected) {
        const opt = el('option', null, 'Current voice');
        opt.value = selected;
        select.append(opt);
      }
      for (const v of catalog) {
        const opt = el('option', null, voiceLabel(v));
        opt.value = v.voice_id;
        select.append(opt);
      }
      select.value = usesCustom(profile) ? CUSTOM : (selected || '');
    }

    async function run(card, button, work) {
      if (card.busy) return;
      card.busy = true;
      card.root.classList.add('is-busy');
      if (button) button.disabled = true;
      try {
        await work();
      } catch (e) {
        onError(errorText(e));
      } finally {
        card.busy = false;
        if (button) button.disabled = false;
        if (!destroyed) card.root.classList.remove('is-busy');
      }
    }

    // One player for auditions in this window; a new version stops the one playing.
    const listen = new Audio();
    let listenUrl = null;
    function stopListening() {
      listen.pause();
      if (listenUrl) { URL.revokeObjectURL(listenUrl); listenUrl = null; }
    }
    function playVersion(v) {
      stopListening();
      if (!v.data) return;
      const bin = atob(v.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      listenUrl = URL.createObjectURL(new Blob([bytes], { type: v.mime || 'audio/mpeg' }));
      listen.src = listenUrl;
      listen.play().catch(() => {});
    }

    function showAudition(card, speaker, versions) {
      const box = card.audition;
      const close = () => { stopListening(); box.hidden = true; box.replaceChildren(); };
      const title = el('p', 'card-audition-title', 'Pick a version. Only the one you keep uses a voice slot.');
      const rows = (versions || []).map((v, i) => {
        const row = el('div', 'card-audition-row');
        const play = el('button', 'btn btn-quiet', 'Play ' + (i + 1));
        play.type = 'button';
        play.disabled = !v.data;
        play.addEventListener('click', () => { try { playVersion(v); } catch { onError('That version could not be played.'); } });
        const keep = el('button', 'btn', 'Keep');
        keep.type = 'button';
        keep.addEventListener('click', () => run(card, keep, async () => {
          stopListening();
          await dub.invoke('voices:pickPreview', { ...target(speaker), id: v.id });
          close();
        }));
        row.append(play, keep);
        return row;
      });
      const cancel = el('button', 'btn btn-quiet', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      box.replaceChildren(title, ...rows, cancel);
      box.hidden = false; // nothing auto-plays: the player presses Play on the version they want to hear
    }

    // Step 0: the player may describe the voice before the 3 versions are made. Blank = Grok writes it.
    function showBrief(card, speaker, generate) {
      const box = card.audition;
      const close = () => { box.hidden = true; box.replaceChildren(); };
      const label = el('label', 'card-audition-title', 'Describe how this character should sound');
      const text = el('textarea', 'input card-brief-text');
      text.rows = 3;
      text.maxLength = 400;
      text.placeholder = 'e.g. a warm, slightly husky young woman who speaks softly and hesitates when nervous';
      label.append(text);
      const hint = el('p', 'card-brief-hint', 'Optional. Leave it blank and Grok writes it from the game and the character.');
      const go = el('button', 'btn', 'Make 3 versions');
      go.type = 'button';
      go.addEventListener('click', () => generate(text.value.trim(), close));
      const cancel = el('button', 'btn btn-quiet', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      box.replaceChildren(label, hint, go, cancel);
      box.hidden = false;
      text.focus();
    }

    function paintOpen(card, open) {
      card.root.classList.toggle('is-open', open);
      card.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      card.body.inert = !open; // collapsed controls are not tabbable
    }

    function build(speaker) {
      const root = el('article', 'card enter');
      root.addEventListener('animationend', () => root.classList.remove('enter'), { once: true });
      root.dataset.speaker = speaker;

      // The header is one real button: name, status badge and a chevron. It opens the settings.
      const head = el('header', 'card-head');
      const toggle = el('button', 'card-toggle');
      toggle.type = 'button';
      const bodyId = 'card-body-' + (++cardSeq);
      toggle.setAttribute('aria-controls', bodyId);
      const name = el('h3', 'card-name', speaker);
      const badge = el('span', 'pick');
      const chevron = el('span', 'chevron');
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(name, badge, chevron);
      head.append(toggle);

      const about = el('p', 'card-about');
      const notes = el('p', 'card-notes'); // read-only: where the character is from and how they talk (from the game research)

      const voiceRow = el('label', 'field');
      voiceRow.append(el('span', 'field-label', 'Voice'));
      const select = el('select', 'select');
      voiceRow.append(select);

      const card = { root, badge, about, notes, select, sliders: {}, busy: false };

      select.addEventListener('change', () => run(card, null, () => {
        const p = voices[speaker] || {};
        let change;
        if (select.value === CUSTOM) change = { use_preset: false }; // back to the designed voice; not a lock
        else change = { voice_id: select.value, ...(customOn && p.custom_voice ? { use_preset: true } : {}) };
        return dub.invoke('voices:update', { ...target(speaker), patch: change });
      }));

      const faders = el('div', 'faders');
      for (const def of SLIDERS) {
        const row = el('label', 'fader');
        row.title = def.hint;
        const label = el('span', 'field-label', def.label);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = def.min; input.max = def.max; input.step = def.step;
        const out = el('output', 'fader-value');
        const paint = () => {
          out.textContent = formatSlider(def.key, input.value);
          const pct = ((input.value - def.min) / (def.max - def.min)) * 100;
          input.style.setProperty('--fill', pct + '%');
        };
        // "input" fires on every pixel of a drag: only repaint. "change" fires once on release.
        input.addEventListener('input', () => { card.sliders[def.key].dirty = true; paint(); });
        input.addEventListener('change', async () => {
          const slot = card.sliders[def.key];
          try {
            await dub.invoke('voices:update', { ...target(speaker), patch: { [def.key]: Number(input.value) } });
          } catch (e) {
            onError(errorText(e));
          } finally {
            slot.dirty = false;
            if (!destroyed && voices[speaker]) patch(speaker, voices[speaker]);
          }
        });
        row.append(label, input, out);
        faders.append(row);
        card.sliders[def.key] = { input, paint, dirty: false };
      }

      const actions = el('div', 'card-actions');
      const preview = el('button', 'btn', 'Preview');
      preview.type = 'button';
      preview.addEventListener('click', () => run(card, preview, () =>
        dub.invoke('voices:preview', target(speaker))));
      // Reset: drop the player's changes and let Grok cast this character again.
      const reset = el('button', 'btn btn-quiet', 'Reset');
      reset.type = 'button';
      reset.title = 'Undo your changes and let AI choose this voice again.';
      reset.addEventListener('click', () => run(card, reset, () =>
        dub.invoke('voices:reroll', target(speaker))));
      // Muted characters are skipped: nothing is sent to ElevenLabs for them.
      const mute = el('button', 'btn btn-quiet card-mute', 'Mute');
      mute.type = 'button';
      mute.addEventListener('click', () => run(card, mute, () =>
        dub.invoke('voices:update', { ...target(speaker), patch: { muted: !(voices[speaker] && voices[speaker].muted) } })));
      card.mute = mute;
      // Experimental: Grok writes a description, ElevenLabs Voice Design makes the voice.
      const custom = el('button', 'btn btn-quiet card-custom', 'Custom voice');
      custom.type = 'button';
      custom.title = 'Design a unique voice for this character. Uses ElevenLabs credits and a voice slot.';
      // ElevenLabs makes up to 3 versions; the player listens and keeps one (only that one uses a slot).
      const audition = el('div', 'card-audition');
      audition.hidden = true;
      async function makeVersions(description) {
        if (card.busy) return;
        custom.textContent = 'Designing\u2026';
        custom.setAttribute('aria-busy', 'true');
        try {
          await run(card, custom, async () => {
            const versions = await dub.invoke('voices:designPreviews', { ...target(speaker), ...(description ? { description } : {}) });
            showAudition(card, speaker, versions);
          });
        } finally {
          custom.removeAttribute('aria-busy');
          if (!destroyed && voices[speaker]) patch(speaker, voices[speaker]);
        }
      }
      custom.addEventListener('click', () => { if (!card.busy) showBrief(card, speaker, (description) => makeVersions(description)); });
      card.custom = custom;
      card.audition = audition;
      actions.append(preview, reset, mute, custom);

      // grid-template-rows 0fr -> 1fr animates the height; the inner wrapper clips.
      const body = el('div', 'card-body');
      body.id = bodyId;
      const inner = el('div', 'card-body-inner');
      inner.append(about, notes, voiceRow, faders, actions, audition);
      body.append(inner);
      card.toggle = toggle;
      card.body = body;
      const setOpen = (open) => {
        open ? openCards.add(speaker) : openCards.delete(speaker);
        paintOpen(card, open);
      };
      toggle.addEventListener('click', () => setOpen(!openCards.has(speaker)));
      paintOpen(card, openCards.has(speaker));

      root.append(head, body);
      return card;
    }

    function patch(speaker, profile) {
      const card = cards.get(speaker);
      if (!card) return;
      // Muted, then "Designed" (a custom ElevenLabs voice is speaking), then "Locked" (the player set it), else Auto.
      const kind = profile.muted ? 'muted' : usesCustom(profile) ? 'designed' : profile.locked ? 'locked' : 'auto';
      card.badge.textContent = { muted: 'Muted', designed: 'Designed voice', locked: 'Locked', auto: 'Auto' }[kind];
      card.badge.className = 'pick ' + { muted: 'pick-muted', designed: 'pick-custom', locked: 'pick-custom', auto: 'pick-auto' }[kind];
      card.root.classList.toggle('is-muted', !!profile.muted);
      card.custom.hidden = !customOn;
      if (!card.custom.hasAttribute('aria-busy')) card.custom.textContent = profile.custom_voice ? 'Redo custom voice' : 'Custom voice';
      card.mute.textContent = profile.muted ? 'Unmute' : 'Mute';
      card.mute.setAttribute('aria-pressed', profile.muted ? 'true' : 'false');
      card.mute.title = profile.muted ? 'Speak this character again.' : 'Stop speaking this character. Saves ElevenLabs credits.';
      card.badge.title = usesCustom(profile)
        ? 'A voice designed for this character is speaking. Your preset voice is kept.'
        : profile.locked
          ? 'You set this voice. dub.game will not change it.'
          : (profile.reason || 'Chosen automatically.');
      card.about.textContent = profile.personality || '';
      card.about.hidden = !profile.personality;
      const notes = [profile.origin, profile.speech].filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().replace(/\.$/, ''));
      card.notes.textContent = notes.length ? 'Notes: ' + notes.join('. ') + '.' : '';
      card.notes.hidden = !notes.length;
      if (document.activeElement !== card.select) fillVoices(card.select, profile);
      for (const def of SLIDERS) {
        const slot = card.sliders[def.key];
        if (slot.dirty) continue; // the player is dragging this one
        // A profile with no volume yet plays at full volume.
        const v = profile[def.key] !== undefined ? profile[def.key] : (def.key === 'volume' ? 1 : undefined);
        if (v !== undefined) slot.input.value = v;
        slot.paint();
      }
    }

    function render() {
      if (destroyed) return;
      voices = voicesFor(store, gameId());
      // Only characters that have spoken (voices.json "spoken") are listed; so are ones the player
      // changed or muted, and whoever speaks right now. The rest are counted, not shown.
      const sorted = sortSpeakers(voices, current);
      const shown = (s) => s === current || spoken.has(s) || voices[s].spoken || voices[s].locked || voices[s].muted;
      const order = [...sorted.filter((s) => s === current || spoken.has(s)), ...sorted.filter((s) => s !== current && !spoken.has(s))]
        .filter(shown);
      let hidden = sorted.length - order.length;
      if (sceneOnly) {
        const g = String(gameId());
        const at = heardAt.get(g) || new Map();
        const now = lineNo.get(g) || 0;
        const inScene = (sp) => sp === current || (at.has(sp) && now - at.get(sp) < SCENE_LINES);
        const scene = sorted.filter(inScene).sort((a, b) => (b === current) - (a === current) || (at.get(b) || 0) - (at.get(a) || 0));
        const rest = order.filter((sp) => !scene.includes(sp));
        order.length = 0;
        order.push(...scene, ...(showAll ? rest : []));
        hidden = rest.length;
      }
      for (const [speaker, card] of cards) {
        if (!order.includes(speaker)) {
          card.root.remove();
          cards.delete(speaker);
        }
      }
      order.forEach((speaker, index) => {
        if (!cards.has(speaker)) cards.set(speaker, build(speaker));
        const card = cards.get(speaker);
        patch(speaker, voices[speaker]);
        card.root.classList.toggle('is-speaking', speaker === current);
        // Reorder only when needed, so focus and open dropdowns survive.
        if (list.children[index] !== card.root) list.insertBefore(card.root, list.children[index] || null);
      });
      empty.textContent = !gameId() && opts.pickText ? opts.pickText : emptyText;
      empty.hidden = order.length > 0;
      if (sceneOnly) {
        empty.textContent = gameId() ? 'Characters show up here when they speak.' : emptyText;
        unheard.textContent = showAll ? 'Only this scene' : 'Show all characters (' + hidden + ')';
        unheard.hidden = !hidden;
      } else {
        unheard.textContent = hidden ? '+' + hidden + ' not heard yet' : '';
        unheard.hidden = !hidden;
      }
    }

    async function refresh() {
      try {
        const [cat, all] = await Promise.all([
          catalog.length ? catalog : dub.invoke('voices:catalog'),
          dub.invoke('voices:get'),
        ]);
        catalog = Array.isArray(cat) ? cat : [];
        try { const s = await dub.invoke('settings:get'); customOn = !!(s && s.customVoices === true); } catch { /* keep the last value */ }
        accept(all);
      } catch (e) {
        onError(errorText(e));
      }
    }

    function accept(all) {
      store = all && typeof all === 'object' && all.games ? all : { current: null, games: {} };
      // A different game's cards are different characters: start the list fresh.
      if (list.dataset.game !== String(gameId())) {
        for (const card of cards.values()) card.root.remove();
        cards.clear();
        list.dataset.game = String(gameId());
      }
      render();
      onStore(store);
    }

    const off = dub.on('voices:changed', accept);

    refresh();

    return {
      refresh,
      /** The main window tells its cards when the Custom voices switch changes. */
      setCustomVoices(on) {
        if (customOn === !!on) return;
        customOn = !!on;
        for (const [speaker, card] of cards) if (voices[speaker]) patch(speaker, voices[speaker]);
      },
      /**
       * Highlight (and float to the top) whoever is speaking. Pass null to clear. Called once per
       * line; game (the line's game) keeps the scene list per game.
       */
      setCurrent(speaker, game) {
        if (speaker) {
          const g = String(game || gameId());
          const n = (lineNo.get(g) || 0) + 1;
          lineNo.set(g, n);
          if (!heardAt.has(g)) heardAt.set(g, new Map());
          heardAt.get(g).set(speaker, n);
        }
        if (speaker === current && !sceneOnly) return;
        current = speaker || null;
        if (current) spoken.add(current);
        render();
      },
      /** Show one game's voices; null follows the game that is playing. */
      setGame(id) {
        pinned = id || null;
        accept(store);
      },
      game: gameId,
      destroy() { destroyed = true; stopListening(); off(); container.replaceChildren(); cards.clear(); },
    };
  }

  window.DubCards = { mount };
})();
