# Google service account (lets scripts read/write the tracker sheet)

The finder scripts on the Mac use a **service account**: a robot Google identity with access to exactly one sheet.
No OAuth pop-ups, no access to your Gmail or Drive.

1. Open https://console.cloud.google.com/ (log in as the sheet owner). Top bar → project picker → **New project** → name `ai-outreach-agent` → Create.
2. Left menu → **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **APIs & Services → Credentials → + Create credentials → Service account** → name `outreach-sheets` → Create and continue → skip roles → Done.
4. Click the new service account → tab **Keys → Add key → Create new key → JSON** → a `.json` file downloads.
5. Move it to `~/sweden/finder/service_account.json` (git-ignored).
6. Copy the service account's email (looks like `outreach-sheets@ai-outreach-agent.iam.gserviceaccount.com`).
   Open the tracker sheet → **Share** → paste that email → **Editor** → untick "Notify" → Share.
7. Test: `cd ~/sweden/finder && .venv/bin/python -m finder sheet-check` → prints tab names and row counts.

To revoke later: delete the key in step 4 or remove the share in step 6.
