# finder: find and verify the right person's email

Python 3.9+. Works offline from the n8n server; writes results to the same Google Sheet the workflows read.

```bash
cd finder
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # fill in SHEET_ID, REACHER_URL/SECRET …
.venv/bin/python -m finder --help
```

## Commands
| Command | What it does |
|---|---|
| `scan pool.csv scan.csv` | Crawls every company site in a pool (team / about / contact / imprint pages, Cloudflare-obfuscated and `[at]` addresses), reads public GitHub commit authors on the company domain, looks up MX. One summary row per company. |
| `run targets.csv results.csv` | For each person: ranked email candidates → verification → best address + evidence. |
| `verify a@b.com …` | Verification chain on single addresses. |
| `crawl domain.com` | Debug: addresses published on one site. |
| `sheet-check` | Tests Google Sheet access. |
| `push results.csv [--dry]` | Adds verified people to the sheet (de-duplicated against live Contacts). |

## How a person's address is chosen
Candidates, best first. The first one a mail server confirms wins.

1. **public**: the person's own address printed on the company site or press (or given by the company).
2. **github**: the person's own commit address on the company domain.
3. **format**: the company's address format, inferred from *other real staff addresses* found on the site
   (e.g. `lena@acme.se` + we know Lena → format `first`).
4. **guess**: common formats (`first`, `first.last`, `flast`…), max 3, only when nothing better exists.

Shared inboxes (`info@`, `hello@`, `careers@` …) are never candidates.

## Verification chain (`verify.py`)
syntax → **MX** (DNS) → **Reacher** SMTP mailbox check (self-hosted, `server/`) → **Reoon** (only when Reacher says `unknown`).

| Verdict | Meaning | Sent? |
|---|---|---|
| `valid` | mailbox confirmed, domain is not catch-all | yes |
| `risky` | catch-all domain or unconfirmable: the address *may* exist | only a published address, with approval |
| `invalid` / `no_mx` | does not exist | never |
| `unknown` | no verifier could answer (e.g. Microsoft 365 blocks probing) | published address only, with approval |

Every check is cached (`data/finder_cache/`) so no address is probed twice.

## What worked in production (Oct 2026)
Five research rounds. **68 % of the people found got a mailbox-confirmed address; bounce rate on cold emails under
0.5 %** (one address published on a careers page had been closed since). The rest were held back, never guessed.

| Step | What we did | Why it matters |
|---|---|---|
| Catch-all triage first | one random address (`xxxxxq1234x@domain`) per domain before researching anyone there | a domain that accepts everything can never give a confirmed address, so no time is spent on it and nothing unconfirmed is sent |
| People from the company itself | team / about pages, career "people" pages (Teamtailor), English job ads that name the hiring manager ([JobTech](https://jobtechdev.se) open API for Sweden, public job ads in Denmark) | current, correct names and roles, often with a published address |
| Hunter (free tier) | Discover for new regional AI companies; domain search filtered to `department=it`, `seniority=senior,executive` | finds team leads at large companies, not only founders |
| Format inference | other real staff addresses on the site → the company format | about half of the confirmed addresses came from a format the mail server then confirmed |
| Reacher, self-hosted | SMTP mailbox check, one address at a time, no mail sent | free and repeatable, results cached |
| Reoon for Microsoft 365 | Microsoft throttles the 2nd recipient in one SMTP session (`452 4.5.3 Too many recipients`), so a plain check can say "invalid" for a real mailbox | a real, working mailbox was once called "invalid" by the SMTP check; Reoon gets these right (it settled 19 % of all confirmed addresses) |

Where to stop: the historical JobTech archive masks names and emails, and generic web search for leads at large
companies gave little. Neither is worth the time.

## Ethics / limits
Only public sources: company websites, press, public GitHub metadata. No breached or scraped-leak databases, no LinkedIn scraping.
SMTP checks never send an email. They stop at `RCPT TO`, one at a time.
