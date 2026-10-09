// ---- NODE: Select drafts for QC ----
// @node qc_select
const QC_SYSTEM = __QC_SYSTEM__;
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages, C = T.Contacts, P = T.Profile, CO = T.Companies, cfg = configOf(T.Config);
requireCols(M, ['msg_id', 'contact_id', 'type', 'subject', 'body', 'status', 'qc_score', 'qc_reasons', 'qc_model', 'qc_hash', 'qc_at', 'approved', 'updated_at']);
requireCols(C, ['contact_id', 'first_name', 'last_name', 'role', 'company', 'company_no']);
const contacts = Object.fromEntries(C.rows.map(c => [str(c.contact_id), c]));
const companyRows = CO ? CO.rows : [];
const companyByNo = Object.fromEntries(companyRows.map(r => [str(r['#']), r]));
const facts = P.rows.filter(f => str(f.fact).trim()).map(f => `${f.fact_id}: ${f.fact}`);
const today = now();
const BATCH = cfg.num('QC_BATCH', 6);

const CLICHES = ['hope this email finds you', 'hope this finds you', 'hope you are well', "hope you're well", 'hope you are doing well', "hope you're doing well", 'passionate', 'reaching out', 'reach out', 'i am writing to', "i'm writing to", 'touch base', 'circle back', 'circling back', 'just following up', 'just wanted to', 'bumping this', 'synergy', 'rockstar', 'ninja', 'guru', 'game-changer', 'game changer', 'cutting-edge', 'cutting edge', 'thrilled', 'excited to', 'dream job', 'to whom it may concern', 'dear sir or madam', 'sorry to bother', 'quick question', 'i know you are busy', "i know you're busy"];
const GRADES = /\b(gpa|grades?|graded|transcripts?|cum laude|summa|magna|honou?rs degree|mention (bien|tr[eè]s bien)|valedictorian|top \d+ ?%|ranked (first|1st|top)|\d{1,2}([.,]\d+)?\s?\/\s?20)\b/i;
const FREE = /\b(for free|unpaid|without (pay|salary|compensation)|no (pay|salary)|free of charge|pro bono|volunteer(ing)?|low (pay|salary|wage)|small (salary|stipend|pay)|minimal (pay|salary|compensation)|any salary|whatever (you can )?pay|reduced (pay|salary)|don'?t need to be paid|no compensation)\b/i;
const PLACEHOLDER = /(\{\{|\}\}|\[[^\]\n]{1,40}\]|<[A-Z_ ]{3,}>|\bTODO\b|\bTBD\b|\bXXX+\b|\bFIRST_?NAME\b|\bCOMPANY_?NAME\b|lorem ipsum|follow up on:|address:\s*not public|check linkedin)/i;
const SIGNATURE_LEAK = new RegExp('__SIGNATURE_LEAK__', 'i'); // owner's phone/site/handles (build_config.OWNER)
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pastDates(text) {
  const found = [];
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const yr = (y, m) => y ? Number(y) : (m < today.month - 6 ? today.year + 1 : today.year);
  // "16–28 October", "16 and 28 October", "12 Oct 2026"
  const re1 = new RegExp(`\\b(\\d{1,2})(?:\\s*(?:[–—-]|to|and|until)\\s*(\\d{1,2}))?\\s+${mon}(?:\\s+(\\d{4}))?`, 'gi');
  let m;
  while ((m = re1.exec(text))) {
    const month = MONTHS[m[3].slice(0, 3).toLowerCase()];
    const day = Number(m[2] || m[1]);
    const d = DateTime.fromObject({ year: yr(m[4], month), month, day }, { zone: TZ });
    if (d.isValid && d.endOf('day') < today) found.push(m[0]);
  }
  // "October 12", "February 2027"
  const re2 = new RegExp(`\\b${mon}\\s+(\\d{1,4})\\b`, 'gi');
  while ((m = re2.exec(text))) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const n = Number(m[2]);
    const d = n > 31 ? DateTime.fromObject({ year: n, month }, { zone: TZ }).endOf('month') : DateTime.fromObject({ year: yr('', month), month, day: n }, { zone: TZ }).endOf('day');
    if (d.isValid && d < today) found.push(m[0]);
  }
  return found;
}

function detChecks(msg, c) {
  const fails = [], warns = [];
  const type = str(msg.type).trim() || 'cold';
  const subject = str(msg.subject).trim();
  const body = str(msg.body).replace(/\r/g, '').trim();
  const lines = body.split('\n');
  const greetM = lines[0].match(/^(hi|hello|hej|dear|good (morning|afternoon))\s+([^,!\n]+)[,!]?\s*$/i);
  const bodyNoGreet = greetM ? lines.slice(1).join('\n') : body;
  const wc = words(bodyNoGreet);
  const sw = words(subject);
  const q = (bodyNoGreet.match(/\?/g) || []).length;
  if (!c) fails.push(`contact_id "${msg.contact_id}" not found in Contacts`);
  if (type === 'cold') {
    if (wc < 80 || wc > 140) fails.push(`Body has ${wc} words (rule: 80–140, greeting excluded)`);
    if (!subject) fails.push('Subject is empty');
    else if (sw > 8) fails.push(`Subject has ${sw} words (max 8)`);
    if (q === 0) fails.push('No clear ask (no question in body)');
  } else {
    if (wc + (greetM ? words(lines[0]) : 0) > 50) fails.push(`Follow-up has ${wc + (greetM ? words(lines[0]) : 0)} words (max 50)`);
  }
  if (q > 1) fails.push(`${q} questions in body: keep exactly one ask`);
  if (!greetM) (type === 'cold' ? fails : warns).push('No greeting line like "Hi <first name>,"');
  else if (/\s(and|&|och|og)\s|,/i.test(greetM[3].trim())) fails.push(`Greeting addresses several people ("${greetM[3].trim()}"): one email per person`);
  else if (c) {
    const g = norm(greetM[3]).split(/\s+/)[0];
    if (g !== norm(c.first_name).split(/\s+/)[0]) fails.push(`Greeting says "${greetM[3].trim()}" but recipient first_name is "${c.first_name}"`);
  }
  const low = (subject + '\n' + body).toLowerCase();
  const cl = CLICHES.filter(x => low.includes(x));
  if (cl.length) fails.push(`Cliché(s): ${cl.map(x => `"${x}"`).join(', ')}`);
  if (GRADES.test(subject + ' ' + body)) fails.push(`Mentions grades: "${(subject + ' ' + body).match(GRADES)[0]}"`);
  if (FREE.test(subject + ' ' + body)) fails.push(`Offers free/low-paid work: "${(subject + ' ' + body).match(FREE)[0]}"`);
  const ph = (subject + '\n' + body).match(PLACEHOLDER);
  if (ph) fails.push(`Placeholder/leftover: "${ph[0]}"`);
  if (SIGNATURE_LEAK.test(body)) fails.push('Body contains signature/contact details: remove them (signature is added automatically)');
  const pd = pastDates(subject + '\n' + body);
  if (pd.length) fails.push(`Date(s) already passed: ${pd.map(x => `"${x}"`).join(', ')}`);
  // other target companies named in the email (possible copy-paste error)
  if (c) {
    const own = norm(c.company);
    const others = [...new Set(C.rows.map(x => str(x.company).replace(/\s*\(.*\)\s*/g, '').trim()).filter(n => n.length >= 5 && !own.includes(norm(n))))];
    const hit = others.filter(n => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(subject + '\n' + body));
    if (hit.length) warns.push(`Mentions other target company: ${hit.join(', ')}`);
  }
  return { fails, warns, stats: { words: wc, subject_words: sw, questions: q, type } };
}

const out = [];
for (const m of M.rows) {
  const st = str(m.status).trim();
  if (!['', 'draft', 'needs_fix', 'ready'].includes(st)) continue;
  if (!str(m.body).trim()) continue;
  const h = contentHash(m);
  const changed = str(m.qc_hash) !== h;
  if ((st === 'ready' || st === 'needs_fix') && !changed) continue;
  if (out.length >= BATCH) break;
  const c = contacts[str(m.contact_id)] || null;
  const det = detChecks(m, c);
  const co = c ? (companyByNo[str(c.company_no)] || {}) : {};
  const userPayload = {
    today: today.toISODate(),
    message: { type: str(m.type) || 'cold', subject: str(m.subject), body: str(m.body) },
    recipient: c ? {
      first_name: c.first_name, last_name: c.last_name, role: c.role, company: c.company,
      company_info: { what_they_do: str(co['What they do']), why_louai_fits: str(co['Why you fit']), notes: str(co['Notes']), funding_size: str(co['Funding / size']), city: str(co['City']) },
    } : null,
    profile_facts: facts,
    deterministic_findings: det.fails.concat(det.warns),
  };
  const messages = [{ role: 'system', content: QC_SYSTEM }, { role: 'user', content: JSON.stringify(userPayload) }];
  const base = { temperature: 0, response_format: { type: 'json_object' }, messages };
  out.push({ json: {
    msg: m, contact: c, hash: h, det,
    wasApproved: truthy(m.approved), changedAfterQC: changed && !!str(m.qc_hash),
    req_primary: { model: cfg.str('LLM_PRIMARY_MODEL', 'gemini-3.5-flash'), ...base },
    req_fallback: { model: cfg.str('LLM_FALLBACK_MODEL', 'openai/gpt-oss-120b'), reasoning_effort: 'low', ...base },
  } });
}
return out;

// ---- NODE: Check primary LLM ----
// @node qc_check_primary
return $input.all().map((it, i) => {
  const ctx = $('Select drafts for QC').itemMatching(i).json;
  let llm = null, llm_error = '';
  try {
    if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
    llm = parseLLMJson(it.json.choices[0].message.content);
    if (typeof llm.verdict !== 'string' || !Array.isArray(llm.issues)) throw new Error('LLM JSON missing verdict/issues');
  } catch (e) { llm = null; llm_error = e.message; }
  return { json: { ...ctx, llm, llm_ok: !!llm, llm_error, llm_model: ctx.req_primary.model } };
});

// ---- NODE: QC decide ----
// @node qc_decide
const VIA = '__VIA__'; // 'primary' or 'fallback'
const T = tablesFrom($('Read Sheet').first().json);
const M = T.Messages;
const W = Writer(), logs = [], notices = [];
const inText = (q, m) => !q || norm(str(m.subject) + '\n' + str(m.body)).replace(/\s+/g, ' ').includes(norm(q).replace(/\s+/g, ' ').replace(/^["'“]|["'”]$/g, ''));
let pass = 0, fail = 0, down = 0;
$input.all().forEach((it, i) => {
  let ctx, llm = null, model, llmErr = '';
  if (VIA === 'primary') { ctx = it.json; llm = ctx.llm; model = ctx.llm_model; }
  else {
    ctx = $('Check primary LLM').itemMatching(i).json; model = ctx.req_fallback.model;
    try {
      if (it.json.error) throw new Error(JSON.stringify(it.json.error).slice(0, 300));
      llm = parseLLMJson(it.json.choices[0].message.content);
      if (typeof llm.verdict !== 'string' || !Array.isArray(llm.issues)) throw new Error('LLM JSON missing verdict/issues');
    } catch (e) { llm = null; llmErr = `primary: ${ctx.llm_error} | fallback: ${e.message}`; }
  }
  const m = ctx.msg;
  if (!llm) {
    down++;
    W.setMany(M, m._row, { qc_reasons: `QC waiting: both LLMs failed, retry next run. ${llmErr.slice(0, 300)}`, updated_at: iso() });
    logs.push(logRow('QC', 'error', 'llm_unavailable', m.msg_id, m.contact_id, llmErr));
    return;
  }
  const fails = ctx.det.fails.slice();
  const type = ctx.det.stats.type;
  const lf = [];
  for (const cl of (llm.claims || [])) {
    if (cl && cl.supported === false && inText(cl.quote, m)) lf.push(`Unsupported ${cl.about === 'recipient_company' ? 'claim about the company' : 'claim'}: "${cl.quote}"${cl.note ? ' — ' + cl.note : ''}`);
  }
  if (type === 'cold' && llm.personal_reason && (llm.personal_reason.present === false || llm.personal_reason.specific === false)) lf.push('No specific personal reason for contacting this recipient');
  if (llm.ask && type === 'cold' && Number(llm.ask.count) !== 1) lf.push(`Ask count = ${llm.ask.count} (need exactly one clear ask)`);
  if (llm.recipient_ok === false) lf.push('Recipient name/company problem');
  if (llm.mentions_grades === true) lf.push('Mentions grades');
  if (llm.offers_free_or_low_pay === true) lf.push('Offers free / low-paid work');
  for (const is of (llm.issues || [])) {
    if (!is) continue;
    const verified = inText(is.quote, m);
    lf.push(`R${is.rule}: ${is.problem}${is.quote ? ` — "${is.quote}"` : ''}${is.fix ? ` → ${is.fix}` : ''}${verified ? '' : ' (quote not found in text: check manually)'}`);
  }
  if (llm.verdict !== 'pass' && !lf.length) lf.push('LLM verdict: fail (no detail given)');
  const seen = new Set();
  const all = fails.concat(lf).filter(x => { const k = norm(x).slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
  const ok = all.length === 0;
  ok ? pass++ : fail++;
  const upd = {
    status: ok ? 'ready' : 'needs_fix',
    qc_score: typeof llm.score === 'number' ? llm.score : '',
    qc_reasons: ok ? `PASS${ctx.det.warns.length ? ' (notes: ' + ctx.det.warns.join('; ') + ')' : ''}` : all.map((x, k) => `${k + 1}. ${x}`).join('\n'),
    qc_model: model, qc_hash: ctx.hash, qc_at: iso(), updated_at: iso(),
  };
  if (ctx.wasApproved && (ctx.changedAfterQC || !ok)) {
    upd.approved = false;
    notices.push(`✏️ Approval cleared for ${m.msg_id} (${str(ctx.contact && ctx.contact.company)}): ${ctx.changedAfterQC ? 'draft was edited after QC' : 'draft failed QC'}. New QC result: ${upd.status}.`);
  }
  W.setMany(M, m._row, upd);
  logs.push(logRow('QC', ok ? 'info' : 'warn', ok ? 'qc_pass' : 'qc_fail', m.msg_id, m.contact_id, `${model} score=${upd.qc_score} ${ok ? '' : all.join(' | ').slice(0, 1500)}`));
});
if (down) notices.push(`⚠️ QC: ${down} draft(s) could not be checked: both LLM providers failed. Will retry in 15 min. See Log.`);
heartbeat(W, T, 'LAST_RUN_QC');
logs.push(logRow('QC', 'info', 'run', '', '', `QC(${VIA}) pass=${pass} fail=${fail} llm_down=${down}`));
return [{ json: { data: W.data, logs, notices } }];
