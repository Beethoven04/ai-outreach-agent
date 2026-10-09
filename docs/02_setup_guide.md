# 2. Setup guide (about 45 minutes)

You need: the Gmail account you@gmail.com, your n8n login on https://your-n8n.example.com, Python 3 on your Mac.

## Step 1: Google Sheet
1. Log in to Google Drive **as you@gmail.com**. Upload `Outreach_Tracker.xlsx`, open it, then *File → Save as Google Sheets*.
2. Copy the sheet ID from the URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
3. Make tick-boxes: in **Messages** select column `approved` (J2:J) → *Insert → Checkbox*. Do the same in **Contacts** column `allow_risky` (S2:S).
4. Open **Profile** and fix fact **F05** (are you still at devUP?).

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
| `Outreach · Telegram bot` | Telegram API | Token from **@BotFather** (`/newbot`) |
| `Outreach · Gemini API key` | Header Auth | Name `Authorization`, Value `Bearer <key>` from https://aistudio.google.com/apikey |
| `Outreach · Groq API key` | Header Auth | Name `Authorization`, Value `Bearer <gsk_…>` from https://console.groq.com/keys |
| `Outreach · Hunter API key` | Query Auth | Name `api_key`, Value from https://hunter.io/api-keys (free: 50 credits/month) |
| `Outreach · Reoon API key` | Query Auth | Name `key`, Value from https://emailverifier.reoon.com (API section; free: 20/day + 100 one-time) |

After saving each credential, open it again and copy its **ID** from the browser URL (`…/credentials/<ID>`).

**Telegram chat ID:** send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates`. The number at `"chat":{"id": …}` is the chat ID.

## Step 4: Build the workflow files with your IDs
1. Edit `build_config.json`: `SHEET_ID`, `TELEGRAM_CHAT_ID`, and the 7 credential `id` values.
2. In Terminal: `cd ~/sweden/n8n && python3 build.py` → writes `workflows/0…6_*.json`.
   This links all 66 credential slots automatically, so you don't click through nodes.

## Step 5: Import into n8n
1. *Workflows → Create → ⋯ → Import from File* → `workflows/0_error_handler.json` → Save. Copy its ID from the URL (`/workflow/<ID>`).
2. Put that ID in `build_config.json` → `ERROR_WORKFLOW_ID`, run `python3 build.py` again.
3. Import `1_…` to `6_…` the same way, and save each. (If you re-import later, delete the old copies first.)
4. Open each workflow → *Settings*: Timezone should show Europe/Stockholm and Error workflow "Outreach 0 · Error handler".
5. Recommended after testing: *Settings → Save successful executions: Do not save*. Execution logs contain email text and are visible to the server owner.

**Do not activate anything yet.** Follow `03_test_plan.md`.

## What runs when (after activation)
| Workflow | Schedule (Stockholm) | Does |
|---|---|---|
| 0 Error handler | on any crash | Telegram alert + Log row |
| 1 Find & verify emails | every 30 min | Hunter finder → DNS MX → Reoon mailbox check; notifies not_found/risky with full info |
| 2 Quality check | every 15 min | Code rules + LLM rubric → `ready` / `needs_fix` + reasons |
| 3 Sender | every 5 min, Mon–Fri 07–18 (window from Config) | One approved email per run, all guards, plain text via Gmail API |
| 4 Reply & bounce watcher | every 15 min | Reads sent threads, classifies replies, cancels follow-ups, holds colleagues, Telegram |
| 5 Follow-up drafts | Mon–Fri 07:15 | Drafts fu1/fu2 (≤50 words) → QC → your approval |
| 6 Daily report | every day 18:00 | Everything that happened + problems + fixes |

## Free-tier limits (checked 7 Oct 2026; they change, so re-check on the linked pages)
- **Gemini** (primary QC model): free tier, roughly 1,000+ requests/day on Flash models. **Free-tier prompts may be used by Google to improve products**: your drafts and recipient names go to Google. Limits: https://aistudio.google.com/rate-limit
- **Groq** `openai/gpt-oss-120b` (fallback): 30 req/min, 1,000 req/day, 8,000 tokens/min. https://console.groq.com/settings/limits
- **Hunter**: 50 credits/month (finder: 1 credit per address found). About 30 of your 43 contacts need it.
- **Reoon**: 20 verifications/day + 100 one-time credits (checked 8 Oct 2026). If credits run out, verification waits until the next day; addresses are not marked risky.
- **Gmail**: about 500 recipients/day hard limit for consumer accounts. 15/day stays far below it; the real risk is spam complaints, not the limit.
