"""Send fake dialogue to a running dub.game app, so you can test without a game.

Usage:  python tests/send_sample.py [seconds_between_lines]
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

URL = "http://127.0.0.1:8765/line"
lines = json.loads((Path(__file__).parent / "sample_lines.json").read_text(encoding="utf-8"))
delay = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0

for line in lines:
    req = urllib.request.Request(
        URL, data=json.dumps(line).encode(), headers={"Content-Type": "application/json"}
    )
    print(line["character"] or "Narrator", "->", urllib.request.urlopen(req).read().decode())
    time.sleep(delay)
