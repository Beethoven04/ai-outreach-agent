# Server: Reacher email verifier

Reacher checks whether a mailbox exists by talking SMTP to the company's mail server (no email is sent).
It needs **outbound port 25**, which home ISPs and many clouds block. It runs on the same server as n8n.

## 1. Test port 25 (on the server)
```bash
nc -vz -w 8 gmail-smtp-in.l.google.com 25 && echo "PORT 25 OPEN" || echo "PORT 25 BLOCKED"
```
If blocked: ask the hosting provider to open it (Hetzner/OVH/Contabo do it on request), or skip Reacher
(the pipeline falls back to the free API verifiers).

## 2. Start Reacher
```bash
mkdir -p ~/reacher && cd ~/reacher
# copy docker-compose.yml and .env.example from this folder, then:
cp .env.example .env
sed -i "s/change-me-to-a-long-random-string/$(openssl rand -hex 24)/" .env
docker compose up -d
docker logs --tail 20 reacher
```

## 3. Smoke test (on the server)
```bash
SECRET=$(grep REACHER_SECRET .env | cut -d= -f2)
# a mailbox that exists → "is_reachable": "safe"
curl -s -X POST localhost:8080/v0/check_email -H "x-reacher-secret: $SECRET" \
  -H 'content-type: application/json' -d '{"to_email":"you@gmail.com"}' | head -c 400; echo
# a made-up mailbox → "invalid"
curl -s -X POST localhost:8080/v0/check_email -H "x-reacher-secret: $SECRET" \
  -H 'content-type: application/json' -d '{"to_email":"no-such-user-x7q2@gmail.com"}' | head -c 400; echo
```

## 4. Use it from the Mac (finder scripts)
```bash
ssh -N -L 8080:127.0.0.1:8080 USER@SERVER_IP     # keep this terminal open
# then in finder/.env:  REACHER_URL=http://127.0.0.1:8080   REACHER_SECRET=<same secret>
```

## 5. Use it from n8n
If n8n runs in Docker on the same host, put both on one Docker network and call `http://reacher:8080/v0/check_email`
with header `x-reacher-secret`. Otherwise use `http://172.17.0.1:8080` (Docker host gateway).

## Reading results
| `is_reachable` | Meaning | Pipeline status |
|---|---|---|
| `safe` | mailbox exists, domain not catch-all | `valid` |
| `invalid` | mailbox does not exist | rejected, try next candidate |
| `risky` | catch-all / full inbox / role account | `risky` (needs your ☑) |
| `unknown` | server refused to answer (greylisting, Microsoft 365 often) | second opinion via Reoon |
