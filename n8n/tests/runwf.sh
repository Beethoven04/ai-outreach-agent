#!/bin/bash
# usage: runwf.sh <n>  -> executes outreachWf00000<n> inside the test container, prints per-node summary
docker exec -e N8N_RUNNERS_BROKER_PORT=5681 n8n-outreach-test n8n execute --id=outreachWf00000$1 --rawOutput > run$1.json 2>run$1.err
echo "exit $?"; grep -v -i 'deprecat\|warn' run$1.err | head -5
python3 - "$1" <<'PY'
import json,sys
t=open(f'run{sys.argv[1]}.json').read(); i=t.find('{')
if i<0: print('NO JSON OUTPUT:', t[:800]); sys.exit()
d=json.loads(t[i:]); rd=d.get('data',{}).get('resultData',d.get('resultData',{}))
if rd.get('error'): print('WORKFLOW ERROR:', json.dumps(rd['error'])[:800])
for n,runs in rd.get('runData',{}).items():
  for r in runs:
    out=(r.get('data') or {}).get('main') or [[]]
    e=(r.get('error') or {})
    errs=[ (it.get('json') or {}).get('error') for o in out for it in (o or []) if (it.get('json') or {}).get('error')]
    print(f"{n:42s} items={[len(o or []) for o in out]} {('NODE ERR: '+e.get('message','')[:200]) if e else ''} {('ITEM ERR: '+json.dumps(errs[0])[:200]) if errs else ''}")
PY
