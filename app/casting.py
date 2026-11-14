"""Ask an LLM (Gemini) to describe a character's voice, then pick a matching ElevenLabs voice."""

import json

from . import config

PROMPT = """You are casting voice actors for a visual novel.
Based on the character's name and their first lines of dialogue, describe the voice
that fits them best. Reply with JSON only, using exactly these keys:

{{
  "gender": "male" | "female" | "neutral",
  "age": "child" | "young" | "young adult" | "middle aged" | "old",
  "tone": "a few comma-separated words, e.g. warm, upbeat",
  "pace": "slow" | "medium" | "fast",
  "accent": "e.g. american, british, none",
  "expressiveness": a number from 0 (flat) to 1 (very dramatic),
  "description": "one sentence describing the voice"
}}

Game: {game}
Character: {name}
Lines:
{lines}
"""

PACE_TO_SPEED = {"slow": 0.9, "medium": 1.0, "fast": 1.1}


def describe_voice(game: str, name: str, lines: list[str]) -> dict:
    """Call Gemini and return the parsed voice profile."""
    from google import genai

    if not config.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set. Add it to your .env file.")
    client = genai.Client(api_key=config.GEMINI_API_KEY)
    prompt = PROMPT.format(
        game=game, name=name, lines="\n".join(f"- {line}" for line in lines[:5])
    )
    resp = client.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config={"response_mime_type": "application/json"},
    )
    return json.loads(resp.text)


def _norm(value) -> str:
    return str(value or "").strip().lower()


def score_voice(profile: dict, voice: dict) -> float:
    """Higher is a better match. Uses the labels ElevenLabs attaches to voices."""
    labels = {k: _norm(v) for k, v in (voice.get("labels") or {}).items()}
    text = " ".join([_norm(voice.get("description"))] + list(labels.values()))
    score = 0.0

    gender = _norm(profile.get("gender"))
    if gender in ("male", "female"):
        if labels.get("gender") == gender:
            score += 5
        elif labels.get("gender"):
            score -= 10  # wrong gender is the worst mismatch

    age = _norm(profile.get("age"))
    if age and age in labels.get("age", ""):
        score += 3
    elif age and age.split()[0] in labels.get("age", ""):
        score += 1.5

    accent = _norm(profile.get("accent"))
    if accent and accent not in ("none", "neutral") and accent in labels.get("accent", ""):
        score += 2

    for word in _norm(profile.get("tone")).replace(",", " ").split():
        if len(word) > 3 and word in text:
            score += 1
    return score


def pick_voice(profile: dict, voices: list[dict]) -> str | None:
    if not voices:
        return None
    best = max(voices, key=lambda v: score_voice(profile, v))
    return best["voice_id"]


def settings_for(profile: dict) -> dict:
    """Turn the LLM's profile into starting ElevenLabs voice settings."""
    try:
        expr = float(profile.get("expressiveness", 0.4))
    except (TypeError, ValueError):
        expr = 0.4
    expr = min(max(expr, 0.0), 1.0)
    return {
        "stability": round(0.75 - 0.45 * expr, 2),  # more expressive -> less stable
        "similarity_boost": 0.75,
        "style": round(0.5 * expr, 2),
        "speed": PACE_TO_SPEED.get(_norm(profile.get("pace")), 1.0),
    }
