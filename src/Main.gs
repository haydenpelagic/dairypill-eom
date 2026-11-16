// =============================================================================
// DairyPill EOM Report — ENTRY POINTS (RULES.md section 1)
//   1. writeOpsHub()        the month folder's reports → Ops Hub 2.0              (Rule 15)
//   2. generateEOMReport()  Ops Hub + the reports → the month's EOM report       (Rules 2–12)
//      shopifyOnly()        only the standalone Shopify Sell Thru file            (Rule 13)
// Normally run from Ops Hub's EOM menu (menuWriteOpsHub / menuGenerateEOMReport, Rule 16), which asks
// for the month. From the Apps Script editor: pick the function and press Run (month = MONTH_OVERRIDE).
// =============================================================================

function writeOpsHub() {
  return writeOpsHubFor_(CONFIG.MONTH_OVERRIDE);
}

function generateEOMReport() {
  return generateEOMReportFor_(CONFIG.MONTH_OVERRIDE);
}

function shopifyOnly() {
  return shopifyOnlyFor_(CONFIG.MONTH_OVERRIDE);
}

// -----------------------------------------------------------------------------
// Rule 16: the EOM menu in Ops Hub 2.0. Its small connector script (opshub/OpsHubMenu.gs, pasted once into Ops Hub)
// calls these two through the library. Names must not end in "_" (those are hidden from a library's users).
// -----------------------------------------------------------------------------

function menuWriteOpsHub() {
  return runFromMenu_('Write month to Ops Hub', writeOpsHubFor_, false);
}

function menuGenerateEOMReport() {
  return runFromMenu_('Generate EOM Report', generateEOMReportFor_, true);
}

/** Rule 16: asks which month (blank = last month), runs, and shows the result or the plain-English reason it stopped. */
function runFromMenu_(title, fn, isReport) {
  var ui = SpreadsheetApp.getUi();
  var last = resolveMonth_('', new Date());
  var resp = ui.prompt(title, 'Which month? Leave blank for ' + last.label + ', or type another the same way (e.g. "' + last.label + '").', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;
  var m;
  try {
    m = resolveMonth_(resp.getResponseText(), new Date());
  } catch (err) {
    ui.alert(title, err.message, ui.ButtonSet.OK);
    return null;
  }
  try {
    var out = fn(m.label);
    if (isReport) {
      showLink_(ui, title + ' — ' + m.label, 'The report is ready in the ' + m.label + ' folder. Open the Checks tab first: anything marked FLAG needs attention.',
        out, 'Open the ' + m.label + ' report');
    } else {
      ui.alert(title + ' — ' + m.label + ': done', out, ui.ButtonSet.OK);
    }
    return out;
  } catch (err) {
    console.error(err);
    ui.alert(title + ' — ' + m.label + ': stopped', err.message, ui.ButtonSet.OK);
    return null;
  }
}

/** A small pop-up with a message and a link that opens in a new tab. */
function showLink_(ui, title, text, url, linkText) {
  var esc = function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var html = HtmlService.createHtmlOutput('<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.4"><p>' + esc(text) + '</p><p><a href="' +
    esc(url) + '" target="_blank">' + esc(linkText) + '</a></p></div>').setWidth(440).setHeight(150);
  ui.showModalDialog(html, title);
}

// -----------------------------------------------------------------------------
// Step 1 — Rule 15: Write month to Ops Hub
// -----------------------------------------------------------------------------

/**
 * Rule 15: reads the month folder's reports (ADS snapshot, Amazon ledger, Shopify orders, work orders) and the Ops Hub
 * logs, and writes the month into Ops Hub 2.0: sku_matrix (new SKUs), wo_log (kit lines), inventory_eom (ADS and
 * Amazon rows of the month's column — manufacturer rows are typed by hand) and sell_thru monthly (the month's column).
 * Everything is read and checked first; nothing is written if anything is wrong (the one exception: work-order lines
 * with no SKU are added to wo_sku_fixes so you can type it). Safe to run again: the month is replaced, never doubled.
 * Returns the plain-English summary.
 */
function writeOpsHubFor_(monthText) {
  var startedAt = new Date();
  var m = resolveMonth_(monthText, startedAt);
  var tabs = tabNames_(m);
  var f = monthFiles_(m, ['ADS', 'LEDGER', 'SHOPIFY', 'WORK_ORDERS']);
  log_('Writing ' + m.label + ' into Ops Hub from folder "' + m.label + '"');

  // Read and check every file BEFORE changing anything (Rule 1.4).
  var shopify = tableFromEntry_(f.e.SHOPIFY, 'Shopify order export');
  checkShopifyOrdersContiguous_(shopify);
  var counted = shopifyLinesCounted_(shopify);                // Rule 5.4a: status columns present
  var ledger = tableFromEntry_(f.e.LEDGER, 'Amazon Inventory Ledger');
  checkLedgerCoversMonth_(ledger, m);
  var ads = tableFromEntry_(f.e.ADS, 'ADS stock snapshot');
  var workOrders = parseWorkOrdersHtml_(f.e.WORK_ORDERS.text, m);
  var todayStr = Utilities.formatDate(startedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var hub = openOpsHub_();
  var manualLog = parseOpsLog_(readOpsLogValues_(hub, CONFIG.OPS_HUB.manualLog), 'manual', m);
  var amzLog = parseOpsLog_(readOpsLogValues_(hub, CONFIG.OPS_HUB.amzLog), 'amz', m);
  var bom = bomFromSource_(readBomSource_());

  // Rule 5.5a: every kit line needs a SKU before wo_log is written.
  var fixes = woFixesTab_(hub, f.parent, m);
  var wo = resolveWorkOrderSkus_(workOrders.lines, bom.rows, fixes.rows, todayStr);
  var fixesChanged = fixes.create || woFixRowsKey_(wo.fixRows) !== woFixRowsKey_(fixes.rows);
  if (wo.unresolved.length) {
    writeWoFixes_(hub, fixes, wo.fixRows);
    var kits = wo.unresolved.reduce(function (a, l) { return a + (Number(l.pieces) || 0); }, 0);
    throw new Error('Nothing was written to Ops Hub for ' + m.label + ': ' + wo.unresolved.length + ' work-order line(s) (' + kits +
      ' kits) have no SKU the script can be sure of — ' + wo.unresolved.map(woLineText_).join('; ') + '. They are now listed on Ops Hub "' +
      CONFIG.OPS_HUB.woFixes.sheetName + '" with Our SKU blank. Type our SKU next to each, then run Write month to Ops Hub again.');
  }
  var data = {
    inventory: adsOnHand_(ads).concat(amazonOnHand_(ledger)),
    sellThru: soldByChannel_(shopify, manualLog, ledger),
    kits: kitLines_(wo.lines, m),
    bomDescs: bom.descs
  };

  var W = CONFIG.OPS_HUB_WRITE, tz = hub.getSpreadsheetTimeZone();
  var sheets = {}, hubValues = {};
  ['skuMatrix', 'woLog', 'inventoryEom', 'sellThru'].forEach(function (k) {
    sheets[k] = sheetByName_(hub, W[k].sheetName);
    if (!sheets[k]) throw new Error('Ops Hub 2.0 has no tab named "' + W[k].sheetName + '". Nothing was written.');
    hubValues[k] = datesToSerials_(sheets[k].getDataRange().getValues(), tz);
  });
  var plan = planOpsHubWrite_(data, hubValues, m); // stops here, before any write, if anything is wrong

  if (fixesChanged) writeWoFixes_(hub, fixes, wo.fixRows);
  applySkuMatrix_(sheets.skuMatrix, plan.skuMatrix);
  applyWoLog_(sheets.woLog, plan.woLog, hubValues.woLog[0]);
  applyMonthColumn_(sheets.inventoryEom, plan.inventoryEom);
  applyMonthColumn_(sheets.sellThru, plan.sellThru);
  SpreadsheetApp.flush();

  // Rule 2.3: rename the raw files to their tab names (after a successful write).
  renameEntry_(f.e.ADS, tabs.adsEnd);
  renameEntry_(f.e.LEDGER, tabs.ledger);
  renameEntry_(f.e.SHOPIFY, tabs.shopify);
  renameEntry_(f.e.WORK_ORDERS, tabs.workOrders);
  if (f.e.BIZ) renameEntry_(f.e.BIZ, tabs.biz);

  // Rule 15.6: what was done, and what to look at.
  var lines = opsHubSummary_(plan);
  if (fixes.create) lines.push(CONFIG.OPS_HUB.woFixes.sheetName + ': tab created' + (fixes.seededFrom ? ' with the ' + fixes.rows.length + ' rows of the WO SKU Fixes tab in ' + fixes.seededFrom : '') + '.');
  if (wo.corrected.length) lines.push('CHECK — work-order SKUs not taken from Job (confirm, or change on ' + CONFIG.OPS_HUB.woFixes.sheetName + ' and run again): ' + wo.corrected.map(woLineText_).join('; ') + '.');
  [[CONFIG.OPS_HUB.manualLog.sheetName, manualLog], [CONFIG.OPS_HUB.amzLog.sheetName, amzLog]].forEach(function (p) {
    if (p[1].notShipped) lines.push('CHECK — ' + p[0] + ': ' + p[1].notShipped + ' row(s) with no Ship Date were not counted (not shipped yet).');
  });
  var skipped = counted.filter(function (x) { return !x; }).length;
  if (skipped) lines.push('INFO — ' + skipped + ' Shopify line(s) not counted (cancelled, or refunded/voided and never shipped).');
  lines.push('Next: type any manufacturer counts in ' + W.inventoryEom.sheetName + ', then EOM → Generate EOM Report.');
  lines.forEach(log_);
  log_('Done in ' + Math.round((new Date() - startedAt) / 1000) + 's: ' + hub.getUrl());
  return lines.join('\n');
}

/**
 * Rule 5.5a: the Ops Hub wo_sku_fixes tab: {sheet, rows, create, seededFrom}. When it doesn't exist yet it is started
 * from the WO SKU Fixes tab of this month's or last month's report (where these lived before 2026-11-16).
 */
function woFixesTab_(hub, parent, m) {
  var cfg = CONFIG.OPS_HUB.woFixes;
  var sheet = sheetByName_(hub, cfg.sheetName);
  var three = function (rows) { return rows.map(function (r) { return [r[0], r[1], r[2] === undefined ? '' : r[2]]; }); };
  if (sheet) return { sheet: sheet, rows: three(readSheetTable_(sheet).rows), create: false, seededFrom: null };
  var out = { sheet: null, rows: [], create: true, seededFrom: null };
  [m.label, m.prevLabel].some(function (label) {
    var folder = subfolder_(parent, label, false);
    var file = folder && fileByName_(folder, workbookName_(parseMonthLabel_(label)));
    var tab = file && sheetByName_(SpreadsheetApp.open(file), 'WO SKU Fixes');
    if (!tab) return false;
    out.rows = three(readSheetTable_(tab).rows);
    out.seededFrom = 'the ' + label + ' report';
    return true;
  });
  return out;
}

/** Rule 5.5a: writes the whole wo_sku_fixes list (header + rows, as text), creating the tab if needed. */
function writeWoFixes_(hub, fixes, rows) {
  var cfg = CONFIG.OPS_HUB.woFixes;
  var sheet = fixes.sheet || hub.insertSheet(cfg.sheetName);
  fixes.sheet = sheet;
  var all = [cfg.headers.slice()].concat(rows.map(function (r) { return [textCell_(r[0]), cleanSku_(r[1]), textCell_(r[2])]; }));
  var before = sheet.getLastRow();
  ensureSize_(sheet, Math.max(all.length, before), 3);
  if (before > all.length) sheet.getRange(all.length + 1, 1, before - all.length, 3).clearContent();
  sheet.getRange(1, 1, all.length, 3).setNumberFormat('@');
  sheet.getRange(1, 1, all.length, 3).setValues(all);
}

// -----------------------------------------------------------------------------
// Step 2 — Generate EOM Report (Rules 2–12)
// -----------------------------------------------------------------------------

/**
 * Builds (or rebuilds) the month's report in the month folder: Ops Hub's numbers for the month are copied in and
 * locked (Rule 4 / 9 / 11), the raw reports are copied in for reference, typed tabs are kept. Only READS Ops Hub.
 * Returns the report's link.
 */
function generateEOMReportFor_(monthText) {
  var startedAt = new Date();
  var m = resolveMonth_(monthText, startedAt);
  var tabs = tabNames_(m);
  var f = monthFiles_(m, ['ADS', 'LEDGER', 'BIZ', 'SHOPIFY', 'WORK_ORDERS']);
  log_('Generating ' + workbookName_(m) + ' from Ops Hub and folder "' + m.label + '"');

  // Read and check every raw file and the Ops Hub BEFORE changing anything in Drive (Rule 1.4).
  var shopifyTable = tableFromEntry_(f.e.SHOPIFY, 'Shopify order export');
  checkShopifyOrdersContiguous_(shopifyTable);
  shopifyLinesCounted_(shopifyTable);                      // Rule 5.4a: status columns present
  var ledgerTable = tableFromEntry_(f.e.LEDGER, 'Amazon Inventory Ledger');
  checkLedgerCoversMonth_(ledgerTable, m);
  var inputs = {
    month: m,
    todayStr: Utilities.formatDate(startedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    builtAt: Utilities.formatDate(startedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' by ' + Session.getActiveUser().getEmail(),
    ads: tableFromEntry_(f.e.ADS, 'ADS stock snapshot'),
    ledger: ledgerTable,
    biz: tableFromEntry_(f.e.BIZ, 'Amazon Business Report'),
    shopify: shopifyTable,
    workOrders: parseWorkOrdersHtml_(f.e.WORK_ORDERS.text, m),
    ignoredFiles: f.scan.ignored
  };

  var hub = openOpsHub_(), tz = hub.getSpreadsheetTimeZone(), W = CONFIG.OPS_HUB_WRITE;
  inputs.bomValues = readBomSource_();
  inputs.manualLog = parseOpsLog_(readOpsLogValues_(hub, CONFIG.OPS_HUB.manualLog), 'manual', m);
  inputs.amzLog = parseOpsLog_(readOpsLogValues_(hub, CONFIG.OPS_HUB.amzLog), 'amz', m);
  var fixSheet = sheetByName_(hub, CONFIG.OPS_HUB.woFixes.sheetName);
  inputs.woFixes = fixSheet ? readSheetTable_(fixSheet).rows : [];
  var hv = {};
  ['inventoryEom', 'sellThru', 'woLog'].forEach(function (k) {
    var sh = sheetByName_(hub, W[k].sheetName);
    if (!sh) throw new Error('Ops Hub 2.0 has no tab named "' + W[k].sheetName + '". Nothing was generated.');
    hv[k] = datesToSerials_(sh.getDataRange().getValues(), tz);
  });
  inputs.hub = readHubMonth_(hv, m); // stops here if Write month to Ops Hub hasn't been run for the month

  // Rule 13.2: Shopify goes through the standalone Sell Thru file.
  renameEntry_(f.e.SHOPIFY, tabs.shopify);
  var sell = ensureSellThru_(f.monthFolder, m, f.e.SHOPIFY, false);
  inputs.shopifyCopyFrom = { spreadsheetId: sell.id, sheetName: 'Order Export' };

  // The report: this month's (create if new); last month's only for carrying Prepaid (Rule 7.3).
  var wbFile = fileByName_(f.monthFolder, workbookName_(m));
  var ss = wbFile ? SpreadsheetApp.open(wbFile) : createSpreadsheetIn_(f.monthFolder, workbookName_(m));
  var prevFolder = subfolder_(f.parent, m.prevLabel, false);
  var prevFile = prevFolder ? fileByName_(prevFolder, CONFIG.WORKBOOK_NAME_PREFIX + m.prevLabel) : null;
  var prevSs = prevFile ? SpreadsheetApp.open(prevFile) : null;

  // Rule 6.2: COGS is typed by hand each month — this month's tab if it exists, else created blank (never carried).
  var cogsSheet = sheetByName_(ss, tabs.cogs);
  inputs.cogs = cogsSheet ? readSheetTable_(cogsSheet, CONFIG.COGS_COLUMNS.key) : null;
  var prepaidSrc = carriedTab_(ss, prevSs, tabs.prepaid);
  inputs.prepaid = prepaidSrc ? prepaidSrc.table : null;
  inputs.copyFrom = { prepaid: prepaidSrc ? prepaidSrc.copyFrom : null };
  // Rule 7: typed tabs (never overwritten).
  inputs.adsReceipts = rowsOf_(sheetByName_(ss, tabs.adsReceipts));
  inputs.mfgReceipts = rowsOf_(sheetByName_(ss, tabs.mfgReceipts));
  inputs.sources = {
    shopifySource: '"' + sellThruName_(m) + '" in the month folder (' + (sell.reused ? 'reused — newer than the Shopify CSV' : 'rebuilt from the Shopify CSV this run') + ').'
  };
  // Tabs this version doesn't make (e.g. MFG Counts from the old layout) are left alone and listed on Checks.
  var made = tabOrder_(tabs).map(function (n) { return n.toLowerCase(); }).concat(['sheet1', '_building']);
  inputs.extraTabs = ss.getSheets().map(function (sh) { return sh.getName(); }).filter(function (n) { return made.indexOf(n.toLowerCase()) < 0; });

  // Build every tab in memory (pure), check formulas are Excel-safe, then write.
  var wb = buildWorkbookModel_(inputs);
  assertExcelSafe_(wb.sheets);
  writeWorkbook_(ss, wb);

  // Rule 2.3: rename raw files to their tab names (after a successful build).
  renameEntry_(f.e.ADS, tabs.adsEnd);
  renameEntry_(f.e.LEDGER, tabs.ledger);
  renameEntry_(f.e.BIZ, tabs.biz);
  renameEntry_(f.e.WORK_ORDERS, tabs.workOrders);

  log_('Done in ' + Math.round((new Date() - startedAt) / 1000) + 's: ' + ss.getUrl());
  log_('Open the Checks tab first — anything marked FLAG needs attention.');
  return ss.getUrl();
}

/** Rule 13: only the standalone Sell Thru file. Returns its link. */
function shopifyOnlyFor_(monthText) {
  var m = resolveMonth_(monthText, new Date());
  var monthFolder = subfolder_(parentFolder_(), m.label, true);
  var scan = scanFolder_(monthFolder, m);
  requireOneOfEach_(scan, ['SHOPIFY'], m.label);
  var entry = scan.byType.SHOPIFY[0];
  var table = tableFromEntry_(entry, 'Shopify order export'); // check before changing anything (Rule 1.4)
  checkShopifyOrdersContiguous_(table);
  shopifyLinesCounted_(table);
  renameEntry_(entry, tabNames_(m).shopify);
  var sell = ensureSellThru_(monthFolder, m, entry, true);
  var url = SpreadsheetApp.openById(sell.id).getUrl();
  log_('Done: ' + url);
  return url;
}

/**
 * Rule 2: the month folder's files, recognized by their columns; exactly one of each type in `types` (Rule 2.1).
 * A leftover Manual Orders file stops the run (Rule 2.5). Returns {parent, monthFolder, scan, e: {type: entry}}.
 */
function monthFiles_(m, types) {
  var parent = parentFolder_();
  var monthFolder = subfolder_(parent, m.label, true);
  var scan = scanFolder_(monthFolder, m);
  if (scan.byType.MANUAL.length) {
    // Rule 2.5: shipments out of ADS now come from the Ops Hub logs; a file as well would double count.
    throw new Error('"' + scan.byType.MANUAL[0].file.getName() + '" in "' + m.label + '" is a Manual Orders file. Those are no longer used: ' +
      'shipments out of ADS are read from Ops Hub "' + CONFIG.OPS_HUB.manualLog.sheetName + '" and "' + CONFIG.OPS_HUB.amzLog.sheetName +
      '". Make sure they are there, then remove the file from the folder and run again.');
  }
  requireOneOfEach_(scan, types, m.label);
  var e = {};
  Object.keys(scan.byType).forEach(function (k) { if (scan.byType[k].length === 1) e[k] = scan.byType[k][0]; });
  return { parent: parent, monthFolder: monthFolder, scan: scan, e: e };
}

function openOpsHub_() {
  try {
    return SpreadsheetApp.openById(CONFIG.OPS_HUB.spreadsheetId);
  } catch (err) {
    throw new Error('Could not open Ops Hub 2.0 as ' + Session.getActiveUser().getEmail() + '. Run this from an account that can edit Ops Hub 2.0. (' + err.message + ')');
  }
}

// -----------------------------------------------------------------------------
// Rule 15: applying the Ops Hub write plan
// -----------------------------------------------------------------------------

/** Dates read from a sheet become date numbers (in the sheet's time zone), so they compare exactly. */
function datesToSerials_(values, tz) {
  return values.map(function (r) {
    return r.map(function (v) {
      if (Object.prototype.toString.call(v) !== '[object Date]') return v;
      return parseMDY_(Utilities.formatDate(v, tz, 'yyyy-MM-dd'), '');
    });
  });
}

/** Grows the sheet so (rows, cols) fits. */
function ensureSize_(sheet, rows, cols) {
  if (rows > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (cols > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

/** Rule 15.5: new SKUs at the bottom of sku_matrix (SKU as text, Description, Status). */
function applySkuMatrix_(sheet, plan) {
  if (!plan.rows.length) return;
  var n = plan.rows.length;
  ensureSize_(sheet, plan.startRow + n - 1, Math.max(plan.cols.sku, plan.cols.desc, plan.cols.status));
  sheet.getRange(plan.startRow, plan.cols.sku, n, 1).setNumberFormat('@'); // SKUs stay text (Rule 5.1a)
  ['sku', 'desc', 'status'].forEach(function (k, j) {
    sheet.getRange(plan.startRow, plan.cols[k], n, 1).setValues(plan.rows.map(function (r) { return [r[j]]; }));
  });
}

/**
 * Rule 15.4: writes ONLY Date, Quantity, SKU and Cost from plan.firstRow down. A written row whose Month / Channel
 * formula cell is empty gets the formula of the row above (copied, so it points at its own row).
 */
function applyWoLog_(sheet, plan, header) {
  if (!plan.changed) return;
  var n = plan.rows.length, first = plan.firstRow;
  ensureSize_(sheet, first + n - 1, Math.max(plan.cols.date, plan.cols.qty, plan.cols.sku, plan.cols.cost));
  sheet.getRange(first, plan.cols.date, n, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(first, plan.cols.sku, n, 1).setNumberFormat('@');
  sheet.getRange(first, plan.cols.cost, n, 1).setNumberFormat('"$"#,##0.00');
  ['date', 'qty', 'sku', 'cost'].forEach(function (k, j) {
    sheet.getRange(first, plan.cols[k], n, 1).setValues(plan.rows.map(function (r) { return [r[j]]; }));
  });
  CONFIG.OPS_HUB_WRITE.woLog.formulaHeaders.forEach(function (h) {
    var c = headerIndex_(header, h);
    if (c < 0 || first < 3) return;
    var formulas = sheet.getRange(first, c + 1, n, 1).getFormulas();
    for (var i = 0; i < n; i++) {
      if (formulas[i][0] || woLogRowKey_(plan.rows[i]) === woLogRowKey_(['', '', '', ''])) continue;
      sheet.getRange(first + i - 1, c + 1).copyTo(sheet.getRange(first + i, c + 1));
    }
  });
}

/**
 * Rules 15.2 / 15.3: the month's column and any new rows. A new column is first copied from last month's column
 * (header formats and the total formulas above the table follow), then its header is set to the month-end date
 * and every row's number is written. New rows: group and SKU (as text); Code / Description copy the formula of
 * the row above when it has one, otherwise get Group+SKU / the SKU's description as plain text.
 */
function applyMonthColumn_(sheet, plan) {
  ensureSize_(sheet, plan.rowsNeeded, plan.colsNeeded);
  if (plan.isNew) {
    sheet.getRange(1, plan.copyFromCol, plan.lastDataRowBefore, 1).copyTo(sheet.getRange(1, plan.col, plan.lastDataRowBefore, 1));
    sheet.getRange(plan.firstRow - 1, plan.col).setValues([[plan.headerSerial]]);
  }
  plan.newRows.forEach(function (nr) {
    sheet.getRange(nr.row, plan.skuCol).setNumberFormat('@');
    sheet.getRange(nr.row, plan.groupCol).setValues([[nr.group]]);
    sheet.getRange(nr.row, plan.skuCol).setValues([[nr.sku]]);
    [[plan.codeCol, nr.code], [plan.descCol, nr.desc]].forEach(function (p) {
      if (!p[0]) return;
      var formula = plan.templateRow ? sheet.getRange(plan.templateRow, p[0]).getFormula() : '';
      if (formula) sheet.getRange(plan.templateRow, p[0]).copyTo(sheet.getRange(nr.row, p[0]));
      else sheet.getRange(nr.row, p[0]).setNumberFormat('@').setValues([[p[1]]]);
    });
  });
  // Rule 15.2: write only the cells the plan sets — null = a row typed by hand (or a blank row): leave it alone.
  var start = null, cv = plan.colValues;
  for (var i = 0; i <= cv.length; i++) {
    var v = i < cv.length ? cv[i][0] : null;
    if (v !== null && start === null) start = i;
    if (v === null && start !== null) {
      sheet.getRange(plan.firstRow + start, plan.col, i - start, 1).setValues(cv.slice(start, i));
      start = null;
    }
  }
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

/**
 * Deletes the tabs being rebuilt first, then writes sources before the tabs whose
 * formulas point at them, so no formula ever points at a missing tab.
 */
function writeWorkbook_(ss, wb) {
  var temp = sheetByName_(ss, '_building') || ss.insertSheet('_building');
  wb.sheets.forEach(function (s) {
    var existing = sheetByName_(ss, s.name);
    if (existing && !s.preserveIfExists) ss.deleteSheet(existing);
  });
  var t = wb.tabs;
  var last = [t.bundleMap, t.kit, t.variance, t.valuation, t.outbound, t.checks, t.readme];
  var ordered = wb.sheets.filter(function (s) { return last.indexOf(s.name) < 0; })
    .concat(last.map(function (n) { return wb.sheets.filter(function (s) { return s.name === n; })[0]; }));
  ordered.forEach(function (s) {
    var how = writeModel_(ss, s);
    log_('  ' + s.name + ': ' + how);
  });
  orderTabs_(ss, tabOrder_(t));
  ['Sheet1', '_building'].forEach(function (n) {
    var s = sheetByName_(ss, n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  ss.setActiveSheet(sheetByName_(ss, t.checks));
  SpreadsheetApp.flush();
}

/** A Sell Thru file built by an older version of the script lacks the Counted Qty column (Rule 5.4a) and is rebuilt. */
function sellThruIsCurrent_(file) {
  var sh = sheetByName_(SpreadsheetApp.open(file), 'Order Export');
  if (!sh) return false;
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  return header[header.length - 1] === 'Counted Qty';
}

/** Rule 13: the standalone Shopify Sell Thru file. Reused if it is newer than the CSV (and built by this version). */
function ensureSellThru_(monthFolder, m, entry, force) {
  var name = sellThruName_(m);
  var file = fileByName_(monthFolder, name);
  if (file && !force && file.getLastUpdated() >= entry.file.getLastUpdated() && sellThruIsCurrent_(file)) {
    return { id: file.getId(), reused: true };
  }
  var ss = file ? SpreadsheetApp.open(file) : createSpreadsheetIn_(monthFolder, name);
  var table = tableFromEntry_(entry, 'Shopify order export');
  var temp = sheetByName_(ss, '_building') || ss.insertSheet('_building');
  ['Channel Breakdown', 'Order Export'].forEach(function (n) { var s = sheetByName_(ss, n); if (s) ss.deleteSheet(s); });
  var models = [shopifyModel_('Order Export', table), channelBreakdownModel_(table, 'Order Export')];
  assertExcelSafe_(models);
  models.forEach(function (x) { writeModel_(ss, x); });
  orderTabs_(ss, ['Channel Breakdown', 'Order Export']);
  ['Sheet1', '_building'].forEach(function (n) { var s = sheetByName_(ss, n); if (s && ss.getSheets().length > 1) ss.deleteSheet(s); });
  SpreadsheetApp.flush();
  log_('Sell Thru file ' + (file ? 'rebuilt' : 'created') + ': ' + ss.getUrl());
  return { id: ss.getId(), reused: false };
}

// -----------------------------------------------------------------------------
// Drive helpers
// -----------------------------------------------------------------------------

function parentFolder_() {
  if (!CONFIG.PARENT_FOLDER_ID || /PASTE/.test(CONFIG.PARENT_FOLDER_ID)) {
    throw new Error('Set PARENT_FOLDER_ID at the top of Config.gs to the ID of the "EOM Reports" folder (the part of its link after /folders/).');
  }
  try {
    return DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);
  } catch (err) {
    throw new Error('Could not open the EOM Reports folder (ID ' + CONFIG.PARENT_FOLDER_ID + ') as ' + Session.getActiveUser().getEmail() +
      '. Share that folder with this Google account (Editor), or run the script from an account that has access. (' + err.message + ')');
  }
}

function subfolder_(parent, name, required) {
  var it = parent.getFoldersByName(name), found = [];
  while (it.hasNext()) found.push(it.next());
  if (found.length > 1) throw new Error('There are ' + found.length + ' folders named "' + name + '" in "' + parent.getName() + '". Keep only one.');
  if (!found.length && required) throw new Error('No folder named "' + name + '" inside "' + parent.getName() + '". Create it and put the month\'s reports in it.');
  return found[0] || null;
}

function fileByName_(folder, name) {
  var it = folder.getFilesByName(name), found = [];
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) found.push(f); }
  if (found.length > 1) throw new Error('There are ' + found.length + ' files named "' + name + '" in "' + folder.getName() + '". Keep only one.');
  return found[0] || null;
}

function createSpreadsheetIn_(folder, name) {
  var ss = SpreadsheetApp.create(name);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

/** Rule 2: every file in the folder, recognized by its columns. Subfolders are not scanned. */
function scanFolder_(folder, m) {
  var skip = [workbookName_(m), sellThruName_(m)];
  var byType = { ADS: [], LEDGER: [], BIZ: [], SHOPIFY: [], MANUAL: [], WORK_ORDERS: [] };
  var ignored = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    var name = file.getName(), mime = file.getMimeType();
    // "ADS Starting Balance …" files were copied in by the old layout (before 2026-11-16): not this month's snapshot.
    if (file.isTrashed() || skip.indexOf(name) >= 0 || name.indexOf('ADS Starting Balance ') === 0) continue;
    var type = null, entry = { file: file };
    if (mime === MimeType.GOOGLE_SHEETS) {
      var values = SpreadsheetApp.open(file).getSheets()[0].getDataRange().getValues();
      type = identifyHeader_(values[0] || []);
      entry.values = values;
    } else if (/\.xlsx$/i.test(name) || mime === MimeType.MICROSOFT_EXCEL) {
      throw new Error('"' + name + '" is an Excel file, which the script cannot read. Open it in Google Sheets (File → Save as Google Sheets) or download it as CSV, and remove the .xlsx from the folder.');
    } else if (/\.(csv|xls|txt|html?)$/i.test(name) || /^text\//.test(mime)) {
      entry.text = file.getBlob().getDataAsString();
      type = identifyText_(entry.text);
    }
    if (type) byType[type].push(entry); else ignored.push(name);
  }
  return { byType: byType, ignored: ignored };
}

function requireOneOfEach_(scan, types, folderName) {
  var problems = [];
  types.forEach(function (t) {
    var list = scan.byType[t], label = CONFIG.FILE_TYPES[t].label;
    if (!list.length) problems.push('missing: ' + label);
    if (list.length > 1) problems.push('more than one ' + label + ': ' + list.map(function (x) { return '"' + x.file.getName() + '"'; }).join(', ') +
      (t === 'LEDGER' || t === 'ADS' ? ' (keep only this month\'s — last month\'s numbers come from Ops Hub)' : ''));
  });
  if (problems.length) throw new Error('Folder "' + folderName + '": ' + problems.join('; ') + '.');
}

function tableFromEntry_(entry, label) {
  return toTable_(entry.text !== undefined ? parseCsv_(entry.text) : entry.values, label);
}

/** Renames a raw file to its tab name, keeping the extension (Rule 2.3). */
function renameEntry_(entry, base) {
  var name = entry.file.getName();
  var ext = /\.[A-Za-z0-9]+$/.exec(name);
  var target = base + (ext && entry.file.getMimeType() !== MimeType.GOOGLE_SHEETS ? ext[0] : '');
  if (name !== target) entry.file.setName(target);
}

/** Rule 5.6: an Ops Hub shipment log's columns (header in one of the top rows; columns found by name). */
function readOpsLogValues_(hub, cfg) {
  var sheet = sheetByName_(hub, cfg.sheetName);
  if (!sheet) throw new Error('Ops Hub has no tab named "' + cfg.sheetName + '".');
  return sheet.getRange(cfg.columns).getValues();
}

function readBomSource_() {
  var src = SpreadsheetApp.openById(CONFIG.BOM_SOURCE.spreadsheetId);
  var sheet = sheetByName_(src, CONFIG.BOM_SOURCE.sheetName);
  if (!sheet) throw new Error('The Ops Hub has no tab named "' + CONFIG.BOM_SOURCE.sheetName + '".');
  return sheet.getRange(CONFIG.BOM_SOURCE.columns).getValues();
}

/** Rule 7.3: a carried tab — this month's copy wins, otherwise last month's (copied in), otherwise null. */
function carriedTab_(ss, prevSs, name) {
  var here = sheetByName_(ss, name);
  if (here) return { table: readSheetTable_(here), copyFrom: null };
  var s = prevSs && sheetByName_(prevSs, name);
  return s ? { table: readSheetTable_(s), copyFrom: { spreadsheetId: prevSs.getId(), sheetName: s.getName() } } : null;
}

function rowsOf_(sheet) {
  if (!sheet) return [];
  return readSheetTable_(sheet).rows;
}

function log_(msg) { console.log(msg); }
