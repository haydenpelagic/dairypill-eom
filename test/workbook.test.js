'use strict';
// Builds a whole workbook from a small made-up month, then CALCULATES every formula with the
// test formula engine and compares the results with numbers worked out by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLogic } = require('./load');
const { workbookFromModels, isErr } = require('./formulaEngine');
const { sampleInputs, sampleHub } = require('./fixtures/sampleMonth');

const L = loadLogic();
const built = L.buildWorkbookModel_(sampleInputs(L));
const wb = workbookFromModels(built.sheets);
const T = built.tabs;
const sheet = (name) => built.sheets.find((s) => s.name === name);

/** Row (1-based) whose column A and B match, on a summary tab. */
function findRow(tab, a, b, built2) {
  const v = (built2 || built).sheets.find((s) => s.name === tab).values;
  for (let r = 0; r < v.length; r++) if (v[r][0] === a && (b === undefined || v[r][1] === b)) return r + 1;
  throw new Error('No row ' + a + ' / ' + b + ' on ' + tab);
}
/** A copy of the sample hub with changes (Ops Hub as someone edited it). */
const hubWith = (fn) => { const h = sampleHub(2026, 8); fn(h); return h; };
const build = (overrides) => { const b = L.buildWorkbookModel_(sampleInputs(L, overrides)); return { b, w: workbookFromModels(b.sheets) }; };
const checkRow = (b, label) => b.sheets.find((s) => s.name === b.tabs.checks).values.find((r) => r[1] === label);
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
  assert.ok(!ads.includes('99999'), 'an Ops Hub row with 0 last month and 0 this month makes no row');
  const mfg = built.blocks.find((b) => b.kind === 'MFG');
  assert.deepEqual(plain(mfg.rows.map((x) => [x.mfg, x.sku, x.countBlank])), [['VitaQuest', '70003', false], ['VitaPros', '70003', false]], 'Ops Hub order');
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

test('Rule 9.5 MFG: one row per manufacturer + SKU in Ops Hub (its order); Beginning/count from Ops Hub, Received from MFG Receipts; delta 0', () => {
  const vq = findRow(T.variance, 'VitaQuest', '70003');
  const vp = findRow(T.variance, 'VitaPros', '70003');
  assert.equal(vp, vq + 1, 'same order as Ops Hub inventory_eom');
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vq, c)), [100, 50, 30, 120, 120, 0]);
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J'].map((c) => val(T.variance, vp, c)), [0, 300, 0, 300, 300, 0]);
  assert.equal(val(T.variance, vq, 'D'), 'Raw Material - Component');
  assert.equal(sheet(T.variance).values.length, vp, 'the MFG rows are the last rows — no subtotal row');
  assert.match(sheet(T.variance).values[vq - 1][8], /^=SUMIFS\('Ops Hub Inventory 09\.30\.2026'!D:D,/);
  // Valuation has the same rows
  assert.equal(val(T.valuation, findRow(T.valuation, 'VitaQuest', '70003'), 'E'), 120);
  assert.equal(val(T.valuation, findRow(T.valuation, 'VitaPros', '70003'), 'E'), 300);
});

test('Rule 7.2a: MFG Receipts typed in the report update the MFG rows without a rerun', () => {
  const rec = sheet(T.mfgReceipts);
  assert.deepEqual(plain(rec.values[0]), ['MFG', 'SKU', 'Qty']);
  assert.equal(rec.preserveIfExists, true);
  const w = workbookFromModels(built.sheets.map((s) => (s === rec ? Object.assign({}, s, { values: [rec.values[0], ['VitaQuest', '70003', 80]] }) : s)));
  const vq = findRow(T.variance, 'VitaQuest', '70003'), vp = findRow(T.variance, 'VitaPros', '70003');
  assert.deepEqual(['E', 'F', 'G', 'I', 'J'].map((c) => w.value(T.variance, vq, c.charCodeAt(0) - 64)), [100, 80, 60, 120, 0]);
  assert.deepEqual(['E', 'F', 'G', 'I'].map((c) => w.value(T.variance, vp, c.charCodeAt(0) - 64)), [0, 0, -300, 300], 'no receipt typed: used goes negative');
  const r = sheet(T.checks).values.findIndex((x) => x[1] === 'Manufacturer rows with negative Sold / Used') + 1;
  assert.equal(w.value(T.checks, r, 3), 'CHECK: 1 rows — more arrived than the count shows');
});

test('Rule 9.5: a manufacturer count left blank in Ops Hub stays blank on the report (never 0) and is a FLAG', () => {
  const { b, w } = build({ hub: hubWith((h) => { h.inventory.find((r) => r.group === 'VitaQuest').end = ''; }) });
  const v = (tab, row, c) => w.value(tab, row, c.charCodeAt(0) - 64);
  const vq = findRow(T.variance, 'VitaQuest', '70003', b);
  assert.deepEqual(['E', 'F', 'G', 'H', 'I', 'J', 'L', 'M', 'N'].map((c) => v(T.variance, vq, c)), [100, 50, '', '', '', '', '', '', '']);
  const iv = findRow(T.valuation, 'VitaQuest', '70003', b);
  assert.deepEqual(['E', 'K'].map((c) => v(T.valuation, iv, c)), ['', '']);
  const row = checkRow(b, 'Manufacturer counts in Ops Hub inventory_eom');
  assert.equal(row[2], 'FLAG: 1 row(s) have no Sep 2026 count');
  assert.match(row[3], /Shown blank on Variance Overview and Inventory Valuation \(not 0\): VitaQuest 70003\. Type each count in the Sep 2026 column of Ops Hub inventory_eom/);
  // totals still tie (blank rows add nothing on either tab)
  const rows = b.sheets.find((s) => s.name === b.tabs.checks).values;
  assert.equal(w.value(T.checks, rows.findIndex((x) => x[1] === 'Inventory Valuation total = Variance Overview Total Actual Cost') + 1, 3), 'OK');
  // a manufacturer row only on MFG Receipts (nothing in Ops Hub) shows with a blank count too
  const { b: b2 } = build({ mfgReceipts: [['VitaQuest', '70003', 50], ['NewCo', '70009', 10]] });
  assert.deepEqual(plain(b2.blocks.find((x) => x.kind === 'MFG').rows.map((x) => [x.mfg, x.sku, x.countBlank])),
    [['VitaQuest', '70003', false], ['VitaPros', '70003', false], ['NewCo', '70009', true]]);
});

test('Rule 9.3 costs and missing COGS', () => {
  // Rule 8.1b: on-hand cost = COGS Total / Unit − the mailer the BOM says is only added when shipped (41001 = $0.32).
  const r = findRow(T.variance, 'ADS', '80090');
  close(val(T.variance, r, 'K'), 6.90 - 0.32);
  close(val(T.variance, r, 'N'), 170 * 6.58 - 195 * 6.58);
  close(val(T.variance, findRow(T.variance, 'ADS', '80030'), 'K'), 2.96 - 0.32);
  close(val(T.variance, findRow(T.variance, 'ADS', '10030'), 'K'), 7.19);   // no mailer line on the BOM: COGS as typed
  close(val(T.variance, findRow(T.variance, 'ADS', '41001'), 'K'), 0.32);   // the loose mailers themselves
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
  // 80030 and 80090 are valued without their mailer (Rule 8.1b): 2.96 − 0.32 and 6.90 − 0.32.
  const ending = 5 * 7.19 + 90 * 2.64 + 170 * 6.58 + 28 * 0.45 + 48 * 2.10 + 35 * 0.64 + 15 * 2.87 + 115 * 2.87 + 4 * 2.10 + 16 * 0.32;
  const raw = 300 * 197.96 + 120 * 197.96;
  const vals = sheet(T.valuation).values;
  assert.ok(!vals.some((r) => /^(Subtotal|▼)/.test(String(r[0]))), 'no block headings or subtotal rows');
  assert.deepEqual(plain(vals[3].slice(0, 11)), ['Location', 'SKU', 'Description', 'Categorization', 'Available Inventory', 'Base Cost',
    'Freight In', 'Tariff', 'Less: Mailer (added when shipped)', 'Total / Unit', 'Total Inventory Value']);
  assert.deepEqual(plain([vals[3][12], vals[4][12], vals[5][12]]), ['Ending Inventory', 'Raw Material - Component', 'TOTAL INVENTORY VALUE']);
  close(val(T.valuation, 4, 'N'), ending);
  close(val(T.valuation, 5, 'N'), raw);
  close(val(T.valuation, 6, 'N'), ending + raw);
  const a8 = findRow(T.valuation, 'Amazon', 'A80004');
  assert.equal(val(T.valuation, a8, 'E'), 25);
  assert.equal(val(T.valuation, a8, 'K'), 'NO COST');
  // Rule 10.1: the mailer column explains the difference from COGS: Base + Freight + Tariff − Mailer = Total / Unit.
  const p = findRow(T.valuation, 'ADS', '80030');
  assert.deepEqual(['F', 'G', 'H', 'I', 'J'].map((c) => Math.round(val(T.valuation, p, c) * 100) / 100), [2.60, 0.01, 0.35, 0.32, 2.64]);
  close(val(T.valuation, p, 'K'), 90 * 2.64);
  assert.equal(val(T.valuation, findRow(T.valuation, 'ADS', '10030'), 'I'), 0, 'a kit has no mailer taken out');
  assert.equal(val(T.valuation, findRow(T.valuation, 'VitaQuest', '70003'), 'I'), 0, 'MFG rows use the same formula');
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
  assert.match(result('Business Report ASINs with sales that are not in the ledger'), /^CHECK: 1 rows/); // ASIN B8 has sales
  assert.match(result('Shopify lines with no SKU (not counted anywhere)'), /^FLAG: 1 /);
  assert.equal(result('Rows where Expected Ending Inventory is negative'), 'OK');
  assert.equal(result('Inventory Valuation total = sum of every row'), 'OK');
  assert.equal(result('Inventory Valuation total = Variance Overview Total Actual Cost'), 'OK');
  assert.equal(result('Manufacturer counts in Ops Hub inventory_eom'), 'OK');
  assert.equal(result('Manufacturer rows with negative Sold / Used'), 'OK');
  for (const label of ['Ops Hub ending inventory = ADS snapshot and Amazon ledger', 'Ops Hub units sold = Shopify, manualorder_log and Amazon ledger',
    'Ops Hub kits built = work-order report (total)', 'Amazon starting balance = Ops Hub Aug 2026 ending']) assert.equal(result(label), 'OK', label);
  // Rule 6.3: the AMZ SKU Map is made from the rules (one row per MSKU + ASIN in the ledger)
  assert.deepEqual(plain(sheet(T.skuMap).values.slice(1).map((r) => r.slice(0, 3))),
    [['A0030 - TEMP SKU', 'B1', 'A0030'], ['A80002', 'B2', 'A80004'], ['50001', 'B3', '50001']]);
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

test('manual tabs are preserved on rebuild; summaries and the locked Ops Hub copies are not', () => {
  for (const name of [T.adsReceipts, T.mfgReceipts, T.prepaid, T.cogs]) assert.equal(sheet(name).preserveIfExists, true, name);
  for (const name of [T.variance, T.valuation, T.outbound, T.checks, T.ledger, T.hubInventory, T.hubSellThru, T.hubWoLog]) assert.equal(sheet(name).preserveIfExists, false, name);
  assert.deepEqual(plain(built.sheets.map((s) => s.name)).sort(), Array.from(L.tabOrder_(T)).sort(), 'exactly the tabs in the README order');
});

test('Rules 4 / 9 / 11: the Ops Hub numbers are copied into the report as values (locked), with where they came from', () => {
  const inv = sheet(T.hubInventory).values;
  assert.deepEqual(plain(inv[0].slice(0, 4)), ['Location', 'SKU', 'Beginning (08/31/2026)', 'Ending (09/30/2026)']);
  assert.match(inv[0][4], /Copied from Ops Hub 2\.0 "inventory_eom" \(Aug 2026 and Sep 2026 columns\) when the report was generated \(2026-10-05 09:00 by test\)\. Locked/);
  assert.deepEqual(plain(inv.find((r) => r[0] === 'VitaPros').slice(0, 4)), ['VitaPros', '70003', '', 300], 'a blank stays blank');
  assert.ok(L.allFormulas_([sheet(T.hubInventory), sheet(T.hubSellThru), sheet(T.hubWoLog)]).length === 0, 'values only — nothing links to Ops Hub');
  assert.deepEqual(plain(sheet(T.hubSellThru).values[1].slice(0, 3)), ['DTC', '10030', 3]);
  assert.deepEqual(plain(sheet(T.hubWoLog).values.slice(1).map((r) => r.slice(1, 4))), [[5, '10030', 0.54], [4, 'A0030', 0.38], [6, 'A0030', 0.38]]);
  assert.match(sheet(T.kit).values[1][3], /^=SUMIFS\('Ops Hub WO Log 09\.30\.2026'!B:B,'Ops Hub WO Log 09\.30\.2026'!C:C,\$A2\)$/);
});

test('Rule 12.14: Ops Hub changed after it was written — the report shows the Ops Hub number and Checks names the difference', () => {
  const { b, w } = build({ hub: hubWith((h) => {
    h.inventory.find((r) => r.group === 'ADS' && r.sku === '80090').end = 175;
    h.sellThru.find((r) => r.group === 'DTC' && r.sku === '10030').qty = 4;
    h.woLog.pop();
    h.inventory.find((r) => r.group === 'Amazon' && r.sku === 'A0030').begin = 115;
  }) });
  assert.equal(w.value(T.variance, findRow(T.variance, 'ADS', '80090', b), 9), 175, 'Actual = Ops Hub');
  assert.equal(w.value(T.outbound, findRow(T.outbound, '10030', undefined, b), 4), 4, 'DTC units = Ops Hub');
  assert.equal(w.value(T.variance, findRow(T.variance, 'ADS', 'A0030', b), 6), 4, 'kits built = Ops Hub wo_log');
  const row = (label) => checkRow(b, label);
  assert.deepEqual(plain(row('Ops Hub ending inventory = ADS snapshot and Amazon ledger').slice(2)),
    ['FLAG: 1 differ', 'ADS 80090: Ops Hub 175, ADS snapshot 170. The report uses the Ops Hub numbers. If Ops Hub was changed on purpose, nothing to do; otherwise run EOM → Write month to Ops Hub again, then Generate EOM Report.']);
  assert.match(row('Ops Hub units sold = Shopify, manualorder_log and Amazon ledger')[3], /^DTC 10030: Ops Hub 4, reports 3\./);
  assert.match(row('Ops Hub kits built = work-order report (total)')[3], /^Kits built in September 2026: Ops Hub wo_log 9, work-order report 15\. The report uses Ops Hub wo_log\. Write month to Ops Hub never rewrites a month already there/);
  assert.equal(row('Amazon starting balance = Ops Hub Aug 2026 ending')[2], 'FLAG: 1 differ');
  assert.match(row('Amazon starting balance = Ops Hub Aug 2026 ending')[3], /^Amazon A0030: Ops Hub Aug 2026 ending 115, ledger 09\/01\/2026 starting 120\./);
  // Amazon Beginning itself still comes from the ledger (Rule 4.2)
  assert.equal(w.value(T.variance, findRow(T.variance, 'Amazon', 'A0030', b), 5), 120);
});

test('Rule 3: tabs the report does not make (old layout) are left alone and listed on Checks', () => {
  const { b } = build({ extraTabs: ['MFG Counts 09.30.2026', 'WO SKU Fixes'] });
  assert.deepEqual(plain(checkRow(b, 'Tabs this version does not make').slice(2)),
    ['CHECK: 2 tab(s)', 'MFG Counts 09.30.2026, WO SKU Fixes — left as they were (probably from the old layout). Nothing uses them: delete them before sending.']);
  assert.equal(checkRow(built, 'Tabs this version does not make'), undefined);
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

test('Rule 4.2: AMZ Starting tab = this month\'s 1st-of-month ledger rows; Amazon Beginning comes from them, not from Ops Hub', () => {
  const v = sheet(T.amzStart).values;
  assert.equal(v.length, 4);
  assert.ok(v.slice(1).every((row) => row[0] === v[1][0]));
  const r = findRow(T.variance, 'Amazon', 'A0030');
  assert.match(sheet(T.variance).values[r - 1][4], /'AMZ Starting Balance 08\.31\.2026'/);
  assert.equal(val(T.variance, r, 'E'), 120);
  // the same rule in plain JS (used to compare with Ops Hub): two MSKUs for one SKU are added together
  const H = ['MSKU', 'Starting Warehouse Balance', 'In Transit Between Warehouses', 'Warehouse Transfer In/Out'];
  assert.deepEqual(plain(L.amzStartBySku_({ header: H, rows: [['A0030 - TEMP SKU', '2', '1', '0'], ['A0030', '3', '0', '-1'], ['A80002', '5', '', '']] })),
    { A0030: 5, A80004: 5 });
});

test('Rule 12.3: an ASIN whose MSKUs map to two different SKUs is flagged', () => {
  const label = 'Amazon ASIN mapped to more than one of our SKUs';
  assert.equal(checkRow(built, label)[2], 'OK', 'A0030 - TEMP SKU and A0030 on one ASIN would both be A0030');
  const raw = sampleInputs(L).ledger;
  const extra = raw.rows[raw.rows.length - 1].slice(); extra[2] = 'B1'; extra[3] = 'A0031';
  const { b } = build({ ledger: { header: raw.header, rows: raw.rows.concat([extra]) } });
  assert.equal(checkRow(b, label)[2], 'FLAG: 1');
  assert.match(checkRow(b, label)[3], /ASIN B1 → A0030 \/ A0031/);
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
    ['ADS Order Number', 'Amazon Store Number', 'SKU', 'Quantity', 'Order Date Date Labels are Received', 'Ship Date'],
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
  const A = ['ADS Order Number', 'Amazon Store Number', 'SKU', 'Quantity', 'Order Date Date Labels are Received', 'Ship Date'];
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
  // a balance change with no ledger event behind it is flagged (Ops Hub says Amazon 50001 ended at 11, the ledger 4)
  const b = L.buildWorkbookModel_(sampleInputs(L, { hub: hubWith((h) => { h.inventory.find((r) => r.group === 'Amazon' && r.sku === '50001').end = 11; }) }));
  const w2 = workbookFromModels(b.sheets);
  const c2 = b.sheets.find((s) => s.name === b.tabs.checks).values;
  assert.equal(w2.value(b.tabs.checks, c2.findIndex((x) => x[1] === 'Amazon Delta explained by ledger events') + 1, 3),
    'FLAG: 1 SKU(s) have Delta the ledger does not explain — see table below');
});

test('Rule 4.2: Amazon Beginning/Ending include units travelling between Amazon warehouses', () => {
  const f = sheet(T.variance).values[findRow(T.variance, 'Amazon', 'A0030') - 1];
  assert.match(f[4], /Starting.*|SUMIFS.*\+SUMIFS.*\+SUMIFS/);
  assert.match(f[8], /^=SUMIFS\('Ops Hub Inventory 09\.30\.2026'!D:D,/, 'Actual Ending = Ops Hub (Write month to Ops Hub put Ending + In Transit there)');
  assert.equal(val(T.variance, findRow(T.variance, 'Amazon', 'A0030'), 'I'), 115, '107 on shelf + 5 expired + 3 in transit');
  assert.equal(plain(L.amazonOnHand_(sampleInputs(L).ledger)).find((d) => d.sku === 'A0030' && d.qty > 100).qty, 107 + 3);
});

test('Rule 5.5a / 8.2: kit lines with a blank or wordy Job — the report shows how each was read; kits built come from Ops Hub wo_log', () => {
  const inputs = sampleInputs(L);
  const wo = Object.assign({}, inputs.workOrders);
  const base = wo.lines.find((l) => l.sku === '10030');
  wo.lines = wo.lines.concat([
    Object.assign({}, base, { wo: 'WO_X1', sku: '', description: 'NO GASSY DAYS STARTER KIT 10030', pieces: 7 }), // SKU in Description
    Object.assign({}, base, { wo: 'WO_X2', sku: '', description: 'NO GASSY DAYS STARTER KIT 30', pieces: 9 })     // no SKU anywhere
  ]);
  inputs.workOrders = wo;
  // Ops Hub wo_log as Write month to Ops Hub left it (the 9 kits under ADS's text, not fixed yet)
  inputs.hub = hubWith((h) => { h.woLog.push({ serial: h.woLog[0].serial, qty: 7, sku: '10030', cost: 0.54 }, { serial: h.woLog[0].serial, qty: 9, sku: 'NO GASSY DAYS STARTER KIT 30', cost: 0.54 }); });
  const b = L.buildWorkbookModel_(inputs);
  const w = workbookFromModels(b.sheets);
  const sh = (n) => b.sheets.find((s) => s.name === n);
  const woRows = sh(b.tabs.workOrders).values;
  assert.deepEqual(plain(woRows[0].slice(9)), ['Job (as reported)', 'How the SKU was found (Rule 5.5a)']);
  assert.equal(woRows.find((r) => r[0] === 'WO_X1')[4], '10030');
  assert.equal(woRows.find((r) => r[0] === 'WO_X2')[4], 'NO GASSY DAYS STARTER KIT 30');
  // Receiving for ADS 10030 = Ops Hub wo_log: the original 5 + 7; the text line makes no ADS row and is flagged
  const r10030 = findRow(T.variance, 'ADS', '10030', b);
  assert.equal(w.value(b.tabs.variance, r10030, 6), 12);
  assert.ok(!b.blocks.find((x) => x.kind === 'ADS').skus.includes('NO GASSY DAYS STARTER KIT 30'));
  const line = (label) => checkRow(b, label);
  assert.deepEqual(plain(line('Kits built (Ops Hub wo_log) that have no BOM rows').slice(2)), ['FLAG: 1',
    'Components not deducted, and no ADS row, for: NO GASSY DAYS STARTER KIT 30 (9 kits). Fix the SKU in Ops Hub wo_log (or add the kit to the Ops Hub BOM), then Generate EOM Report again.']);
  assert.match(line('Work-order lines ADS wrote with no SKU (went into wo_log as written)')[2], /^INFO: 1 line\(s\) \/ 9 kits/);
  assert.match(line('Work-order SKUs found in the text (confirm)')[2], /^CHECK: 1 line/);
  assert.equal(line('Ops Hub kits built = work-order report (total)')[2], 'OK', 'same total kits, whatever the SKUs');
  // once fixed in wo_log, the flag clears and the kits count for the right SKU
  const fixed = L.buildWorkbookModel_(Object.assign({}, inputs, { hub: hubWith((h) => { h.woLog.push({ serial: h.woLog[0].serial, qty: 16, sku: '10030', cost: 0.54 }); }) }));
  assert.equal(checkRow(fixed, 'Kits built (Ops Hub wo_log) that have no BOM rows')[2], 'OK');
  // The normal sample month has nothing to fix.
  assert.equal(checkRow(built, 'Work-order lines ADS wrote with no SKU (went into wo_log as written)')[2], 'OK');
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
  close(w.value(b.tabs.variance, r, 11), 6.90 - 0.32); // on-hand cost: COGS less the mailer (Rule 8.1b)
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
  // Rule 8.1b: 80090's on-hand cost needs the mailer's cost too (its BOM lists a mailer added when shipped) — loud until typed.
  assert.equal(w.value(b.tabs.variance, r, 11), 'NO COST');
  const j = cogs.values.findIndex((x) => x[0] === '41001');
  const typed2 = typed.map((row, k) => (k === j ? [row[0], row[1], 0.32, '', '', row[5]] : row));
  w = workbookFromModels(b.sheets.map((s) => (s === cogs ? Object.assign({}, s, { values: typed2 }) : s)));
  close(w.value(b.tabs.variance, r, 11), 6.9 - 0.32);
});

test('Rule 11.2a: a bundle with no COGS cost is costed from its parts; its own COGS cost wins when above $0', () => {
  const inputs = sampleInputs(L);
  // Two more Shopify bundles: one whose parts are all on COGS, one with a part (A80004) that has no COGS row.
  const sh = inputs.shopify, skuIx = sh.header.indexOf('Lineitem sku');
  const tin = sh.rows.find((r) => r[skuIx] === '80030,51002');
  const nameIx = sh.header.indexOf('Name');
  const line = (order, sku) => tin.map((x, i) => (i === skuIx ? sku : i === nameIx ? order : x));
  sh.rows.push(line('#90', '80030,80030,51002'), line('#91', '80030,A80004'));
  inputs.hub = hubWith((h) => { h.sellThru.push({ group: 'TikTok', sku: '80030,80030,51002', qty: 1 }, { group: 'TikTok', sku: '80030,A80004', qty: 1 }); });
  // 80030,51002 has no COGS row; 80090,80090's Total was typed as $0.
  inputs.cogs = { header: inputs.cogs.header, rows: inputs.cogs.rows.filter((r) => r[0] !== '80030,51002')
    .map((r) => (r[0] === '80090,80090' ? [r[0], r[1], 0, 0, 0, 0] : r)) };
  const b = L.buildWorkbookModel_(inputs);
  const w = workbookFromModels(b.sheets);
  const ob = b.sheets.find((s) => s.name === b.tabs.outbound).values;
  const cost = (sku) => w.value(b.tabs.outbound, ob.findIndex((x) => x[0] === sku) + 1, 3);
  // Rule 8.1b: parts at on-hand cost (80030 = 2.96 − 0.32 mailer), then ONE mailer per bundle unit.
  close(cost('80030,51002'), 2.64 + 0.45 + 0.32);  // parts: 80030 + 51002 + one mailer (= 2.96 + 0.45, as before)
  close(cost('80030,80030,51002'), 2 * 2.64 + 0.45 + 0.32); // two pouches, still one mailer
  close(cost('80090,80090'), 2 * 6.58 + 0.32);     // own $0 → parts, one mailer
  assert.equal(cost('80030,A80004'), 'NO COST');   // a part has no cost
  close(cost('80030'), 2.96);                       // a pouch sold alone: on-hand 2.64 + mailer 0.32 = its COGS cost
  // Checks lists only the bundle whose part is missing.
  const detail = b.sheets.find((s) => s.name === b.tabs.checks).values.find((x) => x[1] === 'SKUs with no COGS cost')[3];
  assert.match(detail, /80030,A80004/);
  assert.ok(!/80030,51002|80030,80030,51002/.test(detail), detail);
  // Own COGS cost above $0 wins (sample month: 80090,80090 typed as 13.80; set 80030,51002 to 5.00).
  const inputs2 = sampleInputs(L);
  inputs2.cogs = { header: inputs2.cogs.header, rows: inputs2.cogs.rows.map((r) => (r[0] === '80030,51002' ? [r[0], '', 5, 0, 0, 5] : r)) };
  const b2 = L.buildWorkbookModel_(inputs2), w2 = workbookFromModels(b2.sheets);
  const ob2 = b2.sheets.find((s) => s.name === b2.tabs.outbound).values;
  // A typed bundle cost is what is in the box (no BOM mailer line), so one mailer is added on top.
  close(w2.value(b2.tabs.outbound, ob2.findIndex((x) => x[0] === '80030,51002') + 1, 3), 5 + 0.32);
  // The sample month's own 80090,80090 cost has a BOM mailer line: 13.80 − 0.32 + 0.32 = 13.80 (see Rule 11 test).
  assert.doesNotThrow(() => L.assertExcelSafe_(b.sheets));
});

test('Rule 8.1b / 6.1: the BOM tab marks only the pouch → mailer lines as "added when shipped" (a kit\'s mailer is inside the kit)', () => {
  const bom = sheet(T.bom).values;
  assert.equal(bom[0][5], 'Mailer added when shipped');
  const flag = (p, c) => bom.find((r) => r[0] === p && r[2] === c)[5];
  assert.deepEqual(['80030', '80090', '80090,80090'].map((p) => flag(p, '41001')), ['Yes', 'Yes', 'Yes']);
  assert.equal(flag('X4', '41001'), '', 'a kit that contains a mailer keeps it in its cost');
  assert.equal(flag('10030', '80030'), '', 'other lines are not marked');
});

test('Rule 8.1b: Outbound Avg Cost = on-hand cost + one mailer, charged on Shopify units only (not manualorder_log, not Amazon)', () => {
  const { sampleRaw, csv } = require('./fixtures/sampleMonth');
  const raw = sampleRaw(2026, 8), m = L.monthInfo_(2026, 8);
  raw.manualLog.push(['146', 'Samples', '80030', '2', '', '9/6/2026']);               // 2 pouches sent as samples: no mailer
  const last = raw.ledger[raw.ledger.length - 1];
  const amz = last.slice(); amz[1] = 'B7'; amz[2] = 'B7'; amz[3] = '80030'; amz[8] = '1'; amz[9] = '-1'; amz[18] = '0'; // Amazon sold 1 pouch
  raw.ledger.push(amz);
  const b = L.buildWorkbookModel_(sampleInputs(L, {
    manualLog: L.parseOpsLog_(raw.manualLog, 'manual', m),
    ledger: L.toTable_(L.parseCsv_(csv(raw.ledger)), 'ledger'),
    // what Write month to Ops Hub puts in sell_thru monthly for these
    hub: hubWith((h) => { h.sellThru.push({ group: 'Samples', sku: '80030', qty: 2 }, { group: 'Amazon', sku: '80030', qty: 1 }); })
  }));
  const w = workbookFromModels(b.sheets);
  const ob = b.sheets.find((s) => s.name === b.tabs.outbound).values;
  const r = ob.findIndex((x) => x[0] === '80030') + 1;
  const v = (col) => w.value(b.tabs.outbound, r, col.charCodeAt(0) - 64);
  close(v('C'), 2.96);                    // as shipped on Shopify: 2.64 on hand + 0.32 mailer
  assert.deepEqual(['D', 'H', 'L', 'N', 'P'].map(v), [0, 1, 2, 1, 4]); // DTC, CX (Shopify replacement), Samples (log), Amazon, All
  close(v('I'), 1 * 2.96);                // Shopify unit: with the mailer
  close(v('M'), 2 * 2.64);                // manualorder_log units: no mailer
  close(v('O'), 1 * 2.64);                // Amazon unit: no mailer
  close(v('Q'), 2.96 + 2 * 2.64 + 2.64);
  // Units side unchanged: the mailer rule still counts only Shopify units (5), the samples use none.
  const vo = b.sheets.find((s) => s.name === b.tabs.variance).values;
  const m41 = vo.findIndex((x) => x[0] === 'ADS' && x[1] === '41001') + 1;
  assert.equal(w.value(b.tabs.variance, m41, 7), 5);
  close(w.value(b.tabs.variance, vo.findIndex((x) => x[0] === 'Amazon' && x[1] === '80030') + 1, 11), 2.64);
  assert.doesNotThrow(() => L.assertExcelSafe_(b.sheets));
});

test('Rule 8.1b / 12: Checks lists the mailers taken out of on-hand cost; a typed bundle cost with no BOM mailer line is CHECK', () => {
  const rows = sheet(T.checks).values;
  const i = rows.findIndex((x) => x[1] === 'Mailer: out of on-hand cost, into Outbound cost');
  assert.match(rows[i][3], /80030 → 1 × 41001; 80090 → 1 × 41001; 80090,80090 → 1 × 41001/);
  assert.ok(!/X4/.test(rows[i][3]), 'kit mailers are not listed');
  // The sample COGS has a typed 80030,51002 cost and no BOM mailer line for it → CHECK naming it.
  assert.equal(wb.value(T.checks, i + 1, 3), 'CHECK: 1 SKU(s) with no mailer line on the BOM');
  assert.match(rows[i][3], /No mailer line on the BOM for: 80030,51002/);
  // Without that typed bundle cost: INFO with the live count of mailers on Shopify orders (5 counted).
  const inputs = sampleInputs(L);
  inputs.cogs = { header: inputs.cogs.header, rows: inputs.cogs.rows.filter((r) => r[0] !== '80030,51002') };
  const b = L.buildWorkbookModel_(inputs), w = workbookFromModels(b.sheets);
  const rows2 = b.sheets.find((s) => s.name === b.tabs.checks).values;
  const j = rows2.findIndex((x) => x[1] === 'Mailer: out of on-hand cost, into Outbound cost') + 1;
  assert.equal(w.value(b.tabs.checks, j, 3), 'INFO: 5 mailers on Shopify orders, costed on Outbound Summary');
});

test('Rule 12.7a: a row copied twice on Inventory Valuation is caught (Variance Overview total no longer matches)', () => {
  const iv = sheet(T.valuation);
  const p = findRow(T.valuation, 'ADS', '80030');
  // Copy the row's cells to the bottom unchanged — exactly what a hand-copied row does (it still points at the same figures).
  const copied = iv.values.concat([iv.values[p - 1].slice()]);
  const w = workbookFromModels(built.sheets.map((s) => (s === iv ? Object.assign({}, s, { values: copied }) : s)));
  const rows = sheet(T.checks).values;
  const res = (label) => w.value(T.checks, rows.findIndex((x) => x[1] === label) + 1, 3);
  assert.match(res('Inventory Valuation total = Variance Overview Total Actual Cost'), /^FLAG: the two totals differ/);
  assert.equal(res('Inventory Valuation total = sum of every row'), 'OK', 'the old check could not see it');
});

test('Rule 5.6: amz_log as it is laid out in the Ops Hub — header in row 2, line breaks in names, SKU first, Ship Date in F', () => {
  const m = L.monthInfo_(2026, 9);
  const v = [['', '', '', '', '', ''],
    ['SKU', 'Quantity', 'ADS Order \nNumber', 'Amazon Store \nNumber', 'Order Date\nDate Labels are Received', 'Ship Date'],
    ['A0030', 480, '0000164', 'MCC1', 46293, '10/1/2026'],     // shipped in October: counted
    ['A0030', 560, '0000173', 'TOL3', 46322, ''],              // no Ship Date yet: not counted
    ['A0090', 80, '0000178', 'RDU2', 46329, '11/4/2026']];     // shipped in November: not October
  const out = L.parseOpsLog_(v, 'amz', m);
  assert.deepEqual(plain(out.rows), [['0000164', 'MCC1', 'A0030', 480, '46293', L.parseMDY_('10/1/2026')]]);
  assert.equal(out.notShipped, 1);
  assert.equal(out.otherMonths, 1);
  // Error messages name the real sheet row (row 3 here, under the summary row and the header row).
  const bad = v.slice(0, 2).concat([['A0030', 'five', '1', 'X', '', '10/2/2026']]);
  assert.throws(() => L.parseOpsLog_(bad, 'amz', m), /amz_log", row 3 \(Quantity\)/);
  // Amazon's SKU names are mapped to ours like the ledger's (Rule 6.3): A80002 is ADS's A80004.
  const renamed = L.parseOpsLog_(v.slice(0, 2).concat([['A80002', 240, '0000173', 'TOL3', '', '10/30/2026'],
    ['A0030 - TEMP SKU', 5, '0000174', 'X', '', '10/30/2026']]), 'amz', m);
  assert.deepEqual(plain(renamed.rows.map((r) => r[2])), ['A80004', 'A0030']);
  // Without a Ship Date column the run stops and says which column is missing.
  assert.throws(() => L.parseOpsLog_(v.map((r) => r.slice(0, 5)), 'amz', m), /missing the column "Ship Date"/);
});
