"""Load and save per-game character voice profiles (profiles/<game>.json)."""

import json
import re
import threading
from copy import deepcopy
from pathlib import Path

from . import config

_lock = threading.Lock()


def _slug(game: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", game.lower()).strip("-") or "unknown-game"


def path_for(game: str, directory: Path | None = None) -> Path:
    return (directory or config.PROFILES_DIR) / f"{_slug(game)}.json"


def new_character(voice_id: str | None = None) -> dict:
    return {
        "voice_id": voice_id or config.ELEVENLABS_DEFAULT_VOICE,
        "settings": deepcopy(config.DEFAULT_SETTINGS),
        "profile": None,  # filled in by casting
        "sample_lines": [],
        "muted": False,
        "locked": False,  # True once the user tunes it; casting won't overwrite
    }


class GameProfile:
    def __init__(self, game: str, directory: Path | None = None):
        self.game = game
        self.path = path_for(game, directory)
        self.characters: dict[str, dict] = {}
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.characters = data.get("characters", {})

    def get_or_create(self, name: str) -> tuple[dict, bool]:
        """Return (character, created)."""
        with _lock:
            if name in self.characters:
                return self.characters[name], False
            self.characters[name] = new_character()
            return self.characters[name], True

    def update(self, name: str, changes: dict) -> dict:
        with _lock:
            char = self.characters.setdefault(name, new_character())
            if "settings" in changes:
                char["settings"].update(changes.pop("settings"))
            char.update(changes)
        self.save()
        return char

    def save(self) -> None:
        with _lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            data = {"game": self.game, "characters": self.characters}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self.path)
