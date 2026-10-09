// ---- NODE: Build daily report ----
// @node report_build
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, L = T.Log, cfg = configOf(T.Config);
const n = now();
const today = d => { const x = parseDT(d); return x && x.hasSame(n, 'day'); };
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const who = id => { const c = contacts[str(id)] || {}; return `${c.full_name || c.first_name || id} (${c.company || '?'})`; };
const hm = v => { const d = parseDT(v); return d ? d.toFormat('HH:mm') : '--:--'; };
const mode = cfg.bool('DRY_RUN', true) ? 'DRY RUN (nothing really sent)' : (cfg.str('TEST_RECIPIENT') ? `TEST (all mail → ${cfg.str('TEST_RECIPIENT')})` : 'LIVE');
const lines = [];
lines.push(`📊 DAILY OUTREACH REPORT — ${n.toFormat('ccc d LLL yyyy')} (${n.toFormat('HH:mm')} Stockholm)`);
lines.push(`Mode: ${mode}${cfg.bool('SENDING_PAUSED') ? `\n⛔ SENDING PAUSED: ${cfg.str('PAUSE_REASON', 'no reason')}` : ''}`);

// 1. sent today
const sentT = M.rows.filter(m => today(m.sent_at)).sort((a, b) => parseDT(a.sent_at) - parseDT(b.sent_at));
const testT = M.rows.filter(m => today(m.test_sent_at));
const dryT = M.rows.filter(m => today(m.dry_run_at));
lines.push(`\n✉️ SENT TODAY: ${sentT.length}/${cfg.num('DAILY_CAP', 15)}`);
sentT.forEach(m => lines.push(`• ${hm(m.sent_at)} ${m.type || 'cold'} → ${who(m.contact_id)} <${m.to_email}> "${m.subject}"`));
if (testT.length) { lines.push(`🧪 Test sends: ${testT.length}`); testT.forEach(m => lines.push(`• ${hm(m.test_sent_at)} ${m.msg_id} → ${who(m.contact_id)}`)); }
if (dryT.length) { lines.push(`🧪 Dry-run simulated: ${dryT.length}`); dryT.forEach(m => lines.push(`• ${hm(m.dry_run_at)} ${m.msg_id} → ${who(m.contact_id)} <${m.to_email}>`)); }

// 2. replies today
const repT = R.rows.filter(r => today(r.received_at));
lines.push(`\n📩 REPLIES TODAY: ${repT.length}`);
repT.forEach(r => lines.push(`• ${hm(r.received_at)} [${r.category}] ${r.full_name} (${r.company}): ${r.summary || str(r.snippet).slice(0, 120)}${r.next_step ? `\n   → ${r.next_step}` : ''}`));

// 3. action needed
const needApproval = M.rows.filter(m => str(m.status) === 'ready' && !truthy(m.approved));
const needFix = M.rows.filter(m => str(m.status) === 'needs_fix');
const notFound = C.rows.filter(c => str(c.email_status) === 'not_found');
const risky = C.rows.filter(c => str(c.email_status) === 'risky' && !truthy(c.allow_risky));
const stuck = M.rows.filter(m => str(m.status) === 'sending' && (!parseDT(m.updated_at) || n.diff(parseDT(m.updated_at), 'minutes').minutes > 15));
const errs = M.rows.filter(m => str(m.status) === 'error');
const held = M.rows.filter(m => str(m.status) === 'held');
lines.push(`\n🙋 NEEDS YOU`);
lines.push(`• Waiting for your approval: ${needApproval.length}${needApproval.length ? ' → ' + needApproval.slice(0, 15).map(m => m.msg_id).join(', ') : ''}`);
lines.push(`• Drafts that failed QC (needs_fix): ${needFix.length}`);
needFix.slice(0, 10).forEach(m => lines.push(`   – ${m.msg_id} ${who(m.contact_id)}: ${str(m.qc_reasons).split('\n')[0].slice(0, 160)}`));
lines.push(`• No verified email (skipped): ${notFound.length}${notFound.length ? ' → ' + notFound.slice(0, 15).map(c => `${c.full_name} (${c.company})`).join('; ') : ''}`);
lines.push(`• Risky emails waiting for allow_risky: ${risky.length}${risky.length ? ' → ' + risky.map(c => `${c.full_name} <${c.email}>`).join('; ') : ''}`);
if (held.length) lines.push(`• On hold (colleague replied): ${held.map(m => `${m.msg_id} ${who(m.contact_id)}`).join('; ')}`);
if (stuck.length) lines.push(`• ⚠️ STUCK in "sending" (sending blocked until fixed): ${stuck.map(m => m.msg_id).join(', ')} → check Gmail "Sent": if the email is there set status=sent, otherwise status=ready.`);
if (errs.length) lines.push(`• ❌ Messages in error: ${errs.map(m => `${m.msg_id}: ${str(m.error).slice(0, 120)}`).join(' | ')}`);

// 4. problems today + suggested solutions
const logT = L.rows.filter(r => today(r.ts) && ['error', 'warn'].includes(str(r.level)));
const FIX = {
  llm_unavailable: 'Both LLMs failed. Check API keys/credits in Google AI Studio & Groq; QC retries every 15 min.',
  gmail_blocked_paused: 'Gmail refused (quota/credential). Wait 24h or reconnect Gmail credential, then SENDING_PAUSED=FALSE.',
  gmail_send_failed: 'Read the error on the row, fix data, set status=ready.',
  hunter_quota: 'Hunter monthly credits used up. Add emails manually or wait for monthly reset.',
  email_not_found: 'Find address on LinkedIn/company site, put in "email", clear "email_status".',
  email_invalid: 'Address rejected; finder tries next source automatically.',
  email_risky: 'Catch-all / unverifiable domain. Tick allow_risky only if you are confident.',
  verify_retry: 'Verifier/DNS hiccup; retried automatically (3 tries).',
  thread_fetch_failed: 'Gmail read failed; check Gmail credential.',
  followup_llm_failed: 'Follow-up generation failed; retried tomorrow.',
  qc_fail: 'Fix the draft using qc_reasons, it is re-checked automatically.',
  hunter_error: 'Hunter call failed (network/API); retried automatically next run.',
  reply_bounce: 'Address bounced; contact blocked. Find another address and add a new contact row if you want to retry.',
  reply_do_not_contact: 'Person asked not to be contacted. Never email again.',
    workflow_error: 'A workflow crashed: see the error message; fix and re-run.',
};
const groups = {};
logT.forEach(r => { const k = str(r.event); (groups[k] = groups[k] || []).push(r); });
lines.push(`\n🛠 PROBLEMS TODAY: ${logT.length ? '' : 'none'}`);
Object.entries(groups).sort((a, b) => b[1].length - a[1].length).forEach(([k, rs]) => {
  lines.push(`• ${k} ×${rs.length}: ${str(rs[0].detail).slice(0, 160)}`);
  if (FIX[k]) lines.push(`   ✔ Fix: ${FIX[k]}`);
});

// 5. pipeline + outlook
const sentAll = M.rows.filter(m => str(m.sent_at));
const coldSent = sentAll.filter(m => (str(m.type) || 'cold') === 'cold');
const repliedContacts = C.rows.filter(c => ['replied', 'referred', 'refused', 'do_not_contact'].includes(str(c.contact_status)));
const interested = R.rows.filter(r => ['interested', 'question', 'referral'].includes(str(r.category)));
const queue = M.rows.filter(m => str(m.status) === 'ready' && truthy(m.approved));
const hasChild = new Set(M.rows.map(m => str(m.parent_msg_id)).filter(Boolean));
const due2 = M.rows.filter(m => str(m.status) === 'sent' && !hasChild.has(str(m.msg_id)) && parseDT(m.followup_due) && parseDT(m.followup_due) <= n.plus({ days: 2 }).endOf('day'));
lines.push(`\n📈 PIPELINE`);
lines.push(`• Contacts: ${C.rows.length} | valid emails: ${C.rows.filter(c => str(c.email_status) === 'valid').length}`);
lines.push(`• Cold emails sent (all time): ${coldSent.length} | follow-ups sent: ${sentAll.length - coldSent.length}`);
lines.push(`• Answered: ${repliedContacts.length} (${coldSent.length ? Math.round(100 * repliedContacts.length / coldSent.length) : 0}%) | positive/questions/referrals: ${interested.length} | bounced: ${C.rows.filter(c => str(c.contact_status) === 'bounced').length} | do_not_contact: ${C.rows.filter(c => str(c.contact_status) === 'do_not_contact').length}`);
lines.push(`• Approved queue: ${queue.length} → ~${Math.ceil(queue.length / cfg.num('DAILY_CAP', 15))} sending day(s)`);
lines.push(`• Follow-ups due within 2 days: ${due2.length}`);

// 6. health
const hb = ['FINDER', 'VERIFY', 'QC', 'SENDER', 'REPLIES', 'FOLLOWUPS'].map(k => `${k.toLowerCase()} ${hm(cfg.str('LAST_RUN_' + k))}${parseDT(cfg.str('LAST_RUN_' + k)) && !today(cfg.str('LAST_RUN_' + k)) ? ' (not today)' : ''}`);
lines.push(`\n🩺 Last activity: ${hb.join(' · ')}`);
lines.push(`Sheet: ${sheetUrl()}`);
const text = lines.join('\n');
return chunk(text).map(t => ({ json: { text: t, full: text } }));
