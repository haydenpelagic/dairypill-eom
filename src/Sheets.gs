// =============================================================================
// DairyPill EOM Report — WRITING SHEETS (Google calls only; no business logic)
// =============================================================================

/** Sheet by name, ignoring upper/lower case. */
function sheetByName_(ss, name) {
  var target = String(name).toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getName().toLowerCase() === target) return sheets[i];
  return null;
}

/** Table {header, rows} from a sheet; header = first row containing `mustHave`. */
function readSheetTable_(sheet, mustHave) {
  var values = sheet.getDataRange().getValues();
  var hr = 0;
  if (mustHave) {
    hr = -1;
    for (var i = 0; i < Math.min(values.length, 10); i++) if (headerIndex_(values[i], mustHave) >= 0) { hr = i; break; }
    if (hr < 0) throw new Error('Tab "' + sheet.getName() + '" has no "' + mustHave + '" column.');
  }
  var header = values[hr].map(function (h) { return String(h).trim(); });
  var rows = values.slice(hr + 1).filter(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); });
  return { header: header, rows: rows };
}

/** Groups column indexes that share a format into contiguous runs: [[start, count, format]]. */
function formatRuns_(cols, format) {
  var sorted = cols.slice().sort(function (a, b) { return a - b; });
  var runs = [];
  sorted.forEach(function (c) {
    var last = runs[runs.length - 1];
    if (last && last[0] + last[1] === c && last[2] === format) last[1]++;
    else runs.push([c, 1, format]);
  });
  return runs;
}

/** Writes one model. Returns 'kept', 'copied' or 'written'. */
function writeModel_(ss, model) {
  var existing = sheetByName_(ss, model.name);
  if (existing && model.preserveIfExists) return 'kept';
  if (existing) ss.deleteSheet(existing);

  if (model.copyFrom) {
    var src = sheetByName_(SpreadsheetApp.openById(model.copyFrom.spreadsheetId), model.copyFrom.sheetName);
    if (!src) throw new Error('Could not find tab "' + model.copyFrom.sheetName + '" to copy into ' + model.name + '.');
    var copy = src.copyTo(ss);
    copy.setName(model.name);
    if (model.tabColor) copy.setTabColor(model.tabColor);
    return 'copied';
  }

  var values = model.values;
  var width = 1;
  values.forEach(function (r) { if (r.length > width) width = r.length; });
  var height = Math.max(values.length, 1);
  var padded = values.map(function (r) {
    var out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
  if (!padded.length) padded = [new Array(width).fill('')];

  var sheet = ss.insertSheet(model.name);
  if (sheet.getMaxRows() < height) sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  // Formats first, so text SKUs stay text and numbers stay numbers (Rule 5.1a).
  var tFrom = model.textFromRow || 1;
  if (height >= tFrom) {
    formatRuns_(model.textCols || [], '@').forEach(function (run) {
      sheet.getRange(tFrom, run[0] + 1, height - tFrom + 1, run[1]).setNumberFormat('@');
    });
  }
  var nFrom = model.numberFromRow || 2;
  if (height >= nFrom) {
    var byFormat = {};
    Object.keys(model.numberFormats || {}).forEach(function (c) {
      var f = model.numberFormats[c];
      (byFormat[f] = byFormat[f] || []).push(Number(c));
    });
    Object.keys(byFormat).forEach(function (f) {
      formatRuns_(byFormat[f], f).forEach(function (run) {
        sheet.getRange(nFrom, run[0] + 1, height - nFrom + 1, run[1]).setNumberFormat(f);
      });
    });
  }
  (model.extraFormats || []).forEach(function (x) { sheet.getRange(x.row, x.col, x.rows, x.cols).setNumberFormat(x.format); });

  sheet.getRange(1, 1, padded.length, width).setValues(padded);

  // Styling: headers, block headers, subtotals.
  (model.titleRows || []).forEach(function (r) { sheet.getRange(r, 1).setFontWeight('bold').setFontSize(12); });
  (model.headerRows || []).forEach(function (r) {
    sheet.getRange(r, 1, 1, width).setFontWeight('bold').setBackground('#d9e1f2').setWrap(true);
  });
  (model.blockRows || []).forEach(function (r) {
    sheet.getRange(r, 1, 1, width).setFontWeight('bold').setBackground('#eeeeee');
  });
  (model.subtotalRows || []).forEach(function (r) {
    sheet.getRange(r, 1, 1, width).setFontWeight('bold')
      .setBorder(true, null, null, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  });
  if (model.frozenRows) sheet.setFrozenRows(model.frozenRows);
  if (model.tabColor) sheet.setTabColor(model.tabColor);
  if (model.isChecks) {
    var rng = sheet.getRange(2, 3, Math.max(height - 1, 1), 1);
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('FLAG').setBackground('#f4cccc').setRanges([rng]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('CHECK').setBackground('#fff2cc').setRanges([rng]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OK').setBackground('#d9ead3').setRanges([rng]).build()
    ]);
    sheet.setColumnWidth(2, 320);
    sheet.setColumnWidth(3, 320);
    sheet.setColumnWidth(4, 600);
  } else if (height <= 2000 && width <= 30) {
    sheet.autoResizeColumns(1, width);
  }
  return 'written';
}

/** Puts tabs in the README order; tabs not in the list go to the end. */
function orderTabs_(ss, names) {
  names.forEach(function (name, i) {
    var s = sheetByName_(ss, name);
    if (!s) return;
    ss.setActiveSheet(s);
    ss.moveActiveSheet(i + 1);
  });
}
