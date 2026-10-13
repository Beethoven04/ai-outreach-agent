# 2. Setup guide (about 45 minutes)

You need: a Gmail account for sending (you@gmail.com), an n8n instance reachable from the internet (the reply bot uses a Telegram webhook), Python 3 and Node 18+ locally.

## Step 1: Google Sheet
1. Create a Google Sheet **as you@gmail.com** with the tabs and header rows from [`01_sheet_schema.md`](01_sheet_schema.md) (Config needs every `LAST_RUN_*` row).
2. Copy the sheet ID from the URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
3. Make tick-boxes: **Messages** column `approved` and **Contacts** column `allow_risky` → *Insert → Checkbox*.
4. Fill **Profile** with true facts about yourself: the QC rejects any claim that is not there.

## Step 2: Google Cloud OAuth (for Gmail + Sheets)
1. https://console.cloud.google.com → create project `outreach-n8n`.
2. *APIs & Services → Library*: enable **Gmail API** and **Google Sheets API**.
3. *OAuth consent screen*: External, app name "Outreach n8n", your Gmail as support email.
   **Then click "Publish app" (status "In production").** In "Testing" mode Google expires the login every 7 days and the workflow silently stops. An unverified app is fine for your own account: at login, click *Advanced → Go to app (unsafe)*.
4. *Credentials → Create credentials → OAuth client ID → Web application*.
   Authorized redirect URI: copy it from the n8n credential window in step 3 (it looks like `https://your-n8n.example.com/rest/oauth2-credential/callback`).

## Step 3: Credentials in n8n (use exactly these names)
n8n → *Overview → Credentials → Create*.

| Name | n8n type | What to enter |
|---|---|---|
| `Outreach · Google Sheets` | Google Sheets OAuth2 API | Client ID + secret from step 2 → *Sign in with Google* (you@gmail.com) |
| `Outreach · Gmail` | Gmail OAuth2 API | Same client ID + secret → sign in |
| `Outreach · Telegram bot` | Telegram API | Bot 1 (operations): token from **@BotFather** (`/newbot`) |
| `Outreach · Reply bot` | Telegram API | Bot 2 (reply drafts with buttons): a **second** bot from @BotFather |
| `Outreach · Gemini API key` | Header Auth | Name `Authorization`, Value `Bearer <key>` from https://aistudio.google.com/apikey |
| `Outreach · Groq API key` | Header Auth | Name `Authorization`, Value `Bearer <gsk_…>` from https://console.groq.com/keys |
| `Outreach · Hunter API key` | Query Auth | Name `api_key`, Value from https://hunter.io/api-keys (free: 50 credits/month) |
| `Outreach · Reoon API key` | Query Auth | Name `key`, Value from https://emailverifier.reoon.com (API section; free: 20/day + 100 one-time) |

After saving each credential, open it again and copy its **ID** from the browser URL (`…/credentials/<ID>`).

**Telegram chat ID:** send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates`. The number at `"chat":{"id": …}` is the chat ID.

## Step 4: Build the workflow files with your IDs
1. `cp build_config.example.json build_config.json`, then fill in `SHEET_ID`, `TELEGRAM_CHAT_ID`, the 8 credential `id`
   values and `OWNER` (your sending address, other addresses, a regex that catches your contact details in a body).
2. `cd n8n && python3 build.py` → writes `workflows/0…8_*.json` with every credential slot linked, so you don't click
   through nodes.

## Step 5: Import into n8n
1. *Workflows → Create → ⋯ → Import from File* → `workflows/0_error_handler.json` → Save. Copy its ID from the URL (`/workflow/<ID>`).
2. Put that ID in `build_config.json` → `ERROR_WORKFLOW_ID`, run `python3 build.py` again.
3. Import `1_…` to `8_…` the same way, and save each. (If you re-import later, delete the old copies first.)
4. Open each workflow → *Settings*: Timezone should show Europe/Stockholm and Error workflow "Outreach 0 · Error handler".
5. Recommended after testing: *Settings → Save successful executions: Do not save*. Execution logs contain email text.
6. After activating workflow 7, check `https://api.telegram.org/bot<REPLY_BOT_TOKEN>/getWebhookInfo`: the URL must point
   at your n8n. (If a credential reference has no id, n8n may silently pick another Telegram credential.)

**Do not activate anything yet.** Follow `03_test_plan.md`.

## What runs when (after activation)
| Workflow | Schedule (Stockholm) | Does |
|---|---|---|
| 0 Error handler | on any crash | Telegram alert + Log row |
| 1 Find & verify emails | every 30 min | Hunter finder → DNS MX → Reoon mailbox check |
| 2 Quality check | every 15 min | Code rules + LLM rubric → `ready` / `needs_fix` + reasons |
| 3 Sender | every 5 min, Mon–Fri 07–18 (window from Config) | One approved email per run, all guards, Gmail "Sent" check first |
| 4 Reply & bounce watcher | :02 :17 :32 :47 | Classifies replies, cancels follow-ups, holds colleagues, logs referrals |
| 5 Follow-up drafts | Mon–Fri 07:15 | Drafts fu1/fu2 (≤50 words) → QC → your approval |
| 6 Daily report | every day 18:00 | Three messages: sent table, replies, day summary |
| 7 Reply assistant | every 5 min + Telegram webhook | Draft answer per reply → card in bot 2 → ✅ sends in the same thread |
| 8 Gmail ↔ sheet sync | hourly at :38 | Logs emails you wrote by hand, closes what they replace, repairs stuck rows |

## Free-tier limits (checked 7 Oct 2026; they change, so re-check on the linked pages)
- **Gemini** (primary QC model): free tier, roughly 1,000+ requests/day on Flash models. **Free-tier prompts may be used by Google to improve products**: your drafts and recipient names go to Google. Limits: https://aistudio.google.com/rate-limit
- **Groq** `openai/gpt-oss-120b` (fallback): 30 req/min, 1,000 req/day, 8,000 tokens/min. https://console.groq.com/settings/limits
- **Hunter**: 50 credits/month (finder: 1 credit per address found).
- **Reoon**: 20 verifications/day + 100 one-time credits (checked 8 Oct 2026). If credits run out, verification waits until the next day; addresses are not marked risky.
- **Gmail**: about 500 recipients/day for consumer accounts; 15/day stays far below it, the real risk is spam complaints. The API also limits quota units per user per minute: that is why each Gmail-reading workflow has its own minute.
