// =============================================================================
// DairyPill EOM Report — ENTRY POINTS
//   buildEOM()    builds (or rebuilds) the month's EOM workbook      (Rules 1–12)
//   shopifyOnly() makes only the standalone Shopify Sell Thru file   (Rule 13)
// Pick the function in the toolbar dropdown and press Run.
// =============================================================================

function buildEOM() {
  var startedAt = new Date();
  var m = resolveMonth_(CONFIG.MONTH_OVERRIDE, startedAt);
  var tabs = tabNames_(m);
  var parent = parentFolder_();
  var monthFolder = subfolder_(parent, m.label, true);
  log_('Building ' + workbookName_(m) + ' from folder "' + m.label + '"');

  // Rule 2: recognize every file by its columns.
  var scan = scanFolder_(monthFolder, m);
  requireOneOfEach_(scan, ['ADS', 'LEDGER', 'BIZ', 'SHOPIFY', 'MANUAL', 'WORK_ORDERS'], m.label);
  var e = {};
  ['ADS', 'LEDGER', 'BIZ', 'SHOPIFY', 'MANUAL', 'WORK_ORDERS'].forEach(function (k) { e[k] = scan.byType[k][0]; });

  // Read and check every raw file BEFORE changing anything in Drive (Rule 1.4).
  var shopifyTable = tableFromEntry_(e.SHOPIFY, 'Shopify order export');
  checkShopifyOrdersContiguous_(shopifyTable);
  var ledgerTable = tableFromEntry_(e.LEDGER, 'Amazon Inventory Ledger');
  checkLedgerCoversMonth_(ledgerTable, m);
  var inputs = {
    month: m,
    todayStr: Utilities.formatDate(startedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    builtAt: Utilities.formatDate(startedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' by ' + Session.getActiveUser().getEmail(),
    ads: tableFromEntry_(e.ADS, 'ADS stock snapshot'),
    ledger: ledgerTable,
    biz: tableFromEntry_(e.BIZ, 'Amazon Business Report'),
    shopify: shopifyTable,
    manual: tableFromEntry_(e.MANUAL, 'Manual Orders file'),
    workOrders: parseWorkOrdersHtml_(e.WORK_ORDERS.text, m),
    ignoredFiles: scan.ignored
  };

  // Rule 4: starting balances (also checked before anything is written).
  var start = findStartingBalances_(parent, monthFolder, m);
  inputs.adsStart = start.ads;
  inputs.amzStart = start.amz;
  inputs.bomValues = readBomSource_();

  // Rule 5.7: check the Ops Hub wo_log can take this month's kit lines (written after the workbook).
  var woLog = CONFIG.WO_LOG.enabled ? planWoLogUpdate_(inputs.workOrders, m) : null;
  inputs.woLogNote = woLog ? woLogSummary_(woLog.plan, m) : 'Not updated — WO_LOG.enabled is false in Config.gs.';

  // Rule 13.2: Shopify goes through the standalone Sell Thru file.
  renameEntry_(e.SHOPIFY, tabs.shopify);
  var sell = ensureSellThru_(monthFolder, m, e.SHOPIFY, false);
  inputs.shopifyCopyFrom = { spreadsheetId: sell.id, sheetName: 'Order Export' };
  start.copyAdsStartFile();

  // Workbooks: this month's (create if new) and last month's (for carried tabs).
  var wbFile = fileByName_(monthFolder, workbookName_(m));
  var ss = wbFile ? SpreadsheetApp.open(wbFile) : createSpreadsheetIn_(monthFolder, workbookName_(m));
  var prevFolder = subfolder_(parent, m.prevLabel, false);
  var prevFile = prevFolder ? fileByName_(prevFolder, CONFIG.WORKBOOK_NAME_PREFIX + m.prevLabel) : null;
  var prevSs = prevFile ? SpreadsheetApp.open(prevFile) : null;
  var bootSs = null;
  function boot() { return bootSs || (bootSs = SpreadsheetApp.openById(CONFIG.BOOTSTRAP_WORKBOOK_ID)); }

  // Rule 6.2 / 7.3: COGS and Prepaid — keep this month's, else carry from last month, else first-run workbook.
  var cogsSrc = carriedTab_(ss, prevSs, boot, tabs.cogs, CONFIG.COGS_COLUMNS.key);
  inputs.cogs = cogsSrc.table;
  var prepaidSrc = carriedTab_(ss, prevSs, boot, tabs.prepaid, null, true);
  inputs.prepaid = prepaidSrc ? prepaidSrc.table : null;
  inputs.copyFrom = { cogs: cogsSrc.copyFrom, prepaid: prepaidSrc ? prepaidSrc.copyFrom : null };

  // Rule 6.3: Amazon SKU map — this month's, else last month's.
  var mapSheet = sheetByName_(ss, tabs.skuMap) || (prevSs && sheetByName_(prevSs, tabs.skuMap));
  inputs.skuMapExisting = mapSheet ? readSheetTable_(mapSheet).rows : [];

  // Rule 7: manual tabs (never overwritten).
  inputs.mfgInv = rowsOf_(sheetByName_(ss, tabs.mfgInv));
  inputs.adsReceipts = rowsOf_(sheetByName_(ss, tabs.adsReceipts));
  var prevMfg = prevSs && sheetByName_(prevSs, 'MFG Inventory ' + m.prevEndStr);
  if (prevMfg) {
    inputs.mfgStart = rowsOf_(prevMfg).map(function (r) { return [r[0], r[1], r[3]]; });
    inputs.mfgStartFromPrev = true;
  } else {
    inputs.mfgStart = rowsOf_(sheetByName_(ss, tabs.mfgStart));
    inputs.mfgStartFromPrev = false;
  }

  inputs.sources = {
    startSources: start.sourceText,
    shopifySource: '"' + sellThruName_(m) + '" in the month folder (' + (sell.reused ? 'reused — newer than the Shopify CSV' : 'rebuilt from the Shopify CSV this run') + ').',
    mfgStartSource: prevMfg ? 'Copied from "MFG Inventory ' + m.prevEndStr + '" in the ' + m.prevLabel + ' workbook.' :
      'No ' + m.prevLabel + ' workbook found — first run: type last month\'s MFG EOM quantities on "' + tabs.mfgStart + '".'
  };

  // Build every tab in memory (pure), check formulas are Excel-safe, then write.
  var wb = buildWorkbookModel_(inputs);
  assertExcelSafe_(wb.sheets);
  writeWorkbook_(ss, wb);

  // Rule 5.7: this month's kit lines into the Ops Hub wo_log (re-read so nothing typed meanwhile is lost).
  if (woLog) {
    var wo = planWoLogUpdate_(inputs.workOrders, m);
    applyWoLog_(wo.sheet, wo.plan);
    log_('wo_log: ' + woLogSummary_(wo.plan, m));
  }

  // Rule 2.3: rename raw files to their tab names (after a successful build).
  renameEntry_(e.ADS, tabs.adsEnd);
  renameEntry_(e.LEDGER, tabs.ledger);
  renameEntry_(e.BIZ, tabs.biz);
  renameEntry_(e.WORK_ORDERS, tabs.workOrders);
  renameEntry_(e.MANUAL, tabs.manual);

  log_('Done in ' + Math.round((new Date() - startedAt) / 1000) + 's: ' + ss.getUrl());
  log_('Open the Checks tab first — anything marked FLAG needs attention.');
  return ss.getUrl();
}

function shopifyOnly() {
  var m = resolveMonth_(CONFIG.MONTH_OVERRIDE, new Date());
  var monthFolder = subfolder_(parentFolder_(), m.label, true);
  var scan = scanFolder_(monthFolder, m);
  requireOneOfEach_(scan, ['SHOPIFY'], m.label);
  var entry = scan.byType.SHOPIFY[0];
  renameEntry_(entry, tabNames_(m).shopify);
  var sell = ensureSellThru_(monthFolder, m, entry, true);
  log_('Done: ' + SpreadsheetApp.openById(sell.id).getUrl());
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

/** Rule 13: the standalone Shopify Sell Thru file. Reused if it is newer than the CSV. */
function ensureSellThru_(monthFolder, m, entry, force) {
  var name = sellThruName_(m);
  var file = fileByName_(monthFolder, name);
  if (file && !force && file.getLastUpdated() >= entry.file.getLastUpdated()) {
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
// Rule 4: starting balances
// -----------------------------------------------------------------------------

function findStartingBalances_(parent, monthFolder, m) {
  var tabs = tabNames_(m);
  var prevFolder = subfolder_(parent, m.prevLabel, false);
  var bootFolder = subfolder_(monthFolder, CONFIG.STARTING_BALANCES_SUBFOLDER, false);
  var boot = bootFolder ? scanFolder_(bootFolder, m) : null;
  var notes = [];

  // ADS (Rule 4.1)
  var prevAdsName = 'ADS Ending Balance ' + m.prevEndStr + '.csv';
  var adsFile = prevFolder ? fileByName_(prevFolder, prevAdsName) : null;
  var adsText;
  if (adsFile) {
    adsText = adsFile.getBlob().getDataAsString();
    if (identifyText_(adsText) !== 'ADS') throw new Error('"' + prevAdsName + '" in the ' + m.prevLabel + ' folder is not an ADS stock snapshot.');
    notes.push('ADS: "' + prevAdsName + '" from the ' + m.prevLabel + ' folder');
  } else if (boot && boot.byType.ADS.length === 1) {
    adsFile = boot.byType.ADS[0].file;
    adsText = boot.byType.ADS[0].text;
    notes.push('ADS: "' + adsFile.getName() + '" from the "' + CONFIG.STARTING_BALANCES_SUBFOLDER + '" subfolder (first run)');
  } else {
    throw new Error('Could not find last month\'s ADS ending snapshot. It should be "' + prevAdsName + '" in the "' + m.prevLabel +
      '" folder (made automatically when ' + m.prevLabel + ' was built). First run only: put last month\'s ADS snapshot CSV in a subfolder named "' +
      CONFIG.STARTING_BALANCES_SUBFOLDER + '" inside "' + m.label + '".' + (boot && boot.byType.ADS.length > 1 ? ' (That subfolder has more than one ADS snapshot.)' : ''));
  }

  // Amazon (Rule 4.2)
  var prevLedgerName = 'AMZ Inventory Ledger ' + m.prevEndStr + '.csv';
  var ledFile = prevFolder ? fileByName_(prevFolder, prevLedgerName) : null;
  var ledText, ledLabel;
  if (ledFile) {
    ledText = ledFile.getBlob().getDataAsString();
    if (identifyText_(ledText) !== 'LEDGER') throw new Error('"' + prevLedgerName + '" in the ' + m.prevLabel + ' folder is not an Amazon Inventory Ledger.');
    ledLabel = '"' + prevLedgerName + '" from the ' + m.prevLabel + ' folder';
  } else if (boot && boot.byType.LEDGER.length === 1) {
    ledText = boot.byType.LEDGER[0].text;
    ledLabel = '"' + boot.byType.LEDGER[0].file.getName() + '" from the "' + CONFIG.STARTING_BALANCES_SUBFOLDER + '" subfolder (first run)';
  } else {
    throw new Error('Could not find last month\'s Amazon ledger. It should be "' + prevLedgerName + '" in the "' + m.prevLabel +
      '" folder. First run only: put an Amazon Inventory Ledger that ends on ' + m.prevEndMDY + ' in a subfolder named "' +
      CONFIG.STARTING_BALANCES_SUBFOLDER + '" inside "' + m.label + '".' + (boot && boot.byType.LEDGER.length > 1 ? ' (That subfolder has more than one ledger.)' : ''));
  }
  var amz = ledgerLastDateRows_(toTable_(parseCsv_(ledText), 'starting Amazon ledger'), m.prevEndSerial, 'The starting Amazon ledger (' + ledLabel + ')');
  notes.push('Amazon: last-day (' + m.prevEndMDY + ') rows of ' + ledLabel);

  return {
    ads: toTable_(parseCsv_(adsText), 'starting ADS snapshot'), amz: amz, sourceText: notes.join('; ') + '.',
    // Rule 4.1: a copy of the starting ADS snapshot goes into this month's folder (done after all checks pass).
    copyAdsStartFile: function () {
      var startCopyName = tabs.adsStart + '.csv';
      if (!fileByName_(monthFolder, startCopyName)) adsFile.makeCopy(startCopyName, monthFolder);
    }
  };
}

// -----------------------------------------------------------------------------
// Drive helpers
// -----------------------------------------------------------------------------

function parentFolder_() {
  if (!CONFIG.PARENT_FOLDER_ID || /PASTE/.test(CONFIG.PARENT_FOLDER_ID)) {
    throw new Error('Set PARENT_FOLDER_ID at the top of Config.gs to the ID of the "DairyPill EOM" folder (the part of its link after /folders/).');
  }
  return DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);
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
      (t === 'LEDGER' || t === 'ADS' ? ' (last month\'s file belongs in the "' + CONFIG.STARTING_BALANCES_SUBFOLDER + '" subfolder)' : ''));
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

/**
 * Rule 5.7: reads the Ops Hub wo_log (dates as yyyy-mm-dd in the Ops Hub's time zone) and works out
 * what to write. Stops before anything changes if the tab, a header or a date is wrong.
 */
function planWoLogUpdate_(workOrders, m) {
  var W = CONFIG.WO_LOG;
  var ops = SpreadsheetApp.openById(W.spreadsheetId);
  var sheet = sheetByName_(ops, W.sheetName);
  if (!sheet) throw new Error('The Ops Hub has no tab named "' + W.sheetName + '". Rename it back, or set WO_LOG.enabled to false in Config.gs.');
  var tz = ops.getSpreadsheetTimeZone();
  var values = sheet.getDataRange().getValues().map(function (r) {
    return r.map(function (v) { return Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v; });
  });
  var plan = planWoLog_(values, workOrders, m);
  if (plan.changed && plan.firstRow + plan.rows.length - 1 > sheet.getMaxRows()) {
    throw new Error('The Ops Hub "' + W.sheetName + '" tab needs ' + (plan.firstRow + plan.rows.length - 1) + ' rows but has ' + sheet.getMaxRows() +
      '. Add rows at the bottom and copy the Description/Channel/Month formulas down, then run again.');
  }
  return { sheet: sheet, plan: plan };
}

/** Rule 5.7: writes ONLY the Date, Quantity, SKU and Cost columns; every other column is left alone. */
function applyWoLog_(sheet, plan) {
  if (!plan.changed) return;
  ['date', 'qty', 'sku', 'cost'].forEach(function (k, j) {
    var range = sheet.getRange(plan.firstRow, plan.cols[k] + 1, plan.rows.length, 1);
    if (k === 'sku') range.setNumberFormat('@'); // SKUs stay text (Rule 5.1a)
    range.setValues(plan.rows.map(function (r) { return [r[j]]; }));
  });
}

function readBomSource_() {
  var src = SpreadsheetApp.openById(CONFIG.BOM_SOURCE.spreadsheetId);
  var sheet = sheetByName_(src, CONFIG.BOM_SOURCE.sheetName);
  if (!sheet) throw new Error('The Ops Hub has no tab named "' + CONFIG.BOM_SOURCE.sheetName + '".');
  return sheet.getRange(CONFIG.BOM_SOURCE.columns).getValues();
}

/**
 * Rule 6.2 / 7.3: a carried tab. This month's copy wins; otherwise last month's; otherwise the
 * first-run workbook. Returns {table, copyFrom} (copyFrom null when the tab already exists).
 */
function carriedTab_(ss, prevSs, bootFn, name, keyHeader, optional) {
  var here = sheetByName_(ss, name);
  if (here) return { table: readSheetTable_(here, keyHeader), copyFrom: null };
  // Last month first; the first-run workbook is only opened when last month doesn't have the tab.
  var sources = [function () { return prevSs; }, bootFn];
  for (var i = 0; i < sources.length; i++) {
    var book = sources[i]();
    var s = book && sheetByName_(book, name);
    if (s) return { table: readSheetTable_(s, keyHeader), copyFrom: { spreadsheetId: book.getId(), sheetName: s.getName() } };
  }
  if (optional) return null;
  throw new Error('Could not find a "' + name + '" tab in this month\'s workbook, last month\'s workbook or the first-run workbook.');
}

function rowsOf_(sheet) {
  if (!sheet) return [];
  return readSheetTable_(sheet).rows;
}

function log_(msg) { console.log(msg); }
