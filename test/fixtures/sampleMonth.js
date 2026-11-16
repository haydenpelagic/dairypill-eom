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
// x = optional { ship, transfer, inTransit, lost } (Customer Shipments are negative, as in Amazon's file)
function led(date, asin, msku, disp, receipts, ending, fc, starting, x) {
  x = x || {};
  return [date, asin, asin, msku, 'Title ' + msku, disp, String(starting || 0), String(x.inTransit || 0), String(receipts), String(x.ship || 0),
    '0', '0', String(x.transfer || 0), '0', String(x.lost || 0), '0', '0', '0', String(ending), '0', fc, ''];
}
const mdy = (y, mi, d) => String(mi + 1).padStart(2, '0') + '/' + String(d).padStart(2, '0') + '/' + y;
const lastDay = (y, mi) => new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();

const SHOP_HEADER = ['Name', 'Email', 'Financial Status', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem sku', 'Tags', 'Source',
  'Cancelled at', 'Lineitem fulfillment status'];
const F = ['', 'fulfilled']; // not cancelled, shipped
const COGS_HEADER = ['SKU', 'Description', 'Base Cost', 'Freight In', 'Tariff', 'Total / Unit'];

/** Raw file contents (arrays) for a month. Same movements every month; dates follow the month. */
function sampleRaw(year, monthIndex) {
  const py = monthIndex === 0 ? year - 1 : year, pm = monthIndex === 0 ? 11 : monthIndex - 1;
  const pLast = lastDay(py, pm), last = lastDay(year, monthIndex);
  const adsStart = [ADS_HEADER, ads('10030', 10), ads('80030', 100), ads('80090', 200), ads('50001', 50), ads('51002', 30),
    ads('20001', 40), ads('A0030', 20), ads('41001', 20)];
  const adsEnd = [ADS_HEADER, ads('10030', 5), ads('80030', 90), ads('80090', 170), ads('50001', 48), ads('51002', 28),
    ads('20001', 35), ads('A0030', 15), ads('41001', 16)];
  const amzStart = [LEDGER_HEADER,
    led(mdy(py, pm, pLast - 1), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 999, 'FC1'), // not the last day: ignored
    led(mdy(py, pm, pLast), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 100, 'FC1'),
    led(mdy(py, pm, pLast), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 20, 'FC2'),
    led(mdy(py, pm, pLast), 'B2', 'A80002', 'SELLABLE', 0, 30, 'FC1')];
  const ledger = [LEDGER_HEADER];
  for (let d = 1; d <= last; d++) {
    // A0030 @ FC1: +15 received on the 10th, 20 shipped on the 15th, 3 sent to another Amazon warehouse on the 20th
    // and still travelling at month end (In Transit 3). Ending 107 + 5 expired + 3 in transit = 115 (Rule 9.3).
    ledger.push(led(mdy(year, monthIndex, d), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', d === 10 ? 15 : 0, d === last ? 107 : 900 + d, 'FC1', d === 1 ? 100 : 0,
      { ship: d === 15 ? -20 : 0, transfer: d === 20 ? -3 : 0, inTransit: d >= 20 ? 3 : 0 }));
  }
  // Rule 4.2: Amazon Beginning = Starting Warehouse Balance on the 1st (A0030 100 + 20 = 120, A80002 30) — ties to amzStart above.
  ledger.push(led(mdy(year, monthIndex, 1), 'B1', 'A0030 - TEMP SKU', 'SELLABLE', 0, 0, 'FC2', 20));
  ledger.push(led(mdy(year, monthIndex, 1), 'B2', 'A80002', 'SELLABLE', 0, 30, 'FC1', 30));
  ledger.push(led(mdy(year, monthIndex, last), 'B1', 'A0030 - TEMP SKU', 'EXPIRED', 0, 5, 'FC2'));
  ledger.push(led(mdy(year, monthIndex, last), 'B2', 'A80002', 'SELLABLE', 0, 25, 'FC1', 0, { ship: -4, lost: -1 }));
  ledger.push(led(mdy(year, monthIndex, last), 'B3', '50001', 'SELLABLE', 5, 4, 'FC3', 0, { ship: -1 }));
  const biz = [['(Parent) ASIN', '(Child) ASIN', 'Title', 'Sessions - Total', 'Units Ordered', 'Ordered Product Sales'],
    ['P1', 'B1', 'Thirty', '9,143', '20', '$1,000.00'],
    ['P1', 'B2', 'Sample', '741', '4', '$20.00'],
    ['P3', 'B3', 'Keypod', '12', '1', '$15.00'],
    ['P9', 'B9', 'Parent row', '2', '0', '$0.00'],
    ['P8', 'B8', 'Unknown', '5', '2', '$30.00']];
  const shopify = [SHOP_HEADER,
    ['#1', 'a@x', 'paid', '3', 'Kit', '10', '10030', '', 'web'].concat(F),
    ['#1', '', '', '2', '180 refill', '10', '80090,80090', '', ''].concat(F),
    ['#2', 'b@x', 'paid', '1', '30 refill', '0', '80030', 'Replacement - Customer Mistake', 'shopify_draft_order'].concat(F),
    ['#2', '', '', '1', 'Tin', '0', '51002', '', ''].concat(F),
    ['#3', 'c@x', 'paid', '1', 'Tin bundle', '0', '80030,51002', 'TikTok-FBM', 'tiktok'].concat(F),
    ['#4', 'd@x', 'paid', '1', '90 refill', '0', '80090', 'Free sample, TikTok', 'tiktok'].concat(F),
    ['#5', 'e@x', 'paid', '1', 'Gift card', '25', '', '', 'web'].concat(F),
    // Rule 5.4a: not counted — cancelled; refunded and never shipped (2nd line inherits the order's status)
    ['#6', 'f@x', 'paid', '5', '90 refill', '10', '80090', '', 'web', '2026-01-01 10:00:00 -0500', 'unfulfilled'],
    ['#7', 'g@x', 'refunded', '2', '90 refill', '10', '80090', '', 'web', '', 'unfulfilled'],
    ['#7', '', '', '4', 'Tin', '0', '51002', '', '', '', '']];
  // Rule 5.6: Ops Hub shipment logs (header + rows). Month = Ship Date; other-month rows are dated 2020 so
  // logs for several months can be stacked into one Ops Hub without overlapping.
  const day = (d) => (monthIndex + 1) + '/' + d + '/' + year;
  const manualLog = [['ADS Order Number', 'Channel', 'SKU', 'Quantity', 'Order Date', 'Ship Date'],
    ['141', 'Marketing', '50001', '2', '', day(2)],
    ['144', 'samples', '50001', '1', '2026-10-01T10:00:00+00:00', day(5)],   // channel matched without caring about capitals
    ['140', 'Marketing', '50001', '99', '', '1/15/2020'],                     // shipped in another month: ignored
    ['145', 'CX', '50001', '7', '', '']];                                     // no Ship Date = not shipped: not counted
  // amz_log as laid out in the Ops Hub since 2026-11: a summary row on top, headers in row 2 (with line breaks),
  // SKU first, Ship Date in F (Rule 5.6). Columns are found by name.
  const amzLog = [['', '', '', '', '', ''],
    ['SKU', 'Quantity', 'ADS Order \nNumber', 'Amazon Store \nNumber', 'Order Date\nDate Labels are Received', 'Ship Date'],
    ['A0030', '15', '142', 'FBA15X', '', day(17)],
    ['A0030', '50', '143', 'FBA16Y', '', '2/1/2020']];                        // another month: ignored
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
    ['X3', 'Sample Kit', 'A80004', 'Amazon Sample Kit', '1'],
    // Rule 8.1b: like the Ops Hub, a pouch sold on its own lists its mailer; a kit's mailer is inside the kit (X4).
    ['80030', '30ct Pouch', '41001', 'Mailer', '1'],
    ['80090', '90ct Pouch', '41001', 'Mailer', '1'],
    ['80090,80090', '180ct Refill', '41001', 'Mailer', '1'],
    ['X4', 'Tin Kit', '41001', 'Mailer', '1']];
  const cogs = (sku, a, b, c) => [sku, '', a, b, c, Math.round((a + b + c) * 100) / 100];
  const cogsRows = [cogs('10030', 6.76, 0.08, 0.35), cogs('80030', 2.60, 0.01, 0.35), cogs('80090', 5.78, 0.08, 1.04), cogs('51002', 0.45, 0, 0),
    cogs('50001', 2.10, 0, 0), cogs('20001', 0.59, 0.05, 0), cogs('A0030', 2.52, 0, 0.35), cogs('70003', 147, 0, 50.96),
    cogs('80090,80090', 11.56, 0.16, 2.08), cogs('80030,51002', 3.05, 0.01, 0.35), cogs('41001', 0.32, 0, 0)]; // A80004 deliberately missing
  // Descriptions as typed on COGS (Outbound Summary reads them, rule 11.2); 50001 left blank on purpose.
  const cogsDescs = { '10030': '10ct Pouch', '80090,80090': '90ct Pouch x2' };
  cogsRows.forEach((r) => { if (cogsDescs[r[0]]) r[1] = cogsDescs[r[0]]; });
  const yyyymm = year + '-' + String(monthIndex + 1).padStart(2, '0');
  const woHtml = fs.readFileSync(path.join(__dirname, 'workorders_sample.html'), 'utf8').replace(/2026-09/g, yyyymm);
  return { adsStart, adsEnd, amzStart, ledger, biz, shopify, manualLog, amzLog, bomValues, cogsHeader: COGS_HEADER, cogsRows, woHtml };
}

const serial = (y, mi, d) => Math.round((Date.UTC(y, mi, d) - Date.UTC(1899, 11, 30)) / 86400000);

/**
 * What Ops Hub holds for the month once "Write month to Ops Hub" has run on sampleRaw (worked out BY HAND from the raw
 * files above, so tests can prove the script gets the same numbers) — plus last month's column and the manufacturer
 * counts typed by hand. Same shape as readHubMonth_: {inventory: [{group, sku, begin, end}], sellThru, woLog}.
 */
function sampleHub(year, monthIndex) {
  const inv = (group, sku, begin, end) => ({ group, sku, begin, end });
  return {
    inventory: [
      // ADS: begin = last month's snapshot (adsStart), end = this month's (adsEnd)
      inv('ADS', '10030', 10, 5), inv('ADS', '80030', 100, 90), inv('ADS', '80090', 200, 170), inv('ADS', '50001', 50, 48),
      inv('ADS', '51002', 30, 28), inv('ADS', '20001', 40, 35), inv('ADS', 'A0030', 20, 15), inv('ADS', '41001', 20, 16),
      inv('ADS', '99999', 0, 0), // an old SKU with nothing: no row on the report
      // Amazon: end = last day Ending + In Transit (A0030: 107 + 5 + 3); begin = last month's Ops Hub ending (ties to the 1st here)
      inv('Amazon', 'A0030', 120, 115), inv('Amazon', 'A80004', 30, 25), inv('Amazon', '50001', 0, 4),
      // Manufacturers: typed by hand in Ops Hub
      inv('VitaQuest', '70003', 100, 120), inv('VitaPros', '70003', '', 300)
    ],
    sellThru: [
      { group: 'DTC', sku: '10030', qty: 3 }, { group: 'DTC', sku: '80090,80090', qty: 2 },
      { group: 'CX', sku: '80030', qty: 1 }, { group: 'CX', sku: '51002', qty: 1 },         // a Replacement order
      { group: 'TikTok', sku: '80030,51002', qty: 1 },
      { group: 'Marketing', sku: '80090', qty: 1 },                                          // "Free sample, TikTok" → Marketing (first match)
      { group: 'Marketing', sku: '50001', qty: 2 }, { group: 'Samples', sku: '50001', qty: 1 }, // manualorder_log
      { group: 'Amazon', sku: '50001', qty: 1 }, { group: 'Amazon', sku: 'A0030', qty: 20 }, { group: 'Amazon', sku: 'A80004', qty: 4 }
    ],
    woLog: [
      { serial: serial(year, monthIndex, 3), qty: 5, sku: '10030', cost: 0.54 },
      { serial: serial(year, monthIndex, 15), qty: 4, sku: 'A0030', cost: 0.38 },
      { serial: serial(year, monthIndex, 16), qty: 6, sku: 'A0030', cost: 0.38 }
    ]
  };
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
    ledger: t(raw.ledger, 'ledger'),
    biz: t(raw.biz, 'biz'),
    shopify: t(raw.shopify, 'shopify'),
    manualLog: ctx.parseOpsLog_(raw.manualLog, 'manual', m),
    amzLog: ctx.parseOpsLog_(raw.amzLog, 'amz', m),
    workOrders: ctx.parseWorkOrdersHtml_(raw.woHtml, m),
    bomValues: raw.bomValues,
    woFixes: [],
    hub: sampleHub(2026, 8),
    cogs: { header: raw.cogsHeader, rows: raw.cogsRows },
    prepaid: null,
    adsReceipts: [['PO-1', '50001', 10]],
    mfgReceipts: [['VitaQuest', '70003', 50], ['VitaPros', '70003', 300]],
    sources: { shopifySource: 'test' },
    ignoredFiles: [],
    extraTabs: []
  };
  return Object.assign(inputs, overrides || {});
}

module.exports = { sampleInputs, sampleRaw, sampleHub, csv, serial, LEDGER_HEADER, ADS_HEADER };
