// ---- NODE: Build daily report ----
// @node report_build
// Three Telegram messages, sent together at the end of the day (HTML, already escaped here):
//   1) emails sent today as a table (time, company, receiver + address)
//   2) replies received today (who, company, verdict, short summary)
//   3) one summary message: mode, problems with a fix for each, pipeline, workflow health
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, L = T.Log, cfg = configOf(T.Config);
const n = now();
const today = d => { const x = parseDT(d); return x && x.hasSame(n, 'day'); };
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const nameOf = c => str(c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' '));
const hm = v => { const d = parseDT(v); return d ? d.toFormat('HH:mm') : '--:--'; };
const fit = (s, w) => { s = str(s).replace(/\s+/g, ' ').trim(); return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w); };
const e = tgEsc;
const out = [];
// split long lists over several messages (Telegram max 4096 chars), never inside a <pre> block; a table repeats its header row
function pack(head, blocks, tableHead) {
  const start = () => (tableHead ? [tableHead] : []);
  let cur = start();
  const render = xs => head + (tableHead ? `<pre>${xs.join('\n')}</pre>` : xs.join('\n\n'));
  for (const b of blocks) { if (render(cur.concat(b)).length > 3800 && cur.length > start().length) { out.push(render(cur)); cur = start(); } cur.push(b); }
  if (cur.length > start().length) out.push(render(cur));
}
const date = n.toFormat('ccc d LLL yyyy');

// ---------- 1) emails sent today ----------
const manual = new Set(L.rows.filter(r => str(r.event) === 'sent' && ['Sync', 'Manual'].includes(str(r.workflow))).map(r => str(r.msg_id)));
const KIND = { cold: '', fu1: 'follow-up', fu2: 'follow-up 2', reply: 'reply', intro: 'intro' };
const sentT = M.rows.filter(m => today(m.sent_at)).sort((a, b) => parseDT(a.sent_at) - parseDT(b.sent_at));
const cap = cfg.num('DAILY_CAP', 15);
const coldT = sentT.filter(m => (str(m.type) || 'cold') === 'cold' && !manual.has(str(m.msg_id))).length;
let head1 = `✉️ <b>EMAILS SENT TODAY · ${date}</b>\n${sentT.length} sent (${coldT} by the Sender, cap ${cap}/day)`;
if (!sentT.length) out.push(head1 + '\n\nNothing was sent today.');
else {
  const rows = sentT.map(m => {
    const c = contacts[str(m.contact_id)] || {};
    const tag = [KIND[str(m.type) || 'cold'], manual.has(str(m.msg_id)) ? 'by hand' : ''].filter(Boolean).join(', ');
    const who = nameOf(c) || str(m.first_name) || '?';
    return `${hm(m.sent_at)} ${e(fit(c.company || m.company || '?', 16))} ${e(who)}${tag ? ' (' + e(tag) + ')' : ''}\n${' '.repeat(23)}${e(str(m.to_email) || c.email)}`;
  });
  pack(head1 + '\n', rows, `Time  ${'Company'.padEnd(16)} Receiver\n${'─'.repeat(5)} ${'─'.repeat(16)} ${'─'.repeat(24)}`);
}
const testT = M.rows.filter(m => today(m.test_sent_at)), dryT = M.rows.filter(m => today(m.dry_run_at));
if (testT.length || dryT.length) out[out.length - 1] += `\n🧪 Not real sends: ${testT.length} test (to the test inbox), ${dryT.length} dry run.`;

// ---------- 2) replies today ----------
const VERDICT = { interested: '🟢 Positive', question: '🟡 Question', referral: '🔀 Referral', not_now: '🟠 Not now', refusal: '🔴 Rejection',
  do_not_contact: '⛔ Do not contact', auto_reply: '🤖 Auto-reply', bounce: '📛 Bounce', other: '⚪ Other', unclassified: '⚪ Unclassified' };
const repT = R.rows.filter(r => today(r.received_at)).sort((a, b) => parseDT(a.received_at) - parseDT(b.received_at));
const counts = {};
repT.forEach(r => { const k = VERDICT[str(r.category)] || '⚪ Other'; counts[k] = (counts[k] || 0) + 1; });
const head2 = `📩 <b>REPLIES TODAY · ${repT.length}</b>${repT.length ? '\n' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') : ''}\n\n`;
if (!repT.length) out.push(head2 + 'No replies today.');
else pack(head2, repT.map(r => {
  const c = contacts[str(r.contact_id)] || {};
  const who = str(r.from_name) || str(r.full_name) || nameOf(c) || '?';
  const summary = str(r.summary) || str(r.snippet).replace(/\s+/g, ' ').slice(0, 200);
  return `<b>${VERDICT[str(r.category)] || '⚪ Other'}</b> · ${e(r.company || c.company || '?')} · ${hm(r.received_at)}\n` +
    `${e(who)} &lt;${e(r.from_email)}&gt;\n${e(summary.slice(0, 300))}${str(r.msg_id) ? `\n<i>answer to ${e(r.msg_id)}</i>` : ''}`;
}));

// ---------- 3) summary: mode, problems, pipeline, health ----------
const lines = [];
const mode = cfg.bool('DRY_RUN', true) ? 'DRY RUN (nothing really sent)' : (cfg.str('TEST_RECIPIENT') ? `TEST (all mail goes to ${cfg.str('TEST_RECIPIENT')})` : 'LIVE');
lines.push(`📊 <b>DAY SUMMARY · ${date}</b> (${n.toFormat('HH:mm')} Stockholm)`);
lines.push(`Mode: ${e(mode)}${cfg.bool('SENDING_PAUSED') ? `\n⛔ SENDING PAUSED: ${e(cfg.str('PAUSE_REASON', 'no reason'))}` : ''}`);

const logT = L.rows.filter(r => today(r.ts) && ['error', 'warn'].includes(str(r.level)));
const FIX = {
  llm_unavailable: 'Both LLMs failed. Check API keys/credits in Google AI Studio & Groq; QC retries every 15 min.',
  gmail_blocked_paused: 'Gmail refused (quota/credential). Wait 24h or reconnect the Gmail credential, then SENDING_PAUSED=FALSE.',
  gmail_send_failed: 'Read the error on the row, fix the data, set status=ready.',
  hunter_quota: 'Hunter monthly credits used up. Add emails by hand or wait for the monthly reset.',
  email_not_found: 'Find the address on LinkedIn/company site, put it in "email", clear "email_status".',
  email_invalid: 'Address rejected; the finder tries the next source automatically.',
  email_risky: 'Catch-all / unverifiable domain. Tick allow_risky only if you are confident.',
  verify_retry: 'Verifier/DNS hiccup; retried automatically (3 tries).',
  thread_fetch_failed: 'Gmail read failed; check the Gmail credential.',
  followup_llm_failed: 'Follow-up generation failed; retried tomorrow.',
  qc_fail: 'Fix the draft using qc_reasons; it is re-checked automatically.',
  hunter_error: 'Hunter call failed (network/API); retried automatically next run.',
  reply_bounce: 'Address bounced; contact blocked. Find another address and add a new contact row if you want to retry.',
  reply_do_not_contact: 'Person asked not to be contacted. Never email again.',
  workflow_error: 'A workflow crashed: see the error message; fix and re-run.',
  manual_send_detected: 'You emailed this person by hand. The sync workflow logs that email and releases or closes the queued row by itself.',
  sync_fetch_failed: 'Gmail read failed during the sync; it retries next hour.',
  reply_draft_failed: 'The reply bot could not write a draft. Press 🔁 on its card or reply to the card with your own text.',
};
const groups = {};
logT.forEach(r => { const k = str(r.event); (groups[k] = groups[k] || []).push(r); });
const stuck = M.rows.filter(m => str(m.status) === 'sending' && (!parseDT(m.updated_at) || n.diff(parseDT(m.updated_at), 'minutes').minutes > 20));
const errs = M.rows.filter(m => str(m.status) === 'error');
const nProblems = Object.keys(groups).length + (stuck.length ? 1 : 0) + (errs.length ? 1 : 0);
lines.push(`\n🛠 <b>PROBLEMS TODAY</b>${nProblems ? '' : ': none'}`);
Object.entries(groups).sort((a, b) => b[1].length - a[1].length).forEach(([k, rs]) => {
  lines.push(`• ${e(k)} ×${rs.length}: ${e(str(rs[0].detail).slice(0, 160))}`);
  if (FIX[k]) lines.push(`   ✔ ${e(FIX[k])}`);
});
if (stuck.length) lines.push(`• ⚠️ Stuck in "sending": ${e(stuck.map(m => m.msg_id).join(', '))}\n   ✔ The sync workflow checks Gmail Sent and fixes it within the hour.`);
if (errs.length) lines.push(`• ❌ Messages in error: ${e(errs.map(m => `${m.msg_id}: ${str(m.error).slice(0, 100)}`).join(' | '))}`);

const sentAll = M.rows.filter(m => str(m.sent_at));
const coldSent = sentAll.filter(m => (str(m.type) || 'cold') === 'cold');
const answered = C.rows.filter(c => ['replied', 'referred', 'refused', 'do_not_contact'].includes(str(c.contact_status)));
const positive = R.rows.filter(r => ['interested', 'question', 'referral'].includes(str(r.category)));
const queue = M.rows.filter(m => str(m.status) === 'ready' && truthy(m.approved));
const hasChild = new Set(M.rows.map(m => str(m.parent_msg_id)).filter(Boolean));
const due2 = M.rows.filter(m => str(m.status) === 'sent' && !hasChild.has(str(m.msg_id)) && parseDT(m.followup_due) && parseDT(m.followup_due) <= n.plus({ days: 2 }).endOf('day'));
lines.push(`\n📈 <b>PIPELINE</b>`);
lines.push(`• Contacts: ${C.rows.length} · valid emails: ${C.rows.filter(c => str(c.email_status) === 'valid').length}`);
lines.push(`• Cold emails sent (all time): ${coldSent.length} · other emails sent: ${sentAll.length - coldSent.length}`);
lines.push(`• Answered: ${answered.length} (${coldSent.length ? Math.round(100 * answered.length / coldSent.length) : 0}%) · positive/questions/referrals: ${positive.length} · bounced: ${C.rows.filter(c => str(c.contact_status) === 'bounced').length}`);
lines.push(`• Approved queue: ${queue.length} → about ${Math.ceil(queue.length / cap)} sending day(s)`);
lines.push(`• Follow-ups due within 2 days: ${due2.length}`);

const hb = ['FINDER', 'VERIFY', 'QC', 'SENDER', 'REPLIES', 'FOLLOWUPS', 'DRAFTER', 'SYNC'].map(k => {
  const v = cfg.raw['LAST_RUN_' + k];
  return `${k.toLowerCase()} ${hm(v)}${parseDT(v) && !today(v) ? ' (not today)' : ''}`;
});
lines.push(`\n🩺 Last run: ${hb.join(' · ')}`);
lines.push(`<a href="${sheetUrl()}">Open the sheet</a>`);
const summary = lines.join('\n');
if (summary.length <= 4000) out.push(summary);
else chunk(summary, 3800).forEach(t => out.push(t)); // rare: very long problem list (plain lines, no open tags)
return out.map(html => ({ json: { html } }));
