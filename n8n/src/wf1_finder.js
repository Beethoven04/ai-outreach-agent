// ---- NODE: Pick contacts to find ----
// @node finder_pick
const T = tablesFrom($('Read Sheet (finder)').first().json);
const C = T.Contacts;
requireCols(C, ['contact_id', 'company', 'company_domain', 'first_name', 'last_name', 'public_emails', 'email', 'email_source', 'email_status', 'email_detail', 'email_tried', 'email_checked_at', 'contact_status']);
const cfg = configOf(T.Config);
const BATCH = cfg.num('FINDER_BATCH', 5);
const out = [];
for (const c of C.rows) {
  if (out.length >= BATCH) break;
  const st = str(c.email_status).trim();
  if (st !== '' && st !== 'not_found') continue;
  if (['do_not_contact', 'bounced'].includes(str(c.contact_status).trim())) continue;
  const tried = str(c.email_tried).split(';').map(norm).filter(Boolean);
  let candidate = '', source = '';
  const manual = norm(c.email);
  if (manual && !tried.includes(manual)) { candidate = manual; source = str(c.email_source) || 'manual'; }
  if (!candidate) {
    const pubs = (str(c.public_emails).match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(norm);
    const fn = norm(c.first_name).replace(/[^a-z]/g, ''), ln = norm(c.last_name).replace(/[^a-z]/g, '');
    const personal = pubs.filter(e => !isRoleAddress(e) && !tried.includes(e)).filter(e => {
      const l = e.split('@')[0].replace(/[^a-z]/g, '');
      return (fn.length > 1 && l.includes(fn)) || (ln.length > 2 && l.includes(ln));
    });
    if (personal.length) { candidate = personal[0]; source = 'public'; }
  }
  const canHunter = !!str(c.company_domain).trim() && !!fn_(c) && !!str(c.last_name).trim();
  const needHunter = !candidate && canHunter && !tried.includes('hunter');
  // after Hunter: test the 2 most common formats; only accepted if the mailbox is confirmed to exist
  if (!candidate && !needHunter && str(c.company_domain).trim() && fn_(c)) {
    const a = s => norm(s).replace(/[^a-z]/g, '');
    const f = a(c.first_name.split(/\s+/)[0]), l = a(str(c.last_name).split(/\s+/).pop());
    const d = norm(c.company_domain).replace(/^www\./, '');
    const guesses = [f && `${f}@${d}`, f && l && `${f}.${l}@${d}`].filter(Boolean).filter(e => !tried.includes(e));
    if (guesses.length && !tried.includes('pattern_stop')) { candidate = guesses[0]; source = 'pattern'; }
  }
  if (st === 'not_found' && source !== 'pattern') continue; // retry not_found only when an untested format guess exists
  out.push({ json: { contact: c, candidate, source, needHunter, canHunter, tried } });
}
function fn_(c) { return str(c.first_name).trim(); }
return out;

// ---- NODE: Finder decide ----
// @node finder_decide
const VIA = '__VIA__'; // 'hunter' or 'direct'
const T = tablesFrom($('Read Sheet (finder)').first().json);
const C = T.Contacts;
const W = Writer(), logs = [], notices = [];
$input.all().forEach((it, i) => {
  const ctx = VIA === 'hunter' ? $('Pick contacts to find').itemMatching(i).json : it.json;
  const c = ctx.contact;
  const tried = ctx.tried.slice();
  const upd = { email_checked_at: iso() };
  if (VIA === 'hunter') {
    const r = it.json;
    const errTxt = r.error ? JSON.stringify(r.error).slice(0, 300) : '';
    if (errTxt) {
      const quota = /429|usage|limit|credits|quota|402/i.test(errTxt);
      logs.push(logRow('Finder', 'warn', quota ? 'hunter_quota' : 'hunter_error', '', c.contact_id, errTxt));
      if (quota) { notices.push(`⚠️ Hunter quota/limit reached. Finder pauses for ${c.full_name || c.first_name} (${c.company}) until credits reset.\n${errTxt}`); }
      W.setMany(C, c._row, upd);
      return; // retry next run
    }
    tried.push('hunter');
    const d = r.data || {};
    if (d.email && EMAIL_RE.test(d.email) && !isRoleAddress(d.email)) {
      Object.assign(upd, { email: norm(d.email), email_source: 'hunter_finder', email_status: 'to_verify', email_tried: tried.join(';'),
        email_detail: `hunter: score ${d.score ?? '?'}, ${d.verification && d.verification.status || 'unverified'}, ${(d.sources || []).length} sources` });
      logs.push(logRow('Finder', 'info', 'email_found', '', c.contact_id, `${d.email} via Hunter (score ${d.score})`));
    } else {
      Object.assign(upd, { email: '', email_status: 'not_found', email_tried: tried.join(';'), email_detail: 'Hunter found nothing' });
      logs.push(logRow('Finder', 'warn', 'email_not_found', '', c.contact_id, `tried: ${tried.join(';')}`));
    }
  } else if (ctx.candidate) {
    Object.assign(upd, { email: ctx.candidate, email_source: ctx.source, email_status: 'to_verify', email_detail: `candidate from ${ctx.source}` });
    logs.push(logRow('Finder', 'info', 'email_candidate', '', c.contact_id, `${ctx.candidate} (${ctx.source})`));
  } else {
    const why = !ctx.canHunter ? `cannot search: missing ${[!str(c.company_domain).trim() && 'company_domain', !str(c.first_name).trim() && 'first_name', !str(c.last_name).trim() && 'last_name'].filter(Boolean).join(', ')}` : 'all sources tried';
    Object.assign(upd, { email: '', email_status: 'not_found', email_detail: why });
    logs.push(logRow('Finder', 'warn', 'email_not_found', '', c.contact_id, why));
  }
  W.setMany(C, c._row, upd);
});
heartbeat(W, T, 'LAST_RUN_FINDER');
logs.push(logRow('Finder', 'info', 'run', '', '', `finder(${VIA}) processed ${$input.all().length}`));
return [{ json: { data: W.data, logs, notices } }];

// ---- NODE: Pick emails to verify ----
// @node verify_pick
const T = tablesFrom($('Read Sheet (verify)').first().json);
const C = T.Contacts;
requireCols(C, ['contact_id', 'email', 'email_status', 'email_detail', 'email_tried', 'email_attempts', 'email_checked_at', 'allow_risky']);
const cfg = configOf(T.Config);
const BATCH = cfg.num('VERIFY_BATCH', 5);
const out = [];
for (const c of C.rows) {
  if (out.length >= BATCH) break;
  if (str(c.email_status).trim() !== 'to_verify') continue;
  const email = norm(c.email);
  const syntax_ok = EMAIL_RE.test(email);
  out.push({ json: { contact: c, email, domain: syntax_ok ? email.split('@')[1] : 'invalid.invalid', syntax_ok, role: isRoleAddress(email) } });
}
return out;

// ---- NODE: MX evaluate ----
// @node mx_eval
return $input.all().map((it, i) => {
  const ctx = $('Pick emails to verify').itemMatching(i).json;
  const r = it.json;
  const answers = (r.Answer || []).filter(a => a.type === 15).map(a => String(a.data).split(' ').pop());
  const mx_ok = !r.error && r.Status === 0 && answers.length > 0 && !answers.every(h => h === '.' || h === '');
  const transient = !!r.error || (r.Status !== 0 && r.Status !== 3); // SERVFAIL etc. = DNS problem, not a bad address
  const mx_detail = transient ? `DNS lookup failed (status ${r.Status ?? 'error'}), will retry` : (r.Status === 3 ? 'domain does not exist (NXDOMAIN)' : (answers.length ? `MX: ${answers.slice(0, 2).join(', ')}` : 'no MX record (null MX or none)'));
  const pre_ok = ctx.syntax_ok && mx_ok && !ctx.role;
  return { json: { ...ctx, mx_ok, mx_detail, dns_error: transient, pre_ok } };
});

// ---- NODE: Reoon check ----
// @node reoon_check
return $input.all().map((it, i) => {
  const ctx = $('MX evaluate').itemMatching(i).json;
  const r = it.json;
  const txt = r.error ? JSON.stringify(r.error) : '';
  const out_of_credits = /credit|balance|limit|quota|429|402/i.test(txt) || /credit|balance/i.test(str(r.reason || r.message || ''));
  const KNOWN = ['safe', 'valid', 'invalid', 'disabled', 'disposable', 'inbox_full', 'catch_all', 'role_account', 'spamtrap', 'unknown'];
  const known = KNOWN.includes(String(r.status || '').toLowerCase());
  return { json: { ...ctx, reoon: r, reoon_ok: !r.error && known && !out_of_credits, reoon_out_of_credits: out_of_credits || (!r.error && !known) } };
});

// ---- NODE: Verify decide ----
// @node verify_decide
const VIA = '__VIA__'; // 'reoon' | 'hunter' | 'precheck'
const T = tablesFrom($('Read Sheet (verify)').first().json);
const C = T.Contacts;
const W = Writer(), logs = [], notices = [];
$input.all().forEach((it, i) => {
  const ctx = VIA === 'hunter' ? $('Reoon check').itemMatching(i).json : it.json;
  const c = ctx.contact;
  const attempts = Number(c.email_attempts || 0) + 1;
  const tried = str(c.email_tried).split(';').map(norm).filter(Boolean);
  const upd = { email_checked_at: iso(), email_attempts: attempts };
  let verdict = '', detail = '';
  if (VIA === 'precheck') {
    if (ctx.dns_error && ctx.syntax_ok && !ctx.role) { // DNS service problem: retry later
      detail = ctx.mx_detail; verdict = attempts >= 3 ? 'risky' : 'retry';
    } else {
      verdict = 'invalid';
      detail = !ctx.syntax_ok ? 'bad syntax' : ctx.role ? 'role/shared address (policy: personal addresses only)' : ctx.mx_detail;
    }
  } else if (VIA === 'hunter') {
    const r = it.json, d = r.data || {};
    if (r.error || !d.status) {
      detail = `Reoon out of credits; Hunter verifier error: ${JSON.stringify(r.error || r).slice(0, 160)}`;
      upd.email_attempts = attempts - 1; verdict = 'retry'; // both out of credits: wait, don't punish the address
      if (i === 0) notices.push(`⚠️ Reoon (20/day) and Hunter verifier both unavailable/out of credits. Verification continues automatically when credits reset.`);
    } else {
      const s2 = String(d.status).toLowerCase();
      detail = `hunter-verify: ${s2}, score ${d.score ?? '?'}, ${ctx.mx_detail}`;
      if (s2 === 'valid') verdict = 'valid';
      else if (['accept_all', 'unknown', 'webmail'].includes(s2)) verdict = 'risky';
      else verdict = 'invalid';
    }
  } else {
    const r = it.json.reoon || it.json;
    if (r.error || !r.status) {
      detail = `verifier error: ${JSON.stringify(r.error || r).slice(0, 200)}`;
      const outOfCredits = /credit|balance|limit|quota|429|402/i.test(detail);
      if (outOfCredits) { upd.email_attempts = attempts - 1; verdict = 'retry'; } // no credits ≠ bad address: just wait
      else verdict = attempts >= 3 ? 'risky' : 'retry';
      if (outOfCredits && i === 0) notices.push(`⚠️ Reoon verifier: daily credits used up (free = 20/day). Remaining emails are verified automatically tomorrow.\n${detail}`);
    } else {
      const s = String(r.status).toLowerCase();
      detail = `reoon: ${s}, score ${r.overall_score ?? '?'}, ${ctx.mx_detail}`;
      if (s === 'safe' || (s === 'valid' && r.is_deliverable)) verdict = 'valid';
      else if (['catch_all', 'unknown', 'inbox_full'].includes(s)) verdict = 'risky';
      else verdict = 'invalid'; // invalid, disabled, disposable, spamtrap, role_account
    }
  }
  if (verdict === 'retry') {
    upd.email_detail = detail;
    logs.push(logRow('Verify', 'warn', 'verify_retry', '', c.contact_id, detail));
  } else if (verdict === 'valid') {
    Object.assign(upd, { email_status: 'valid', email_detail: (str(c.email_source) === 'pattern' ? 'format guess CONFIRMED by mailbox check — ' : '') + detail });
    logs.push(logRow('Verify', 'info', 'email_valid', '', c.contact_id, `${ctx.email} — ${detail}`));
  } else if (verdict === 'risky' && str(c.email_source) === 'pattern') {
    if (!tried.includes(ctx.email)) tried.push(ctx.email);
    tried.push('pattern_stop'); // catch-all/unknown domain: any further guess is unconfirmable
    Object.assign(upd, { email: '', email_status: '', email_tried: tried.join(';'), email_attempts: 0, email_detail: `${ctx.email} guess not confirmable (${detail})` });
    logs.push(logRow('Verify', 'warn', 'email_invalid', '', c.contact_id, `pattern guess unconfirmable: ${ctx.email} — ${detail}`));
  } else if (verdict === 'risky') {
    Object.assign(upd, { email_status: 'risky', email_detail: detail });
    logs.push(logRow('Verify', 'warn', 'email_risky', '', c.contact_id, `${ctx.email} — ${detail}`));
  } else {
    if (!tried.includes(ctx.email)) tried.push(ctx.email);
    // reset so the finder tries the next source (public -> Hunter); finder reports not_found when exhausted
    Object.assign(upd, { email: '', email_status: '', email_tried: tried.join(';'), email_attempts: 0, email_detail: `${ctx.email} rejected: ${detail}` });
    logs.push(logRow('Verify', 'warn', 'email_invalid', '', c.contact_id, `${ctx.email} — ${detail}`));
  }
  W.setMany(C, c._row, upd);
});
heartbeat(W, T, 'LAST_RUN_VERIFY');
logs.push(logRow('Verify', 'info', 'run', '', '', `verify(${VIA}) processed ${$input.all().length}`));
return [{ json: { data: W.data, logs, notices } }];
