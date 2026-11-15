// Character cards: one per speaker of one game in voices.json. Shared by the overlay and the main
// window's Voices tab. Cards are keyed by speaker and patched in place, so a voices:changed event
// never rebuilds a card the player is in the middle of adjusting. Voices are saved per game: the
// cards show the game that is playing (follow: true, the overlay) or only the game the host picks
// with setGame() (follow: false, the main window's Voices tab).
(function () {
  'use strict';
  const { SLIDERS, formatSlider, sortSpeakers, voiceLabel, errorText, voicesFor } = window.DubLib;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * mount(container, { dub, onError, emptyText, pickText?, follow?, onStore }) -> { refresh, setCurrent, setGame, game, destroy }
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

    const emptyText = opts.emptyText || 'No characters yet. Voices appear here as soon as a game sends its first line.';
    const empty = el('p', 'cards-empty', emptyText);
    const list = el('div', 'cards');
    container.replaceChildren(empty, list);

    function fillVoices(select, selected) {
      select.replaceChildren();
      const known = catalog.some((v) => v.voice_id === selected);
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
      select.value = selected || '';
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

    function build(speaker) {
      const root = el('article', 'card enter');
      root.addEventListener('animationend', () => root.classList.remove('enter'), { once: true });
      root.dataset.speaker = speaker;

      const head = el('header', 'card-head');
      const name = el('h3', 'card-name', speaker);
      const badge = el('span', 'pick');
      head.append(name, badge);

      const about = el('p', 'card-about');

      const voiceRow = el('label', 'field');
      voiceRow.append(el('span', 'field-label', 'Voice'));
      const select = el('select', 'select');
      voiceRow.append(select);

      const card = { root, badge, about, select, sliders: {}, busy: false };

      select.addEventListener('change', () => run(card, null, () =>
        dub.invoke('voices:update', { ...target(speaker), patch: { voice_id: select.value } })));

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
      // Reset: drop the player's changes and let Gemini cast this character again.
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
      actions.append(preview, reset, mute);

      root.append(head, about, voiceRow, faders, actions);
      return card;
    }

    function patch(speaker, profile) {
      const card = cards.get(speaker);
      if (!card) return;
      card.badge.textContent = profile.muted ? 'Muted' : (profile.locked ? 'Custom' : 'Auto');
      card.badge.className = 'pick ' + (profile.muted ? 'pick-muted' : (profile.locked ? 'pick-custom' : 'pick-auto'));
      card.root.classList.toggle('is-muted', !!profile.muted);
      card.mute.textContent = profile.muted ? 'Unmute' : 'Mute';
      card.mute.setAttribute('aria-pressed', profile.muted ? 'true' : 'false');
      card.mute.title = profile.muted ? 'Speak this character again.' : 'Stop speaking this character. Saves ElevenLabs credits.';
      card.badge.title = profile.locked
        ? 'You set this voice. dub.game will not change it.'
        : (profile.reason || 'Chosen automatically.');
      card.about.textContent = profile.personality || '';
      card.about.hidden = !profile.personality;
      if (document.activeElement !== card.select) fillVoices(card.select, profile.voice_id);
      for (const def of SLIDERS) {
        const slot = card.sliders[def.key];
        if (slot.dirty) continue; // the player is dragging this one
        if (profile[def.key] !== undefined) slot.input.value = profile[def.key];
        slot.paint();
      }
    }

    function render() {
      if (destroyed) return;
      voices = voicesFor(store, gameId());
      const order = sortSpeakers(voices, current);
      for (const [speaker, card] of cards) {
        if (!Object.prototype.hasOwnProperty.call(voices, speaker)) {
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
    }

    async function refresh() {
      try {
        const [cat, all] = await Promise.all([
          catalog.length ? catalog : dub.invoke('voices:catalog'),
          dub.invoke('voices:get'),
        ]);
        catalog = Array.isArray(cat) ? cat : [];
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
      /** Highlight (and float to the top) whoever is speaking. Pass null to clear. */
      setCurrent(speaker) {
        if (speaker === current) return;
        current = speaker || null;
        render();
      },
      /** Show one game's voices; null follows the game that is playing. */
      setGame(id) {
        pinned = id || null;
        accept(store);
      },
      game: gameId,
      destroy() { destroyed = true; off(); container.replaceChildren(); cards.clear(); },
    };
  }

  window.DubCards = { mount };
})();
