"""Public GitHub commits: work addresses that people themselves published in commit metadata.

Finds the company's GitHub organisation (its 'blog' field must point to the company domain), then reads author
emails of recent commits in its public repos. Uses the `gh` CLI (already logged in) for the API token.
"""
import json
import subprocess


def _api(path: str):
    try:
        out = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github+json", path],
                             capture_output=True, text=True, timeout=40)
        return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None
    except (subprocess.SubprocessError, ValueError):
        return None


def find_org(company: str, domain: str):
    q = company.split("(")[0].strip().replace(" ", "+")
    res = _api(f"search/users?q={q}+type:org&per_page=5") or {}
    for item in res.get("items", []):
        org = _api(f"orgs/{item['login']}") or {}
        if domain in (org.get("blog") or "").lower() or domain in (org.get("email") or "").lower():
            return item["login"]
    return None


def commit_emails(company: str, domain: str, max_repos: int = 6):
    """{email: name} for commit authors whose address is on the company domain."""
    org = find_org(company, domain)
    if not org:
        return {}, None
    repos = _api(f"orgs/{org}/repos?sort=pushed&per_page={max_repos}") or []
    found = {}
    for r in repos[:max_repos]:
        commits = _api(f"repos/{org}/{r['name']}/commits?per_page=100") or []
        for c in commits if isinstance(commits, list) else []:
            a = (c.get("commit") or {}).get("author") or {}
            e = (a.get("email") or "").lower()
            if e.endswith("@" + domain) and "noreply" not in e:
                found[e] = a.get("name", "")
    return found, org
