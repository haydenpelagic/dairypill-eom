'use strict';
// Rule 15: writeOpsHub planning (pure). What gets written to inventory_eom, sell_thru monthly, wo_log and
// sku_matrix, worked out by hand on small made-up tabs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLogic } = require('./load');

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

test('Rule 15.2: new month column after last month; every row filled (0 when none); new Location + SKU added at the bottom', () => {
  const data = [
    { group: 'ADS', sku: '10030', qty: 309 },
    { group: 'ads', sku: '20001', qty: 6000 },     // capitals don't matter
    { group: 'ADS', sku: '20001', qty: 292 },      // repeated pair is added up
    { group: 'Amazon', sku: 'A0180', qty: 595 },   // not on the tab → new row
    { group: 'VitaQuest', sku: '70001', qty: 0 },  // not on the tab but 0 → no row
    { group: 'VitaQuest', sku: '70002', qty: 55000 }
  ];
  const p = L.planMonthColumn_(invTab(), W.inventoryEom, oct, data, { A0180: 'Amz Kit - 180ct Refill' });
  assert.equal(p.col, 6, 'column F, right after Sep 2026 (E)');
  assert.equal(p.isNew, true);
  assert.equal(p.copyFromCol, 5);
  assert.equal(p.headerSerial, OCT);
  assert.equal(p.firstRow, 3);
  // rows 3..7 existing (row 5 blank, kept blank), rows 8..9 new
  assert.deepEqual(plain(p.colValues), [[309], [6292], [''], [0], [0], [595], [55000]]);
  assert.deepEqual(plain(p.newRows.map((r) => [r.row, r.group, r.sku, r.code])), [[8, 'Amazon', 'A0180', 'AmazonA0180'], [9, 'VitaQuest', '70002', 'VitaQuest70002']]);
  assert.equal(p.templateRow, 7);
  assert.deepEqual([p.groupCol, p.skuCol, p.codeCol, p.descCol], [2, 3, 1, null]);
  assert.equal(p.updated, 4);
});

test('Rule 15.2: running again for the same month replaces that column in place (no new column)', () => {
  const tab = invTab();
  tab[1].push(OCT); tab[2].push(1); tab[3].push(2); tab[5].push(3); tab[6].push(4);
  const p = L.planMonthColumn_(tab, W.inventoryEom, oct, [{ group: 'ADS', sku: '10030', qty: 5 }], {});
  assert.equal(p.col, 6);
  assert.equal(p.isNew, false);
  assert.deepEqual(plain(p.colValues), [[5], [0], [''], [0], [0]]);
  assert.equal(p.added, 0);
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

// Outbound Summary, calculated values (current layout with Description, and the older one without)
const outbound = (withDesc) => {
  const pre = withDesc ? ['', '', ''] : ['', ''];
  const h = withDesc ? ['SKU', 'Description', 'Avg Cost / Unit'] : ['SKU', 'Avg Cost / Unit'];
  const groups = ['DTC', 'Marketing', 'CX', 'TikTok', 'Samples', 'Amazon', 'All Channels'];
  const row = (sku, units) => (withDesc ? [sku, 'd', 1] : [sku, 1]).concat(...units.map((u) => [u, u * 2]));
  return [['Outbound Summary — October 2026'], ['note'],
    pre.concat(...groups.map((g) => [g, ''])), h.concat(...groups.map(() => ['Units', 'Total Cost'])),
    row('10030', [5, 1, 0, 0, 0, 0, 6]), row('A0030', [0, 0, 0, 0, 0, 7, 7]), row('TOTAL', [5, 1, 0, 0, 0, 7, 13])];
};

test('Rule 15.3: units by channel are read from Outbound Summary by header (with or without the Description column)', () => {
  for (const withDesc of [true, false]) {
    const got = plain(L.soldByChannelFromOutbound_(outbound(withDesc), 'Outbound Summary'));
    assert.equal(got.length, 12, '2 SKUs × 6 channels; All Channels and TOTAL left out');
    assert.deepEqual(got.filter((d) => d.qty), [{ group: 'DTC', sku: '10030', qty: 5 }, { group: 'Marketing', sku: '10030', qty: 1 }, { group: 'Amazon', sku: 'A0030', qty: 7 }]);
  }
  const bad = outbound(true); bad[4][3] = '#REF!';
  assert.throws(() => L.soldByChannelFromOutbound_(bad, 'Outbound Summary'), /Nothing was written to Ops Hub: Units on "Outbound Summary" is not a number in row 5 \(10030, DTC\) shows "#REF!"/);
  const noSamples = outbound(true).map((r) => r.slice(0, 11).concat(r.slice(13)));
  assert.throws(() => L.soldByChannelFromOutbound_(noSamples, 'Outbound Summary'), /no Units column for: Samples/);
});

test('Rule 15.2: ending inventory = Actual Ending Inventory of every Variance Overview row with a SKU', () => {
  const v = [['Variance Overview — October 2026'], ['x'], [],
    ['Location', 'SKU', 'Description', 'Categorization', 'Beginning Inventory', 'Receiving', 'Sold / Used', 'Expected Ending Inventory', 'Actual Ending Inventory'],
    ['ADS', '10030', 'k', 'Ending Inventory', 0, 1, 1, 0, 309], ['VitaQuest', '70003', 'l', 'Raw', 0, 0, 0, 0, 800], ['', '', '', '', '', '', '', '', '']];
  assert.deepEqual(plain(L.eomInventoryFromVariance_(v, 'VO')), [{ group: 'ADS', sku: '10030', qty: 309 }, { group: 'VitaQuest', sku: '70003', qty: 800 }]);
  v[5][8] = 'NO COST';
  assert.throws(() => L.eomInventoryFromVariance_(v, 'VO'), /row 6 \(VitaQuest 70003\) shows "NO COST"/);
});

const woTab = (rows) => [['Work Order', 'Ticket Number', 'Description (from report)', 'Date', 'SKU', 'Pieces', 'Rate', 'Rate Type', 'Amount']].concat(rows);

test('Rule 15.4: kit lines = Work Orders rows (Date, Pieces, SKU, Rate); a line with no SKU or outside the month stops the run', () => {
  const ok = woTab([['WO1', 't', 'd', '2026-10-07', '10180', 50, 0.54, 'pieces', 27], ['WO2', 't', 'd', '2026-10-05', 'A0030', 0, 0.38, 'pieces', 0]]);
  assert.deepEqual(plain(L.kitLinesFromWorkOrders_(ok, oct, 'WO')), [{ serial: L.dateSerial_(2026, 9, 7), qty: 50, sku: '10180', cost: 0.54, wo: 'WO1' }]);
  assert.throws(() => L.kitLinesFromWorkOrders_(woTab([['WO3', 't', 'AMAZON KIT A-1080', '2026-10-15', '', 540, 0.38, 'pieces', 205.2]]), oct, 'WO'),
    /have no SKU: WO3 \(row 2\), 540 kits\. Type the SKU on the WO SKU Fixes tab, run buildEOM again/);
  assert.throws(() => L.kitLinesFromWorkOrders_(woTab([['WO4', 't', 'd', '2026-09-30', '10030', 5, 0.54, 'pieces', 2.7]]), oct, 'WO'), /dated 09\/30\/2026, outside October 2026/);
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

test('Rule 15.4: wo_log — the month\'s kit lines go after last month\'s, oldest first; running again changes nothing; a new report replaces them', () => {
  const p = L.planWoLog_(woLog(), kits, oct);
  assert.equal(p.changed, true);
  assert.equal(p.firstRow, 4);
  assert.deepEqual(plain(p.rows), [[L.dateSerial_(2026, 9, 5), 200, '10030', 0.54], [L.dateSerial_(2026, 9, 7), 50, '10180', 0.54]]);
  assert.deepEqual(plain(p.cols), { date: 1, qty: 2, sku: 3, cost: 4 }, 'the rate table\'s second "SKU" header is not used');
  const after = applyWo(woLog(), p);
  assert.equal(L.planWoLog_(after, kits, oct).changed, false, 'second run: already up to date');
  const fewer = L.planWoLog_(after, kits.slice(0, 1), oct);
  assert.deepEqual(plain(fewer.rows), [[L.dateSerial_(2026, 9, 7), 50, '10180', 0.54], ['', '', '', '']], 'the October row that is gone is cleared');
  assert.equal(fewer.removed, 2);
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
