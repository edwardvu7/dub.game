"""Settings loaded from the environment (.env)."""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional for tests
    pass

ROOT = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT / "profiles"
CACHE_DIR = ROOT / "cache"
UI_DIR = ROOT / "ui"

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")
# "George", a premade ElevenLabs voice. Used until a character is cast.
ELEVENLABS_DEFAULT_VOICE = os.getenv("ELEVENLABS_DEFAULT_VOICE", "JBFqnCBsd6RMkjVDRZzb")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

PORT = int(os.getenv("DUBGAME_PORT", "8765"))

DEFAULT_SETTINGS = {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0,
}
