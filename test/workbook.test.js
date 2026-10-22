'use strict';
// Builds a whole workbook from a small made-up month, then CALCULATES every formula with the
// test formula engine and compares the results with numbers worked out by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLogic } = require('./load');
const { workbookFromModels, isErr } = require('./formulaEngine');
const { sampleInputs } = require('./fixtures/sampleMonth');

const L = loadLogic();
const built = L.buildWorkbookModel_(sampleInputs(L));
const wb = workbookFromModels(built.sheets);
const T = built.tabs;
const sheet = (name) => built.sheets.find((s) => s.name === name);

/** Row (1-based) whose column A and B match, on a summary tab. */
function findRow(tab, a, b) {
  const v = sheet(tab).values;
  for (let r = 0; r < v.length; r++) if (v[r][0] === a && (b === undefined || v[r][1] === b)) return r + 1;
  throw new Error('No row ' + a + ' / ' + b + ' on ' + tab);
}
const val = (tab, row, colLetter) => wb.value(tab, row, colLetter.charCodeAt(0) - 64);
const plain = (x) => JSON.parse(JSON.stringify(x));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' ≠ ' + b);

test('every formula calculates without an error (except the intended NO COST text)', () => {
  for (const s of built.sheets) wb.evaluateAll(s.name);
  const bad = [];
  for (const f of L.allFormulas_(built.sheets)) {
    const v = wb.value(f.sheet, f.row, f.col);
    if (isErr(v)) bad.push(f.sheet + '!' + f.row + ':' + f.col + ' ' + f.f + ' → ' + v.error);
  }
  assert.deepEqual(bad, []);
});

test('Rule 14.1: no Excel-breaking functions anywhere', () => {
  assert.doesNotThrow(() => L.assertExcelSafe_(built.sheets));
  const bad = [L.model_('x', [['=XLOOKUP(A1,B:B,C:C)']])];
  assert.throws(() => L.assertExcelSafe_(bad), /XLOOKUP/);
});

test('Rule 9.2: ADS block rows come from the sources, not from a typed list', () => {
  const ads = plain(built.blocks.find((b) => b.kind === 'ADS').skus);
  assert.deepEqual(ads, ['10030', '20001', '50001', '51002', '80030', '80090', 'A0030']);
  assert.ok(!ads.includes('70001'), 'kit components that are not at ADS must not create rows');
  assert.deepEqual(plain(built.blocks.find((b) => b.kind === 'AMZ').skus), ['50001', 'A0030', 'A80004']);
  assert.deepEqual(plain(built.blocks.filter((b) => b.kind === 'MFG').map((b) => b.label)), ['VitaPros', 'VitaQuest']);
});

test('Rule 9.3 ADS: begin / receiving / sold (bundles split, CX included, kits) / actual', () => {
  const expect = {
    // sku: [begin, recv, sold, expected, actual, delta]
    '10030': [10, 5, 3, 12, 5, -7],
    '80030': [100, 0, 17, 83, 90, 7],      // 1 CX + 1 TikTok bundle + 5 starter kits + 10 Amazon kits
    '80090': [200, 0, 5, 195, 170, -25],   // "80090,80090" x2 lines = 4, plus 1 single
    '51002': [30, 0, 2, 28, 28, 0],        // CX line of a replacement order + TikTok bundle
    '50001': [50, 10, 2, 58, 48, -10],     // PO receipt; MANUAL order
    '20001': [40, 0, 5, 35, 35, 0],        // used by 5 starter kits
    'A0030': [20, 10, 15, 15, 15, 0]       // kitted 4 + 6; 15 sent to Amazon
  };
  for (const [sku, e] of Object.entries(expect)) {
    const r = findRow(T.variance, 'ADS', sku);
    assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, r, c)), e, 'ADS ' + sku);
  }
});

test('Rule 9.3 Amazon: starting = last month\'s last day; actual = last day of this month; all dispositions', () => {
  const expect = { 'A0030': [120, 15, 20, 115, 115, 0], 'A80004': [30, 0, 4, 26, 25, -1], '50001': [0, 5, 1, 4, 4, 0] };
  for (const [sku, e] of Object.entries(expect)) {
    const r = findRow(T.variance, 'Amazon', sku);
    assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, r, c)), e, 'Amazon ' + sku);
  }
});

test('Rule 9.3 MFG: Used is calculated, so delta is 0', () => {
  const vq = findRow(T.variance, 'VitaQuest', '70003');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vq, c)), [100, 50, 30, 120, 120, 0]);
  const vp = findRow(T.variance, 'VitaPros', '70003');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vp, c)), [0, 300, 0, 300, 300, 0]);
});

test('Rule 9.3 costs and missing COGS', () => {
  const r = findRow(T.variance, 'ADS', '80090');
  close(val(T.variance, r, 'K'), 6.90);
  close(val(T.variance, r, 'N'), 170 * 6.9 - 195 * 6.9);
  const a8 = findRow(T.variance, 'Amazon', 'A80004');
  assert.equal(val(T.variance, a8, 'K'), 'NO COST');
  assert.equal(val(T.variance, a8, 'M'), 'NO COST');
});

test('Rule 9.1: subtotals add up their own block only', () => {
  const r = findRow(T.variance, 'Subtotal – ADS');
  assert.equal(val(T.variance, r, 'E'), 10 + 100 + 200 + 30 + 50 + 40 + 20);
  assert.equal(val(T.variance, r, 'J'), -7 + 7 - 25 + 0 - 10 + 0 + 0);
});

test('Rule 10: valuation totals box', () => {
  const ending = 5 * 7.19 + 90 * 2.96 + 170 * 6.90 + 28 * 0.45 + 48 * 2.10 + 35 * 0.64 + 15 * 2.87 + 115 * 2.87 + 4 * 2.10;
  const raw = 300 * 197.96 + 120 * 197.96;
  close(val(T.valuation, 2, 'B'), ending);
  close(val(T.valuation, 3, 'B'), raw);
  close(val(T.valuation, 4, 'B'), ending + raw);
  const a8 = findRow(T.valuation, 'Amazon', 'A80004');
  assert.equal(val(T.valuation, a8, 'E'), 25);
  assert.equal(val(T.valuation, a8, 'J'), 'NO COST');
});

test('Rule 11: outbound units by channel (order-level tags, manual marketing, Amazon)', () => {
  const row = (sku) => findRow(T.outbound, sku);
  const units = (sku) => ['C', 'E', 'G', 'I', 'K', 'M'].map((c) => val(T.outbound, row(sku), c)); // DTC, Mktg, CX, TikTok, Amazon, All
  assert.deepEqual(units('10030'), [3, 0, 0, 0, 0, 3]);
  assert.deepEqual(units('80090,80090'), [2, 0, 0, 0, 0, 2]);
  assert.deepEqual(units('51002'), [0, 0, 1, 0, 0, 1]);           // 2nd line of a Replacement order → CX
  assert.deepEqual(units('80030,51002'), [0, 0, 0, 1, 0, 1]);
  assert.deepEqual(units('80090'), [0, 1, 0, 0, 0, 1]);           // "Free sample, TikTok" → Marketing (first match)
  assert.deepEqual(units('50001'), [0, 2, 0, 0, 1, 3]);           // MANUAL order + Amazon
  assert.deepEqual(units('A0030'), [0, 0, 0, 0, 20, 20]);
  const total = findRow(T.outbound, 'TOTAL');
  assert.deepEqual(['C', 'E', 'G', 'I', 'K', 'M'].map((c) => val(T.outbound, total, c)), [5, 3, 2, 1, 25, 36]);
  close(val(T.outbound, row('80090,80090'), 'D'), 2 * 13.80);
});

test('Rule 12: checks flag what is wrong and pass what is right', () => {
  const rows = sheet(T.checks).values;
  const result = (label) => { const r = rows.findIndex((x) => x[1] === label); return wb.value(T.checks, r + 1, 3); };
  assert.match(result('SKUs with no COGS cost'), /^FLAG: 2 /);         // A80004 on Variance + Outbound
  assert.match(result('Amazon rows with no SKU mapping'), /^FLAG: 1 /); // ASIN B8 has sales
  assert.match(result('Shopify lines with no SKU (not counted anywhere)'), /^FLAG: 1 /);
  assert.equal(result('Rows where Expected Ending Inventory is negative'), 'OK');
  assert.equal(result('Inventory Valuation total = sum of block subtotals'), 'OK');
  assert.equal(result('MFG Inventory filled in'), 'OK');
  const map = rows.find((x) => x[1] === 'AMZ SKU Map entries added this run');
  assert.match(map[3], /A80002 \(B2\) → A80004/);
  assert.match(map[3], /A0030 - TEMP SKU \(B1\) → A0030/);
  const noCost = rows.find((x) => x[1] === 'SKUs with no COGS cost');
  assert.match(noCost[3], /A80004/);
});

test('Rule 8: helper tabs', () => {
  const bm = sheet(T.bundleMap).values;
  const r = bm.findIndex((x) => x[0] === '80090,80090') + 1;
  assert.equal(bm[r - 1][2], 2);
  assert.equal(wb.value(T.bundleMap, r, 5), 4);
  const kit = sheet(T.kit).values;
  assert.deepEqual(plain(kit.slice(1).map((x) => [x[0], x[1]])), [['10030', '70001'], ['10030', '80030'], ['10030', '20001'], ['A0030', '80030']]);
  assert.equal(wb.value(T.kit, 5, 5), 10); // A0030 → 80030: 1 x 10 kits
});

test('manual tabs are preserved on rebuild; summaries are not', () => {
  for (const name of [T.mfgInv, T.adsReceipts, T.prepaid, T.cogs]) assert.equal(sheet(name).preserveIfExists, true, name);
  for (const name of [T.variance, T.valuation, T.outbound, T.checks, T.ledger]) assert.equal(sheet(name).preserveIfExists, false, name);
  assert.equal(sheet(T.mfgStart).preserveIfExists, false, 'MFG Starting is regenerated when last month exists');
  const first = L.buildWorkbookModel_(sampleInputs(L, { mfgStartFromPrev: false, mfgStart: [] }));
  assert.equal(first.sheets.find((s) => s.name === T.mfgStart).preserveIfExists, true, 'first run: you type MFG Starting');
});

test('raw tabs: SKU columns are text, quantities numbers, ledger dates real dates', () => {
  const led = sheet(T.ledger);
  assert.ok(led.textCols.includes(3), 'MSKU is text');
  assert.equal(typeof led.values[1][0], 'number', 'dates become date numbers');
  assert.equal(led.values[0][led.values[0].length - 1], 'SKU (mapped)');
  const ads = sheet(T.adsEnd);
  assert.ok(ads.textCols.includes(0));
  assert.equal(ads.values[1][7], 5);
  const biz = sheet(T.biz);
  assert.equal(biz.values[1][3], 9143);
});

test('manual tabs: quantities typed as text still count (converted to numbers)', () => {
  const b = L.buildWorkbookModel_(sampleInputs(L, { adsReceipts: [['PO-1', 50001, '10']] }));
  const w = workbookFromModels(b.sheets);
  const rec = b.sheets.find((s) => s.name === b.tabs.adsReceipts);
  assert.equal(rec.values[1][1], '50001');
  assert.equal(rec.values[1][2], 10);
  const v = b.sheets.find((s) => s.name === b.tabs.variance).values;
  const r = v.findIndex((x) => x[0] === 'ADS' && x[1] === '50001') + 1;
  assert.equal(w.value(b.tabs.variance, r, 6), 10);
  assert.throws(() => L.buildWorkbookModel_(sampleInputs(L, { adsReceipts: [['PO-1', '50001', 'ten']] })), /Expected a number on ADS Receipts/);
});
