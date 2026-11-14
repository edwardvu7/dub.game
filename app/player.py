"""Plays one line at a time. A new line cuts off the one before it."""

import threading
from pathlib import Path


class Player:
    def __init__(self):
        self._lock = threading.Lock()
        self._ready = False
        self.volume = 1.0
        self.enabled = True

    def _init(self) -> None:
        if not self._ready:
            import pygame

            pygame.mixer.init()
            self._ready = True

    def play(self, path: Path) -> None:
        if not self.enabled:
            return
        import pygame

        with self._lock:
            self._init()
            pygame.mixer.music.stop()
            pygame.mixer.music.load(str(path))
            pygame.mixer.music.set_volume(self.volume)
            pygame.mixer.music.play()

    def stop(self) -> None:
        if not self._ready:
            return
        import pygame

        with self._lock:
            pygame.mixer.music.stop()
