"""Settings from finder/.env (never committed). See finder/.env.example."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # finder/
REPO = ROOT.parent                                     # repo root
DATA = REPO / "data"                                   # private, git-ignored


def _load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


def get(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


SHEET_ID = get("SHEET_ID")
SERVICE_ACCOUNT = get("SERVICE_ACCOUNT", str(ROOT / "service_account.json"))
REACHER_URL = get("REACHER_URL")            # e.g. http://127.0.0.1:8080 through the SSH tunnel
REACHER_SECRET = get("REACHER_SECRET")
REOON_KEY = get("REOON_KEY")                # optional second opinion (free: 20/day)
HUNTER_KEY = get("HUNTER_KEY")              # optional (free tier)
CACHE = DATA / "finder_cache"
CACHE.mkdir(parents=True, exist_ok=True)
