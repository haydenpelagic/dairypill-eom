// Replays a real month through the EOM logic and calculates every formula locally, then
// compares with the hand-built report. Usage:  node tools/replay.js <folder> ["October 2026"]
// The folder holds CSV exports (not committed — they contain business data):
//   ads_start.csv  ads_end.csv  amazon_ledger_full.csv  amazon_sales.csv  shopify.csv
//   manualorder_log.csv  amz_log.csv (Ops Hub tabs, A:F)  workorders.xls  bom.csv  cogs.csv  ads_receipts.csv
//   mfg_inventory.csv (MFG,SKU,Received Qty,EOM Qty[,Beginning])   optional: wo_sku_fixes.csv  old_variance.csv  old_outbound.csv
// Ops Hub is taken to hold exactly what "Write month to Ops Hub" would write from these files (ADS start = last
// month's column; Amazon start = the ledger's 1st-of-month rows; manufacturer counts from mfg_inventory.csv).
'use strict';
const fs = require('fs');
const path = require('path');
const { loadLogic } = require('../test/load');
const { workbookFromModels } = require('../test/formulaEngine');

const dir = process.argv[2];
const monthLabel = process.argv[3] || 'September 2026';
if (!dir) { console.error('Usage: node tools/replay.js <folder> ["September 2026"]'); process.exit(1); }
const L = loadLogic();
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const has = (f) => fs.existsSync(path.join(dir, f));
const table = (f, label) => L.toTable_(L.parseCsv_(read(f)), label || f);
const m = L.parseMonthLabel_(monthLabel);

const cogs = table('cogs.csv');
cogs.rows = cogs.rows.map((r) => r.map((v, i) => (i >= 2 && i <= 5 && String(v).trim() !== '' ? L.toNumber_(v) : v)));
const mfg = has('mfg_inventory.csv') ? table('mfg_inventory.csv').rows.map((r) => ({ mfg: r[0], sku: L.cleanSku_(r[1]), recv: Number(r[2]) || 0, eom: Number(r[3]), begin: r[4] === undefined || r[4] === '' ? '' : Number(r[4]) })) : [];

const ads = table('ads_end.csv'), ledger = table('amazon_ledger_full.csv'), shopify = table('shopify.csv');
const manualLog = L.parseOpsLog_(L.parseCsv_(read('manualorder_log.csv')), 'manual', m);
const workOrders = L.parseWorkOrdersHtml_(read('workorders.xls'), m);
const bomValues = L.parseCsv_(read('bom.csv'));
const woFixes = has('wo_sku_fixes.csv') ? table('wo_sku_fixes.csv').rows : [];
const resolved = L.resolveWorkOrderSkus_(workOrders.lines, L.bomFromSource_(bomValues).rows, woFixes, 'replay');

// What Ops Hub holds after "Write month to Ops Hub" (+ last month's column and the manufacturer counts typed there).
const begin = {};
if (has('ads_start.csv')) L.adsOnHand_(table('ads_start.csv')).forEach((d) => { begin['ADS|' + d.sku] = (begin['ADS|' + d.sku] || 0) + d.qty; });
const amzBegin = L.amzStartBySku_(L.ledgerFirstDateRows_(ledger, m));
Object.keys(amzBegin).forEach((s) => { begin['Amazon|' + s] = amzBegin[s]; });
const end = {};
L.adsOnHand_(ads).concat(L.amazonOnHand_(ledger)).forEach((d) => { end[d.group + '|' + d.sku] = (end[d.group + '|' + d.sku] || 0) + d.qty; });
const keys = [...new Set(Object.keys(begin).concat(Object.keys(end)))];
const hub = {
  inventory: keys.map((k) => ({ group: k.split('|')[0], sku: k.split('|').slice(1).join('|'), begin: begin[k] || 0, end: end[k] || 0 }))
    .concat(mfg.map((x) => ({ group: x.mfg, sku: x.sku, begin: x.begin, end: isNaN(x.eom) ? '' : x.eom }))),
  sellThru: L.soldByChannel_(shopify, manualLog, ledger),
  woLog: L.kitLines_(resolved.lines, m)
};

const inputs = {
  month: m,
  todayStr: 'replay',
  builtAt: 'replay',
  ads, ledger, shopify, manualLog, workOrders, bomValues, woFixes, hub, cogs,
  biz: table('amazon_sales.csv'),
  amzLog: L.parseOpsLog_(L.parseCsv_(read('amz_log.csv')), 'amz', m),
  prepaid: null,
  adsReceipts: has('ads_receipts.csv') ? table('ads_receipts.csv').rows : [],
  mfgReceipts: mfg.filter((x) => x.recv).map((x) => [x.mfg, x.sku, x.recv]),
  sources: { shopifySource: 'replay' },
  ignoredFiles: [],
  extraTabs: []
};

console.time('build');
const built = L.buildWorkbookModel_(inputs);
L.assertExcelSafe_(built.sheets);
console.timeEnd('build');
const wb = workbookFromModels(built.sheets);
console.time('calculate');
for (const s of built.sheets) wb.evaluateAll(s.name);
console.timeEnd('calculate');
const T = built.tabs;
const vals = (tab) => built.sheets.find((s) => s.name === tab).values.map((row, r) => row.map((_, c) => wb.value(tab, r + 1, c + 1)));
const num = (v) => (typeof v === 'number' ? v : String(v).trim() === '' ? 0 : Number(String(v).replace(/[$,+]/g, '')));
const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);

// ---- Variance: new vs old
const newVar = vals(T.variance).filter((r) => r[1] && !String(r[0]).startsWith('Subtotal') && r[0] !== 'Location');
const oldVar = {};
if (has('old_variance.csv')) {
  for (const r of table('old_variance.csv').rows) oldVar[r[1] + '|' + r[2]] = r;
}
const loc = (l) => (l === 'Amazon' ? 'Amazon' : l);
console.log('\nVARIANCE  (new | old)   columns: Begin, Receiving, Sold/Used, Expected, Actual, Delta');
const rows = [];
for (const r of newVar) {
  const o = oldVar[loc(r[0]) + '|' + r[1]];
  const n = [r[4], r[5], r[6], r[7], r[8], r[9]].map(r2);
  const old = o ? [o[6], o[7], o[8], o[9], o[10], o[11]].map(num) : null;
  const same = old && n.every((x, i) => Math.abs(num(x) - old[i]) < 0.01);
  rows.push({ loc: r[0], sku: r[1], new: n.join(' / '), old: old ? old.join(' / ') : '(not in old report)', same: same ? '' : '≠' });
  if (o) delete oldVar[loc(r[0]) + '|' + r[1]];
}
console.table(rows);
const gone = Object.keys(oldVar);
if (gone.length) console.log('In old report but not new:', gone.join(', '));

// ---- Outbound
const ob = vals(T.outbound);
const oldOb = {};
if (has('old_outbound.csv')) for (const r of L.parseCsv_(read('old_outbound.csv')).slice(2)) if (r[0]) oldOb[r[0]] = r;
console.log('\nOUTBOUND units (new | old): DTC, Marketing, CX, TikTok, Amazon');
const orows = [];
for (const r of ob.slice(4)) {
  if (!r[0]) continue;
  const n = [r[3], r[5], r[7], r[9], r[11]];
  const o = oldOb[r[0]] ? [2, 4, 6, 8, 10].map((i) => num(oldOb[r[0]][i])) : null;
  orows.push({ sku: r[0], new: n.join(' / '), old: o ? o.join(' / ') : '-', same: o && n.every((x, i) => x === o[i]) ? '' : '≠' });
}
console.table(orows);

// ---- Valuation totals
const v = vals(T.valuation);
const box = L.VALUATION_HEADER.length + 1; // the totals box to the right of the table (Rule 10.2), from the header row
console.log('\nVALUATION', v.slice(3).filter((r) => r[box]).map((r) => r[box] + ' = ' + r2(r[box + 1])).join(' | '));

// ---- Checks
console.log('\nCHECKS');
for (const r of vals(T.checks).slice(1)) console.log(' ', r[0], r[1], '→', r[2], r[3] ? '— ' + String(r[3]).slice(0, 220) : '');
