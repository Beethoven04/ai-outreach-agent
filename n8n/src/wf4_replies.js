// ---- NODE: Inbox search query ----
// @node rw_search
// Two cheap Gmail searches (always 2 items, so the chain continues):
// 1) recent mail not from us → only watched threads with new activity are fetched (13 Oct: fetching ~100 threads
//    every run hit Gmail's 'Total Query Cost' quota and half the fetches failed);
// 2) mail from every address/domain we emailed → replies outside our threads (new thread, manual sends, Dreamdata case).
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, cfg = configOf(T.Config);
const n = now();
const FREEMAIL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'aol.com'];
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const terms = new Set();
for (const m of M.rows) {
  const sent = parseDT(m.sent_at);
  if (!sent || n.diff(sent, 'days').days > cfg.num('REPLY_WATCH_DAYS', 60)) continue;
  const email = norm(str(m.to_email) || str((contacts[str(m.contact_id)] || {}).email));
  if (!EMAIL_RE.test(email)) continue;
  const dom = email.split('@')[1];
  terms.add(FREEMAIL.includes(dom) ? email : dom);
}
const q = terms.size && cfg.bool('INBOX_SEARCH', true)
  ? `in:inbox newer_than:${cfg.num('INBOX_SEARCH_DAYS', 3)}d -from:me from:(${[...terms].sort().join(' OR ')})` : '';
// look back at least to the last successful run (+1 day), so a stopped server misses nothing
const last = parseDT(cfg.raw.LAST_RUN_REPLIES);
const back = Math.min(30, Math.max(cfg.num('INBOX_SEARCH_DAYS', 3), last ? Math.ceil(n.diff(last, 'days').days) + 1 : 30));
return [{ json: { kind: 'activity', q: `newer_than:${back}d -from:me -in:sent -in:drafts -in:chats` } }, { json: { kind: 'domains', q, terms: terms.size } }];

// ---- NODE: Threads to check ----
// @node rw_threads
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, cfg = configOf(T.Config);
requireCols(T.Replies, ['reply_id', 'received_at', 'msg_id', 'contact_id', 'full_name', 'company', 'from_email', 'kind', 'category', 'summary', 'next_step', 'snippet', 'thread_link', 'action_taken']);
const n = now();
const days = cfg.num('REPLY_WATCH_DAYS', 60);
const threads = {};
for (const m of M.rows) {
  const tid = str(m.gmail_thread_id).trim();
  const sent = parseDT(m.sent_at);
  if (!tid || !sent || n.diff(sent, 'days').days > days) continue;
  (threads[tid] = threads[tid] || []).push(m);
}
// search 1: only threads with new mail; on any doubt (error, more than one page) fetch every watched thread as before
const act = ($input.all()[0] || {}).json || {};
const full = !!(act.error || act.nextPageToken || !Array.isArray(act.messages) && act.resultSizeEstimate !== 0);
const active = new Set((act.messages || []).map(x => x.threadId));
const out = Object.keys(threads).filter(tid => full || active.has(tid)).map(tid => ({ json: { thread_id: tid, msg_ids: threads[tid].map(m => str(m.msg_id)) } }));
// search 2: hits in threads we do not watch → fetched too, matched to a contact by sender address/domain later
const sr = ($input.all()[1] || {}).json || {};
if ($('Inbox search query').all()[1].json.q && !sr.error) {
  const seen = new Set(T.Replies.rows.map(r => str(r.reply_id)));
  const oot = {};
  for (const x of (sr.messages || [])) {
    if (threads[x.threadId] || seen.has(x.id)) continue;
    (oot[x.threadId] = oot[x.threadId] || []).push(x.id);
  }
  for (const tid of Object.keys(oot)) out.push({ json: { thread_id: tid, msg_ids: [], oot_ids: oot[tid] } });
}
return out;

// ---- NODE: Detect new replies ----
// @node rw_detect
const REPLY_SYSTEM = __REPLY_SYSTEM__;
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, cfg = configOf(T.Config);
const seen = new Set(R.rows.map(r => str(r.reply_id)));
const me = [cfg.str('FROM_EMAIL', '__OWNER_FROM__'), ...__OWNER_OTHER_EMAILS__].map(norm);
const byId = Object.fromEntries(M.rows.map(m => [str(m.msg_id), m]));
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
// out-of-thread mail: match the sender to a contact we emailed (exact address first, then same domain), newest sent message wins
const sentTo = M.rows.filter(m => parseDT(m.sent_at)).map(m => ({ m, c: contacts[str(m.contact_id)] || {}, email: norm(str(m.to_email) || str((contacts[str(m.contact_id)] || {}).email)) }))
  .sort((a, b) => parseDT(b.m.sent_at) - parseDT(a.m.sent_at));
function matchSender(fromEmail) {
  const dom = fromEmail.split('@')[1] || '';
  return sentTo.find(x => x.email === fromEmail) || sentTo.find(x => x.email.split('@')[1] === dom && !/^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|aol)\.com$|^proton(mail)?\.(me|com)$/.test(dom)) || null;
}
const out = [];
$input.all().forEach((it, i) => {
  const ctx = $('Threads to check').itemMatching(i).json;
  const th = it.json;
  if (th.error) { out.push({ json: { kind: 'thread_error', thread_id: ctx.thread_id, error: JSON.stringify(th.error).slice(0, 300), needs_llm: false } }); return; }
  const ours = ctx.msg_ids.map(id => byId[id]).filter(Boolean).sort((a, b) => parseDT(a.sent_at) - parseDT(b.sent_at));
  const oot = new Set(ctx.oot_ids || []);
  for (const gm of (th.messages || [])) {
    if (seen.has(gm.id)) continue;
    if (oot.size && !oot.has(gm.id)) continue;
    if ((gm.labelIds || []).includes('SENT') || (gm.labelIds || []).includes('DRAFT')) continue;
    const H = {}; for (const h of ((gm.payload && gm.payload.headers) || [])) H[h.name.toLowerCase()] = h.value;
    const from = str(H.from);
    const fromEmail = norm((from.match(/<([^>]+)>/) || [, from])[1]);
    if (me.includes(fromEmail)) continue;
    let last = ours[ours.length - 1], c = last ? contacts[str(last.contact_id)] || {} : {};
    if (oot.size) { const hit = matchSender(fromEmail); if (!hit) continue; last = hit.m; c = hit.c; }
    if (!last) continue;
    const clean = stripQuoted(gmailText(gm.payload)).slice(0, 2500) || str(gm.snippet);
    const subj = str(H.subject);
    let kind = 'human';
    if (/mailer-daemon|postmaster/i.test(fromEmail) || /multipart\/report/i.test(str(H['content-type'])) || /(delivery status notification|undeliver|delivery has failed|mail delivery failed|returned mail|address not found)/i.test(subj)) kind = 'bounce';
    else if ((H['auto-submitted'] && !/^no$/i.test(H['auto-submitted'])) || H['x-autoreply'] || H['x-autorespond'] || /auto_reply|auto-reply/i.test(str(H['precedence'])) || /(out of office|automatic reply|auto[- ]?reply|autosvar|frånvaro|fraværende|ikke til stede|abwesenheit|absence|on leave|on vacation|semester)/i.test(subj)) kind = 'auto_reply';
    const user = { is_auto_reply: kind === 'auto_reply', original_email: { subject: str(last.subject), body: str(last.body) }, reply: { from, subject: subj, text: clean } };
    const base = { temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: REPLY_SYSTEM }, { role: 'user', content: JSON.stringify(user) }] };
    out.push({ json: {
      kind, needs_llm: kind === 'human' || kind === 'auto_reply', // auto-replies can carry a referral ("mailbox closed, contact X")
      reply_id: gm.id, thread_id: ctx.thread_id, out_of_thread: oot.size > 0,
      rfc_message_id: str(H['message-id']), references: str(H.references),
      received_at: DateTime.fromMillis(Number(gm.internalDate || Date.now())).setZone(TZ).toISO({ suppressMilliseconds: true }),
      from, from_email: fromEmail, subject: subj, text: clean, msg: last, contact: c,
      req_primary: { model: cfg.str('LLM_PRIMARY_MODEL', 'gemini-3.5-flash'), ...base },
      req_fallback: { model: cfg.str('LLM_FALLBACK_MODEL', 'openai/gpt-oss-120b'), reasoning_effort: 'low', ...base },
    } });
  }
});
return out;

// ---- NODE: Check primary LLM (replies) ----
// @node rw_check_primary
return $input.all().map((it, i) => {
  const ctx = $('Detect new replies').itemMatching(i).json;
  let llm = null, llm_error = '';
  try {
    if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
    llm = parseLLMJson(it.json.choices[0].message.content);
    if (!llm.category) throw new Error('no category');
  } catch (e) { llm = null; llm_error = e.message; }
  return { json: { ...ctx, llm, llm_ok: !!llm, llm_error } };
});

// ---- NODE: Apply replies ----
// @node rw_apply
const VIA = '__VIA__'; // 'none' | 'primary' | 'fallback'
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies;
const W = Writer(), logs = [], notices = [], appendReplies = [], appendContacts = [], appendMessages = [];
const knownEmails = new Set(C.rows.map(x => norm(x.email)).filter(Boolean));
let nextC = Math.max(0, ...C.rows.map(x => Number((str(x.contact_id).match(/^C(\d+)$/) || [, 0])[1])).filter(n => n < 900)) + 1;
const companyOf = c => norm(str(c.company).replace(/\s*\(.*\)\s*/g, ''));
const CATS = ['interested', 'question', 'referral', 'not_now', 'refusal', 'do_not_contact', 'auto_reply', 'other'];
$input.all().forEach((it, i) => {
  let ctx, llm = null, err = '';
  if (VIA === 'none' || VIA === 'primary') { ctx = it.json; llm = ctx.llm || null; err = ctx.llm_error || ''; }
  else {
    ctx = $('Check primary LLM (replies)').itemMatching(i).json;
    try {
      if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
      llm = parseLLMJson(it.json.choices[0].message.content);
      if (!llm.category) throw new Error('no category');
    } catch (e) { llm = null; err = `primary: ${ctx.llm_error} | fallback: ${e.message}`; }
  }
  if (ctx.kind === 'thread_error') {
    logs.push(logRow('Replies', 'error', 'thread_fetch_failed', '', '', `${ctx.thread_id}: ${ctx.error}`));
    return;
  }
  const c = ctx.contact || {}, m = ctx.msg;
  let category = ctx.kind === 'bounce' ? 'bounce'
    : ctx.kind === 'auto_reply' ? (llm && llm.category === 'referral' && str(llm.referral_to || llm.referral_email).trim() ? 'referral' : 'auto_reply')
    : (llm && CATS.includes(llm.category) ? llm.category : 'unclassified');
  const actions = [];
  const link = `https://mail.google.com/mail/u/0/#all/${ctx.thread_id}`;
  if (category !== 'auto_reply') {
    // stop every pending follow-up for this contact
    const pending = M.rows.filter(x => str(x.contact_id) === str(c.contact_id) && /^fu\d$/.test(str(x.type)) && ['', 'draft', 'needs_fix', 'ready', 'held'].includes(str(x.status)));
    pending.forEach(x => W.setMany(M, x._row, { status: 'cancelled', error: `cancelled: ${category} on ${iso()}`, updated_at: iso() }));
    if (pending.length) actions.push(`${pending.length} follow-up(s) cancelled`);
    if (m && m._row) W.setMany(M, m._row, { status: category === 'bounce' ? 'bounced' : 'replied', reply_at: ctx.received_at, updated_at: iso() });
    if (c._row) {
      // 'referred' stops mails to this person but, unlike 'replied', does not put colleagues on hold in the Sender
      const cs = category === 'bounce' ? 'bounced' : category === 'do_not_contact' ? 'do_not_contact' : ['refusal', 'not_now'].includes(category) ? 'refused' : category === 'referral' ? 'referred' : 'replied';
      const upd = { contact_status: cs };
      if (category === 'bounce') Object.assign(upd, { email_status: 'invalid', email_detail: `bounced ${iso()}` });
      W.setMany(C, c._row, upd);
      actions.push(`contact_status=${cs}`);
    }
    // hold colleagues at the same company who have not been emailed yet
    const mates = C.rows.filter(x => c.company && companyOf(x) === companyOf(c) && str(x.contact_id) !== str(c.contact_id));
    const mateIds = new Set(mates.map(x => str(x.contact_id)));
    const held = M.rows.filter(x => mateIds.has(str(x.contact_id)) && !str(x.sent_at) && ['', 'draft', 'needs_fix', 'ready'].includes(str(x.status)));
    if (!['bounce', 'referral'].includes(category)) held.forEach(x => W.setMany(M, x._row, { status: 'held', error: `held: ${c.full_name || c.first_name} at ${c.company} replied (${category})`, updated_at: iso() }));
    if (!['bounce', 'referral'].includes(category) && held.length) actions.push(`${held.length} colleague email(s) at ${c.company} put on hold`);
  }
  if (category === 'referral' && llm) {
    // add the referred person to Contacts (the finder verifies the address); never twice
    const rEmail = norm((str(llm.referral_email).match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/i) || [''])[0]);
    const rName = str(llm.referral_name).trim();
    if ((rEmail || rName) && !(rEmail && knownEmails.has(rEmail))) {
      const id = 'C' + String(nextC++).padStart(3, '0');
      const parts = rName.split(/\s+/).filter(Boolean);
      appendContacts.push(rowArray(C, {
        contact_id: id, company_no: c.company_no, company: c.company, company_domain: c.company_domain || (rEmail.split('@')[1] || ''),
        first_name: parts[0] || '', last_name: parts.slice(1).join(' '), full_name: rName, role: str(llm.referral_role).trim(), country: c.country,
        email: rEmail, email_source: rEmail ? 'referral' : '', email_status: '', email_attempts: 0, allow_risky: false, contact_status: 'active',
        notes: `Referral from ${c.full_name || c.first_name} (${m ? m.msg_id : '?'}) on ${ctx.received_at.slice(0, 10)}: "${str(llm.referral_to).slice(0, 200)}". Needs a cold draft.`,
      }));
      if (rEmail) knownEmails.add(rEmail);
      actions.push(`referral added to Contacts as ${id}`);
    }
    // thank-you / intro drafts are written by workflow 7 (Reply assistant) from the Replies row below
  }
  if (ctx.out_of_thread) actions.push('found by inbox search (outside our thread)');
  const rEmailOut = llm && category === 'referral' ? norm((str(llm.referral_email).match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/i) || [''])[0]) : '';
  appendReplies.push(rowArray(R, {
    reply_id: ctx.reply_id, received_at: ctx.received_at, msg_id: m ? m.msg_id : '', contact_id: c.contact_id, full_name: c.full_name, company: c.company,
    from_email: ctx.from_email, kind: ctx.kind, category, summary: llm ? str(llm.summary) : (ctx.kind === 'human' ? `LLM failed: ${err.slice(0, 150)}` : ''),
    next_step: llm ? str(llm.next_step) + (llm.referral_to ? ` | referral: ${llm.referral_to}` : '') : '', snippet: ctx.text.slice(0, 500), thread_link: link, action_taken: actions.join('; '),
    // used by the Reply assistant (wf7) to answer this exact message in its thread
    thread_id: ctx.thread_id, from_name: str(ctx.from).replace(/<[^>]*>/, '').replace(/"/g, '').trim(), rfc_message_id: ctx.rfc_message_id || '', references: ctx.references || '', subject: ctx.subject, text: ctx.text.slice(0, 2500),
    referral_name: llm && category === 'referral' ? str(llm.referral_name).trim() : '', referral_email: rEmailOut,
  }));
  logs.push(logRow('Replies', category === 'bounce' ? 'warn' : 'info', `reply_${category}`, m ? m.msg_id : '', c.contact_id, `${ctx.from} | ${ctx.subject} | ${actions.join('; ')}`));
  // Telegram (bot 1) gets only problems: a bounce means an address is dead. Human replies get a draft card in the reply bot (wf7),
  // and every reply is listed in the daily report.
  if (category === 'bounce') notices.push(`📛 BOUNCE: ${m ? m.msg_id : '?'} to ${c.full_name || c.first_name || '?'} (${c.company || '?'}) <${str(m && m.to_email) || c.email || '?'}> did not arrive.\n` +
    `"${ctx.text.slice(0, 300)}"\n${actions.join('; ')}\n✔ Fix: find another address for this person and add a new contact row if you want to retry.\nThread: ${link}`);
});
heartbeat(W, T, 'LAST_RUN_REPLIES');
return [{ json: { data: W.data, logs, notices, appendReplies, appendContacts, appendMessages } }];
