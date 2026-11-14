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
  });

  // Whoever is speaking moves to the top, so their settings are the first thing in view.
  dub.on('line:received', (line) => {
    if (line) cards.setCurrent(line.speaker || null);
  });

  // Main sends this each time the overlay is shown: voices may have changed while it was hidden.
  dub.on('overlay:toggle', () => cards.refresh());

  // The main process turns close() into hide(), so the overlay reopens instantly.
  const hide = () => window.close();
  $('overlay-close').addEventListener('click', hide);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Esc inside an open dropdown should close the dropdown, not the overlay.
    if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
    hide();
  });
})();
