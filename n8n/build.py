#!/usr/bin/env python3
"""Build importable n8n workflow JSON files from src/*.js + prompts/*.md.

Usage:  python3 build.py            (uses build_config.json)
Edit build_config.json (sheet ID, Telegram chat ID, credential IDs) and re-run, then re-import.
"""
import json, os, re, subprocess, sys, tempfile, uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(ROOT, os.environ.get('BUILD_CONFIG', 'build_config.json'))))
OWNER = CFG.get('OWNER', {})


def owner(js):
    """Inject the owner's addresses / signature-leak pattern (kept out of src/ so the code is shareable)."""
    return (js.replace('__OWNER_FROM__', OWNER.get('from_email', ''))
              .replace('__OWNER_OTHER_EMAILS__', json.dumps(OWNER.get('other_emails', [])))
              .replace('__SIGNATURE_LEAK__', OWNER.get('signature_leak_regex', '(?!)').replace('\\', '\\\\')))
COMMON = open(os.path.join(ROOT, 'src/common.js')).read()
PROMPTS = {k: open(os.path.join(ROOT, f'prompts/{f}')).read().strip() for k, f in
           [('__QC_SYSTEM__', 'qc_system.md'), ('__REPLY_SYSTEM__', 'reply_system.md'), ('__FOLLOWUP_SYSTEM__', 'followup_system.md'),
            ('__REPLY_DRAFT_SYSTEM__', 'reply_draft_system.md'), ('__REPLY_EDIT_SYSTEM__', 'reply_edit_system.md')]}
SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/' + CFG['SHEET_ID']
GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'


def sections():
    out = {}
    for f in sorted(os.listdir(os.path.join(ROOT, 'src'))):
        if not f.startswith('wf'):
            continue
        txt = open(os.path.join(ROOT, 'src', f)).read()
        for part in re.split(r'(?m)^// ---- NODE: .*$', txt)[1:]:
            m = re.search(r'// @node (\w+)', part)
            out[m.group(1)] = part.split('\n', 2)[2] if part.startswith('\n// @node') else part
    return out


SEC = sections()


def cred(key):
    c = CFG['credentials'][key]
    return {'id': c.get('id') or key, 'name': c['name']}


class WF:
    def __init__(self, name):
        self.name, self.nodes, self.conn, self.x, self.y = name, [], {}, 0, 0

    def add(self, node, after=None, out=0, pos=None):
        node.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, self.name + node['name'])))
        if pos is None:
            if after:
                p = next(n for n in self.nodes if n['name'] == after)['position']
                pos = [p[0] + 260, p[1] + out * 220]
                while any(n['position'] == pos for n in self.nodes):
                    pos = [pos[0], pos[1] + 220]
            else:
                pos = [0, self.y]
                self.y += 700
        node['position'] = pos
        self.nodes.append(node)
        if after:
            outs = self.conn.setdefault(after, {'main': []})['main']
            while len(outs) <= out:
                outs.append([])
            outs[out].append({'node': node['name'], 'type': 'main', 'index': 0})
        return node['name']

    def json(self):
        settings = {'executionOrder': 'v1', 'timezone': 'Europe/Stockholm', 'saveManualExecutions': True,
                    'callerPolicy': 'workflowsFromSameOwner'}
        if CFG.get('ERROR_WORKFLOW_ID') and 'Error' not in self.name:
            settings['errorWorkflow'] = CFG['ERROR_WORKFLOW_ID']
        return {'name': self.name, 'nodes': self.nodes, 'connections': self.conn, 'settings': settings,
                'active': False, 'pinData': {}, 'meta': {'templateCredsSetupCompleted': False}}


def code(name, key, via=None):
    js = SEC[key]
    for k, v in PROMPTS.items():
        js = js.replace(k, json.dumps(v))
    if via:
        js = js.replace("'__VIA__'", repr(via))
    js = js.replace('__TG_CHAT_ID__', str(CFG.get('REPLY_BOT_CHAT_ID') or CFG['TELEGRAM_CHAT_ID']))
    full = owner(COMMON.replace('__SHEET_ID__', CFG['SHEET_ID']) + '\n' + js)
    return {'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2,
            'parameters': {'jsCode': full}}


def http(name, method, url, auth=None, body=None, query=None, headers=None, batch=None, timeout=60000,
         on_error=True, json_resp=False):
    p = {'method': method, 'url': url, 'options': {'timeout': timeout}}
    node = {'name': name, 'type': 'n8n-nodes-base.httpRequest', 'typeVersion': 4.2, 'parameters': p}
    if auth:
        kind, ckey = auth
        if kind in ('googleSheetsOAuth2Api', 'gmailOAuth2'):
            p['authentication'] = 'predefinedCredentialType'
            p['nodeCredentialType'] = kind
            node['credentials'] = {kind: cred(kind)}
        else:
            p['authentication'] = 'genericCredentialType'
            p['genericAuthType'] = kind
            node['credentials'] = {kind: cred(ckey)}
    if query:
        p['sendQuery'] = True
        p['queryParameters'] = {'parameters': [{'name': k, 'value': v} for k, v in query]}
    if headers:
        p['sendHeaders'] = True
        p['headerParameters'] = {'parameters': [{'name': k, 'value': v} for k, v in headers]}
    if body is not None:
        p['sendBody'] = True
        p['specifyBody'] = 'json'
        p['jsonBody'] = body
    if batch:
        p['options']['batching'] = {'batch': {'batchSize': batch[0], 'batchInterval': batch[1]}}
    if json_resp:
        p['options']['response'] = {'response': {'responseFormat': 'json'}}
    if on_error:
        node['onError'] = 'continueRegularOutput'
    return node


def read_sheet(name, tabs):
    q = '&'.join('ranges=' + t for t in tabs)
    return http(name, 'GET', f'{SHEETS}/values:batchGet?{q}&valueRenderOption=UNFORMATTED_VALUE',
                auth=('googleSheetsOAuth2Api', None), on_error=False)


def schedule(name, cron):
    return {'name': name, 'type': 'n8n-nodes-base.scheduleTrigger', 'typeVersion': 1.2,
            'parameters': {'rule': {'interval': [{'field': 'cronExpression', 'expression': cron}]}}}


def if_true(name, expr):
    return {'name': name, 'type': 'n8n-nodes-base.if', 'typeVersion': 2, 'parameters': {
        'conditions': {'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'loose'},
                       'conditions': [{'id': str(uuid.uuid5(uuid.NAMESPACE_URL, name)), 'leftValue': expr, 'rightValue': '',
                                       'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}],
                       'combinator': 'and'}, 'options': {}}}


def telegram(name):
    return {'name': name, 'type': 'n8n-nodes-base.telegram', 'typeVersion': 1.2,
            'parameters': {'chatId': str(CFG['TELEGRAM_CHAT_ID']),
                           'text': "={{ String($json.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}",
                           'additionalFields': {'appendAttribution': False, 'parse_mode': 'HTML', 'disable_web_page_preview': True}},
            'credentials': {'telegramApi': cred('telegramApi')}}


def telegram_html(name):
    """$json.html is already-escaped Telegram HTML (tables in <pre>, bold headings); used by the daily report"""
    node = telegram(name)
    node['parameters']['text'] = '={{ $json.html }}'
    return node


# ---- reply bot (second Telegram bot, credential 'telegramApi_replybot') ----
def bot_cred():
    return {'telegramApi': cred('telegramApi_replybot')}


def tg_card(name):
    """one draft card per item ($json.text = HTML, $json.msg_id, $json.ver) with the 4 buttons"""
    def btn(label, act):
        return {'text': label, 'additionalFields': {'callback_data': "={{ '" + act + "|' + $json.msg_id + '|' + $json.ver }}"}}
    return {'name': name, 'type': 'n8n-nodes-base.telegram', 'typeVersion': 1.2, 'onError': 'continueRegularOutput',
            'parameters': {'resource': 'message', 'operation': 'sendMessage', 'chatId': str(CFG.get('REPLY_BOT_CHAT_ID') or CFG['TELEGRAM_CHAT_ID']),
                           'text': '={{ $json.text }}', 'replyMarkup': 'inlineKeyboard',
                           'inlineKeyboard': {'rows': [{'row': {'buttons': [btn('✅ Send', 'send'), btn('✏️ Edit', 'edit')]}},
                                                       {'row': {'buttons': [btn('🔁 Regenerate', 'regen'), btn('❌ Skip', 'skip')]}}]},
                           'additionalFields': {'appendAttribution': False, 'parse_mode': 'HTML', 'disable_web_page_preview': True}},
            'credentials': bot_cred()}


def tg_say(name, expr):
    return {'name': name, 'type': 'n8n-nodes-base.telegram', 'typeVersion': 1.2, 'onError': 'continueRegularOutput',
            'parameters': {'resource': 'message', 'operation': 'sendMessage', 'chatId': str(CFG.get('REPLY_BOT_CHAT_ID') or CFG['TELEGRAM_CHAT_ID']),
                           'text': "={{ String(" + expr + ").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}",
                           'additionalFields': {'appendAttribution': False, 'parse_mode': 'HTML', 'disable_web_page_preview': True}},
            'credentials': bot_cred()}


def tg_edit(name, expr):
    """replace the card the button was pressed on (plain text, buttons removed)"""
    return {'name': name, 'type': 'n8n-nodes-base.telegram', 'typeVersion': 1.2, 'onError': 'continueRegularOutput',
            'parameters': {'resource': 'message', 'operation': 'editMessageText', 'messageType': 'message',
                           'chatId': "={{ $('Bot route').first().json.chat_id }}", 'messageId': "={{ $('Bot route').first().json.card_message_id }}",
                           'text': '={{ ' + expr + ' }}', 'replyMarkup': 'none', 'additionalFields': {'disable_web_page_preview': True}},
            'credentials': bot_cred()}


def tg_answer(name):
    return {'name': name, 'type': 'n8n-nodes-base.telegram', 'typeVersion': 1.2, 'onError': 'continueRegularOutput',
            'parameters': {'resource': 'callback', 'operation': 'answerQuery', 'queryId': '={{ $json.callback_id }}',
                           'additionalFields': {'text': '={{ $json.toast }}', 'show_alert': '={{ $json.alert }}'}},
            'credentials': bot_cred()}


def notices_node(name, decide):
    return {'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'parameters': {'jsCode':
        COMMON.replace('__SHEET_ID__', CFG['SHEET_ID']) +
        f"\nconst d = $('{decide}').first().json;\nreturn (d.notices || []).flatMap(t => chunk(t)).map(text => ({{ json: {{ text }} }}));"}}


def gate_node(name, decide, field):
    return {'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'parameters': {'jsCode':
        f"const d = $('{decide}').first().json;\nreturn (d.{field} || []).length ? [{{ json: {{ values: d.{field} }} }}] : [];"}}


def tail(wf, decide, suffix, appends=(), out=0, src=None):
    """decide -> write cells -> append Log -> notices -> Telegram ; + optional appends to other tabs
    (decide may be an IF node: out picks its branch, src names the Code node that holds logs/notices)"""
    w = wf.add(http(f'Write updates {suffix}', 'POST', f'{SHEETS}/values:batchUpdate',
                    auth=('googleSheetsOAuth2Api', None), on_error=False,
                    body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $json.data }) }}"), after=decide, out=out)
    decide = src or decide
    lg = wf.add(http(f'Append Log {suffix}', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                     auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body=f"={{{{ JSON.stringify({{ values: $('{decide}').first().json.logs }}) }}}}"), after=w)
    nt = wf.add(notices_node(f'Notices {suffix}', decide), after=lg)
    wf.add(telegram(f'Telegram {suffix}'), after=nt)
    for tab, field in appends:
        g = wf.add(gate_node(f'Has {tab} rows? {suffix}', decide, field), after=lg, out=0)
        wf.add(http(f'Append {tab} {suffix}', 'POST', f'{SHEETS}/values/{tab}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                    auth=('googleSheetsOAuth2Api', None), on_error=False,
                    body='={{ JSON.stringify({ values: $json.values }) }}'), after=g)


def gmail_search(name, q_expr, max_results='50'):
    """Gmail messages.list (ids only, 5 quota units): used as a cheap "did this already happen?" check"""
    return http(name, 'GET', f'{GMAIL}/messages', auth=('gmailOAuth2', None), query=[('q', q_expr), ('maxResults', max_results)])


def llm(name, provider, req_field, batch_ms):
    url, ck = (GEMINI_URL, 'httpHeaderAuth_gemini') if provider == 'gemini' else (GROQ_URL, 'httpHeaderAuth_groq')
    expr = f"={{{{ JSON.stringify($json.{req_field}) }}}}" if req_field.startswith('req') else req_field
    node = http(name, 'POST', url, auth=('httpHeaderAuth', ck), body=expr, batch=(1, batch_ms), timeout=90000)
    node.update({'retryOnFail': True, 'maxTries': 3, 'waitBetweenTries': 5000})  # rides out 503 "high demand" spikes
    return node


# ---------------- workflows ----------------
def wf0():
    wf = WF('Outreach 0 · Error handler')
    t = wf.add({'name': 'On workflow error', 'type': 'n8n-nodes-base.errorTrigger', 'typeVersion': 1, 'parameters': {}})
    f = wf.add(code('Format error', 'err_format'), after=t)
    tg = wf.add(telegram('Telegram alert'), after=f)
    wf.add(http('Append Log', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                auth=('googleSheetsOAuth2Api', None),
                body="={{ JSON.stringify({ values: $('Format error').first().json.logs }) }}"), after=tg)
    return wf


def wf1():
    wf = WF('Outreach 1 · Find & verify emails')
    s = wf.add(schedule('Every 30 min', '*/30 * * * *'))
    r = wf.add(read_sheet('Read Sheet (finder)', ['Config', 'Contacts']), after=s)
    p = wf.add(code('Pick contacts to find', 'finder_pick'), after=r)
    i = wf.add(if_true('Needs Hunter?', '={{ $json.needHunter }}'), after=p)
    h = wf.add(http('Hunter: email finder', 'GET', 'https://api.hunter.io/v2/email-finder',
                    auth=('httpQueryAuth', 'httpQueryAuth_hunter'), batch=(1, 1500),
                    query=[('domain', '={{ $json.contact.company_domain }}'), ('first_name', '={{ $json.contact.first_name }}'),
                           ('last_name', '={{ $json.contact.last_name }}')]), after=i, out=0)
    d1 = wf.add(code('Finder decide (hunter)', 'finder_decide', 'hunter'), after=h)
    tail(wf, d1, '(finder hunter)')
    d2 = wf.add(code('Finder decide (direct)', 'finder_decide', 'direct'), after=i, out=1)
    tail(wf, d2, '(finder direct)')
    # verify chain
    r2 = wf.add(read_sheet('Read Sheet (verify)', ['Config', 'Contacts']), after=s, out=0)
    vp = wf.add(code('Pick emails to verify', 'verify_pick'), after=r2)
    dns = wf.add(http('DNS: MX lookup', 'GET', 'https://cloudflare-dns.com/dns-query',
                      query=[('name', '={{ $json.domain }}'), ('type', 'MX')], headers=[('accept', 'application/dns-json')],
                      batch=(1, 300), json_resp=True), after=vp)
    mx = wf.add(code('MX evaluate', 'mx_eval'), after=dns)
    i2 = wf.add(if_true('Syntax + MX OK?', '={{ $json.pre_ok }}'), after=mx)
    rv = wf.add(http('Reoon: verify mailbox', 'GET', 'https://emailverifier.reoon.com/api/v1/verify',
                     auth=('httpQueryAuth', 'httpQueryAuth_reoon'), batch=(1, 2000), timeout=120000,
                     query=[('email', '={{ $json.email }}'), ('mode', 'power')]), after=i2, out=0)
    rc = wf.add(code('Reoon check', 'reoon_check'), after=rv)
    i3 = wf.add(if_true('Reoon answered?', '={{ $json.reoon_ok }}'), after=rc)
    v1 = wf.add(code('Verify decide (reoon)', 'verify_decide', 'reoon'), after=i3, out=0)
    tail(wf, v1, '(verify reoon)')
    hv = wf.add(http('Hunter: verify email (fallback)', 'GET', 'https://api.hunter.io/v2/email-verifier',
                     auth=('httpQueryAuth', 'httpQueryAuth_hunter'), batch=(1, 1500), timeout=60000,
                     query=[('email', '={{ $json.email }}')]), after=i3, out=1)
    v3 = wf.add(code('Verify decide (hunter)', 'verify_decide', 'hunter'), after=hv)
    tail(wf, v3, '(verify hunter)')
    v2 = wf.add(code('Verify decide (precheck)', 'verify_decide', 'precheck'), after=i2, out=1)
    tail(wf, v2, '(verify precheck)')
    return wf


def wf2():
    wf = WF('Outreach 2 · Quality check (LLM)')
    s = wf.add(schedule('Every 15 min', '*/15 * * * *'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Profile', 'Companies']), after=s)
    sel = wf.add(code('Select drafts for QC', 'qc_select'), after=r)
    p = wf.add(llm('LLM primary (Gemini)', 'gemini', 'req_primary', 7000), after=sel)
    c = wf.add(code('Check primary LLM', 'qc_check_primary'), after=p)
    i = wf.add(if_true('Primary OK?', '={{ $json.llm_ok }}'), after=c)
    d1 = wf.add(code('QC decide (primary)', 'qc_decide', 'primary'), after=i, out=0)
    tail(wf, d1, '(qc primary)')
    fb = wf.add(llm('LLM fallback (Groq)', 'groq', 'req_fallback', 20000), after=i, out=1)
    d2 = wf.add(code('QC decide (fallback)', 'qc_decide', 'fallback'), after=fb)
    tail(wf, d2, '(qc fallback)')
    return wf


def wf3():
    wf = WF('Outreach 3 · Sender')
    s = wf.add(schedule('Every 5 min, Mon-Fri 07-18', '*/5 7-18 * * 1-5'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Log']), after=s)
    p = wf.add(code('Pick next email', 'send_pick'), after=r)
    # emails Louai sent by hand are not in the sheet until the hourly sync: ask Gmail Sent right before sending (one cheap search)
    gq = wf.add(gmail_search('Gmail: sent by hand?', "={{ $json.guard_q }}"), after=p)
    gd = wf.add(code('Manual send guard', 'send_guard'), after=gq)
    gi = wf.add(if_true('Nothing sent by hand?', '={{ $json.guard_ok }}'), after=gd)
    tail(wf, gi, '(on hold)', out=1, src=gd)
    lk = wf.add(http('Lock row (status=sending)', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None),
                     on_error=False, body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $json.lock }) }}"), after=gi, out=0)
    w = wf.add({'name': 'Random delay', 'type': 'n8n-nodes-base.wait', 'typeVersion': 1.1,
                'parameters': {'amount': "={{ $('Pick next email').first().json.jitter }}", 'unit': 'seconds'}}, after=lk)
    i = wf.add(if_true('Really send? (not DRY_RUN)', "={{ $('Pick next email').first().json.mode !== 'dry_run' }}"), after=w)
    g = wf.add(http('Gmail: send', 'POST', f'{GMAIL}/messages/send', auth=('gmailOAuth2', None),
                    body="={{ JSON.stringify($('Pick next email').first().json.gmail_payload) }}"), after=i, out=0)
    m = wf.add(http('Gmail: read Message-ID', 'GET', '=' + f'{GMAIL}/messages/' + '{{ $json.id }}', auth=('gmailOAuth2', None),
                    query=[('format', 'metadata'), ('metadataHeaders', 'Message-ID')]), after=g)
    a1 = wf.add(code('After send (gmail)', 'send_after', 'gmail'), after=m)
    tail(wf, a1, '(send)')
    a2 = wf.add(code('After send (dry)', 'send_after', 'dry'), after=i, out=1)
    tail(wf, a2, '(dry)')
    return wf


def wf4():
    wf = WF('Outreach 4 · Reply & bounce watcher')
    # :02/:17/:32/:47 so its burst of Gmail thread reads never shares a minute with the Sender (*/5); same minute → 403 'Units per minute per user' on 12 Oct
    s = wf.add(schedule('Every 15 min', '2-59/15 * * * *'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Replies']), after=s)
    # replies outside our threads (new thread, manual sends): one inbox search by the domains we emailed, then the normal thread path
    q = wf.add(code('Inbox search query', 'rw_search'), after=r)
    sr = wf.add(http('Gmail: search inbox', 'GET', f'{GMAIL}/messages', auth=('gmailOAuth2', None),
                     query=[('q', "={{ $json.q || 'in:inbox -in:inbox' }}"), ('maxResults', '500')]), after=q)
    t = wf.add(code('Threads to check', 'rw_threads'), after=sr)
    g = wf.add(http('Gmail: get thread', 'GET', '=' + f'{GMAIL}/threads/' + '{{ $json.thread_id }}', auth=('gmailOAuth2', None),
                    query=[('format', 'full')], batch=(5, 1000)), after=t)
    d = wf.add(code('Detect new replies', 'rw_detect'), after=g)
    i = wf.add(if_true('Human reply? (needs LLM)', '={{ $json.needs_llm }}'), after=d)
    p = wf.add(llm('LLM primary (Gemini)', 'gemini', 'req_primary', 7000), after=i, out=0)
    c = wf.add(code('Check primary LLM (replies)', 'rw_check_primary'), after=p)
    i2 = wf.add(if_true('Primary OK?', '={{ $json.llm_ok }}'), after=c)
    a1 = wf.add(code('Apply replies (primary)', 'rw_apply', 'primary'), after=i2, out=0)
    tail(wf, a1, '(primary)', appends=[('Replies', 'appendReplies'), ('Contacts', 'appendContacts'), ('Messages', 'appendMessages')])
    fb = wf.add(llm('LLM fallback (Groq)', 'groq', 'req_fallback', 20000), after=i2, out=1)
    a2 = wf.add(code('Apply replies (fallback)', 'rw_apply', 'fallback'), after=fb)
    tail(wf, a2, '(fallback)', appends=[('Replies', 'appendReplies'), ('Contacts', 'appendContacts'), ('Messages', 'appendMessages')])
    a3 = wf.add(code('Apply replies (no LLM)', 'rw_apply', 'none'), after=i, out=1)
    tail(wf, a3, '(no LLM)', appends=[('Replies', 'appendReplies'), ('Contacts', 'appendContacts'), ('Messages', 'appendMessages')])
    return wf


def wf5():
    wf = WF('Outreach 5 · Follow-up drafts')
    s = wf.add(schedule('Mon-Fri 07:15', '15 7 * * 1-5'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Profile']), after=s)
    sel = wf.add(code('Due follow-ups', 'fu_select'), after=r)
    p = wf.add(llm('LLM primary (Gemini)', 'gemini', 'req_primary', 7000), after=sel)
    c = wf.add(code('Check primary LLM (follow-ups)', 'fu_check_primary'), after=p)
    i = wf.add(if_true('Primary OK?', '={{ $json.llm_ok }}'), after=c)
    d1 = wf.add(code('Create follow-up drafts (primary)', 'fu_create', 'primary'), after=i, out=0)
    tail(wf, d1, '(fu primary)', appends=[('Messages', 'appendMessages')])
    fb = wf.add(llm('LLM fallback (Groq)', 'groq', 'req_fallback', 20000), after=i, out=1)
    d2 = wf.add(code('Create follow-up drafts (fallback)', 'fu_create', 'fallback'), after=fb)
    tail(wf, d2, '(fu fallback)', appends=[('Messages', 'appendMessages')])
    return wf


def wf6():
    wf = WF('Outreach 6 · Daily report')
    s = wf.add(schedule('Daily 18:00', '0 18 * * *'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Replies', 'Log']), after=s)
    b = wf.add(code('Build daily report', 'report_build'), after=r)
    wf.add(telegram_html('Telegram report'), after=b)  # 3 messages in order: sent table, replies, day summary
    return wf


def wf7():
    wf = WF('Outreach 7 · Reply assistant (bot)')
    # A) drafter: new Replies rows -> LLM draft -> Messages row (awaiting_ok) -> card in the reply bot
    #    (no calendar check: Louai's calendar is on his Mac, he checks it himself before pressing ✅)
    s = wf.add(schedule('Every 5 min', '*/5 * * * *'))
    r = wf.add(read_sheet('Read Sheet (drafter)', ['Config', 'Contacts', 'Messages', 'Replies', 'Profile']), after=s)
    p = wf.add(code('Pick replies to draft', 'rd_pick'), after=r)
    b = wf.add(code('Build draft requests', 'rd_build'), after=p)
    l1 = wf.add(llm('LLM primary (Gemini)', 'gemini', 'req_primary', 7000), after=b)
    c = wf.add(code('Check primary LLM (drafts)', 'rd_check'), after=l1)
    i = wf.add(if_true('Primary OK?', '={{ $json.llm_ok }}'), after=c)
    for via, src in (('primary', (i, 0)), ('fallback', None)):
        if src is None:
            src = (wf.add(llm('LLM fallback (Groq)', 'groq', 'req_fallback', 20000), after=i, out=1), 0)
        d = wf.add(code(f'Create reply drafts ({via})', 'rd_create', via), after=src[0], out=src[1])
        g = wf.add(gate_node(f'Has drafts? ({via})', d, 'appendMessages'), after=d)
        a = wf.add(http(f'Append Messages ({via})', 'POST', f'{SHEETS}/values/Messages!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                        auth=('googleSheetsOAuth2Api', None), on_error=False, body='={{ JSON.stringify({ values: $json.values }) }}'), after=g)
        w = wf.add(http(f'Write updates ({via})', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                        body=f"={{{{ JSON.stringify({{ valueInputOption: 'RAW', data: $('{d}').first().json.data }}) }}}}"), after=a)
        lg = wf.add(http(f'Append Log ({via})', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                         auth=('googleSheetsOAuth2Api', None), on_error=False,
                         body=f"={{{{ JSON.stringify({{ values: $('{d}').first().json.logs }}) }}}}"), after=w)
        k = wf.add(cards_node(f'Cards ({via})', d), after=lg)
        wf.add(tg_card(f'Send card ({via})'), after=k)

    # B) the bot: buttons + typed edits from Louai's chat only
    t = wf.add({'name': 'Reply bot trigger', 'type': 'n8n-nodes-base.telegramTrigger', 'typeVersion': 1.2,
                'webhookId': str(uuid.uuid5(uuid.NAMESPACE_URL, 'outreach-reply-bot')),
                'parameters': {'updates': ['message', 'callback_query'], 'additionalFields': {}}, 'credentials': bot_cred()})
    rb = wf.add(read_sheet('Read Sheet (bot)', ['Config', 'Contacts', 'Messages', 'Replies', 'Profile', 'Log']), after=t)
    rt = wf.add(code('Bot route', 'bot_route'), after=rb)
    an = wf.add(tg_answer('Answer button'), after=rt)
    act = lambda a: "={{ $('Bot route').first().json.action === '" + a + "' }}"
    i1 = wf.add(if_true('Send?', act('send')), after=an)
    # ✅: first ask Gmail Sent whether Louai already answered by hand (not in the sheet until the hourly sync)
    hq = wf.add(gmail_search('Gmail: sent by hand? (bot)', "={{ $('Bot route').first().json.guard_q }}"), after=i1, out=0)
    hc = wf.add(code('Hand check (bot)', 'bot_hand_check'), after=hq)
    ih = wf.add(if_true('Clear to send?', '={{ $json.clear }}'), after=hc)
    wh = wf.add(http('Write updates (by hand)', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $('Hand check (bot)').first().json.data }) }}"), after=ih, out=1)
    lh = wf.add(http('Append Log (by hand)', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                     auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ values: $('Hand check (bot)').first().json.logs }) }}"), after=wh)
    wf.add(tg_edit('Card: answered by hand', "$('Hand check (bot)').first().json.card_text"), after=lh)
    e1 = wf.add(tg_edit('Card: sending', "$('Bot route').first().json.card_text"), after=ih, out=0)
    lk = wf.add(http('Lock row (bot)', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $('Bot route').first().json.lock }) }}"), after=e1)
    gs = wf.add(http('Gmail: send (bot)', 'POST', f'{GMAIL}/messages/send', auth=('gmailOAuth2', None),
                     body="={{ JSON.stringify($('Bot route').first().json.gmail_payload) }}"), after=lk)
    gm = wf.add(http('Gmail: read Message-ID (bot)', 'GET', '=' + f'{GMAIL}/messages/' + '{{ $json.id }}', auth=('gmailOAuth2', None),
                     query=[('format', 'metadata'), ('metadataHeaders', 'Message-ID')]), after=gs)
    af = wf.add(code('After bot send', 'bot_send_after'), after=gm)
    w = wf.add(http('Write updates (bot send)', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                    body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $('After bot send').first().json.data }) }}"), after=af)
    lg = wf.add(http('Append Log (bot send)', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                     auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ values: $('After bot send').first().json.logs }) }}"), after=w)
    wf.add(tg_edit('Card: result', "$('After bot send').first().json.card_text"), after=lg)
    i2 = wf.add(if_true('Rewrite?', act('rewrite')), after=i1, out=1)
    bb = wf.add(code('Build rewrite request', 'bot_rewrite_build'), after=i2, out=0)
    lp = wf.add(llm('LLM primary (bot)', 'gemini', 'req_primary', 1000), after=bb)
    ck = wf.add(code('Check rewrite LLM', 'bot_rewrite_check'), after=lp)
    i3 = wf.add(if_true('Rewrite OK?', '={{ $json.llm_ok }}'), after=ck)
    for via, src in (('primary', (i3, 0)), ('fallback', None)):
        if src is None:
            src = (wf.add(llm('LLM fallback (bot)', 'groq', 'req_fallback', 1000), after=i3, out=1), 0)
        d = wf.add(code(f'Apply rewrite ({via})', 'bot_rewrite_apply', via), after=src[0], out=src[1])
        w = wf.add(http(f'Write updates (rewrite {via})', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                        body=f"={{{{ JSON.stringify({{ valueInputOption: 'RAW', data: $('{d}').first().json.data }}) }}}}"), after=d)
        lg = wf.add(http(f'Append Log (rewrite {via})', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                         auth=('googleSheetsOAuth2Api', None), on_error=False,
                         body=f"={{{{ JSON.stringify({{ values: $('{d}').first().json.logs }}) }}}}"), after=w)
        k = wf.add(cards_node(f'Cards (rewrite {via})', d), after=lg)
        wf.add(tg_card(f'Send card (rewrite {via})'), after=k)
    i4 = wf.add(if_true('Skip?', act('skip')), after=i2, out=1)
    ws = wf.add(http('Write updates (skip)', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $('Bot route').first().json.data }) }}"), after=i4, out=0)
    ls = wf.add(http('Append Log (skip)', 'POST', f'{SHEETS}/values/Log!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                     auth=('googleSheetsOAuth2Api', None), on_error=False,
                     body="={{ JSON.stringify({ values: $('Bot route').first().json.logs }) }}"), after=ws)
    wf.add(tg_edit('Card: skipped', "$('Bot route').first().json.card_text"), after=ls)
    i5 = wf.add(if_true('Say?', act('say')), after=i4, out=1)
    sy = wf.add(tg_say('Say', "$('Bot route').first().json.say"), after=i5, out=0)
    k = wf.add(cards_node('Cards (pending)', 'Bot route'), after=sy)
    wf.add(tg_card('Send card (pending)'), after=k)
    return wf


def wf8():
    wf = WF('Outreach 8 · Gmail-sheet sync')
    # minute :38 hourly: the Sender fires at :x0/:x5 (+ <=60 s jitter) and the reply watcher at :02/:17/:32/:47,
    # so this run's Gmail reads never share a minute with them ('Units per minute per user' 403 on 12 Oct)
    s = wf.add(schedule('Hourly at :38', '38 * * * *'))
    r = wf.add(read_sheet('Read Sheet', ['Config', 'Contacts', 'Messages', 'Replies']), after=s)
    p = wf.add(code('Sync plan', 'sync_plan'), after=r)
    ls = wf.add(gmail_search('Gmail: list Sent', '={{ $json.q }}', '500'), after=p)
    u = wf.add(code('Unknown sent mail', 'sync_unknown'), after=ls)
    i = wf.add(if_true('Anything new in Sent?', '={{ !$json.none }}'), after=u)
    g = wf.add(http('Gmail: read sent email', 'GET', '=' + f'{GMAIL}/messages/' + '{{ $json.id }}', auth=('gmailOAuth2', None),
                    query=[('format', 'full')], batch=(1, 400)), after=i, out=0)
    for via, src in (('gmail', (g, 0)), ('none', (i, 1))):
        d = wf.add(code(f'Reconcile ({via})', 'sync_apply', via), after=src[0], out=src[1])
        # every output is gated: a quiet hour (or a missing LAST_RUN_SYNC row) must not send an empty write (400)
        gw = wf.add(gate_node(f'Has updates? (sync {via})', d, 'data'), after=d)
        wf.add(http(f'Write updates (sync {via})', 'POST', f'{SHEETS}/values:batchUpdate', auth=('googleSheetsOAuth2Api', None), on_error=False,
                    body="={{ JSON.stringify({ valueInputOption: 'RAW', data: $json.values }) }}"), after=gw)
        for tab, field in (('Log', 'logs'), ('Messages', 'appendMessages')):
            g = wf.add(gate_node(f'Has {tab} rows? (sync {via})', d, field), after=d)
            wf.add(http(f'Append {tab} (sync {via})', 'POST', f'{SHEETS}/values/{tab}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
                        auth=('googleSheetsOAuth2Api', None), on_error=False, body='={{ JSON.stringify({ values: $json.values }) }}'), after=g)
        nt = wf.add(notices_node(f'Notices (sync {via})', d), after=d)
        wf.add(telegram(f'Telegram (sync {via})'), after=nt)
        b = wf.add(bot_notes_node(f'Bot notes ({via})', d), after=d)
        wf.add(tg_say(f'Tell reply bot ({via})', '$json.text'), after=b)
    return wf


def bot_notes_node(name, src):
    return {'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'parameters': {'jsCode':
        f"return ($('{src}').first().json.bot_notes || []).map(text => ({{ json: {{ text }} }}));"}}


def cards_node(name, src):
    return {'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'parameters': {'jsCode':
        f"return ($('{src}').first().json.cards || []).map(c => ({{ json: c }}));"}}


# ---------------- validation ----------------
def validate(wf):
    names = {n['name'] for n in wf.nodes}
    assert len(names) == len(wf.nodes), f'{wf.name}: duplicate node names'
    for src, v in wf.conn.items():
        assert src in names, (wf.name, src)
        for outs in v['main']:
            for c in outs:
                assert c['node'] in names, (wf.name, c['node'])
    for n in wf.nodes:
        blob = json.dumps(n['parameters'])
        for ref in re.findall(r"\$\('([^']+)'\)", blob.replace('\\u2014', '—')):
            assert ref in names, f"{wf.name} / {n['name']}: reference to missing node '{ref}'"
        if n['type'] == 'n8n-nodes-base.code':
            js = n['parameters']['jsCode']
            assert '__VIA__' not in js and '__QC_SYSTEM__' not in js and '__SHEET_ID__' not in js and '__TG_CHAT_ID__' not in js and '__REPLY_' not in js, (wf.name, n['name'])
            with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
                f.write('(async function(){\n' + js + '\n})');
            r = subprocess.run(['node', '--check', f.name], capture_output=True, text=True)
            os.unlink(f.name)
            assert r.returncode == 0, f"{wf.name} / {n['name']}: JS syntax error\n{r.stderr}"


def mockify(doc, base, idx, start=None):
    """TEST ONLY: point every external API at a local mock server and drop credentials.
    MOCK_TG_CRED=<id>: keep the reply-bot Telegram nodes real (that credential's Base URL points at the mock).
    start='Reply bot trigger': the CLI start node feeds the bot branch; the trigger becomes GET /admin/update."""
    rep = [('https://sheets.googleapis.com', base + '/sheets'), ('https://gmail.googleapis.com', base + '/gmail'),
           (GEMINI_URL, base + '/gemini/chat/completions'), (GROQ_URL, base + '/groq/chat/completions'),
           ('https://api.hunter.io', base + '/hunter'), ('https://emailverifier.reoon.com', base + '/reoon'),
           ('https://cloudflare-dns.com', base + '/doh')]
    doc['id'] = f'outreachWf{idx:06d}'
    sched = next((n for n in doc['nodes'] if n['type'] in ('n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.errorTrigger')), None)
    for n in doc['nodes']:  # webhook trigger cannot run under the CLI: replay a stored Telegram update instead
        if n['type'] == 'n8n-nodes-base.telegramTrigger':
            n.clear(); n.update(http('Reply bot trigger', 'GET', base + '/admin/update', on_error=False), position=[0, 700], id=str(uuid.uuid4()))
    if start:  # bot copy: drop the schedule trigger so the CLI starts at the bot branch
        sched = None
        for n in [n for n in doc['nodes'] if n['type'] == 'n8n-nodes-base.scheduleTrigger']:
            doc['nodes'].remove(n); doc['connections'].pop(n['name'], None)
        doc['nodes'].append({'id': str(uuid.uuid4()), 'name': 'CLI start', 'type': 'n8n-nodes-base.executeWorkflowTrigger',
                             'typeVersion': 1.1, 'position': [-300, 700], 'parameters': {'inputSource': 'passthrough'}})
        doc['connections']['CLI start'] = {'main': [[{'node': start, 'type': 'main', 'index': 0}]]}
    if sched:  # n8n CLI `execute` needs an Execute Workflow Trigger as start node
        doc['nodes'].append({'id': str(uuid.uuid4()), 'name': 'CLI start', 'type': 'n8n-nodes-base.executeWorkflowTrigger',
                             'typeVersion': 1.1, 'position': [-300, 0], 'parameters': {'inputSource': 'passthrough'}})
        doc['connections']['CLI start'] = json.loads(json.dumps(doc['connections'][sched['name']]))
    for n in doc['nodes']:
        p = n['parameters']
        if n['type'] == 'n8n-nodes-base.telegram' and os.environ.get('MOCK_TG_CRED') and n.get('credentials') == bot_cred():
            n['credentials'] = {'telegramApi': {'id': os.environ['MOCK_TG_CRED'], 'name': 'Mock reply bot'}}
            continue
        if n['type'] == 'n8n-nodes-base.telegram':
            n.update(http(n['name'], 'POST', base + '/telegram/sendMessage', on_error=False, batch=(1, 50),  # one by one, like the Telegram node
                          body="={{ JSON.stringify({ chat_id: '1', text: $json.text || $json.html }) }}"))
            n.pop('credentials', None)
            continue
        if n['type'] == 'n8n-nodes-base.httpRequest':
            for k in ('authentication', 'nodeCredentialType', 'genericAuthType'):
                p.pop(k, None)
            n.pop('credentials', None)
            for a_, b_ in rep:
                p['url'] = p['url'].replace(a_, b_)
    return doc


if __name__ == '__main__':
    mock = os.environ.get('MOCK_BASE')
    outdir = os.path.join(ROOT, 'tests/workflows_mock' if mock else 'workflows')
    os.makedirs(outdir, exist_ok=True)
    for i, f in enumerate([wf0, wf1, wf2, wf3, wf4, wf5, wf6, wf7, wf8]):
        wf = f()
        validate(wf)
        path = os.path.join(outdir, f'{i}_' + re.sub(r'[^a-z0-9]+', '_', wf.name.split('·')[1].strip().lower()).strip('_') + '.json')
        doc = mockify(json.loads(json.dumps(wf.json())), mock, i) if mock else wf.json()
        json.dump(doc, open(path, 'w'), indent=1, ensure_ascii=False)
        if mock and f is wf7:  # second mock copy that starts at the bot branch
            bot = mockify(json.loads(json.dumps(wf.json())), mock, 9, start='Reply bot trigger')
            json.dump(bot, open(os.path.join(outdir, '9_reply_bot_mock.json'), 'w'), indent=1, ensure_ascii=False)
        print(f'OK  {path}  ({len(wf.nodes)} nodes)')
