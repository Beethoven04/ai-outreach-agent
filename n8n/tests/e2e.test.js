// End-to-end scenario test: node tests/e2e.test.js
const assert = require('assert');
const { run, Sheet, setNow, J } = require('./harness');
const sheet = new Sheet(require('./sheet_fixture.demo.json'));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✔', msg); };
const tail = (out) => { const d = out[0].json; if (d.data && d.data.length) sheet.batchUpdate(d.data); if (d.logs && d.logs.length) sheet.append('Log', d.logs); if (d.appendReplies && d.appendReplies.length) sheet.append('Replies', d.appendReplies); if (d.appendMessages && d.appendMessages.length) sheet.append('Messages', d.appendMessages); if (d.appendContacts && d.appendContacts.length) sheet.append('Contacts', d.appendContacts); return d; };
const msg = id => sheet.rows('Messages').find(m => m.msg_id === id);
const con = id => sheet.rows('Contacts').find(c => c.contact_id === id);
const llmResp = obj => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

(async () => {
  setNow('2026-10-07T20:00:00');
  // ================= WF1 FINDER =================
  console.log('\nWF1 finder/verify');
  sheet.cfg('FINDER_BATCH', 50); sheet.cfg('VERIFY_BATCH', 50);
  let read = [{ json: sheet.batchGet(['Config', 'Contacts']) }];
  let picks = await run('1', 'Pick contacts to find', read, { nodes: { 'Read Sheet (finder)': read } });
  ok(picks.length === 43, `finder picks all 43 contacts (got ${picks.length})`);
  const direct = picks.filter(p => !p.json.needHunter), hunt = picks.filter(p => p.json.needHunter);
  const byName = n => picks.find(p => p.json.contact.first_name === n).json;
  ok(byName('Maja').candidate === 'maja@emberstudio.ai' && !byName('Maja').needHunter, 'public personal email used (Maja @ Ember Studio)');
  ok(byName('Nils').candidate === '' && byName('Nils').needHunter, 'shared inbox hello@pinestudio.ai NOT used, Hunter instead');
  ok(byName('Arvid').needHunter === false && byName('Arvid').candidate === 'arvid@meridiaanalytics2.dk' && byName('Arvid').source === 'pattern', 'no last name → no Hunter, format guess first@domain (must be confirmed)');
  ok(byName('Jonas').candidate === '' && !byName('Jonas').needHunter, 'no domain → nothing to try');
  ok(byName('Liv').candidate === 'liv@arborsystems2.dk', 'first-name-only personal address accepted');
  // Hunter mocks: found for some, nothing for others, quota error for one
  const hunterOut = hunt.map((p, i) => {
    const c = p.json.contact;
    if (c.first_name === 'Joaquín') return { json: { data: { email: 'joaquin@nimbuslabs.io', score: 91, verification: { status: 'valid' }, sources: [1, 2] } } };
    if (c.first_name === 'Mikael') return { json: { data: { email: 'mikael@polarai.com', score: 88, verification: { status: 'accept_all' } } } };
    if (c.first_name === 'Sara') return { json: { error: { message: '429 - usage limit reached' } } };
    if (i % 2) return { json: { data: { email: null } } };
    return { json: { data: { email: `${c.first_name.toLowerCase()}@${c.company_domain}`, score: 70, verification: { status: 'valid' } } } };
  });
  let d = tail(await run('1', 'Finder decide (hunter)', hunterOut, { nodes: { 'Read Sheet (finder)': read, 'Pick contacts to find': picks }, pair: { 'Pick contacts to find': i => hunt[i] } }));
  ok(d.notices.some(n => /Hunter quota/.test(n)), 'Hunter quota → Telegram warning');
  d = tail(await run('1', 'Finder decide (direct)', direct, { nodes: { 'Read Sheet (finder)': read } }));
  ok(con('C012').email_status === 'not_found' && d.notices.some(n => /Jonas/.test(n) && /missing company_domain/.test(n)), 'Jonas → not_found + notice with full info');
  ok(con('C038').email === 'arvid@meridiaanalytics2.dk' && con('C038').email_source === 'pattern', 'Arvid guess queued for mailbox check');
  ok(con('C001').email === 'joaquin@nimbuslabs.io' && con('C001').email_status === 'to_verify', 'Joaquín email → to_verify');
  ok(con('C011').email_status === '', 'Sara (quota) left for retry');

  // verify
  read = [{ json: sheet.batchGet(['Config', 'Contacts']) }];
  const vp = await run('1', 'Pick emails to verify', read, { nodes: { 'Read Sheet (verify)': read } });
  ok(vp.length > 5, `verify picks ${vp.length} to_verify emails`);
  const dns = vp.map(p => p.json.domain === 'polarai.com' ? { json: { Status: 3 } } : { json: { Status: 0, Answer: [{ type: 15, data: '10 aspmx.l.google.com.' }] } });
  const mx = await run('1', 'MX evaluate', dns, { nodes: { 'Pick emails to verify': vp } });
  const preOk = mx.filter(m => m.json.pre_ok), preBad = mx.filter(m => !m.json.pre_ok);
  ok(preBad.some(m => m.json.email === 'mikael@polarai.com'), 'NXDOMAIN → fails precheck');
  const sf = await run('1', 'MX evaluate', [{ json: { Status: 2 } }], { nodes: { 'Pick emails to verify': vp }, pair: { 'Pick emails to verify': () => vp[0] } });
  ok(sf[0].json.dns_error && !sf[0].json.pre_ok, 'DNS SERVFAIL → retry, not invalid');
  const reoon = preOk.map(m => {
    if (m.json.email === 'joaquin@nimbuslabs.io') return { json: { status: 'safe', overall_score: 98, is_deliverable: true } };
    if (m.json.email === 'maja@emberstudio.ai') return { json: { status: 'catch_all', overall_score: 60 } };
    if (m.json.email.startsWith('liv')) return { json: { status: 'invalid' } };
    if (m.json.email === 'arvid@meridiaanalytics2.dk') return { json: { status: 'catch_all', overall_score: 50 } };
    return { json: { status: 'safe', overall_score: 95, is_deliverable: true } };
  });
  // Reoon out of credits for one address -> Hunter verifier fallback
  const rIdx = preOk.findIndex(m => m.json.email === 'joaquin@nimbuslabs.io');
  reoon[rIdx] = { json: { error: { message: '402 - insufficient credits' } } };
  const rc = await run('1', 'Reoon check', reoon, { nodes: { 'MX evaluate': mx }, pair: { 'MX evaluate': i => preOk[i] } });
  ok(rc[rIdx].json.reoon_out_of_credits && !rc[rIdx].json.reoon_ok, 'Reoon out of credits detected');
  const odd = await run('1', 'Reoon check', [{ json: { status: 'error', reason: 'daily limit' } }], { nodes: { 'MX evaluate': mx }, pair: { 'MX evaluate': () => preOk[0] } });
  ok(!odd[0].json.reoon_ok, 'Reoon 200 + status "error" → not treated as invalid, goes to Hunter');
  const rOk = rc.filter(x => x.json.reoon_ok), rNo = rc.filter(x => !x.json.reoon_ok);
  d = tail(await run('1', 'Verify decide (reoon)', rOk, { nodes: { 'Read Sheet (verify)': read } }));
  tail(await run('1', 'Verify decide (hunter)', rNo.map(() => ({ json: { data: { status: 'valid', score: 96 } } })), { nodes: { 'Read Sheet (verify)': read, 'Reoon check': rc }, pair: { 'Reoon check': i => rNo[i] } }));
  ok(/hunter-verify: valid/.test(con('C001').email_detail), 'Hunter verifier used as fallback');
  ok(con('C001').email_status === 'valid', 'Joaquín → valid');
  ok(con('C009').email_status === 'risky' && d.notices.some(n => /RISKY/.test(n) && /Maja/.test(n)), 'catch-all → risky + notice');
  ok(con('C038').email_status === '' && /pattern_stop/.test(con('C038').email_tried) && !d.notices.some(n => /RISKY/.test(n) && /Arvid/.test(n)), 'format guess on catch-all domain → rejected, not risky, guessing stopped');
  ok(con('C033').email_status === '' && /liv/.test(con('C033').email_tried), 'invalid → cleared + remembered in email_tried (finder retries next source)');
  tail(await run('1', 'Verify decide (precheck)', preBad, { nodes: { 'Read Sheet (verify)': read } }));
  ok(con('C002').email_status === '' && /mikael@polarai.com/.test(con('C002').email_tried), 'NXDOMAIN email rejected');
  // next finder run: Liv has no more sources → not_found
  read = [{ json: sheet.batchGet(['Config', 'Contacts']) }];
  picks = await run('1', 'Pick contacts to find', read, { nodes: { 'Read Sheet (finder)': read } });
  const b = picks.find(p => p.json.contact.first_name === 'Liv');
  ok(b && !b.json.candidate && !b.json.needHunter, 'Liv: no repeat of rejected address');
  const dario = picks.find(p => p.json.contact.contact_id === 'C001');
  ok(!dario, 'valid contacts not re-picked');
  ok(!picks.some(p => p.json.contact.email_status === 'not_found' && p.json.source !== 'pattern'), 'not_found only retried with a new format guess (no notice spam)');

  // ================= WF2 QC =================
  console.log('\nWF2 QC');
  sheet.cfg('QC_BATCH', 100);
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  let sel = await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } });
  ok(sel.length === 40, `all 40 drafts selected for QC (got ${sel.length})`);
  const det = id => sel.find(s => s.json.msg.msg_id === id).json.det;
  ok(det('M002').fails.some(f => /Anna/.test(f)), 'M002 "Hi Anna" to Mikael → deterministic fail');
  ok(det('M005').fails.some(f => /several people/.test(f)), 'M005 two founders in one email → fail');
  ok(det('M001').fails.length === 0, `M001 passes deterministic rules (got: ${det('M001').fails.join(' | ')})`);
  console.log('    word counts:', sel.map(s => s.json.det.stats.words).join(','));
  ok(sel[0].json.req_primary.messages[1].content.includes('F05'), 'LLM payload contains profile facts');
  ok(sel[0].json.req_primary.messages[1].content.includes('Conversational AI agents'), 'LLM payload contains company research');
  // primary LLM: M001 flagged on devUP tense (realistic), others pass; M010 primary fails -> fallback
  const prim = sel.map(s => {
    const id = s.json.msg.msg_id;
    if (id === 'M010') return { json: { error: { message: '503 overloaded' } } };
    if (id === 'M001') return { json: llmResp({ claims: [{ quote: 'an AI Engineer at devUP', about: 'sender', supported: false, fact_ids: ['F05'], note: 'CV says job ended Sept 2026' }, { quote: 'I am a wizard', about: 'sender', supported: false }], personal_reason: { present: true, quote: "Nimbus Labs's agents are close to what I build.", specific: true }, ask: { count: 1 }, recipient_ok: true, tone_ok: true, mentions_grades: false, offers_free_or_low_pay: false, issues: [], score: 70, verdict: 'fail' }) };
    return { json: llmResp({ claims: [], personal_reason: { present: true, specific: true }, ask: { count: 1 }, recipient_ok: true, tone_ok: true, mentions_grades: false, offers_free_or_low_pay: false, issues: [], score: 92, verdict: 'pass' }) };
  });
  const chk = await run('2', 'Check primary LLM', prim, { nodes: { 'Select drafts for QC': sel } });
  const good = chk.filter(c => c.json.llm_ok), bad = chk.filter(c => !c.json.llm_ok);
  ok(bad.length === 1 && bad[0].json.msg.msg_id === 'M010', 'failed primary routed to fallback');
  d = tail(await run('2', 'QC decide (primary)', good, { nodes: { 'Read Sheet': read } }));
  ok(msg('M001').status === 'needs_fix' && /devUP/.test(msg('M001').qc_reasons) && !/wizard/.test(msg('M001').qc_reasons), 'M001 needs_fix with devUP reason; hallucinated quote ignored');
  ok(msg('M002').status === 'needs_fix', 'M002 needs_fix');
  ok(msg('M003').status === 'ready' && msg('M003').qc_hash, 'M003 ready with hash');
  d = tail(await run('2', 'QC decide (fallback)', [{ json: { error: { message: '429' } } }], { nodes: { 'Read Sheet': read, 'Check primary LLM': chk }, pair: { 'Check primary LLM': () => bad[0] } }));
  ok(msg('M010').status === 'draft' && /both LLMs failed/.test(msg('M010').qc_reasons) && d.notices.length === 1, 'both LLMs down → stays draft, retried, notified');
  // rerun: nothing to do except M010
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  sel = await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } });
  ok(sel.length === 1 && sel[0].json.msg.msg_id === 'M010', 'idempotent: only pending draft re-selected');

  // ================= WF3 SENDER =================
  console.log('\nWF3 sender');
  const readyIds = sheet.rows('Messages').filter(m => m.status === 'ready').map(m => m.msg_id);
  // approve everything ready; give contacts valid emails for test
  for (const id of readyIds) sheet.set('Messages', id, 'approved', 'msg_id', true);
  for (const c of sheet.rows('Contacts')) if (!c.email) { sheet.set('Contacts', c.contact_id, 'email', 'contact_id', `${c.first_name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@${c.company_domain || 'example.com'}`); sheet.set('Contacts', c.contact_id, 'email_status', 'contact_id', 'valid'); }
  sheet.set('Contacts', 'C009', 'email_status', 'contact_id', 'risky');
  const send = async (gmailMock) => {
    const rd = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }];
    const p = await run('3', 'Pick next email', rd, { nodes: { 'Read Sheet': rd } });
    if (!p.length) return null;
    sheet.batchUpdate(p[0].json.lock);
    const ctx = { nodes: { 'Read Sheet': rd, 'Pick next email': p, 'Gmail: send': [{ json: gmailMock || {} }] } };
    const out = p[0].json.mode === 'dry_run' ? await run('3', 'After send (dry)', [{ json: {} }], ctx) : await run('3', 'After send (gmail)', [{ json: { payload: { headers: [{ name: 'Message-ID', value: '<abc@mail.gmail.com>' }] } } }], ctx);
    return { pick: p[0].json, out: tail(out) };
  };
  setNow('2026-10-10T09:00:00'); // Saturday
  ok(await send() === null, 'weekend → nothing sent');
  setNow('2026-10-08T07:30:00');
  ok(await send() === null, 'before window → nothing');
  setNow('2026-10-08T08:31:00');
  let r = await send();
  ok(r && r.pick.mode === 'dry_run' && msg(r.pick.msg.msg_id).dry_run_at && msg(r.pick.msg.msg_id).status === 'ready', `DRY_RUN: ${r.pick.msg.msg_id} simulated, status back to ready`);
  ok(/Content-Type: text\/plain/.test(Buffer.from(r.pick.gmail_payload.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), 'MIME is text/plain');
  ok(!/<img|<html|http.*track/i.test(r.pick.preview) && /owner@example.com/.test(r.pick.preview), 'no tracking, signature appended');
  setNow('2026-10-08T08:33:00');
  ok(await send() === null, 'gap < 5 min → wait');
  setNow('2026-10-08T08:36:30');
  r = await send(); ok(r && r.pick.msg.msg_id !== 'M003', 'next dry-run picks a different message');
  // LIVE
  sheet.cfg('DRY_RUN', false); sheet.cfg('TEST_RECIPIENT', '');
  setNow('2026-10-08T08:42:00');
  r = await send({ id: 'g1', threadId: 't1' });
  const first = r.pick.msg.msg_id;
  ok(msg(first).status === 'sent' && msg(first).gmail_thread_id === 't1' && msg(first).rfc_message_id === '<abc@mail.gmail.com>' && msg(first).followup_due === '2026-10-12', `LIVE: ${first} sent, ids + follow-up date logged`);
  ok(sheet.rows('Messages').every(m => m.msg_id === first || m.status !== 'sending'), 'no stuck locks');
  // Gmail quota error → pause
  setNow('2026-10-08T08:48:00');
  r = await send({ error: { message: '429 Daily user sending quota exceeded' } });
  ok(sheet.rows('Config').find(c => c.key === 'SENDING_PAUSED').value === true && msg(r.pick.msg.msg_id).status === 'ready', 'quota error → SENDING_PAUSED=TRUE, message back to ready');
  setNow('2026-10-08T08:55:00');
  ok(await send() === null, 'paused → nothing sent');
  sheet.cfg('SENDING_PAUSED', false);
  // send rest of the day, check cap and same-company rule
  const sentIds = [first];
  let t = DateTime_add('2026-10-08T08:55:00', 0);
  for (let k = 0; k < 40; k++) { setNow(t); const x = await send({ id: 'g' + k + 2, threadId: 't' + (k + 2) }); if (x) sentIds.push(x.pick.msg.msg_id); t = DateTime_add(t, 6); }
  const todaySent = sheet.rows('Messages').filter(m => String(m.sent_at).startsWith('2026-10-08'));
  ok(todaySent.length <= 15, `daily cap respected (${todaySent.length} ≤ 15)`);
  ok(todaySent.every(m => { const h = Number(String(m.sent_at).slice(11, 13)), mi = Number(String(m.sent_at).slice(14, 16)); return h * 60 + mi < 11 * 60 + 30; }), 'all sends inside 08:30–11:30');
  const coDay = {}; todaySent.forEach(m => { const c = con(m.contact_id).company; coDay[c] = (coDay[c] || 0) + 1; });
  ok(Object.values(coDay).every(v => v === 1), 'never two people of the same company on the same day');
  ok(sheet.rows('Messages').filter(m => m.contact_id === 'C009' && m.status === 'sent').length === 0, 'risky email without allow_risky never sent');
  // edit after approval → blocked
  const victim = sheet.rows('Messages').find(m => m.status === 'ready' && m.approved === true);
  sheet.set('Messages', victim.msg_id, 'body', 'msg_id', victim.body + ' Edited.');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  sel = await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } });
  const vs = sel.find(s => s.json.msg.msg_id === victim.msg_id);
  ok(vs && vs.json.changedAfterQC && vs.json.wasApproved, 'edited approved draft re-selected for QC');
  const vchk = await run('2', 'Check primary LLM', [{ json: llmResp({ claims: [], personal_reason: { present: true, specific: true }, ask: { count: 1 }, recipient_ok: true, issues: [], score: 90, verdict: 'pass' }) }], { nodes: { 'Select drafts for QC': [vs] } });
  d = tail(await run('2', 'QC decide (primary)', vchk, { nodes: { 'Read Sheet': read } }));
  ok(msg(victim.msg_id).approved === false && d.notices.some(n => /Approval cleared/.test(n)), 'approval cleared after edit + notified');

  // ================= WF4 REPLIES =================
  console.log('\nWF4 replies');
  setNow('2026-10-09T10:00:00');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const th = await run('4', 'Threads to check', read, { nodes: { 'Read Sheet': read } });
  ok(th.length === sentIds.length - 0 || th.length > 0, `${th.length} threads watched`);
  const fm = msg(first); const fc = con(fm.contact_id);
  const enc = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const threads = th.map(x => {
    if (x.json.thread_id !== fm.gmail_thread_id) return { json: { messages: [{ id: 'mine-' + x.json.thread_id, labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Louai <owner@example.com>' }] } }] } };
    return { json: { messages: [
      { id: 'mine', labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Louai Eddiaz <owner@example.com>' }] } },
      { id: 'r1', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${fc.full_name} <${fc.email}>` }, { name: 'Subject', value: 'Re: ' + fm.subject }], body: { data: enc('Hi Louai, sounds interesting, can you do Tuesday 14:00?\n\nOn Thu, Louai wrote:\n> old text') } } },
      { id: 'r2', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${fc.full_name} <${fc.email}>` }, { name: 'Subject', value: 'Automatic reply: out of office' }, { name: 'Auto-Submitted', value: 'auto-replied' }], body: { data: enc('I am away') } } },
    ] } };
  });
  const det4 = await run('4', 'Detect new replies', threads, { nodes: { 'Read Sheet': read, 'Threads to check': th } });
  ok(det4.length === 2 && det4.find(x => x.json.reply_id === 'r1').json.kind === 'human' && det4.find(x => x.json.reply_id === 'r2').json.kind === 'auto_reply', 'human vs auto-reply detected, own messages ignored');
  ok(!/old text/.test(det4[0].json.text), 'quoted history stripped');
  const human = det4.filter(x => x.json.needs_llm);
  ok(human.length === 2 && det4.find(x => x.json.reply_id === 'r2').json.needs_llm, 'auto-replies are classified too (they can carry a referral)');
  const c4 = await run('4', 'Check primary LLM (replies)', human.map(h => ({ json: llmResp(h.json.reply_id === 'r1'
    ? { category: 'interested', summary: 'Wants a call Tuesday 14:00.', next_step: 'Confirm Tuesday 14:00.', referral_to: '' }
    : { category: 'auto_reply', summary: 'Out of office.', next_step: 'Wait.', referral_to: '' }) })), { nodes: { 'Detect new replies': human } });
  d = tail(await run('4', 'Apply replies (primary)', c4, { nodes: { 'Read Sheet': read } }));
  ok(msg(first).status === 'replied' && con(fm.contact_id).contact_status === 'replied', 'reply → message replied, contact replied');
  ok(d.notices[0].includes('INTERESTED') && d.notices[0].includes('Tuesday') && d.notices[0].includes('mail.google.com'), 'Telegram notice has category, summary, link');
  ok(sheet.rows('Replies').length === 2 && sheet.rows('Replies').find(x => x.reply_id === 'r2').category === 'auto_reply', 'both replies logged in Replies tab; plain out-of-office stays auto_reply');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const det4b = await run('4', 'Detect new replies', threads, { nodes: { 'Read Sheet': read, 'Threads to check': th } });
  ok(det4b.length === 0, 'replies not processed twice');

  // ---- referrals: an auto-reply ("mailbox closed, contact X") and a person pointing to a colleague ----
  const [sA, sB] = sentIds.filter(id => id !== first).map(msg).filter(m => m && m.status === 'sent').slice(0, 2);
  const cA = con(sA.contact_id), cB = con(sB.contact_id);
  const contactsBefore = sheet.rows('Contacts').length;
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const th2 = await run('4', 'Threads to check', read, { nodes: { 'Read Sheet': read } });
  const threads2 = th2.map(x => {
    const msgs = [{ id: 'mine2-' + x.json.thread_id, labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Louai <owner@example.com>' }] } }];
    if (x.json.thread_id === sA.gmail_thread_id) msgs.push({ id: 'r3', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${cA.full_name} <${cA.email}>` }, { name: 'Subject', value: 'Re: ' + sA.subject }, { name: 'Auto-Submitted', value: 'auto-replied' }], body: { data: enc('This email account is no longer active. Please contact CEO John Q. Smith at jqs@example.com instead.') } } });
    if (x.json.thread_id === sB.gmail_thread_id) msgs.push({ id: 'r4', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${cB.full_name} <${cB.email}>` }, { name: 'Subject', value: 'Re: ' + sB.subject }], body: { data: enc('Hi Louai, I am not the right person, but write to Jane Doe, our CTO: jane.doe@example.com') } } });
    return { json: { messages: msgs } };
  });
  const det5 = await run('4', 'Detect new replies', threads2, { nodes: { 'Read Sheet': read, 'Threads to check': th2 } });
  ok(det5.length === 2 && det5.every(x => x.json.needs_llm) && det5.find(x => x.json.reply_id === 'r3').json.kind === 'auto_reply', 'referral auto-reply + human referral detected, both sent to the LLM');
  const tyBody = `Hi ${cB.first_name},\n\nThank you for pointing me to Jane Doe. I will contact her directly.`;
  const c5 = await run('4', 'Check primary LLM (replies)', det5.map(h => ({ json: llmResp(h.json.reply_id === 'r3'
    ? { category: 'referral', summary: 'Mailbox closed; contact the CEO.', next_step: 'Email John Q. Smith.', referral_to: 'CEO John Q. Smith, jqs@example.com', referral_name: 'John Q. Smith', referral_role: 'CEO', referral_email: 'jqs@example.com', thank_you_draft: '' }
    : { category: 'referral', summary: 'Points to the CTO.', next_step: 'Email Jane Doe.', referral_to: 'Jane Doe, our CTO: jane.doe@example.com', referral_name: 'Jane Doe', referral_role: 'CTO', referral_email: 'jane.doe@example.com', thank_you_draft: tyBody }) })), { nodes: { 'Detect new replies': det5 } });
  d = tail(await run('4', 'Apply replies (primary)', c5, { nodes: { 'Read Sheet': read } }));
  const rep3 = sheet.rows('Replies').find(x => x.reply_id === 'r3'), rep4 = sheet.rows('Replies').find(x => x.reply_id === 'r4');
  ok(rep3.category === 'referral' && rep3.kind === 'auto_reply' && rep4.category === 'referral', 'both classified as referral (auto-reply kind kept)');
  ok(con(cA.contact_id).contact_status === 'referred' && con(cB.contact_id).contact_status === 'referred' && msg(sA.msg_id).status === 'replied', 'referrer → contact referred, message replied');
  const newC = sheet.rows('Contacts').slice(contactsBefore);
  const claus = newC.find(x => x.email === 'jqs@example.com'), jane = newC.find(x => x.email === 'jane.doe@example.com');
  ok(newC.length === 2 && claus && claus.first_name === 'John' && claus.role === 'CEO' && claus.company === cA.company && claus.contact_status === 'active' && claus.email_status === '' && /^C\d{3}$/.test(claus.contact_id) && jane && jane.contact_id !== claus.contact_id, 'referred people added to Contacts (same company, active, address to verify)');
  const ty = msg(`${sA.msg_id}-R1`), tyB = msg(`${sB.msg_id}-R1`);
  ok(!ty && tyB && tyB.type === 'reply' && tyB.status === 'draft' && tyB.to_email === cB.email && tyB.gmail_thread_id === sB.gmail_thread_id && tyB.body === tyBody.replace(/\\n/g, '\n'), 'thank-you draft only for the human referral, in the same thread');
  ok(d.notices.some(n => /REFERRAL/.test(n) && /New contact added/.test(n)), 'Telegram notice for referral');
  // same company is NOT put on hold by a referral
  const mateRow = sheet.rows('Contacts').find(x => x.company === cA.company && x.contact_id !== cA.contact_id && x.contact_id !== claus.contact_id);
  ok(!mateRow || !sheet.rows('Messages').some(m => m.contact_id === mateRow.contact_id && m.status === 'held'), 'colleagues not held after a referral');
  // no duplicate contact when the same referral comes again
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const again = c5.map(x => ({ json: { ...x.json, reply_id: x.json.reply_id + 'b' } }));
  tail(await run('4', 'Apply replies (primary)', again, { nodes: { 'Read Sheet': read } }));
  ok(sheet.rows('Contacts').length === contactsBefore + 2 && msg(tyB.msg_id).status === 'draft', 'same referral twice → no duplicate contact, thank-you draft kept');
  // thank-you goes through QC, then the Sender answers in the thread to the person who wrote
  sheet.cfg('QC_BATCH', 200);
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  sel = await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } });
  const tys = sel.find(x => x.json.msg.msg_id === tyB.msg_id);
  if (tys && tys.json.det.fails.length) console.log('    det:', JSON.stringify(tys.json.det)); ok(tys && !tys.json.det.fails.length, 'thank-you passes the code rules (≤50 words, greeting)');
  const tyc = await run('2', 'Check primary LLM', [{ json: llmResp({ claims: [], personal_reason: { present: false, specific: false }, ask: { count: 0 }, recipient_ok: true, issues: [], score: 95, verdict: 'pass' }) }], { nodes: { 'Select drafts for QC': [tys] } });
  tail(await run('2', 'QC decide (primary)', tyc, { nodes: { 'Read Sheet': read } }));
  ok(msg(tyB.msg_id).status === 'ready', 'thank-you QC → ready');
  sheet.set('Messages', tyB.msg_id, 'approved', 'msg_id', true);
  setNow('2026-10-09T10:30:00');
  r = await send({ id: 'gty', threadId: sB.gmail_thread_id });
  const tyRaw = r ? Buffer.from(r.pick.gmail_payload.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString() : '';
  ok(r && r.pick.msg.msg_id === tyB.msg_id && r.pick.gmail_payload.threadId === sB.gmail_thread_id && /In-Reply-To: <abc@mail.gmail.com>/.test(tyRaw) && new RegExp('To: ' + cB.email).test(tyRaw), 'Sender sends the thank-you in the same thread to the person who replied');
  ok(msg(tyB.msg_id).status === 'sent', 'thank-you marked sent');

  // ================= WF5 FOLLOW-UPS =================
  console.log('\nWF5 follow-ups');
  setNow('2026-10-12T07:15:00');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile']) }];
  const due = await run('5', 'Due follow-ups', read, { nodes: { 'Read Sheet': read } });
  ok(due.length > 0 && !due.some(x => x.json.contact.contact_id === fm.contact_id), `${due.length} follow-ups due; replied contact excluded`);
  const fuc = await run('5', 'Check primary LLM (follow-ups)', due.map(() => ({ json: llmResp({ body: 'Hi X,\n\nA short note on my email from last week. I also built a Teams RAG assistant that answers HR questions in Dutch with citations. Would a 15-minute call next week work?' }) })), { nodes: { 'Due follow-ups': due } });
  d = tail(await run('5', 'Create follow-up drafts (primary)', fuc, { nodes: { 'Read Sheet': read } }));
  const fu = sheet.rows('Messages').filter(m => m.type === 'fu1');
  ok(fu.length === due.length && fu.every(m => m.status === 'draft' && m.subject.startsWith('Re: ') && m.gmail_thread_id), 'fu1 drafts appended with thread + Re: subject');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile']) }];
  const due2 = await run('5', 'Due follow-ups', read, { nodes: { 'Read Sheet': read } });
  ok(!due2.some(x => fu.some(f => f.contact_id === x.json.contact.contact_id)), `no duplicate follow-up drafts (next run only picks the ${due2.length} remaining)`);
  // QC + approve + send one follow-up in thread
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  sel = await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } });
  const fsel = sel.filter(s => s.json.msg.type === 'fu1');
  ok(fsel.length && fsel[0].json.det.fails.some(f => /Greeting says "X"/.test(f)), 'follow-up QC catches wrong greeting');
  const f0 = fu[0];
  sheet.set('Messages', f0.msg_id, 'body', 'msg_id', `Hi ${f0.first_name},\n\nA short note on my email from last week. I also built a Teams RAG assistant that answers HR questions in Dutch with citations. Would a 15-minute call next week work?`);
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
  sel = (await run('2', 'Select drafts for QC', read, { nodes: { 'Read Sheet': read } })).filter(s => s.json.msg.msg_id === f0.msg_id);
  ok(sel[0].json.det.fails.length === 0, `fixed follow-up passes deterministic QC (${sel[0].json.det.fails.join('|')})`);
  const fchk = await run('2', 'Check primary LLM', [{ json: llmResp({ claims: [], personal_reason: { present: true, specific: true }, ask: { count: 1 }, recipient_ok: true, issues: [], score: 90, verdict: 'pass' }) }], { nodes: { 'Select drafts for QC': sel } });
  tail(await run('2', 'QC decide (primary)', fchk, { nodes: { 'Read Sheet': read } }));
  sheet.set('Messages', f0.msg_id, 'approved', 'msg_id', true);
  setNow('2026-10-12T08:31:00');
  r = await send({ id: 'gf', threadId: msg(f0.parent_msg_id).gmail_thread_id });
  ok(r && r.pick.msg.msg_id === f0.msg_id && r.pick.gmail_payload.threadId === msg(f0.parent_msg_id).gmail_thread_id, 'follow-up sent first, in the same Gmail thread');
  const mime = Buffer.from(r.pick.gmail_payload.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  ok(/In-Reply-To: <abc@mail.gmail.com>/.test(mime) && /References: /.test(mime), 'In-Reply-To/References headers set');
  ok(msg(f0.msg_id).status === 'sent', 'follow-up marked sent');
  // duplicate guard: reset follow-up to ready+approved → must not resend
  sheet.set('Messages', f0.msg_id, 'status', 'msg_id', 'ready'); sheet.set('Messages', f0.msg_id, 'sent_at', 'msg_id', '');
  setNow('2026-10-12T08:40:00');
  r = await send({ id: 'gx', threadId: 'tx' });
  ok(!r || r.pick.msg.msg_id !== f0.msg_id, 'duplicate guard: same type/same address never re-sent');

  // ================= WF6 REPORT + WF0 =================
  console.log('\nWF6 report / WF0 error');
  setNow('2026-10-12T18:00:00');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies', 'Log']) }];
  const rep = await run('6', 'Build daily report', read, { nodes: { 'Read Sheet': read } });
  ok(rep.length >= 1 && rep.every(x => x.json.text.length <= 4000) && /SENT TODAY/.test(rep[0].json.full) && /PROBLEMS TODAY/.test(rep[0].json.full), `report built (${rep.length} Telegram chunk(s))`);
  console.log('\n---- REPORT PREVIEW ----\n' + rep[0].json.full.slice(0, 2500) + '\n------------------------');
  const er = await run('0', 'Format error', [{ json: { execution: { id: 1, url: 'https://n8n/x', lastNodeExecuted: 'Read Sheet', error: { message: 'Sheet "Messages" is missing column(s): approved' } }, workflow: { name: 'Outreach 3 · Sender' } } }]);
  ok(/header/.test(er[0].json.text) && er[0].json.logs.length === 1, 'error handler formats alert with fix hint');
  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch(e => { console.error('\n✘ FAILED:', e.message); console.error(e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); });

function DateTime_add(isoS, mins) { const { DateTime } = require('luxon'); return DateTime.fromISO(isoS, { zone: 'Europe/Stockholm' }).plus({ minutes: mins }).toISO({ includeOffset: false, suppressMilliseconds: true }); }
