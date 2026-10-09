# Outreach automation (n8n): validate → approve → send → track

| # | Deliverable | Where |
|---|---|---|
| 1 | Google Sheet schema + ready-to-upload tracker (43 contacts, 40 drafts imported) | `docs/01_sheet_schema.md`, `Outreach_Tracker.xlsx` |
| 2 | n8n workflows (importable JSON, 7 sub-workflows) | `workflows/0…6_*.json` (built by `build.py` from `src/` + `prompts/`) |
| 3 | LLM prompts: QC rubric, reply classifier, follow-up writer | `prompts/qc_system.md`, `prompts/reply_system.md`, `prompts/followup_system.md` |
| 4 | Setup guide (credentials, IDs, import) | `docs/02_setup_guide.md` |
| 5 | Test plan (dry run → test sends → live) | `docs/03_test_plan.md` |

## How it fits together
```
Contacts ─▶ [1 Find & verify] ─▶ email_status=valid
Messages ─▶ [2 QC: code rules + LLM rubric] ─▶ ready / needs_fix(+reasons)
             you tick ☑ approved
         ─▶ [3 Sender] guards: DRY_RUN · paused · Mon–Fri · 08:30–11:30 · 15/day · 5 min+jitter
                       · approved & unchanged since QC · valid email · active contact
                       · never same type/content twice (Log) · 1 person/company/day, next only if no reply
            ─▶ Gmail API, plain text, no tracking ─▶ Log + sheet (ids, thread, follow-up date)
Gmail threads ─▶ [4 Replies] human / auto-reply / bounce → LLM category → cancel follow-ups, hold colleagues, Telegram
               ─▶ [5 Follow-ups] after 4 days, ≤50 words, same thread → back to QC + approval (max 2)
[6 Daily report 18:00] · [0 Error handler] → Telegram
```

## Decisions and why
- **Sheet** = new Google Sheet on the Gmail account. Your tracker was Excel on a university SharePoint, which usually blocks n8n's OAuth app consent. One Google login now covers Sheets and Gmail.
- **Email finding**: public personal address (from your research) → Hunter Email Finder. Shared inboxes (`info@`, `hello@`…) are **never** used: the person is skipped and you get a Telegram notice with all the info.
- **Verification (3 layers)**: syntax + role-address check → DNS MX (Cloudflare DoH) → Reoon mailbox check. Only `safe` is `valid`. Catch-all is `risky` and needs your ☑ `allow_risky`. Invalid addresses are remembered and the next source is tried.
- **QC model**: hard rules are **code** (word counts, subject length, clichés, grades, free work, placeholders, signature leak, past dates, wrong or multiple names), so they can't be hallucinated. The LLM only judges the personal reason, the ask, and whether each claim matches your Profile facts / company research. Every finding must quote the text; quotes that don't exist are discarded.
  - Primary: **Gemini 3.5 Flash** (Google AI Studio free tier): strongest free model with generous limits. Trade-off: free-tier data may be used by Google.
  - Fallback: **Groq gpt-oss-120b** (free, Groq does not train on API data, but 8k tokens/min, so it's slower).
  - Rejected: Hugging Face (free = $0.10/month credits), OpenRouter free (50 req/day), Cerebras (trial only), Mistral free (requires opting in to training).
- **Reply-To + signature** = you@gmail.com. Replies to you@yourdomain.com would never reach the watched inbox, and reply/opt-out detection would break.
- **Plain HTTP + Code nodes** instead of the Gmail/Sheets nodes: exact control over MIME/threading headers, and fewer node-version incompatibilities on a server whose version I can't see.
- **Reuse**: patterns from n8n templates [#7175](https://n8n.io/workflows/7175) (follow-up stages, reply tracking) and [#15849](https://n8n.io/workflows/15849) (working-hours guard, daily-limit check, reply identifier) were adopted. The templates themselves were not copied: they have no approval, dedupe or verification, and duplicate one node chain per follow-up.

## Risks you should know
- **Friend's server**: the server owner can technically use your Gmail credential and read execution logs. Keep it only if you fully trust them. Turn off saving successful executions after testing.
- **devUP conflict**: CV says the job ended Sept 2026, portfolio says Present, drafts say "I'm an AI Engineer at devUP". Fix Profile F05 or the drafts, otherwise QC (correctly) fails them.
- **Stale dates**: drafts say "near Lund 16–28 October". QC fails any date that has passed; send early.
- **Deliverability**: 15/day, plain text, no tracking, one per company per day. Stop if bounces exceed 5% (the daily report shows it).

## Verification done
`node tests/e2e.test.js` → 63/63 checks. All 7 workflows were also imported and executed in a real **n8n 2.42.4** container against a mock of every API (`tests/mock_server.js`, `MOCK_BASE=… python3 build.py`, `tests/runwf.sh`).
