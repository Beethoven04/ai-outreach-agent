// ---- NODE: Sync plan ----
// @node sync_plan
// Hourly (minute :38, a minute no other Gmail workflow uses). Louai also writes emails by hand in Gmail: this workflow
// finds them in Gmail "Sent" and puts them in the sheet, so the Sender and the reply bot never send something twice.
// It only reads Gmail; it never sends anything.
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, cfg = configOf(T.Config);
requireCols(M, ['msg_id', 'contact_id', 'type', 'parent_msg_id', 'subject', 'body', 'status', 'approved', 'qc_model', 'to_email', 'sent_at', 'gmail_message_id', 'gmail_thread_id', 'rfc_message_id', 'followup_due', 'error', 'updated_at', 'reply_id']);
if (!cfg.bool('SYNC_ENABLED', true)) return [];
const n = now();
// a send is in progress (Sender or reply bot): never write next to it, try again next hour
if (M.rows.some(m => str(m.status) === 'sending' && parseDT(m.updated_at) && n.diff(parseDT(m.updated_at), 'minutes').minutes < 20)) return [];
const last = parseDT(cfg.raw.LAST_RUN_SYNC);
let from = last ? last.minus({ hours: 2 }) : n.minus({ days: cfg.num('SYNC_FIRST_DAYS', 3) });
// a row stuck in "sending": look back to before the lock, so the email is found if it did go out
for (const m of M.rows) {
  const u = str(m.status) === 'sending' && parseDT(m.updated_at);
  if (u && u.minus({ minutes: 10 }) < from) from = u.minus({ minutes: 10 });
}
if (n.diff(from, 'days').days > 30) from = n.minus({ days: 30 });
// Gmail ids that the Sender / reply bot found before sending (row on hold with error "manual_check: … <ids>")
const extra = [...new Set(M.rows.filter(m => str(m.status) === 'held' && /^manual_check:/.test(str(m.error)))
  .flatMap(m => str(m.error).match(/\b[0-9a-f]{16}\b/g) || []))];
return [{ json: { q: `in:sent after:${Math.floor(from.toSeconds())}`, from: iso(from), extra } }];

// ---- NODE: Unknown sent mail ----
// @node sync_unknown
// Sent emails the sheet does not know yet (no Messages row has their Gmail id). Always returns at least one item,
// so the reconcile step also runs when there is nothing new (stuck rows, contact-status clean-up, heartbeat).
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, cfg = configOf(T.Config);
const plan = $('Sync plan').first().json;
const res = $input.first().json || {};
const list_ok = !res.error && !res.nextPageToken;
const list_error = res.error ? JSON.stringify(res.error).slice(0, 300) : res.nextPageToken ? 'more than one page of sent mail' : '';
const known = new Set(M.rows.map(m => str(m.gmail_message_id).trim()).filter(Boolean));
const ids = [...new Set([...(res.messages || []).map(x => x.id), ...plan.extra])].filter(id => id && !known.has(id));
const out = ids.slice(0, cfg.num('SYNC_MAX_FETCH', 40)).map(id => ({ json: { id, list_ok, list_error } }));
return out.length ? out : [{ json: { none: true, list_ok, list_error } }];

// ---- NODE: Reconcile ----
// @node sync_apply
const VIA = '__VIA__'; // 'gmail' (sent emails to look at) | 'none' (nothing new in Gmail: sheet clean-up only)
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, R = T.Replies, cfg = configOf(T.Config);
const n = now();
const W = Writer(), logs = [], notices = [], bot_notes = [], added = [];
const info = $('Unknown sent mail').first().json;
const fetched = VIA === 'gmail' ? $input.all().map(x => x.json) : [];
const fetchErr = fetched.filter(g => g.error || !g.id);
const gmailOk = !!info.list_ok && !fetchErr.length;
if (!info.list_ok) logs.push(logRow('Sync', 'warn', 'sync_fetch_failed', '', '', `Gmail Sent search: ${info.list_error}`));
if (fetchErr.length) logs.push(logRow('Sync', 'warn', 'sync_fetch_failed', '', '', `${fetchErr.length} sent email(s) could not be read: ${JSON.stringify(fetchErr[0].error || fetchErr[0]).slice(0, 200)}`));

const me = [cfg.str('FROM_EMAIL', '__OWNER_FROM__'), ...__OWNER_OTHER_EMAILS__].map(norm);
const rows = M.rows; // changed in memory as we go, so two emails in one run see each other
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const set = (m, upd) => { Object.assign(m, upd); if (m._row) W.setMany(M, m._row, upd); };
// which contact an address belongs to: their own address, an address we wrote to, or a colleague who answered for them
const byEmail = {};
const own = (e, cid) => { e = norm(e); if (cid && EMAIL_RE.test(e) && !byEmail[e]) byEmail[e] = str(cid); };
C.rows.forEach(c => own(c.email, c.contact_id));
rows.forEach(m => own(m.to_email, m.contact_id));
R.rows.forEach(r => own(r.from_email, r.contact_id));
const threadOf = {};
rows.forEach(m => { if (str(m.gmail_thread_id) && !threadOf[str(m.gmail_thread_id)]) threadOf[str(m.gmail_thread_id)] = str(m.contact_id); });
R.rows.forEach(r => { if (str(r.thread_id) && str(r.contact_id) && !threadOf[str(r.thread_id)]) threadOf[str(r.thread_id)] = str(r.contact_id); });
const ids = new Set(rows.map(m => str(m.msg_id)));
let nextM = Math.max(0, ...rows.map(m => Number((str(m.msg_id).match(/^M(\d+)$/) || [, 0])[1])).filter(x => x < 900)) + 1;
const newId = base => {
  if (!base) { while (ids.has('M' + String(nextM).padStart(3, '0'))) nextM++; const id = 'M' + String(nextM++).padStart(3, '0'); ids.add(id); return id; }
  let k = 1; while (ids.has(base + k)) k++; ids.add(base + k); return base + k;
};
const addrs = s => (str(s).match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[a-z]{2,}/gi) || []).map(norm);
const bare = s => norm(s).replace(/^((re|sv|aw|vs|fw|fwd)\s*:\s*)+/i, '');
const typeOf = m => str(m.type) || 'cold';
const UNSENT = ['', 'draft', 'needs_fix', 'ready', 'held'];
const OPEN_BOT = ['awaiting_ok', 'draft_failed'];
const due = at => at.plus({ days: cfg.num('FOLLOWUP_DAYS', 4) }).toISODate();
const handled = new Set(), ignored = new Set();

for (const g of fetched.filter(g => g.id && !g.error).sort((a, b) => Number(a.internalDate) - Number(b.internalDate))) {
  if (!(g.labelIds || []).includes('SENT') || (g.labelIds || []).includes('DRAFT')) { ignored.add(g.id); continue; }
  const at = DateTime.fromMillis(Number(g.internalDate)).setZone(TZ);
  if (n.diff(at, 'minutes').minutes < 5) continue; // may be a Sender/bot send still being written to the sheet: next run
  const H = gmailHeaders(g);
  const to = [...addrs(H.to), ...addrs(H.cc)].filter(a => !me.includes(a));
  const tid = str(g.threadId);
  const cid = to.map(a => byEmail[a]).find(Boolean) || threadOf[tid];
  const c = contacts[cid];
  if (!c) { ignored.add(g.id); continue; } // not outreach mail (private email, test inbox …)
  handled.add(g.id);
  const email = to.find(a => byEmail[a] === cid) || to[0] || norm(c.email);
  const who = `${str(c.full_name || c.first_name) || email} (${str(c.company) || '?'})`;
  const subject = str(H.subject), body = (stripQuoted(gmailText(g.payload)) || str(g.snippet)).slice(0, 4000);
  const fill = { sent_at: iso(at), to_email: email, gmail_message_id: g.id, gmail_thread_id: tid, rfc_message_id: str(H['message-id']), updated_at: iso() };
  const mine = rows.filter(m => str(m.contact_id) === cid);
  const score = m => (str(m.gmail_thread_id) === tid ? 2 : 0) + (bare(m.subject) === bare(subject) ? 1 : 0);

  // bot drafts this email already answers are closed, so ✅ on their old card cannot send a second answer
  for (const d of mine.filter(m => OPEN_BOT.includes(str(m.status)) && norm(m.to_email) === email)) {
    const rr = R.rows.find(r => str(r.reply_id) === str(d.reply_id));
    if (rr && parseDT(rr.received_at) && parseDT(rr.received_at) > at) continue; // their email came after Louai's: the draft is still needed
    set(d, { status: 'skipped', error: `answered by hand in Gmail on ${at.toFormat('d LLL HH:mm')} (found by sync)`, updated_at: iso() });
    logs.push(logRow('Sync', 'info', 'reply_skipped', d.msg_id, cid, `answered by hand: gmail ${g.id}`));
    bot_notes.push(`🗂 ${d.msg_id} closed: you already answered ${who} <${email}> by hand in Gmail (${at.toFormat('d LLL HH:mm')}). Its card can no longer send.`);
  }

  // a) already in the sheet without Gmail ids (logged by hand, or status typed "sent") → only add the ids
  //    (logged time within 30 min; a row with no time at all only matches if nothing better does)
  const logged = mine.filter(m => !str(m.gmail_message_id) && ['sent', 'replied', 'bounced'].includes(str(m.status)) && (!str(m.to_email) || norm(m.to_email) === email)
    && (!str(m.gmail_thread_id) || str(m.gmail_thread_id) === tid)
    && (!parseDT(m.sent_at) || Math.abs(at.diff(parseDT(m.sent_at), 'minutes').minutes) <= 30))
    .sort((a, b) => (parseDT(b.sent_at) ? 4 : 0) + score(b) - (parseDT(a.sent_at) ? 4 : 0) - score(a))[0];
  if (logged) {
    set(logged, { ...fill, sent_at: str(logged.sent_at) || fill.sent_at, error: '' });
    logs.push(logRow('Sync', 'info', 'sync_ids_added', logged.msg_id, cid, `${typeOf(logged)} → ${email} | gmail ${g.id} thread ${tid}`));
    continue;
  }
  // b) a row stuck in "sending" whose email did go out (the run that sent it never wrote the result)
  const inflight = mine.find(m => str(m.status) === 'sending' && (!str(m.to_email) || norm(m.to_email) === email));
  let row = null, type, how;
  if (inflight) {
    row = inflight; type = typeOf(row); how = 'was stuck in "sending": the email did go out';
    set(row, { ...fill, status: 'sent', approved: true, error: '', ...(['reply', 'intro'].includes(type) ? {} : { followup_due: due(at) }) });
  } else {
    // c) a new email by hand: what kind is it?
    const coldSent = mine.some(m => typeOf(m) === 'cold' && str(m.sent_at));
    const answered = R.rows.some(r => str(r.contact_id) === cid && str(r.kind) === 'human' && parseDT(r.received_at) && parseDT(r.received_at) < at);
    type = !coldSent ? 'cold' : answered ? 'reply' : 'fu';
    if (type === 'cold') row = mine.filter(m => typeOf(m) === 'cold' && !str(m.sent_at) && UNSENT.includes(str(m.status))).sort((a, b) => score(b) - score(a))[0];
    if (type === 'fu') row = mine.filter(m => /^fu\d$/.test(typeOf(m)) && !str(m.sent_at) && UNSENT.includes(str(m.status))).sort((a, b) => typeOf(a).localeCompare(typeOf(b)))[0];
    if (row) {
      type = typeOf(row); how = 'the queued email was sent by hand: marked sent, the Sender will not send it';
      set(row, { ...fill, status: 'sent', approved: true, subject, body, qc_model: `${str(row.qc_model)} · sent by hand`.replace(/^ · /, ''), error: '', followup_due: due(at) });
    } else {
      const root = mine.filter(m => str(m.sent_at) && (str(m.gmail_thread_id) === tid || typeOf(m) === 'cold')).sort((a, b) => score(b) - score(a) || parseDT(a.sent_at) - parseDT(b.sent_at))[0];
      if (type === 'fu') { const k = mine.filter(m => /^fu\d$/.test(typeOf(m)) && str(m.sent_at)).length + 1; type = `fu${k}`; }
      const id = type === 'cold' ? newId('') : type === 'reply' ? newId(`${root.msg_id}-R`) : (ids.has(`${root.msg_id}-${type.toUpperCase()}`) ? newId(`${root.msg_id}-H`) : (ids.add(`${root.msg_id}-${type.toUpperCase()}`), `${root.msg_id}-${type.toUpperCase()}`));
      row = { msg_id: id, contact_id: cid, company: str(c.company), first_name: str(c.first_name), type, parent_msg_id: type === 'cold' ? '' : root.msg_id,
        subject, body, status: 'sent', approved: true, qc_model: 'sent by hand', ...fill, followup_due: type === 'reply' ? '' : due(at), error: '' };
      rows.push(row); added.push(row);
      how = 'new email you wrote by hand: added to Messages';
    }
  }
  if (!threadOf[tid]) threadOf[tid] = cid;
  logs.push(logRow('Sync', 'info', 'sent', row.msg_id, cid, `${type} → ${email} | ${subject} | gmail ${g.id} thread ${tid} | by hand: ${how}`));
}

// rows the Sender / reply bot put on hold because of an email it did not know: release them once that email is in the sheet
const knownNow = new Set(rows.map(m => str(m.gmail_message_id)).filter(Boolean));
for (const m of rows.filter(m => m._row && str(m.status) === 'held' && /^manual_check:/.test(str(m.error)))) {
  const gids = str(m.error).match(/\b[0-9a-f]{16}\b/g) || [];
  if (!gids.every(id => knownNow.has(id) || ignored.has(id))) continue;
  set(m, { status: ['reply', 'intro'].includes(typeOf(m)) ? 'awaiting_ok' : 'ready', error: `released by sync ${iso()}: the email sent by hand is now in the sheet`, updated_at: iso() });
  logs.push(logRow('Sync', 'info', 'sync_released', m.msg_id, m.contact_id, gids.join(' ')));
}
// rows stuck in "sending" whose email is NOT in Gmail Sent → it never went out → back in the queue
if (gmailOk) for (const m of rows.filter(m => m._row && str(m.status) === 'sending' && (!parseDT(m.updated_at) || n.diff(parseDT(m.updated_at), 'minutes').minutes >= 20))) {
  const back = ['reply', 'intro'].includes(typeOf(m)) && /^reply-bot/.test(str(m.qc_model)) ? 'awaiting_ok' : 'ready';
  set(m, { status: back, error: `unlocked by sync ${iso()}: stuck in "sending" and not in Gmail Sent (never sent)`, updated_at: iso() });
  logs.push(logRow('Sync', 'warn', 'sync_unlocked', m.msg_id, m.contact_id, `status sending → ${back}`));
  notices.push(`🔧 ${m.msg_id} was stuck in "sending". It is not in Gmail Sent, so it never went out: back to "${back}". Nothing to do.`);
}
// contact status changed (also by hand in the sheet) → close queued emails that must not go out any more
for (const m of rows.filter(m => m._row && !str(m.sent_at) && UNSENT.concat(OPEN_BOT).includes(str(m.status)))) {
  const cs = str((contacts[str(m.contact_id)] || {}).contact_status), t = typeOf(m);
  const stop = ['do_not_contact', 'bounced'].includes(cs) || (cs === 'refused' && (t === 'cold' || /^fu\d$/.test(t))) || (['replied', 'referred'].includes(cs) && /^fu\d$/.test(t));
  if (!stop) continue;
  set(m, { status: 'cancelled', error: `cancelled by sync ${iso()}: contact is ${cs}`, updated_at: iso() });
  logs.push(logRow('Sync', 'info', 'sync_cancelled', m.msg_id, m.contact_id, `contact_status=${cs}`));
}
heartbeat(W, T, 'LAST_RUN_SYNC');
if (logs.length) logs.push(logRow('Sync', 'info', 'sync_done', '', '', `${handled.size} email(s) by hand found, ${added.length} added, ${W.data.length} cell(s) updated`));
return [{ json: { data: W.data, logs, notices, bot_notes, appendMessages: added.map(r => rowArray(M, r)) } }];
