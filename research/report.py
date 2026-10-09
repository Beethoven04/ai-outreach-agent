"""candidates/results CSV → readable Markdown report, grouped by organisation.

Usage: python research/report.py data/research/<date>/results.csv data/research/<date>/REPORT.md
"""
import csv
import sys
from collections import OrderedDict

ICON = {"valid": "✅ valid", "risky": "⚠️ risky", "unknown": "❔ unknown", "unchecked": "· unchecked",
        "invalid": "❌ invalid", "not_found": "— none", "no_mx": "❌ no MX"}
SRC = {"public": "published", "github": "own GitHub commits", "format": "company format", "guess": "guess"}


def main(src, out):
    rows = list(csv.DictReader(open(src)))
    orgs = OrderedDict()
    for r in rows:
        orgs.setdefault(r["org_id"], []).append(r)
    n_valid = sum(1 for r in rows if r["verdict"] == "valid")
    n_pub = sum(1 for r in rows if r["email_source"] in ("public", "github"))
    lines = [f"# Outreach targets: {src.split('/')[-2] if '/' in src else ''}", "",
             f"{len(orgs)} organisations · {len(rows)} people · {n_pub} published/own addresses · {n_valid} mailbox-verified", "",
             "Legend: ✅ mailbox confirmed · ⚠️ catch-all/unconfirmable · ❔ no verifier answer · · not checked yet · "
             "★ = primary contact (others are backups: only after 1 day with no reply)", ""]
    groups = OrderedDict([("Companies", []), ("Hubs, associations, research centres", [])])
    for oid, ppl in orgs.items():
        key = "Hubs, associations, research centres" if ppl[0]["type"] in ("Hub/association", "Research centre") \
            else "Companies"
        groups[key].append((oid, ppl))
    for g, items in groups.items():
        lines += [f"## {g} ({len(items)})", "",
                  "| # | Organisation | City | Person | Role | Email | Source | Status |",
                  "|---|---|---|---|---|---|---|---|"]
        for oid, ppl in items:
            for i, r in enumerate(ppl):
                star = "★ " if r["is_primary"] == "1" else ""
                org = f"**{r['company']}** ({r['priority']})" if i == 0 else "″"
                lines.append(f"| {oid if i == 0 else ''} | {org} | {r['city'] if i == 0 else ''} | {star}{r['first_name']} "
                             f"{r['last_name']} | {r['role']} | {r['email'] or '—'} | {SRC.get(r['email_source'], '—')} | "
                             f"{ICON.get(r['verdict'], r['verdict'])} |")
        lines.append("")
    lines += ["## How to read 'Source'", "",
              "- **published**: the address is printed on the company's own site/press next to the person's name.",
              "- **own GitHub commits**: the person used this work address in public commits to the company's GitHub.",
              "- **company format**: built from the format other staff addresses on the site use (e.g. first.last).",
              "- **guess**: common format; only ever sent if a mail server confirms it (✅).", ""]
    open(out, "w").write("\n".join(lines))
    print(f"report → {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
