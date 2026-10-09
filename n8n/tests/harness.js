// Minimal n8n Code-node emulator + fake Google Sheet, for end-to-end tests of the built workflows.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { DateTime, Settings } = require('luxon');

const WF_DIR = path.join(__dirname, '..', 'workflows');
const wfs = {};
for (const f of fs.readdirSync(WF_DIR)) { const w = JSON.parse(fs.readFileSync(path.join(WF_DIR, f))); wfs[f.split('_')[0]] = w; }

function setNow(isoStr) { const ms = DateTime.fromISO(isoStr, { zone: 'Europe/Stockholm' }).toMillis(); Settings.now = () => ms; }

class Sheet {
  constructor(fixture) { this.tabs = JSON.parse(JSON.stringify(fixture)); }
  batchGet(tabs) { return { valueRanges: tabs.map(t => ({ range: `'${t}'!A1:ZZ`, values: this.tabs[t] })) }; }
  colIdx(l) { let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
  batchUpdate(data) {
    if (!data || !data.length) throw new Error('Must specify at least one data (empty batchUpdate)');
    for (const d of data) {
      const m = d.range.match(/^'?([^'!]+)'?!([A-Z]+)(\d+)$/); if (!m) throw new Error('bad range ' + d.range);
      const t = this.tabs[m[1]]; const r = Number(m[3]) - 1, c = this.colIdx(m[2]);
      while (t.length <= r) t.push([]);
      while (t[r].length <= c) t[r].push('');
      t[r][c] = d.values[0][0];
    }
  }
  append(tab, values) { if (!values || !values.length) throw new Error('empty append'); for (const v of values) this.tabs[tab].push(v.slice()); }
  rows(tab) { const [h, ...rs] = this.tabs[tab]; return rs.filter(r => r.some(x => String(x) !== '')).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); }
  set(tab, key, col, keyCol, value) { const t = this.tabs[tab]; const h = t[0]; const r = t.findIndex(x => x[h.indexOf(keyCol)] === key); t[r][h.indexOf(col)] = value; }
  cfg(key, value) { this.set('Config', key, 'value', 'key', value); }
}

// Run one Code node. ctx.nodes: {nodeName: items[]}; ctx.pair: {nodeName: (i)=>item}; input: items[]
function run(wfKey, nodeName, input, ctx = {}) {
  const wf = wfs[wfKey]; const node = wf.nodes.find(n => n.name === nodeName);
  if (!node) throw new Error(`node ${nodeName} not in wf ${wfKey}`);
  const wrap = arr => ({ all: () => arr, first: () => arr[0], item: arr[0] });
  const $ = name => {
    const items = (ctx.nodes || {})[name];
    if (!items) throw new Error(`test ctx missing node output for $('${name}') in ${nodeName}`);
    return { all: () => items, first: () => items[0], itemMatching: i => (ctx.pair && ctx.pair[name] ? ctx.pair[name](i) : items[i]) };
  };
  const sandbox = { $, $input: wrap(input || []), DateTime, Buffer, console, JSON, Math, Date, Object, Array, String, Number, RegExp, Set, Map, Error, isNaN, encodeURIComponent };
  const code = `(async function(){\n${node.parameters.jsCode}\n})()`;
  return vm.runInNewContext(code, sandbox, { timeout: 5000 });
}
const J = arr => arr.map(json => ({ json }));
module.exports = { wfs, run, Sheet, setNow, J, DateTime };
