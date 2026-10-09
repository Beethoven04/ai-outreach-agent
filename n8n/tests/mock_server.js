// Mock of Google Sheets, Gmail, Gemini/Groq, Hunter, Reoon, DoH and Telegram for running the workflows in a real n8n.
const http = require('http'), url = require('url'), fs = require('fs');
const PORT = 8787;
const SNAP = process.env.SNAPSHOT;
const state = SNAP ? JSON.parse(fs.readFileSync(SNAP)) : { tabs: JSON.parse(fs.readFileSync(__dirname + '/sheet_fixture.json')), calls: [], sent: [], telegram: [], replies: {} };
const cfgSet = (k, v) => { const t = state.tabs.Config; const r = t.find(x => x[0] === k); r[1] = v; };
// make the run deterministic and fast
if (!SNAP) [['DRY_RUN', true], ['TEST_RECIPIENT', ''], ['WINDOW_START', '00:00'], ['WINDOW_END', '23:59'], ['SEND_DAYS', '1,2,3,4,5,6,7'], ['JITTER_SECONDS', 0],
 ['MIN_GAP_MINUTES', 0], ['FINDER_BATCH', 4], ['VERIFY_BATCH', 6], ['QC_BATCH', 4]].forEach(([k, v]) => cfgSet(k, v));
const colIdx = l => { let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const trim = rows => rows.map(r => { const x = r.map(v => (v === '' ? undefined : v)); while (x.length && x[x.length - 1] === undefined) x.pop(); return x.map(v => (v === undefined ? '' : v)); });

function body(req) { return new Promise(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({ _raw: b }); } }); }); }
function send(res, code, obj, ctype = 'application/json') { res.writeHead(code, { 'content-type': ctype }); res.end(JSON.stringify(obj)); }

function llm(b) {
  const sys = b.messages[0].content, user = JSON.parse(b.messages[1].content);
  if (/quality checker/.test(sys)) {
    const bad = /Hi Anna/.test(user.message.body);
    return { claims: [{ quote: 'a Dutch AI consultancy', about: 'sender', supported: true, fact_ids: ['F06'] }], personal_reason: { present: true, quote: '', specific: true }, ask: { count: 1, quotes: [] },
      recipient_ok: !bad, tone_ok: true, mentions_grades: false, offers_free_or_low_pay: false, issues: bad ? [{ rule: 5, quote: 'Hi Anna', problem: 'wrong name', fix: 'use Rasmus' }] : [], score: bad ? 30 : 93, verdict: bad ? 'fail' : 'pass' };
  }
  if (/classify replies/.test(sys)) return { category: 'interested', summary: 'Wants a call next Tuesday.', next_step: 'Propose two slots.', referral_to: '', language: 'en', confidence: 0.9 };
  if (/follow-up email/.test(sys)) return { body: `Hi ${user.recipient.first_name},\n\nA short addition to my last email: I also built a Teams RAG assistant that answers HR questions in Dutch with citations. Would a 15-minute call next week work?` };
  return {};
}

http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname; const b = req.method === 'POST' ? await body(req) : {};
  state.calls.push(`${req.method} ${p}`);
  try {
    // ---- admin ----
    if (p === '/admin/state') return send(res, 200, state);
    if (p === '/admin/flag') { Object.assign(state, b); return send(res, 200, { ok: 1 }); }
    if (p === '/admin/set') { const { tab, keyCol, key, col, value } = b; const t = state.tabs[tab]; const h = t[0]; t.filter((r, i) => i && (key === '*' || r[h.indexOf(keyCol)] === key)).forEach(r => { while (r.length <= h.indexOf(col)) r.push(''); r[h.indexOf(col)] = value; }); return send(res, 200, { ok: 1 }); }
    if (p === '/admin/reply') { state.replies[b.threadId] = (state.replies[b.threadId] || []).concat([b.message]); return send(res, 200, { ok: 1 }); }
    // ---- Sheets ----
    let m;
    if ((m = p.match(/^\/sheets\/v4\/spreadsheets\/[^/]+\/values:batchGet$/))) {
      const ranges = [].concat(u.query.ranges);
      return send(res, 200, { valueRanges: ranges.map(r => ({ range: `${r}!A1:Z${state.tabs[r].length}`, majorDimension: 'ROWS', values: trim(state.tabs[r]) })) });
    }
    if (p.endsWith('/values:batchUpdate')) {
      if (!b.data || !b.data.length) return send(res, 400, { error: { code: 400, message: 'Must specify at least one data' } });
      if (b.valueInputOption !== 'RAW') return send(res, 400, { error: { message: 'bad valueInputOption' } });
      for (const d of b.data) { const r = d.range.match(/^'?([^'!]+)'?!([A-Z]+)(\d+)$/); const t = state.tabs[r[1]]; const ri = Number(r[3]) - 1, ci = colIdx(r[2]); while (t.length <= ri) t.push([]); while (t[ri].length <= ci) t[ri].push(''); t[ri][ci] = d.values[0][0]; }
      return send(res, 200, { totalUpdatedCells: b.data.length });
    }
    if ((m = p.match(/\/values\/([^!]+)!A1:append$/))) {
      if (!Array.isArray(b.values) || !b.values.length) return send(res, 400, { error: { message: 'no values' } });
      b.values.forEach(v => state.tabs[decodeURIComponent(m[1])].push(v)); return send(res, 200, { updates: { updatedRows: b.values.length } });
    }
    // ---- Gmail ----
    if (p === '/gmail/gmail/v1/users/me/messages/send') {
      const id = 'gm' + (state.sent.length + 1); const threadId = b.threadId || 'th' + (state.sent.length + 1);
      const mime = Buffer.from(b.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
      state.sent.push({ id, threadId, mime }); return send(res, 200, { id, threadId, labelIds: ['SENT'] });
    }
    if ((m = p.match(/^\/gmail\/gmail\/v1\/users\/me\/messages\/(\w+)$/))) return send(res, 200, { id: m[1], payload: { headers: [{ name: 'Message-ID', value: `<${m[1]}@mock.mail>` }] } });
    if ((m = p.match(/^\/gmail\/gmail\/v1\/users\/me\/threads\/(\w+)$/))) {
      const mine = state.sent.filter(s => s.threadId === m[1]).map(s => ({ id: s.id, labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Owner <owner@example.com>' }] } }));
      return send(res, 200, { id: m[1], messages: mine.concat(state.replies[m[1]] || []) });
    }
    // ---- LLMs ----
    if (p === '/gemini/chat/completions' || p === '/groq/chat/completions') {
      if (p.startsWith('/gemini') && state.failGemini) return send(res, 503, { error: { message: 'overloaded' } });
      return send(res, 200, { choices: [{ message: { content: JSON.stringify(llm(b)) } }], model: b.model });
    }
    // ---- Hunter / Reoon / DoH ----
    if (p === '/hunter/v2/email-finder') return send(res, 200, u.query.first_name === 'Kim' ? { data: { email: null } } : { data: { email: `${u.query.first_name.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase()}@${u.query.domain}`, score: 85, verification: { status: 'valid' }, sources: [] } });
    if (p === '/reoon/api/v1/verify') return send(res, 200, /^dennis@/.test(u.query.email) ? { status: 'catch_all', overall_score: 60 } : { status: 'safe', overall_score: 97, is_deliverable: true });
    if (p === '/doh/dns-query') return send(res, 200, u.query.name === 'getkiku.com' ? { Status: 3 } : { Status: 0, Answer: [{ name: u.query.name, type: 15, data: '10 mx.' + u.query.name + '.' }] }, 'application/dns-json');
    // ---- Telegram ----
    if (p === '/telegram/sendMessage') { state.telegram.push(b.text); return send(res, 200, { ok: true }); }
    send(res, 404, { error: 'no route ' + p });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => console.log('mock on', PORT));
