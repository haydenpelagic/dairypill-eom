'use strict';
// Runs the REAL entry points (buildEOM / shopifyOnly) against an in-memory Google Drive:
//   1. first run for September (Starting Balances subfolder, first-run COGS workbook)
//   2. you type MFG Inventory + ADS Receipts, run again (manual tabs kept, MFG blocks appear)
//   3. October, carried forward from September (ADS/AMZ/MFG starting balances, COGS, SKU map)
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
// Ops Hub: BOM + the two shipment logs. The logs hold several months' rows (Rule 5.6: month = Ship Date).
const logMonths = [[2026, 8], [2026, 9], [2027, 2], [2027, 3]].map(([y, mi]) => sampleRaw(y, mi));
const stackLog = (k) => [rawSep[k][0]].concat(...logMonths.map((r) => r[k].slice(1)));
gas.spreadsheetWithId(ctx.CONFIG.BOM_SOURCE.spreadsheetId, 'DairyPill Ops Hub 2.0', null, {
  Other: [['x']],
  bom: rawSep.bomValues.map((r) => ['', '', '', ''].concat(r)), // the real tab is lower-case "bom"; data in E:I
  manualorder_log: stackLog('manualLog'),
  amz_log: stackLog('amzLog').map((r) => r.concat(['October'])) // extra columns past F are ignored
});
const cogsWithFormulas = [rawSep.cogsHeader].concat(rawSep.cogsRows.map((r, i) => ['=TRIM(B' + (i + 2) + ')'].concat(r.slice(1))));
const makeBootWb = () => gas.spreadsheetWithId(ctx.CONFIG.BOOTSTRAP_WORKBOOK_ID, 'Sept hand-built', null, {
  COGS: cogsWithFormulas,
  Prepaid: [['Prepaid POs', 'Invoice', 'SKU'], ['POUCHES-26', '102973', '80030']],
  // Rule 2.2a: the hand-built workbook's ADS ending tab — a title row, a blank row, then the snapshot
  // (rows in a different order and quantities as numbers, as Sheets returns them).
  'ADS 930': [['9/30/26'], ['']].concat([rawSep.adsStart[0]], rawSep.adsStart.slice(1).reverse().map((r) => r.map((v, i) => (i === 7 ? Number(v) : v))))
});
const bootWb = makeBootWb();
ctx.CONFIG.PARENT_FOLDER_ID = parent.getId();
ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';

test('placeholder folder id gives a plain-English error', () => {
  const g = createGas(); const c = load(g);
  c.CONFIG.PARENT_FOLDER_ID = 'PASTE_THE_PARENT_FOLDER_ID_HERE';
  assert.throws(() => c.buildEOM(), /Set PARENT_FOLDER_ID at the top of Config.gs/);
});

test('a folder the account cannot open gives a plain-English error', () => {
  const g = createGas(); const c = load(g);
  assert.match(c.CONFIG.PARENT_FOLDER_ID, /^16H9CC/, 'the real EOM Reports folder is set in Config.gs');
  assert.throws(() => c.buildEOM(), /Could not open the EOM Reports folder .* as tester@example\.com\. Share that folder/);
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
  assert.match(checks.find((x) => x[1] === 'Starting balances came from')[3], /Starting Balances" subfolder \(first run\)/);
  // Rule 4.2a: optional August ledger in Starting Balances ties to September's 9/1 starting balance
  const tie = checks.find((x) => x[1] === 'Amazon starting balance = last month\'s ending');
  assert.equal(tie[2], 'OK');
  assert.match(tie[3], /ledger 8-31\.csv/);
  assert.match(checks.find((x) => x[1] === 'Files in the folder that were ignored')[3], /notes\.pdf/);
});

test('2. typing MFG Inventory + ADS Receipts and running again keeps what you typed', () => {
  const ss = findFile(sep, 'DAIRYPILL_EOM COGS - September 2026').ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 8));
  const mfg = ss.getSheetByName(tabs.mfgInv);
  mfg.getRange(2, 1, 2, 4).setValues([['VitaQuest', '70003', 50, 120], ['VitaPros', '70003', 300, 300]]);
  ss.getSheetByName(tabs.mfgStart).getRange(2, 1, 1, 3).setValues([['VitaQuest', '70003', 100]]);
  ss.getSheetByName(tabs.adsReceipts).getRange(2, 1, 1, 3).setValues([['PO-1', '50001', 10]]);
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
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, ads, c)), [50, 10, 3, 57, 48, -9]);
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
  // ADS start = September's ADS ending
  const ads = rowOf(ss, tabs.variance, 'ADS', '80090');
  assert.equal(wb.value(tabs.variance, ads, COLS[0]), 170);
  // Rule 4.2: Amazon start = October ledger's 10/01 Starting Warehouse Balance (100 + 20), NOT September's 9/30 ending (110 + 5)
  const amz = rowOf(ss, tabs.variance, 'Amazon', 'A0030');
  assert.equal(wb.value(tabs.variance, amz, COLS[0]), 120);
  assert.equal(ss.getSheetByName(tabs.amzStart).rawValues().length, 4, 'AMZ Starting tab = the three 10/01 rows + header');
  // Rule 4.2a: the differences are flagged on Checks, run not stopped
  const tieRow = ss.getSheetByName(tabs.checks).rawValues().find((x) => x[1] === 'Amazon starting balance = last month\'s ending');
  assert.equal(tieRow[2], 'FLAG: 3 SKU(s) differ');
  // shown by OUR SKU (A0030 - TEMP SKU → A0030, A80002 → A80004), matching Variance Overview
  assert.match(tieRow[3], /(^|; )A0030: 09\/30\/2026 ending 115 vs 10\/01\/2026 starting 120 \(\+5\)/);
  assert.match(tieRow[3], /A80004: 09\/30\/2026 ending 25 vs 10\/01\/2026 starting 30 \(\+5\)/);
  assert.doesNotMatch(tieRow[3], /TEMP SKU/);
  assert.match(tieRow[3], /50001: 09\/30\/2026 ending 4 vs 10\/01\/2026 starting 0 \(-4\)/);
  assert.match(tieRow[3], /AMZ Inventory Ledger 09\.30\.2026\.csv" in the September 2026 folder/);
  // MFG start = September's MFG Inventory EOM
  const vq = rowOf(ss, tabs.variance, 'VitaQuest', '70003');
  assert.equal(wb.value(tabs.variance, vq, COLS[0]), 120);
  const vp = rowOf(ss, tabs.variance, 'VitaPros', '70003');
  assert.equal(wb.value(tabs.variance, vp, COLS[0]), 300);
  // COGS (with your A80004 edit) and the SKU map came from September's workbook
  assert.ok(ss.getSheetByName('COGS').rawValues().some((r) => r[1] === 'A80004'));
  const map = ss.getSheetByName('AMZ SKU Map').rawValues();
  assert.ok(map.some((r) => r[0] === 'A80002' && r[2] === 'A80004'));
  const checks = ss.getSheetByName(tabs.checks).rawValues();
  assert.match(checks.find((x) => x[1] === 'Starting balances came from')[3], /September 2026 folder/);
  assert.equal(checks.find((x) => x[1] === 'AMZ SKU Map entries added this run')[2], 'OK');
  assert.ok(findFile(oct, 'ADS Starting Balance 09.30.2026.csv'));
});

test('Rule 2.3: last month\'s renamed files are found with or without .csv, or saved as a Google Sheet', () => {
  const g = createGas(); const c = load(g);
  const f = g.root.createFolder('September 2026');
  const raw = sampleRaw(2026, 8);
  assert.equal(c.monthFileEntry_(f, 'ADS Ending Balance 09.30.2026'), null);
  f.createFile('ADS Ending Balance 09.30.2026 (1).csv', csv(raw.adsEnd)); // a different name: not matched
  f.createFile('AMZ Inventory Ledger 09.30.2026', csv(raw.ledger));      // extension lost
  assert.equal(c.monthFileEntry_(f, 'ADS Ending Balance 09.30.2026'), null);
  const led = c.monthFileEntry_(f, 'AMZ Inventory Ledger 09.30.2026');
  assert.equal(led.type, 'LEDGER');
  g.spreadsheetWithId('sheet-ads', 'ADS Ending Balance 09.30.2026', f, { Sheet1: raw.adsEnd }); // saved as a Google Sheet
  const ads = c.monthFileEntry_(f, 'ADS Ending Balance 09.30.2026');
  assert.equal(ads.type, 'ADS');
  assert.equal(c.tableFromEntry_(ads, 'x').rows.length, raw.adsEnd.length - 1);
  f.createFile('ADS Ending Balance 09.30.2026.CSV', csv(raw.adsEnd));
  assert.throws(() => c.monthFileEntry_(f, 'ADS Ending Balance 09.30.2026'), /There are 2 files named "ADS Ending Balance 09.30.2026".*Keep only one/);
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

test('a Sell Thru file from an older script version is rebuilt, not reused', () => {
  const g = createGas(); const c = load(g);
  const f = g.root.createFolder('x');
  const old = g.spreadsheetWithId('st-old', 'old', f, { 'Order Export': [['Name', 'Order Tags', 'Channel']] });
  const cur = g.spreadsheetWithId('st-new', 'new', f, { 'Order Export': [['Name', 'Counted', 'Counted Qty']] });
  assert.equal(c.sellThruIsCurrent_(old.file), false);
  assert.equal(c.sellThruIsCurrent_(cur.file), true);
});

test('a leftover Manual Orders file, or a Shopify export without status columns, stops the run before anything in Drive changes', () => {
  const mar = parent.createFolder('March 2027');
  const raw = sampleRaw(2027, 2);
  putMonthFiles(mar, raw, { boot: true });
  mar.createFile('manual orders.csv', csv([['CUSTOMER', 'ORDER', 'SKU', 'QUANTITY', 'DATE'], ['MANUAL', '150', '50001', '1', '3/2/2027']]));
  ctx.CONFIG.MONTH_OVERRIDE = 'March 2027';
  const before = names(mar);
  assert.throws(() => ctx.buildEOM(), /"manual orders.csv" in "March 2027" is a Manual Orders file\. Those are no longer used: shipments out of ADS are read from Ops Hub "manualorder_log" and "amz_log"/);
  assert.deepEqual(names(mar), before, 'nothing renamed, copied or created');

  const apr = parent.createFolder('April 2027');
  const raw2 = sampleRaw(2027, 3);
  raw2.shopify = raw2.shopify.map((r) => r.slice(0, 9)); // no Cancelled at / Lineitem fulfillment status
  putMonthFiles(apr, raw2, { boot: true });
  ctx.CONFIG.MONTH_OVERRIDE = 'April 2027';
  const before2 = names(apr);
  assert.throws(() => ctx.buildEOM(), /missing the column "Cancelled at"/);
  assert.throws(() => ctx.shopifyOnly(), /missing the column "Cancelled at"/);
  assert.deepEqual(names(apr), before2, 'nothing renamed or created');
});

test('Rule 2.2a: first run with last month\'s ADS snapshot loose in the month folder — found by matching the first-run workbook', () => {
  if (!gas.drive.files.get(ctx.CONFIG.BOOTSTRAP_WORKBOOK_ID)) makeBootWb(); // an earlier test deletes it
  const jun = parent.createFolder('June 2027');
  const raw = sampleRaw(2027, 5);
  putMonthFiles(jun, raw);                                                              // this month's snapshot: (12)
  jun.createFile('DY_Stock_Snapshot_Palisades (19).csv', csv(raw.adsStart));            // last month's, higher number
  ctx.CONFIG.MONTH_OVERRIDE = 'June 2027';
  ctx.buildEOM();
  const n = names(jun);
  assert.ok(n.includes('ADS Starting Balance 05.31.2027.csv'), 'the matching snapshot is renamed as the starting balance');
  assert.ok(n.includes('ADS Ending Balance 06.30.2027.csv'), 'the other one is this month\'s ending');
  assert.ok(!n.some((x) => /Palisades/.test(x)), 'both snapshots identified');
  const ss = findFile(jun, 'DAIRYPILL_EOM COGS - June 2027').ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2027, 5));
  const wb = calc(ss);
  const ads = rowOf(ss, tabs.variance, 'ADS', '80030');
  assert.equal(wb.value(tabs.variance, ads, 5), 100, 'Beginning = the matched (start) snapshot');
  assert.equal(wb.value(tabs.variance, ads, 9), 90, 'Actual = this month\'s snapshot');
  const checks = ss.getSheetByName(tabs.checks).rawValues();
  assert.match(checks.find((x) => x[1] === 'Starting balances came from')[3], /matches the "ADS 930" tab of the first-run workbook/);
  ctx.buildEOM(); // rebuild: the renamed starting file is found again, nothing doubles
  assert.deepEqual(names(jun), n);
});

test('Rule 2.2a: two loose ADS snapshots and neither matches the first-run workbook — stops before anything changes', () => {
  if (!gas.drive.files.get(ctx.CONFIG.BOOTSTRAP_WORKBOOK_ID)) makeBootWb(); // an earlier test deletes it
  const jul = parent.createFolder('July 2028');
  const raw = sampleRaw(2028, 6);
  putMonthFiles(jul, raw);
  jul.createFile('other snapshot.csv', csv(raw.adsStart.map((r, i) => (i === 1 ? r.map((v, j) => (j === 7 ? '11' : v)) : r))));
  ctx.CONFIG.MONTH_OVERRIDE = 'July 2028';
  const before = names(jul);
  assert.throws(() => ctx.buildEOM(), /There are 2 ADS stock snapshots in the month folder .* and none of them matches the "ADS 930" tab/);
  assert.deepEqual(names(jul), before);
});
