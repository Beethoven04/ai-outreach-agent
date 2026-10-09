// ---- NODE: Format error ----
// @node err_format
const e = $input.first().json;
const ex = e.execution || {}, wf = e.workflow || {}, er = ex.error || (e.trigger && e.trigger.error) || {};
const msg = str(er.message || 'unknown error');
let hint = 'Open the execution link, read the failing node, fix, then re-run.';
if (/missing column|header row/i.test(msg)) hint = 'A sheet header was renamed or deleted. Restore the exact column names (see docs/01_sheet_schema.md).';
else if (/invalid_grant|unauthori[sz]ed|401|token/i.test(msg)) hint = 'A credential expired or was revoked. Reconnect it in n8n → Credentials.';
else if (/quota|rate|429/i.test(msg)) hint = 'A provider rate limit was hit. It usually recovers on the next run.';
else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|socket|timeout/i.test(msg)) hint = 'Network/provider outage. Retried automatically on next schedule.';
else if (/Must specify at least one|batchUpdate/i.test(msg)) hint = 'Empty sheet update: check that Config has the LAST_RUN_* rows.';
const text = `🚨 WORKFLOW ERROR — ${str(wf.name)}\nNode: ${str(ex.lastNodeExecuted || er.node && er.node.name || '?')}\nError: ${msg.slice(0, 900)}\n${er.description ? 'Detail: ' + str(er.description).slice(0, 400) + '\n' : ''}When: ${iso()}\n${ex.url ? 'Execution: ' + ex.url + '\n' : ''}✔ Fix: ${hint}`;
return [{ json: { text, logs: [logRow(str(wf.name) || 'unknown', 'error', 'workflow_error', '', '', `${str(ex.lastNodeExecuted)}: ${msg}`)] } }];
