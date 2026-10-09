// ---- NODE: Pick next email ----
// @node send_pick
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, cfg = configOf(T.Config);
requireCols(M, ['msg_id', 'contact_id', 'type', 'parent_msg_id', 'subject', 'body', 'status', 'qc_hash', 'approved', 'to_email', 'dry_run_at', 'test_sent_at', 'sent_at', 'gmail_message_id', 'gmail_thread_id', 'rfc_message_id', 'followup_due', 'error', 'updated_at']);
requireCols(C, ['contact_id', 'company', 'email', 'email_status', 'allow_risky', 'contact_status']);
const n = now();
const mode = cfg.bool('DRY_RUN', true) ? 'dry_run' : (cfg.str('TEST_RECIPIENT') ? 'test' : 'live');
const doneCol = { dry_run: 'dry_run_at', test: 'test_sent_at', live: 'sent_at' }[mode];

// ---- gates ----
if (cfg.bool('SENDING_PAUSED')) return [];
const days = cfg.str('SEND_DAYS', '1,2,3,4,5').split(',').map(Number);
if (!days.includes(n.weekday)) return [];
const [sh, sm] = cfg.str('WINDOW_START', '08:30').split(':').map(Number);
const [eh, em] = cfg.str('WINDOW_END', '11:30').split(':').map(Number);
const mins = n.hour * 60 + n.minute;
if (mins < sh * 60 + sm || mins >= eh * 60 + em) return [];
const isToday = v => { const d = parseDT(v); return d && d.hasSame(n, 'day'); };
const sentToday = M.rows.filter(m => isToday(m[doneCol])).length;
if (sentToday >= cfg.num('DAILY_CAP', 15)) return [];
const lastSend = M.rows.map(m => parseDT(m[doneCol])).filter(Boolean).sort((a, b) => b - a)[0];
if (lastSend && n.diff(lastSend, 'seconds').seconds < cfg.num('MIN_GAP_MINUTES', 5) * 60 - 30) return [];
if (M.rows.some(m => str(m.status) === 'sending')) return []; // a previous send is unresolved: never risk a double send

// ---- candidate selection ----
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const byId = Object.fromEntries(M.rows.map(m => [str(m.msg_id), m]));
const companyOf = c => norm(str(c.company).replace(/\s*\(.*\)\s*/g, ''));
const sentRows = M.rows.filter(m => str(m.sent_at));
// append-only Log = source of truth for "already sent", even if someone edits Messages cells by hand
const sentLog = (T.Log ? T.Log.rows : []).filter(r => str(r.event) === 'sent').map(r => {
  const x = str(r.detail).match(/^(\w+) → ([^\s|]+)/);
  return { msg_id: str(r.msg_id), type: x ? x[1] : '', email: x ? norm(x[2]) : '' };
});
const blocked = [];
function eligible(m) {
  if (str(m.status) !== 'ready' || !truthy(m.approved)) return false;
  if (contentHash(m) !== str(m.qc_hash)) { blocked.push(`${m.msg_id}: edited after QC (waiting for re-QC)`); return false; }
  if (str(m[doneCol])) return false;
  const c = contacts[str(m.contact_id)];
  if (!c) { blocked.push(`${m.msg_id}: contact missing`); return false; }
  const type = str(m.type) || 'cold';
  const cs = str(c.contact_status) || 'active';
  // a 'reply' answers someone who wrote to us: allowed after they replied/referred, sent to the address they wrote from
  const okStatus = type === 'reply' ? ['active', 'replied', 'referred'] : ['active'];
  if (!okStatus.includes(cs)) { blocked.push(`${m.msg_id}: contact_status=${cs}`); return false; }
  const es = str(c.email_status);
  if (type !== 'reply' && !(es === 'valid' || (es === 'risky' && truthy(c.allow_risky)))) { blocked.push(`${m.msg_id}: email_status=${es || 'unchecked'}`); return false; }
  const email = type === 'reply' && str(m.to_email).trim() ? norm(m.to_email) : norm(c.email);
  if (!EMAIL_RE.test(email)) { blocked.push(`${m.msg_id}: bad email`); return false; }
  if (mode === 'live') {
    // duplicate guard: never same type twice to same address, never same content twice to same address
    if (sentLog.some(s => s.msg_id === str(m.msg_id))) { blocked.push(`${m.msg_id}: already sent once (Log)`); return false; }
    if (sentLog.some(s => s.email === email && s.type === type)) { blocked.push(`${m.msg_id}: ${type} already sent to ${email} (Log)`); return false; }
    if (sentRows.some(s => norm(s.to_email) === email && (str(s.type) || 'cold') === type)) { blocked.push(`${m.msg_id}: ${type} already sent to ${email}`); return false; }
    if (sentRows.some(s => norm(s.to_email) === email && str(s.qc_hash) === str(m.qc_hash))) { blocked.push(`${m.msg_id}: identical email already sent to ${email}`); return false; }
  }
  if (type === 'cold') {
    if (mode === 'live' && sentRows.some(s => str(s.contact_id) === str(c.contact_id) && (str(s.type) || 'cold') === 'cold')) { blocked.push(`${m.msg_id}: contact already got a cold email`); return false; }
    // same-company rule: next person only after SAME_COMPANY_GAP_DAYS and only if nobody there answered
    const co = companyOf(c);
    const mates = C.rows.filter(x => companyOf(x) === co && str(x.contact_id) !== str(c.contact_id));
    if (mates.some(x => ['replied', 'refused', 'do_not_contact'].includes(str(x.contact_status)))) { blocked.push(`${m.msg_id}: someone at ${c.company} already answered → on hold`); return false; }
    const gapDays = cfg.num('SAME_COMPANY_GAP_DAYS', 1);
    const mateIds = new Set(mates.map(x => str(x.contact_id)));
    const recent = M.rows.filter(s => mateIds.has(str(s.contact_id)) && str(s[doneCol])).map(s => parseDT(s[doneCol])).filter(Boolean);
    if (recent.some(d => n.diff(d, 'days').days < gapDays || d.hasSame(n, 'day'))) { blocked.push(`${m.msg_id}: colleague at ${c.company} emailed < ${gapDays} day(s) ago`); return false; }
  } else {
    const p = byId[str(m.parent_msg_id)];
    if (!p) { blocked.push(`${m.msg_id}: parent message missing`); return false; }
    if (mode !== 'test') {
      const parentOk = type === 'reply' ? ['sent', 'replied'] : ['sent']; // a thank-you answers a parent that got a reply
      if (!parentOk.includes(str(p.status)) || !str(p.gmail_thread_id)) { blocked.push(`${m.msg_id}: parent not in "sent" state (${p.status})`); return false; }
      if (type !== 'reply') {
        const due = parseDT(p.followup_due);
        if (!due || due.startOf('day') > n) { blocked.push(`${m.msg_id}: follow-up not due yet`); return false; }
      }
    }
  }
  return true;
}
const ordered = M.rows.filter(m => (str(m.type) || 'cold') !== 'cold').concat(M.rows.filter(m => (str(m.type) || 'cold') === 'cold'));
const pick = ordered.find(eligible);
if (!pick) return [];
const c = contacts[str(pick.contact_id)];
const type = str(pick.type) || 'cold';

// ---- build the MIME message (plain text, no tracking) ----
const enc = s => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=');
const fromName = cfg.str('FROM_NAME', 'Louai Eddiaz');
const fromEmail = cfg.str('FROM_EMAIL', '__OWNER_FROM__');
const replyTo = cfg.str('REPLY_TO', fromEmail);
const signature = cfg.str('SIGNATURE', '').replace(/\\n/g, '\n');
const realTo = type === 'reply' && str(pick.to_email).trim() ? norm(pick.to_email) : norm(c.email);
const to = mode === 'test' ? cfg.str('TEST_RECIPIENT') : realTo;
let subject = str(pick.subject).trim();
let threadId = '', inReplyTo = '', refs = [];
if (type !== 'cold') {
  const chain = []; let p = byId[str(pick.parent_msg_id)];
  while (p) { chain.unshift(p); p = byId[str(p.parent_msg_id)]; }
  const root = chain[0];
  if (!subject) subject = 'Re: ' + str(root.subject).replace(/^re:\s*/i, '');
  if (mode === 'live') {
    threadId = str(chain[chain.length - 1].gmail_thread_id);
    refs = chain.map(x => str(x.rfc_message_id)).filter(Boolean);
    inReplyTo = refs[refs.length - 1] || '';
  }
}
if (mode === 'test') subject = `[TEST → ${realTo}] ${subject}`;
const text = (str(pick.body).replace(/\r/g, '').trim() + (signature ? '\n\n' + signature : '')).replace(/\n/g, '\r\n');
const headers = [
  `From: ${enc(fromName)} <${fromEmail}>`,
  `To: ${to}`,
  `Reply-To: ${replyTo}`,
  `Subject: ${enc(subject)}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
];
if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${refs.join(' ')}`);
const b64body = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
const mime = headers.join('\r\n') + '\r\n\r\n' + b64body;
const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const gmail_payload = threadId ? { raw, threadId } : { raw };
const jitter = Math.floor(Math.random() * (cfg.num('JITTER_SECONDS', 60) + 1));
const W = Writer();
W.setMany(M, pick._row, { status: 'sending', updated_at: iso() });
return [{ json: {
  mode, msg: pick, contact: c, to, realTo, subject, type, gmail_payload, jitter,
  preview: `To: ${to}\nSubject: ${subject}\n\n${text.replace(/\r\n/g, '\n')}`,
  lock: W.data, sentToday, blocked: blocked.slice(0, 20),
} }];

// ---- NODE: After send ----
// @node send_after
const VIA = '__VIA__'; // 'gmail' or 'dry'
const p = $('Pick next email').first().json;
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, CF = T.Config, cfg = configOf(CF);
const W = Writer(), logs = [], notices = [];
const m = p.msg;
const n = now();
const cfgRow = k => CF.rows.find(r => str(r.key).trim() === k);
if (VIA === 'dry') {
  W.setMany(M, m._row, { status: 'ready', dry_run_at: iso(), to_email: p.realTo, error: '', updated_at: iso() });
  logs.push(logRow('Sender', 'info', 'dry_run', m.msg_id, m.contact_id, p.preview));
  if (cfg.bool('NOTIFY_EACH_SEND', true)) notices.push(`🧪 DRY RUN (not sent) — ${p.type} #${p.sentToday + 1} today\n${p.contact.full_name || p.contact.first_name} @ ${p.contact.company}\n\n${p.preview}`);
} else {
  const sent = $('Gmail: send').first().json;
  const meta = $input.first().json;
  if (sent.error || !sent.id) {
    const err = JSON.stringify(sent.error || sent).slice(0, 600);
    const pause = /quota|ratelimit|rate limit|429|limit exceeded|sending limit|suspicious|abuse|blocked|invalid_grant|unauthori[sz]ed|401|insufficient|forbidden|403|token/i.test(err);
    W.setMany(M, m._row, { status: pause ? 'ready' : 'error', error: `${iso()} ${err}`, updated_at: iso() });
    if (pause) {
      const r1 = cfgRow('SENDING_PAUSED'), r2 = cfgRow('PAUSE_REASON');
      if (r1) W.set(CF, r1._row, 'value', true);
      if (r2) W.set(CF, r2._row, 'value', `${iso()} Gmail: ${err.slice(0, 300)}`);
    }
    logs.push(logRow('Sender', 'error', pause ? 'gmail_blocked_paused' : 'gmail_send_failed', m.msg_id, m.contact_id, err));
    notices.push(`${pause ? '⛔ SENDING PAUSED' : '❌ SEND FAILED'} — ${m.msg_id} to ${p.to}\n${err}\n` +
      (pause ? 'Cause: Gmail quota/limit or credential problem. Fix: wait 24h (quota) or reconnect the Gmail credential in n8n, then set Config SENDING_PAUSED = FALSE.'
             : 'The email was NOT sent. Check the error, fix the row, then set status back to "ready".'));
  } else {
    const hdrs = (meta.payload && meta.payload.headers) || [];
    const rfc = (hdrs.find(h => /^message-id$/i.test(h.name)) || {}).value || '';
    if (p.mode === 'live') {
      const due = n.plus({ days: cfg.num('FOLLOWUP_DAYS', 4) }).toISODate();
      W.setMany(M, m._row, { status: 'sent', sent_at: iso(), to_email: p.realTo, gmail_message_id: sent.id, gmail_thread_id: sent.threadId, rfc_message_id: rfc, followup_due: due, error: rfc ? '' : 'sent OK, Message-ID not read (follow-up threading may be weaker)', updated_at: iso() });
      logs.push(logRow('Sender', 'info', 'sent', m.msg_id, m.contact_id, `${p.type} → ${p.to} | ${p.subject} | gmail ${sent.id} thread ${sent.threadId}`));
      if (cfg.bool('NOTIFY_EACH_SEND', true)) notices.push(`✅ SENT ${p.type} #${p.sentToday + 1} today → ${p.contact.full_name || p.contact.first_name} (${p.contact.company}) <${p.to}>\n"${p.subject}"\nFollow-up due: ${due}`);
    } else {
      W.setMany(M, m._row, { status: 'ready', test_sent_at: iso(), to_email: p.realTo, error: '', updated_at: iso() });
      logs.push(logRow('Sender', 'info', 'test_sent', m.msg_id, m.contact_id, `TEST → ${p.to} (real: ${p.realTo}) | ${p.subject}`));
      if (cfg.bool('NOTIFY_EACH_SEND', true)) notices.push(`🧪 TEST sent to ${p.to} (real recipient would be ${p.realTo})\n"${p.subject}"`);
    }
  }
}
heartbeat(W, T, 'LAST_RUN_SENDER');
return [{ json: { data: W.data, logs, notices } }];
