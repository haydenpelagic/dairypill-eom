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

// ---------------------------------------------------------------- Rule 5.6: Ops Hub shipment logs
test('Rule 5.6: Ops Hub logs — month by Ship Date, loud on bad rows', () => {
  const m = L.monthInfo_(2026, 9);
  const H = ['ADS Order Number', 'Channel', 'SKU', 'Quantity', 'Order Date', 'Ship Date'];
  const p = L.parseOpsLog_([H, ['1', 'Samples', '80030', '3', '10/01/2026', '10/02/2026'], ['2', 'DTC', '10030', 1, '', 46336],
    ['3', 'CX', '10030', 1, '', '']], 'manual', m); // 46336 = 11/10/2026
  assert.deepEqual(JSON.parse(JSON.stringify(p.rows)), [['1', 'Samples', '80030', 3, L.dateSerial_(2026, 9, 1), L.dateSerial_(2026, 9, 2)]]);
  assert.equal(p.otherMonths, 1);
  assert.equal(p.notShipped, 1);
  const bad = (row, re) => assert.throws(() => L.parseOpsLog_([H, row], 'manual', m), re);
  bad(['1', 'Wholesale', '80030', 3, '', '10/02/2026'], /Channel "Wholesale" in Ops Hub "manualorder_log", row 2 is not one of: DTC, Marketing, CX, TikTok, Samples, Amazon/);
  bad(['1', 'DTC', 8003051003, 3, '', '10/02/2026'], /turned into a number/);
  bad(['1', 'DTC', '80030', 'three', '', '10/02/2026'], /Expected a number/);
  bad(['1', 'DTC', '', 3, '', '10/02/2026'], /No SKU/);
  bad(['1', 'DTC', '80030', 3, '', 'next week'], /Expected a date/);
  assert.throws(() => L.parseOpsLog_([['Order', 'SKU']], 'amz', m), /missing the column "ADS Order Number"/);
});

// ---------------------------------------------------------------- Rule 15: posting to Ops Hub
test('Rule 15: formulas are moved like dragging down / right', () => {
  assert.equal(L.shiftFormulaRows_('=if(A120=0,"", eomonth(A120,0))', 1), '=if(A121=0,"", eomonth(A121,0))');
  assert.equal(L.shiftFormulaRows_('=xlookup(C6,sku_matrix!A:A,sku_matrix!B:B,"")', 2), '=xlookup(C8,sku_matrix!A:A,sku_matrix!B:B,"")');
  assert.equal(L.shiftFormulaRows_('=IF(OR(LEFT(A70,1)="1",LEFT(A71,1)="8"),TRUE,FALSE)', 1), '=IF(OR(LEFT(A71,1)="1",LEFT(A72,1)="8"),TRUE,FALSE)');
  assert.equal(L.shiftFormulaRows_('=A$2+$B3+"A1"', 1), '=A$2+$B4+"A1"');
  assert.equal(L.shiftFormulaRows_("='sell thru A1'!B2", 1), "='sell thru A1'!B3");
  assert.equal(L.shiftFormulaCols_('=sum(Y6:Y)', 1), '=sum(Z6:Z)');
  assert.equal(L.shiftFormulaCols_('=sumifs(Y6:Y,$A6:$A,"Amazon")', 1), '=sumifs(Z6:Z,$A6:$A,"Amazon")');
  assert.equal(L.shiftFormulaCols_('=EOMONTH(Z5,1)', 1), '=EOMONTH(AA5,1)');
  assert.equal(L.shiftFormulaCols_('=SUM(D3:D)', 1), '=SUM(E3:E)');
});

test('Rule 15.3/15.5: month column and grouped rows', () => {
  const cfg = { sheetName: 'sell_thru monthly', headerRow: 2, firstMonthCol: 4 };
  const aug = L.dateSerial_(2026, 7, 31);
  const v = [['', '', '', 'Actual'], ['Channel', 'Code', 'SKU', aug],
    ['DTC', 'DTC10030', '10030', 5], ['DTC', 'DTC80030', '80030', 1], ['Marketing', 'M50001', '50001', 2], ['Amazon', 'AA0030', 'A0030', 9]];
  assert.deepEqual(JSON.parse(JSON.stringify(L.planMonthColumn_(v, cfg, L.monthInfo_(2026, 8)))), { col: 5, isNew: true, prevCol: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(L.planMonthColumn_(v, cfg, L.monthInfo_(2026, 7)))), { col: 4, isNew: false });
  assert.throws(() => L.planMonthColumn_(v, cfg, L.monthInfo_(2026, 9)), /next one to post is September 2026, not October 2026/);
  const ins = JSON.parse(JSON.stringify(L.planGroupedRows_(v, cfg, 0, 2, [
    { group: 'DTC', sku: '10030' }, { group: 'DTC', sku: '51002' }, { group: 'Samples', sku: '80030' }, { group: 'DTC', sku: '50003' }])));
  assert.deepEqual(ins, [{ afterRow: 6, items: [{ group: 'Samples', sku: '80030' }] },
    { afterRow: 4, items: [{ group: 'DTC', sku: '50003' }, { group: 'DTC', sku: '51002' }] }]);
  const dup = v.concat([['DTC', 'x', '10030', 0]]);
  assert.throws(() => L.planGroupedRows_(dup, cfg, 0, 2, []), /same row twice: DTC 10030 \(rows 3 and 7\)/);
  const col = L.monthColumnValues_(v, cfg, 0, 2, { 'DTC|10030': 7, 'Amazon|A0030': 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(col)), { firstRow: 3, values: [[7], [0], [0], [4]] });
});

test('Rule 15.2/15.4: wo_log refuses a month already posted; sku_matrix gets only new single SKUs', () => {
  const m = L.monthInfo_(2026, 8);
  const wo = [['Date', 'Quantity', 'SKU', 'Cost', 'Month', 'Channel'], [L.dateSerial_(2026, 7, 24), 200, '10030', 0.54, '', '']];
  const plan = L.planWoLog_(wo, [{ date: L.dateSerial_(2026, 8, 3), qty: 5, sku: '10030', rate: 0.54 }], m);
  assert.equal(plan.afterRow, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.rows)), [{ 1: L.dateSerial_(2026, 8, 3), 2: 5, 3: '10030', 4: 0.54 }]);
  assert.throws(() => L.planWoLog_(wo.concat([[L.dateSerial_(2026, 8, 3), 5, '10030', 0.54]]), [], m), /already has 1 rows dated September 2026/);
  assert.throws(() => L.planWoLog_([['When', 'Qty']], [], m), /expected "Date" in cell A1/);
  const sku = L.planSkuMatrix_([['SKU', 'Description', 'Status'], ['10030', 'Kit', 'ACTIVE'], ['a80004', '', '']],
    ['10030', '80030,51002', 'A80004', '51003', '51003'], { 51003: 'Cream Travel Tin' });
  assert.deepEqual(JSON.parse(JSON.stringify(sku.rows)), [{ 1: '51003', 2: 'Cream Travel Tin', 3: 'NEEDS VERIFICATION' }]);
});
