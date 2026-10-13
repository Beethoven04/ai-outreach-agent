// ---- NODE: Pick replies to draft ----
// @node rd_pick
// New rows in Replies (written by workflow 4) → one draft per human reply (same thread) and, for a referral with an
// address, one intro email to the referred person (new thread). Nothing is sent here: drafts wait for ✅ in the reply bot.
const T = tablesFrom($('Read Sheet (drafter)').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, cfg = configOf(T.Config);
requireCols(R, ['reply_id', 'received_at', 'msg_id', 'contact_id', 'from_email', 'kind', 'category', 'thread_link', 'thread_id', 'from_name', 'rfc_message_id', 'references', 'subject', 'text', 'referral_name', 'referral_email', 'draft_msg_id']);
requireCols(M, ['msg_id', 'contact_id', 'type', 'parent_msg_id', 'subject', 'body', 'status', 'approved', 'to_email', 'gmail_thread_id', 'sent_at', 'reply_id', 'error', 'updated_at']);
if (!cfg.bool('REPLY_DRAFTS_ENABLED', true)) return [];
const since = parseDT(cfg.raw.REPLY_DRAFTS_SINCE) || now().minus({ days: 2 }); // never draft for old replies (raw: Sheets may store it as a date serial)
const HUMAN = ['interested', 'question', 'referral', 'not_now', 'refusal', 'other', 'unclassified'];
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const byId = Object.fromEntries(M.rows.map(m => [str(m.msg_id), m]));
const facts = profileFacts(T);
const ids = new Set(M.rows.map(m => str(m.msg_id)));
const nextId = (parent, letter) => { let k = 1; while (ids.has(`${parent}-${letter}${k}`)) k++; ids.add(`${parent}-${letter}${k}`); return `${parent}-${letter}${k}`; };
const jobs = [], marks = [], introFor = new Set();
for (const r of R.rows) {
  if (jobs.length >= cfg.num('REPLY_DRAFT_BATCH', 4)) break;
  if (str(r.draft_msg_id).trim()) continue;
  const at = parseDT(r.received_at);
  if (!at || at < since) continue;
  const cat = str(r.category), kind = str(r.kind);
  const c = contacts[str(r.contact_id)] || {};
  const m = byId[str(r.msg_id)];
  if (!m) { marks.push([r._row, 'skip: original message not found']); continue; }
  const done = M.rows.filter(x => str(x.reply_id) === str(r.reply_id));
  if (done.length) { marks.push([r._row, done.map(x => x.msg_id).join(', ')]); continue; }
  const modes = [];
  if (kind === 'human' && HUMAN.includes(cat)) {
    // Louai already answered by hand (a later email to this contact went out) → no draft
    const later = M.rows.some(x => str(x.contact_id) === str(r.contact_id) && parseDT(x.sent_at) && parseDT(x.sent_at) > at);
    if (later) { marks.push([r._row, 'skip: answered by hand']); continue; }
    modes.push('reply');
  }
  const rEmail = norm(r.referral_email);
  const rc = cat === 'referral' && EMAIL_RE.test(rEmail) ? C.rows.find(x => norm(x.email) === rEmail) : null;
  if (rc && (str(rc.contact_status) || 'active') === 'active' && !introFor.has(str(rc.contact_id))
    && !M.rows.some(x => str(x.contact_id) === str(rc.contact_id) && !['cancelled', 'skipped'].includes(str(x.status)))) { modes.push('intro'); introFor.add(str(rc.contact_id)); }
  if (!modes.length) { marks.push([r._row, `skip: ${kind} ${cat}`]); continue; }
  for (const mode of modes) {
    const target = mode === 'intro' ? rc : replyTarget(r, c);
    const referrer = str(r.from_name || c.full_name || c.first_name);
    jobs.push({
      mode, msg_id: nextId(str(m.msg_id), mode === 'intro' ? 'I' : 'R'), reply_row: r._row, reply: r, msg: m, target,
      to_email: mode === 'intro' ? rEmail : norm(r.from_email),
      thread_id: mode === 'intro' ? '' : (str(r.thread_id) || (str(r.thread_link).match(/#all\/(\w+)/) || [, ''])[1] || str(m.gmail_thread_id)),
      subject: mode === 'intro' ? '' : 'Re: ' + str(r.subject || m.subject).replace(/^(re|sv|aw|vs):\s*/i, ''),
      llm_input: replyJobInput(mode, r, m, target, facts, cfg, referrer),
    });
  }
}
if (!jobs.length) return [];
return [{ json: { jobs, marks } }];

// ---- NODE: Build draft requests ----
// @node rd_build
const DRAFT_SYSTEM = __REPLY_DRAFT_SYSTEM__;
const p = $('Pick replies to draft').first().json;
const cfg = configOf(tablesFrom($('Read Sheet (drafter)').first().json).Config);
return p.jobs.map(j => ({ json: { ...j, ...draftRequest(DRAFT_SYSTEM, j.llm_input, cfg, 0.3) } }));

// ---- NODE: Check primary LLM (drafts) ----
// @node rd_check
return $input.all().map((it, i) => {
  const ctx = $('Build draft requests').itemMatching(i).json;
  let llm = null, llm_error = '';
  try {
    if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
    llm = parseLLMJson(it.json.choices[0].message.content);
    if (!str(llm.body).trim()) throw new Error('empty body');
  } catch (e) { llm = null; llm_error = e.message; }
  return { json: { ...ctx, llm, llm_ok: !!llm, llm_error } };
});

// ---- NODE: Create reply drafts ----
// @node rd_create
const VIA = '__VIA__'; // 'primary' | 'fallback'
const T = tablesFrom($('Read Sheet (drafter)').first().json);
const M = T.Messages, R = T.Replies;
const p = $('Pick replies to draft').first().json;
const W = Writer(), logs = [], appendMessages = [], cards = [], byReply = {};
$input.all().forEach((it, i) => {
  let j, out = null, err = '';
  if (VIA === 'primary') { j = it.json; out = j.llm; err = j.llm_error; }
  else {
    j = $('Check primary LLM (drafts)').itemMatching(i).json;
    try {
      if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
      out = parseLLMJson(it.json.choices[0].message.content);
      if (!str(out.body).trim()) throw new Error('empty body');
    } catch (e) { out = null; err = `primary: ${j.llm_error} | fallback: ${e.message}`; }
  }
  const t = j.target || {};
  const subject = j.mode === 'intro' ? (str(out && out.subject).trim() || `Internship: ${str(j.reply.from_name || 'your colleague')} suggested you`) : j.subject;
  const row = {
    msg_id: j.msg_id, contact_id: t.contact_id, company: t.company, first_name: t.first_name, type: j.mode === 'intro' ? 'intro' : 'reply',
    parent_msg_id: j.msg.msg_id, reply_id: j.reply.reply_id, subject, body: out ? str(out.body).replace(/\r/g, '').trim() : '',
    status: out ? 'awaiting_ok' : 'draft_failed', approved: false, to_email: j.to_email, gmail_thread_id: j.thread_id,
    qc_model: `reply-bot ${VIA}`, error: out ? '' : err.slice(0, 300), updated_at: iso(),
  };
  const checks = replyChecks(row, t);
  row.qc_reasons = [...checks.fails, ...checks.warns, ...((out && out.open_questions) || []).map(q => `open: ${q}`)].join(' | ');
  appendMessages.push(rowArray(M, row));
  (byReply[j.reply_row] = byReply[j.reply_row] || []).push(j.msg_id);
  logs.push(logRow('ReplyBot', out ? 'info' : 'warn', out ? 'reply_drafted' : 'reply_draft_failed', row.msg_id, row.contact_id, `${row.type} → ${row.to_email} | ${out ? row.qc_reasons : err}`));
  cards.push(draftCard({ row, reply: j.reply, contact: t, checks, notes: out && str(out.notes), open_questions: out && out.open_questions,
    head: out ? '' : `⚠️ Could not draft automatically (${tgEsc(err.slice(0, 150))}). Press 🔁 Regenerate, or reply to this message with your own text.` }));
});
// all planned ids of the reply (the other IF branch may hold the rest), so neither branch overwrites the other
for (const rowNo of Object.keys(byReply)) W.set(R, Number(rowNo), 'draft_msg_id', p.jobs.filter(x => String(x.reply_row) === rowNo).map(x => x.msg_id).join(', '));
for (const [rowNo, why] of p.marks) W.set(R, rowNo, 'draft_msg_id', why);
heartbeat(W, T, 'LAST_RUN_DRAFTER');
return [{ json: { data: W.data, logs, appendMessages, cards } }];

// ---- NODE: Bot route ----
// @node bot_route
// Every Telegram update to the reply bot. Only Louai's own chat is obeyed; anything else is dropped silently.
const up = $('Reply bot trigger').first().json;
const OWNER = '__TG_CHAT_ID__';
const cq = up.callback_query, tm = up.message;
const chatId = str(cq ? cq.message && cq.message.chat && cq.message.chat.id : tm && tm.chat && tm.chat.id);
const fromId = str(cq ? cq.from && cq.from.id : tm && tm.from && tm.from.id);
if (!chatId || chatId !== OWNER || fromId !== OWNER) return [];
const T = tablesFrom($('Read Sheet (bot)').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, cfg = configOf(T.Config);
const byId = Object.fromEntries(M.rows.map(m => [str(m.msg_id), m]));
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const base = { chat_id: chatId, callback_id: cq ? str(cq.id) : '', card_message_id: cq && cq.message ? cq.message.message_id : '', card_text: cq && cq.message ? str(cq.message.text) : '', toast: '', alert: false, cards: [] };
const one = o => [{ json: { ...base, ...o, toast: str(o.toast).slice(0, 190) } }];
const say = text => one({ action: 'say', say: text });
const toast = (text, alert = true) => one({ action: 'toast', toast: text, alert });
const OPEN = ['awaiting_ok', 'draft_failed'];
const ctxOf = row => {
  const r = R.rows.find(x => str(x.reply_id) === str(row.reply_id)) || {};
  const c = contacts[str(row.contact_id)] || {};
  const target = str(row.type) === 'intro' ? c : replyTarget(r, c);
  return { r, c, target };
};
const cardOf = (row, head) => { const { r, target } = ctxOf(row); return draftCard({ row, reply: r, contact: target, checks: replyChecks(row, target), head }); };

if (tm) {
  const text = str(tm.text).trim();
  const open = M.rows.filter(m => OPEN.includes(str(m.status)) && ['reply', 'intro'].includes(str(m.type)));
  if (!text || /^\/(start|help)\b/i.test(text)) {
    return say('I draft answers to the replies you get. Every draft comes as a card with buttons:\n✅ Send: sends it now, only to the address shown on the card. A reply goes into the same Gmail conversation as their email; an intro is a new email.\n✏️ Edit: reply to the card with an instruction ("shorter", "propose Thursday 14:00") or with your own text, and I send back the new version with the changes.\n🔁 Regenerate: a fresh version.\n❌ Skip: no answer.\n/pending shows every draft still waiting.');
  }
  if (/^\/pending\b/i.test(text)) {
    if (!open.length) return say('No drafts waiting.');
    return one({ action: 'say', say: `${open.length} draft(s) waiting. Newest cards below.`, cards: open.slice(-5).map(row => cardOf(row, '📌 Still waiting')) });
  }
  const ref = tm.reply_to_message ? (str(tm.reply_to_message.text).match(/Draft (M[\w-]+)/) || [])[1] : '';
  const row = ref ? byId[ref] : (open.length === 1 ? open[0] : null);
  if (!row) return say(open.length ? 'Reply to the draft card you want to change (swipe left on it), so I know which one you mean. /pending lists them.' : 'No drafts waiting.');
  if (!OPEN.includes(str(row.status))) return say(`${row.msg_id} is "${row.status}": it can no longer be changed.`);
  const { r, c, target } = ctxOf(row);
  return one({ action: 'rewrite', how: 'edit', user_text: text.slice(0, 3000), row, reply: r, contact: target,
    llm_input: { louai_message: text.slice(0, 3000), current_draft: { subject: str(row.subject), body: str(row.body), type: str(row.type) },
      their_message: { category: str(r.category), from_name: str(r.from_name || r.full_name), text: str(r.text || r.snippet) },
      recipient: { first_name: str(target.first_name), role: str(target.role), company: str(target.company || c.company) },
      louai_facts: profileFacts(T), availability: availabilityOf(cfg) } });
}

if (!cq) return [];
const [act, id, ver] = str(cq.data).split('|');
const row = byId[id];
if (!row) return toast(`Draft ${id} not found in the sheet.`);
const st = str(row.status);
if (st === 'sent') return toast(`${id} was already sent ✅`);
if (st === 'sending') return toast(`${id} is being sent right now.`);
if (!OPEN.includes(st)) return toast(`${id} is "${st}": nothing to do.`);
const { r, c, target } = ctxOf(row);
if (act === 'edit') return toast('Reply to this card (swipe left on it) with your change or with your own text. I will send back the new version.');
if (act === 'skip') {
  const W = Writer();
  W.setMany(M, row._row, { status: 'skipped', updated_at: iso() });
  return one({ action: 'skip', toast: `Skipped ${id}`, alert: false, data: W.data,
    logs: [logRow('ReplyBot', 'info', 'reply_skipped', id, row.contact_id, 'skipped in Telegram')], card_text: `❌ SKIPPED ${id} (nothing sent)\n\n${base.card_text}`.slice(0, 4000) });
}
if (act === 'regen') {
  const m = byId[str(row.parent_msg_id)] || {};
  return one({ action: 'rewrite', how: 'regen', toast: 'Writing a new version…', alert: false, row, reply: r, contact: target,
    llm_input: { ...replyJobInput(str(row.type) === 'intro' ? 'intro' : 'reply', r, m, target, profileFacts(T), cfg, str(r.from_name || r.full_name)), previous_draft: str(row.body) } });
}
if (act !== 'send') return toast('Unknown button.');
// ---- ✅ Send: every guard runs again on the live sheet ----
if (ver !== draftVer(row)) return toast(`This card shows an old version of ${id}. Use the newest card (or /pending).`);
const checks = replyChecks(row, target);
if (checks.fails.length) return toast(`Not sent: ${checks.fails.join(' · ')}. Edit it first.`);
if (!EMAIL_RE.test(norm(row.to_email))) return toast(`Not sent: bad address "${row.to_email}".`);
if (['do_not_contact', 'bounced'].includes(str(c.contact_status))) return toast(`Not sent: contact is ${c.contact_status}.`);
const sentLog = (T.Log ? T.Log.rows : []).some(x => str(x.event) === 'sent' && str(x.msg_id) === id);
if (sentLog) return toast(`Not sent: the Log says ${id} was already sent.`);
if (M.rows.some(x => str(x.sent_at) && norm(x.to_email) === norm(row.to_email) && contentHash(x) === contentHash(row))) return toast('Not sent: the same text already went to this address.');
// answered already (an email to this address after their message is in the sheet: bot, Sender, or by hand found by the sync)
const theirAt = parseDT(r.received_at);
const later = theirAt && M.rows.find(x => str(x.msg_id) !== id && norm(x.to_email) === norm(row.to_email) && parseDT(x.sent_at) && parseDT(x.sent_at) > theirAt);
if (later) return toast(`Not sent: ${later.msg_id} already went to ${row.to_email} on ${parseDT(later.sent_at).toFormat('d LLL HH:mm')}, after their email. Press ❌ Skip if that answered them.`);
if (cfg.bool('SENDING_PAUSED')) return toast(`Not sent: SENDING_PAUSED is TRUE in Config (${cfg.str('PAUSE_REASON', 'no reason given')}).`);
if (cfg.bool('DRY_RUN', true)) return toast('Not sent: DRY_RUN is TRUE in Config.');
const mode = cfg.str('TEST_RECIPIENT') ? 'test' : 'live';
const fromEmail = cfg.str('FROM_EMAIL', '__OWNER_FROM__');
let inReplyTo = '', refs = [];
if (str(row.type) !== 'intro') {
  // answer THEIR message: In-Reply-To = its Message-ID; fall back to our own sent chain for old Replies rows
  inReplyTo = str(r.rfc_message_id);
  refs = str(r.references).split(/\s+/).filter(Boolean).concat(inReplyTo ? [inReplyTo] : []);
  if (!inReplyTo) { const p = byId[str(row.parent_msg_id)]; inReplyTo = str(p && p.rfc_message_id); refs = inReplyTo ? [inReplyTo] : []; }
}
const to = mode === 'test' ? cfg.str('TEST_RECIPIENT') : norm(row.to_email);
const subject = (mode === 'test' ? `[TEST → ${row.to_email}] ` : '') + str(row.subject);
const { raw } = buildRaw({ fromName: cfg.str('FROM_NAME', 'Louai Eddiaz'), fromEmail, replyTo: cfg.str('REPLY_TO', fromEmail), to, subject,
  body: row.body, signature: cfg.str('SIGNATURE', '').replace(/\\n/g, '\n'), inReplyTo, refs });
const threadId = mode === 'live' && str(row.type) !== 'intro' ? str(row.gmail_thread_id) : '';
const W = Writer();
W.setMany(M, row._row, { status: 'sending', updated_at: iso() });
// the next node asks Gmail Sent whether Louai already wrote to this address by hand (not in the sheet yet)
const since = (theirAt || now().minus({ days: 7 })).minus({ minutes: 1 });
const guard_q = `in:sent (to:${norm(row.to_email)} OR cc:${norm(row.to_email)}) after:${Math.floor(since.toSeconds())}`;
return one({ action: 'send', guard_q, toast: 'Sending…', alert: false, mode, row, to, subject, lock: W.data, gmail_payload: threadId ? { raw, threadId } : { raw },
  card_text: `⏳ Sending ${id} to ${to} (${threadId ? 'reply in the same Gmail conversation' : str(row.type) === 'intro' ? 'new email' : 'reply'})…\n\n${base.card_text}`.slice(0, 4000) });

// ---- NODE: Hand check (bot) ----
// @node bot_hand_check
// Gmail Sent has an email to this address, sent after their message, that the sheet does not know → Louai already
// answered by hand: never send a second answer. Gmail cannot be checked → do not send now either.
const rt = $('Bot route').first().json;
const T = tablesFrom($('Read Sheet (bot)').first().json);
const M = T.Messages, row = rt.row;
const res = $input.first().json || {};
const known = new Set(M.rows.map(m => str(m.gmail_message_id).trim()).filter(Boolean));
const unknown = (res.messages || []).map(x => x.id).filter(id => id && !known.has(id));
if (!res.error && !unknown.length) return [{ json: { clear: true } }];
const W = Writer();
let card_text, logs;
if (res.error) {
  W.setMany(M, row._row, { status: 'awaiting_ok', error: `${iso()} Gmail Sent check failed, not sent: ${JSON.stringify(res.error).slice(0, 200)}`, updated_at: iso() });
  logs = [logRow('ReplyBot', 'warn', 'manual_check_failed', row.msg_id, row.contact_id, JSON.stringify(res.error).slice(0, 300))];
  card_text = `⏸ NOT SENT ${row.msg_id}: could not check Gmail Sent first. Nothing was sent. Try again in a minute with /pending.`;
} else {
  W.setMany(M, row._row, { status: 'skipped', error: `answered by hand in Gmail (${unknown.join(' ')}), found before sending`, updated_at: iso() });
  logs = [logRow('ReplyBot', 'info', 'manual_send_detected', row.msg_id, row.contact_id, `${row.to_email}: ${unknown.join(' ')}`)];
  card_text = `🗂 NOT SENT ${row.msg_id}: Gmail Sent shows you already wrote to ${row.to_email} by hand after their email. Draft closed so they do not get two answers. The sync logs your email within the hour.`;
}
return [{ json: { clear: false, data: W.data, logs, card_text } }];

// ---- NODE: After bot send ----
// @node bot_send_after
const rt = $('Bot route').first().json;
const sent = $('Gmail: send (bot)').first().json;
const meta = $input.first().json;
const T = tablesFrom($('Read Sheet (bot)').first().json);
const M = T.Messages, row = rt.row;
const W = Writer(), logs = [];
let card_text;
if (sent.error || !sent.id) {
  const err = JSON.stringify(sent.error || sent).slice(0, 500);
  W.setMany(M, row._row, { status: 'awaiting_ok', error: `${iso()} ${err}`, updated_at: iso() });
  logs.push(logRow('ReplyBot', 'error', 'gmail_send_failed', row.msg_id, row.contact_id, err));
  card_text = `❌ NOT SENT ${row.msg_id}: ${err.slice(0, 300)}\nFix the problem, then use /pending to get the card again.`;
} else {
  const rfc = (((meta.payload && meta.payload.headers) || []).find(h => /^message-id$/i.test(h.name)) || {}).value || '';
  if (rt.mode === 'live') {
    W.setMany(M, row._row, { status: 'sent', approved: true, sent_at: iso(), gmail_message_id: sent.id, gmail_thread_id: sent.threadId, rfc_message_id: rfc, error: '', updated_at: iso() });
    logs.push(logRow('ReplyBot', 'info', 'sent', row.msg_id, row.contact_id, `${row.type} → ${rt.to} | ${rt.subject} | gmail ${sent.id} thread ${sent.threadId}`));
    const where = str(row.type) === 'intro' ? 'as a new email' : sent.threadId && sent.threadId === str(row.gmail_thread_id) ? 'in the same Gmail conversation' : 'as a reply';
    card_text = `✅ SENT ${now().toFormat('HH:mm')} to ${rt.to} ${where}\n${rt.subject}\n\n${str(row.body)}`;
  } else {
    W.setMany(M, row._row, { status: 'awaiting_ok', test_sent_at: iso(), error: '', updated_at: iso() });
    logs.push(logRow('ReplyBot', 'info', 'test_sent', row.msg_id, row.contact_id, `TEST → ${rt.to} (real: ${row.to_email}) | ${rt.subject}`));
    card_text = `🧪 TEST sent to ${rt.to} (real recipient: ${row.to_email}). Draft still waiting: clear TEST_RECIPIENT, then /pending to send it for real.`;
  }
}
return [{ json: { data: W.data, logs, card_text: card_text.slice(0, 4000) } }];

// ---- NODE: Build rewrite request ----
// @node bot_rewrite_build
const DRAFT_SYSTEM = __REPLY_DRAFT_SYSTEM__;
const EDIT_SYSTEM = __REPLY_EDIT_SYSTEM__;
const rt = $('Bot route').first().json;
const cfg = configOf(tablesFrom($('Read Sheet (bot)').first().json).Config);
const regen = rt.how === 'regen';
return [{ json: draftRequest(regen ? DRAFT_SYSTEM : EDIT_SYSTEM, rt.llm_input, cfg, regen ? 0.8 : 0.2) }];

// ---- NODE: Check rewrite LLM ----
// @node bot_rewrite_check
const ctx = $('Build rewrite request').first().json;
const it = $input.first().json;
let llm = null, llm_error = '';
try {
  if (it.error) throw new Error(JSON.stringify(it.error).slice(0, 300));
  llm = parseLLMJson(it.choices[0].message.content);
  if (!str(llm.body).trim()) throw new Error('empty body');
} catch (e) { llm = null; llm_error = e.message; }
return [{ json: { ...ctx, llm, llm_ok: !!llm, llm_error } }];

// ---- NODE: Apply rewrite ----
// @node bot_rewrite_apply
const VIA = '__VIA__'; // 'primary' | 'fallback'
const rt = $('Bot route').first().json;
const ctx = $('Check rewrite LLM').first().json;
const T = tablesFrom($('Read Sheet (bot)').first().json);
const M = T.Messages;
let out = null, err = '';
if (VIA === 'primary') { out = ctx.llm; err = ctx.llm_error; }
else {
  const it = $input.first().json;
  try {
    if (it.error) throw new Error(JSON.stringify(it.error).slice(0, 300));
    out = parseLLMJson(it.choices[0].message.content);
    if (!str(out.body).trim()) throw new Error('empty body');
  } catch (e) { out = null; err = `primary: ${ctx.llm_error} | fallback: ${e.message}`; }
}
const row = rt.row, W = Writer(), logs = [];
if (!out) {
  W.setMany(M, row._row, { error: `${iso()} rewrite failed: ${err.slice(0, 250)}`, updated_at: iso() });
  logs.push(logRow('ReplyBot', 'warn', 'reply_rewrite_failed', row.msg_id, row.contact_id, err));
  return [{ json: { data: W.data, logs, cards: [{ text: `⚠️ Could not rewrite ${tgEsc(row.msg_id)} (${tgEsc(err.slice(0, 200))}). The draft is unchanged. Try again, or reply with your full text.`, msg_id: row.msg_id, ver: draftVer(row) }] } }];
}
const next = { ...row, subject: str(out.subject).trim() || str(row.subject), body: str(out.body).replace(/\r/g, '').trim(), status: 'awaiting_ok' };
const checks = replyChecks(next, rt.contact);
W.setMany(M, row._row, { subject: next.subject, body: next.body, status: 'awaiting_ok', qc_reasons: [...checks.fails, ...checks.warns].join(' | '), qc_model: `reply-bot ${VIA}`, error: '', updated_at: iso() });
const how = rt.how === 'regen' ? 'regenerated' : out.mode === 'own_text' ? 'your text, polished' : 'your change applied';
logs.push(logRow('ReplyBot', 'info', rt.how === 'regen' ? 'reply_regenerated' : 'reply_edited', row.msg_id, row.contact_id, `${how}${rt.user_text ? ' | Louai: ' + rt.user_text.slice(0, 500) : ''}`));
const diff = sentenceDiff(row.body, next.body);
const card = draftCard({ row: next, reply: rt.reply, contact: rt.contact, checks, notes: str(out.notes) || str(out.open_questions && out.open_questions.join(' · ')),
  diff: rt.how === 'regen' ? [] : (diff.length ? diff : ['(no change)']), head: `${rt.how === 'regen' ? '🔁' : '✏️'} <b>New version</b> (${how}). Older cards of this draft no longer send.` });
return [{ json: { data: W.data, logs, cards: [card] } }];
