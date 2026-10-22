// A small, made-up month with hand-computed expected results (see workbook.test.js and e2e.test.js).
'use strict';
const fs = require('fs');
const path = require('path');

function csv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

const ADS_HEADER = ['Stock Number', 'Lot Code', 'Manufacture Date', 'Expiration Date', 'Shelf Life', 'Qty Picked (7 Days)',
  'Qty Picked (30 Days)', 'Qty On Hand', 'Qty On Hand (S1)', 'Qty On Hand (S2)', 'Qty On Hand (S3)', 'Projected Months of Inventory'];
const ads = (sku, qty) => [sku, 'NONE', '', '3000-01-01', '', '', '', String(qty), String(qty), '0', '0', ''];

const LEDGER_HEADER = ['Date', 'FNSKU', 'ASIN', 'MSKU', 'Title', 'Disposition', 'Starting Warehouse Balance',
  'In Transit Between Warehouses', 'Receipts', 'Customer Shipments', 'Customer Returns', 'Vendor Returns',
  'Warehouse Transfer In/Out', 'Found', 'Lost', 'Damaged', 'Disposed', 'Other Events', 'Ending Warehouse Balance',
  'Unknown Events', 'Location', 'Store'];
function led(date, asin, msku, disp, receipts, ending, fc) {
  return [date, asin, asin, msku, 'Title ' + msku, disp, '0', '0', String(receipts), '0', '0', '0', '0', '0', '0', '0', '0', '0',
    String(ending), '0', fc, ''];
}
const mdy = (y, mi, d) => String(mi + 1).padStart(2, '0') + '/' + String(d).padStart(2, '0') + '/' + y;
const lastDay = (y, mi) => new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();

const SHOP_HEADER = ['Name', 'Email', 'Financial Status', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem sku', 'Tags', 'Source'];
const COGS_HEADER = ['Trim', 'Lineitem sku', 'Description', 'Categorization', 'COGS / Unit', 'Freight / Unit', 'Tariffs / Unit', 'Total / Unit'];

/** Raw file contents (arrays) for a month. Same movements every month; dates follow the month. */
function sampleRaw(year, monthIndex) {
  const py = monthIndex === 0 ? year - 1 : year, pm = monthIndex === 0 ? 11 : monthIndex - 1;
  const pLast = lastDay(py, pm), last = lastDay(year, monthIndex);
  const adsStart = [ADS_HEADER, ads('10030', 10), ads('80030', 100), ads('80090', 200), ads('50001', 50), ads('51002', 30),
    ads('20001', 40), ads('A0030', 20)];
  const adsEnd = [ADS_HEADER, ads('10030', 5), ads('80030', 90), ads('80090', 170), ads('50001', 48), ads('51002', 28),
    ads('20001', 35), ads('A0030', 15)];
  const amzStart = [LEDGER_HEADER,
    led(mdy(py, pm, pLast - 1), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 999, 'FC1'), // not the last day: ignored
    led(mdy(py, pm, pLast), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 100, 'FC1'),
    led(mdy(py, pm, pLast), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 20, 'FC2'),
    led(mdy(py, pm, pLast), 'B2', 'A80002', 'SELLABLE', 0, 30, 'FC1')];
  const ledger = [LEDGER_HEADER];
  for (let d = 1; d <= last; d++) {
    ledger.push(led(mdy(year, monthIndex, d), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', d === 10 ? 15 : 0, d === last ? 110 : 900 + d, 'FC1'));
  }
  ledger.push(led(mdy(year, monthIndex, last), 'B1', 'A0030 - TEMP SKU', 'EXPIRED', 0, 5, 'FC2'));
  ledger.push(led(mdy(year, monthIndex, last), 'B2', 'A80002', 'SELLABLE', 0, 25, 'FC1'));
  ledger.push(led(mdy(year, monthIndex, last), 'B3', '50001', 'SELLABLE', 5, 4, 'FC3'));
  const biz = [['(Parent) ASIN', '(Child) ASIN', 'Title', 'Sessions - Total', 'Units Ordered', 'Ordered Product Sales'],
    ['P1', 'B1', 'Thirty', '9,143', '20', '$1,000.00'],
    ['P1', 'B2', 'Sample', '741', '4', '$20.00'],
    ['P3', 'B3', 'Keypod', '12', '1', '$15.00'],
    ['P9', 'B9', 'Parent row', '2', '0', '$0.00'],
    ['P8', 'B8', 'Unknown', '5', '2', '$30.00']];
  const shopify = [SHOP_HEADER,
    ['#1', 'a@x', 'paid', '3', 'Kit', '10', '10030', '', 'web'],
    ['#1', '', '', '2', '180 refill', '10', '80090,80090', '', ''],
    ['#2', 'b@x', 'paid', '1', '30 refill', '0', '80030', 'Replacement - Customer Mistake', 'shopify_draft_order'],
    ['#2', '', '', '1', 'Tin', '0', '51002', '', ''],
    ['#3', 'c@x', 'paid', '1', 'Tin bundle', '0', '80030,51002', 'TikTok-FBM', 'tiktok'],
    ['#4', 'd@x', 'paid', '1', '90 refill', '0', '80090', 'Free sample, TikTok', 'tiktok'],
    ['#5', 'e@x', 'paid', '1', 'Gift card', '25', '', '', 'web']];
  const manual = [['CUSTOMER', 'ORDER', 'SKU', 'QUANTITY', 'DATE'],
    ['MANUAL', '141', '50001', '2', (monthIndex + 1) + '/2/' + year],
    ['AMAZON', '142', 'A0030', '15', (monthIndex + 1) + '/17/' + year]];
  const bomValues = [
    ['BOM', '', '', '', ''],
    ['Parent SKU', 'Parent Desc', 'Child SKU', 'Child Desc', 'Qty'],
    ['10030', 'Starter Kit 30', '10030', 'Starter Kit 30', '1'], // identity row: removed
    ['80030', '30ct Pouch', '80030', '30ct Pouch', '1'],
    ['80090', '90ct Pouch', '80090', '90ct Pouch', '1'],
    ['', '', '', '', ''],
    [10030, 'Starter Kit 30', 70001, 'Custom Pouch 30', 1],
    ['10030', 'Starter Kit 30', '80030', '30ct Pouch', '1'],
    ['10030', 'Starter Kit 30', '20001', 'Glass Jar', '1'],
    ['10030', 'Starter Kit 30', '20001', 'Glass Jar', '1'],     // duplicate: removed
    ['A0030', 'Amazon Kit 30', '80030', '30ct Pouch', '1'],
    ['80090,80090', '180ct Refill', '80090', '90ct Pouch', '2'],
    ['50001', 'Key Pod Black', '50001', 'Key Pod Black', '1'],
    ['X1', 'Has Tin', '51002', 'Bold Travel Tin', '1'],
    ['X2', 'Gold Kit', '70003', 'Lactase', '0.005'],
    ['X3', 'Sample Kit', 'A80004', 'Amazon Sample Kit', '1']];
  const cogs = (sku, a, b, c) => [sku, sku, '', '', a, b, c, Math.round((a + b + c) * 100) / 100];
  const cogsRows = [cogs('10030', 6.76, 0.08, 0.35), cogs('80030', 2.60, 0.01, 0.35), cogs('80090', 5.78, 0.08, 1.04), cogs('51002', 0.45, 0, 0),
    cogs('50001', 2.10, 0, 0), cogs('20001', 0.59, 0.05, 0), cogs('A0030', 2.52, 0, 0.35), cogs('70003', 147, 0, 50.96),
    cogs('80090,80090', 11.56, 0.16, 2.08), cogs('80030,51002', 3.05, 0.01, 0.35)]; // A80004 deliberately missing
  const yyyymm = year + '-' + String(monthIndex + 1).padStart(2, '0');
  const woHtml = fs.readFileSync(path.join(__dirname, 'workorders_sample.html'), 'utf8').replace(/2026-09/g, yyyymm);
  return { adsStart, adsEnd, amzStart, ledger, biz, shopify, manual, bomValues, cogsHeader: COGS_HEADER, cogsRows, woHtml };
}

function sampleInputs(ctx, overrides) {
  const m = ctx.monthInfo_(2026, 8);
  const raw = sampleRaw(2026, 8);
  const t = (rows, label) => ctx.toTable_(ctx.parseCsv_(csv(rows)), label);
  const inputs = {
    month: m,
    todayStr: '2026-10-05',
    builtAt: '2026-10-05 09:00 by test',
    ads: t(raw.adsEnd, 'ADS'),
    adsStart: t(raw.adsStart, 'ADS start'),
    ledger: t(raw.ledger, 'ledger'),
    amzStart: ctx.ledgerLastDateRows_(t(raw.amzStart, 'start ledger'), m.prevEndSerial, 'start ledger'),
    biz: t(raw.biz, 'biz'),
    shopify: t(raw.shopify, 'shopify'),
    manual: t(raw.manual, 'manual'),
    workOrders: ctx.parseWorkOrdersHtml_(raw.woHtml, m),
    bomValues: raw.bomValues,
    cogs: { header: raw.cogsHeader, rows: raw.cogsRows },
    prepaid: null,
    skuMapExisting: [],
    mfgStart: [['VitaQuest', '70003', 100]],
    mfgStartFromPrev: true,
    mfgInv: [['VitaQuest', '70003', 50, 120], ['VitaPros', '70003', 300, 300]],
    adsReceipts: [['PO-1', '50001', 10]],
    sources: { startSources: 'test', shopifySource: 'test', mfgStartSource: 'test' },
    ignoredFiles: []
  };
  return Object.assign(inputs, overrides || {});
}

module.exports = { sampleInputs, sampleRaw, csv, LEDGER_HEADER, ADS_HEADER };
