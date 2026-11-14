"""Turns raw line events from a game into clean (character, text) pairs."""

import re
from dataclasses import dataclass

NARRATOR = "Narrator"

# Ren'Py text tags: {b}, {/i}, {w=0.5}, {color=#fff}, {p}, ...
_TAG_RE = re.compile(r"\{[^{}]*\}")
# Escaped braces in Ren'Py are written as {{ and }}
_ESCAPED_OPEN = "\x00"
_ESCAPED_CLOSE = "\x01"


@dataclass
class Line:
    game: str
    character: str
    text: str


def clean_text(text: str) -> str:
    """Strip Ren'Py text tags and squash whitespace."""
    text = text.replace("{{", _ESCAPED_OPEN).replace("}}", _ESCAPED_CLOSE)
    text = _TAG_RE.sub("", text)
    text = text.replace(_ESCAPED_OPEN, "{").replace(_ESCAPED_CLOSE, "}")
    return " ".join(text.split())


def parse_event(event: dict) -> Line | None:
    """Build a Line from a hook event. Returns None if there is nothing to say."""
    text = clean_text(str(event.get("text") or ""))
    if not text:
        return None
    character = str(event.get("character") or "").strip() or NARRATOR
    game = str(event.get("game") or "unknown-game").strip() or "unknown-game"
    return Line(game=game, character=character, text=text)
