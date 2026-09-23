"""Harvest the actual squads that won each round, from the official round-winner articles.

The articles name every player: captain, starters, sixth man, bench and coach. That is a
real record of what winning teams looked like, round by round, rather than a guess about
what might work.
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "*/*",
                  "Origin": "https://euroleaguefantasy.euroleaguebasketball.net",
                  "Referer": "https://euroleaguefantasy.euroleaguebasketball.net/"})
API = "https://article-cms-api.incrowdsports.com/v2/articles/slug/"

def article(slug):
    r = S.get(API + slug + "?clientId=EUROLEAGUE", timeout=20)
    if r.status_code != 200:
        return None
    art = r.json()["data"]["article"]
    m = art.get("articleMetadata") or {}
    parts = [str(m.get("title", "")), str(m.get("description", ""))]
    for b in art.get("content") or []:
        if b.get("contentType") == "TEXT":
            parts.append(str(b.get("content", "")))
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", "\n".join(parts))
    return re.sub(r"<[^>]+>", " ", t)


# Rather than regex "Name of Club" -- which breaks on "his teammate X" and on club
# names that changed sponsor -- match against the real 2025-26 player list.
import pandas as pd
from flp.projections import normalise_name

_pg = pd.read_parquet(config.DATA / "player_game.parquet")
_e = _pg[(_pg.competition == "E") & (_pg.season == "E2025")]
_people = _e[["player", "team_code", "position"]].drop_duplicates("player")
LOOKUP = {}
for r in _people.itertuples():
    surname = str(r.player).split(",")[0].strip()
    first = str(r.player).split(",")[1].strip() if "," in str(r.player) else ""
    LOOKUP[normalise_name(f"{first} {surname}")] = {
        "player": r.player, "team": r.team_code, "position": r.position}
_coaches = _pg[(_pg.competition == "E") & (_pg.season == "E2025")]
COACH_LOOKUP = {}
_cg = pd.read_parquet(config.DATA / "coach_game.parquet")
for c in _cg[(_cg.competition == "E") & (_cg.season == "E2025")].coach.dropna().unique():
    surname = str(c).split(",")[0].strip()
    first = str(c).split(",")[1].strip() if "," in str(c) else ""
    COACH_LOOKUP[normalise_name(f"{first} {surname}")] = c
    COACH_LOOKUP[normalise_name(surname)] = c


def find_players(segment, lookup=None):
    """Which known players are named in this stretch of text, in order."""
    lookup = lookup if lookup is not None else LOOKUP
    key = normalise_name(segment)
    hits = []
    allow_single = lookup is COACH_LOOKUP
    for name, info in lookup.items():
        toks = name.split()
        if len(toks) < 2 and not allow_single:
            continue
        if len(toks) < 2 and len(name) < 5:
            continue
        # require the full first+last to appear adjacently
        if f" {name} " in f" {key} ":
            hits.append((key.index(name), name, info))
    hits.sort()
    seen, out = set(), []
    for _, name, info in hits:
        tag = info["player"] if isinstance(info, dict) else info
        if tag in seen:
            continue
        seen.add(tag)
        out.append(info)
    return out


def parse(t):
    """Classify by SENTENCE. The sixth man's name precedes the phrase 'sixth man', and
    coaches are named with a different first name than the feed uses (Sarunas vs Saras),
    so both need handling that a single forward-looking regex cannot give."""
    out = {"score": None, "manager": None, "team": None,
           "captain": None, "starters": [], "sixth": None, "bench": [], "coach": None}
    m = re.search(r"score of\s*([\d,]+\.?\d*)", t)
    if m:
        out["score"] = float(m.group(1).replace(",", ""))
    m = re.search(r"([A-Z][\w'\u2019.\-]+(?:\s+[A-Z][\w'\u2019.\-]+)*)\s+beat everyone else", t)
    if m:
        out["manager"] = m.group(1).strip()
    m = re.search(r"team\s+([^,]+?),\s+which had", t)
    if m:
        out["team"] = m.group(1).strip()

    body = t[t.find("lineup:"):] if "lineup:" in t else t
    sentences = re.split(r"(?<=[.!])\s+", body)
    for sent in sentences:
        low = sent.lower()
        if "head coach" in low:
            # coaches carry different first names in the feed -- match on surname
            hits = find_players(sent, COACH_LOOKUP)
            if hits:
                out["coach"] = hits[0]
        elif "sixth man" in low:
            hits = find_players(sent)
            if hits:
                out["sixth"] = hits[0]
        elif "bench player" in low:
            out["bench"] = find_players(sent)
        elif "starters" in low or "lineup:" in low:
            out["starters"] = find_players(sent)
            cap = re.search(r"captain[,:]?\s+(.{0,60})", sent, re.I)
            if cap:
                c = find_players(cap.group(1))
                if c:
                    out["captain"] = c[0]
    # a sixth man wrongly swept into starters
    if out["sixth"]:
        out["starters"] = [p for p in out["starters"]
                           if p["player"] != out["sixth"]["player"]]
    return out


rows = []
for n in range(1, 35):
    for pat in (f"euroleague-fantasy-challenge-el2526-round-{n}-winner",
                f"euroleague-fantasy-challenge-round-{n}-winner-el2526"):
        t = article(pat)
        if t:
            d = parse(t)
            d["round"] = n
            rows.append(d)
            break
    time.sleep(0.08)

out = config.RAW / "winning_lineups_2526.json"
out.write_text(json.dumps(rows, indent=1))
ok = [r for r in rows if r["captain"] and r["coach"]]
print(f"{len(rows)} round-winner articles, {len(ok)} fully parsed -> {out}")
for r in ok[:3]:
    print(f"\n  R{r['round']} {r['score']} — {r['team']}")
    print(f"    C: {r['captain']['player'] if r['captain'] else '?'}")
    print(f"    starters: {', '.join(p['player'] for p in r['starters'])}")
    print(f"    6th: {r['sixth']['player'] if r['sixth'] else '?'}")
    print(f"    bench: {', '.join(p['player'] for p in r['bench'])}")
    print(f"    coach: {r['coach']}")
