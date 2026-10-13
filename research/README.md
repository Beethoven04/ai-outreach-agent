# research: where target organisations come from

| Source | Script / method | Why |
|---|---|---|
| The Hub (Nordic startup job board) | `sources/thehub.py`: public JSON API, every company currently hiring in the region | Hiring startups answer emails |
| Incubators / science parks | Minc (Malmö), Ideon (Lund), Hetch and Mindpark (Helsingborg): portfolio pages | Early-stage, founder-reachable |
| Funding news | EU-Startups, ArcticStartup, Øresund Startup News, TechSavvy | Freshly funded = growing team |
| Consultancy directories | Clutch, Sortlist, RevenueBase, local "AI-byrå" searches | Boutique AI consultancies |
| Universities | Group pages (KU, DTU, ITU, Lund LTH) | Thesis co-supervision / PhD |
| Job ads (Sweden) | [JobTech](https://jobtechdev.se) open job-ad API from Arbetsförmedlingen, English ads only | Companies hiring in AI right now; some ads name the hiring manager |
| Job ads (Denmark) | Public English job ads | Same: active teams and named managers |
| Career "people" pages | Teamtailor and similar company career sites | Current team members and roles, published by the company |
| Hunter Discover | Free company search by industry and region | New regional AI companies not on the other lists |

Output (git-ignored): `data/research/<date>/pool.csv` → `finder scan` → `targets.csv` → `finder run` → `results.csv` → `finder push`.
