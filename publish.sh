#!/usr/bin/env bash
# Publish this project to GitHub as YOUR commits (no co-author lines).
#   ./publish.sh            first run: git init + safety scan + commit + create public repo + push
#   ./publish.sh "message"  later runs: safety scan + commit + push
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="ai-outreach-agent"
VISIBILITY="--public"
MSG="${1:-Update}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }

# 1. git init on first run
if [ ! -d .git ]; then
  git init -q -b main
  grn "git repository created"
  MSG="${1:-Initial commit: AI outreach agent (n8n + Python finder)}"
fi

# 2. stage everything that .gitignore allows
git add -A

# 3. safety scan: block the commit if private data is staged
BAD=0
STAGED=$(git diff --cached --name-only)
for f in $STAGED; do
  case "$f" in
    data/*|private/*|roles/*|CLAUDE.md|*.env|n8n/build_config.json|*service_account*|n8n/workflows/*|n8n/tests/sheet_fixture.json)
      red "BLOCKED (private path staged): $f"; BAD=1 ;;
  esac
done
# secrets and personal identifiers inside staged files
PATTERNS='AIza[0-9A-Za-z_-]{30,}|gsk_[0-9A-Za-z]{20,}|ghp_[0-9A-Za-z]{30,}|gho_[0-9A-Za-z]{30,}|xox[bp]-|-----BEGIN (RSA |EC )?PRIVATE KEY|"private_key"|1wPqnvmD1hZ5qINQXnxQRgtmIhVA7FK1X|683772247|eddiazlouai|eddiaz04louai|\+212 ?7'
if git diff --cached -U0 | grep -E "^\+" | grep -Eq "$PATTERNS"; then
  red "BLOCKED: a staged change contains a secret / private ID:"
  git diff --cached -U0 | grep -E "^\+" | grep -En "$PATTERNS" | head -5
  BAD=1
fi
if [ "$BAD" = 1 ]; then
  git reset -q
  red "Nothing committed. Fix the files above (or add them to .gitignore) and run again."
  exit 1
fi
grn "safety scan passed ($(echo "$STAGED" | grep -c . || true) files staged)"

# 4. commit as you (uses your git user.name / user.email)
if git diff --cached --quiet; then
  grn "nothing new to commit"
else
  git commit -q -m "$MSG"
  grn "committed: $MSG"
fi

# 5. create the GitHub repo on first push, then push
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" $VISIBILITY --source=. --remote=origin \
    --description "AI outreach agent: find organisations, find & verify the right people's emails, draft personalised emails with LLM quality control, send safely, triage replies (n8n + Python)"
fi
git push -u origin main
grn "pushed → $(gh repo view --json url -q .url 2>/dev/null || git remote get-url origin)"
