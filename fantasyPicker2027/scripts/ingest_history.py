"""Download historical per-player game stats for EuroLeague seasons.

Source is the incrowdsports feed rather than live.euroleague.net: it is on a
different CDN (the euroleague.net hosts rate-limit hard and will Cloudflare-block
an IP), and its payload is richer -- it carries the person code, position and club
alongside the stats, which is what we need to map history onto this season's pool.

`valuation` in this feed is PIR, which is exactly the fantasy scoring base.
Cached on disk and resumable: re-running only fetches what is missing.
"""
import argparse
import json
import random
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

# The season code carries its competition: E2025 = EuroLeague, U2025 = EuroCup.
FEED = ("https://feeds.incrowdsports.com/provider/euroleague-feeds/v2"
        "/competitions/{c}/seasons/{s}/games/{g}/stats")
RESULTS = "https://api-live.euroleague.net/v1/results?seasoncode={s}"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"

ap = argparse.ArgumentParser()
ap.add_argument("--seasons", default="E2025,E2024,E2023,E2022,E2021,E2020,E2019,E2018",
                help="season codes; E* = EuroLeague, U* = EuroCup")
ap.add_argument("--workers", type=int, default=4)
ap.add_argument("--interval", type=float, default=0.12, help="min seconds between requests")
ap.add_argument("--limit", type=int, default=0, help="stop after N fetches (0 = all)")
args = ap.parse_args()
SEASONS = [s.strip() for s in args.seasons.split(",") if s.strip()]

OUT = config.RAW / "stats"
OUT.mkdir(parents=True, exist_ok=True)
RESULTS_PATH = config.RAW / "results.json"
S = requests.Session()
S.headers.update({"User-Agent": UA})

_lock = threading.Lock()
_next_at = [0.0]


def paced_get(url: str, tries: int = 5):
    backoff = 4.0
    for attempt in range(tries):
        with _lock:
            wait = _next_at[0] - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _next_at[0] = time.monotonic() + args.interval
        try:
            r = S.get(url, timeout=45)
        except Exception:
            if attempt == tries - 1:
                return None
            time.sleep(backoff)
            backoff = min(backoff * 2, 120)
            continue
        if r.status_code in (429, 500, 502, 503):
            time.sleep(float(r.headers.get("Retry-After", backoff)) + random.random())
            backoff = min(backoff * 2, 120)
            continue
        return r
    return None


def fetch_results(season: str) -> list[dict]:
    r = paced_get(RESULTS.format(s=season))
    if r is None or r.status_code != 200:
        raise RuntimeError(f"results {season}: blocked (HTTP {getattr(r, 'status_code', '-')})")
    out = []
    for g in ET.fromstring(r.text).findall("game"):
        def t(tag):
            el = g.find(tag)
            return el.text if el is not None else None
        if (t("played") or "").lower() != "true":
            continue
        try:
            out.append({
                "season": season, "gamecode": int(t("gamenumber")),
                "gameday": int(t("gameday") or 0), "group": t("group"), "date": t("date"),
                "home_code": t("homecode"), "away_code": t("awaycode"),
                "home_name": t("hometeam"), "away_name": t("awayteam"),
                "home_score": int(t("homescore")), "away_score": int(t("awayscore")),
            })
        except (TypeError, ValueError):
            continue
    return out


all_games = json.loads(RESULTS_PATH.read_text()) if RESULTS_PATH.exists() else []
have = {g["season"] for g in all_games}
print(f"cached results: {len(all_games)} games, seasons {sorted(have)}", flush=True)
for season in [s for s in SEASONS if s not in have]:
    got = fetch_results(season)
    all_games += got
    print(f"fetched results {season}: {len(got)}", flush=True)
    RESULTS_PATH.write_text(json.dumps(all_games, indent=1))

order = {s: i for i, s in enumerate(SEASONS)}
wanted = sorted((g for g in all_games if g["season"] in SEASONS),
                key=lambda g: (order[g["season"]], g["gamecode"]))
todo = [g for g in wanted if not (OUT / f"{g['season']}_{g['gamecode']}.json").exists()]
cached = len(wanted) - len(todo)
if args.limit:
    todo = todo[:args.limit]
print(f"{cached} cached, {len(todo)} to fetch\n", flush=True)

done = [0]
errors = []


def fetch(g) -> None:
    season, gc = g["season"], g["gamecode"]
    r = paced_get(FEED.format(c=season[0], s=season, g=gc))
    if r is None or r.status_code != 200:
        errors.append(f"{season}_{gc}: HTTP {getattr(r, 'status_code', 'none')}")
    else:
        try:
            d = r.json()
            if d.get("local", {}).get("players"):
                (OUT / f"{season}_{gc}.json").write_text(json.dumps(d))
            else:
                errors.append(f"{season}_{gc}: empty")
        except Exception as e:
            errors.append(f"{season}_{gc}: {str(e)[:50]}")
    done[0] += 1
    if done[0] % 100 == 0:
        print(f"  {done[0]}/{len(todo)}  errors={len(errors)}", flush=True)


with ThreadPoolExecutor(max_workers=args.workers) as ex:
    list(ex.map(fetch, todo))

print(f"\ndone. files: {len(list(OUT.glob('*.json')))}, errors: {len(errors)}")
for e in errors[:10]:
    print("  ", e)
