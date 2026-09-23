"""Pull the official rulebook to docs/rules/ as Markdown.

GitBook publishes a machine-readable index at llms.txt and a .md variant of every
page, which is far cleaner than scraping the rendered HTML. Re-run any time to
pick up rule changes (the site shows a 'last updated' per page).
"""
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

BASE = "https://fantaking.gitbook.io/euroleague-fantasy-challenge-rules"
UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
S = requests.Session()
S.headers.update({"User-Agent": UA})

index = S.get(f"{BASE}/llms.txt", timeout=30).text
# llms.txt groups pages under language headings (## ENG, ## ITA, ## GR ...).
# Take only the ENG block; the rest are translations of the same content.
eng = re.split(r"^##\s+", index, flags=re.M)
eng = next((b for b in eng if b.startswith("ENG")), index)
links = re.findall(r"\[([^\]]+)\]\((https://[^)]+\.md)\)", eng)

out_dir = config.DOCS / "rules"
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "_index.md").write_text(index)

for title, url in links:
    slug = url.rsplit("/euroleague-fantasy-challenge-rules/", 1)[-1]
    name = slug.replace("/", "__")
    body = S.get(url, timeout=30).text
    (out_dir / name).write_text(body)
    print(f"{len(body):>6}ch  {name}")
print(f"\n{len(links)} pages -> {out_dir}")
