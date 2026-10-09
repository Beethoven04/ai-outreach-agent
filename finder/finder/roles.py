"""Find leadership names in crawled page text: '<Name> … CTO' / 'CTO … <Name>' within a short window."""
import json
import re

from . import config

TITLES = r"(?:co-?founder|founder|grundare|stifter|medstifter|ceo|cto|cpo|coo|chief [a-z]+ officer|vd|adm\.? ?direkt\w*|" \
         r"managing (?:director|partner)|partner|head of (?:ai|data|engineering|tech\w*|ml|machine learning)|" \
         r"(?:vp|director) of engineering|lead (?:ai|data|ml) \w+|tech lead|ai lead|teknisk chef|udviklingschef)"
NAME = r"([A-ZÅÄÖÆØÉÜ][a-zåäöæøéüí'\-]+(?: [A-ZÅÄÖÆØÉÜ][a-zåäöæøéüí'\-]+){1,2})"
PAT1 = re.compile(NAME + r"[\s,·|\-–:]{1,6}(" + TITLES + r")\b", re.I)
PAT2 = re.compile(r"\b(" + TITLES + r")[\s,·|\-–:]{1,6}" + NAME)
STOP = {"About Us", "Read More", "Our Team", "Contact Us", "Book Demo", "Get Started", "Learn More", "Privacy Policy"}


def leaders(domain: str):
    f = config.CACHE / "domains" / f"{domain}.json"
    if not f.exists():
        return []
    texts = json.loads(f.read_text()).get("texts_sample", {})
    found = {}
    for url, t in texts.items():
        for m in PAT1.finditer(t):
            name, title = m.group(1), m.group(2)
            if name not in STOP and not re.search(r"\b(the|our|and|we|of)\b", name, re.I):
                found.setdefault((name, title.lower()), url)
        for m in PAT2.finditer(t):
            title, name = m.group(1), m.group(2)
            if name not in STOP:
                found.setdefault((name, title.lower()), url)
    return [(n, t, u) for (n, t), u in found.items()]


def email_contexts(domain: str, width: int = 110):
    """{email: 'text around the address on the page'}: shows the name/title printed next to each address."""
    f = config.CACHE / "domains" / f"{domain}.json"
    if not f.exists():
        return {}
    d = json.loads(f.read_text())
    out = {}
    for e in d.get("site_emails", {}):
        if not e.endswith("@" + domain):
            continue
        for t in d.get("texts_sample", {}).values():
            i = t.lower().find(e)
            if i != -1:
                out[e] = re.sub(r"\s+", " ", t[max(0, i - width): i + len(e) + 30])
                break
        out.setdefault(e, "")
    for e, name in d.get("github_emails", {}).items():
        out.setdefault(e, f"[github commit author: {name}]")
    return out
