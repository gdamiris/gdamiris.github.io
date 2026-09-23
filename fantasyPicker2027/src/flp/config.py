"""Configuration loaded from the gitignored .env file."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"
DOCS = ROOT / "docs"


def load_env(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env()

USERNAME = os.environ.get("EL_USERNAME", "")
PASSWORD = os.environ.get("EL_PASSWORD", "")
DEVICE_ID = os.environ.get("EL_DEVICE_ID", "")
GAME_ID = int(os.environ.get("DUNKEST_GAME_ID", "7"))
TEAM_ID = os.environ.get("DUNKEST_TEAM_ID", "")
PLAYERS_LIST_ID = os.environ.get("DUNKEST_PLAYERS_LIST_ID", "49")
SAMPLE_MATCHDAY = os.environ.get("DUNKEST_SAMPLE_MATCHDAY", "1528")
