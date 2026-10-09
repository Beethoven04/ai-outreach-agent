"""Team members (name + title) from The Hub startup pages listed in thehub_companies.csv.

Usage: python research/sources/thehub_team.py data/research/sources/thehub_companies.csv data/research/sources/thehub_team.csv
"""
import csv
import re
import sys
import time

import requests

TEAM = re.compile(r'title:"([^"]{0,80})",name:\{first:"([^"]{1,40})",last:"([^"]{0,60})"\}')


def team(url):
    try:
        html = requests.get(url, headers={"User-Agent": "Mozilla/5.0 Chrome/126"}, timeout=25).text
    except requests.RequestException:
        return []
    return [(t.encode().decode("unicode_escape", "ignore") if "\\u" in t else t, f, l) for t, f, l in TEAM.findall(html)]


def main(src, out):
    rows = list(csv.DictReader(open(src)))
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["company", "website", "first_name", "last_name", "title", "hub_url"])
        for r in rows:
            for t, f, l in team(r["hub_url"]):
                w.writerow([r["company"], r["website"], f, l, t, r["hub_url"]])
            time.sleep(0.4)
    print("done →", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
