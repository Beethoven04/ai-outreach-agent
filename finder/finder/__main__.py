"""CLI.  Run from finder/:   .venv/bin/python -m finder <command> ...

  sheet-check                         list tabs of the tracker sheet (tests the service account)
  crawl <domain>                      print published addresses found on a company site
  verify <email> [...]                run the verification chain on addresses
  run <targets.csv> <out.csv> [--no-verify] [--no-github]
                                      targets → candidates → verification → results CSV
  scan <pool.csv> <out.csv> [--no-github]
                                      crawl every domain in a pool, summarise published addresses
  push <results.csv> [--dry]          add verified people to the sheet's Contacts/Companies tabs (dedupe first)
"""
import sys


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, args = argv[0], argv[1:]
    if cmd == "sheet-check":
        from .sheet import check
        check()
    elif cmd == "crawl":
        from .crawl import crawl
        r = crawl(args[0])
        print(f"{r['pages']} pages")
        for e, urls in sorted(r["emails"].items()):
            print(f"  {e:45} {urls[0]}")
    elif cmd == "verify":
        from .verify import verify
        for e in [a for a in args if not a.startswith("--")]:
            v = verify(e, force="--force" in args)
            print(f"{e:45} {v['verdict']:8} {v.get('mx_provider', ''):10} {v.get('detail', '')}")
    elif cmd == "run":
        from .pipeline import run
        run(args[0], args[1], do_verify="--no-verify" not in args, use_github="--no-github" not in args)
    elif cmd == "scan":
        from .pipeline import scan
        res = scan(args[0], args[1], use_github="--no-github" not in args)
        print(f"{len(res)} domains scanned, {sum(1 for r in res if r.get('n_personal'))} publish personal addresses → {args[1]}")
    elif cmd == "push":
        from .push import push
        push(args[0], dry="--dry" in args)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
