'use strict';
// Runs the REAL entry points (buildEOM / shopifyOnly) against an in-memory Google Drive:
//   1. first run for September (Starting Balances subfolder, first-run COGS workbook)
//   2. you type MFG Inventory + ADS Receipts, run again (manual tabs kept, MFG blocks appear)
//   3. October, carried forward from September (ADS/AMZ/MFG/In Transit starting balances, COGS, SKU map)
//   4. postToOpsHub posts September then October to an in-memory Ops Hub
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gasMock');
const { Workbook, isErr } = require('./formulaEngine');
const { sampleRaw, csv } = require('./fixtures/sampleMonth');

function load(gas) {
  const ctx = vm.createContext(gas.sandbox);
  for (const f of ['Config.gs', 'Logic.gs', 'Sheets.gs', 'Main.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function putMonthFiles(folder, raw, opts) {
  folder.createFile('DY_Stock_Snapshot_Palisades (12).csv', csv(raw.adsEnd));
  folder.createFile('177349020748.csv', csv(raw.ledger));
  folder.createFile('BusinessReport-10-22-26.csv', '﻿' + csv(raw.biz));
  folder.createFile('orders_export.csv', csv(raw.shopify));
  folder.createFile('ProductionLabor.DY.2026-10-01.xls', raw.woHtml, 'application/vnd.ms-excel');
  folder.createFile('notes.pdf', '%PDF', 'application/pdf');
  if (opts && opts.boot) {
    const b = folder.createFolder('Starting Balances');
    b.createFile('DY_Stock_Snapshot_Palisades (11).csv', csv(raw.adsStart));
    b.createFile('ledger 8-31.csv', csv(raw.amzStart));
  }
}

function findFile(folder, name) { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }
function names(folder) { const out = []; const it = folder.getFiles(); while (it.hasNext()) out.push(it.next().getName()); return out.sort(); }

/** Calculates the whole workbook with the test engine (raw values incl. formulas). */
function calc(ss) {
  const map = {};
  for (const s of ss.getSheets()) map[s.getName()] = s.rawValues();
  return new Workbook(map);
}
function rowOf(ss, tab, a, b) {
  const v = ss.getSheetByName(tab).rawValues();
  const i = v.findIndex((r) => r[0] === a && (b === undefined || r[1] === b));
  if (i < 0) throw new Error('No row ' + a + '/' + b + ' on ' + tab);
  return i + 1;
}
const COLS = ['E', 'F', 'G', 'H', 'I', 'J'].map((c) => c.charCodeAt(0) - 64);

// ------------------------------------------------------------------ set up Drive
const gas = createGas();
const ctx = load(gas);
const parent = gas.root.createFolder('DairyPill EOM');
const sep = parent.createFolder('September 2026');
const rawSep = sampleRaw(2026, 8);
putMonthFiles(sep, rawSep, { boot: true });
// Ops Hub: BOM, the shipment logs (rows for every month the tests build) and the tabs postToOpsHub writes.
const logRows = (key) => [2026, 2026, 2026, 2026].map((y, i) => sampleRaw(y, 8 + i)[key].slice(1)).reduce((a, b) => a.concat(b), [])
  .filter((r) => r[0] !== '140'); // each sample month's "last month" row would double up once the months are combined
const S = (y, mi, d) => ctx.dateSerial_(y, mi, d);
const hub = gas.spreadsheetWithId(ctx.CONFIG.BOM_SOURCE.spreadsheetId, 'DairyPill Ops Hub 2.0', null, {
  Other: [['x']],
  bom: rawSep.bomValues.map((r) => ['', '', '', ''].concat(r)), // the real tab is lower-case "bom"; data in E:I
  manualorder_log: [rawSep.manualLog[0]].concat(logRows('manualLog')),
  amz_log: [rawSep.amzLog[0].concat(['', '', 'SKU', 'Units Sent'])].concat(logRows('amzLog')), // a side table at the right is ignored
  wo_log: [['Date', 'Quantity', 'SKU', 'Cost', 'Month', 'Channel'],
    [S(2026, 7, 24), 200, '10030', 0.54, '=if(A2=0,"", eomonth(A2,0))', '=if(left(C2,1)="A","Amazon","DTC")']],
  'sell_thru monthly': [['Last Updated:'], ['', '', '', '', 'Actual'], ['', '', '', 'Total Units Sold', '=sum(E6:E)'], [],
    ['Channel', 'Code', 'SKU', 'Description', S(2026, 7, 31)],
    ['DTC', '=A6&C6', '10030', '=xlookup(C6,sku_matrix!A:A,sku_matrix!B:B,"")', 7],
    ['DTC', '=A7&C7', '80030', '=xlookup(C7,sku_matrix!A:A,sku_matrix!B:B,"")', 4],
    ['Marketing', '=A8&C8', '50001', '=xlookup(C8,sku_matrix!A:A,sku_matrix!B:B,"")', 1],
    ['Amazon', '=A9&C9', 'A0030', '=xlookup(C9,sku_matrix!A:A,sku_matrix!B:B,"")', 30]],
  inventory_eom: [['', '', 'Total Units - ADS', '=sumifs(D3:D,$B3:$B,"ADS")'], ['Code', 'Location', 'SKU', S(2026, 7, 31)],
    ['ADS10030', 'ADS', '10030', 10], ['AmazonA0030', 'Amazon', 'A0030', 120], ['VitaQuest70003', 'VitaQuest', '70003', 100]],
  sku_matrix: [['SKU', 'Description', 'Status', 'Category'], ['10030', 'Starter Kit', 'ACTIVE', '=H2'], ['80030', '30ct Pouch', 'ACTIVE', '=H3']]
});
hub.customEval = () => ''; // Ops Hub formulas (XLOOKUP, EOMONTH…) are not calculated in tests
const cogsWithFormulas = [rawSep.cogsHeader].concat(rawSep.cogsRows.map((r, i) => ['=TRIM(B' + (i + 2) + ')'].concat(r.slice(1))));
const bootWb = gas.spreadsheetWithId(ctx.CONFIG.BOOTSTRAP_WORKBOOK_ID, 'Sept hand-built', null, {
  COGS: cogsWithFormulas,
  Prepaid: [['Prepaid POs', 'Invoice', 'SKU'], ['POUCHES-26', '102973', '80030']]
});
ctx.CONFIG.PARENT_FOLDER_ID = parent.getId();
ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';

test('placeholder folder id gives a plain-English error', () => {
  const g = createGas(); const c = load(g);
  assert.throws(() => c.buildEOM(), /Set PARENT_FOLDER_ID at the top of Config.gs/);
});

test('1. first run for September builds the full workbook', () => {
  const url = ctx.buildEOM();
  assert.match(url, /^https:\/\/docs.google.com/);
  const wbFile = findFile(sep, 'DAIRYPILL_EOM COGS - September 2026');
  assert.ok(wbFile, 'workbook created in the month folder');
  const ss = wbFile.ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 8));
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), Array.from(ctx.tabOrder_(tabs)));

  // raw files renamed; ADS start copied in; Sell Thru created; pdf left alone
  assert.deepEqual(names(sep), [
    'ADS Ending Balance 09.30.2026.csv', 'ADS Starting Balance 08.31.2026.csv', 'AMZ Business Report 09.30.2026.csv',
    'AMZ Inventory Ledger 09.30.2026.csv', 'DAIRYPILL_EOM COGS - September 2026', 'DairyPill Sell Thru Sep 2026',
    'Shopify Orders 09.30.2026.csv', 'Work Orders 09.30.2026.xls', 'notes.pdf']);
  // the month's Ops Hub log rows are frozen into the workbook (by Ship Date)
  const ml = ss.getSheetByName(tabs.manualLog).rawValues();
  assert.deepEqual(ml.slice(1).map((r) => [r[1], r[2], r[3]]), [['Marketing', '50001', 2], ['Samples', '80030', 3]]);
  assert.equal(ss.getSheetByName(tabs.amzLog).rawValues().length, 2);

  // SKUs stayed text (the mock turns number-looking text into numbers unless the cell is text-formatted)
  const shop = ss.getSheetByName(tabs.shopify).rawValues();
  assert.equal(shop[2][6], '80090,80090');
  assert.equal(ss.getSheetByName(tabs.adsEnd).rawValues()[1][0], '10030');
  assert.equal(ss.getSheetByName(tabs.adsEnd).rawValues()[1][7], 5);

  // Every formula calculates; numbers match the hand-worked sample
  const wb = calc(ss);
  for (const s of ss.getSheets()) wb.evaluateAll(s.getName());
  const r = rowOf(ss, tabs.variance, 'ADS', '80090');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, r, c)), [200, 0, 5, 195, 170, -25]);
  const a = rowOf(ss, tabs.variance, 'Amazon', 'A0030');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, a, c)), [120, 15, 20, 115, 115, 0]);
  // COGS copied from the first-run workbook with its formulas
  assert.equal(ss.getSheetByName('COGS').rawValues()[1][0], '=TRIM(B2)');
  assert.equal(wb.value(tabs.variance, r, 11), 6.9);
  // First run: MFG tabs are empty → flagged
  const checks = ss.getSheetByName(tabs.checks).rawValues();
  const res = (label) => wb.value(tabs.checks, checks.findIndex((x) => x[1] === label) + 1, 3);
  assert.match(res('MFG Inventory filled in'), /^FLAG/);
  assert.match(res('MFG Starting Balance filled in'), /^FLAG/);
  assert.match(res('In Transit to AMZ starting balance'), /^CHECK: empty/);
  assert.match(checks.find((x) => x[1] === 'Starting balances came from')[3], /Starting Balances" subfolder \(first run\)/);
  assert.match(checks.find((x) => x[1] === 'Files in the folder that were ignored')[3], /notes\.pdf/);
});

test('2. typing MFG Inventory + ADS Receipts and running again keeps what you typed', () => {
  const ss = findFile(sep, 'DAIRYPILL_EOM COGS - September 2026').ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 8));
  const mfg = ss.getSheetByName(tabs.mfgInv);
  mfg.getRange(2, 1, 2, 4).setValues([['VitaQuest', '70003', 50, 120], ['VitaPros', '70003', 300, 300]]);
  ss.getSheetByName(tabs.mfgStart).getRange(2, 1, 1, 3).setValues([['VitaQuest', '70003', 100]]);
  ss.getSheetByName(tabs.adsReceipts).getRange(2, 1, 1, 3).setValues([['PO-1', '50001', 10]]);
  ss.getSheetByName(tabs.transitStart).getRange(2, 1, 2, 2).setValues([['50001', 5], ['A0030', 8]]);
  ss.getSheetByName('COGS').getRange(12, 1, 1, 8).setValues([['=TRIM(B12)', 'A80004', '', '', 1, 0.03, 0, 1.03]]); // you add a missing cost

  ctx.buildEOM();
  const ss2 = findFile(sep, 'DAIRYPILL_EOM COGS - September 2026').ss;
  assert.equal(ss2, ss, 'same workbook rebuilt in place');
  assert.equal(ss2.getSheetByName(tabs.mfgInv).rawValues()[1][0], 'VitaQuest', 'typed MFG data kept');
  const wb = calc(ss2);
  for (const s of ss2.getSheets()) wb.evaluateAll(s.getName());
  const vq = rowOf(ss2, tabs.variance, 'VitaQuest', '70003');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, vq, c)), [100, 50, 30, 120, 120, 0]);
  const ads = rowOf(ss2, tabs.variance, 'ADS', '50001');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, ads, c)), [50, 10, 2, 58, 48, -10]);
  assert.equal(ss2.getSheetByName(tabs.transitStart).rawValues()[1][0], 50001, 'typed In Transit start kept');
  const tr = rowOf(ss2, tabs.variance, 'In Transit to AMZ', 'A0030');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, tr, c)), [8, 15, 15, 8, 8, 0]);
  const a8 = rowOf(ss2, tabs.variance, 'Amazon', 'A80004');
  assert.equal(wb.value(tabs.variance, a8, 11), 1.03, 'your COGS edit is used');
  const checks = ss2.getSheetByName(tabs.checks).rawValues();
  const res = (label) => wb.value(tabs.checks, checks.findIndex((x) => x[1] === label) + 1, 3);
  assert.equal(res('MFG Inventory filled in'), 'OK');
  assert.equal(res('SKUs with no COGS cost'), 'OK');
  assert.match(checks.find((x) => x[1] === 'Shopify data came from')[3], /reused/);
  // nothing anywhere evaluates to an error
  const errs = [];
  for (const s of ss2.getSheets()) {
    const v = s.rawValues();
    v.forEach((row, i) => row.forEach((x, j) => { if (typeof x === 'string' && x.startsWith('=') && isErr(wb.value(s.getName(), i + 1, j + 1))) errs.push(s.getName() + ' ' + (i + 1) + ',' + (j + 1)); }));
  }
  assert.deepEqual(errs, []);
});

test('3. October carries everything forward from September (first-run workbook no longer needed)', () => {
  gas.drive.files.delete(bootWb.getId()); // prove October never needs it
  const oct = parent.createFolder('October 2026');
  const rawOct = sampleRaw(2026, 9);
  putMonthFiles(oct, rawOct, { boot: false });
  ctx.CONFIG.MONTH_OVERRIDE = 'October 2026';
  ctx.buildEOM();
  const ss = findFile(oct, 'DAIRYPILL_EOM COGS - October 2026').ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 9));
  assert.equal(tabs.adsStart, 'ADS Starting Balance 09.30.2026');
  const wb = calc(ss);
  for (const s of ss.getSheets()) wb.evaluateAll(s.getName());
  // ADS start = September's ADS ending; Amazon start = September ledger's 9/30 rows (110 + 5 expired)
  const ads = rowOf(ss, tabs.variance, 'ADS', '80090');
  assert.equal(wb.value(tabs.variance, ads, COLS[0]), 170);
  const amz = rowOf(ss, tabs.variance, 'Amazon', 'A0030');
  assert.equal(wb.value(tabs.variance, amz, COLS[0]), 115);
  // MFG start = September's MFG Inventory EOM
  const vq = rowOf(ss, tabs.variance, 'VitaQuest', '70003');
  assert.equal(wb.value(tabs.variance, vq, COLS[0]), 120);
  const vp = rowOf(ss, tabs.variance, 'VitaPros', '70003');
  assert.equal(wb.value(tabs.variance, vp, COLS[0]), 300);
  // In Transit start = September's In Transit ending (A0030: 8 + 15 − 15)
  const tr = rowOf(ss, tabs.variance, 'In Transit to AMZ', 'A0030');
  assert.equal(wb.value(tabs.variance, tr, COLS[0]), 8);
  assert.deepEqual(ss.getSheetByName(tabs.transitStart).rawValues().slice(1).map((r) => [String(r[0]), r[1]]), [['50001', 0], ['A0030', 8]]);
  // COGS (with your A80004 edit) and the SKU map came from September's workbook
  assert.ok(ss.getSheetByName('COGS').rawValues().some((r) => r[1] === 'A80004'));
  const map = ss.getSheetByName('AMZ SKU Map').rawValues();
  assert.ok(map.some((r) => r[0] === 'A80002' && r[2] === 'A80004'));
  const checks = ss.getSheetByName(tabs.checks).rawValues();
  assert.match(checks.find((x) => x[1] === 'Starting balances came from')[3], /September 2026 folder/);
  assert.equal(checks.find((x) => x[1] === 'AMZ SKU Map entries added this run')[2], 'OK');
  assert.ok(findFile(oct, 'ADS Starting Balance 09.30.2026.csv'));
});

test('4. postToOpsHub: refuses while Checks has FLAGs, then posts September and October', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';
  assert.throws(() => ctx.postToOpsHub(), /Checks tab still has \d+ FLAG\(s\), so nothing was posted/);
  ctx.CONFIG.POST_DESPITE_FLAGS = true;
  ctx.postToOpsHub();
  const tab = (n) => hub.getSheetByName(n);
  // wo_log: kit lines appended under the existing row; Month/Channel formulas dragged down
  const wo = tab('wo_log').rawValues();
  assert.deepEqual(wo.slice(2).map((r) => [r[1], r[2], r[3]]), [[5, '10030', 0.54], [4, 'A0030', 0.38], [6, 'A0030', 0.38]]);
  assert.equal(wo[2][0], S(2026, 8, 3));
  assert.equal(wo[2][4], '=if(A3=0,"", eomonth(A3,0))');
  assert.equal(wo[4][5], '=if(left(C5,1)="A","Amazon","DTC")');
  // sell_thru monthly: Sep column added, formulas dragged right, new rows inside their channel block
  const st = tab('sell_thru monthly').rawValues();
  assert.equal(st[4][5], S(2026, 8, 30));
  assert.equal(st[1][5], 'Actual');
  assert.equal(st[2][5], '=sum(F6:F)');
  const stRow = (ch, sku) => st.find((r) => r[0] === ch && r[2] === sku);
  assert.equal(stRow('DTC', '10030')[5], 3);
  assert.equal(stRow('DTC', '80030')[5], 0, 'existing row with no sales gets 0');
  assert.equal(stRow('Marketing', '50001')[5], 2);
  assert.equal(stRow('Samples', '80030')[5], 3);
  assert.equal(stRow('Amazon', 'A0030')[5], 20);
  const dtcNew = st.findIndex((r) => r[0] === 'DTC' && r[2] === '80090,80090');
  assert.ok(dtcNew > 0 && dtcNew < st.findIndex((r) => r[0] === 'Marketing'), 'new DTC row sits in the DTC block');
  assert.equal(st[dtcNew][1], '=A' + (dtcNew + 1) + '&C' + (dtcNew + 1), 'Code formula dragged down');
  assert.equal(st[dtcNew][3], '=xlookup(C' + (dtcNew + 1) + ',sku_matrix!A:A,sku_matrix!B:B,"")');
  assert.equal(st[dtcNew][4], '', 'old months stay blank on new rows');
  // inventory_eom: Sep column; new locations / SKUs; Code written as Location&SKU
  const inv = tab('inventory_eom').rawValues();
  assert.equal(inv[1][4], S(2026, 8, 30));
  assert.equal(inv[0][4], '=sumifs(E3:E,$B3:$B,"ADS")');
  const invRow = (loc, sku) => inv.find((r) => r[1] === loc && r[2] === sku);
  assert.equal(invRow('ADS', '10030')[4], 5);
  assert.equal(invRow('Amazon', 'A0030')[4], 115);
  assert.equal(invRow('VitaQuest', '70003')[4], 120);
  assert.deepEqual(invRow('In Transit to AMZ', 'A0030').slice(0, 5), ['In Transit to AMZA0030', 'In Transit to AMZ', 'A0030', '', 8]);
  // sku_matrix: new single SKUs only, flagged for you to verify, formulas dragged down
  const sm = tab('sku_matrix').rawValues();
  const added = sm.slice(3).map((r) => r[0]);
  assert.ok(added.includes('50001') && added.includes('A0030') && !added.some((x) => String(x).includes(',')));
  assert.ok(sm.slice(3).every((r) => r[2] === 'NEEDS VERIFICATION'));
  assert.equal(sm[3][3], '=H4');
  assert.equal(sm.find((r) => r[0] === '80090')[1], '90ct Pouch', 'description from the BOM');

  // posting the same month again is refused (wo_log would double)
  assert.throws(() => ctx.postToOpsHub(), /wo_log" already has 3 rows dated September 2026/);
  // skipping a month is refused
  ctx.CONFIG.MONTH_OVERRIDE = 'October 2026';
  const before = tab('sell_thru monthly').rawValues().length;
  ctx.postToOpsHub();
  const st2 = tab('sell_thru monthly').rawValues();
  assert.equal(st2.length, before, 'October needs no new rows');
  assert.equal(st2[4][6], S(2026, 9, 31));
  assert.equal(st2.find((r) => r[0] === 'DTC' && r[2] === '10030')[6], 3);
  ctx.CONFIG.POST_DESPITE_FLAGS = false;
});

test('a Manual Orders file in the month folder is refused', () => {
  const jan = parent.createFolder('January 2027');
  jan.createFile('manual.csv', 'CUSTOMER,ORDER,SKU,QUANTITY,DATE\r\nMANUAL,1,50001,2,1/2/2027');
  ctx.CONFIG.MONTH_OVERRIDE = 'January 2027';
  assert.throws(() => ctx.buildEOM(), /is a Manual Orders file. Those are no longer used/);
});

test('missing or duplicate files stop the run with a clear message', () => {
  const nov = parent.createFolder('November 2026');
  ctx.CONFIG.MONTH_OVERRIDE = 'November 2026';
  assert.throws(() => ctx.buildEOM(), /missing: ADS stock snapshot; missing: Amazon Inventory Ledger/);
  const raw = sampleRaw(2026, 10);
  putMonthFiles(nov, raw, { boot: false });
  nov.createFile('second ledger.csv', csv(raw.ledger));
  assert.throws(() => ctx.buildEOM(), /more than one Amazon Inventory Ledger/);
  nov.createFile('Book1.xlsx', 'x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => ctx.buildEOM(), /Excel file/);
});

test('ledger that starts on the 2nd stops the run', () => {
  const dec = parent.createFolder('December 2026');
  const raw = sampleRaw(2026, 11);
  raw.ledger = raw.ledger.filter((r) => !String(r[0]).startsWith('12/01/'));
  putMonthFiles(dec, raw, { boot: true });
  ctx.CONFIG.MONTH_OVERRIDE = 'December 2026';
  assert.throws(() => ctx.buildEOM(), /missing 1 day\(s\): 12\/01\/2026/);
});

test('shopifyOnly makes just the Sell Thru file', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';
  ctx.shopifyOnly();
  const st = findFile(sep, 'DairyPill Sell Thru Sep 2026').ss;
  assert.deepEqual(st.getSheets().map((s) => s.getName()), ['Channel Breakdown', 'Order Export']);
  const wb = calc(st);
  wb.evaluateAll('Order Export');
  const cb = st.getSheetByName('Channel Breakdown').rawValues();
  const row = cb.findIndex((r) => r[0] === '51002') + 1;
  assert.deepEqual(['B', 'C', 'D', 'E', 'F'].map((c) => wb.value('Channel Breakdown', row, c.charCodeAt(0) - 64)), [0, 0, 1, 0, 1]); // DTC, Mktg, CX, TikTok, total
});

test('a failed run changes nothing in the folder', () => {
  const dec = parent.getFoldersByName('December 2026').next();
  ctx.CONFIG.MONTH_OVERRIDE = 'December 2026';
  const before = names(dec);
  assert.throws(() => ctx.buildEOM(), /missing 1 day/);
  assert.deepEqual(names(dec), before, 'no workbook, Sell Thru or renamed files after a failed check');
});
