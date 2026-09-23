"""Pull EuroLeague news articles (injuries, signings, rotation notes).

Injuries and role changes are the largest single source of projection error and
have no structured feed, so we pull the editorial feed and keyword-filter it.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

API = "https://article-cms-api.incrowdsports.com/v2/articles"
UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"

ap = argparse.ArgumentParser()
ap.add_argument("--pages", type=int, default=6)
ap.add_argument("--size", type=int, default=50)
args = ap.parse_args()

s = requests.Session()
s.headers.update({"User-Agent": UA, "Accept": "*/*",
                  "Origin": "https://euroleaguefantasy.euroleaguebasketball.net",
                  "Referer": "https://euroleaguefantasy.euroleaguebasketball.net/"})

arts = []
for page in range(1, args.pages + 1):
    r = s.get(API, params={"clientId": "EUROLEAGUE", "categorySlug": "news",
                           "page": page, "size": args.size}, timeout=30)
    r.raise_for_status()
    body = r.json()
    data = body.get("data") if isinstance(body, dict) else body
    if isinstance(data, dict):
        data = data.get("content") or data.get("articles") or []
    if not data:
        break
    arts += data

out = config.RAW / "news.json"
out.write_text(json.dumps(arts, indent=1))
print(f"{len(arts)} articles -> {out}")
if arts:
    print("keys:", list(arts[0].keys())[:18])


def text(a):
    """Title/description live under articleMetadata; the body is a list of blocks."""
    meta = a.get("articleMetadata") or {}
    parts = [str(meta.get("title", "")), str(meta.get("description", ""))]
    for blk in a.get("content") or []:
        if blk.get("contentType") == "TEXT":
            parts.append(str(blk.get("content", "")))
    return " ".join(parts)


KEYS = re.compile(r"injur|out for|surgery|sidelin|miss|return|sign|contract|waive|"
                  r"release|extend|acl|knee|ankle|calf|hamstring|doubt", re.I)
hits = [a for a in arts if KEYS.search(text(a))]
print(f"\n=== {len(hits)} articles mentioning injury/roster keywords ===")
for a in hits[:30]:
    date = str(a.get("publishDate") or "")[:10]
    title = (a.get("articleMetadata") or {}).get("title")
    print(f"  {date}  {str(title)[:110]}")
