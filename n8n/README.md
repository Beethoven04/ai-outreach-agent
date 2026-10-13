# n8n workflows

Nine workflows, generated from source. Nothing is edited in the n8n UI: change `src/` or `prompts/`, run
`build.py`, run the tests, then import or deploy.

```
src/common.js          helpers injected into every Code node (sheet tables, Writer, dates, MIME, Gmail parsing, cards)
src/wfN_*.js           one file per workflow, one section per Code node (// ---- NODE: … / // @node key)
prompts/*.md           LLM system prompts (QC rubric, reply classifier, follow-up writer, reply drafter, reply editor)
build.py               wires nodes + connections, fills sheet/credential ids from build_config.json → workflows/*.json
tests/e2e.test.js      170 end-to-end checks: every Code node against an anonymised sheet, APIs mocked
tests/mock_server.js   mock of Sheets, Gmail, Gemini/Groq, Hunter, Reoon, DoH and Telegram for a real n8n container
```

## The workflows

| # | Workflow | Trigger (Stockholm) | What it does |
|---|---|---|---|
| 0 | Error handler | any crash | Telegram alert with a fix hint + Log row |
| 1 | Find & verify emails | every 30 min | Hunter finder → DNS MX → Reoon mailbox check → `valid` / `risky` / `not_found` |
| 2 | Quality check (LLM) | every 15 min | code rules + LLM rubric against Profile and Companies → `ready` / `needs_fix` with quoted reasons |
| 3 | Sender | every 5 min, Mon–Fri 07–18 | one approved email per run; all guards; Gmail "Sent" check right before sending |
| 4 | Reply & bounce watcher | :02 :17 :32 :47 | two Gmail searches, then only threads with new mail; classifies, handles referrals and bounces |
| 5 | Follow-up drafts | Mon–Fri 07:15 | fu1/fu2 after 4 days, ≤ 50 words, same thread → back to QC + approval |
| 6 | Daily report | 18:00 | three Telegram messages: sent table, replies, day summary |
| 7 | Reply assistant (bot) | every 5 min + Telegram webhook | drafts an answer per reply; second bot with ✅ / ✏️ / 🔁 / ❌ |
| 8 | Gmail ↔ sheet sync | hourly at :38 | logs emails written by hand, closes what they replace, repairs stuck rows |

```
Contacts ─▶ [1] ─▶ email_status = valid
Messages ─▶ [2] ─▶ ready ─▶ ☑ approved ─▶ [3] ─▶ Gmail ─▶ Log + sheet (ids, thread, follow-up date)
Gmail ─▶ [4] ─▶ Replies row ─▶ [7] ─▶ card in bot 2 ─▶ ✅ ─▶ reply in their thread
                            └▶ [5] follow-ups ─▶ [2]
Gmail Sent ─▶ [8] ─▶ Messages (hand-written emails) · held rows released · stuck rows repaired
[3] sends · problems · [6] report · [0] errors ─▶ bot 1
```

## Guards (in code, re-checked on the live sheet every run)
- **Sender (3):** `DRY_RUN`, `SENDING_PAUSED`, `TEST_RECIPIENT`, send days and window, daily cap, minimum gap + jitter,
  no other row in `sending`, approved and unchanged since QC, verified (or explicitly allowed) address, active
  contact, never the same type or the same text twice to an address (Log is append-only), one person per company per
  day, colleagues on hold once someone at the company answered.
- **Gmail "Sent" check (3 and 7):** right before sending, one search `in:sent (to:x OR cc:x) after:<time>`. Any id the
  sheet does not know means the owner wrote by hand: the Sender puts the row on `held` (`manual_check: <ids>`), the
  reply bot closes the draft. If Gmail cannot be searched, nothing is sent that run.
- **Reply bot (7):** only the owner's chat id is obeyed; the card version must match the current text, so an old card
  cannot send; refuses if a later email to the same address is already in the sheet; the card states who receives
  the email (only that address, no CC) and whether it goes into the same Gmail conversation or as a new email.
- **Sync (8):** never runs next to a send (any row in `sending` for < 20 min skips the hour); ignores emails from the
  last 5 minutes (they may still be written by the Sender or the bot); only emails to known contacts are touched.

## What the sync (8) does with an email found in Gmail "Sent"

| Situation | Result |
|---|---|
| already in the sheet without Gmail ids (logged by hand, ±30 min) | ids added to that row |
| a row stuck in `sending` for this address | marked `sent` (the email did go out) |
| first email to this contact, a cold email is queued | the queued row becomes `sent` with the real text; the Sender never sends it |
| the contact replied before | new `Mxxx-Rn` row (`type reply`); open bot drafts it answers are closed and bot 2 is told |
| otherwise (a follow-up by hand) | the queued fu1/fu2 becomes `sent`, or a new follow-up row is added |
| not to a known contact (private email, test inbox) | ignored |

After the emails: rows held by the Gmail check are released once their email is in the sheet; rows stuck in
`sending` ≥ 20 min that are **not** in Gmail Sent go back to `ready` (`awaiting_ok` for bot drafts); queued emails of
contacts set to `do_not_contact` / `bounced` (or follow-ups of `replied` / `referred` / `refused`) are cancelled.

## Gmail API quota
Gmail limits quota units per user per minute. Sending and reading in the same minute caused a 403 on 12 Oct 2026, so:
the Sender fires on :x0/:x5, the reply watcher on :02/:17/:32/:47, the sync on :38. Thread reads are batched
(5 per second), sync reads 1 email per 400 ms, and every search returns ids only.

## Reply assistant (7) without a calendar
The owner's calendar is local, not Google. The drafter gets the usual hours from Config `AVAILABILITY`
(`1-5 09:00-17:00` = Monday to Friday) and `AVAILABILITY_NOTE`. It accepts a time the other person proposes inside
those hours (with "check your calendar" on the card), never invents slots, and leaves anything outside them as an
open question for the owner.

## Config keys added since the first version
| key | default | used by |
|---|---|---|
| `REPLY_DRAFTS_ENABLED`, `REPLY_DRAFTS_SINCE`, `REPLY_DRAFT_BATCH` | TRUE, last 2 days, 4 | 7 |
| `AVAILABILITY`, `AVAILABILITY_NOTE`, `MEETING_MINUTES` | `1-5 09:00-17:00`, empty, 30 | 7 |
| `INBOX_SEARCH`, `INBOX_SEARCH_DAYS` | TRUE, 3 | 4 |
| `SYNC_ENABLED`, `SYNC_FIRST_DAYS`, `SYNC_MAX_FETCH` | TRUE, 3, 40 | 8 |
| `LAST_RUN_DRAFTER`, `LAST_RUN_SYNC` | written automatically | 7, 8, report. **The rows must exist.** |

## Build, test, deploy
```bash
python3 build.py                     # → workflows/0…8_*.json (git-ignored: they contain real ids)
(cd tests && npm i) && node tests/e2e.test.js
```
Real n8n test (before any node or parameter change goes live):
```bash
node tests/mock_server.js &
MOCK_BASE=http://host.docker.internal:8787 MOCK_TG_CRED=mockTgCred000001 python3 build.py   # → tests/workflows_mock/
docker exec n8n-outreach-test n8n import:workflow --separate --input=/wf
tests/runwf.sh 3                     # 0…8 = the workflows, 9 = the reply-bot branch of 7
```
Re-importing replaces anything changed in the n8n UI; keep every change in `build.py` / `src/`.

## Decisions
- **HTTP + Code nodes** instead of the Gmail/Sheets nodes: exact control over MIME and threading headers, fewer
  node-version surprises on a server whose version can change.
- **Gemini Flash primary, Groq `gpt-oss-120b` fallback** on any error: free tiers, a different provider when one is
  overloaded. Model names live in Config.
- **Reply-To = the watched Gmail address**, so every answer lands where workflow 4 can see it.
- **Reuse:** ideas from n8n templates [#7175](https://n8n.io/workflows/7175) (follow-up stages, reply tracking) and
  [#15849](https://n8n.io/workflows/15849) (working-hours guard, daily limit). Not copied: they have no approval,
  dedupe or verification.
