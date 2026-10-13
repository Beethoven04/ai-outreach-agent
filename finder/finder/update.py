"""results.csv → update EXISTING Contacts rows (matched by full name + company) with verification outcomes.

valid      → email + email_status=valid (Sender can use it)
risky      → best address + email_status=risky + evidence (owner ticks allow_risky per person)
not found  → email empty, email_status=not_found, email_tried lists every rejected address, so the n8n finder
             does not spend Hunter/Reoon credits re-testing them
Never touches contacts that are already `valid` or not `active`.
"""
import csv
import re
import time

from . import sheet

SRC = {"public": "public", "github": "public", "format": "pattern", "guess": "pattern"}


def _n(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def update(results_csv, dry=False):
    res = list(csv.DictReader(open(results_csv, newline="")))
    contacts, _ = sheet.rows("Contacts")
    idx = {(_n(c["full_name"]), _n(c["company"])): c for c in contacts}
    today = time.strftime("%Y-%m-%d")
    ups, stats = {}, {"valid": 0, "risky": 0, "not_found": 0, "skipped": 0}
    for r in res:
        c = idx.get((_n(f"{r['first_name']} {r['last_name']}".strip()), _n(r["company"])))
        if not c or c.get("email_status") == "valid" or c.get("contact_status") not in ("", "active"):
            stats["skipped"] += 1
            continue
        tried = r.get("tried", "")
        rejected = ";".join(t.split("=")[0] for t in tried.split("; ") if t.endswith("=invalid") or t.endswith("=no_mx"))
        v = r.get("verdict")
        if v == "valid":
            u = {"email": r["email"], "email_status": "valid", "email_source": SRC.get(r["email_source"], ""),
                 "email_detail": r["detail"][:200], "email_checked_at": today, "email_tried": rejected}
        elif v in ("risky", "unknown") and r.get("email"):
            v = "risky"
            u = {"email": r["email"], "email_status": "risky", "email_source": SRC.get(r["email_source"], ""),
                 "email_detail": (r["detail"] + " | catch-all domain: mailbox cannot be confirmed; tick allow_risky to use")[:240],
                 "email_checked_at": today, "email_tried": rejected}
        else:
            v = "not_found"
            u = {"email": "", "email_status": "not_found", "email_detail": "finder: all candidates rejected",
                 "email_checked_at": today, "email_tried": ";".join(t.split("=")[0] for t in tried.split("; ") if t)}
        stats[v] += 1
        ups[c["contact_id"]] = u
    print(stats)
    if dry:
        for k, u in ups.items():
            print(f"  {k} {u['email_status']:9} {u['email'] or '—':42} {u['email_detail'][:60]}")
        return stats
    n = sheet.update_by_key("Contacts", "contact_id", ups)
    print(f"updated {n} cells in {len(ups)} contacts")
    return stats
