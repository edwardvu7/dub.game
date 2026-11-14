"""ElevenLabs text-to-speech with an on-disk audio cache."""

import hashlib
import json
from pathlib import Path

from . import config

API = "https://api.elevenlabs.io/v1"


def cache_key(voice_id: str, settings: dict, text: str, model: str | None = None) -> str:
    payload = json.dumps(
        {"v": voice_id, "s": settings, "t": text, "m": model or config.ELEVENLABS_MODEL},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _headers() -> dict:
    if not config.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY is not set. Add it to your .env file.")
    return {"xi-api-key": config.ELEVENLABS_API_KEY}


def synthesize(text: str, voice_id: str, settings: dict, cache_dir: Path | None = None) -> Path:
    """Return the path to an mp3 of `text` spoken by `voice_id`, generating it if needed."""
    import httpx

    cache_dir = cache_dir or config.CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{cache_key(voice_id, settings, text)}.mp3"
    if out.exists():
        return out

    resp = httpx.post(
        f"{API}/text-to-speech/{voice_id}",
        headers=_headers(),
        json={
            "text": text,
            "model_id": config.ELEVENLABS_MODEL,
            "voice_settings": settings,
        },
        timeout=30,
    )
    resp.raise_for_status()
    tmp = out.with_suffix(".part")
    tmp.write_bytes(resp.content)
    tmp.replace(out)
    return out


def list_voices() -> list[dict]:
    """Voices available on the account, with their labels (gender, age, accent...)."""
    import httpx

    resp = httpx.get(f"{API}/voices", headers=_headers(), timeout=30)
    resp.raise_for_status()
    return [
        {
            "voice_id": v["voice_id"],
            "name": v.get("name", ""),
            "labels": v.get("labels") or {},
            "description": v.get("description") or "",
        }
        for v in resp.json().get("voices", [])
    ]
