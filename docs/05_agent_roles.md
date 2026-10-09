# Agent roles

The project is operated together with an AI coding agent (Claude Code). Instead of one long prompt, the agent works
through **role files**: each has one mission, its inputs/outputs and its don'ts. All roles share one context file
(facts about the sender, hard rules, where things live, current state). The real files are private (they hold
personal facts). This is their shape.

| Role | Mission | Writes to |
|---|---|---|
| Contact researcher | Find the right person per organisation and a published or verified address | Contacts, Companies |
| Email writer | Cold emails, referral emails, follow-ups, thank-yous in an approved structure; every claim must exist in the Profile tab | Messages (status `draft`) |
| Inbox triage | Classify replies (interested, referral, refusal, auto-reply, bounce), log referrals as new contacts | Replies, Contacts |
| Pipeline operator | Config switches, approvals, manual sends when the server is down, sheet hygiene | Config, Messages, Log |
| n8n engineer | Change workflows only through `src/` + `prompts/` → `build.py` → tests | `n8n/` |

**Shared hard rules** (excerpt): no invented facts or metrics; never mention pay or grades; English only; never use
shared inboxes; never guess an address without marking it unverified; anything outward-facing needs the owner's OK.

**Session hygiene:** read the context file and exactly one role file at the start; re-read the live sheet (never
trust remembered numbers); update the dated "State" section at the end.
