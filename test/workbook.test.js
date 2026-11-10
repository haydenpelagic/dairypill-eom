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
  for (let r = 0; r < v.length; r++) {
    const cell = (c) => (typeof v[r][c] === 'string' && v[r][c].charAt(0) === '=' ? wb.value(tab, r + 1, c + 1) : v[r][c]); // MFG rows are formulas
    if (cell(0) === a && (b === undefined || cell(1) === b)) return r + 1;
  }
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
  assert.deepEqual(ads, ['10030', '20001', '41001', '50001', '51002', '80030', '80090', 'A0030']);
  assert.ok(!ads.includes('70001'), 'kit components that are not at ADS must not create rows');
  assert.deepEqual(plain(built.blocks.find((b) => b.kind === 'AMZ').skus), ['50001', 'A0030', 'A80004']);
  const mfg = built.blocks.filter((b) => b.kind === 'MFG');
  assert.deepEqual(plain(mfg.map((b) => [b.label, b.rows])), [['MFG', 50]], 'one MFG section, 50 rows');
});

test('Rule 9.3 ADS: begin / receiving / sold (bundles split, CX included, kits) / actual', () => {
  const expect = {
    // sku: [begin, recv, sold, expected, actual, delta]
    '10030': [10, 5, 3, 12, 5, -7],
    '80030': [100, 0, 17, 83, 90, 7],      // 1 CX + 1 TikTok bundle + 5 starter kits + 10 Amazon kits
    '80090': [200, 0, 5, 195, 170, -25],   // "80090,80090" x2 lines = 4, plus 1 single
    '51002': [30, 0, 2, 28, 28, 0],        // CX line of a replacement order + TikTok bundle
    '50001': [50, 10, 3, 57, 48, -9],      // PO receipt; manualorder_log Marketing 2 + Samples 1
    '20001': [40, 0, 5, 35, 35, 0],        // used by 5 starter kits
    'A0030': [20, 10, 15, 15, 15, 0]       // kitted 4 + 6; 15 shipped out of ADS to Amazon (amz_log)
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

test('Rule 9.5 MFG: rows mirror MFG Counts in its order; Used is calculated, so delta is 0', () => {
  const vq = findRow(T.variance, 'VitaQuest', '70003');
  const vp = findRow(T.variance, 'VitaPros', '70003');
  assert.equal(vp, vq + 1, 'same order as the MFG Counts tab (VitaQuest typed first)');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vq, c)), [100, 50, 30, 120, 120, 0]);
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vp, c)), [0, 300, 0, 300, 300, 0]);
  assert.equal(val(T.variance, vq, 'D'), 'Raw Material - Component');
  assert.deepEqual(['A', 'B', 'D', 'E', 'I', 'M'].map((c) => val(T.variance, vp + 1, c)), ['', '', '', '', '', ''], 'unused rows stay blank');
  assert.equal(sheet(T.variance).values.length, vq + 49, 'the 50 MFG rows are the last rows — no subtotal row');
  // Valuation mirrors the same rows
  const v1 = findRow(T.valuation, 'VitaQuest', '70003');
  assert.equal(val(T.valuation, v1, 'E'), 120);
  assert.equal(val(T.valuation, v1 + 1, 'E'), 300);
});

test('Rule 9.5 / 7.1: a row typed at the bottom of MFG Counts (SKU as a number, no Received) shows up without a rebuild', () => {
  const counts = sheet(T.mfgInv).values;
  const w = workbookFromModels(built.sheets.map((s) => (s.name === T.mfgInv ? Object.assign({}, s, { values: counts.concat([['VitaQuest', 70001, 40, '']]) }) : s)));
  const vq = findRow(T.variance, 'VitaQuest', '70003');
  const v = (row, c) => w.value(T.variance, row, c.charCodeAt(0) - 64);
  assert.deepEqual(['A', 'B', 'E', 'F', 'G', 'I', 'J'].map((c) => v(vq + 2, c)), ['VitaQuest', '70001', 0, 0, -40, 40, 0]);
  assert.equal(v(vq + 2, 'I') + v(vq, 'I') + v(vq + 1, 'I'), 460);
});

test('Rule 7.1 / 4.4: a new MFG Counts tab starts with last month\'s MFG + SKU rows (non-zero), quantities blank', () => {
  const b = L.buildWorkbookModel_(sampleInputs(L, { mfgInv: null, mfgStart: [['VitaQuest', '70003', 800], ['VitaPros', 70003, 300], ['VitaPros', '70009', 0]] }));
  assert.deepEqual(plain(b.sheets.find((s) => s.name === T.mfgInv).values),
    [['MFG', 'SKU', 'EOM Qty', 'Received Qty'], ['VitaQuest', '70003', '', ''], ['VitaPros', '70003', '', '']]);
  const boot = [['Code', 'Location', 'SKU', 'Categorization', 'Actual Ending Inventory'], ['ADS1', 'ADS', '1', 'Ending Inventory', '5'],
    ['VitaPros70003', 'VitaPros', '70003', 'Raw Material - Component', '300'], ['VitaQuest70003', 'VitaQuest', '70003', 'Raw Material - Component', '800']];
  assert.deepEqual(plain(L.mfgStartFromBootstrap_(boot)), [['VitaPros', '70003', 300], ['VitaQuest', '70003', 800]]);
});

test('Rule 9.3 costs and missing COGS', () => {
  const r = findRow(T.variance, 'ADS', '80090');
  close(val(T.variance, r, 'K'), 6.90);
  close(val(T.variance, r, 'N'), 170 * 6.9 - 195 * 6.9);
  const a8 = findRow(T.variance, 'Amazon', 'A80004');
  assert.equal(val(T.variance, a8, 'K'), 'NO COST');
  assert.equal(val(T.variance, a8, 'M'), 'NO COST');
});

test('Rule 9.1: one flat table (no block headings or subtotal rows) and a Total Variance box to the right', () => {
  const vals = sheet(T.variance).values;
  assert.ok(!vals.some((r) => /^(Subtotal|▼)/.test(String(r[0]))), 'no block headings or subtotal rows');
  assert.equal(vals[4][0], 'ADS', 'data starts right under the header');
  assert.deepEqual(plain(vals[3].slice(14, 17)), ['', 'Total Variance ($)', '=SUM(N:N)']);
  let sum = 0;
  for (let r = 5; r <= vals.length; r++) { const x = val(T.variance, r, 'N'); if (typeof x === 'number') sum += x; }
  close(val(T.variance, 4, 'Q'), sum);
  assert.equal(built.sheets.find((s) => s.name === T.variance).totalCell, 'Q4');
});

test('Rule 10: valuation totals box', () => {
  const ending = 5 * 7.19 + 90 * 2.96 + 170 * 6.90 + 28 * 0.45 + 48 * 2.10 + 35 * 0.64 + 15 * 2.87 + 115 * 2.87 + 4 * 2.10 + 16 * 0.32;
  const raw = 300 * 197.96 + 120 * 197.96;
  const vals = sheet(T.valuation).values;
  assert.ok(!vals.some((r) => /^(Subtotal|▼)/.test(String(r[0]))), 'no block headings or subtotal rows');
  assert.deepEqual(plain([vals[3][11], vals[4][11], vals[5][11]]), ['Ending Inventory', 'Raw Material - Component', 'TOTAL INVENTORY VALUE']);
  close(val(T.valuation, 4, 'M'), ending);
  close(val(T.valuation, 5, 'M'), raw);
  close(val(T.valuation, 6, 'M'), ending + raw);
  const a8 = findRow(T.valuation, 'Amazon', 'A80004');
  assert.equal(val(T.valuation, a8, 'E'), 25);
  assert.equal(val(T.valuation, a8, 'J'), 'NO COST');
});

test('Rule 11: outbound units by channel (order-level tags, manualorder_log channels incl. Samples, Amazon)', () => {
  const row = (sku) => findRow(T.outbound, sku);
  const U = ['D', 'F', 'H', 'J', 'L', 'N', 'P']; // DTC, Mktg, CX, TikTok, Samples, Amazon, All
  assert.deepEqual(plain(sheet(T.outbound).values[2].filter((x) => x)), ['DTC', 'Marketing', 'CX', 'TikTok', 'Samples', 'Amazon', 'All Channels']);
  const units = (sku) => U.map((c) => val(T.outbound, row(sku), c));
  assert.deepEqual(units('10030'), [3, 0, 0, 0, 0, 0, 3]);
  assert.deepEqual(units('80090,80090'), [2, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(units('51002'), [0, 0, 1, 0, 0, 0, 1]);           // 2nd line of a Replacement order → CX
  assert.deepEqual(units('80030,51002'), [0, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(units('80090'), [0, 1, 0, 0, 0, 0, 1]);           // "Free sample, TikTok" → Marketing (first match)
  assert.deepEqual(units('50001'), [0, 2, 0, 0, 1, 1, 4]);           // manualorder_log Marketing 2 + Samples 1; Amazon ledger 1
  assert.deepEqual(units('A0030'), [0, 0, 0, 0, 0, 20, 20]);         // the 15 in amz_log are not sales
  const total = findRow(T.outbound, 'TOTAL');
  assert.deepEqual(U.map((c) => val(T.outbound, total, c)), [5, 3, 2, 1, 1, 25, 37]);
  close(val(T.outbound, row('80090,80090'), 'E'), 2 * 13.80);
  assert.deepEqual(plain(sheet(T.outbound).values[3].slice(0, 3)), ['SKU', 'Description', 'Avg Cost / Unit']);
  // Description is looked up on the COGS tab (INDEX/MATCH, Excel-safe) — same text as COGS column B.
  assert.equal(val(T.outbound, row('10030'), 'B'), '10ct Pouch');
  assert.equal(val(T.outbound, row('80090,80090'), 'B'), '90ct Pouch x2');
  assert.equal(val(T.outbound, row('50001'), 'B'), '(no description)');   // blank on COGS
  assert.equal(val(T.outbound, row('A80004'), 'B'), '(no description)');  // not on COGS at all
  assert.match(sheet(T.outbound).values[row('10030') - 1][1], /^=IFERROR\(IF\(INDEX\('COGS'!/);
});

test('Rule 12: checks flag what is wrong and pass what is right', () => {
  const rows = sheet(T.checks).values;
  const result = (label) => { const r = rows.findIndex((x) => x[1] === label); return wb.value(T.checks, r + 1, 3); };
  assert.match(result('SKUs with no COGS cost'), /^FLAG: 2 /);         // A80004 on Variance + Outbound
  assert.match(result('Amazon rows with no SKU mapping'), /^FLAG: 1 /); // ASIN B8 has sales
  assert.match(result('Shopify lines with no SKU (not counted anywhere)'), /^FLAG: 1 /);
  assert.equal(result('Rows where Expected Ending Inventory is negative'), 'OK');
  assert.equal(result('Inventory Valuation total = sum of every row'), 'OK');
  assert.equal(result('MFG Counts filled in'), 'OK');
  assert.equal(result('MFG Counts fits the MFG section'), 'OK');
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

test('Rule 4.2a: Amazon tie-out on Checks — OK, not compared, or problem', () => {
  const tieRow = (b) => { const ch = b.sheets.find((x) => x.name === b.tabs.checks).values; return ch.find((r) => r[1] === 'Amazon starting balance = last month\'s ending'); };
  assert.equal(tieRow(built)[2], 'OK');
  const none = L.buildWorkbookModel_(sampleInputs(L, { amzPrevEnd: { rows: null, source: 'looked in the August 2026 folder', problem: null } }));
  assert.equal(tieRow(none)[2], 'INFO');
  assert.match(tieRow(none)[3], /Not compared — no 08\/31\/2026 Amazon ledger found/);
  const bad = L.buildWorkbookModel_(sampleInputs(L, { amzPrevEnd: { rows: null, source: 'x', problem: 'x ends on 08/30/2026' } }));
  assert.equal(tieRow(bad)[2], 'FLAG: not compared');
  // Beginning never depends on last month's ledger
  const r = findRow(T.variance, 'Amazon', 'A0030');
  const rNone = none.sheets.find((x) => x.name === T.variance).values.findIndex((v) => v[0] === 'Amazon' && v[1] === 'A0030') + 1;
  assert.equal(r, rNone);
  assert.match(sheet(T.variance).values[r - 1][4], /Starting|'AMZ Starting Balance/);
  assert.equal(val(T.variance, r, 'E'), 120);
});

test('Rule 4.2: AMZ Starting tab = this month\'s 1st-of-month ledger rows', () => {
  const v = sheet(T.amzStart).values;
  assert.equal(v.length, 4);
  assert.ok(v.slice(1).every((row) => row[0] === v[1][0]));
  const diffs = L.amzTieOut_({ header: ['MSKU', 'Ending Warehouse Balance'], rows: [['A', '5'], ['A', '1'], ['B', '2']] },
    { header: ['MSKU', 'Starting Warehouse Balance'], rows: [['A', '6'], ['C', '1']] });
  assert.deepEqual(plain(diffs), [{ sku: 'B', prevEnd: 2, start: 0, diff: -2 }, { sku: 'C', prevEnd: 0, start: 1, diff: 1 }]);
  // with a mapping, two MSKUs for one SKU are added together before comparing
  const byOurs = L.amzTieOut_({ header: ['MSKU', 'Ending Warehouse Balance'], rows: [['A - TEMP SKU', '5']] },
    { header: ['MSKU', 'Starting Warehouse Balance'], rows: [['A - TEMP SKU', '2'], ['A', '3']] }, (m) => m.replace(' - TEMP SKU', ''));
  assert.deepEqual(plain(byOurs), []);
});

test('Rule 12.3: an ASIN or MSKU mapped to two different SKUs is flagged', () => {
  const label = 'Amazon MSKU/ASIN mapped to more than one of our SKUs';
  const row = (b) => b.sheets.find((x) => x.name === b.tabs.checks).values.find((r) => r[1] === label);
  assert.equal(row(built)[2], 'OK');
  const bad = L.buildWorkbookModel_(sampleInputs(L, { skuMapExisting: [['A0030 - TEMP SKU', 'B1', 'A0030', ''], ['A0030-NEW', 'B1', 'A0031', 'typed']] }));
  assert.equal(row(bad)[2], 'FLAG: 1');
  assert.match(row(bad)[3], /ASIN B1 → A0030 \/ A0031/);
  const same = L.buildWorkbookModel_(sampleInputs(L, { skuMapExisting: [['A0030 - TEMP SKU', 'B1', 'A0030', ''], ['A0030-NEW', 'B1', 'A0030', '']] }));
  assert.equal(row(same)[2], 'OK', 'two MSKUs on one ASIN is fine when they map to the same SKU');
  assert.deepEqual(plain(L.skuMapConflicts_([['M1', 'X', 'S1', ''], ['M1', 'Y', 'S2', '']])), [{ kind: 'MSKU', key: 'M1', skus: ['S1', 'S2'] }]);
});

test('Rule 5.4a: cancelled, and refunded/voided-and-never-shipped Shopify lines are not counted', () => {
  const v = sheet(T.shopify).values, h = v[0];
  const counted = v.slice(1).map((r, i) => [r[0], r[6], wb.value(T.shopify, i + 2, h.indexOf('Counted') + 1)]);
  assert.deepEqual(plain(counted.filter((x) => x[2] !== 'Yes')), [
    ['#6', '80090', 'No - cancelled'], ['#7', '80090', 'No - refunded, not shipped'], ['#7', '51002', 'No - refunded, not shipped']]);
  // 80090 sold stays 5 at ADS (the 5 cancelled + 2 refunded units are ignored); 51002 stays 2
  assert.equal(val(T.variance, findRow(T.variance, 'ADS', '80090'), 'G'), 5);
  assert.equal(val(T.variance, findRow(T.variance, 'ADS', '51002'), 'G'), 2);
  const ch = sheet(T.checks).values;
  const r = ch.findIndex((x) => x[0] === '5.4a') + 1;
  assert.equal(wb.value(T.checks, r, 3), 'INFO: 3 lines / 11 units not counted');
  // refunded but SHIPPED still counts (the product left ADS); partially refunded counts
  const H = ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags', 'Financial Status', 'Cancelled at', 'Lineitem fulfillment status'];
  const t = { header: H, rows: [['#1', '1', 'A', '', 'refunded', '', 'fulfilled'], ['#2', '2', 'B', '', 'partially_refunded', '', ''],
    ['#3', '3', 'C', '', 'voided', '', ''], ['#3', '4', 'D', '', '', '', 'Fulfilled']] };
  assert.deepEqual(plain(L.shopifyLinesCounted_(t)), [true, true, false, true]);
  const w = workbookFromModels([L.shopifyModel_('S', t)]);
  assert.deepEqual([2, 3, 4, 5].map((row) => w.value('S', row, 12)), ['Yes', 'Yes', 'No - voided, not shipped', 'Yes']);
  assert.deepEqual([2, 3, 4, 5].map((row) => w.value('S', row, 13)), [1, 2, 0, 4]);
});

test('Rule 5.6: Ops Hub logs — only rows shipped inside the month count; blank Ship Date = not shipped', () => {
  assert.deepEqual(plain(sheet(T.manualLog).values), [
    ['ADS Order Number', 'Channel', 'SKU', 'Quantity', 'Order Date', 'Ship Date'],
    ['141', 'Marketing', '50001', 2, '', L.parseMDY_('9/2/2026')],
    ['144', 'Samples', '50001', 1, '2026-10-01T10:00:00+00:00', L.parseMDY_('9/5/2026')]]);
  assert.deepEqual(plain(sheet(T.amzLog).values), [
    ['ADS Order Number', 'Amazon Number', 'SKU', 'Quantity', 'Order Date', 'Ship Date'],
    ['142', 'FBA15X', 'A0030', 15, '', L.parseMDY_('9/17/2026')]]);
  assert.equal(val(T.variance, findRow(T.variance, 'ADS', '50001'), 'G'), 3, 'other-month and unshipped rows are not counted');
  // amz_log only reduces ADS: Amazon's side still comes from the ledger (Receipts 15 = what arrived).
  assert.equal(val(T.variance, findRow(T.variance, 'Amazon', 'A0030'), 'F'), 15);
  const ch = sheet(T.checks).values;
  const r = ch.findIndex((x) => x[0] === '5.6');
  assert.match(String(ch[r][2]), /^CHECK: rows with no Ship Date are not counted/);
  assert.equal(ch[r][3], 'manualorder_log: 2 rows shipped 09/01/2026–09/30/2026; 1 rows with no Ship Date (not shipped — not counted); 1 rows from other months (ignored). ' +
    'amz_log: 1 rows shipped 09/01/2026–09/30/2026; 1 rows from other months (ignored).');
  assert.equal(L.parseMDY_('2026-09-05'), L.parseMDY_('09/05/2026'));
});

test('Rule 5.6: Ops Hub log rows that would make a number wrong stop the run', () => {
  const m = L.monthInfo_(2026, 8);
  const H = ['ADS Order Number', 'Channel', 'SKU', 'Quantity', 'Order Date', 'Ship Date'];
  const A = ['ADS Order Number', 'Amazon Number', 'SKU', 'Quantity', 'Order Date', 'Ship Date'];
  const one = (row, head) => () => L.parseOpsLog_([head || H, row], head === A ? 'amz' : 'manual', m);
  assert.throws(one(['1', 'Amazon', 'A0030', 5, '', '9/3/2026']), /units sent from ADS to Amazon belong in Ops Hub "amz_log"/);
  assert.throws(one(['1', 'Wholesale', '50001', 5, '', '9/3/2026']), /Channel "Wholesale" .* is not one of: DTC, Marketing, CX, TikTok, Samples/);
  assert.throws(one(['', '112-7128727', 'A0180', 1, '', 'Shipped'], A), /Expected a date like 09\/30\/2026 in Ops Hub tab "amz_log", row 2 \(Ship Date\) but found "Shipped".*date the units left ADS/);
  assert.throws(one(['1', 'CX', '', 5, '', '9/3/2026']), /No SKU in Ops Hub tab "manualorder_log", row 2/);
  assert.throws(one(['1', 'CX', '50001', 'five', '', '9/3/2026']), /Expected a number in Ops Hub tab "manualorder_log", row 2 \(Quantity\)/);
  assert.throws(one(['1', 'CX', 8003051003, 1, '', '9/3/2026']), /turned into a number/);
  assert.throws(() => L.parseOpsLog_([['ADS Order Number', 'SKU']], 'manual', m), /missing the column "Channel"/);
  assert.equal(L.parseOpsLog_([H, ['1', 'cx', '50001', 1, '', L.parseMDY_('9/30/2026')], ['', '', '', '', '', '']], 'manual', m).rows[0][1], 'CX');
});

test('Rule 9.3 / 12.13: Amazon Sold = shipped; Delta is split into ledger events; ordered vs shipped', () => {
  const a = findRow(T.variance, 'Amazon', 'A80004');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, a, c)), [30, 0, 4, 26, 25, -1]);
  const ch = sheet(T.checks).values;
  const hdr = ch.findIndex((x) => x[0] === 'Amazon SKU');
  const head = ch[hdr];
  const tableRow = (sku) => { const i = ch.findIndex((x, j) => j > hdr && x[0] === sku) + 1; return (name) => wb.value(T.checks, i, head.indexOf(name) + 1); };
  const a8 = tableRow('A80004');
  assert.deepEqual(['Delta (Variance Overview)', 'Lost', 'Unexplained', 'Units Ordered (Business Report)', 'Units Shipped (ledger)'].map(a8), [-1, -1, 0, 4, 4]);
  const a3 = tableRow('A0030');
  assert.deepEqual(['Delta (Variance Overview)', 'Transfers not matched by in-transit', 'Unexplained', 'Units Shipped (ledger)'].map(a3), [0, 0, 0, 20]);
  const res = (label) => wb.value(T.checks, ch.findIndex((x) => x[1] === label) + 1, 3);
  assert.equal(res('Amazon Delta explained by ledger events'), 'OK');
  assert.equal(res('Amazon units ordered vs shipped (Sold / Used uses shipped)'), 'INFO: ordered 25 / shipped 25');
  // a balance change with no ledger event behind it is flagged
  const raw = sampleInputs(L).ledger;
  const last = raw.rows[raw.rows.length - 1].slice(); last[18] = '11'; // 50001 ending 4 → 11 with no event
  const b = L.buildWorkbookModel_(sampleInputs(L, { ledger: { header: raw.header, rows: raw.rows.slice(0, -1).concat([last]) } }));
  const w2 = workbookFromModels(b.sheets);
  const c2 = b.sheets.find((s) => s.name === b.tabs.checks).values;
  assert.equal(w2.value(b.tabs.checks, c2.findIndex((x) => x[1] === 'Amazon Delta explained by ledger events') + 1, 3),
    'FLAG: 1 SKU(s) have Delta the ledger does not explain — see table below');
});

test('Rule 4.2: Amazon Beginning/Ending include units travelling between Amazon warehouses', () => {
  const f = sheet(T.variance).values[findRow(T.variance, 'Amazon', 'A0030') - 1];
  assert.match(f[4], /Starting.*|SUMIFS.*\+SUMIFS.*\+SUMIFS/);
  assert.match(f[8], /^=SUMIFS\(.*MAX.*\)\+SUMIFS\(.*MAX.*\)$/);
  assert.equal(val(T.variance, findRow(T.variance, 'Amazon', 'A0030'), 'I'), 115, '107 on shelf + 5 expired + 3 in transit');
});

test('Rule 5.5a: kit lines with a blank or wordy Job — counted when certain, otherwise FLAG and listed on WO SKU Fixes', () => {
  const inputs = sampleInputs(L);
  const wo = Object.assign({}, inputs.workOrders);
  const base = wo.lines.find((l) => l.sku === '10030');
  wo.lines = wo.lines.concat([
    Object.assign({}, base, { wo: 'WO_X1', sku: '', description: 'NO GASSY DAYS STARTER KIT 10030', pieces: 7 }), // SKU in Description
    Object.assign({}, base, { wo: 'WO_X2', sku: '', description: 'NO GASSY DAYS STARTER KIT 30', pieces: 9 })     // no SKU anywhere
  ]);
  inputs.workOrders = wo;
  const b = L.buildWorkbookModel_(inputs);
  const w = workbookFromModels(b.sheets);
  const sh = (n) => b.sheets.find((s) => s.name === n);
  const woRows = sh(b.tabs.workOrders).values;
  assert.deepEqual(plain(woRows[0].slice(9)), ['Job (as reported)', 'How the SKU was found (Rule 5.5a)']);
  const x1 = woRows.find((r) => r[0] === 'WO_X1'), x2 = woRows.find((r) => r[0] === 'WO_X2');
  assert.equal(x1[4], '10030');
  assert.equal(x2[4], '', 'unresolved line has no SKU, so its kits match no row');
  // Receiving for ADS 10030 = the original kits + 7 (the 9 are not counted)
  const v = b.sheets.find((s) => s.name === b.tabs.variance).values;
  const r10030 = v.findIndex((r) => r[0] === 'ADS' && r[1] === '10030') + 1;
  assert.equal(w.value(b.tabs.variance, r10030, 6) - wb.value(T.variance, findRow(T.variance, 'ADS', '10030'), 6), 7);
  const checks = sh(b.tabs.checks).values;
  const line = (label) => checks.find((r) => r[1] === label);
  assert.match(line('Work-order lines with no usable SKU (kits NOT counted)')[2], /^FLAG: 1 line\(s\) \/ 9 kits not counted/);
  assert.match(line('Work-order lines with no usable SKU (kits NOT counted)')[3], /WO_X2 .*Job blank, Description "NO GASSY DAYS STARTER KIT 30"/);
  assert.match(line('Work-order SKUs not taken from Job (confirm)')[2], /^CHECK: 1 line/);
  assert.deepEqual(plain(sh(b.tabs.woFixes).values.slice(1).map((r) => [r[0], r[1]])),
    [['NO GASSY DAYS STARTER KIT 10030', '10030'], ['NO GASSY DAYS STARTER KIT 30', '']]);
  // The normal sample month has nothing to fix.
  const ok = sheet(T.checks).values;
  assert.equal(ok.find((r) => r[1] === 'Work-order lines with no usable SKU (kits NOT counted)')[2], 'OK');
});

test('Rule 8.1a: one 41001 mailer per unit sold of 80030 / 80090 / 80090,80090 / 80090,80090,80090 and of any bundle with a pouch (counted Shopify lines)', () => {
  const bm = sheet(T.bundleMap).values;
  const mailerRows = bm.filter((r) => r[1] === '41001').map((r) => [r[0], r[2], r[5]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(plain(mailerRows), [['80030', 1, 'Mailer rule (Rule 8.1a)'], ['80030,51002', 1, 'Mailer rule (Rule 8.1a)'],
    ['80090', 1, 'Mailer rule (Rule 8.1a)'], ['80090,80090', 1, 'Mailer rule (Rule 8.1a)']]);
  assert.ok(!bm.some((r) => r[1] === '41001' && /^(10030|51002)$/.test(r[0])), 'kits and accessories alone use no mailer');
  // Counted units: 80090,80090 ×2, 80030 ×1, 80090 ×1, 80030,51002 ×1 (the cancelled and refunded-unshipped 80090 lines don't count) = 5 mailers
  const r = findRow(T.variance, 'ADS', '41001');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, r, c)), [20, 0, 5, 15, 16, 1]);
  // Which SKUs use a mailer: pouch bundles yes (one per bundle, however many pouches), jar bundles and plain accessories no.
  const uses = (s) => L.usesMailer_(s);
  assert.deepEqual(['80030', '80090,80090,80090', '50005,80030', '80030,80030,51002', '80090,51003', '20001,20002', '51002', '10030', '50001,51002']
    .map(uses), [true, true, true, true, true, false, false, false, false]);
});

test('Rule 6.2: COGS in the new layout (no Trim); a SKU stored as a number still finds its cost', () => {
  const inputs = sampleInputs(L);
  inputs.cogs = { header: inputs.cogs.header, rows: inputs.cogs.rows.map((r) => (r[0] === '80090' ? [80090, '90ct Pouch'].concat(r.slice(2)) : r)) };
  const b = L.buildWorkbookModel_(inputs);
  const w = workbookFromModels(b.sheets);
  const v = b.sheets.find((s) => s.name === b.tabs.variance).values;
  const r = v.findIndex((x) => x[0] === 'ADS' && x[1] === '80090') + 1;
  close(w.value(b.tabs.variance, r, 11), 6.90);
  const a8 = v.findIndex((x) => x[0] === 'Amazon' && x[1] === 'A80004') + 1;
  assert.equal(w.value(b.tabs.variance, a8, 11), 'NO COST', 'a SKU with letters and no COGS row is still NO COST');
  assert.ok(!b.sheets.find((s) => s.name === b.tabs.checks).values.find((x) => x[1] === 'SKUs with no COGS cost')[3].includes('80090,'),
    'Checks does not list 80090 as missing');
  // Rule 11.2: the Outbound description lookup matches a number SKU the same way.
  const ob = b.sheets.find((s) => s.name === b.tabs.outbound).values;
  assert.equal(w.value(b.tabs.outbound, ob.findIndex((x) => x[0] === '80090') + 1, 2), '90ct Pouch');
});

test('Rule 6.2: with no COGS tab yet, a blank one is created — every SKU, costs empty, Total = sum; blanks show NO COST until typed', () => {
  const inputs = sampleInputs(L);
  inputs.cogs = null;
  const b = L.buildWorkbookModel_(inputs);
  const cogs = b.sheets.find((s) => s.name === b.tabs.cogs);
  assert.deepEqual(plain(cogs.values[0]), ['SKU', 'Description', 'Base Cost', 'Freight In', 'Tariff', 'Total / Unit']);
  assert.ok(cogs.preserveIfExists, 'never overwritten once it exists');
  const skus = cogs.values.slice(1).map((r) => r[0]);
  for (const s of ['10030', '80090', '80090,80090', 'A80004', '70003', '41001']) assert.ok(skus.includes(s), s + ' listed');
  assert.ok(cogs.values.slice(1).every((r) => r[2] === '' && r[3] === '' && r[4] === '' && /^=IF\(COUNT\(/.test(r[5])), 'only the sum formula is filled');
  let w = workbookFromModels(b.sheets);
  const v = b.sheets.find((s) => s.name === b.tabs.variance).values;
  const r = v.findIndex((x) => x[0] === 'ADS' && x[1] === '80090') + 1;
  assert.equal(w.value(b.tabs.variance, r, 11), 'NO COST');
  assert.match(b.sheets.find((s) => s.name === b.tabs.checks).values.find((x) => x[1] === 'SKUs with no COGS cost')[3], /created this run with every SKU and blank costs/);
  // Type only a Base Cost: Total / Unit sums what is there and the cost appears without a rebuild.
  const i = cogs.values.findIndex((x) => x[0] === '80090');
  const typed = cogs.values.map((row, k) => (k === i ? [row[0], row[1], 6.5, 0.4, '', row[5]] : row));
  w = workbookFromModels(b.sheets.map((s) => (s === cogs ? Object.assign({}, s, { values: typed }) : s)));
  close(w.value(b.tabs.variance, r, 11), 6.9);
});

test('Rule 11.2a: a bundle with no COGS cost is costed from its parts; its own COGS cost wins when above $0', () => {
  const inputs = sampleInputs(L);
  // Two more Shopify bundles: one whose parts are all on COGS, one with a part (A80004) that has no COGS row.
  const sh = inputs.shopify, skuIx = sh.header.indexOf('Lineitem sku');
  const tin = sh.rows.find((r) => r[skuIx] === '80030,51002');
  const nameIx = sh.header.indexOf('Name');
  const line = (order, sku) => tin.map((x, i) => (i === skuIx ? sku : i === nameIx ? order : x));
  sh.rows.push(line('#90', '80030,80030,51002'), line('#91', '80030,A80004'));
  // 80030,51002 has no COGS row; 80090,80090's Total was typed as $0.
  inputs.cogs = { header: inputs.cogs.header, rows: inputs.cogs.rows.filter((r) => r[0] !== '80030,51002')
    .map((r) => (r[0] === '80090,80090' ? [r[0], r[1], 0, 0, 0, 0] : r)) };
  const b = L.buildWorkbookModel_(inputs);
  const w = workbookFromModels(b.sheets);
  const ob = b.sheets.find((s) => s.name === b.tabs.outbound).values;
  const cost = (sku) => w.value(b.tabs.outbound, ob.findIndex((x) => x[0] === sku) + 1, 3);
  close(cost('80030,51002'), 2.96 + 0.45);         // parts: 80030 + 51002
  close(cost('80030,80030,51002'), 2 * 2.96 + 0.45);
  close(cost('80090,80090'), 2 * 6.90);            // own $0 → parts
  assert.equal(cost('80030,A80004'), 'NO COST');   // a part has no cost
  close(cost('80030'), 2.96);                       // plain SKUs unchanged
  // Checks lists only the bundle whose part is missing.
  const detail = b.sheets.find((s) => s.name === b.tabs.checks).values.find((x) => x[1] === 'SKUs with no COGS cost')[3];
  assert.match(detail, /80030,A80004/);
  assert.ok(!/80030,51002|80030,80030,51002/.test(detail), detail);
  // Own COGS cost above $0 wins (sample month: 80090,80090 typed as 13.80; set 80030,51002 to 5.00).
  const inputs2 = sampleInputs(L);
  inputs2.cogs = { header: inputs2.cogs.header, rows: inputs2.cogs.rows.map((r) => (r[0] === '80030,51002' ? [r[0], '', 5, 0, 0, 5] : r)) };
  const b2 = L.buildWorkbookModel_(inputs2), w2 = workbookFromModels(b2.sheets);
  const ob2 = b2.sheets.find((s) => s.name === b2.tabs.outbound).values;
  close(w2.value(b2.tabs.outbound, ob2.findIndex((x) => x[0] === '80030,51002') + 1, 3), 5);
  assert.doesNotThrow(() => L.assertExcelSafe_(b.sheets));
});
