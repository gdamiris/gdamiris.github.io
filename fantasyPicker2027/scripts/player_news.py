"""Match news articles to players in the fantasy pool.

Targets the players the projection model is blind on -- those with no EuroLeague
history, whose minutes are pure price-guesses -- and surfaces what the editorial
feed says about their expected role.
"""
import json
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.projections import normalise_name

arts = json.loads((config.RAW / "news.json").read_text())
proj = pd.read_csv(config.DATA / "projections" / "round01.csv")
pl = proj[proj.position != "Head Coach"].copy()
unknown = pl[pl.confidence.fillna(0) < 0.05].copy()


def body(a):
    meta = a.get("articleMetadata") or {}
    parts = [str(meta.get("title", "")), str(meta.get("description", ""))]
    for blk in a.get("content") or []:
        if blk.get("contentType") == "TEXT":
            parts.append(str(blk.get("content", "")))
    return "\n".join(parts)


docs = [{"date": str(a.get("publishDate") or "")[:10],
         "slug": a.get("slug", ""),
         "title": (a.get("articleMetadata") or {}).get("title", ""),
         "tags": a.get("tags") or [],
         "text": body(a)} for a in arts]

print(f"{len(docs)} articles | {len(unknown)} players with no EuroLeague history\n")

found = []
for _, p in unknown.sort_values("price", ascending=False).iterrows():
    ln = str(p.last_name or "").strip()
    fn = str(p.first_name or "").strip()
    if len(ln) < 3:
        continue
    pat = re.compile(rf"\b{re.escape(fn)}\s+{re.escape(ln)}\b|\b{re.escape(ln)}\b", re.I)
    hits = [d for d in docs if pat.search(d["text"])]
    if hits:
        found.append((p, hits))

print(f"=== {len(found)}/{len(unknown)} unknown players have news coverage ===\n")
for p, hits in found[:18]:
    print(f"--- {p.last_name}, {p.first_name}  ({p.team_abbr}, {p.price}cr, "
          f"model assumes {p.minutes_pg:.1f} min -> {p.proj:.1f} pts) ---")
    for d in hits[:2]:
        print(f"    [{d['date']}] {d['title'][:100]}")
        snippet = re.sub(r"\s+", " ", d["text"])
        m = re.search(rf".{{0,180}}\b{re.escape(str(p.last_name))}\b.{{0,220}}", snippet, re.I)
        if m:
            print(f"      ...{m.group(0).strip()[:400]}...")
    print()
