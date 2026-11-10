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

test('Rule 4.2a: tie-out rows are the last day of last month only', () => {
  const t = { header: ['Date', 'MSKU', 'Ending Warehouse Balance'], rows: [['08/30/2026', 'A', '1'], ['08/31/2026', 'A', '2'], ['08/31/2026', 'B', '3']] };
  const out = L.ledgerLastDateRows_(t, L.monthInfo_(2026, 8).prevEndSerial, 'test ledger');
  assert.equal(out.rows.length, 2);
  assert.throws(() => L.ledgerLastDateRows_(t, L.monthInfo_(2026, 9).prevEndSerial, 'test ledger'), /ends on 08\/31\/2026 but it should end on 09\/30\/2026/);
});

test('Rule 5.4: Shopify lines inherit the order\'s tags; split orders stop the run', () => {
  const H = ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags', 'Financial Status', 'Cancelled at', 'Lineitem fulfillment status'];
  const t = { header: H, rows: [['#1', '1', 'A', 'Replacement', 'paid', '', 'fulfilled'], ['#1', '1', 'B', '', '', '', 'fulfilled'], ['#2', '1', 'C', '', 'paid', '', 'fulfilled']] };
  const m = L.shopifyModel_('Order Export', t);
  assert.deepEqual(plain(m.values[0]), H.concat(['Order Tags', 'Channel', 'Order Financial Status', 'Order Cancelled At', 'Counted', 'Counted Qty']));
  assert.equal(m.values[1][7], '=""&D2');
  assert.equal(m.values[2][7], '=IF(A3=A2,H2,""&D3)');
  assert.match(m.values[2][8], /^=IF\(ISNUMBER\(SEARCH\("influencer",H3\)\),"Marketing",IF\(ISNUMBER\(SEARCH\("replacement",H3\)\),"CX"/);
  const split = { header: H, rows: [['#1', '1', 'A', '', '', '', ''], ['#2', '1', 'B', '', '', '', ''], ['#1', '1', 'C', '', '', '', '']] };
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

test('Rule 5.5a: work-order lines whose Job is blank or words get a SKU only when it is certain', () => {
  const bom = [['10030', 'x', '80030', 'x', 1], ['10270', 'x', '80090', 'x', 3], ['A0030', 'x', '80030', 'x', 1], ['A0180', 'x', '80090', 'x', 2]];
  const line = (wo, job, description, pieces) => ({ wo, ticket: '1', description, date: '2026-10-01', sku: job, pieces, rate: 0.5, rateType: 'pieces', amount: 1 });
  const lines = [
    line('WO_1', '10030', 'NO GASSY DAYS STARTER KIT 30', 200),                    // Job is a SKU → used as is
    line('WO_2', 'AMAZON KIT A0030', 'AMAZON KIT A0030', 1040),                    // SKU word inside Job
    line('WO_3', 'NO GASSY DAYS STARTER KIT 10270', 'NO GASSY DAYS STARTER KIT 10270', 100),
    line('WO_4', '', 'NO GASSY DAYS STARTER KIT 10270', 150),                      // Job blank → same text as WO_3 (now on the fixes list)
    line('WO_5', '', 'NO GASSY DAYS STARTER KIT 90', 200),                         // no SKU anywhere → not counted
    line('WO_6', '', 'AMAZON KIT A-1080', 540),                                   // typo, not a SKU → not counted
    line('WO_7', '', 'no gassy days starter kit 30 ', 152)                         // on the fixes tab (any case/spacing)
  ];
  const fixes = [['NO GASSY DAYS STARTER KIT 30', '10030', 'typed by hand'], ['Old line', '', '']];
  const r = L.resolveWorkOrderSkus_(lines, bom, fixes, '2026-11-10');
  assert.deepEqual(plain(r.lines.map((l) => l.sku)), ['10030', 'A0030', '10270', '10270', '', '', '10030']);
  assert.deepEqual(plain(r.lines.map((l) => l.how.split(' (')[0])), ['Job', 'found A0030 in Job', 'found 10270 in Job', 'WO SKU Fixes tab',
    'NOT COUNTED — no SKU', 'NOT COUNTED — no SKU', 'WO SKU Fixes tab']);
  assert.deepEqual(plain(r.unresolved.map((l) => l.wo)), ['WO_5', 'WO_6']);
  assert.deepEqual(plain(r.corrected.map((l) => l.wo)), ['WO_2', 'WO_3', 'WO_4', 'WO_7']);
  // The fixes tab keeps hand-typed rows and lists every new text: found SKUs filled in, unknown ones blank to type.
  assert.deepEqual(plain(r.fixRows.map((x) => [x[0], x[1]])), [
    ['NO GASSY DAYS STARTER KIT 30', '10030'], ['Old line', ''], ['AMAZON KIT A0030', 'A0030'],
    ['NO GASSY DAYS STARTER KIT 10270', '10270'], ['NO GASSY DAYS STARTER KIT 90', ''], ['AMAZON KIT A-1080', '']]);
  // Next month, a SKU typed on the tab is used (and beats the automatic find).
  const next = L.resolveWorkOrderSkus_([line('WO_8', '', 'AMAZON KIT A-1080', 10), line('WO_9', 'AMAZON KIT A0030', '', 5)], bom,
    r.fixRows.map((x) => (x[0] === 'AMAZON KIT A-1080' ? [x[0], 'A0180', ''] : x[0] === 'AMAZON KIT A0030' ? [x[0], 'A0090', ''] : x)), '2026-12-01');
  assert.deepEqual(plain(next.lines.map((l) => l.sku)), ['A0180', 'A0090']);
  assert.equal(next.unresolved.length, 0);
  // Two different kit SKUs in the text = ambiguous → not counted.
  const amb = L.resolveWorkOrderSkus_([line('WO_10', '', 'KIT 10030 OR 10270', 5)], bom, [], 'd');
  assert.equal(amb.lines[0].sku, '');
  assert.match(amb.fixRows[0][2], /more than one kit SKU in the text: 10030, 10270/);
});
