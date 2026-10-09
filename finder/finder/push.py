"""results.csv → Google Sheet (Companies + Contacts tabs), de-duplicated against the live sheet.

Rules (same as the n8n Sender expects):
- a person is skipped if their email OR (full name + company) already exists in Contacts
- a company is reused if its domain or name already exists in Companies; otherwise a row is appended with the next #
- email_status is written ONLY for `valid` (Reacher/Reoon-confirmed). Everything else stays empty so the n8n
  finder/verifier can still try; `risky` published addresses get a note for the human to decide on allow_risky.
"""
import csv
import re
import time

from . import sheet


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _domain(url):
    return re.sub(r"^https?://(www\.)?", "", (url or "").lower()).split("/")[0]


def push(results_csv, dry=False):
    with open(results_csv, newline="") as fh:
        res = list(csv.DictReader(fh))
    contacts, _ = sheet.rows("Contacts")
    companies, _ = sheet.rows("Companies")
    have_email = {c.get("email", "").lower() for c in contacts if c.get("email")}
    have_name = {(_norm(c.get("full_name")), _norm(c.get("company"))) for c in contacts}
    by_domain = {_domain(c.get("Website")): c for c in companies if c.get("Website")}
    by_domain.update({c.get("company_domain", "").lower(): {"#": c.get("company_no")} for c in contacts if c.get("company_domain")})
    by_name = {_norm(c.get("Company")): c for c in companies}
    next_no = max([int(c["#"]) for c in companies if str(c.get("#", "")).isdigit()] + [0]) + 1
    next_cid = max([int(c["contact_id"][1:]) for c in contacts
                    if re.fullmatch(r"C\d+", c.get("contact_id", "")) and not c["contact_id"].startswith("C9")] + [0]) + 1
    new_companies, new_contacts, skipped = [], [], []
    today = time.strftime("%Y-%m-%d")
    for r in res:
        if not r.get("first_name"):
            continue
        email = (r.get("email") or "").lower()
        full = f"{r['first_name']} {r['last_name']}".strip()
        if (email and email in have_email) or (_norm(full), _norm(r["company"])) in have_name:
            skipped.append(f"{full} ({r['company']}): already in Contacts")
            continue
        comp = by_domain.get(r["domain"].lower()) or by_name.get(_norm(r["company"]))
        if comp is None:
            comp = {"#": next_no, "Priority": r.get("priority", ""), "Type": r.get("type", ""), "Company": r["company"],
                    "City": r.get("city", ""), "Country": r.get("country", ""), "What they do": r.get("what", ""),
                    "Why you fit": r.get("why", ""), "Website": f"https://{r['domain']}",
                    "Notes": f"Added by finder {today}. Source: {r.get('source_url', '')}"}
            new_companies.append(comp)
            by_domain[r["domain"].lower()] = comp
            next_no += 1
        verdict = r.get("verdict", "")
        valid = verdict == "valid"
        note = (f"{'PRIMARY' if r.get('is_primary') in ('1', 'True', 'true', 'yes') else 'backup'} · finder {today} · "
                f"{r.get('email_source', '')} → {verdict} ({r.get('detail', '')[:120]}). Tried: {r.get('tried', '')[:300]}. "
                f"Source: {r.get('source_url', '')}")
        new_contacts.append({
            "contact_id": f"C{next_cid:03d}", "company_no": comp["#"], "company": r["company"],
            "company_domain": r["domain"], "first_name": r["first_name"], "last_name": r["last_name"],
            "full_name": full, "role": r.get("role", ""), "country": r.get("country", ""),
            "public_emails": email if r.get("email_source") == "public" else "",
            "email": email if valid or r.get("email_source") in ("public", "github") else "",
            "email_source": {"public": "public", "github": "public", "format": "pattern", "guess": "pattern"}.get(
                r.get("email_source", ""), ""),
            "email_status": "valid" if valid else "",
            "email_detail": r.get("detail", "")[:200] if valid else "",
            "email_checked_at": today if valid else "",
            "contact_status": "active", "notes": note,
        })
        have_name.add((_norm(full), _norm(r["company"])))
        if email:
            have_email.add(email)
        next_cid += 1
    print(f"companies to add: {len(new_companies)} · contacts to add: {len(new_contacts)} "
          f"(valid: {sum(1 for c in new_contacts if c['email_status'] == 'valid')}) · skipped: {len(skipped)}")
    for s in skipped:
        print("  skip", s)
    if dry:
        for c in new_contacts:
            print(f"  {c['contact_id']} {c['company'][:24]:24} {c['full_name'][:24]:24} {c['email'] or '—':40} {c['email_status']}")
        return
    sheet.append("Companies", new_companies)
    sheet.append("Contacts", new_contacts)
    print("written to sheet")
