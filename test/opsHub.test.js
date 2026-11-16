'use strict';
// Rule 15: "Write month to Ops Hub" (pure parts). The numbers worked out from the month's files, and what gets
// written to inventory_eom, sell_thru monthly, wo_log and sku_matrix — checked by hand on small made-up tabs.
// Also the reading side (Generate EOM Report locks Ops Hub's numbers into the report).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLogic } = require('./load');
const { sampleInputs, sampleHub } = require('./fixtures/sampleMonth');

const L = loadLogic();
const plain = (x) => JSON.parse(JSON.stringify(x));
const oct = L.monthInfo_(2026, 9);
const SEP = oct.prevEndSerial, OCT = oct.endSerial, AUG = L.dateSerial_(2026, 7, 31), NOV = L.dateSerial_(2026, 10, 30);
const W = L.CONFIG.OPS_HUB_WRITE;

// inventory_eom as it is in Ops Hub: totals row, header row 2, Code | Location | SKU | months
const invTab = () => [
  ['', '', 'Total Units - ADS', 100, 90],
  ['Code', 'Location', 'SKU', AUG, SEP],
  ['ADS10030', 'ADS', '10030', 39, 0],
  ['ADS20001', 'ADS', 20001, 2579, 17],      // SKU stored as a number still matches "20001"
  ['', '', '', '', ''],                        // a blank row in the middle is left alone
  ['AmazonA0030', 'Amazon', 'A0030', 2117, 3001],
  ['VitaPros70003', 'VitaPros', '70003', 0, 300]
];

test('Rule 15.2: new month column after last month; ADS + Amazon rows filled (0 when none); manufacturer rows left blank; new Location + SKU added at the bottom', () => {
  const data = [
    { group: 'ADS', sku: '10030', qty: 309 },
    { group: 'ads', sku: '20001', qty: 6000 },     // capitals don't matter
    { group: 'ADS', sku: '20001', qty: 292 },      // repeated pair is added up
    { group: 'Amazon', sku: 'A0180', qty: 595 },   // not on the tab → new row
    { group: 'Amazon', sku: 'A0090', qty: 0 }      // not on the tab but 0 → no row
  ];
  const p = L.planMonthColumn_(invTab(), W.inventoryEom, oct, data, { A0180: 'Amz Kit - 180ct Refill' });
  assert.equal(p.col, 6, 'column F, right after Sep 2026 (E)');
  assert.equal(p.isNew, true);
  assert.equal(p.copyFromCol, 5);
  assert.equal(p.headerSerial, OCT);
  assert.equal(p.firstRow, 3);
  // rows 3..7 existing (row 5 blank; row 7 VitaPros = typed by hand → blank, not September's 300), row 8 new
  assert.deepEqual(plain(p.colValues), [[309], [6292], [''], [0], [''], [595]]);
  assert.deepEqual(plain(p.newRows.map((r) => [r.row, r.group, r.sku, r.code])), [[8, 'Amazon', 'A0180', 'AmazonA0180']]);
  assert.equal(p.templateRow, 7);
  assert.deepEqual([p.groupCol, p.skuCol, p.codeCol, p.descCol], [2, 3, 1, null]);
  assert.equal(p.updated, 3);
  assert.deepEqual(plain(p.handRows), [{ group: 'VitaPros', sku: '70003', blank: true }]);
  assert.throws(() => L.planMonthColumn_(invTab(), W.inventoryEom, oct, [{ group: 'VitaQuest', sku: '70001', qty: 1 }], {}),
    /only writes ADS and Amazon rows, not "VitaQuest"/);
});

test('Rule 15.2: running again for the same month replaces the ADS / Amazon cells in place; manufacturer cells typed by hand are not touched', () => {
  const tab = invTab();
  tab[1].push(OCT); tab[2].push(1); tab[3].push(2); tab[5].push(3); tab[6].push(812); // VitaPros Oct typed by hand: 812
  const p = L.planMonthColumn_(tab, W.inventoryEom, oct, [{ group: 'ADS', sku: '10030', qty: 5 }], {});
  assert.equal(p.col, 6);
  assert.equal(p.isNew, false);
  assert.deepEqual(plain(p.colValues), [[5], [0], [null], [0], [null]], 'null = leave the cell alone (blank row, VitaPros)');
  assert.equal(p.added, 0);
  assert.deepEqual(plain(p.handRows), [{ group: 'VitaPros', sku: '70003', blank: false }]);
  const lines = L.opsHubSummary_({ month: oct, inventoryEom: p, sellThru: Object.assign({}, p, { handRows: [] }), woLog: { added: 0, kept: 0, changed: false }, skuMatrix: { rows: [] } });
  assert.match(lines[1], /Manufacturer rows are typed by hand and were not touched \(1\)\. All have a Oct 2026 count\./);
  tab[6][5] = '';
  const blank = L.planMonthColumn_(tab, W.inventoryEom, oct, [], {});
  const lines2 = L.opsHubSummary_({ month: oct, inventoryEom: blank, sellThru: Object.assign({}, blank, { handRows: [] }), woLog: { added: 0, kept: 0, changed: false }, skuMatrix: { rows: [] } });
  assert.match(lines2[1], /Still blank for Oct 2026: VitaPros 70003 — type each count in column F before Generate EOM Report/);
});

test('Rule 15.2: months stay in order — a missing last month, a later month, or a busy next column stops the run', () => {
  const noSep = invTab().map((r) => r.slice(0, 4));
  assert.throws(() => L.planMonthColumn_(noSep, W.inventoryEom, oct, [], {}), /no Oct 2026 column, and its last month column is Aug 2026, not Sep 2026/);
  const withNov = invTab(); withNov[1].push(NOV);
  assert.throws(() => L.planMonthColumn_(withNov, W.inventoryEom, oct, [], {}), /last month column is Nov 2026/);
  const busy = invTab(); busy[3][5] = 'note';
  assert.throws(() => L.planMonthColumn_(busy, W.inventoryEom, oct, [], {}), /column F\) is where Oct 2026 goes, but it is not empty \(row 4\)/);
  const dup = invTab(); dup.push(['x', 'ADS', 10030, 1, 1]);
  assert.throws(() => L.planMonthColumn_(dup, W.inventoryEom, oct, [], {}), /same Location \+ SKU twice: ADS 10030 \(rows 3 and 8\)/);
  const half = invTab(); half.push(['', 'ADS', '', 1, 1]);
  assert.throws(() => L.planMonthColumn_(half, W.inventoryEom, oct, [], {}), /row 8 has a Location but no SKU/);
});

// sell_thru monthly as it is in Ops Hub: header row 5, Channel | Code | SKU | Description | months
const sellTab = () => [
  ['Last Updated:'], ['', '', '', '', 'Actual', 'Actual'], ['', '', '', 'Total Units Sold', 10, 20], ['', '', '', 'Total Units Sold - Amazon', 0, 5],
  ['Channel', 'Code', 'SKU', 'Description', AUG, SEP],
  ['DTC', 'DTC10030', '10030', 'Starter Kit', 9, 15],
  ['Amazon', 'AmazonA50001', 'A50001', '', 1, 5]
];

test('Rule 15.3: sell_thru — Channel + SKU rows filled from Outbound; new pairs only when units ≠ 0', () => {
  const data = [
    { group: 'DTC', sku: '10030', qty: 1113 }, { group: 'Samples', sku: '10030', qty: 0 },
    { group: 'Amazon', sku: '50001', qty: 72 }, { group: 'Marketing', sku: '80030,51002', qty: 52 }
  ];
  const p = L.planMonthColumn_(sellTab(), W.sellThru, oct, data, { '50001': 'Key Pod "Black"' });
  assert.equal(p.col, 7);
  assert.deepEqual(plain(p.colValues), [[1113], [0], [72], [52]], 'AmazonA50001 is a different SKU from 50001, so it gets 0');
  assert.deepEqual(plain(p.newRows.map((r) => [r.row, r.group, r.sku, r.code, r.desc])),
    [[8, 'Amazon', '50001', 'Amazon50001', 'Key Pod "Black"'], [9, 'Marketing', '80030,51002', 'Marketing80030,51002', '']]);
  assert.deepEqual([p.codeCol, p.descCol, p.templateRow], [2, 4, 7]);
});

test('Rule 15: the numbers written to Ops Hub, worked out from the sample month\'s files, are exactly the hand-worked ones', () => {
  const x = sampleInputs(L), m = x.month, hub = sampleHub(2026, 8);
  const sum = (list) => { const o = {}; list.forEach((d) => { const k = d.group + '|' + d.sku; o[k] = Math.round(((o[k] || 0) + d.qty) * 1e6) / 1e6; }); return o; };
  // inventory_eom: ADS and Amazon rows (manufacturer rows are typed by hand)
  const inv = sum(L.adsOnHand_(x.ads).concat(L.amazonOnHand_(x.ledger)));
  const want = {};
  hub.inventory.filter((r) => r.group === 'ADS' || r.group === 'Amazon').forEach((r) => { if (r.end) want[r.group + '|' + r.sku] = r.end; });
  assert.deepEqual(inv, want);
  // sell_thru monthly: counted Shopify lines by channel + manualorder_log + Amazon ledger shipments
  const sold = sum(L.soldByChannel_(x.shopify, x.manualLog, x.ledger));
  assert.deepEqual(sold, sum(hub.sellThru));
  // wo_log: kit lines with date, pieces, SKU, rate
  const bom = L.bomFromSource_(x.bomValues);
  const kits = L.kitLines_(L.resolveWorkOrderSkus_(x.workOrders.lines, bom.rows).lines, m);
  assert.deepEqual(plain(kits.map((k) => [k.serial, k.qty, k.sku, k.cost])), plain(hub.woLog.map((k) => [k.serial, k.qty, k.sku, k.cost])));
  // and the plan puts them in the right places
  const plan = L.planOpsHubWrite_({ inventory: L.adsOnHand_(x.ads).concat(L.amazonOnHand_(x.ledger)), sellThru: L.soldByChannel_(x.shopify, x.manualLog, x.ledger), kits, bomDescs: bom.descs },
    { inventoryEom: [[''], ['Code', 'Location', 'SKU', m.prevEndSerial], ['ADS10030', 'ADS', '10030', 10]],
      sellThru: [[], [], [], [], ['Channel', 'Code', 'SKU', 'Description', m.prevEndSerial]],
      woLog: [['Date', 'Quantity', 'SKU', 'Cost']], skuMatrix: [['SKU', 'Description', 'Status']] }, m);
  assert.equal(plan.inventoryEom.colValues[0][0], 5, 'ADS 10030 = 5');
  // a kit line ADS wrote as words goes into wo_log as written, but never onto sku_matrix as a "SKU"
  const plan2 = L.planOpsHubWrite_({ inventory: [], sellThru: [], kits: [{ serial: m.endSerial, qty: 9, sku: 'NO GASSY DAYS STARTER KIT 30', cost: 0.5, certain: false }], bomDescs: {} },
    { inventoryEom: [[''], ['Code', 'Location', 'SKU', m.prevEndSerial]], sellThru: [[], [], [], [], ['Channel', 'Code', 'SKU', 'Description', m.prevEndSerial]],
      woLog: [['Date', 'Quantity', 'SKU', 'Cost']], skuMatrix: [['SKU', 'Description', 'Status']] }, m);
  assert.deepEqual(plain(plan2.woLog.rows), [[m.endSerial, 9, 'NO GASSY DAYS STARTER KIT 30', 0.5]]);
  assert.deepEqual(plain(plan2.skuMatrix.rows), []);
  assert.deepEqual(plain(plan.skuMatrix.rows.find((r) => r[0] === '80090,80090')), ['80090,80090', '180ct Refill', 'NEEDS VERIFICATION']);
});

test('Rule 15.4: kit lines (a line written as ADS reported it is kept, marked not certain); no Rate, Pieces that aren\'t a number, or a date outside the month stops the run', () => {
  const l = (o) => Object.assign({ wo: 'WO1', date: '2026-10-07', sku: '10180', pieces: 50, rate: 0.54 }, o);
  assert.deepEqual(plain(L.kitLines_([l({}), l({ pieces: 0, sku: '' })], oct)), [{ serial: L.dateSerial_(2026, 9, 7), qty: 50, sku: '10180', cost: 0.54, wo: 'WO1', certain: true }]);
  assert.deepEqual(plain(L.kitLines_([l({ sku: 'KIT 30', certain: false })], oct).map((k) => [k.sku, k.certain])), [['KIT 30', false]]);
  assert.throws(() => L.kitLines_([l({ sku: '' })], oct), /no SKU or text at all: WO1 \(2026-10-07\), 50 kits/);
  assert.throws(() => L.kitLines_([l({ date: '2026-09-30' })], oct), /dated 09\/30\/2026, outside October 2026/);
  assert.throws(() => L.kitLines_([l({ rate: '' })], oct), /Rate "" is not a number/);
  assert.throws(() => L.kitLines_([l({ pieces: '' })], oct), /Pieces "" is not a number/);
});

test('Generate EOM Report: reads this month and last month out of Ops Hub; blank stays blank; stops if the month was not written yet', () => {
  const got = L.readHubMonth_({ inventoryEom: invTab().map((r, i) => (i === 1 ? r.concat([OCT]) : i < 2 ? r : r.concat([i === 6 ? '' : i * 10]))),
    sellThru: sellTab().map((r, i) => (i === 4 ? r.concat([OCT]) : i < 4 ? r : r.concat([i === 5 ? 7 : 0]))), woLog: woLog() }, oct);
  assert.deepEqual(plain(got.inventory), [
    { group: 'ADS', sku: '10030', begin: 0, end: 20 }, { group: 'ADS', sku: '20001', begin: 17, end: 30 },
    { group: 'Amazon', sku: 'A0030', begin: 3001, end: 50 }, { group: 'VitaPros', sku: '70003', begin: 300, end: '' }]);
  assert.deepEqual(plain(got.sellThru), [{ group: 'DTC', sku: '10030', qty: 7 }], 'rows with 0 units are left out');
  assert.deepEqual(plain(got.woLog), [], 'no wo_log rows dated in October');
  assert.throws(() => L.readHubMonth_({ inventoryEom: invTab(), sellThru: sellTab(), woLog: woLog() }, oct),
    /Ops Hub tab "inventory_eom" has no Oct 2026 column yet\. Run EOM → 1\. Write month to Ops Hub for October 2026 first/);
  const noSep = invTab().map((r) => r.slice(0, 4).concat(r.length > 4 ? [r[4]] : []));
  noSep[1][4] = OCT;
  assert.throws(() => L.readHubMonth_({ inventoryEom: noSep, sellThru: sellTab(), woLog: woLog() }, oct), /has no Sep 2026 column\. Last month's counts are this month's Beginning/);
  const text = invTab().map((r, i) => (i === 1 ? r.concat([OCT]) : i < 2 ? r : r.concat([i === 3 ? 'n/a' : 1])));
  assert.throws(() => L.readHubMonth_({ inventoryEom: text, sellThru: sellTab().map((r, i) => (i === 4 ? r.concat([OCT]) : r)), woLog: woLog() }, oct),
    /Nothing was generated: Ops Hub tab "inventory_eom" has text where a number belongs: row 4 \(ADS 20001, Oct 2026\) shows "n\/a"/);
  const sep = L.woLogMonthRows_(woLog(), L.monthInfo_(2026, 8));
  assert.deepEqual(plain(sep), [{ serial: L.dateSerial_(2026, 8, 3), qty: 200, sku: '10030', cost: 0.54 }, { serial: L.dateSerial_(2026, 8, 24), qty: 22, sku: '10180', cost: 0.54 }]);
});

test('Rule 12.14: Ops Hub vs the raw reports — differences by Group + SKU (repeats added up), nothing when they agree', () => {
  const hub = [{ group: 'ADS', sku: '1', qty: 5 }, { group: 'ADS', sku: '2', qty: 3 }];
  const raw = [{ group: 'ads', sku: '1', qty: 2 }, { group: 'ADS', sku: '1', qty: 3 }, { group: 'ADS', sku: '3', qty: 1 }];
  assert.deepEqual(plain(L.tieOutDiffs_(hub, raw, 'Ops Hub', 'file').map((d) => d.text)), ['ADS 2: Ops Hub 3, file 0', 'ADS 3: Ops Hub 0, file 1']);
  assert.deepEqual(plain(L.tieOutDiffs_(hub, hub, 'Ops Hub', 'file')), []);
});

const woLog = () => [
  ['Date', 'Quantity', 'SKU', 'Cost', 'Month', 'Channel', '', 'SKU', 'Nov 2025'],
  [L.dateSerial_(2026, 8, 3), 200, '10030', 0.54, 'f', 'f', '', 'Base Fee', 32],
  [L.dateSerial_(2026, 8, 24), 22, '10180', 0.54, 'f', 'f', '', 'A0090', '-'],
  ['', '', '', '', '', '', '', '', '']
];
const kits = [{ serial: L.dateSerial_(2026, 9, 7), qty: 50, sku: '10180', cost: 0.54 }, { serial: L.dateSerial_(2026, 9, 5), qty: 200, sku: '10030', cost: 0.54 }];

/** What wo_log looks like after a plan is applied (Date, Quantity, SKU, Cost only). */
function applyWo(values, p) {
  const out = values.map((r) => r.slice());
  p.rows.forEach((row, i) => {
    const r = p.firstRow - 1 + i;
    while (out.length <= r) out.push(['', '', '', '', '', '', '', '', '']);
    ['date', 'qty', 'sku', 'cost'].forEach((k, j) => { out[r][p.cols[k] - 1] = row[j]; });
  });
  return out;
}

test('Rule 15.4: wo_log — the month\'s kit lines go after last month\'s, oldest first; once the month is there it is never rewritten (fixed by hand)', () => {
  const p = L.planWoLog_(woLog(), kits, oct);
  assert.equal(p.changed, true);
  assert.equal(p.firstRow, 4);
  assert.deepEqual(plain(p.rows), [[L.dateSerial_(2026, 9, 5), 200, '10030', 0.54], [L.dateSerial_(2026, 9, 7), 50, '10180', 0.54]]);
  assert.deepEqual(plain(p.cols), { date: 1, qty: 2, sku: 3, cost: 4 }, 'the rate table\'s second "SKU" header is not used');
  const after = applyWo(woLog(), p);
  after[3][2] = '10031'; // someone fixes a SKU in wo_log
  const again = L.planWoLog_(after, kits.slice(0, 1), oct);
  assert.deepEqual([again.changed, again.kept, again.monthFirstRow, again.monthLastRow, again.rows.length], [false, 2, 4, 5, 0], 'left alone, even with a different report');
  assert.match(L.opsHubSummary_({ month: oct, woLog: again, skuMatrix: { rows: [] },
    inventoryEom: { col: 6, isNew: false, updated: 0, added: 0, newRows: [], handRows: [] }, sellThru: { col: 7, isNew: false, updated: 0, added: 0, newRows: [], handRows: [] } })[2],
  /^wo_log: the 2 October 2026 row\(s\) already there \(rows 4–5\) were left as they are — to rewrite them from the work-order report, delete them and run again\.$/);
  const missingDate = woLog(); missingDate[2][0] = '';
  assert.throws(() => L.planWoLog_(missingDate, kits, oct), /row 3 has a Quantity\/SKU\/Cost but no Date/);
});

test('Rule 15.4: wo_log — a month written late goes before the later months already there', () => {
  const later = woLog(); later[3] = [L.dateSerial_(2026, 10, 2), 9, 'A0030', 0.38, '', '', '', '', ''];
  const p = L.planWoLog_(later, kits, oct);
  assert.equal(p.firstRow, 4);
  assert.deepEqual(plain(p.rows.map((r) => r[2])), ['10030', '10180', 'A0030'], 'November row moves down');
});

test('Rule 15.5: SKUs not on sku_matrix are added after its last SKU with Status NEEDS VERIFICATION', () => {
  const sm = [['SKU', 'Description', 'Status'], [10030, 'Starter Kit', 'ACTIVE'], ['80090,80090', '180ct', 'ACTIVE'], ['', '', '']];
  const p = L.planSkuMatrix_(sm, ['10030', '80090,80090', 'A0180', '80030,51002'], { A0180: 'Amz Kit - 180ct Refill' });
  assert.equal(p.startRow, 4);
  assert.deepEqual(plain(p.rows), [['A0180', 'Amz Kit - 180ct Refill', 'NEEDS VERIFICATION'], ['80030,51002', '', 'NEEDS VERIFICATION']]);
});
