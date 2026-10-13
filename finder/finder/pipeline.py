"""Targets CSV → per-person ranked email candidates → verification → results CSV.

Candidate order (stop at the first `valid`):
  1. published   – address of this person printed on the company site / press / input file
  2. github      – this person's own commit address on the company domain
  3. format      – company format inferred from OTHER real staff addresses on the site/GitHub
  4. guess       – common formats, only when nothing better exists (max 3), used last
"""
import csv
import json
import time

from . import config, crawl as crawler, github
from .emails import build, infer_format, is_role, local_shape, name_parts, DEFAULT_ORDER, FORMATS
from .verify import verify, mx

DOMAIN_CACHE = config.CACHE / "domains"
DOMAIN_CACHE.mkdir(parents=True, exist_ok=True)


def domain_intel(company: str, domain: str, refresh: bool = False, use_github: bool = True):
    f = DOMAIN_CACHE / f"{domain}.json"
    if f.exists() and not refresh:
        return json.loads(f.read_text())
    c = crawler.crawl(domain)
    gh, org = (github.commit_emails(company, domain) if use_github else ({}, None))
    site_emails = {e: urls for e, urls in c["emails"].items()}
    intel = {
        "domain": domain, "crawled_at": time.strftime("%Y-%m-%d %H:%M"), "pages": c["pages"],
        "site_emails": site_emails, "github_org": org, "github_emails": gh,
        "texts_sample": {u: t[:20000] for u, t in list(c["texts"].items())[:12]},
        "mx": mx(domain),
    }
    f.write_text(json.dumps(intel, indent=1))
    return intel


def _domain_format(intel, people):
    """Infer the format from staff addresses whose owner we can identify (our targets or GitHub names)."""
    personal = [e for e in list(intel["site_emails"]) + list(intel["github_emails"])
                if e.endswith("@" + intel["domain"]) and not is_role(e)]
    known = []
    for e in personal:
        for p in people:
            if build("first", p["first_name"], p["last_name"]) and any(
                    build(fm, p["first_name"], p["last_name"]) == e.split("@")[0] for fm in FORMATS):
                known.append((e, p["first_name"], p["last_name"]))
        name = intel["github_emails"].get(e, "")
        if name and " " in name.strip():
            first, last = name.strip().split(" ", 1)
            known.append((e, first, last))
    fmt = infer_format(known)
    if fmt:
        return fmt, f"inferred from {len(known)} identified address(es)"
    shapes = [local_shape(e.split("@")[0]) for e in personal]
    if shapes:
        top = max(set(shapes), key=shapes.count)
        guess = {"first.last": "first.last", "f.last": "f.last", "first_last": "first_last",
                 "initials": "fl", "single": "first"}[top]
        return guess, f"shape of {len(personal)} unidentified staff address(es): {top}"
    return None, "no staff addresses found"


def candidates_for(person, intel, fmt, all_formats=False):
    dom = intel["domain"]
    out, seen = [], set()

    def add(email, source, note):
        email = (email or "").strip().lower()
        if email and email not in seen and not is_role(email):
            seen.add(email)
            out.append({"email": email, "source": source, "note": note})

    for e in [x.strip() for x in (person.get("published_email") or "").split(";") if x.strip()]:
        add(e, "public", person.get("source_url", "input"))
    f, l, L = name_parts(person["first_name"], person["last_name"])
    pool = [(e, u) for e, u in intel["site_emails"].items() if e.endswith("@" + dom)] + \
        [(e, ["github"]) for e in intel["github_emails"]]
    for e, urls in pool:
        local = e.split("@")[0]
        if any(build(fm, person["first_name"], person["last_name"]) == local for fm in FORMATS) and \
                (local not in (f[:1], "") and (len(local) > 2 or f[:1] + l[:1] == local)):
            src = "github" if urls == ["github"] else "public"
            add(e, src, (urls[0] if urls else ""))
    if fmt:
        add(f"{build(fmt, person['first_name'], person['last_name'])}@{dom}", "format", f"company format {fmt}")
    for fm in (list(DEFAULT_ORDER) + [f for f in FORMATS if f not in DEFAULT_ORDER]) if all_formats else DEFAULT_ORDER:
        if not all_formats and len([c for c in out if c["source"] == "guess"]) >= 3:
            break
        local = build(fm, person["first_name"], person["last_name"])
        if local:
            add(f"{local}@{dom}", "guess", fm)
    return out


def read_targets(path):
    with open(path, newline="") as fh:
        return [r for r in csv.DictReader(fh) if (r.get("domain") or "").strip()]


def run(targets_csv, out_csv, do_verify=True, max_guess_checks=3, use_github=True, all_formats=False):
    people = read_targets(targets_csv)
    by_domain = {}
    for p in people:
        by_domain.setdefault(p["domain"].strip().lower(), []).append(p)
    results = []
    for dom, ppl in by_domain.items():
        intel = domain_intel(ppl[0]["company"], dom, use_github=use_github)
        fmt, fmt_note = _domain_format(intel, ppl)
        print(f"· {dom:32} pages={intel['pages']:2} site={len(intel['site_emails']):2} gh={len(intel['github_emails']):2} "
              f"mx={intel['mx'][1]:9} fmt={fmt} ({fmt_note})")
        for p in ppl:
            if not p.get("first_name"):
                continue
            cands = candidates_for(p, intel, fmt, all_formats=all_formats)
            if all_formats:
                max_guess_checks = 99
            chosen, checks, tried, catch_all = None, [], [], False
            for c in cands:
                if c["source"] == "guess" and len([t for t in tried if t["source"] == "guess"]) >= max_guess_checks:
                    break
                if catch_all and c["source"] in ("format", "guess"):
                    break  # catch-all domain: guesses can never be confirmed
                v = verify(c["email"]) if do_verify else {"verdict": "unchecked", "detail": ""}
                tried.append({**c, **{"verdict": v["verdict"], "detail": v.get("detail", "")}})
                if v.get("catch_all"):
                    catch_all = True
                if v["verdict"] == "valid":
                    chosen = tried[-1]
                    break
            if not chosen:
                # best non-invalid candidate: published/github/format first; on a catch-all domain the top guess
                # (cannot be confirmed by anyone, so it stays `risky` and needs the owner's approval)
                ok_src = ("public", "github", "format", "guess") if catch_all else ("public", "github", "format")
                for t in tried:
                    if t["verdict"] in ("risky", "unknown", "unchecked") and t["source"] in ok_src:
                        chosen = t
                        break
            if chosen and chosen["verdict"] == "valid" and chosen["source"] == "guess" and fmt \
                    and fmt_note.startswith("inferred") \
                    and build(fmt, p["first_name"], p["last_name"]) != chosen["email"].split("@")[0]:
                # mailbox exists, but the company's confirmed format says this person's address looks different:
                # it may belong to someone else with the same first name
                chosen = {**chosen, "verdict": "risky",
                          "detail": chosen["detail"] + f" | WARNING: company format is {fmt}; this mailbox may be another person"}
            results.append({
                **{k: p.get(k, "") for k in ("org_id", "company", "domain", "city", "country", "type", "priority",
                                             "first_name", "last_name", "role", "is_primary", "source_url", "what", "why")},
                "email": chosen["email"] if chosen else "",
                "email_source": chosen["source"] if chosen else "",
                "verdict": chosen["verdict"] if chosen else "not_found",
                "detail": chosen["detail"] if chosen else "",
                "domain_format": fmt or "", "catch_all": catch_all, "mx_provider": intel["mx"][1],
                "tried": "; ".join(f"{t['email']}={t['verdict']}" for t in tried),
            })
    if results:
        with open(out_csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(results[0].keys()))
            w.writeheader()
            w.writerows(results)
    return results


def scan(pool_csv, out_csv, workers=6, use_github=True):
    """Crawl every domain of a pool CSV (org_id, company, domain, ...) and summarise what each site publishes."""
    from concurrent.futures import ThreadPoolExecutor
    with open(pool_csv, newline="") as fh:
        pool = [r for r in csv.DictReader(fh) if (r.get("domain") or "").strip()]

    def one(r):
        dom = r["domain"].strip().lower()
        try:
            intel = domain_intel(r["company"], dom, use_github=use_github)
        except Exception as e:  # one bad site must not stop the batch
            return {**r, "pages": 0, "error": str(e)[:120]}
        emails = set(intel["site_emails"]) | set(intel["github_emails"])
        own = sorted(e for e in emails if e.endswith("@" + dom))
        other = sorted(e for e in emails if not e.endswith("@" + dom))
        personal = [e for e in own if not is_role(e)]
        return {**r, "pages": intel["pages"], "mx_provider": intel["mx"][1], "github_org": intel["github_org"] or "",
                "n_personal": len(personal), "personal": " ".join(personal)[:1500],
                "role": " ".join(e for e in own if is_role(e)), "other_domain": " ".join(other)[:300], "error": ""}

    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, pool))
    keys = list(res[0].keys())
    for r in res:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(out_csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        w.writerows(res)
    return res


def export_candidates(targets_csv, out_txt, max_guess=3, all_formats=False, only=None):
    """Every candidate address for every person (for batch verification elsewhere, e.g. a CI runner)."""
    people = read_targets(targets_csv)
    emails = []
    for p in people:
        if not p.get("first_name") or (only and (p["first_name"], p["last_name"]) not in only):
            continue
        intel = domain_intel(p["company"], p["domain"].strip().lower(), use_github=False)
        fmt, _ = _domain_format(intel, [x for x in people if x["domain"] == p["domain"]])
        guesses = 0
        for c in candidates_for(p, intel, fmt, all_formats=all_formats):
            if c["source"] == "guess":
                guesses += 1
                if guesses > max_guess and not all_formats:
                    continue
            emails.append(c["email"])
    uniq = list(dict.fromkeys(emails))
    open(out_txt, "w").write("\n".join(uniq) + "\n")
    return uniq
