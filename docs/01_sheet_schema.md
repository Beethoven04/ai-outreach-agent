# 1. Google Sheet schema

One Google Sheet is the database for every workflow and for the Python finder.

**Rule: never rename tabs or header cells.** Columns may be reordered and new columns added at the end; the workflows
find columns by header name and stop with a clear Telegram error if one is missing.

Tabs: **README · Config · Contacts · Messages · Replies · Log · Profile · Companies**

## Config (key | value | notes): every switch, no redeploy needed

| key | default | meaning |
|---|---|---|
| DRY_RUN | TRUE | Full run, nothing sent. Rows get `dry_run_at`. |
| TEST_RECIPIENT | your test inbox | If filled **and** DRY_RUN=FALSE, every email goes there with subject `[TEST → real address]`. Empty = live. |
| SENDING_PAUSED / PAUSE_REASON | FALSE | Emergency stop. Set automatically on Gmail quota or credential errors. |
| DAILY_CAP | 15 | Emails per day (cold + follow-ups). |
| SEND_DAYS | 1,2,3,4,5 | Mon–Fri. |
| WINDOW_START / WINDOW_END | 08:30 / 11:30 | Europe/Stockholm (Sweden and Denmark share this clock). |
| MIN_GAP_MINUTES / JITTER_SECONDS | 5 / 60 | Gap between emails plus a random 0–60 s. |
| SAME_COMPANY_GAP_DAYS | 1 | Next person at a company only after this, and only if nobody there answered. |
| FOLLOWUPS_ENABLED / FOLLOWUP_DAYS / MAX_FOLLOWUPS | TRUE / 4 / 2 | |
| NOTIFY_EACH_SEND | TRUE | Telegram (bot 1) message per send. |
| FROM_NAME / FROM_EMAIL / REPLY_TO / SIGNATURE | | Sender identity. `SIGNATURE` uses `\n` for new lines and is appended automatically. |
| LLM_PRIMARY_MODEL / LLM_FALLBACK_MODEL | gemini-3.5-flash / openai/gpt-oss-120b | Change here if a model is retired. |
| QC_BATCH, FINDER_BATCH, VERIFY_BATCH, FOLLOWUP_BATCH, REPLY_WATCH_DAYS | 6, 5, 5, 10, 60 | Throughput limits (stay inside free tiers). |
| INBOX_SEARCH / INBOX_SEARCH_DAYS | TRUE / 3 | Reply watcher also searches the inbox for replies outside our threads. |
| REPLY_DRAFTS_ENABLED / REPLY_DRAFTS_SINCE / REPLY_DRAFT_BATCH | TRUE / go-live time / 4 | Reply assistant: only replies received after `REPLY_DRAFTS_SINCE` get a draft. |
| AVAILABILITY / AVAILABILITY_NOTE / MEETING_MINUTES | `1-5 09:00-17:00` / free text / 30 | Usual free hours (weekday range, then hours) and where you can meet. No calendar is read. |
| SYNC_ENABLED / SYNC_FIRST_DAYS / SYNC_MAX_FETCH | TRUE / 3 / 40 | Gmail ↔ sheet sync: on/off, look-back on the very first run, emails read per run. |
| LAST_RUN_* | automatic | Heartbeats (FINDER, VERIFY, QC, SENDER, REPLIES, FOLLOWUPS, DRAFTER, SYNC) shown in the daily report. **Do not delete these rows.** |

Date values (`REPLY_DRAFTS_SINCE`, `LAST_RUN_*`) may be stored by Sheets as date serial numbers; the workflows read both.

## Contacts: one row per person (never one email for two people)
`contact_id, company_no, company, company_domain, first_name, last_name, full_name, role, country, linkedin_url, public_emails, email, email_source, email_status, email_detail, email_tried, email_attempts, email_checked_at, allow_risky ☑, contact_status, notes`

- `email_status`: *(empty = to find)* → `to_verify` → `valid` | `risky` | `not_found`. Rejected addresses are cleared,
  remembered in `email_tried`, and the next source is tried.
- `allow_risky` ☑: only for a catch-all / unverifiable address you accept.
- `contact_status`: `active | replied | referred | refused | do_not_contact | bounced`. Only `active` people get cold
  emails. Changing it by hand is fine: the hourly sync cancels queued emails that must no longer go out.
- To give an address yourself: type it in `email` and clear `email_status`; it is verified automatically.

## Messages: one row per email
`msg_id, contact_id, company, first_name, type, parent_msg_id, subject, body, status, approved ☑, qc_score, qc_reasons, qc_model, qc_hash, qc_at, to_email, dry_run_at, test_sent_at, sent_at, gmail_message_id, gmail_thread_id, rfc_message_id, followup_due, reply_at, error, updated_at, reply_id`

- `type`: `cold`, `fu1`, `fu2`, `reply` (answer in the same thread), `intro` (new email to a referred person).
- Ids: `M123` cold, `M123-FU1` follow-up, `M123-R1` reply, `M123-I1` intro, `M123-H1` other email written by hand.
  Ids ≥ `M900` are tests.
- `body` = greeting + text only (no signature).
- `status`:
  - cold / follow-ups: `draft → needs_fix | ready → sending → sent → replied | bounced`, plus `held` (colleague replied,
    or `manual_check:` = Gmail Sent had an email the sheet did not know; the sync releases it), `cancelled`, `error`.
  - reply / intro (reply bot): `awaiting_ok → sending → sent`, or `skipped` (❌, or answered by hand), `draft_failed`.
- `approved` ☑: nothing cold or follow-up is sent without it. Editing subject/body after QC clears it and re-runs QC.
- `qc_model` ends in `sent by hand` for emails the sync found in Gmail Sent.

## Replies (automatic, written by workflow 4)
`reply_id, received_at, msg_id, contact_id, full_name, company, from_email, kind (human | auto_reply | bounce), category, summary, next_step, snippet, thread_link, action_taken, thread_id, from_name, rfc_message_id, references, subject, text, referral_name, referral_email, draft_msg_id`

`category`: `interested | question | referral | not_now | refusal | do_not_contact | auto_reply | bounce | other`.
`draft_msg_id` = the reply bot's draft(s) for this reply, or `skip: …` with the reason.

## Log (automatic, append-only)
`ts, workflow, level (info | warn | error), event, msg_id, contact_id, detail`. Source of truth for "already sent"
(event `sent`, written by the Sender, the reply bot and the sync). Workflow `Sync` / `Manual` = written by hand.

## Profile (the only facts the QC and the reply bot accept)
`fact_id, fact, source, confirmed`. A new fact must be added here before any email uses it.

## Companies (research, read-only for the workflows)
The QC uses "What they do / Why you fit / Notes" to check claims about each company.
