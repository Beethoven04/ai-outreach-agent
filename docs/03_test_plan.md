# 3. Test plan

## Automated (run before every change)
- **170 end-to-end checks** (`cd n8n && python3 build.py && node tests/e2e.test.js`) run every Code node of the built
  workflows against an anonymised sheet (`tests/sheet_fixture.demo.json`) with mocked APIs: finder and verifier, QC
  rules and LLM fallback, approval reset after edits, every Sender gate (weekend, window, gap, cap, pause,
  same-company, risky, duplicates, the Gmail "Sent" check), dry-run / test / live, Gmail errors, replies, auto-replies,
  referrals, bounces, follow-ups in thread, the reply bot (drafts, edits, diff, stale cards, ✅ guards, hand-answer
  check), the Gmail ↔ sheet sync (hand-written emails, stuck rows, released holds, idempotence), the three-message
  daily report and the error handler.
- **Real n8n 2.42.4** (Docker) with every API mocked (`tests/mock_server.js`): changed workflows are imported and
  executed end to end before they are deployed. See [`n8n/README.md`](../n8n/README.md#build-test-deploy).

What needs your real accounts: Google / Gmail / Telegram / Hunter / Reoon credentials and real LLM answers. Phases A–C
cover those.

## Phase A: Dry run (no email leaves)
Config: `DRY_RUN = TRUE`.
1. Execute **1 Find & verify** a few times. ✔ Contacts get `valid` / `risky` / `not_found`.
2. Execute **2 Quality check** until every draft has a status. ✔ Read `qc_reasons`; fix drafts (they are re-checked).
3. Tick `approved` on 3 rows. Set `WINDOW_START`/`WINDOW_END` around the current time and execute **3 Sender** 3 times.
   ✔ Bot 1 shows "DRY RUN (not sent)" with the full email. ✔ Rows get `dry_run_at`, status stays `ready`.
4. Execute **6 Daily report**. ✔ Three messages arrive together: sent table, replies, day summary.

## Phase B: Test sends to yourself
Config: `DRY_RUN = FALSE`, `TEST_RECIPIENT = <your test inbox>`.
1. Execute **3 Sender** 2–3 times. ✔ Emails arrive with subject `[TEST → real@address] …`, correct signature, not in
   spam. ✔ Rows get `test_sent_at`; nothing is marked `sent`.
2. **Full loop with a fake contact** (`C900`, your test inbox as `email`, `valid`, `active`; message `M900`, type `cold`):
   untick every other `approved`, clear `TEST_RECIPIENT`, execute **3** → `M900` `sent` with a thread id.
   - Reply from the test inbox "Sounds good, can we talk Tuesday?" → execute **4** → ✔ `M900` `replied`.
     Execute **7** → ✔ a card in bot 2 says who receives the answer and that it stays in the same conversation.
     Reply to the card "propose Thursday 14:00" → ✔ new card with the change. ✅ → ✔ the answer arrives **in the same thread**.
   - **Hand-written email:** answer the next test reply yourself in Gmail, then press ✅ on its card → ✔ "NOT SENT:
     you already wrote … by hand". Execute **8** → ✔ your email appears in Messages (`qc_model` "sent by hand").
   - A second fake contact without a reply: set its `followup_due` to yesterday → **5** → `M901-FU1` → QC → approve →
     **3** → ✔ arrives in the same thread.
   - Reply "please remove me from your list" → **4** → ✔ contact `do_not_contact`, pending follow-ups `cancelled`.
3. `SENDING_PAUSED = TRUE` → execute **3** → ✔ nothing sent. Set back to FALSE.

## Phase C: Live
1. Delete the test rows. Config: `DRY_RUN = FALSE`, `TEST_RECIPIENT` empty, `DAILY_CAP = 10` for the first 2 days.
2. Activate workflows 1–8 (0 runs by itself on errors). Check the reply-bot webhook (`getWebhookInfo`).
3. Day 1: bot 1 shows a message per send and the 18:00 report; bot 2 shows a card per reply.

## Stop rules (pause with `SENDING_PAUSED = TRUE`)
- Bounce rate above 5% of sent → check verification before continuing.
- More than one "spam / do not contact" complaint → review tone and targeting.
- Gmail shows a warning, CAPTCHA or "unusual activity" → pause 48 h, restart at 5/day.
- The QC model is retired or errors every run → change `LLM_PRIMARY_MODEL` in Config.
