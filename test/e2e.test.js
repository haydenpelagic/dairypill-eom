'use strict';
// Runs the REAL entry points against an in-memory Google Drive and Ops Hub 2.0:
//   1. Write month to Ops Hub (September): ADS + Amazon rows, sell_thru, wo_log, sku_matrix; manufacturer rows left for you;
//      wo_sku_fixes started from the old-layout report's WO SKU Fixes tab; running again changes nothing
//   2. Generate EOM Report (September): Ops Hub's numbers locked into the report; typed tabs kept on a rerun
//   3. Generate before Write: stops, nothing changes
//   4. October: Beginning = September's Ops Hub column; a blank manufacturer count stays blank; an Ops Hub edit shows + FLAG
//   5. A work-order line with no SKU: listed on wo_sku_fixes, nothing else written; type the SKU and run again
//   6. The EOM menu (month prompt, result pop-ups)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gasMock');
const { Workbook, isErr } = require('./formulaEngine');
const { sampleRaw, sampleHub, csv } = require('./fixtures/sampleMonth');

function load(gas) {
  const ctx = vm.createContext(gas.sandbox);
  for (const f of ['Config.gs', 'Logic.gs', 'Sheets.gs', 'Main.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function putMonthFiles(folder, raw) {
  folder.createFile('DY_Stock_Snapshot_Palisades (12).csv', csv(raw.adsEnd));
  folder.createFile('177349020748.csv', csv(raw.ledger));
  folder.createFile('BusinessReport-10-22-26.csv', '﻿' + csv(raw.biz));
  folder.createFile('orders_export.csv', csv(raw.shopify));
  folder.createFile('ProductionLabor.DY.2026-10-01.xls', raw.woHtml, 'application/vnd.ms-excel');
  folder.createFile('notes.pdf', '%PDF', 'application/pdf');
}

function findFile(folder, name) { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }
function names(folder) { const out = []; const it = folder.getFiles(); while (it.hasNext()) out.push(it.next().getName()); return out.sort(); }

/** Calculates the whole workbook with the test engine (raw values incl. formulas). */
function calc(ss) {
  const map = {};
  for (const s of ss.getSheets()) map[s.getName()] = s.rawValues();
  const wb = new Workbook(map);
  for (const s of ss.getSheets()) wb.evaluateAll(s.getName());
  return wb;
}
function rowOf(ss, tab, a, b) {
  const v = ss.getSheetByName(tab).rawValues();
  const i = v.findIndex((r) => r[0] === a && (b === undefined || r[1] === b));
  if (i < 0) throw new Error('No row ' + a + '/' + b + ' on ' + tab);
  return i + 1;
}
const COLS = ['E', 'F', 'G', 'H', 'I', 'J'].map((c) => c.charCodeAt(0) - 64);
const checksRow = (ss, label) => ss.getSheetByName('Checks').rawValues().find((x) => x[1] === label);
function checkResult(ss, wb, label) {
  const rows = ss.getSheetByName('Checks').rawValues();
  return wb.value('Checks', rows.findIndex((x) => x[1] === label) + 1, 3);
}

// ------------------------------------------------------------------ set up Drive and Ops Hub
const gas = createGas();
const ctx = load(gas);
const D = (y, m, d) => ctx.dateSerial_(y, m, d);
const JUL = D(2026, 6, 31), AUG = D(2026, 7, 31), SEP = D(2026, 8, 30), OCT = D(2026, 9, 31);
const parent = gas.root.createFolder('DairyPill EOM');
const sep = parent.createFolder('September 2026');
const rawSep = sampleRaw(2026, 8);
putMonthFiles(sep, rawSep);
// A September report from the OLD layout (before 2026-11-16): its WO SKU Fixes start the Ops Hub tab; its other tabs are left alone.
gas.spreadsheetWithId('old-sep-report', 'DAIRYPILL_EOM COGS - September 2026', sep, {
  'WO SKU Fixes': [['Reported as (Job, or Description when Job is blank)', 'Our SKU', 'Note'], ['NO GASSY DAYS STARTER KIT 30', '10030', 'typed by hand']],
  'MFG Counts 09.30.2026': [['MFG', 'SKU', 'EOM Qty', 'Received Qty'], ['VitaQuest', '70003', 120, 50]],
  Prepaid: [['Prepaid POs', 'Invoice', 'SKU'], ['POUCHES-26', '102973', '80030']]
});

// Ops Hub: BOM + the two shipment logs (several months' rows; Rule 5.6: month = Ship Date), and the four tabs it writes,
// as they look today (formulas the test engine understands; SKU columns text-formatted).
const logMonths = [[2026, 8], [2026, 9], [2026, 10]].map(([y, mi]) => sampleRaw(y, mi));
const head = (k) => (k === 'amzLog' ? 2 : 1); // amz_log has a summary row above its header row
const stackLog = (k) => rawSep[k].slice(0, head(k)).concat(...logMonths.map((r) => r[k].slice(head(k))));
const hub = gas.spreadsheetWithId(ctx.CONFIG.OPS_HUB.spreadsheetId, 'DairyPill Ops Hub 2.0', null, {
  Other: [['x']],
  bom: rawSep.bomValues.map((r) => ['', '', '', ''].concat(r)), // the real tab is lower-case "bom"; data in E:I
  manualorder_log: stackLog('manualLog'),
  amz_log: stackLog('amzLog').map((r) => r.concat(['October'])) // extra columns past F are ignored
});
const addTab = (name, rows, textCols) => {
  const s = new gas.MockSheet(hub, name);
  s.cells = rows.map((r) => r.slice());
  rows.forEach((r, i) => (textCols || []).forEach((c) => { s.formats[(i + 1) + ',' + c] = '@'; }));
  hub.sheets.push(s); hub.dirty = true;
  return s;
};
const ads = (sku, jul, aug) => ['ADS' + sku, 'ADS', sku, jul, aug];
const inv = addTab('inventory_eom', [
  ['', '', 'Total Units - ADS', '=SUMIFS(D3:D,$B3:$B,"ADS")', '=SUMIFS(E3:E,$B3:$B,"ADS")'],
  ['Code', 'Location', 'SKU', JUL, AUG],
  ads('10030', 1, 10), ads('80030', 1, 100), ads('80090', 1, 200), ads('50001', 1, 50), ads('51002', 1, 30), ads('20001', 1, 40),
  ads('A0030', 1, 20), ads('41001', 1, 20), ads('99999', 5, 0), // an old SKU: nothing since July
  ['AmazonA0030', 'Amazon', 'A0030', 1, 120], ['AmazonA80004', 'Amazon', 'A80004', 1, 30], ['Amazon50001', 'Amazon', '50001', 0, 0],
  ['VitaQuest70003', 'VitaQuest', '70003', 90, 100], ['VitaPros70003', 'VitaPros', '70003', '', '']], [3]);
const desc = (r) => '=IFERROR(INDEX(sku_matrix!B:B,MATCH(C' + r + ',sku_matrix!A:A,0)),"")';
const sell = addTab('sell_thru monthly', [
  ['Last Updated:'], ['', '', '', '', 'Actual', 'Actual'],
  ['', '', '', 'Total Units Sold', '=SUM(E6:E)', '=SUM(F6:F)'], ['', '', '', 'Total Units Sold - Amazon', '=SUMIFS(E6:E,$A6:$A,"Amazon")', '=SUMIFS(F6:F,$A6:$A,"Amazon")'],
  ['Channel', 'Code', 'SKU', 'Description', JUL, AUG],
  ['DTC', '=A6&C6', '10030', desc(6), 1, 2], ['Amazon', '=A7&C7', 'A0030', desc(7), 3, 4]], [3]);
const month = (r) => '=IF(A' + r + '=0,"",A' + r + ')';
const chan = (r) => '=IF(C' + r + '="","",IFERROR(IF(SEARCH("A",C' + r + ')=1,"Amazon","DTC"),"DTC"))';
const wo = addTab('wo_log', [
  ['Date', 'Quantity', 'SKU', 'Cost', 'Month', 'Channel', '', 'SKU', 'Nov 2025'],
  [D(2026, 7, 3), 200, '10030', 0.54, month(2), chan(2), '', 'Base Fee', 32],
  [D(2026, 7, 24), 22, '10180', 0.54, month(3), chan(3), '', 'A0090', 1],
  ['', '', '', '', month(4), chan(4)]], [3]); // formulas stop at row 4: later rows get them copied down
const sku = addTab('sku_matrix', [['SKU', 'Description', 'Status'], ['10030', 'Starter Kit - Black 30ct', 'ACTIVE'], ['80090', '90ct Pouch', 'ACTIVE']], [1]);
const fixesTab = () => hub.getSheetByName('wo_sku_fixes');
const snap = () => [inv, sell, wo, sku, fixesTab()].map((s) => (s ? JSON.stringify(s.rawValues()) : 'none'));
ctx.CONFIG.PARENT_FOLDER_ID = parent.getId();

test('placeholder folder id gives a plain-English error', () => {
  const g = createGas(); const c = load(g);
  c.CONFIG.PARENT_FOLDER_ID = 'PASTE_THE_PARENT_FOLDER_ID_HERE';
  assert.throws(() => c.generateEOMReport(), /Set PARENT_FOLDER_ID at the top of Config.gs/);
  assert.throws(() => c.writeOpsHub(), /Set PARENT_FOLDER_ID at the top of Config.gs/);
});

test('a folder the account cannot open gives a plain-English error', () => {
  const g = createGas(); const c = load(g);
  assert.match(c.CONFIG.PARENT_FOLDER_ID, /^16H9CC/, 'the real EOM Reports folder is set in Config.gs');
  assert.throws(() => c.writeOpsHub(), /Could not open the EOM Reports folder .* as tester@example\.com\. Share that folder/);
});

test('1. Write month to Ops Hub (September): ADS + Amazon rows, sell_thru, wo_log, sku_matrix — from the files; manufacturer rows left for you', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';
  const summary = ctx.writeOpsHub();
  const hand = sampleHub(2026, 8); // the numbers worked out by hand from the September files

  // inventory_eom: column F = September, headed with the month-end date; total formula copied from August
  const iv = inv.getDataRange().getValues();
  assert.equal(iv[1][5], SEP);
  assert.equal(inv.rawValues()[0][5], '=SUMIFS(F3:F,$B3:$B,"ADS")');
  for (const r of hand.inventory.filter((x) => x.group === 'ADS' || x.group === 'Amazon')) {
    const row = iv.find((x) => x[1] === r.group && String(x[2]) === r.sku);
    assert.ok(row, r.group + ' ' + r.sku);
    assert.equal(row[5], r.end, r.group + ' ' + r.sku);
  }
  assert.deepEqual(iv.filter((x) => x[1] === 'VitaQuest' || x[1] === 'VitaPros').map((x) => x[5]), ['', ''], 'manufacturer rows blank — not August\'s numbers');
  assert.match(summary, /inventory_eom: Sep 2026 column F added — 12 existing rows filled\./);
  assert.match(summary, /Still blank for Sep 2026: VitaQuest 70003, VitaPros 70003 — type each count in column F/);

  // sell_thru monthly: column G = September units by Channel + SKU; new pairs added at the bottom with the row formulas
  const sv = sell.getDataRange().getValues();
  assert.equal(sv[4][6], SEP);
  for (const r of hand.sellThru) {
    const row = sv.find((x) => x[0] === r.group && String(x[2]) === r.sku);
    assert.ok(row, 'sell_thru row for ' + r.group + ' ' + r.sku);
    assert.equal(row[6], r.qty, r.group + ' ' + r.sku);
  }
  sell.rawValues().slice(7).forEach((x, i) => {
    assert.equal(x[1], '=A' + (i + 8) + '&C' + (i + 8), 'Code formula copied down');
    assert.equal(x[3], desc(i + 8), 'Description formula copied down');
  });

  // wo_log: August rows kept; September = the work-order report's kit lines, oldest first, Cost = Rate, formulas copied down
  const wl = wo.getDataRange().getValues();
  assert.deepEqual(wl.slice(1, 3).map((r) => r.slice(0, 4)), [[D(2026, 7, 3), 200, '10030', 0.54], [D(2026, 7, 24), 22, '10180', 0.54]]);
  assert.deepEqual(wl.slice(3, 6).map((r) => r.slice(0, 4)), hand.woLog.map((k) => [k.serial, k.qty, k.sku, k.cost]));
  assert.equal(wo.rawValues()[4][4], month(5), 'Month formula copied down');

  // sku_matrix: every SKU written is listed; new ones are NEEDS VERIFICATION, existing rows untouched
  const sm = sku.getDataRange().getValues();
  const listed = new Set(sm.slice(1).map((r) => String(r[0])));
  hand.sellThru.concat(hand.inventory.filter((x) => x.end && (x.group === 'ADS' || x.group === 'Amazon'))).forEach((x) => assert.ok(listed.has(x.sku), 'sku_matrix has ' + x.sku));
  assert.deepEqual(sm[1], ['10030', 'Starter Kit - Black 30ct', 'ACTIVE']);
  assert.ok(sm.slice(3).every((r) => r[2] === 'NEEDS VERIFICATION'));

  // wo_sku_fixes: created, starting from the old-layout September report's WO SKU Fixes tab
  assert.deepEqual(fixesTab().rawValues(), [['Reported as (Job, or Description when Job is blank)', 'Our SKU', 'Note'], ['NO GASSY DAYS STARTER KIT 30', '10030', 'typed by hand']]);
  assert.match(summary, /wo_sku_fixes: tab created with the 1 rows of the WO SKU Fixes tab in the September 2026 report/);
  assert.match(summary, /CHECK — manualorder_log: 3 row\(s\) with no Ship Date were not counted/);

  // raw files renamed; nothing else in the folder changed
  assert.deepEqual(names(sep), ['ADS Ending Balance 09.30.2026.csv', 'AMZ Business Report 09.30.2026.csv', 'AMZ Inventory Ledger 09.30.2026.csv',
    'DAIRYPILL_EOM COGS - September 2026', 'Shopify Orders 09.30.2026.csv', 'Work Orders 09.30.2026.xls', 'notes.pdf']);

  // Running again changes nothing
  const once = snap();
  const again = ctx.writeOpsHub();
  assert.match(again, /inventory_eom: Sep 2026 column F replaced/);
  assert.match(again, /wo_log: .* already up to date/);
  assert.match(again, /sku_matrix: no new SKUs/);
  assert.deepEqual(snap(), once);

  // You type the manufacturer counts in Ops Hub; running Write again keeps them
  const vqRow = iv.findIndex((x) => x[1] === 'VitaQuest') + 1, vpRow = iv.findIndex((x) => x[1] === 'VitaPros') + 1;
  inv.getRange(vqRow, 6).setValues([[120]]);
  inv.getRange(vpRow, 6).setValues([['=150*2']]); // even a formula typed there is left alone
  assert.match(ctx.writeOpsHub(), /All have a Sep 2026 count/);
  assert.equal(inv.rawValues()[vqRow - 1][5], 120);
  assert.equal(inv.rawValues()[vpRow - 1][5], '=150*2');
});

test('2. Generate EOM Report (September): Ops Hub\'s numbers locked in; raw reports copied; typed tabs kept on a rerun', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';
  const url = ctx.generateEOMReport();
  assert.match(url, /^https:\/\/docs.google.com/);
  const ss = findFile(sep, 'DAIRYPILL_EOM COGS - September 2026').ss;
  assert.equal(ss.getId(), 'old-sep-report', 'the existing report is rebuilt in place');
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 8));
  const made = Array.from(ctx.tabOrder_(tabs));
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), made.concat(['WO SKU Fixes', 'MFG Counts 09.30.2026']), 'old-layout tabs left at the end');
  assert.match(checksRow(ss, 'Tabs this version does not make')[3], /^WO SKU Fixes, MFG Counts 09\.30\.2026 — left as they were/);

  // SKUs stayed text (the mock turns number-looking text into numbers unless the cell is text-formatted)
  assert.equal(ss.getSheetByName(tabs.shopify).rawValues()[2][6], '80090,80090');
  assert.equal(ss.getSheetByName(tabs.hubInventory).rawValues()[1][1], '10030');

  let wb = calc(ss);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'ADS', '80090'), c)), [200, 0, 5, 195, 170, -25]);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'Amazon', 'A0030'), c)), [120, 15, 20, 115, 115, 0]);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'VitaQuest', '70003'), c)), [100, 0, -20, 120, 120, 0], 'no MFG receipt typed yet');
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'VitaPros', '70003'), c)), [0, 0, -300, 300, 300, 0], 'a count typed as a formula in Ops Hub is copied as its value');
  for (const label of ['Ops Hub ending inventory = ADS snapshot and Amazon ledger', 'Ops Hub units sold = Shopify, manualorder_log and Amazon ledger',
    'Ops Hub kits built = work-order report', 'Amazon starting balance = Ops Hub Aug 2026 ending', 'Manufacturer counts in Ops Hub inventory_eom']) {
    assert.equal(checkResult(ss, wb, label), 'OK', label);
  }
  assert.equal(checkResult(ss, wb, 'Manufacturer rows with negative Sold / Used'), 'CHECK: 2 rows — more arrived than the count shows');
  assert.equal(ss.getSheetByName('Prepaid').rawValues()[1][0], 'POUCHES-26', 'the Prepaid you had is kept');
  assert.equal(wb.value(tabs.variance, rowOf(ss, tabs.variance, 'ADS', '80090'), 11), 'NO COST', 'COGS created blank: NO COST, not $0');

  // You type ADS Receipts, MFG Receipts and COGS — the summaries follow without a rerun; a rerun keeps them
  ss.getSheetByName(tabs.adsReceipts).getRange(2, 1, 1, 3).setValues([['PO-1', '50001', 10]]);
  ss.getSheetByName(tabs.mfgReceipts).getRange(2, 1, 2, 3).setValues([['VitaQuest', '70003', 50], ['VitaPros', '70003', 300]]);
  const cogsSheet = ss.getSheetByName('COGS');
  const typed = Object.fromEntries(rawSep.cogsRows.map((x) => [x[0], x.slice(2, 5)]).concat([['A80004', [1, 0.03, 0]]]));
  cogsSheet.rawValues().forEach((row, i) => { if (i > 0 && typed[row[0]]) cogsSheet.getRange(i + 1, 3, 1, 3).setValues([typed[row[0]]]); });
  wb = calc(ss);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'VitaQuest', '70003'), c)), [100, 50, 30, 120, 120, 0]);

  ctx.generateEOMReport();
  assert.equal(ss.getSheetByName(tabs.mfgReceipts).rawValues()[1][2], 50, 'typed MFG receipts kept');
  wb = calc(ss);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'ADS', '50001'), c)), [50, 10, 3, 57, 48, -9]);
  assert.ok(Math.abs(wb.value(tabs.variance, rowOf(ss, tabs.variance, 'Amazon', 'A80004'), 11) - 1.03) < 1e-9, 'your COGS entry is used');
  assert.equal(checkResult(ss, wb, 'SKUs with no COGS cost'), 'OK');
  assert.equal(checkResult(ss, wb, 'Manufacturer rows with negative Sold / Used'), 'OK');
  assert.match(checksRow(ss, 'Shopify data came from')[3], /reused/);
  assert.match(checksRow(ss, 'Ops Hub numbers used (locked)')[3], /inventory_eom — \d+ rows \(Aug 2026 = Beginning, Sep 2026 = Actual Ending/);
  // nothing anywhere evaluates to an error
  const errs = [];
  for (const s of ss.getSheets()) {
    s.rawValues().forEach((row, i) => row.forEach((x, j) => { if (typeof x === 'string' && x.startsWith('=') && isErr(wb.value(s.getName(), i + 1, j + 1))) errs.push(s.getName() + ' ' + (i + 1) + ',' + (j + 1)); }));
  }
  assert.deepEqual(errs, []);
  assert.ok(names(sep).includes('DairyPill Sell Thru Sep 2026'));
});

test('3. Generate EOM Report before Write month to Ops Hub: stops with a plain message; nothing in the folder or Ops Hub changes', () => {
  const oct = parent.createFolder('October 2026');
  putMonthFiles(oct, sampleRaw(2026, 9));
  ctx.CONFIG.MONTH_OVERRIDE = 'October 2026';
  const before = names(oct), hubBefore = snap();
  assert.throws(() => ctx.generateEOMReport(), /Ops Hub tab "inventory_eom" has no Oct 2026 column yet\. Run EOM → 1\. Write month to Ops Hub for October 2026 first/);
  assert.deepEqual(names(oct), before);
  assert.deepEqual(snap(), hubBefore);
});

test('4. October: Beginning = September\'s Ops Hub column; a blank manufacturer count stays blank; an Ops Hub edit shows on the report with a FLAG', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'October 2026';
  const oct = parent.getFoldersByName('October 2026').next();
  ctx.writeOpsHub();
  const iv = inv.getDataRange().getValues();
  assert.equal(iv[1][6], OCT, 'October in column G, after September');
  // You type VitaPros but not VitaQuest yet; and you correct ADS 80090 in Ops Hub by hand
  inv.getRange(iv.findIndex((x) => x[1] === 'VitaPros') + 1, 7).setValues([[280]]);
  inv.getRange(iv.findIndex((x) => x[1] === 'ADS' && String(x[2]) === '80090') + 1, 7).setValues([[171]]);

  ctx.generateEOMReport();
  const ss = findFile(oct, 'DAIRYPILL_EOM COGS - October 2026').ss;
  const tabs = ctx.tabNames_(ctx.monthInfo_(2026, 9));
  const wb = calc(ss);
  // ADS Beginning = September's Ops Hub column (= September's snapshot); Actual = Ops Hub as edited
  assert.deepEqual([COLS[0], COLS[4]].map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'ADS', '80090'), c)), [170, 171]);
  assert.deepEqual(checksRow(ss, 'Ops Hub ending inventory = ADS snapshot and Amazon ledger').slice(2, 3), ['FLAG: 1 differ']);
  assert.match(checksRow(ss, 'Ops Hub ending inventory = ADS snapshot and Amazon ledger')[3], /^ADS 80090: Ops Hub 171, ADS snapshot 170\./);
  // Rule 4.2: Amazon Beginning = October ledger's 10/01 rows (100 + 20), compared with Ops Hub's September ending (115)
  assert.equal(wb.value(tabs.variance, rowOf(ss, tabs.variance, 'Amazon', 'A0030'), COLS[0]), 120);
  const tie = checksRow(ss, 'Amazon starting balance = Ops Hub Sep 2026 ending');
  assert.equal(tie[2], 'FLAG: 3 differ');
  assert.match(tie[3], /Amazon 50001: Ops Hub Sep 2026 ending 4, ledger 10\/01\/2026 starting 0; Amazon A0030: Ops Hub Sep 2026 ending 115, ledger 10\/01\/2026 starting 120; Amazon A80004: Ops Hub Sep 2026 ending 25, ledger 10\/01\/2026 starting 30/);
  // Manufacturers: Beginning = September's counts; VitaQuest has no October count → blank (not 0) + FLAG
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'VitaQuest', '70003'), c)), [120, 0, '', '', '', '']);
  assert.deepEqual(COLS.map((c) => wb.value(tabs.variance, rowOf(ss, tabs.variance, 'VitaPros', '70003'), c)), [300, 0, 20, 280, 280, 0]);
  assert.equal(checksRow(ss, 'Manufacturer counts in Ops Hub inventory_eom')[2], 'FLAG: 1 row(s) have no Oct 2026 count');
  // Prepaid carried from September; COGS new and blank; no old-layout tabs here
  assert.equal(ss.getSheetByName('Prepaid').rawValues()[1][0], 'POUCHES-26');
  assert.ok(ss.getSheetByName('COGS').rawValues().some((r) => r[0] === 'A80004' && r[2] === ''));
  assert.equal(checksRow(ss, 'Tabs this version does not make'), undefined);
  // Typing the count in Ops Hub and generating again picks it up (the report is locked until then)
  inv.getRange(iv.findIndex((x) => x[1] === 'VitaQuest') + 1, 7).setValues([[110]]);
  assert.equal(calc(ss).value(tabs.variance, rowOf(ss, tabs.variance, 'VitaQuest', '70003'), COLS[4]), '', 'still locked');
  ctx.generateEOMReport();
  assert.equal(calc(ss).value(tabs.variance, rowOf(ss, tabs.variance, 'VitaQuest', '70003'), COLS[4]), 110);
});

test('5. A work-order line with no SKU: listed on Ops Hub wo_sku_fixes and nothing else written; type the SKU and run again', () => {
  const nov = parent.createFolder('November 2026');
  const raw = sampleRaw(2026, 10);
  raw.woHtml = raw.woHtml.replace('<td>2026-11-15</td><td>A0030</td>', '<td>2026-11-15</td><td></td>'); // ADS left Job blank
  putMonthFiles(nov, raw);
  ctx.CONFIG.MONTH_OVERRIDE = 'November 2026';
  const before = snap(), files = names(nov);
  assert.throws(() => ctx.writeOpsHub(), /Nothing was written to Ops Hub for November 2026: 1 work-order line\(s\) \(4 kits\) have no SKU the script can be sure of — WO_2 2026-11-15: Job blank, Description "AMAZON KIT & MAILER 150".*Type our SKU next to each, then run Write month to Ops Hub again/);
  const after = snap();
  assert.deepEqual(after.slice(0, 4), before.slice(0, 4), 'inventory_eom, sell_thru, wo_log, sku_matrix unchanged');
  assert.deepEqual(names(nov), files, 'files not renamed');
  const fx = fixesTab().rawValues();
  assert.deepEqual(fx[2].slice(0, 2), ['AMAZON KIT & MAILER 150', '']);
  fixesTab().getRange(3, 2).setValues([['A0030']]);
  ctx.writeOpsHub();
  const nl = wo.getDataRange().getValues().filter((r) => r[0] >= D(2026, 10, 1) && r[0] <= D(2026, 10, 30)).map((r) => [r[1], r[2]]);
  assert.deepEqual(nl, [[5, '10030'], [4, 'A0030'], [6, 'A0030']]);
});

test('6. The EOM menu asks which month and shows the result, or the plain-English reason it stopped', () => {
  const ui = gas.ui;
  ui.shown.length = 0;
  ui.answers.push(null); // Cancel
  assert.equal(ctx.menuWriteOpsHub(), null);
  ui.answers.push('Sept 2026'); // a typo
  assert.equal(ctx.menuGenerateEOMReport(), null);
  assert.match(ui.shown.at(-1).text, /must look like "September 2026"/);
  ui.answers.push('September 2026');
  assert.match(ctx.menuWriteOpsHub(), /inventory_eom: Sep 2026 column F replaced/);
  assert.equal(ui.shown.at(-1).title, 'Write month to Ops Hub — September 2026: done');
  ui.answers.push(' september 2026 ');
  const url = ctx.menuGenerateEOMReport();
  assert.match(url, /^https:\/\/docs.google.com/);
  const d = ui.shown.at(-1);
  assert.equal(d.kind, 'dialog');
  assert.match(d.text, new RegExp('href="' + url.replace(/[.]/g, '\\.') + '" target="_blank">Open the September 2026 report'));
  ui.answers.push('January 2030');
  assert.equal(ctx.menuWriteOpsHub(), null);
  assert.equal(ui.shown.at(-1).title, 'Write month to Ops Hub — January 2030: stopped');
  assert.match(ui.shown.at(-1).text, /No folder named "January 2030"/);
  assert.match(ui.shown.find((x) => x.kind === 'prompt').text, /^Which month\? Leave blank for /);
});

test('missing or duplicate files stop the run with a clear message', () => {
  const mar = parent.createFolder('March 2027');
  ctx.CONFIG.MONTH_OVERRIDE = 'March 2027';
  assert.throws(() => ctx.generateEOMReport(), /missing: ADS stock snapshot; missing: Amazon Inventory Ledger/);
  assert.throws(() => ctx.writeOpsHub(), /missing: ADS stock snapshot; missing: Amazon Inventory Ledger; missing: Shopify order export/);
  const raw = sampleRaw(2027, 2);
  putMonthFiles(mar, raw);
  mar.createFile('second ledger.csv', csv(raw.ledger));
  assert.throws(() => ctx.writeOpsHub(), /more than one Amazon Inventory Ledger.*keep only this month's/);
  mar.createFile('Book1.xlsx', 'x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => ctx.generateEOMReport(), /Excel file/);
});

test('a ledger that starts on the 2nd stops both steps; a failed run changes nothing in the folder or Ops Hub', () => {
  const dec = parent.createFolder('December 2027');
  const raw = sampleRaw(2027, 11);
  raw.ledger = raw.ledger.filter((r) => !String(r[0]).startsWith('12/01/'));
  putMonthFiles(dec, raw);
  ctx.CONFIG.MONTH_OVERRIDE = 'December 2027';
  const before = names(dec), hubBefore = snap();
  assert.throws(() => ctx.writeOpsHub(), /missing 1 day\(s\): 12\/01\/2027/);
  assert.throws(() => ctx.generateEOMReport(), /missing 1 day\(s\): 12\/01\/2027/);
  assert.deepEqual(names(dec), before, 'no report, Sell Thru or renamed files after a failed check');
  assert.deepEqual(snap(), hubBefore);
});

test('shopifyOnly makes just the Sell Thru file', () => {
  ctx.CONFIG.MONTH_OVERRIDE = 'September 2026';
  ctx.shopifyOnly();
  const st = findFile(sep, 'DairyPill Sell Thru Sep 2026').ss;
  assert.deepEqual(st.getSheets().map((s) => s.getName()), ['Channel Breakdown', 'Order Export']);
  const wb = calc(st);
  const cb = st.getSheetByName('Channel Breakdown').rawValues();
  const row = cb.findIndex((r) => r[0] === '51002') + 1;
  assert.deepEqual(['B', 'C', 'D', 'E', 'F'].map((c) => wb.value('Channel Breakdown', row, c.charCodeAt(0) - 64)), [0, 0, 1, 0, 1]); // DTC, Mktg, CX, TikTok, total
});

test('a Sell Thru file from an older script version is rebuilt, not reused', () => {
  const g = createGas(); const c = load(g);
  const f = g.root.createFolder('x');
  const old = g.spreadsheetWithId('st-old', 'old', f, { 'Order Export': [['Name', 'Order Tags', 'Channel']] });
  const cur = g.spreadsheetWithId('st-new', 'new', f, { 'Order Export': [['Name', 'Counted', 'Counted Qty']] });
  assert.equal(c.sellThruIsCurrent_(old.file), false);
  assert.equal(c.sellThruIsCurrent_(cur.file), true);
});

test('a leftover Manual Orders file, or a Shopify export without status columns, stops the run before anything changes', () => {
  const mar = parent.createFolder('March 2028');
  putMonthFiles(mar, sampleRaw(2028, 2));
  mar.createFile('manual orders.csv', csv([['CUSTOMER', 'ORDER', 'SKU', 'QUANTITY', 'DATE'], ['MANUAL', '150', '50001', '1', '3/2/2028']]));
  ctx.CONFIG.MONTH_OVERRIDE = 'March 2028';
  const before = names(mar), hubBefore = snap();
  for (const run of [ctx.writeOpsHub, ctx.generateEOMReport]) {
    assert.throws(() => run(), /"manual orders.csv" in "March 2028" is a Manual Orders file\. Those are no longer used: shipments out of ADS are read from Ops Hub "manualorder_log" and "amz_log"/);
  }
  assert.deepEqual(names(mar), before, 'nothing renamed, copied or created');

  const apr = parent.createFolder('April 2028');
  const raw2 = sampleRaw(2028, 3);
  raw2.shopify = raw2.shopify.map((r) => r.slice(0, 9)); // no Cancelled at / Lineitem fulfillment status
  putMonthFiles(apr, raw2);
  ctx.CONFIG.MONTH_OVERRIDE = 'April 2028';
  const before2 = names(apr);
  assert.throws(() => ctx.writeOpsHub(), /missing the column "Cancelled at"/);
  assert.throws(() => ctx.generateEOMReport(), /missing the column "Cancelled at"/);
  assert.throws(() => ctx.shopifyOnly(), /missing the column "Cancelled at"/);
  assert.deepEqual(names(apr), before2, 'nothing renamed or created');
  assert.deepEqual(snap(), hubBefore);
});
