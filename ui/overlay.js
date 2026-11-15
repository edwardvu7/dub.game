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

  // Esc is left to the game (most games open their menu with it); Shift+F2 hides the overlay.
})();
