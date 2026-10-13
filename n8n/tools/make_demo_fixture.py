#!/usr/bin/env python3
"""Turn the private test fixture (a snapshot of the real sheet) into a public demo fixture.

Every real person, company and domain is replaced by a fake one, consistently, in BOTH the fixture and the
end-to-end test file, so the 85 checks keep exercising exactly the same cases.

Usage (from n8n/):  python3 tools/make_demo_fixture.py tests/sheet_fixture.json tests/e2e.test.js
Writes: tests/sheet_fixture.demo.json and rewrites tests/e2e.test.js to use it.
"""
import json, os
import re
import sys

FIRST = ["Joaquín", "Mikael", "Ines", "Tobias", "Freja", "Oskar", "Lena", "Viktor", "Maja", "Henrik", "Sara", "Jonas",
         "Elin", "Anders", "Clara", "Nils", "Ida", "Rasmus", "Alma", "Felix", "Nora", "Emil", "Agnes", "Lucas", "Tilde",
         "Hugo", "Astrid", "Karl", "Signe", "Axel", "Ebba", "Magnus", "Liv", "Oliver", "Saga", "Theo", "Vera", "Arvid",
         "Elsa", "Jakob", "Moa", "Sebastian", "Linnea", "Filip", "Ella", "Gustav", "Wilma"]
LAST = ["Lindqvist", "Brandt", "Holm", "Ek", "Dahl", "Berg", "Krog", "Lund", "Strand", "Moller", "Vik", "Sand", "Falk",
        "Hedlund", "Norberg", "Aakre", "Bech", "Juhl", "Kjaer", "Lauridsen", "Mark", "Nyborg", "Olsen", "Prien", "Rask",
        "Skov", "Toft", "Ulrik", "Vang", "Winther", "Aagaard", "Bisgaard", "Cramer", "Dyhr", "Engel", "Fogh", "Graae",
        "Hald", "Iversen", "Jessen", "Kofoed", "Lerche", "Munk", "Nordahl", "Orum", "Poulsen", "Riis"]
WORDS = ["Nimbus", "Polar", "Kestrel", "Fjord", "Lumen", "Arbor", "Cobalt", "Ember", "Harbor", "Juniper", "Krona",
         "Lynx", "Meridia", "Nova", "Orbit", "Pine", "Quill", "Rune", "Sable", "Tundra", "Umbra", "Vale", "Willow",
         "Zephyr", "Aster", "Birch", "Cirrus", "Delta", "Eider", "Flint"]
SUFFIX = ["Labs", "AI", "Analytics", "Systems", "Agents", "Data", "Works", "Studio"]


def ascii_low(s):
    import unicodedata
    s = str(s or "").lower()
    for a, b in (("æ", "ae"), ("ø", "o"), ("å", "a")):
        s = s.replace(a, b)
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def main(fixture, test_file):
    d = json.load(open(fixture))
    rep = {}  # real string -> fake string

    def put(real, fake):
        real = str(real or "").strip()
        if len(real) >= 3 and real not in rep:
            rep[real] = fake

    # companies (all rows of Companies tab, numbered)
    comp = d["Companies"]
    ch = comp[0]
    ci, wi = ch.index("Company"), ch.index("Website")
    dom_of = {}
    for i, r in enumerate(comp[1:]):
        name = f"{WORDS[i % len(WORDS)]} {SUFFIX[i % len(SUFFIX)]}" + (f" {i // len(WORDS) + 1}" if i >= len(WORDS) else "")
        slug = re.sub(r"[^a-z0-9]", "", name.lower())
        real_dom = re.sub(r"^https?://(www\.)?", "", str(r[wi] or "")).split("/")[0]
        tld = real_dom.rsplit(".", 1)[-1] if "." in real_dom else "io"
        put(r[ci], name)
        if real_dom and " " not in real_dom:
            put(real_dom, f"{slug}.{tld}")
            dom_of[real_dom] = f"{slug}.{tld}"
        base = str(r[ci]).split("(")[0].strip()
        put(base, name)
    # people
    c = d["Contacts"]
    h = c[0]
    fi, li, di = h.index("first_name"), h.index("last_name"), h.index("company_domain")
    for i, r in enumerate(c[1:]):
        f, l = FIRST[i % len(FIRST)], LAST[i % len(LAST)]
        if r[di] and r[di] not in dom_of:
            put(r[di], f"{WORDS[(i + 7) % len(WORDS)].lower()}{i}.io")
        if r[li]:
            put(f"{r[fi]} {r[li]}", f"{f} {l}")
            put(r[li], l)
        put(r[fi], f)
        # name parts inside email local parts: dennis@ / dennis.lieber@ / dario@
        fa, la = ascii_low(r[fi]), ascii_low(r[li]).split(" ")[-1] if r[li] else ""
        if fa:
            rep.setdefault(f"{fa}@", f"{ascii_low(f)}@")
            rep.setdefault(f"'{fa}'", f"'{ascii_low(f)}'")      # test-file literals: startsWith('bastian')
            rep.setdefault(f"/{fa}/", f"/{ascii_low(f)}/")      # test-file regexes: /bastian/
            if la:
                rep.setdefault(f"{fa}.{la}@", f"{ascii_low(f)}.{ascii_low(l)}@")
    # owner identifiers
    # owner identifiers come from the private build_config.json, never from this file
    owner = json.load(open(__file__.rsplit("/tools/", 1)[0] + "/build_config.json")).get("OWNER", {})
    for real, fake in [(owner.get("phone"), "+00 000 00 00 00"), (owner.get("from_email"), "owner@example.com"),
                       (owner.get("test_inbox"), "owner.test@example.com")] + \
                      [(e, f"owner{i}@example.com") for i, e in enumerate(owner.get("other_emails", []))]:
        if real:
            rep[real] = fake
    keys = sorted(rep, key=len, reverse=True)
    pat = re.compile("|".join(re.escape(k) for k in keys))

    def sub(s):
        return pat.sub(lambda m: rep[m.group(0)], s) if isinstance(s, str) else s

    out = {}
    for tab, rows in d.items():
        out[tab] = [[sub(v) for v in row] if j else row for j, row in enumerate(rows)]
    # drop free-text research columns that could still identify people
    for col in ("Key people (public)", "Who to contact first", "Public email(s)", "Phone", "LinkedIn", "Notes"):
        if col in out["Companies"][0]:
            k = out["Companies"][0].index(col)
            for row in out["Companies"][1:]:
                row[k] = ""
    k = out["Contacts"][0].index("notes")
    for row in out["Contacts"][1:]:
        row[k] = "demo"
    demo = fixture.replace(".json", ".demo.json")
    json.dump(out, open(demo, "w"), ensure_ascii=False)
    t = open(test_file).read()
    t = sub(t).replace("require('./sheet_fixture.json')", "require('./sheet_fixture.demo.json')")
    # extra literal replacements for real names used inside the test file (kept out of the public repo)
    extra = os.path.join(os.path.dirname(__file__), "..", "..", "private", "tools", "demo_extra_map.json")
    for real, fake in (json.load(open(extra)).items() if os.path.exists(extra) else []):
        t = t.replace(real, fake)
    open(test_file, "w").write(t)
    print(f"{len(rep)} replacements → {demo}; {test_file} now uses the demo fixture")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
