// ===== COMMON HELPERS (injected into every Code node by build.py) =====
const SHEET_ID = '__SHEET_ID__';
const TZ = 'Europe/Stockholm';

function now() { return DateTime.now().setZone(TZ); }
function iso(dt) { return (dt || now()).toISO({ suppressMilliseconds: true }); }
function parseDT(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') { // Sheets serial date
    return DateTime.fromMillis(Math.round((v - 25569) * 86400000), { zone: 'UTC' }).setZone(TZ, { keepLocalTime: true });
  }
  const s = String(v).trim();
  let d = DateTime.fromISO(s, { zone: TZ });
  if (!d.isValid) d = DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm', { zone: TZ });
  if (!d.isValid) d = DateTime.fromFormat(s, 'dd/MM/yyyy', { zone: TZ });
  if (!d.isValid) d = DateTime.fromFormat(s, 'yyyy-MM-dd', { zone: TZ });
  return d.isValid ? d : null;
}
function truthy(v) { return v === true || ['true', 'yes', '1', 'x', 'ja'].includes(String(v).trim().toLowerCase()); }
function str(v) { return v === null || v === undefined ? '' : String(v); }
function norm(s) { return str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// values (2D array from Sheets) -> table object
function parseTable(name, values) {
  values = values || [];
  const header = (values[0] || []).map(h => str(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (!r.some(c => str(c).trim() !== '')) continue;
    const o = { _row: i + 1 };
    header.forEach((h, j) => { if (h) o[h] = r[j] === undefined ? '' : r[j]; });
    rows.push(o);
  }
  return { name, header, rows };
}
function tablesFrom(resp) {
  const out = {};
  for (const vr of (resp.valueRanges || [])) {
    const name = vr.range.split('!')[0].replace(/^'|'$/g, '');
    out[name] = parseTable(name, vr.values);
  }
  return out;
}
function requireCols(t, cols) {
  const missing = cols.filter(c => !t.header.includes(c));
  if (missing.length) throw new Error(`Sheet "${t.name}" is missing column(s): ${missing.join(', ')}. Fix the header row.`);
}
function cell(t, row, col) {
  const j = t.header.indexOf(col);
  if (j < 0) throw new Error(`Sheet "${t.name}" has no column "${col}"`);
  return `'${t.name}'!${colLetter(j + 1)}${row}`;
}
// collects batchUpdate data
function Writer() {
  const data = [];
  return {
    set(t, row, col, value) { data.push({ range: cell(t, row, col), values: [[value === undefined || value === null ? '' : value]] }); },
    setMany(t, row, obj) { for (const k of Object.keys(obj)) this.set(t, row, k, obj[k]); },
    data,
  };
}
function rowArray(t, obj) { return t.header.map(h => (obj[h] === undefined || obj[h] === null ? '' : obj[h])); }

function configOf(t) {
  const c = {};
  for (const r of t.rows) c[str(r.key).trim()] = r.value;
  return {
    raw: c,
    str: (k, d = '') => (str(c[k]).trim() === '' ? d : str(c[k]).trim()),
    num: (k, d) => { const n = Number(c[k]); return str(c[k]).trim() === '' || isNaN(n) ? d : n; },
    bool: (k, d = false) => (str(c[k]).trim() === '' ? d : truthy(c[k])),
  };
}

// cyrb53 hash -> hex (no crypto module needed)
function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
function contentHash(msg, email) {
  return hash([norm(email), str(msg.subject).trim(), str(msg.body).replace(/\r/g, '').trim()].join('␞'));
}

function logRow(workflow, level, event, msgId, contactId, detail) {
  return [iso(), workflow, level, event, str(msgId), str(contactId), str(detail).slice(0, 45000)];
}
function chunk(text, size = 3500) {
  const out = []; let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > size) { if (cur) out.push(cur); cur = line.slice(0, size); } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
function words(s) { return str(s).replace(/https?:\/\/\S+/g, 'URL').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length; }
function sheetUrl() { return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`; }
function contactLine(c) {
  return [
    `${str(c.full_name) || (str(c.first_name) + ' ' + str(c.last_name)).trim()} (${str(c.role) || 'role ?'}) @ ${str(c.company)}`,
    c.company_domain ? `domain: ${c.company_domain}` : '',
    c.linkedin_url ? `LinkedIn: ${c.linkedin_url}` : '',
    c.public_emails ? `public emails: ${c.public_emails}` : '',
    c.email ? `email: ${c.email} [${str(c.email_status) || 'unchecked'}]` : '',
    `contact_id: ${c.contact_id} (sheet row ${c._row})`,
  ].filter(Boolean).join('\n');
}
function parseLLMJson(text) {
  let t = str(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
const ROLE_LOCALS = ['info', 'hello', 'hi', 'hej', 'hey', 'contact', 'kontakt', 'careers', 'career', 'jobs', 'job', 'support', 'help', 'sales', 'press', 'media', 'team', 'friends', 'business', 'research', 'information', 'office', 'admin', 'mail', 'post', 'noreply', 'no-reply', 'marketing', 'hr', 'recruiting', 'talent', 'invoice', 'billing', 'privacy', 'legal', 'security', 'partners', 'partner', 'hallo', 'kundeservice', 'kundservice'];
function isRoleAddress(email) { const l = norm(email).split('@')[0]; return ROLE_LOCALS.includes(l); }
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
function heartbeat(W, T, key) {
  const r = T.Config && T.Config.rows.find(x => str(x.key).trim() === key);
  if (r) W.set(T.Config, r._row, 'value', iso());
}

// ---- reading Gmail messages (reply watcher + sync) ----
function gmailPart(p, mime) {
  if (!p) return '';
  if (p.mimeType === mime && p.body && p.body.data) return Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  for (const q of (p.parts || [])) { const t = gmailPart(q, mime); if (t) return t; }
  return '';
}
// plain text of a Gmail API message payload (falls back to the HTML part without tags)
function gmailText(payload) {
  return gmailPart(payload, 'text/plain') || gmailPart(payload, 'text/html').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map(l => l.trim()).join('\n');
}
function gmailHeaders(msg) { const H = {}; for (const h of ((msg && msg.payload && msg.payload.headers) || [])) H[h.name.toLowerCase()] = h.value; return H; }
// the new text of an email, without the quoted conversation below it
function stripQuoted(t) {
  const out = [];
  for (const l of str(t).replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(l)) break;
    if (/^(on .+wrote:|den .+skrev:|d\. .+skrev|le .+a écrit|am .+schrieb|-{2,}\s*original message|from:\s|fra:\s|från:\s|sent from my)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

// ---- MIME message for Gmail (Sender + Reply bot): plain text + Gmail-style HTML, base64url ----
// o: { fromName, fromEmail, replyTo, to, subject, body, signature, inReplyTo, refs[] }
function buildRaw(o) {
  const enc = s => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=');
  const body = str(o.body).replace(/\r/g, '').trim();
  const signature = str(o.signature);
  const text = (body + (signature ? '\n\n' + signature : '')).replace(/\n/g, '\r\n');
  // HTML part shaped like Gmail's own compose output (one <div> per line, <div><br></div> between paragraphs),
  // so the message renders like a normally typed Gmail email in every client (12 Oct: plain-text-only looked machine-made).
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linkify = s => s
    .replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '<a href="mailto:$1">$1</a>')
    .replace(/(^|[\s·(])((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:dev|com|io|se|dk|ai|net|org)(?:\/[^\s<]*[^\s<.,;:!?)])?)(?=$|[\s·),.;:!?])/gi,
      (m, pre, u) => /@/.test(u) ? m : `${pre}<a href="${/^https?:/i.test(u) ? u : 'https://' + u}">${u}</a>`);
  const lineDiv = l => l.trim() ? `<div>${linkify(esc(l))}</div>` : '<div><br></div>';
  const bodyHtml = body.split('\n').map(lineDiv).join('');
  const sigHtml = signature ? '<div><br></div><div dir="ltr" class="gmail_signature">' + signature.split('\n').map(l => linkify(esc(l))).join('<br>') + '</div>' : '';
  const html = `<div dir="ltr">${bodyHtml}${sigHtml}</div>`;
  const boundary = '000000000000' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const headers = [
    `From: ${enc(o.fromName)} <${o.fromEmail}>`,
    `To: ${o.to}`,
    `Reply-To: ${o.replyTo || o.fromEmail}`,
    `Subject: ${enc(o.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const refs = (o.refs || []).filter(Boolean);
  if (o.inReplyTo) headers.push(`In-Reply-To: ${o.inReplyTo}`, `References: ${(refs.length ? refs : [o.inReplyTo]).join(' ')}`);
  const mimeBody = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(text), '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(html), '',
    `--${boundary}--`, '',
  ].join('\r\n');
  const mime = headers.join('\r\n') + '\r\n\r\n' + mimeBody;
  return { raw: Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), text };
}

// ---- Reply assistant (wf7): availability, checks, diff, Telegram card ----
// Louai's calendar lives on his Mac (not Google), so the bot never checks free/busy: it gets his general hours
// (Config AVAILABILITY like "1-5 09:00-17:00", 1=Mon..7=Sun) and never confirms a time on its own (Louai checks before ✅).
function availabilityText(cfg) {
  const m = cfg.str('AVAILABILITY', '1-5 09:00-17:00').match(/^(\d)-(\d)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  const D = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return m ? `${D[+m[1]]} to ${D[+m[2]]}, ${m[3]} to ${m[4]} (Stockholm/Copenhagen time)` : cfg.str('AVAILABILITY', '');
}
function availabilityOf(cfg) {
  return { usual_hours: availabilityText(cfg), note: cfg.str('AVAILABILITY_NOTE', ''), meeting_minutes: cfg.num('MEETING_MINUTES', 30) };
}
// code-side checks for reply/intro drafts: fails block sending, warns are shown on the card
function replyChecks(row, c) {
  const fails = [], warns = [];
  const body = str(row.body).replace(/\r/g, '').trim();
  if (!body) { fails.push('Draft is empty'); return { fails, warns }; }
  const first = body.split('\n')[0];
  const g = first.match(/^(hi|hello|hej|dear)\s+([^,!\n]+)[,!]?\s*$/i);
  const want = str(c && c.first_name);
  if (!g) warns.push('No "Hi <name>," greeting line');
  // 13 Oct: an edit meant for Alexander went to Sofia ("Hi Alexander" in Sofia's email) → wrong name blocks ✅
  else if (want && norm(g[2]).split(/\s+/)[0] !== norm(want).split(/\s+/)[0]) fails.push(`Greeting says "${g[2].trim()}" but this email goes to ${want} <${str(row.to_email)}>`);
  const wc = words(g ? body.split('\n').slice(1).join('\n') : body);
  const max = str(row.type) === 'intro' ? 140 : 130;
  if (wc > max) warns.push(`${wc} words (keep replies short, max ${max})`);
  const low = body.toLowerCase();
  const ph = body.match(/(\{\{|\}\}|\[[^\]\n]{1,40}\]|<[A-Z_ ]{3,}>|\bTODO\b|\bTBD\b|\bXXX+\b|lorem ipsum)/i);
  if (ph) fails.push(`Placeholder left in the text: "${ph[0]}"`);
  if (/\b(gpa|grades?|transcripts?)\b/i.test(body)) fails.push('Mentions grades');
  if (/\b(for free|unpaid|without (pay|salary)|no (pay|salary)|low (pay|salary)|small (salary|stipend))\b/i.test(body)) fails.push('Talks about free/low pay');
  if (new RegExp('__SIGNATURE_LEAK__', 'i').test(body)) warns.push('Contact details in the body (the signature is added automatically)');
  if (/[—;]/.test(body)) warns.push('Em dash or semicolon (reads machine-written)');
  const banned = ['hope this finds you', 'hope you are well', "hope you're well", 'reaching out', 'reach out', 'passionate', 'thrilled', 'excited to', 'touch base', 'circle back', 'just following up', 'i would love the opportunity', 'leverag'].filter(x => low.includes(x));
  if (banned.length) warns.push(`Banned phrase(s): ${banned.join(', ')}`);
  return { fails, warns };
}
// sentence-level diff for "show me the change"
function sentenceDiff(a, b) {
  const sp = s => str(s).replace(/\r/g, '').split(/\n+|(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  const A = sp(a), B = sp(b);
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) out.push('➕ ' + B[j++]);
    else out.push('➖ ' + A[i++]);
  }
  return out;
}
function tgEsc(s) { return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function draftVer(row) { return hash(str(row.to_email) + '␞' + contentHash(row)).slice(0, 8); }
const REPLY_ICON = { interested: '🟢', question: '🟡', referral: '🔀', not_now: '🟠', refusal: '🔴', other: '⚪', unclassified: '⚪', auto_reply: '🤖' };
// one Telegram card (HTML) per draft; the bot finds the draft again through "Draft <msg_id>" in the card text
function draftCard(o) { // o: { row, reply, contact, checks, notes, open_questions, diff, head }
  const r = o.reply || {}, c = o.contact || {}, row = o.row;
  const who = `${tgEsc(c.full_name || c.first_name || r.full_name || '?')}${c.role ? ' (' + tgEsc(c.role) + ')' : ''} @ ${tgEsc(c.company || r.company || '?')}`;
  const parts = [];
  if (o.head) parts.push(o.head);
  parts.push(`${REPLY_ICON[r.category] || '📩'} <b>${tgEsc(str(r.category || 'reply').toUpperCase())}</b> · ${who}`);
  if (r.text || r.snippet) parts.push(`<i>Their message (${tgEsc(str(r.received_at).slice(0, 16).replace('T', ' '))}):</i>\n<blockquote>${tgEsc(str(r.text || r.snippet).slice(0, 1200))}</blockquote>`);
  if (o.diff && o.diff.length) parts.push(`✏️ <b>Changes</b>\n${tgEsc(o.diff.slice(0, 12).join('\n'))}`);
  const name = str(c.full_name || c.first_name).trim();
  const to = `${name ? tgEsc(name) + ' ' : ''}&lt;${tgEsc(row.to_email)}&gt;`;
  const where = str(row.type) === 'intro'
    ? `🆕 <b>New email</b> (new conversation): ${tgEsc(str(r.from_name || r.full_name || 'their colleague'))} pointed you to this person.`
    : str(row.gmail_thread_id)
      ? '↩️ <b>Reply in the same Gmail conversation</b> as their email (the thread you already have with them).'
      : '⚠️ Gmail thread unknown: it goes out as "Re:" to their email, but Gmail may show it as a new conversation.';
  parts.push(`✍️ <b>Draft ${tgEsc(row.msg_id)}</b>\n📤 <b>Goes to:</b> ${to}, only this address (no CC)\n${where}\n<b>Subject:</b> ${tgEsc(row.subject)}\n\n${tgEsc(str(row.body) || '(empty)')}`);
  const ch = o.checks || { fails: [], warns: [] };
  if (ch.fails.length) parts.push(`⛔ ${tgEsc(ch.fails.join(' · '))}`);
  if (ch.warns.length) parts.push(`⚠️ ${tgEsc(ch.warns.join(' · '))}`);
  if (o.open_questions && o.open_questions.length) parts.push(`❓ Not answered (no fact for it): ${tgEsc(o.open_questions.join(' · '))}`);
  if (o.notes) parts.push(`ℹ️ ${tgEsc(o.notes)}`);
  parts.push('<i>To change it: reply to this message with an instruction ("shorter", "propose Thursday 14:00") or with your own text.</i>');
  let text = parts.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3990) + '…';
  return { text, msg_id: str(row.msg_id), ver: draftVer(row) };
}
function profileFacts(T) { return (T.Profile ? T.Profile.rows : []).filter(f => str(f.fact).trim()).map(f => `${f.fact_id}: ${f.fact}`); }
// who the answer goes to: the person who wrote (may be a colleague of the contact), or the referred person for an intro
function replyTarget(r, c) {
  if (!str(r.from_email) || norm(r.from_email) === norm(c.email)) return { ...c };
  const first = str(r.from_name).replace(/["']/g, '').trim().split(/\s+/)[0] || '';
  return { first_name: first, full_name: str(r.from_name), role: '', company: c.company, email: r.from_email, contact_id: c.contact_id };
}
function replyJobInput(mode, r, m, target, facts, cfg, referrer) {
  return {
    mode, today: now().toFormat('cccc d LLLL yyyy'), louai_facts: facts,
    original_email: { subject: str(m && m.subject), body: str(m && m.body) },
    their_message: { category: str(r.category), from_name: str(r.from_name || r.full_name), text: str(r.text || r.snippet) },
    recipient: { first_name: str(target.first_name), role: str(target.role), company: str(target.company), ...(mode === 'intro' ? { referred_by: referrer } : {}) },
    availability: availabilityOf(cfg),
  };
}
function draftRequest(system, job, cfg, temperature) {
  const base = { temperature, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(job) }] };
  return {
    req_primary: { model: cfg.str('LLM_PRIMARY_MODEL', 'gemini-3.5-flash'), ...base },
    req_fallback: { model: cfg.str('LLM_FALLBACK_MODEL', 'openai/gpt-oss-120b'), reasoning_effort: 'low', ...base },
  };
}
// ===== END COMMON =====
