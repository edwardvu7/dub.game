"""dub.game companion app: receives lines from the game hook and speaks them.

Run with:  python -m app.main
"""

import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import casting, config, tts
from .capture import parse_event
from .player import Player
from .profiles import GameProfile

log = logging.getLogger("dubgame")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="dub.game")
player = Player()
pool = ThreadPoolExecutor(max_workers=4)

_state_lock = threading.Lock()
_profiles: dict[str, GameProfile] = {}
_current_game: str | None = None
_line_seq = 0  # increases with every line; stale audio is dropped
_casting_in_progress: set[tuple[str, str]] = set()
_voices: list[dict] | None = None

SAMPLE_LINES_FOR_CASTING = 3


# ---------- helpers ----------

def get_profile(game: str) -> GameProfile:
    with _state_lock:
        if game not in _profiles:
            _profiles[game] = GameProfile(game)
        return _profiles[game]


def current_profile() -> GameProfile:
    if _current_game is None:
        raise HTTPException(404, "No game has sent a line yet.")
    return get_profile(_current_game)


def get_voices() -> list[dict]:
    global _voices
    if _voices is None:
        _voices = tts.list_voices()
    return _voices


def cast_character(game: str, name: str) -> None:
    key = (game, name)
    profile = get_profile(game)
    try:
        char = profile.characters[name]
        voice_profile = casting.describe_voice(game, name, char["sample_lines"])
        voice_id = casting.pick_voice(voice_profile, get_voices())
        if profile.characters[name].get("locked"):
            return  # user tuned it while we were waiting
        changes = {"profile": voice_profile, "settings": casting.settings_for(voice_profile)}
        if voice_id:
            changes["voice_id"] = voice_id
        profile.update(name, changes)
        log.info("Cast %s -> %s (%s)", name, voice_id, voice_profile.get("description"))
    except Exception:
        log.exception("Casting failed for %s", name)
    finally:
        _casting_in_progress.discard(key)


def maybe_cast(game: str, name: str, char: dict) -> None:
    key = (game, name)
    if char.get("profile") or char.get("locked") or key in _casting_in_progress:
        return
    _casting_in_progress.add(key)
    pool.submit(cast_character, game, name)


def speak(seq: int, text: str, voice_id: str, settings: dict) -> None:
    try:
        path = tts.synthesize(text, voice_id, settings)
    except Exception:
        log.exception("TTS failed")
        return
    if seq == _line_seq:  # skip if the player already moved on
        player.play(path)


# ---------- API ----------

class LineEvent(BaseModel):
    game: str = "unknown-game"
    character: str | None = None
    text: str = ""
    event: str = "begin"


class CharacterUpdate(BaseModel):
    voice_id: str | None = None
    settings: dict | None = None
    muted: bool | None = None


class PreviewRequest(BaseModel):
    text: str = "Hello! This is how I sound."


@app.post("/line")
def receive_line(event: LineEvent):
    global _current_game, _line_seq
    line = parse_event(event.model_dump())
    if line is None:
        return {"ok": True, "spoken": False}

    _current_game = line.game
    profile = get_profile(line.game)
    char, created = profile.get_or_create(line.character)
    if len(char["sample_lines"]) < SAMPLE_LINES_FOR_CASTING:
        char["sample_lines"].append(line.text)
        profile.save()
    if created or not char.get("profile"):
        maybe_cast(line.game, line.character, char)

    with _state_lock:
        _line_seq += 1
        seq = _line_seq
    player.stop()
    if char.get("muted"):
        return {"ok": True, "spoken": False}
    pool.submit(speak, seq, line.text, char["voice_id"], dict(char["settings"]))
    return {"ok": True, "spoken": True, "character": line.character}


@app.post("/stop")
def stop():
    global _line_seq
    with _state_lock:
        _line_seq += 1
    player.stop()
    return {"ok": True}


@app.get("/characters")
def characters():
    profile = current_profile()
    return {"game": profile.game, "characters": profile.characters}


@app.put("/characters/{name}")
def update_character(name: str, update: CharacterUpdate):
    profile = current_profile()
    if name not in profile.characters:
        raise HTTPException(404, f"Unknown character: {name}")
    changes = {k: v for k, v in update.model_dump().items() if v is not None}
    changes["locked"] = True
    return profile.update(name, changes)


@app.post("/characters/{name}/recast")
def recast(name: str):
    profile = current_profile()
    if name not in profile.characters:
        raise HTTPException(404, f"Unknown character: {name}")
    profile.update(name, {"profile": None, "locked": False})
    maybe_cast(profile.game, name, profile.characters[name])
    return {"ok": True}


@app.post("/characters/{name}/preview")
def preview(name: str, req: PreviewRequest):
    global _line_seq
    profile = current_profile()
    char = profile.characters.get(name)
    if char is None:
        raise HTTPException(404, f"Unknown character: {name}")
    with _state_lock:
        _line_seq += 1
        seq = _line_seq
    pool.submit(speak, seq, req.text, char["voice_id"], dict(char["settings"]))
    return {"ok": True}


@app.get("/voices")
def voices():
    try:
        return get_voices()
    except Exception as exc:
        raise HTTPException(502, f"Could not load ElevenLabs voices: {exc}")


@app.put("/player")
def set_player(enabled: bool | None = None, volume: float | None = None):
    if enabled is not None:
        player.enabled = enabled
        if not enabled:
            player.stop()
    if volume is not None:
        player.volume = min(max(volume, 0.0), 1.0)
    return {"enabled": player.enabled, "volume": player.volume}


@app.get("/")
def index():
    return FileResponse(config.UI_DIR / "index.html")


app.mount("/ui", StaticFiles(directory=config.UI_DIR), name="ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=config.PORT)
