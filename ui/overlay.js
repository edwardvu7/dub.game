// Overlay window (Shift+F2): a compact panel of voice settings on top of the game. It shows the
// same character cards as the Voices tab and nothing else.
// Audio is played by the main window only, so nothing here makes sound.
(function () {
  'use strict';
  const dub = window.dub;
  const $ = (id) => document.getElementById(id);
  const errorBox = $('overlay-error');
  let errorTimer = null;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { errorBox.hidden = true; }, 7000);
  }

  const cards = window.DubCards.mount($('cards-host'), {
    dub,
    onError: showError,
    emptyText: 'No characters yet. They appear here as soon as the game sends its first line.',
    scene: true, // only the characters of the current scene
  });

  // Whoever is speaking moves to the top, so their settings are the first thing in view.
  dub.on('line:received', (line) => {
    if (line) cards.setCurrent(line.speaker || null, line.game);
  });

  // Main sends this each time the overlay is shown: voices may have changed while it was hidden.
  dub.on('overlay:toggle', () => cards.refresh());

  // A native <select> opens its list in a separate OS window, which lands beneath this always-on-top overlay
  // (unclickable). So the overlay draws its own list inside the page for every card's voice picker.
  let list = null;
  function closeList() { if (list) { list.remove(); list = null; } }
  function openList(select) {
    closeList();
    const box = select.getBoundingClientRect();
    list = document.createElement('ul');
    list.className = 'pick-list';
    list.setAttribute('role', 'listbox');
    for (const opt of select.options) {
      const li = document.createElement('li');
      li.textContent = opt.textContent;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(opt.value === select.value));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (opt.value !== select.value) { select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
        closeList();
      });
      list.append(li);
    }
    document.body.append(list);
    const room = window.innerHeight - box.bottom - 8;
    const up = room < 160 && box.top > room; // open upward when there is more space above
    list.style.left = box.left + 'px';
    list.style.width = box.width + 'px';
    list.style.maxHeight = Math.max(120, (up ? box.top : room) - 8) + 'px';
    if (up) list.style.bottom = (window.innerHeight - box.top + 4) + 'px'; else list.style.top = (box.bottom + 4) + 'px';
    const on = list.querySelector('[aria-selected="true"]');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  const isPicker = (t) => t && t.tagName === 'SELECT';
  document.addEventListener('mousedown', (e) => {
    if (isPicker(e.target)) { e.preventDefault(); list ? closeList() : openList(e.target); }
    else if (list && !list.contains(e.target)) closeList();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && list) { e.stopPropagation(); closeList(); }
    else if (isPicker(e.target) && (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown') || e.key === 'F4')) { e.preventDefault(); openList(e.target); }
  }, true);
  window.addEventListener('blur', closeList);
  dub.on('overlay:toggle', closeList);

  // Esc is left to the game (most games open their menu with it); Shift+F2 hides the overlay.
})();
