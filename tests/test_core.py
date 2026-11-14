"""Tests for the parts that don't need API keys. Run with: pytest"""

from app import casting, tts
from app.capture import NARRATOR, clean_text, parse_event
from app.profiles import GameProfile


def test_clean_text_strips_renpy_tags():
    assert clean_text("Hi {b}there{/b}!{w=0.5} Bye.") == "Hi there! Bye."
    assert clean_text("{color=#f00}Red{/color}   text") == "Red text"
    assert clean_text("Literal {{braces}}") == "Literal {braces}"


def test_parse_event_defaults_to_narrator_and_skips_empty():
    line = parse_event({"game": "g", "character": None, "text": "It was dark."})
    assert line.character == NARRATOR
    assert parse_event({"game": "g", "character": "A", "text": "{w}"}) is None


def test_cache_key_changes_with_inputs():
    s = {"stability": 0.5}
    assert tts.cache_key("v", s, "hi") == tts.cache_key("v", s, "hi")
    assert tts.cache_key("v", s, "hi") != tts.cache_key("v", s, "hello")
    assert tts.cache_key("v", s, "hi") != tts.cache_key("w", s, "hi")


def test_pick_voice_prefers_matching_gender_and_age():
    voices = [
        {"voice_id": "m-old", "labels": {"gender": "male", "age": "old"}},
        {"voice_id": "f-young", "labels": {"gender": "female", "age": "young"}},
        {"voice_id": "m-young", "labels": {"gender": "male", "age": "young"}},
    ]
    assert casting.pick_voice({"gender": "female", "age": "young adult"}, voices) == "f-young"
    assert casting.pick_voice({"gender": "male", "age": "old"}, voices) == "m-old"


def test_settings_for_maps_expressiveness_and_pace():
    calm = casting.settings_for({"expressiveness": 0, "pace": "slow"})
    loud = casting.settings_for({"expressiveness": 1, "pace": "fast"})
    assert calm["stability"] > loud["stability"]
    assert calm["speed"] < loud["speed"]


def test_profile_round_trip(tmp_path):
    p = GameProfile("My Game!", directory=tmp_path)
    char, created = p.get_or_create("Eileen")
    assert created
    p.update("Eileen", {"settings": {"speed": 1.1}, "locked": True})

    reloaded = GameProfile("My Game!", directory=tmp_path)
    assert reloaded.characters["Eileen"]["settings"]["speed"] == 1.1
    assert reloaded.characters["Eileen"]["locked"] is True
    assert (tmp_path / "my-game.json").exists()
