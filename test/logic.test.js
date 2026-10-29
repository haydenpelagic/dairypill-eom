'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadLogic } = require('./load');

const L = loadLogic();
const plain = (x) => JSON.parse(JSON.stringify(x));

test('CSV: quotes, embedded commas, CRLF, BOM, trailing comma, blank lines', () => {
  const rows = L.parseCsv_('﻿"a","b,c",d\r\n"1","say ""hi""",\r\n\r\nx,y,z');
  assert.deepEqual(plain(rows), [['a', 'b,c', 'd'], ['1', 'say "hi"', ''], ['x', 'y', 'z']]);
});

test('Rule 2: files are recognized by their columns', () => {
  assert.equal(L.identifyText_('Stock Number,Lot Code,Manufacture Date,Qty On Hand\n1,2,3,4'), 'ADS');
  assert.equal(L.identifyText_('"Date","FNSKU","ASIN","MSKU","Title","Disposition","Starting Warehouse Balance","Receipts","Ending Warehouse Balance"'), 'LEDGER');
  assert.equal(L.identifyText_('﻿(Parent) ASIN,(Child) ASIN,Title,Units Ordered'), 'BIZ');
  assert.equal(L.identifyText_('Name,Email,Lineitem quantity,Lineitem sku,Tags'), 'SHOPIFY');
  assert.equal(L.identifyText_('CUSTOMER,ORDER,SKU,QUANTITY,DATE'), 'MANUAL');
  assert.equal(L.identifyText_('<html>Production Detail Worksheet Report</html>'), 'WORK_ORDERS');
  assert.equal(L.identifyText_('foo,bar'), null);
});

test('Rule 3: tab names are dated, ≤ 31 characters, and Excel-safe', () => {
  const m = L.monthInfo_(2026, 8);
  const t = L.tabNames_(m);
  assert.equal(t.adsStart, 'ADS Starting Balance 08.31.2026');
  assert.equal(t.adsEnd, 'ADS Ending Balance 09.30.2026');
  assert.equal(t.ledger, 'AMZ Inventory Ledger 09.30.2026');
  for (const name of Object.values(t)) {
    assert.ok(name.length <= 31, name + ' is too long for Excel');
    assert.ok(!/[\/\\?*\[\]:]/.test(name), name + ' has a character Excel forbids');
  }
  // every month of a leap year and a year boundary
  for (let mi = 0; mi < 12; mi++) for (const n of Object.values(L.tabNames_(L.monthInfo_(2028, mi)))) assert.ok(n.length <= 31);
  const jan = L.monthInfo_(2027, 0);
  assert.equal(jan.prevLabel, 'December 2026');
  assert.equal(jan.prevEndStr, '12.31.2026');
  assert.equal(L.monthInfo_(2028, 1).endStr, '02.29.2028');
});

test('Rule 1.2: default month is last calendar month; override must match the folder name', () => {
  assert.equal(L.resolveMonth_('', new Date(2026, 9, 22)).label, 'September 2026');
  assert.equal(L.resolveMonth_('', new Date(2027, 0, 5)).label, 'December 2026');
  assert.equal(L.resolveMonth_('august 2026', new Date()).label, 'August 2026');
  assert.throws(() => L.resolveMonth_('Sept 2026', new Date()), /must look like/);
});

test('numbers: commas, dollars, percents; loud on garbage', () => {
  assert.equal(L.toNumber_('2,814'), 2814);
  assert.equal(L.toNumber_('$70,033.49'), 70033.49);
  assert.equal(L.toNumber_('30.78%'), 0.3078);
  assert.equal(L.toNumber_('-3'), -3);
  assert.equal(L.toNumber_(''), '');
  assert.throws(() => L.toNumber_('abc', 'in test'), /Expected a number in test/);
});

test('Rule 8.1: bundle SKUs split into components with counts', () => {
  assert.deepEqual(plain(L.splitBundle_('80090,80090')), [{ sku: '80090', count: 2 }]);
  assert.deepEqual(plain(L.splitBundle_(' 80030 , 51002 ')), [{ sku: '80030', count: 1 }, { sku: '51002', count: 1 }]);
  assert.deepEqual(plain(L.splitBundle_('80030,80030,51003')), [{ sku: '80030', count: 2 }, { sku: '51003', count: 1 }]);
  assert.deepEqual(plain(L.splitBundle_('10030')), [{ sku: '10030', count: 1 }]);
});

test('Rule 6.3: Amazon SKU mapping rules and map merge', () => {
  assert.equal(L.mapAmazonSku_('A0030 - TEMP SKU').sku, 'A0030');
  assert.equal(L.mapAmazonSku_('A80002').sku, 'A80004');
  assert.match(L.mapAmazonSku_('A80002').note, /renamed A80002 → A80004/);
  assert.equal(L.mapAmazonSku_('50001').sku, '50001');
  const merged = L.mergeSkuMap_([['50001', 'B3', '50001', 'kept']], [{ msku: '50001', asin: 'B3' }, { msku: 'A80002', asin: 'B2' }], '2026-10-05');
  assert.equal(merged.rows.length, 2);
  assert.equal(merged.added.length, 1);
  assert.deepEqual(plain(merged.rows[0]), ['50001', 'B3', '50001', 'kept']);
  assert.equal(merged.added[0][2], 'A80004');
});

test('Rule 5.5: work-order report parsed; fees dropped; multi-day orders kept; TOTAL enforced', () => {
  const m = L.monthInfo_(2026, 8);
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'workorders_sample.html'), 'utf8');
  const wo = L.parseWorkOrdersHtml_(html, m);
  assert.equal(wo.from, '2026-09');
  assert.equal(wo.lines.length, 3);
  assert.equal(wo.feeLines, 2);
  assert.equal(wo.reportTotal, 72.5);
  assert.deepEqual(plain(wo.lines.map((l) => [l.wo, l.sku, l.pieces])), [['WO_1', '10030', 5], ['WO_2', 'A0030', 4], ['WO_2', 'A0030', 6]]);
  assert.equal(wo.lines[1].description, 'AMAZON KIT & MAILER 150');
  assert.throws(() => L.parseWorkOrdersHtml_(html.replace('$72.50', '$80.00'), m), /add up to \$72.50 but the report TOTAL says \$80.00/);
  assert.throws(() => L.parseWorkOrdersHtml_(html, L.monthInfo_(2026, 9)), /Download the work orders for October 2026/);
  assert.throws(() => L.parseWorkOrdersHtml_(html.replace(/<tr><th colspan=4>TOTAL:[\s\S]*?<\/tr>/, ''), m), /TOTAL/);
});

test('Rule 5.2: ledger must have every day of the month', () => {
  const m = L.monthInfo_(2026, 8);
  const header = ['Date', 'MSKU'];
  const days = (from, to) => { const r = []; for (let d = from; d <= to; d++) r.push(['09/' + String(d).padStart(2, '0') + '/2026', 'X']); return r; };
  assert.doesNotThrow(() => L.checkLedgerCoversMonth_({ header, rows: days(1, 30) }, m));
  assert.throws(() => L.checkLedgerCoversMonth_({ header, rows: days(2, 30) }, m), /missing 1 day\(s\): 09\/01\/2026/);
  assert.throws(() => L.checkLedgerCoversMonth_({ header, rows: days(1, 30).concat([['10/01/2026', 'X']]) }, m), /outside September 2026/);
});

test('Rule 4.2: starting rows are the last day of last month only', () => {
  const t = { header: ['Date', 'MSKU', 'Ending Warehouse Balance'], rows: [['08/30/2026', 'A', '1'], ['08/31/2026', 'A', '2'], ['08/31/2026', 'B', '3']] };
  const out = L.ledgerLastDateRows_(t, L.monthInfo_(2026, 8).prevEndSerial, 'test ledger');
  assert.equal(out.rows.length, 2);
  assert.throws(() => L.ledgerLastDateRows_(t, L.monthInfo_(2026, 9).prevEndSerial, 'test ledger'), /ends on 08\/31\/2026 but the starting balance must come from 09\/30\/2026/);
});

test('Rule 5.4: Shopify lines inherit the order\'s tags; split orders stop the run', () => {
  const t = { header: ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags'], rows: [['#1', '1', 'A', 'Replacement'], ['#1', '1', 'B', ''], ['#2', '1', 'C', '']] };
  const m = L.shopifyModel_('Order Export', t);
  assert.deepEqual(plain(m.values[0]), ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags', 'Order Tags', 'Channel']);
  assert.equal(m.values[1][4], '=""&D2');
  assert.equal(m.values[2][4], '=IF(A3=A2,E2,""&D3)');
  assert.match(m.values[2][5], /^=IF\(ISNUMBER\(SEARCH\("influencer",E3\)\),"Marketing",IF\(ISNUMBER\(SEARCH\("replacement",E3\)\),"CX"/);
  const split = { header: t.header, rows: [['#1', '1', 'A', ''], ['#2', '1', 'B', ''], ['#1', '1', 'C', '']] };
  assert.throws(() => L.shopifyModel_('Order Export', split), /order #1 appears in two separate places/);
});

test('Rule 6.1: BOM import drops parent = child rows and duplicates, keeps descriptions', () => {
  const bom = L.bomFromSource_([
    ['BOM', '', '', '', ''],
    ['Parent SKU', 'Parent Desc', 'Child SKU', 'Child Desc', 'Qty'],
    ['30001', 'Hat', '30001', 'Hat', '1'],
    [10030, 'Kit', 80030, 'Pouch', 1],
    ['10030', 'Kit', '80030', 'Pouch', '1'],
    ['10030', 'Kit', '', '', ''],
    ['', '', '', '', '']]);
  assert.deepEqual(plain(bom.rows), [['10030', 'Kit', '80030', 'Pouch', 1]]);
  assert.equal(bom.identity, 1);
  assert.deepEqual(plain(bom.duplicates), ['10030 → 80030']);
  assert.equal(bom.descs['30001'], 'Hat');
  const d = L.skuDescriptions_(bom.descs, ['80030,80030,30001', '99999,80030']);
  assert.equal(d.desc['80030,80030,30001'], '2 x Pouch + Hat');
  assert.equal(d.desc['99999,80030'], undefined);
});

test('only columns the formulas use must be numbers; other odd values are kept as text', () => {
  const t = { header: ['(Parent) ASIN', '(Child) ASIN', 'Sessions - Total', 'Units Ordered'], rows: [['P', 'B1', '--', '2,822']] };
  const m = L.bizModel_('biz', t, L.tabNames_(L.monthInfo_(2026, 8)));
  assert.equal(m.values[1][2], '--');
  assert.equal(m.values[1][3], 2822);
  const bad = { header: t.header, rows: [['P', 'B1', '5', 'n/a']] };
  assert.throws(() => L.bizModel_('biz', bad, L.tabNames_(L.monthInfo_(2026, 8))), /column "Units Ordered"/);
});

test('Rule 5.7: wo_log — the month is replaced by the report, other months kept, loud on bad input', () => {
  const m = L.monthInfo_(2026, 8);
  const H = ['Date', 'Quantity', 'SKU', 'Description', 'Channel', 'Month', 'Cost'];
  const line = (date, sku, pieces, rate) => ({ wo: 'WO_1', date, sku, pieces, rate });
  const parsed = { lines: [line('2026-09-14', '10180', 50, 0.54), line('2026-09-03', 'A0030', 990, 0.38), line('2026-09-14', '10270', 15, 0.59)] };
  const row = (d, q, s, c) => [d, q, s, '', '', '', c];

  // no September rows yet: inserted before the first later-dated row, oldest first, report order within a day
  let p = L.planWoLog_([H, row('2026-08-24', 200, '10030', 0.54), row(46238, 7, 'A0030', 0.38) /* 2026-08-02 as a date number */, row('10/02/2026', 7, 'A0030', 0.38)], parsed, m);
  assert.equal(p.firstRow, 4);
  assert.deepEqual(plain(p.rows), [['2026-09-03', 990, 'A0030', 0.38], ['2026-09-14', 50, '10180', 0.54], ['2026-09-14', 15, '10270', 0.59], ['2026-10-02', 7, 'A0030', 0.38]]);
  assert.deepEqual([p.removed, p.added, p.monthFirstRow, p.monthLastRow, p.laterRowsMoved], [0, 3, 4, 6, true]);

  // fewer lines than before, at the end of the log: leftover rows are cleared
  p = L.planWoLog_([H, row('2026-08-24', 200, '10030', 0.54), row('2026-09-01', 1, 'X', 1), row('2026-09-02', 1, 'X', 1), row('2026-09-03', 1, 'X', 1), row('2026-09-04', 1, 'X', 1)], parsed, m);
  assert.equal(p.firstRow, 3);
  assert.deepEqual(plain(p.rows.slice(3)), [['', '', '', '']]);
  assert.match(L.woLogSummary_(p, m), /^Updated: rows 3–5 hold the 3 September 2026 kit lines \(replaced 4 September 2026 rows that were there\)\.$/);

  // already matching (numbers typed as text, SKU stored as a number): nothing to write
  p = L.planWoLog_([H, row('2026-09-03', '990', 'A0030', 0.38), row('2026-09-14', 50, 10180, '0.54'), row('2026-09-14', 15, '10270', 0.59)], parsed, m);
  assert.equal(p.changed, false);

  // columns found by header, wherever they are; zero-piece lines skipped
  p = L.planWoLog_([['SKU', 'Cost', 'Date', 'Quantity']], { lines: [line('2026-09-03', '10030', 5, 0.54), line('2026-09-03', '10030', '', 0.54)] }, m);
  assert.deepEqual(plain(p.cols), { date: 2, qty: 3, sku: 0, cost: 1 });
  assert.deepEqual(plain(p.rows), [['2026-09-03', 5, '10030', 0.54]]);

  assert.throws(() => L.planWoLog_([['Date', 'Qty', 'SKU', 'Cost']], parsed, m), /missing the column "Quantity"/);
  assert.throws(() => L.planWoLog_([H, row('', 5, '10030', 0.54)], parsed, m), /row 2 has a Quantity\/SKU\/Cost but no Date/);
  assert.throws(() => L.planWoLog_([H, row('Sept 3', 5, '10030', 0.54)], parsed, m), /row 2 \(Date\) but found "Sept 3"/);
  assert.throws(() => L.planWoLog_([H], { lines: [line('2026-08-31', '10030', 5, 0.54)] }, m), /dated outside September 2026: WO_1 \(2026-08-31\)/);
});
