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
return Object.keys(threads).map(tid => ({ json: { thread_id: tid, msg_ids: threads[tid].map(m => str(m.msg_id)) } }));

// ---- NODE: Detect new replies ----
// @node rw_detect
const REPLY_SYSTEM = __REPLY_SYSTEM__;
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, cfg = configOf(T.Config);
const seen = new Set(R.rows.map(r => str(r.reply_id)));
const me = [cfg.str('FROM_EMAIL', '__OWNER_FROM__'), ...__OWNER_OTHER_EMAILS__].map(norm);
const byId = Object.fromEntries(M.rows.map(m => [str(m.msg_id), m]));
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const b64 = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function partText(p, mime) {
  if (!p) return '';
  if (p.mimeType === mime && p.body && p.body.data) return b64(p.body.data);
  for (const q of (p.parts || [])) { const t = partText(q, mime); if (t) return t; }
  return '';
}
function stripQuoted(t) {
  const lines = t.replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^(on .+wrote:|den .+skrev:|d\. .+skrev|le .+a écrit|am .+schrieb|-{2,}\s*original message|from:\s|fra:\s|från:\s|sent from my)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}
const out = [];
$input.all().forEach((it, i) => {
  const ctx = $('Threads to check').itemMatching(i).json;
  const th = it.json;
  if (th.error) { out.push({ json: { kind: 'thread_error', thread_id: ctx.thread_id, error: JSON.stringify(th.error).slice(0, 300), needs_llm: false } }); return; }
  const ours = ctx.msg_ids.map(id => byId[id]).filter(Boolean).sort((a, b) => parseDT(a.sent_at) - parseDT(b.sent_at));
  const last = ours[ours.length - 1];
  const c = contacts[str(last.contact_id)] || {};
  for (const gm of (th.messages || [])) {
    if (seen.has(gm.id)) continue;
    if ((gm.labelIds || []).includes('SENT') || (gm.labelIds || []).includes('DRAFT')) continue;
    const H = {}; for (const h of ((gm.payload && gm.payload.headers) || [])) H[h.name.toLowerCase()] = h.value;
    const from = str(H.from);
    const fromEmail = norm((from.match(/<([^>]+)>/) || [, from])[1]);
    if (me.includes(fromEmail)) continue;
    let text = partText(gm.payload, 'text/plain');
    if (!text) text = partText(gm.payload, 'text/html').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const clean = stripQuoted(text).slice(0, 2500) || str(gm.snippet);
    const subj = str(H.subject);
    let kind = 'human';
    if (/mailer-daemon|postmaster/i.test(fromEmail) || /multipart\/report/i.test(str(H['content-type'])) || /(delivery status notification|undeliver|delivery has failed|mail delivery failed|returned mail|address not found)/i.test(subj)) kind = 'bounce';
    else if ((H['auto-submitted'] && !/^no$/i.test(H['auto-submitted'])) || H['x-autoreply'] || H['x-autorespond'] || /auto_reply|auto-reply/i.test(str(H['precedence'])) || /(out of office|automatic reply|auto[- ]?reply|autosvar|frånvaro|fraværende|ikke til stede|abwesenheit|absence|on leave|on vacation|semester)/i.test(subj)) kind = 'auto_reply';
    const user = { is_auto_reply: kind === 'auto_reply', original_email: { subject: str(last.subject), body: str(last.body) }, reply: { from, subject: subj, text: clean } };
    const base = { temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: REPLY_SYSTEM }, { role: 'user', content: JSON.stringify(user) }] };
    out.push({ json: {
      kind, needs_llm: kind === 'human' || kind === 'auto_reply', // auto-replies can carry a referral ("mailbox closed, contact X")
      reply_id: gm.id, thread_id: ctx.thread_id,
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
const ICON = { interested: '🟢', question: '🟡', referral: '🔀', not_now: '🟠', refusal: '🔴', do_not_contact: '⛔', auto_reply: '🤖', bounce: '📛', other: '⚪', unclassified: '⚪' };
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
    // a person (not a robot) gave the referral: draft a short thank-you in the same thread, for QC + approval
    const ty = str(llm.thank_you_draft).trim();
    if (ctx.kind === 'human' && ty && m) {
      const rid = `${str(m.msg_id)}-R1`;
      if (!M.rows.some(x => str(x.msg_id) === rid)) {
        appendMessages.push(rowArray(M, {
          msg_id: rid, contact_id: c.contact_id, company: c.company, first_name: c.first_name, type: 'reply', parent_msg_id: m.msg_id,
          subject: 'Re: ' + str(m.subject).replace(/^re:\s*/i, ''), body: ty, status: 'draft', approved: false, to_email: ctx.from_email,
          gmail_thread_id: m.gmail_thread_id, updated_at: iso(), qc_reasons: 'thank-you reply drafted from the referral; waiting for QC',
        }));
        actions.push(`thank-you reply drafted as ${rid}`);
      }
    }
  }
  appendReplies.push(rowArray(R, {
    reply_id: ctx.reply_id, received_at: ctx.received_at, msg_id: m ? m.msg_id : '', contact_id: c.contact_id, full_name: c.full_name, company: c.company,
    from_email: ctx.from_email, kind: ctx.kind, category, summary: llm ? str(llm.summary) : (ctx.kind === 'human' ? `LLM failed: ${err.slice(0, 150)}` : ''),
    next_step: llm ? str(llm.next_step) + (llm.referral_to ? ` | referral: ${llm.referral_to}` : '') : '', snippet: ctx.text.slice(0, 500), thread_link: link, action_taken: actions.join('; '),
  }));
  logs.push(logRow('Replies', category === 'bounce' ? 'warn' : 'info', `reply_${category}`, m ? m.msg_id : '', c.contact_id, `${ctx.from} | ${ctx.subject} | ${actions.join('; ')}`));
  notices.push(`${ICON[category] || '📩'} REPLY — ${category.toUpperCase()}\n` +
    `From: ${ctx.from}\nContact: ${c.full_name || c.first_name || '?'} (${c.role || 'role ?'}) @ ${c.company || '?'}\n` +
    `Subject: ${ctx.subject}\nReceived: ${ctx.received_at}\n` +
    (llm ? `Summary: ${llm.summary}\nSuggested next step: ${llm.next_step}${llm.referral_to ? `\nReferral to: ${llm.referral_to}` : ''}\n` : (ctx.kind === 'human' ? `⚠️ Could not classify automatically (${err.slice(0, 120)}). Read it yourself.\n` : '')) +
    `\n"${ctx.text.slice(0, 700)}"\n\nOpen thread: ${link}\nActions: ${actions.join('; ') || 'none (auto-reply: follow-ups continue)'}\n` +
    (category === 'do_not_contact' ? 'This person is now do_not_contact: they will never be emailed again.' : category === 'bounce' ? 'Address is dead. Find another address, then create a new contact/message row if you want to retry.' : category === 'referral' ? 'New contact added: write a cold draft for them. Any thank-you reply needs your ✅ before it is sent.' : 'You decide whether to reply: nothing is sent automatically.'));
});
heartbeat(W, T, 'LAST_RUN_REPLIES');
return [{ json: { data: W.data, logs, notices, appendReplies, appendContacts, appendMessages } }];
