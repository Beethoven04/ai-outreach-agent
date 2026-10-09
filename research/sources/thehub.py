"""Pull every startup currently hiring on The Hub (thehub.io, the Nordic startup job board) in a region.

Uses the same public JSON API the website calls. Output: one row per company with its open job titles.
Usage: python research/sources/thehub.py data/research/sources/thehub_companies.csv
"""
import csv
import re
import sys
import time

import requests

API = "https://api.thehub.io/v2/jobs"
REGION = re.compile(r"copenhagen|københavn|kobenhavn|frederiksberg|lyngby|hellerup|valby|nørrebro|østerbro|vesterbro|"
                    r"amager|ørestad|søborg|gentofte|herlev|ballerup|malmö|malmo|lund|helsingborg|hyllie", re.I)
TECH = re.compile(r"\b(ai|ml|llm|genai|machine learning|data|engineer|developer|software|python|backend|full.?stack|"
                  r"intern|thesis|student|research|scientist|automation|agent)\b", re.I)


def pull(country):
    page, out = 1, []
    while True:
        r = requests.get(API, params={"countryCode": country, "page": page},
                         headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}, timeout=30)
        d = r.json()
        out += d.get("docs", [])
        if page >= d.get("pages", 1):
            return out
        page += 1
        time.sleep(0.5)


def main(out_csv):
    companies = {}
    for cc in ("DK", "SE"):
        for j in pull(cc):
            loc = (j.get("location") or {})
            where = f"{loc.get('locality', '')} {loc.get('address', '')}"
            if not REGION.search(where):
                continue
            c = j.get("company") or {}
            row = companies.setdefault(c.get("key"), {
                "company": c.get("name", ""), "website": c.get("website", ""), "employees": c.get("numberOfEmployees", ""),
                "founded": c.get("founded", ""), "city": loc.get("locality", ""), "country": loc.get("country", ""),
                "hub_url": f"https://thehub.io/startups/{c.get('key')}", "jobs": [], "tech_jobs": 0})
            row["jobs"].append(j.get("title", ""))
            row["tech_jobs"] += bool(TECH.search(j.get("title", "")))
    with open(out_csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["company", "website", "city", "country", "employees", "founded",
                                           "tech_jobs", "jobs", "hub_url"])
        w.writeheader()
        for row in sorted(companies.values(), key=lambda r: -r["tech_jobs"]):
            w.writerow({**row, "jobs": " | ".join(row["jobs"])[:600]})
    print(f"{len(companies)} companies in region → {out_csv}")


if __name__ == "__main__":
    main(sys.argv[1])
