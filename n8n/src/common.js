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
// ===== END COMMON =====
