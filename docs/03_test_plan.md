# 3. Test plan

## Already done (on my side, before delivery)
- **63 automated checks** (`node tests/e2e.test.js`) run every Code node of the built workflows against your real 40 drafts and 43 contacts: finder, verifier, QC, approval reset, sender gates (weekend, window, gap, cap, pause, same-company, risky), dry-run/test/live, Gmail errors, replies, auto-replies, bounces, follow-ups in thread, duplicate guard, report, error handler.
- **Real n8n 2.42.4** (Docker) with every API mocked: all 7 workflows imported and executed end-to-end (find → verify → QC with Gemini→Groq fallback → dry-run → test send → live send → reply + bounce → follow-up in same thread → daily report → error alert).

What could not be tested without your accounts: real Google/Gmail/Telegram/Hunter/Reoon credentials and the real LLM answers. Phases A–C below cover those.

## Phase A: Dry run (no email leaves)
Config: `DRY_RUN = TRUE`.
1. Open **1 Find & verify**, click *Execute workflow* 3–4 times (or activate it for a few hours).
   ✔ Contacts get `valid` / `risky` / `not_found`. ✔ Telegram shows a notice with full info for each skipped person.
2. Open **2 Quality check**, execute until all drafts have a status.
   ✔ Read `qc_reasons`. Expected real failures: M002 "Hi Anna", M005/M022/M036 written to two people, M038 only 75 words, and probably **every** draft on "AI Engineer at devUP" until Profile F05 is fixed.
3. Fix drafts in the sheet (they are re-checked automatically), then tick `approved` on 3 rows.
4. Temporarily set `WINDOW_START`/`WINDOW_END` to include the current time, then execute **3 Sender** 3 times.
   ✔ Telegram shows "DRY RUN (not sent)" with the full email + signature. ✔ Rows get `dry_run_at`, status stays `ready`. ✔ Gmail "Sent" is empty.
5. Execute **6 Daily report**. ✔ Report arrives on Telegram.

## Phase B: Test sends to yourself
Config: `DRY_RUN = FALSE`, `TEST_RECIPIENT = you@yourdomain.com`.
1. Execute **3 Sender** 2–3 times.
   ✔ Emails arrive at you@yourdomain.com with subject `[TEST → real@address] …`. ✔ Plain text, correct name/signature, not in spam. ✔ Rows get `test_sent_at`; nothing marked `sent`.
2. **Reply/follow-up/opt-out test with a fake contact:**
   - Add a Contacts row: `contact_id C900`, company `TEST`, first_name `Louai`, email `you@yourdomain.com`, email_status `valid`, contact_status `active`.
   - Add a Messages row: `M900`, contact `C900`, type `cold`, a valid 80–140-word body starting with "Hi Louai,". Wait for QC → `ready`, tick approved.
   - **Untick every other `approved`**, set `TEST_RECIPIENT` empty (this is live mode, but only M900 is approved). Execute **3 Sender** → M900 `sent`, thread ID filled.
   - Reply from you@yourdomain.com: "Sounds good, can we talk Tuesday?" → execute **4 Reply watcher** → ✔ M900 `replied`, Telegram "INTERESTED".
   - Repeat with a second fake contact, but don't reply. Set its `followup_due` to yesterday → execute **5 Follow-ups** → ✔ `M901-FU1` draft → QC → approve → **3 Sender** → ✔ arrives *in the same thread*.
   - Reply "please remove me from your list" → **4** → ✔ contact `do_not_contact`, pending follow-ups `cancelled`.
3. Put `SENDING_PAUSED = TRUE` → execute **3** → ✔ nothing sent. Set back to FALSE.

## Phase C: Live
1. Delete the TEST rows. Config: `DRY_RUN = FALSE`, `TEST_RECIPIENT` empty, `DAILY_CAP = 10` for the first 2 days, then 15.
2. Re-tick `approved` on the drafts you want sent.
3. **Activate** workflows 1, 2, 3, 4, 5, 6. (0 runs by itself on errors; no activation needed.)
4. Day 1: watch Telegram. You should get a ✅ per send, replies as they come, and the 18:00 report.

## Stop rules (pause with `SENDING_PAUSED = TRUE`)
- Bounce rate above 5% of sent → check email verification before continuing.
- Any "spam / do not contact" complaint beyond one → review tone/targeting.
- Gmail shows a warning, CAPTCHA or "unusual activity" → pause 48 h, then restart at 5/day.
- QC model retired / errors every run → change `LLM_PRIMARY_MODEL` in Config.

## Re-running my tests (optional)
```
cd ~/sweden/n8n && python3 build.py && node tests/e2e.test.js
```
