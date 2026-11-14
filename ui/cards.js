// Character cards: one per speaker in voices.json. Shared by the overlay and the main window's
// Voices tab. Cards are keyed by speaker and patched in place, so a voices:changed event never
// rebuilds a card the player is in the middle of adjusting.
(function () {
  'use strict';
  const { SLIDERS, formatSlider, sortSpeakers, voiceLabel, errorText } = window.DubLib;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * mount(container, { dub, onError, emptyText }) -> { refresh, setCurrent, destroy }
   * dub: window.dub. onError(message): how the host window shows a failure.
   */
  function mount(container, opts) {
    const dub = opts.dub;
    const onError = opts.onError || (() => {});
    const cards = new Map(); // speaker -> { root, controls... }
    let catalog = [];
    let voices = {};
    let current = null; // speaker of the line being spoken
    let destroyed = false;

    const empty = el('p', 'cards-empty', opts.emptyText ||
      'No characters yet. Voices appear here as soon as a game sends its first line.');
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
      const root = el('article', 'card');
      root.dataset.speaker = speaker;

      const head = el('header', 'card-head');
      const name = el('h3', 'card-name', speaker);
      const badge = el('span', 'tag');
      head.append(name, badge);

      const about = el('p', 'card-about');

      const voiceRow = el('label', 'field');
      voiceRow.append(el('span', 'field-label', 'Voice'));
      const select = el('select', 'select');
      voiceRow.append(select);

      const card = { root, badge, about, select, sliders: {}, busy: false };

      select.addEventListener('change', () => run(card, null, () =>
        dub.invoke('voices:update', { speaker, patch: { voice_id: select.value } })));

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
            await dub.invoke('voices:update', { speaker, patch: { [def.key]: Number(input.value) } });
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
        dub.invoke('voices:preview', { speaker })));
      const reroll = el('button', 'btn btn-quiet', 'Re-roll with AI');
      reroll.type = 'button';
      reroll.title = 'Ask Gemini for a different voice. This replaces your own settings.';
      reroll.addEventListener('click', () => run(card, reroll, () =>
        dub.invoke('voices:reroll', { speaker })));
      actions.append(preview, reroll);

      root.append(head, about, voiceRow, faders, actions);
      return card;
    }

    function patch(speaker, profile) {
      const card = cards.get(speaker);
      if (!card) return;
      card.badge.textContent = profile.locked ? 'Your pick' : 'AI pick';
      card.badge.className = 'tag ' + (profile.locked ? 'tag-yours' : 'tag-ai');
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
      empty.hidden = order.length > 0;
    }

    async function refresh() {
      try {
        const [cat, all] = await Promise.all([
          catalog.length ? catalog : dub.invoke('voices:catalog'),
          dub.invoke('voices:get'),
        ]);
        catalog = Array.isArray(cat) ? cat : [];
        voices = all && typeof all === 'object' ? all : {};
        render();
      } catch (e) {
        onError(errorText(e));
      }
    }

    const off = dub.on('voices:changed', (all) => {
      voices = all && typeof all === 'object' ? all : {};
      render();
    });

    refresh();

    return {
      refresh,
      /** Highlight (and float to the top) whoever is speaking. Pass null to clear. */
      setCurrent(speaker) {
        if (speaker === current) return;
        current = speaker || null;
        render();
      },
      destroy() { destroyed = true; off(); container.replaceChildren(); cards.clear(); },
    };
  }

  window.DubCards = { mount };
})();
