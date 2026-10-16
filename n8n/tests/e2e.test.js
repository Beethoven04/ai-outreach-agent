// End-to-end scenario test: node tests/e2e.test.js
const assert = require('assert');
const { run, Sheet, setNow, J } = require('./harness');
const sheet = new Sheet(require('./sheet_fixture.demo.json'));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✔', msg); };
const tail = (out) => { const d = out[0].json; if (d.data && d.data.length) sheet.batchUpdate(d.data); if (d.logs && d.logs.length) sheet.append('Log', d.logs); if (d.appendReplies && d.appendReplies.length) sheet.append('Replies', d.appendReplies); if (d.appendMessages && d.appendMessages.length) sheet.append('Messages', d.appendMessages); if (d.appendContacts && d.appendContacts.length) sheet.append('Contacts', d.appendContacts); return d; };
const msg = id => sheet.rows('Messages').find(m => m.msg_id === id);
const con = id => sheet.rows('Contacts').find(c => c.contact_id === id);
const BCFG = require('../build_config.json');
// helpers from src/common.js (same code the Code nodes run)
const COMMON = (() => { const ctx = { DateTime: require('luxon').DateTime, Buffer }; require('vm').runInNewContext(require('fs').readFileSync(__dirname + '/../src/common.js', 'utf8') + '\nthis.draftVer = draftVer;', ctx); return ctx; })();
const draftVerOf = row => COMMON.draftVer(row);
const llmResp = obj => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
// wf4: inbox search query → (Gmail search result) → threads to check
// activity = result of search 1 (default: an error → every watched thread is fetched, the old behaviour)
const threadsToCheck = async (read, hits = [], activity = { error: { message: 'x' } }) => {
  const q = await run('4', 'Inbox search query', read, { nodes: { 'Read Sheet': read } });
  return run('4', 'Threads to check', [{ json: activity }, { json: { messages: hits } }], { nodes: { 'Read Sheet': read, 'Inbox search query': q } });
};

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
  ok(con('C012').email_status === 'not_found' && /missing company_domain/.test(con('C012').email_detail) && !d.notices.length, 'Jonas → not_found with the reason (Log + report only, no Telegram ping)');
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
  ok(con('C009').email_status === 'risky' && !d.notices.some(n => /RISKY/.test(n)), 'catch-all → risky (no Telegram ping: not a problem)');
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
  {
    // 12 Oct style rules: AI tells + colleague look-alikes (run on a scratch copy of the sheet)
    const S2 = new Sheet(JSON.parse(JSON.stringify(sheet.tabs)));
    const mh = S2.tabs.Messages[0], bi = mh.indexOf('body'), ci = mh.indexOf('contact_id'), si = mh.indexOf('status'), qi = mh.indexOf('qc_hash');
    const ch = S2.tabs.Contacts[0], cci = ch.indexOf('company'), cid = ch.indexOf('contact_id');
    const m1 = S2.tabs.Messages.find(r => r[mh.indexOf('msg_id')] === 'M001');
    const c1 = S2.tabs.Contacts.find(r => r[cid] === m1[ci]);
    const twin = S2.tabs.Contacts.find(r => r !== c1 && r[cid] && r[cid] !== 'contact_id' && S2.tabs.Messages.some(m => m[ci] === r[cid] && m[si] === 'draft'));
    twin[cci] = c1[cci];
    const tm = S2.tabs.Messages.find(m => m[ci] === twin[cid] && m[si] === 'draft');
    const fn = twin[ch.indexOf('first_name')];
    tm[bi] = m1[bi].replace(/^Hi [^,]+,/, `Hi ${fn},`); tm[qi] = '';
    m1[bi] = m1[bi].replace('. It routes', '; it routes');
    const rd = [{ json: S2.batchGet(['Config', 'Contacts', 'Messages', 'Profile', 'Companies']) }];
    const sel2 = await run('2', 'Select drafts for QC', rd, { nodes: { 'Read Sheet': rd } });
    const d1 = sel2.find(x => x.json.msg.msg_id === 'M001').json.det;
    ok(d1.fails.some(f => /Semicolon/.test(f)), 'semicolon → deterministic fail');
    ok(d1.fails.some(f => /Too similar to/.test(f)), 'near-identical email to a colleague at the same company → fail');
  }
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
  // sentSearch = what Gmail Sent returns for the guard search (default: nothing sent by hand)
  const send = async (gmailMock, sentSearch = { resultSizeEstimate: 0 }) => {
    const rd = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }];
    const p = await run('3', 'Pick next email', rd, { nodes: { 'Read Sheet': rd } });
    if (!p.length) return null;
    const g = await run('3', 'Manual send guard', [{ json: sentSearch }], { nodes: { 'Read Sheet': rd, 'Pick next email': p } });
    if (!g[0].json.guard_ok) return { pick: p[0].json, held: tail(g) };
    sheet.batchUpdate(g[0].json.lock);
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
  {
    const raw = Buffer.from(r.pick.gmail_payload.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const bnd = (raw.match(/boundary="([^"]+)"/) || [])[1];
    const parts = bnd ? raw.split('--' + bnd).slice(1, -1) : [];
    const dec = p => Buffer.from(p.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString();
    const plain = parts[0] ? dec(parts[0]) : '', html = parts[1] ? dec(parts[1]) : '';
    const bodyM = msg(r.pick.msg.msg_id);
    ok(/multipart\/alternative/.test(raw) && parts.length === 2 && /text\/plain/.test(parts[0]) && /text\/html/.test(parts[1]), 'MIME is multipart/alternative (plain + html, like Gmail compose)');
    const paras = String(bodyM.body).trim().split(/\n\s*\n/);
    ok(paras.every(pp => plain.includes(pp.replace(/\n/g, '\r\n'))) && !/[^\r\n]\r\n[^\r\n]/.test(plain.split('\r\n\r\n').slice(0, paras.length).join('\r\n\r\n').replace(/^[^\r]*\r\n/, '').split('\r\n\r\n').filter(x => x.length > 60).join('')), 'plain part keeps each paragraph on one line (no hard wraps)');
    ok(html.startsWith('<div dir="ltr">') && /<div><br><\/div>/.test(html) && !/<script|<img/i.test(html) && /href="mailto:owner@example.com"/.test(html), 'html part: Gmail-style divs, linkified signature, no tracking');
  }
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
  const th = await threadsToCheck(read);
  ok(th.length === sentIds.length - 0 || th.length > 0, `${th.length} threads watched`);
  const fm = msg(first); const fc = con(fm.contact_id);
  const thAct = await threadsToCheck(read, [], { messages: [{ id: 'r1', threadId: fm.gmail_thread_id }, { id: 'zz', threadId: 'not-ours' }], resultSizeEstimate: 2 });
  ok(thAct.length === 1 && thAct[0].json.thread_id === fm.gmail_thread_id, `only threads with new mail are fetched (1 of ${th.length})`);
  ok((await threadsToCheck(read, [], { resultSizeEstimate: 0 })).length === 0, 'no new mail → no thread fetched at all');
  ok((await threadsToCheck(read, [], { messages: [{ id: 'a', threadId: 'b' }], nextPageToken: 'p' })).length === th.length, 'more than one page of results → safe fallback: every watched thread');
  const sq0 = await run('4', 'Inbox search query', read, { nodes: { 'Read Sheet': read } });
  ok(sq0.length === 2 && /^newer_than:\d+d -from:me -in:sent/.test(sq0[0].json.q), `activity search query: ${sq0[0].json.q}`);
  const enc = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const threads = th.map(x => {
    if (x.json.thread_id !== fm.gmail_thread_id) return { json: { messages: [{ id: 'mine-' + x.json.thread_id, labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Louai <owner@example.com>' }] } }] } };
    return { json: { messages: [
      { id: 'mine', labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Louai Eddiaz <owner@example.com>' }] } },
      { id: 'r1', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${fc.full_name} <${fc.email}>` }, { name: 'Subject', value: 'Re: ' + fm.subject }, { name: 'Message-ID', value: '<r1@mail.example.com>' }], body: { data: enc('Hi Louai, sounds interesting, can you do Tuesday 14:00?\n\nOn Thu, Louai wrote:\n> old text') } } },
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
  ok(!d.notices.length, 'replies do not ping bot 1 (the reply bot gets a card, the daily report lists them)');
  ok(sheet.rows('Replies').length === 2 && sheet.rows('Replies').find(x => x.reply_id === 'r2').category === 'auto_reply', 'both replies logged in Replies tab; plain out-of-office stays auto_reply');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const det4b = await run('4', 'Detect new replies', threads, { nodes: { 'Read Sheet': read, 'Threads to check': th } });
  ok(det4b.length === 0, 'replies not processed twice');

  // ---- referrals: an auto-reply ("mailbox closed, contact X") and a person pointing to a colleague ----
  const [sA, sB] = sentIds.filter(id => id !== first).map(msg).filter(m => m && m.status === 'sent').slice(0, 2);
  const cA = con(sA.contact_id), cB = con(sB.contact_id);
  const contactsBefore = sheet.rows('Contacts').length;
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const th2 = await threadsToCheck(read);
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
  ok(!msg(`${sA.msg_id}-R1`) && !msg(`${sB.msg_id}-R1`), 'wf4 no longer drafts thank-yous (the reply bot does)');
  ok(rep4.referral_email === 'jane.doe@example.com' && rep4.referral_name === 'Jane Doe' && rep4.thread_id === sB.gmail_thread_id && rep4.text.includes('Jane Doe') && rep4.from_name === cB.full_name, 'Replies row keeps thread, sender name, full text and referral address for the bot');
  ok(!d.notices.length, 'referrals do not ping bot 1 either');
  // same company is NOT put on hold by a referral
  const mateRow = sheet.rows('Contacts').find(x => x.company === cA.company && x.contact_id !== cA.contact_id && x.contact_id !== claus.contact_id);
  ok(!mateRow || !sheet.rows('Messages').some(m => m.contact_id === mateRow.contact_id && m.status === 'held'), 'colleagues not held after a referral');
  // no duplicate contact when the same referral comes again
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const again = c5.map(x => ({ json: { ...x.json, reply_id: x.json.reply_id + 'b' } }));
  tail(await run('4', 'Apply replies (primary)', again, { nodes: { 'Read Sheet': read } }));
  ok(sheet.rows('Contacts').length === contactsBefore + 2, 'same referral twice → no duplicate contact');
  // ================= WF7 REPLY ASSISTANT (drafter + bot) =================
  console.log('\nWF7 reply assistant');
  setNow('2026-10-09T10:05:00');
  const OWNER = String(BCFG.REPLY_BOT_CHAT_ID || BCFG.TELEGRAM_CHAT_ID);
  const plain = h => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const decodeRaw = raw => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  const rd7 = () => [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies', 'Profile']) }];
  let read7 = rd7();
  const pick7 = await run('7', 'Pick replies to draft', read7, { nodes: { 'Read Sheet (drafter)': read7 } });
  const jobs = pick7[0].json.jobs;
  const jRe = id => jobs.filter(j => j.reply.reply_id === id);
  ok(jobs.length === 4 && jRe('r1').length === 1 && jRe('r1')[0].mode === 'reply' && jRe('r2').length === 0, `drafter: 4 jobs (interested reply, intros, thank-you); auto-reply skipped (got ${jobs.map(j => j.reply.reply_id + ':' + j.mode).join(', ')})`);
  ok(jRe('r3').length === 1 && jRe('r3')[0].mode === 'intro' && jRe('r3')[0].to_email === 'jqs@example.com', 'robot referral → only an intro email to the new person');
  ok(jRe('r4').map(j => j.mode).join() === 'reply,intro' && jRe('r4')[1].to_email === 'jane.doe@example.com' && jRe('r4')[0].to_email === cB.email, 'human referral → thank-you to the writer + intro to the referred person');
  ok(jRe('r1')[0].msg_id === `${first}-R1` && jRe('r1')[0].thread_id === fm.gmail_thread_id && /^Re: /.test(jRe('r1')[0].subject) && jRe('r3')[0].msg_id === `${sA.msg_id}-I1`, 'draft ids Mxxx-R1 / Mxxx-I1, reply stays in the thread');
  ok(pick7[0].json.marks.some(([row, why]) => /auto_reply/.test(why)), 'auto-reply marked as skipped');
  const b7 = await run('7', 'Build draft requests', pick7, { nodes: { 'Read Sheet (drafter)': read7, 'Pick replies to draft': pick7 } });
  const u0 = JSON.parse(b7[0].json.req_primary.messages[1].content);
  ok(!('calendar' in u0) && !b7[0].json.cal && /^Monday to Friday, 09:00 to 17:00/.test(u0.availability.usual_hours) && u0.louai_facts.length > 5 && u0.their_message.text.includes('Tuesday 14:00'), `no calendar (it is on Louai's Mac): LLM gets his usual hours (${u0.availability.usual_hours}), Profile facts, their full message`);
  ok(/cannot see Louai's calendar/.test(b7[0].json.req_primary.messages[0].content) && !/suggested_slots|free_windows/.test(b7[0].json.req_primary.messages[0].content), 'draft prompt: never confirms or invents times from a calendar');
  const tFirst = jRe('r1')[0].target.first_name;
  const bodies = {
    r1: `Hi ${tFirst},\n\nThank you for the quick answer. Tuesday at 14:00 does not work for me, sorry. Could we do Monday 12 October at 10:00 or Tuesday 13 October at 10:00, Copenhagen/Stockholm time?\n\nBest regards,`,
    r3: { subject: 'Internship: pointed to you by the auto-reply', body: 'Hi John,\n\nThe auto-reply from my email to your colleague pointed me to you. I am a final-year master\'s student in Data Science and AI and I build AI agents at devUP, a Dutch AI consultancy. I am looking for a master\'s thesis internship from February 2027, for 3 to 6 months or longer. Would a 20-minute call suit you?\n\nBest regards,' },
    r4: `Hi ${cB.first_name},\n\nThank you for pointing me to Jane Doe. I will contact her directly.`,
  };
  const llm7 = b7.map(x => {
    const j = x.json;
    if (j.reply.reply_id === 'r4' && j.mode === 'intro') return { json: { error: { message: '503 high demand' } } };
    if (j.reply.reply_id === 'r3') return { json: llmResp({ ...bodies.r3, open_questions: [], notes: '' }) };
    return { json: llmResp({ subject: '', body: bodies[j.reply.reply_id], open_questions: j.reply.reply_id === 'r1' ? [] : [], notes: j.reply.reply_id === 'r1' ? 'Check your calendar: Tuesday 13 October at 14:00' : '' }) };
  });
  const ck7 = await run('7', 'Check primary LLM (drafts)', llm7, { nodes: { 'Build draft requests': b7 } });
  const ok7 = ck7.filter(x => x.json.llm_ok), bad7 = ck7.filter(x => !x.json.llm_ok);
  ok(ok7.length === 3 && bad7.length === 1, 'one LLM failure goes to the fallback');
  const ctx7 = { nodes: { 'Read Sheet (drafter)': read7, 'Pick replies to draft': pick7, 'Check primary LLM (drafts)': ck7 } };
  const cr1 = tail(await run('7', 'Create reply drafts (primary)', ok7, ctx7));
  const fbBody = 'Hi Jane,\n\nJohn suggested I contact you. I am a final-year master\'s student in Data Science and AI and I build AI agents at devUP, a Dutch AI consultancy. I am looking for a master\'s thesis internship from February 2027, for 3 to 6 months or longer, remote, hybrid or on-site. Would a 20-minute call suit you?\n\nBest regards,';
  const cr2 = tail(await run('7', 'Create reply drafts (fallback)', [{ json: llmResp({ subject: 'Master\'s thesis internship, AI agents', body: fbBody }) }], { ...ctx7, pair: { 'Check primary LLM (drafts)': () => bad7[0] } }));
  const d1 = msg(`${first}-R1`), dI = msg(`${sA.msg_id}-I1`), dT = msg(`${sB.msg_id}-R1`), dJ = msg(`${sB.msg_id}-I1`);
  ok(d1 && d1.status === 'awaiting_ok' && d1.type === 'reply' && d1.to_email === fc.email && d1.gmail_thread_id === fm.gmail_thread_id && d1.reply_id === 'r1' && d1.approved === false, 'reply draft saved: awaiting_ok, not approved, same thread, to the person who wrote');
  ok(dI && dI.type === 'intro' && dI.to_email === 'jqs@example.com' && dI.gmail_thread_id === '' && dI.contact_id === claus.contact_id && dI.subject.startsWith('Internship'), 'intro draft: new thread, to the referred contact, own subject');
  ok(dT && dT.to_email === cB.email && dJ && dJ.to_email === 'jane.doe@example.com' && dJ.body === fbBody && /fallback/.test(dJ.qc_model), 'thank-you + fallback-written intro saved');
  const rr = id => sheet.rows('Replies').find(x => x.reply_id === id);
  ok(rr('r1').draft_msg_id === d1.msg_id && /skip/.test(rr('r2').draft_msg_id) && rr('r4').draft_msg_id.includes(dT.msg_id), 'Replies rows marked with their draft id (auto-reply: skip)');
  const cards = [...cr1.cards, ...cr2.cards];
  const c1 = cards.find(c => c.msg_id === d1.msg_id);
  ok(cards.length === 4 && c1 && c1.text.includes('<blockquote>') && !c1.text.includes('📅') && c1.text.includes(`Draft ${d1.msg_id}`) && c1.text.includes('Check your calendar') && c1.ver === draftVerOf(d1) && c1.text.length <= 4000, 'Telegram card: their message, draft, LLM note, version for the buttons (no calendar line)');
  ok(c1.text.includes(`<b>Goes to:</b> ${fc.full_name} &lt;${fc.email}&gt;, only this address`) && c1.text.includes('Reply in the same Gmail conversation'), 'card says who receives it and that it stays in the same conversation');
  const cI = cards.find(c => c.msg_id === dI.msg_id);
  ok(cI.text.includes('&lt;jqs@example.com&gt;') && cI.text.includes('<b>New email</b> (new conversation)'), 'intro card says: new email, new conversation, to the referred person');
  ok(!(await run('3', 'Pick next email', [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }], { nodes: { 'Read Sheet': [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }] } })).some(p => ['reply', 'intro'].includes(p.json.type)), 'Sender never touches bot drafts');
  read7 = rd7();
  const pick7b = await run('7', 'Pick replies to draft', read7, { nodes: { 'Read Sheet (drafter)': read7 } });
  ok(!pick7b.length || !pick7b[0].json.jobs.some(j => ['r1', 'r3', 'r4'].includes(j.reply.reply_id)), 'drafted replies are never drafted twice');
  // old replies (before go-live) are ignored
  sheet.cfg('REPLY_DRAFTS_SINCE', '2099-01-01T00:00:00'); // test replies carry the real clock (internalDate = Date.now())
  read7 = rd7();
  ok((await run('7', 'Pick replies to draft', read7, { nodes: { 'Read Sheet (drafter)': read7 } })).length === 0, 'REPLY_DRAFTS_SINCE: older replies get no draft');
  sheet.cfg('REPLY_DRAFTS_SINCE', 73051); // 2100-01-01 as a Sheets date serial (13 Oct: USER_ENTERED turned the ISO text into a number)
  read7 = rd7();
  ok((await run('7', 'Pick replies to draft', read7, { nodes: { 'Read Sheet (drafter)': read7 } })).length === 0, 'REPLY_DRAFTS_SINCE stored as a date serial is respected');
  sheet.cfg('REPLY_DRAFTS_SINCE', '');

  // ---- the bot ----
  const rdB = () => [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies', 'Profile', 'Log']) }];
  const bot = async (update) => { const rb = rdB(); const out = await run('7', 'Bot route', rb, { nodes: { 'Reply bot trigger': [{ json: update }], 'Read Sheet (bot)': rb } }); return { out, rb }; };
  const cb = (data, cardText = 'card') => ({ update_id: 1, callback_query: { id: 'cq1', from: { id: Number(OWNER) }, data, message: { message_id: 77, chat: { id: Number(OWNER) }, text: cardText } } });
  const txt = (text, replyTo) => ({ update_id: 2, message: { message_id: 90, from: { id: Number(OWNER) }, chat: { id: Number(OWNER) }, text, ...(replyTo ? { reply_to_message: { message_id: 77, text: replyTo } } : {}) } });
  let bt = await bot({ update_id: 3, callback_query: { id: 'x', from: { id: 999 }, data: `send|${d1.msg_id}|${c1.ver}`, message: { message_id: 1, chat: { id: 999 }, text: '' } } });
  ok(bt.out.length === 0, 'stranger pressing a button → ignored');
  bt = await bot({ update_id: 4, message: { message_id: 5, from: { id: 999 }, chat: { id: 999 }, text: '/pending' } });
  ok(bt.out.length === 0, 'stranger writing to the bot → ignored');
  bt = await bot(txt('/pending'));
  ok(bt.out[0].json.action === 'say' && bt.out[0].json.cards.length === 4, '/pending re-sends the 4 waiting cards');
  bt = await bot(txt('shorter please'));
  ok(bt.out[0].json.action === 'say' && /Reply to the draft card/.test(bt.out[0].json.say), 'edit without replying to a card (several waiting) → asks which one');
  // ✏️ edit: instruction as a reply to the card
  bt = await bot(txt('Remove the sorry and propose only Monday', plain(c1.text)));
  const rt1 = bt.out[0].json;
  ok(rt1.action === 'rewrite' && rt1.how === 'edit' && rt1.row.msg_id === d1.msg_id && rt1.llm_input.current_draft.body === d1.body && rt1.llm_input.louai_message.includes('Monday'), 'reply to a card → rewrite of THAT draft with Louai\'s message');
  let bb = await run('7', 'Build rewrite request', bt.out, { nodes: { 'Bot route': bt.out, 'Read Sheet (bot)': bt.rb } });
  const uB = JSON.parse(bb[0].json.req_primary.messages[1].content);
  ok(bb[0].json.req_primary.messages[0].content.includes('own_text') && uB.availability.usual_hours && !('calendar' in uB), 'edit uses the edit prompt + usual hours (no calendar)');
  const newBody = `Hi ${tFirst},\n\nThank you for the quick answer. Tuesday at 14:00 does not work for me. Could we do Monday 12 October at 10:00, Copenhagen/Stockholm time?\n\nBest regards,`;
  let ckB = await run('7', 'Check rewrite LLM', [{ json: llmResp({ mode: 'instruction', subject: d1.subject, body: newBody, notes: '' }) }], { nodes: { 'Build rewrite request': bb } });
  let ap = tail(await run('7', 'Apply rewrite (primary)', ckB, { nodes: { 'Bot route': bt.out, 'Read Sheet (bot)': bt.rb, 'Check rewrite LLM': ckB } }));
  const card2 = ap.cards[0];
  ok(msg(d1.msg_id).body === newBody && msg(d1.msg_id).status === 'awaiting_ok', 'edited text saved, still waiting for ✅');
  ok(card2.text.includes('Changes') && card2.text.includes('➖ Tuesday at 14:00 does not work for me, sorry.') && card2.text.includes('➕ Tuesday at 14:00 does not work for me.') && card2.ver !== c1.ver, 'new card shows exactly what changed + new version');
  bt = await bot(cb(`send|${d1.msg_id}|${c1.ver}`));
  ok(bt.out[0].json.action === 'toast' && /old version/.test(bt.out[0].json.toast), '✅ on the OLD card → refused (stale version)');
  // own text → polished
  bt = await bot(txt(`Hi ${tFirst}, monday 10 works great for me, see you then`, plain(card2.text)));
  bb = await run('7', 'Build rewrite request', bt.out, { nodes: { 'Bot route': bt.out, 'Read Sheet (bot)': bt.rb } });
  ckB = await run('7', 'Check rewrite LLM', [{ json: { error: { message: '503' } } }], { nodes: { 'Build rewrite request': bb } });
  ok(!ckB[0].json.llm_ok, 'rewrite: primary LLM down → fallback');
  const ownBody = `Hi ${tFirst},\n\nMonday at 10:00 works great for me. See you then.\n\nBest regards,`;
  ap = tail(await run('7', 'Apply rewrite (fallback)', [{ json: llmResp({ mode: 'own_text', subject: d1.subject, body: ownBody, notes: '' }) }], { nodes: { 'Bot route': bt.out, 'Read Sheet (bot)': bt.rb, 'Check rewrite LLM': ckB } }));
  const card3 = ap.cards[0];
  ok(msg(d1.msg_id).body === ownBody && card3.text.includes('your text, polished'), 'Louai\'s own text → polished version shown for approval');
  // ✅ send
  sheet.cfg('DRY_RUN', true);
  bt = await bot(cb(`send|${d1.msg_id}|${card3.ver}`));
  ok(bt.out[0].json.action === 'toast' && /DRY_RUN/.test(bt.out[0].json.toast), 'DRY_RUN on → bot refuses to send');
  sheet.cfg('DRY_RUN', false);
  bt = await bot(cb(`send|${d1.msg_id}|${card3.ver}`, plain(card3.text)));
  const sd = bt.out[0].json;
  const raw1 = decodeRaw(sd.gmail_payload.raw);
  ok(sd.action === 'send' && sd.gmail_payload.threadId === fm.gmail_thread_id && /In-Reply-To: <r1@mail\.example\.com>/.test(raw1) && new RegExp('To: ' + fc.email).test(raw1) && /Subject: Re: /.test(raw1), '✅ → reply to THEIR message (In-Reply-To their Message-ID), same Gmail thread');
  ok(/Content-Type: multipart\/alternative/.test(raw1) && Buffer.from(raw1.split('base64\r\n\r\n')[1].split('\r\n\r\n')[0].replace(/\r\n/g, ''), 'base64').toString().includes('Monday at 10:00'), 'same MIME format as the Sender (text + HTML, signature)');
  ok(new RegExp(`^in:sent \\(to:${fc.email.replace(/[.]/g, '\\.')} OR cc:`).test(sd.guard_q) && /after:\d+$/.test(sd.guard_q), '✅ first asks Gmail Sent whether you already answered by hand');
  let hc = await run('7', 'Hand check (bot)', [{ json: { resultSizeEstimate: 0 } }], { nodes: { 'Bot route': [{ json: sd }], 'Read Sheet (bot)': bt.rb } });
  ok(hc[0].json.clear === true, 'nothing sent by hand → clear to send');
  hc = await run('7', 'Hand check (bot)', [{ json: { messages: [{ id: '9999aaaabbbbcccc' }] } }], { nodes: { 'Bot route': [{ json: sd }], 'Read Sheet (bot)': bt.rb } });
  ok(hc[0].json.clear === false && hc[0].json.data.some(x => x.values[0][0] === 'skipped') && /already wrote to/.test(hc[0].json.card_text), 'you already answered by hand → NOT sent, draft closed, card says why');
  hc = await run('7', 'Hand check (bot)', [{ json: { error: { message: '429' } } }], { nodes: { 'Bot route': [{ json: sd }], 'Read Sheet (bot)': bt.rb } });
  ok(hc[0].json.clear === false && hc[0].json.data.some(x => x.values[0][0] === 'awaiting_ok') && /could not check Gmail/.test(hc[0].json.card_text), 'Gmail check fails → NOT sent, draft stays waiting');
  sheet.batchUpdate(sd.lock);
  ok(msg(d1.msg_id).status === 'sending', 'row locked while sending');
  bt = await bot(cb(`send|${d1.msg_id}|${card3.ver}`));
  ok(/being sent/.test(bt.out[0].json.toast), 'double tap while sending → refused');
  const af = tail(await run('7', 'After bot send', [{ json: { payload: { headers: [{ name: 'Message-ID', value: '<sent-r1@mail.gmail.com>' }] } } }], { nodes: { 'Bot route': [{ json: sd }], 'Read Sheet (bot)': bt.rb, 'Gmail: send (bot)': [{ json: { id: 'gR1', threadId: fm.gmail_thread_id } }] } }));
  ok(msg(d1.msg_id).status === 'sent' && msg(d1.msg_id).gmail_message_id === 'gR1' && msg(d1.msg_id).approved === true && /^✅ SENT \d\d:\d\d to .* in the same Gmail conversation/.test(af.card_text), 'sent → row sent, card says ✅ SENT to whom, in the same conversation');
  ok(sheet.rows('Log').some(x => x.event === 'sent' && x.msg_id === d1.msg_id && /^reply → /.test(x.detail)), 'Log "sent" row (Sender duplicate guard sees it)');
  bt = await bot(cb(`send|${d1.msg_id}|${card3.ver}`));
  ok(/already sent/.test(bt.out[0].json.toast), '✅ again → "already sent", nothing re-sent');
  // Gmail failure → back to waiting, nothing marked sent
  bt = await bot(cb(`send|${dT.msg_id}|${draftVerOf(msg(dT.msg_id))}`));
  sheet.batchUpdate(bt.out[0].json.lock);
  const af2 = tail(await run('7', 'After bot send', [{ json: { error: { message: 'x' } } }], { nodes: { 'Bot route': bt.out, 'Read Sheet (bot)': bt.rb, 'Gmail: send (bot)': [{ json: { error: { message: '403 Units per minute per user' } } }] } }));
  ok(msg(dT.msg_id).status === 'awaiting_ok' && !msg(dT.msg_id).sent_at && /NOT SENT/.test(af2.card_text), 'Gmail error → draft back to awaiting_ok, card says NOT SENT');
  // intro: new thread
  bt = await bot(cb(`send|${dJ.msg_id}|${draftVerOf(msg(dJ.msg_id))}`));
  const rawJ = decodeRaw(bt.out[0].json.gmail_payload.raw);
  ok(bt.out[0].json.action === 'send' && !bt.out[0].json.gmail_payload.threadId && !/In-Reply-To/.test(rawJ) && /To: jane\.doe@example\.com/.test(rawJ), 'intro → brand-new email to the referred person (no thread)');
  // 🔁 regenerate + ❌ skip
  bt = await bot(cb(`regen|${dI.msg_id}|x`));
  ok(bt.out[0].json.action === 'rewrite' && bt.out[0].json.how === 'regen' && bt.out[0].json.llm_input.previous_draft === dI.body && bt.out[0].json.llm_input.mode === 'intro', '🔁 → new version asked with the previous draft');
  bt = await bot(cb(`skip|${dI.msg_id}|x`, 'old card'));
  tail([{ json: { data: bt.out[0].json.data, logs: bt.out[0].json.logs } }]);
  ok(msg(dI.msg_id).status === 'skipped' && /SKIPPED/.test(bt.out[0].json.card_text), '❌ → skipped, card says nothing sent');
  bt = await bot(cb(`send|${dI.msg_id}|${draftVerOf(msg(dI.msg_id))}`));
  ok(/skipped/.test(bt.out[0].json.toast), 'skipped draft can no longer be sent');
  // 13 Oct incident: Louai's "thank him" edit landed on Sofia's intro card → "Hi Alexander" to Sofia must not send
  sheet.set('Messages', dJ.msg_id, 'body', 'msg_id', 'Hi John,\n\nThank you for connecting me with Jane.\n\nBest regards,');
  bt = await bot(cb(`send|${dJ.msg_id}|${draftVerOf(msg(dJ.msg_id))}`));
  ok(bt.out[0].json.action === 'toast' && /Greeting says "John" but this email goes to Jane/.test(bt.out[0].json.toast), 'wrong name in the greeting → ✅ blocked (Sofia/Alexander mix-up)');
  bt = await bot(cb(`edit|${dT.msg_id}|x`));
  ok(bt.out[0].json.action === 'toast' && /Reply to this card/.test(bt.out[0].json.toast) && bt.out[0].json.toast.length <= 190, '✏️ → tells how to edit (toast ≤ 200 chars)');

  // ---- wf4: reply outside our thread (manual send, no thread id) found by inbox search ----
  const manual = sheet.rows('Messages').find(m => m.status === 'sent' && m.type === 'cold' && m.contact_id !== fm.contact_id && ![cA.contact_id, cB.contact_id].includes(m.contact_id));
  const mc = con(manual.contact_id), dom = String(mc.email).split('@')[1];
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  const sq = (await run('4', 'Inbox search query', read, { nodes: { 'Read Sheet': read } })).slice(1);
  ok(sq[0].json.q.includes(dom) && /newer_than:3d/.test(sq[0].json.q) && /-from:me/.test(sq[0].json.q), 'inbox search covers every domain we emailed');
  const th3 = await threadsToCheck(read, [{ id: 'o1', threadId: 'tnew' }, { id: 'r1', threadId: fm.gmail_thread_id }]);
  const oot = th3.find(x => x.json.thread_id === 'tnew');
  ok(oot && oot.json.oot_ids[0] === 'o1' && !th3.some(x => (x.json.oot_ids || []).includes('r1')), 'search hit in an unknown thread is fetched; known threads/replies are not doubled');
  const det6 = await run('4', 'Detect new replies', [{ json: { messages: [
    { id: 'o0', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Newsletter <news@' + dom + '>' }], body: { data: enc('old') } } },
    { id: 'o1', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `Sam Colleague <sam@${dom}>` }, { name: 'Subject', value: 'Your internship email' }, { name: 'Message-ID', value: '<o1@x>' }], body: { data: enc('Hi Louai, my colleague forwarded your email. Can you send your CV?') } } },
  ] } }], { nodes: { 'Read Sheet': read, 'Threads to check': [oot] } });
  ok(det6.length === 1 && det6[0].json.out_of_thread && det6[0].json.contact.contact_id === mc.contact_id && det6[0].json.msg.msg_id === manual.msg_id && det6[0].json.rfc_message_id === '<o1@x>', 'out-of-thread reply matched to the contact by domain (only messages the search found)');
  const c6 = await run('4', 'Check primary LLM (replies)', [{ json: llmResp({ category: 'interested', summary: 'Wants the CV.', next_step: 'Send CV.', referral_to: '' }) }], { nodes: { 'Detect new replies': det6 } });
  d = tail(await run('4', 'Apply replies (primary)', c6, { nodes: { 'Read Sheet': read } }));
  const ro1 = sheet.rows('Replies').find(x => x.reply_id === 'o1');
  ok(ro1 && ro1.thread_id === 'tnew' && ro1.from_name === 'Sam Colleague' && /inbox search/.test(ro1.action_taken), 'logged with its own thread, so the bot answers in that thread');
  read7 = rd7();
  const pk = await run('7', 'Pick replies to draft', read7, { nodes: { 'Read Sheet (drafter)': read7 } });
  const jo = pk[0].json.jobs.find(j => j.reply.reply_id === 'o1');
  ok(jo && jo.to_email === `sam@${dom}` && jo.target.first_name === 'Sam' && jo.thread_id === 'tnew', 'bot drafts to the colleague who wrote (greets Sam, not the original contact)');

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
  // 14 Oct: Gemini 429 + Groq 400 on every follow-up → one Telegram notice, no drafts, retried next run
  const fuDown = { error: { message: 'Request failed with status code 429', status: '429' } };
  const fchkDown = await run('5', 'Check primary LLM (follow-ups)', due.map(() => ({ json: fuDown })), { nodes: { 'Due follow-ups': due } });
  const fdown = (await run('5', 'Create follow-up drafts (fallback)', due.map(() => ({ json: fuDown })), { nodes: { 'Read Sheet': read, 'Check primary LLM (follow-ups)': fchkDown } }))[0].json;
  ok(due.length > 1 && fdown.appendMessages.length === 0 && fdown.notices.length === 1 && fdown.notices[0].split('\n•').length === due.length + 1 && fdown.logs.filter(l => l[3] === 'followup_llm_failed').length === due.length, `both LLMs down → ${due.length} failures in ONE notice, logged per contact, no drafts`);
  ok(/"json"|\bjson\b/i.test(due[0].json.req_fallback.messages.map(m => m.content).join(' ')), 'follow-up request mentions "json" (Groq json_object mode needs it)');
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

  // ---- manual-send guard: Gmail Sent has an email the sheet does not know → never send on top of it ----
  setNow('2026-10-12T09:10:00');
  const HAND1 = 'aaaabbbbccccdddd', PRIV = '1111222233334444';
  r = await send({ id: 'gNever', threadId: 'tNever' }, { messages: [{ id: HAND1, threadId: 'tHand1' }], resultSizeEstimate: 1 });
  const heldId = r && r.pick.msg.msg_id, heldTo = r && r.pick.realTo, heldC = r && r.pick.contact;
  ok(r && r.held && msg(heldId).status === 'held' && /^manual_check: .*aaaabbbbccccdddd/.test(msg(heldId).error) && !msg(heldId).sent_at, `guard: unknown email to ${heldTo} in Gmail Sent → ${heldId} NOT sent, on hold`);
  ok(r.held.notices.some(n => /NOT SENT/.test(n) && n.includes(heldTo)) && sheet.rows('Log').some(x => x.event === 'manual_send_detected' && x.msg_id === heldId), 'guard: bot-1 notice (a real conflict) + Log row');
  ok(new RegExp(`^in:sent \\(to:${heldTo.replace(/[.]/g, '\\.')} OR cc:`).test(r.pick.guard_q) && /after:\d+$/.test(r.pick.guard_q), `guard search is one cheap Gmail query (${r.pick.guard_q.slice(0, 60)}…)`);
  const known1 = sheet.rows('Messages').find(m => m.gmail_message_id);
  let r2 = await send({ id: 'gNever2', threadId: 'tNever2' }, { messages: [{ id: known1.gmail_message_id }], resultSizeEstimate: 1 });
  ok(!r2 || (r2.pick.msg.msg_id !== heldId && !r2.held), 'guard: an email the sheet already knows does not block (and the held row is not picked again)');
  if (r2 && r2.pick && msg(r2.pick.msg.msg_id).status === 'sent') { /* sent normally: fine */ }
  const rg = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }];
  const pg = await run('3', 'Pick next email', rg, { nodes: { 'Read Sheet': rg } });
  if (pg.length) {
    const ge = await run('3', 'Manual send guard', [{ json: { error: { message: '429' } } }], { nodes: { 'Read Sheet': rg, 'Pick next email': pg } });
    ok(!ge[0].json.guard_ok && !ge[0].json.data.some(d => /![A-Z]+\d+$/.test(d.range) && d.values[0][0] === 'sending'), 'guard: Gmail search fails → nothing sent and nothing locked this run');
  } else ok(true, 'guard: (queue empty, error case skipped)');

  // ================= WF8 GMAIL ↔ SHEET SYNC =================
  console.log('\nWF8 Gmail-sheet sync');
  const { DateTime: LDT } = require('luxon');
  const T0 = Date.now() + 10 * 60000; // replies in this test carry the real clock
  const at = ms => LDT.fromMillis(ms).setZone('Europe/Stockholm');
  setNow(at(T0).toISO({ includeOffset: false }));
  sheet.append('Config', [['LAST_RUN_SYNC', '', 'written by workflow 8']]);
  const rdS = () => [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies']) }];
  // state Louai created by hand: a stuck "sending" row, a contact set to do_not_contact, a row held for an email that is private
  const queued = sheet.rows('Messages').filter(m => m.status === 'ready' && !m.sent_at && m.msg_id !== heldId && m.contact_id !== heldC.contact_id);
  const stuckRow = queued[0], dncRow = queued.find(m => m.contact_id !== stuckRow.contact_id), privRow = queued.find(m => ![stuckRow.contact_id, dncRow.contact_id].includes(m.contact_id));
  sheet.set('Messages', stuckRow.msg_id, 'status', 'msg_id', 'sending'); sheet.set('Messages', stuckRow.msg_id, 'updated_at', 'msg_id', at(T0 - 3 * 3600e3).toISO());
  sheet.set('Contacts', dncRow.contact_id, 'contact_status', 'contact_id', 'do_not_contact');
  sheet.set('Messages', privRow.msg_id, 'status', 'msg_id', 'held'); sheet.set('Messages', privRow.msg_id, 'error', 'msg_id', `manual_check: Gmail Sent has 1 email(s): ${PRIV}`);
  // Sender busy (row locked a minute ago) → sync does not run at all
  sheet.set('Messages', stuckRow.msg_id, 'updated_at', 'msg_id', at(T0 - 60000).toISO());
  let rs = rdS();
  ok((await run('8', 'Sync plan', rs, { nodes: { 'Read Sheet': rs } })).length === 0, 'sync waits while a send is in progress (row in "sending" < 20 min)');
  sheet.set('Messages', stuckRow.msg_id, 'updated_at', 'msg_id', at(T0 - 3 * 3600e3).toISO());
  rs = rdS();
  const plan = await run('8', 'Sync plan', rs, { nodes: { 'Read Sheet': rs } });
  const after = Number(plan[0].json.q.match(/after:(\d+)/)[1]);
  ok(/^in:sent after:\d+$/.test(plan[0].json.q) && after * 1000 <= T0 - 3 * 3600e3 - 9 * 60000 && plan[0].json.extra.includes(HAND1) && plan[0].json.extra.includes(PRIV), 'plan: one Sent search reaching back before the stuck lock + the Gmail ids the guards found');
  const openDraft = sheet.rows('Messages').find(m => m.status === 'awaiting_ok' && m.type === 'reply' && m.gmail_thread_id);
  const hdr = (to, subject, id, cc) => [{ name: 'From', value: 'Louai <owner@example.com>' }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []), { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }];
  const gm = (id, threadId, ms, headers, text) => ({ id, threadId, labelIds: ['SENT'], internalDate: String(ms), payload: { mimeType: 'text/plain', headers, body: { data: enc(text) } } });
  const listed = { messages: [{ id: HAND1 }, { id: known1.gmail_message_id }, { id: PRIV }, { id: 'eeee000011112222' }, { id: 'ffff000011112222' }], resultSizeEstimate: 5 };
  const un = await run('8', 'Unknown sent mail', [{ json: listed }], { nodes: { 'Read Sheet': rs, 'Sync plan': plan } });
  ok(un.length === 4 && !un.some(x => x.json.id === known1.gmail_message_id) && un.every(x => x.json.list_ok), 'only emails the sheet does not know are fetched (one by one, batched)');
  const mails = [
    gm(HAND1, 'tHand1', T0 - 9 * 60000, hdr(`${heldC.full_name} <${heldTo}>`, 'Thesis internship question', HAND1), 'Hi there,\n\nI wrote this one myself.\n\nBest regards,\nLouai'),
    gm(PRIV, 'tPriv', T0 - 8 * 60000, hdr('Chess Club <club@chess.example>', 'Visit on Friday', PRIV), 'Can I join on Friday?'),
    gm('eeee000011112222', openDraft.gmail_thread_id, T0 - 7 * 60000, hdr(`Someone <${openDraft.to_email}>`, 'Re: ' + openDraft.subject, 'e1'), 'Thanks a lot, I answered by hand.\n\nOn Mon someone wrote:\n> old'),
    gm('ffff000011112222', 'tVeryNew', T0 - 60000, hdr(`x <${heldTo}>`, 'just now', 'f1'), 'sent a minute ago'),
  ];
  const before = sheet.rows('Messages').length;
  let sy = tail(await run('8', 'Reconcile (gmail)', J(mails), { nodes: { 'Read Sheet': rs, 'Unknown sent mail': un } }));
  const hr = msg(heldId);
  ok(hr.status === 'sent' && hr.gmail_message_id === HAND1 && hr.gmail_thread_id === 'tHand1' && hr.subject === 'Thesis internship question' && /I wrote this one myself/.test(hr.body) && /sent by hand/.test(hr.qc_model) && hr.followup_due, 'cold email sent by hand → the queued row is marked sent (real text, Gmail ids, follow-up date)');
  ok(sheet.rows('Log').some(x => x.workflow === 'Sync' && x.event === 'sent' && x.msg_id === heldId && x.detail.startsWith(`cold → ${heldTo}`)), 'Log "sent" row from Sync (the Sender duplicate guard reads it)');
  ok(msg(openDraft.msg_id).status === 'skipped' && sy.bot_notes.some(t => t.includes(openDraft.msg_id) && /by hand/.test(t)), 'reply answered by hand in Gmail → the bot draft is closed + note in the reply bot');
  const handReply = sheet.rows('Messages').slice(before).find(m => m.gmail_message_id === 'eeee000011112222');
  ok(handReply && handReply.type === 'reply' && handReply.status === 'sent' && handReply.qc_model === 'sent by hand' && /-R\d+$/.test(handReply.msg_id) && handReply.body === 'Thanks a lot, I answered by hand.', `manual reply added to Messages as ${handReply && handReply.msg_id} (quoted text stripped)`);
  ok(!sheet.rows('Messages').some(m => m.gmail_message_id === PRIV) && !sheet.rows('Messages').some(m => m.gmail_message_id === 'ffff000011112222'), 'private email ignored; an email from the last 5 minutes waits for the next run');
  ok(msg(stuckRow.msg_id).status === 'ready' && /never sent/.test(msg(stuckRow.msg_id).error) && sy.notices.some(n => n.includes(stuckRow.msg_id)), 'row stuck in "sending" and not in Gmail Sent → back to ready (+ bot-1 notice)');
  ok(msg(dncRow.msg_id).status === 'cancelled' && /do_not_contact/.test(msg(dncRow.msg_id).error), 'contact set to do_not_contact by hand → its queued email is cancelled');
  ok(msg(privRow.msg_id).status === 'ready' && /released by sync/.test(msg(privRow.msg_id).error), 'row held for an email that turned out not to be outreach → released');
  ok(sheet.rows('Config').find(x => x.key === 'LAST_RUN_SYNC').value, 'heartbeat LAST_RUN_SYNC written');
  // same emails again → nothing changes (idempotent)
  rs = rdS();
  const n1 = sheet.rows('Messages').length;
  const plan2 = await run('8', 'Sync plan', rs, { nodes: { 'Read Sheet': rs } });
  const un2 = await run('8', 'Unknown sent mail', [{ json: listed }], { nodes: { 'Read Sheet': rs, 'Sync plan': plan2 } });
  ok(!un2.some(x => [HAND1, 'eeee000011112222'].includes(x.json.id)), 'second run: logged emails are known now (not fetched again)');
  sy = tail(await run('8', 'Reconcile (gmail)', J(mails.filter(m => un2.some(x => x.json.id === m.id))), { nodes: { 'Read Sheet': rs, 'Unknown sent mail': un2 } }));
  ok(sheet.rows('Messages').length === n1 && !sy.bot_notes.length, 'second run adds nothing (no duplicates)');
  // nothing new in Gmail → sheet-only path still cleans up and writes the heartbeat
  rs = rdS();
  const none = await run('8', 'Unknown sent mail', [{ json: { resultSizeEstimate: 0 } }], { nodes: { 'Read Sheet': rs, 'Sync plan': [{ json: { extra: [] } }] } });
  ok(none.length === 1 && none[0].json.none, 'nothing new → one "none" item (IF sends it to the sheet-only branch)');
  sy = await run('8', 'Reconcile (none)', none, { nodes: { 'Read Sheet': rs, 'Unknown sent mail': none } });
  ok(sy[0].json.data.length >= 1 && !sy[0].json.appendMessages.length, 'sheet-only branch: heartbeat, no appends');
  // the Sender now treats the hand-sent email as sent
  const rq = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Log']) }];
  setNow('2026-10-14T09:00:00');
  const pq = await run('3', 'Pick next email', rq, { nodes: { 'Read Sheet': rq } });
  ok(!pq.length || pq[0].json.msg.msg_id !== heldId, 'Sender never re-sends the email Louai sent by hand');
  setNow(at(T0).toISO({ includeOffset: false }));

  // ================= WF6 REPORT + WF0 =================
  console.log('\nWF6 report / WF0 error');
  read = [{ json: sheet.batchGet(['Config', 'Contacts', 'Messages', 'Replies', 'Log']) }];
  const rep = (await run('6', 'Build daily report', read, { nodes: { 'Read Sheet': read } })).map(x => x.json.html);
  const repTxt = rep.map(plain);
  ok(rep.length === 3 && rep.every(h => h.length <= 4096), `report = 3 Telegram messages sent together (${rep.map(h => h.length).join(' / ')} chars)`);
  ok(/^✉️ <b>EMAILS SENT TODAY/.test(rep[0]) && /<pre>Time  Company +Receiver\n/.test(rep[0]) && repTxt[0].includes(heldTo) && /\d\d:\d\d .*\(reply, by hand\)/.test(repTxt[0]), 'message 1: table with time, company, receiver + address (hand-sent emails marked)');
  ok(/^📩 <b>REPLIES TODAY · \d+/.test(rep[1]) && rep[1].includes('🟢 Positive') && rep[1].includes('🤖 Auto-reply') && rep[1].includes(`&lt;${fc.email}&gt;`) && repTxt[1].includes('Wants a call Tuesday 14:00.'), 'message 2: every reply with who (address), company, verdict and summary');
  ok(/^📊 <b>DAY SUMMARY/.test(rep[2]) && /PROBLEMS TODAY/.test(rep[2]) && /PIPELINE/.test(rep[2]) && /sync \d\d:\d\d/.test(rep[2]) && !/NEEDS YOU|Waiting for your approval/.test(rep.join('')), 'message 3: problems + pipeline + health in ONE message, no "needs you" section');
  ok(rep.every(h => (h.match(/<pre>/g) || []).length === (h.match(/<\/pre>/g) || []).length && (h.match(/<b>/g) || []).length === (h.match(/<\/b>/g) || []).length), 'report HTML is balanced (Telegram rejects broken tags)');
  console.log('\n---- REPORT PREVIEW ----\n' + repTxt.join('\n\n====\n\n').slice(0, 3500) + '\n------------------------');
  const er = await run('0', 'Format error', [{ json: { execution: { id: 1, url: 'https://n8n/x', lastNodeExecuted: 'Read Sheet', error: { message: 'Sheet "Messages" is missing column(s): approved' } }, workflow: { name: 'Outreach 3 · Sender' } } }]);
  ok(/header/.test(er[0].json.text) && er[0].json.logs.length === 1, 'error handler formats alert with fix hint');
  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch(e => { console.error('\n✘ FAILED:', e.message); console.error(e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); });

function DateTime_add(isoS, mins) { const { DateTime } = require('luxon'); return DateTime.fromISO(isoS, { zone: 'Europe/Stockholm' }).plus({ minutes: mins }).toISO({ includeOffset: false, suppressMilliseconds: true }); }
