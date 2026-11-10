// =============================================================================
// DairyPill EOM Report — LOGIC (pure functions, no Google calls)
// Everything here turns raw file contents into "sheet models" (rows of values
// and formulas). Main.gs reads the files and Sheets.gs writes the models.
// Rule numbers refer to RULES.md.
// =============================================================================

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

var FORBIDDEN_FUNCTIONS = ['XLOOKUP', 'UNIQUE', 'FILTER', 'VSTACK', 'HSTACK', 'LET', 'ARRAYFORMULA',
  'ARRAY_CONSTRAIN', 'IMPORTRANGE', 'QUERY', 'SORT', 'SPLIT', 'REGEXMATCH', 'LAMBDA', 'MAP'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A SKU as trimmed text ("10030", never the number 10030). Rule 5.1(a). */
function cleanSku_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Converts "2,814", "$70,033.49", "30.78%", "-3" to numbers; "" stays "". Loud on garbage. */
function toNumber_(v, where) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (s === '') return '';
  var pct = /%$/.test(s);
  var neg = /^\(.*\)$/.test(s);
  var t = s.replace(/[$,%\s()]/g, '');
  var n = Number(t);
  if (t === '' || isNaN(n)) {
    throw new Error('Expected a number ' + (where || '') + ' but found "' + s + '".');
  }
  if (neg) n = -n;
  return pct ? n / 100 : n;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** 1 -> A, 27 -> AA */
function colLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

function normHeader_(h) {
  return String(h === null || h === undefined ? '' : h).replace(/^﻿/, '').trim().toLowerCase();
}

/** Index of a header (case-insensitive), or -1. */
function headerIndex_(header, name) {
  var target = normHeader_(name);
  for (var i = 0; i < header.length; i++) if (normHeader_(header[i]) === target) return i;
  return -1;
}

/** Index of a header, or a loud error naming the file and the missing column. */
function requireHeader_(header, name, fileLabel) {
  var i = headerIndex_(header, name);
  if (i < 0) throw new Error('The ' + fileLabel + ' is missing the column "' + name + '". Columns found: ' + header.join(', '));
  return i;
}

/** Whole-column reference to another tab: 'Tab Name'!H:H  (Rule 14.2) */
function colRef_(tab, letter) {
  return "'" + String(tab).replace(/'/g, "''") + "'!" + letter + ':' + letter;
}

/** Text inside a formula: "abc" with quotes doubled. */
function q_(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

/** Days since 1899-12-30 (the spreadsheet date number) — avoids time-zone shifts. */
function dateSerial_(year, monthIndex, day) {
  return Math.round((Date.UTC(year, monthIndex, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

function serialToMDY_(serial) {
  var d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  return pad2_(d.getUTCMonth() + 1) + '/' + pad2_(d.getUTCDate()) + '/' + d.getUTCFullYear();
}

/** "09/30/2026" (or a spreadsheet date number) -> date number. */
function parseMDY_(v, where) {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return dateSerial_(v.getFullYear(), v.getMonth(), v.getDate());
  var iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(String(v));
  if (iso) return dateSerial_(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  var m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(v));
  if (!m) throw new Error('Expected a date like 09/30/2026 ' + (where || '') + ' but found "' + v + '".');
  return dateSerial_(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function uniqueSorted_(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (x) {
    if (x === '' || x === null || x === undefined) return;
    if (!seen[x]) { seen[x] = true; out.push(x); }
  });
  return out.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
}

function textCell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return (v.getMonth() + 1) + '/' + v.getDate() + '/' + v.getFullYear();
  return String(v);
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180) — used for every CSV so behaviour is identical everywhere
// ---------------------------------------------------------------------------

function parseCsv_(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var rows = [], row = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (f) { return String(f).trim() !== ''; }); });
}

/** First line of a CSV only (fast file recognition). */
function csvHeader_(text) {
  var end = text.search(/\r?\n/);
  var first = end < 0 ? text : text.slice(0, end);
  var rows = parseCsv_(first);
  return rows.length ? rows[0] : [];
}

/** {header, rows} with every row padded to the header width. */
function toTable_(rows, label) {
  if (!rows.length) throw new Error('The ' + label + ' is empty.');
  var header = rows[0].map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
  var body = rows.slice(1).map(function (r) {
    var out = r.slice(0, header.length);
    while (out.length < header.length) out.push('');
    return out;
  });
  return { header: header, rows: body };
}

// ---------------------------------------------------------------------------
// Rule 2: recognize files by their columns
// ---------------------------------------------------------------------------

/**
 * Rule 2.2a: an ADS snapshot as a comparable list of "SKU|Lot|Qty On Hand" (sorted), so two
 * snapshots can be checked for being the same report whatever their file names, cell types or row order.
 */
function adsSignature_(table) {
  var A = CONFIG.COLUMNS.ADS;
  var si = requireHeader_(table.header, A.sku, 'ADS stock snapshot');
  var li = requireHeader_(table.header, 'Lot Code', 'ADS stock snapshot');
  var qi = requireHeader_(table.header, A.qty, 'ADS stock snapshot');
  return table.rows.filter(function (r) { return cleanSku_(r[si]) !== ''; }).map(function (r) {
    var q = toNumber_(r[qi], 'in the ADS stock snapshot (' + A.qty + ')');
    return cleanSku_(r[si]) + '|' + textCell_(r[li]).trim() + '|' + (q === '' ? 0 : q);
  }).sort().join('\n');
}

/** Rule 2.2a: an ADS snapshot pasted into a sheet with a title above it — the table starts at the "Stock Number" row. */
function adsTableFromSheetValues_(values, label) {
  for (var i = 0; i < Math.min(values.length, 10); i++) {
    if (headerIndex_(values[i], CONFIG.COLUMNS.ADS.sku) >= 0) return toTable_(values.slice(i), label);
  }
  throw new Error('Could not find the "' + CONFIG.COLUMNS.ADS.sku + '" header in ' + label + '.');
}

/**
 * Rule 2.2a: of several ADS snapshot tables, the index of the one identical to `reference`.
 * Exactly one must match, or the run stops (it never guesses).
 */
function matchingAdsSnapshot_(tables, reference, names, refLabel) {
  var ref = adsSignature_(reference);
  var hits = [];
  tables.forEach(function (t, i) { if (adsSignature_(t) === ref) hits.push(i); });
  if (hits.length === 1) return hits[0];
  throw new Error('There are ' + tables.length + ' ADS stock snapshots in the month folder (' + names.join(', ') + ') and ' +
    (hits.length ? 'more than one' : 'none') + ' of them matches ' + refLabel + ', so the script cannot tell which is last month\'s ending. ' +
    'Keep only this month\'s snapshot in the folder and put last month\'s in a subfolder named "' + CONFIG.STARTING_BALANCES_SUBFOLDER + '".');
}

function identifyHeader_(header) {
  var types = CONFIG.FILE_TYPES;
  for (var key in types) {
    if (!types[key].headers) continue;
    var ok = types[key].headers.every(function (h) { return headerIndex_(header, h) >= 0; });
    if (ok) return key;
  }
  return null;
}

function identifyText_(text) {
  if (text.indexOf(CONFIG.FILE_TYPES.WORK_ORDERS.marker) >= 0) return 'WORK_ORDERS';
  return identifyHeader_(csvHeader_(text));
}

// ---------------------------------------------------------------------------
// Rule 1.2 / 3: months and tab names
// ---------------------------------------------------------------------------

function monthInfo_(year, monthIndex) {
  var lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  var prevYear = monthIndex === 0 ? year - 1 : year;
  var prevMonthIndex = monthIndex === 0 ? 11 : monthIndex - 1;
  var prevLastDay = new Date(Date.UTC(prevYear, prevMonthIndex + 1, 0)).getUTCDate();
  return {
    year: year,
    monthIndex: monthIndex,
    label: MONTH_NAMES[monthIndex] + ' ' + year,
    shortLabel: MONTH_NAMES[monthIndex].slice(0, 3) + ' ' + year,
    yyyymm: year + '-' + pad2_(monthIndex + 1),
    lastDay: lastDay,
    firstSerial: dateSerial_(year, monthIndex, 1),
    endSerial: dateSerial_(year, monthIndex, lastDay),
    endStr: pad2_(monthIndex + 1) + '.' + pad2_(lastDay) + '.' + year,
    endMDY: pad2_(monthIndex + 1) + '/' + pad2_(lastDay) + '/' + year,
    prevLabel: MONTH_NAMES[prevMonthIndex] + ' ' + prevYear,
    prevEndSerial: dateSerial_(prevYear, prevMonthIndex, prevLastDay),
    prevEndStr: pad2_(prevMonthIndex + 1) + '.' + pad2_(prevLastDay) + '.' + prevYear,
    prevEndMDY: pad2_(prevMonthIndex + 1) + '/' + pad2_(prevLastDay) + '/' + prevYear
  };
}

/** "September 2026" -> monthInfo. Loud on anything else. */
function parseMonthLabel_(s) {
  var m = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(String(s));
  if (m) {
    for (var i = 0; i < 12; i++) {
      if (MONTH_NAMES[i].toLowerCase() === m[1].toLowerCase()) return monthInfo_(Number(m[2]), i);
    }
  }
  throw new Error('MONTH_OVERRIDE must look like "September 2026" but is "' + s + '".');
}

/** Rule 1.2: blank override = last calendar month. */
function resolveMonth_(override, today) {
  if (override && String(override).trim() !== '') return parseMonthLabel_(override);
  var y = today.getFullYear(), mi = today.getMonth() - 1;
  if (mi < 0) { mi = 11; y -= 1; }
  return monthInfo_(y, mi);
}

/** Rule 3: every tab name (≤ 31 characters, no "/"). */
function tabNames_(m) {
  return {
    adsStart: 'ADS Starting Balance ' + m.prevEndStr,
    amzStart: 'AMZ Starting Balance ' + m.prevEndStr,
    mfgStart: 'MFG Starting Balance ' + m.prevEndStr,
    adsEnd: 'ADS Ending Balance ' + m.endStr,
    ledger: 'AMZ Inventory Ledger ' + m.endStr,
    biz: 'AMZ Business Report ' + m.endStr,
    shopify: 'Shopify Orders ' + m.endStr,
    workOrders: 'Work Orders ' + m.endStr,
    manualLog: 'Manual Order Log ' + m.endStr,
    amzLog: 'AMZ Log ' + m.endStr,
    mfgInv: 'MFG Counts ' + m.endStr,
    adsReceipts: 'ADS Receipts ' + m.endStr,
    prepaid: 'Prepaid',
    bom: 'BOM',
    cogs: 'COGS',
    skuMap: 'AMZ SKU Map',
    skuList: 'SKU List',
    bundleMap: 'Bundle Map',
    kit: 'Kit Consumption',
    checks: 'Checks',
    variance: 'Variance Overview',
    valuation: 'Inventory Valuation',
    outbound: 'Outbound Summary',
    readme: 'README'
  };
}

/** Tab order in the finished workbook. */
function tabOrder_(t) {
  return [t.readme, t.checks, t.variance, t.valuation, t.outbound,
    t.mfgInv, t.adsReceipts, t.mfgStart, t.prepaid, t.cogs, t.skuMap,
    t.bundleMap, t.kit, t.adsStart, t.adsEnd, t.amzStart, t.ledger, t.biz, t.shopify, t.workOrders, t.manualLog, t.amzLog,
    t.bom, t.skuList];
}

function workbookName_(m) { return CONFIG.WORKBOOK_NAME_PREFIX + m.label; }
function sellThruName_(m) { return CONFIG.SELL_THRU_NAME_PREFIX + m.shortLabel; }

// ---------------------------------------------------------------------------
// Rule 6.3: Amazon MSKU -> our SKU
// ---------------------------------------------------------------------------

function mapAmazonSku_(msku) {
  var s = cleanSku_(msku);
  var notes = [];
  CONFIG.AMAZON_SKU_RULES.removeText.forEach(function (t) {
    if (s.indexOf(t) >= 0) { s = s.split(t).join('').trim(); notes.push('removed "' + t.trim() + '"'); }
  });
  var r = CONFIG.AMAZON_SKU_RULES.renames[s];
  if (r) { notes.push('renamed ' + s + ' → ' + r); s = r; }
  return { sku: s, note: notes.length ? notes.join('; ') : 'same as Amazon SKU' };
}

/** Keeps every existing map row; adds any new (MSKU, ASIN) pair. Rule 6.3. */
function mergeSkuMap_(existingRows, pairs, todayStr) {
  var rows = existingRows.map(function (r) { return [cleanSku_(r[0]), cleanSku_(r[1]), cleanSku_(r[2]), textCell_(r[3])]; })
    .filter(function (r) { return r[0] !== '' || r[1] !== ''; });
  var have = {};
  rows.forEach(function (r) { have[r[0] + '|' + r[1]] = true; });
  var added = [];
  pairs.forEach(function (p) {
    var key = p.msku + '|' + p.asin;
    if (have[key] || p.msku === '') return;
    have[key] = true;
    var mapped = mapAmazonSku_(p.msku);
    var row = [p.msku, p.asin, mapped.sku, 'Added ' + todayStr + ': ' + mapped.note];
    rows.push(row);
    added.push(row);
  });
  return { rows: rows, added: added };
}

/** Rule 12.3: an ASIN (Business Report lookup) or MSKU (ledger lookup) whose map rows point at different SKUs. */
function skuMapConflicts_(rows) {
  var out = [];
  [{ kind: 'ASIN', col: 1 }, { kind: 'MSKU', col: 0 }].forEach(function (k) {
    var by = {}, order = [];
    rows.forEach(function (r) {
      var key = r[k.col], sku = r[2];
      if (key === '' || sku === '') return;
      if (!by[key]) { by[key] = []; order.push(key); }
      if (by[key].indexOf(sku) < 0) by[key].push(sku);
    });
    order.forEach(function (key) { if (by[key].length > 1) out.push({ kind: k.kind, key: key, skus: by[key] }); });
  });
  return out;
}

function lookupMap_(rows, colIdx, value) {
  for (var i = 0; i < rows.length; i++) if (rows[i][colIdx] === value) return rows[i][2];
  return null;
}

// ---------------------------------------------------------------------------
// Rule 8.1: Shopify bundle SKUs ("80090,80090" -> 80090 x 2)
// ---------------------------------------------------------------------------

function splitBundle_(sku) {
  var counts = {}, order = [];
  String(sku).split(',').forEach(function (p) {
    var s = p.trim();
    if (!s) return;
    if (!counts[s]) { counts[s] = 0; order.push(s); }
    counts[s]++;
  });
  return order.map(function (s) { return { sku: s, count: counts[s] }; });
}

// ---------------------------------------------------------------------------
// Rule 5.5: ADS work-order report (an HTML page saved as .xls)
// ---------------------------------------------------------------------------

function decodeEntities_(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); });
}

/** All table rows in document order, each {depth, cells}. Handles nested tables. */
function htmlTableRows_(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  var re = /<\s*(\/?)\s*(table|tr|td|th)\b[^>]*>/gi;
  var stack = [];     // one {row, cell} per open table
  var rows = [];
  var last = 0, m;
  function top() { return stack[stack.length - 1]; }
  while ((m = re.exec(html)) !== null) {
    var between = html.slice(last, m.index);
    last = re.lastIndex;
    if (stack.length && top().cell !== null) top().cell += between;
    var closing = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'table') {
      if (!closing) stack.push({ row: null, cell: null });
      else stack.pop();
    } else if (!stack.length) {
      continue;
    } else if (tag === 'tr') {
      if (!closing) top().row = [];
      else if (top().row) { rows.push({ depth: stack.length, cells: top().row }); top().row = null; }
    } else { // td / th
      if (!closing) top().cell = '';
      else if (top().cell !== null) {
        var text = decodeEntities_(top().cell.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (top().row) top().row.push(text);
        top().cell = null;
      }
    }
  }
  return rows;
}

/**
 * Returns {from, through, lines:[{wo, ticket, description, date, sku, pieces, rate, rateType, amount}],
 *          feeLines, lineTotal, reportTotal}. Stops loudly if the lines don't add up to TOTAL
 * or the report is for a different month.
 */
function parseWorkOrdersHtml_(html, m) {
  var rows = htmlTableRows_(html);
  var out = { from: '', through: '', lines: [], feeLines: 0, lineTotal: 0, reportTotal: null };
  var current = null;
  var feeJobs = CONFIG.WORK_ORDER_FEE_JOBS.map(function (j) { return j.toLowerCase(); });
  rows.forEach(function (r) {
    var c = r.cells;
    if (!c.length) return;
    if (/^from_date:?$/i.test(c[0])) { out.from = c[1] || ''; return; }
    if (/^through_date:?$/i.test(c[0])) { out.through = c[1] || ''; return; }
    if (/^TOTAL:?$/i.test(c[0])) { out.reportTotal = toNumber_(c[1], 'in the work-order TOTAL line'); return; }
    if (c.length >= 5 && /^\d{4}-\d{2}$/.test(c[0])) {
      current = { billingMonth: c[0], ticket: c[1], wo: c[2], description: c[3] };
      return;
    }
    if (c.length >= 7 && /^\d{4}-\d{2}-\d{2}$/.test(c[0])) {
      if (!current) throw new Error('Work-order report: found a detail line dated ' + c[0] + ' before any work-order header.');
      var amount = toNumber_(c[6], 'in work order ' + current.wo + ' (Amount)');
      out.lineTotal += amount === '' ? 0 : amount;
      if (feeJobs.indexOf(c[1].toLowerCase()) >= 0) { out.feeLines++; return; }
      out.lines.push({
        wo: current.wo, ticket: current.ticket, description: current.description,
        date: c[0], sku: cleanSku_(c[1]),
        pieces: toNumber_(c[3], 'in work order ' + current.wo + ' (Pieces)'),
        rate: toNumber_(c[4], 'in work order ' + current.wo + ' (Rate)'),
        rateType: c[5], amount: amount
      });
    }
  });
  if (out.reportTotal === null) throw new Error('Work-order report: could not find the "TOTAL:" line, so the file may be incomplete.');
  out.lineTotal = Math.round(out.lineTotal * 100) / 100;
  if (Math.abs(out.lineTotal - out.reportTotal) > 0.005) {
    throw new Error('Work-order report: the lines add up to $' + out.lineTotal.toFixed(2) +
      ' but the report TOTAL says $' + out.reportTotal.toFixed(2) + '. The file may be cut off or in a new format.');
  }
  if (m && (out.from !== m.yyyymm || out.through !== m.yyyymm)) {
    throw new Error('Work-order report covers ' + out.from + ' to ' + out.through + ' but this report is for ' + m.label +
      ' (' + m.yyyymm + '). Download the work orders for ' + m.label + '.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 4.2 / 5.2: Amazon ledger dates
// ---------------------------------------------------------------------------

/** Stops unless the ledger has every day from the 1st to the last day of the month. */
function checkLedgerCoversMonth_(table, m) {
  var di = requireHeader_(table.header, CONFIG.COLUMNS.LEDGER.date, 'Amazon Inventory Ledger');
  var seen = {};
  var outside = 0;
  table.rows.forEach(function (r, i) {
    var s = parseMDY_(r[di], 'in the Amazon Inventory Ledger, row ' + (i + 2));
    if (s < m.firstSerial || s > m.endSerial) outside++;
    seen[s] = true;
  });
  var missing = [];
  for (var s = m.firstSerial; s <= m.endSerial; s++) if (!seen[s]) missing.push(serialToMDY_(s));
  if (outside) {
    throw new Error('The Amazon Inventory Ledger has ' + outside + ' rows dated outside ' + m.label +
      '. Download it for ' + serialToMDY_(m.firstSerial) + ' to ' + m.endMDY + ' only.');
  }
  if (missing.length) {
    throw new Error('The Amazon Inventory Ledger is missing ' + missing.length + ' day(s): ' + missing.join(', ') +
      '. Download it again for ' + serialToMDY_(m.firstSerial) + ' to ' + m.endMDY + ' (daily, Summary view).');
  }
  return { first: m.firstSerial, last: m.endSerial };
}

/** Rule 4.2: this month's ledger rows dated the 1st (their Starting Warehouse Balance is Amazon Beginning). */
function ledgerFirstDateRows_(table, m) {
  var di = requireHeader_(table.header, CONFIG.COLUMNS.LEDGER.date, 'Amazon Inventory Ledger');
  requireHeader_(table.header, CONFIG.COLUMNS.LEDGER.starting, 'Amazon Inventory Ledger');
  var rows = table.rows.filter(function (r, i) {
    return parseMDY_(r[di], 'in the Amazon Inventory Ledger, row ' + (i + 2)) === m.firstSerial;
  });
  if (!rows.length) throw new Error('The Amazon Inventory Ledger has no rows dated ' + serialToMDY_(m.firstSerial) + ', so there is no Amazon starting balance.');
  return { header: table.header, rows: rows };
}

/**
 * Rule 4.2a: per OUR SKU (MSKU mapped with skuOf), last month's final-day Ending Warehouse Balance vs
 * this month's 1st-of-month Starting Warehouse Balance. Returns the SKUs that differ (empty = ties).
 */
function amzTieOut_(prevEndRows, firstRows, skuOf) {
  var L = CONFIG.COLUMNS.LEDGER;
  function sums(tbl, colName, where) {
    var mi = requireHeader_(tbl.header, L.msku, where), vi = requireHeader_(tbl.header, colName, where);
    var out = {};
    tbl.rows.forEach(function (r, i) {
      var k = skuOf ? skuOf(cleanSku_(r[mi])) : cleanSku_(r[mi]);
      out[k] = (out[k] || 0) + toNumber_(r[vi], 'in ' + where + ' (' + colName + '), row ' + (i + 2));
    });
    return out;
  }
  // Both sides include units between Amazon warehouses (Rule 4.2): last month's final-day Ending + In Transit,
  // vs this month's Starting + start-of-day In Transit (the 1st's In Transit + its Warehouse Transfer In/Out).
  function plus(a, b) { var o = {}; [a, b].forEach(function (x) { for (var k in x) o[k] = (o[k] || 0) + x[k]; }); return o; }
  function opt(tbl, colName, where) { return headerIndex_(tbl.header, colName) >= 0 ? sums(tbl, colName, where) : {}; }
  var prev = plus(sums(prevEndRows, L.ending, 'last month\'s Amazon ledger'), opt(prevEndRows, L.inTransit, 'last month\'s Amazon ledger'));
  var cur = plus(plus(sums(firstRows, L.starting, 'the Amazon Inventory Ledger'), opt(firstRows, L.inTransit, 'the Amazon Inventory Ledger')),
    opt(firstRows, L.transfers, 'the Amazon Inventory Ledger'));
  var diffs = [];
  uniqueSorted_(Object.keys(prev).concat(Object.keys(cur))).forEach(function (k) {
    var a = prev[k] || 0, b = cur[k] || 0;
    if (Math.abs(a - b) > 1e-9) diffs.push({ sku: k, prevEnd: a, start: b, diff: b - a });
  });
  return diffs;
}

/** Rule 4.2a: rows carrying the ledger's LAST date; that date must be last month's end. */
function ledgerLastDateRows_(table, expectedSerial, sourceLabel) {
  var di = requireHeader_(table.header, CONFIG.COLUMNS.LEDGER.date, sourceLabel);
  var max = -Infinity;
  var serials = table.rows.map(function (r, i) {
    var s = parseMDY_(r[di], 'in ' + sourceLabel + ', row ' + (i + 2));
    if (s > max) max = s;
    return s;
  });
  if (max !== expectedSerial) {
    throw new Error(sourceLabel + ' ends on ' + serialToMDY_(max) + ' but it should end on ' +
      serialToMDY_(expectedSerial) + ' (last month\'s final day).');
  }
  return { header: table.header, rows: table.rows.filter(function (_, i) { return serials[i] === max; }) };
}

// ---------------------------------------------------------------------------
// Sheet models
// A model = {name, values (2-D, formulas are strings starting with "="), textCols,
//   textFromRow, numberFormats {colIdx: format}, numberFromRow, headerRows, blockRows,
//   subtotalRows, frozenRows, tabColor, preserveIfExists, copyFrom, checks}
// ---------------------------------------------------------------------------

var TAB_COLORS = { summary: '#38761d', manual: '#f1c232', reference: '#3c78d8', helper: '#8e7cc3', raw: '#999999' };

function model_(name, values, opts) {
  var m = {
    name: name, values: values, textCols: [], textFromRow: 2, numberFormats: {}, numberFromRow: 2,
    headerRows: [1], blockRows: [], subtotalRows: [], frozenRows: 1, tabColor: TAB_COLORS.raw,
    preserveIfExists: false, copyFrom: null, isChecks: false
  };
  for (var k in (opts || {})) m[k] = opts[k];
  return m;
}

/**
 * A raw report pasted as received (Rule 5.1): text columns stay text, listed numeric columns
 * become numbers, listed date columns become dates; optional formula columns are appended.
 */
function rawModel_(name, table, opts) {
  opts = opts || {};
  var header = table.header.slice();
  var numeric = opts.numericCols || [];
  var strict = opts.strictCols || numeric; // columns formulas use must be numbers; others convert when they can
  var dates = opts.dateCols || [];
  var rows = table.rows.map(function (r, i) {
    return header.map(function (h, c) {
      var v = r[c];
      if (dates.indexOf(c) >= 0) return v === '' ? '' : parseMDY_(v, 'in ' + name + ', row ' + (i + 2));
      if (numeric.indexOf(c) >= 0) {
        if (strict.indexOf(c) >= 0) return toNumber_(v, 'in ' + name + ', row ' + (i + 2) + ', column "' + h + '"');
        try { return toNumber_(v); } catch (e) { return textCell_(v); }
      }
      return textCell_(v);
    });
  });
  var extra = opts.extraCols || [];
  extra.forEach(function (x) { header.push(x.header); });
  rows.forEach(function (row, i) {
    extra.forEach(function (x) { row.push(x.formula(i + 2)); });
  });
  var textCols = [];
  var numberFormats = {};
  for (var c = 0; c < table.header.length; c++) {
    if (dates.indexOf(c) >= 0) numberFormats[c] = 'MM/dd/yyyy';
    else if (numeric.indexOf(c) >= 0) numberFormats[c] = '#,##0.####';
    else textCols.push(c);
  }
  return model_(name, [header].concat(rows), {
    textCols: textCols, numberFormats: numberFormats, tabColor: opts.tabColor || TAB_COLORS.raw
  });
}

function indexesOf_(header, names) {
  return names.map(function (n) { return headerIndex_(header, n); }).filter(function (i) { return i >= 0; });
}

function rangeIndexes_(header, fromName, toName, label) {
  var a = requireHeader_(header, fromName, label);
  var b = toName ? requireHeader_(header, toName, label) : header.length - 1;
  var out = [];
  for (var i = a; i <= b; i++) out.push(i);
  return out;
}

/** ADS stock snapshot (start or end). */
function adsModel_(name, table) {
  requireHeader_(table.header, CONFIG.COLUMNS.ADS.sku, 'ADS stock snapshot');
  requireHeader_(table.header, CONFIG.COLUMNS.ADS.qty, 'ADS stock snapshot');
  return rawModel_(name, table, {
    numericCols: indexesOf_(table.header, CONFIG.COLUMNS.ADS.numeric),
    strictCols: indexesOf_(table.header, [CONFIG.COLUMNS.ADS.qty])
  });
}

/** Amazon ledger (full month or starting rows) + "SKU (mapped)" formula column (Rule 5.1c). */
function ledgerModel_(name, table, tabs) {
  var L = CONFIG.COLUMNS.LEDGER;
  var msku = colLetter_(requireHeader_(table.header, L.msku, 'Amazon Inventory Ledger') + 1);
  return rawModel_(name, table, {
    numericCols: rangeIndexes_(table.header, L.numericFrom, L.numericTo, 'Amazon Inventory Ledger'),
    strictCols: indexesOf_(table.header, [L.receipts, L.ending, L.starting, L.inTransit, L.transfers, L.shipments].concat(L.deltaEvents)),
    dateCols: [requireHeader_(table.header, L.date, 'Amazon Inventory Ledger')],
    extraCols: [{
      header: 'SKU (mapped)',
      formula: function (r) {
        return '=IFERROR(INDEX(' + colRef_(tabs.skuMap, 'C') + ',MATCH(' + msku + r + ',' + colRef_(tabs.skuMap, 'A') +
          ',0)),' + q_(CONFIG.UNMAPPED_TEXT) + ')';
      }
    }]
  });
}

/** Amazon Business Report + "SKU (mapped)" by ASIN. */
function bizModel_(name, table, tabs) {
  var B = CONFIG.COLUMNS.BIZ;
  var asin = colLetter_(requireHeader_(table.header, B.asin, 'Amazon Business Report') + 1);
  requireHeader_(table.header, B.units, 'Amazon Business Report');
  return rawModel_(name, table, {
    numericCols: rangeIndexes_(table.header, B.numericFrom, null, 'Amazon Business Report'),
    strictCols: indexesOf_(table.header, [B.units]),
    extraCols: [{
      header: 'SKU (mapped)',
      formula: function (r) {
        return '=IFERROR(INDEX(' + colRef_(tabs.skuMap, 'C') + ',MATCH(' + asin + r + ',' + colRef_(tabs.skuMap, 'B') +
          ',0)),' + q_(CONFIG.UNMAPPED_TEXT) + ')';
      }
    }]
  });
}

/** Rule 5.4: channel formula from the order's tags (first match wins). */
function channelFormula_(tagsCell) {
  var f = q_(CONFIG.DEFAULT_CHANNEL);
  for (var i = CONFIG.CHANNEL_RULES.length - 1; i >= 0; i--) {
    var r = CONFIG.CHANNEL_RULES[i];
    f = 'IF(ISNUMBER(SEARCH(' + q_(r.keyword) + ',' + tagsCell + ')),' + q_(r.channel) + ',' + f + ')';
  }
  return '=' + f;
}

/** Stops if one order's lines are not next to each other (the Order Tags fill-down needs that). */
function checkShopifyOrdersContiguous_(table) {
  var ni = requireHeader_(table.header, CONFIG.COLUMNS.SHOPIFY.name, 'Shopify order export');
  var done = {}, prev = null;
  table.rows.forEach(function (r, i) {
    var n = r[ni];
    if (n !== prev) {
      if (done[n]) throw new Error('Shopify export: order ' + n + ' appears in two separate places (row ' + (i + 2) +
        '). Re-export from Shopify without re-sorting the file.');
      if (prev !== null) done[prev] = true;
      prev = n;
    }
  });
}

/**
 * Shopify "Order Export" tab (Rule 5.4 / 13.1). Adds:
 *   Order Tags = this order's tags (Shopify fills Tags only on an order's first line)
 *   Channel    = first matching channel rule on Order Tags
 */
function shopifyModel_(name, table) {
  var S = CONFIG.COLUMNS.SHOPIFY;
  checkShopifyOrdersContiguous_(table);
  var col = function (h) { return colLetter_(requireHeader_(table.header, h, 'Shopify order export') + 1); };
  var n = col(S.name), tags = col(S.tags), qty = col(S.qty), fin = col(S.financial), canc = col(S.cancelled), ful = col(S.fulfillment);
  requireHeader_(table.header, S.sku, 'Shopify order export');
  var L = shopifyLetters_(table.header);
  // Order-level fields are only on an order's first line: carry them down to every line of the order.
  function fillDown(src, own) {
    return function (r) { return r === 2 ? '=""&' + src + r : '=IF(' + n + r + '=' + n + (r - 1) + ',' + own + (r - 1) + ',""&' + src + r + ')'; };
  }
  return rawModel_(name, table, {
    numericCols: indexesOf_(table.header, S.numeric),
    strictCols: indexesOf_(table.header, [S.qty]),
    tabColor: TAB_COLORS.raw,
    extraCols: [
      { header: 'Order Tags', formula: fillDown(tags, L.orderTags) },
      { header: 'Channel', formula: function (r) { return channelFormula_(L.orderTags + r); } },
      { header: 'Order Financial Status', formula: fillDown(fin, L.orderFinancial) },
      { header: 'Order Cancelled At', formula: fillDown(canc, L.orderCancelled) },
      // Rule 5.4a: cancelled → out; refunded/voided AND this line not fulfilled → out; everything else counts.
      { header: 'Counted', formula: function (r) {
        return '=IF(' + L.orderCancelled + r + '<>"","' + SHOPIFY_EXCLUDED.cancelled + '",IF(' + ful + r + '="fulfilled","Yes",IF(' +
          L.orderFinancial + r + '="refunded","' + SHOPIFY_EXCLUDED.refunded + '",IF(' + L.orderFinancial + r + '="voided","' +
          SHOPIFY_EXCLUDED.voided + '","Yes"))))';
      } },
      { header: 'Counted Qty', formula: function (r) { return '=IF(' + L.counted + r + '="Yes",' + qty + r + ',0)'; } }
    ]
  });
}

var SHOPIFY_EXCLUDED = { cancelled: 'No - cancelled', refunded: 'No - refunded, not shipped', voided: 'No - voided, not shipped' };

/** Rule 5.4a in plain JS (same rule as the Counted formula): true when a Shopify line counts as sold. */
function shopifyLinesCounted_(table) {
  var S = CONFIG.COLUMNS.SHOPIFY, h = table.header;
  var ni = requireHeader_(h, S.name, 'Shopify order export'), fi = requireHeader_(h, S.financial, 'Shopify order export'),
    ci = requireHeader_(h, S.cancelled, 'Shopify order export'), li = requireHeader_(h, S.fulfillment, 'Shopify order export');
  var prev = null, fin = '', canc = '';
  return table.rows.map(function (r) {
    if (r[ni] !== prev) { prev = r[ni]; fin = textCell_(r[fi]); canc = textCell_(r[ci]); }
    if (canc !== '') return false;
    if (textCell_(r[li]).trim().toLowerCase() === 'fulfilled') return true;
    var f = fin.trim().toLowerCase();
    return !(f === 'refunded' || f === 'voided');
  });
}

/** Column letters on the Shopify tab (same on the Sell Thru file and the EOM copy). */
function shopifyLetters_(header) {
  var S = CONFIG.COLUMNS.SHOPIFY;
  var w = header.length;
  return {
    name: colLetter_(headerIndex_(header, S.name) + 1),
    sku: colLetter_(headerIndex_(header, S.sku) + 1),
    rawQty: colLetter_(headerIndex_(header, S.qty) + 1),
    orderTags: colLetter_(w + 1),
    channel: colLetter_(w + 2),
    orderFinancial: colLetter_(w + 3),
    orderCancelled: colLetter_(w + 4),
    counted: colLetter_(w + 5),
    qty: colLetter_(w + 6) // Counted Qty: every "units sold" formula uses this (Rule 5.4a)
  };
}

/** Rule 13.1: Channel Breakdown tab of the standalone Sell Thru file. */
function channelBreakdownModel_(shopifyTable, orderExportTab) {
  var L = shopifyLetters_(shopifyTable.header);
  var si = headerIndex_(shopifyTable.header, CONFIG.COLUMNS.SHOPIFY.sku);
  var skus = uniqueSorted_(shopifyTable.rows.map(function (r) { return cleanSku_(r[si]); }));
  var ch = CONFIG.CHANNELS;
  var values = [['Lineitem sku'].concat(ch).concat(['Grand Total'])];
  skus.forEach(function (sku, i) {
    var r = i + 2;
    var row = [sku];
    ch.forEach(function (_, j) {
      var c = colLetter_(j + 2);
      row.push('=SUMIFS(' + colRef_(orderExportTab, L.qty) + ',' + colRef_(orderExportTab, L.sku) + ',$A' + r + ',' +
        colRef_(orderExportTab, L.channel) + ',' + c + '$1)');
    });
    row.push('=SUM(B' + r + ':' + colLetter_(ch.length + 1) + r + ')');
    values.push(row);
  });
  var last = skus.length + 1;
  var total = ['Grand Total'];
  for (var j = 0; j <= ch.length; j++) {
    var c = colLetter_(j + 2);
    total.push(last >= 2 ? '=SUM(' + c + '2:' + c + last + ')' : 0);
  }
  values.push(total);
  return model_('Channel Breakdown', values, {
    textCols: [0], subtotalRows: [values.length], tabColor: TAB_COLORS.summary,
    numberFormats: numFmts_(1, ch.length + 1, '#,##0')
  });
}

function numFmts_(fromCol, toCol, fmt) {
  var o = {};
  for (var c = fromCol; c <= toCol; c++) o[c] = fmt;
  return o;
}

/** Rule 5.5: one row per kit line. */
function workOrdersModel_(name, parsed) {
  var header = ['Work Order', 'Ticket Number', 'Description (from report — not used)', 'Date', 'SKU (Job)', 'Pieces', 'Rate', 'Rate Type', 'Amount'];
  var rows = parsed.lines.map(function (l) {
    return [l.wo, l.ticket, l.description, l.date, l.sku, l.pieces, l.rate, l.rateType, l.amount];
  });
  return model_(name, [header].concat(rows), {
    textCols: [0, 1, 2, 3, 4, 7],
    numberFormats: { 5: '#,##0', 6: '0.00', 8: '$#,##0.00' }
  });
}

/**
 * Rule 5.6: the rows of an Ops Hub shipment log (manualorder_log or amz_log) shipped in the month.
 * `values` = the log's columns as read from Ops Hub (header in row 1).
 * Returns {rows: [[order, channel|amazonNo, sku, qty, orderDate, shipDate]], notShipped, otherMonths}.
 * A blank Ship Date = not shipped yet (counted in notShipped). Stops on anything that would make a
 * number wrong: a Ship Date that isn't a date, a bad Quantity, an unknown Channel, a missing SKU,
 * or a SKU Google Sheets has turned into a number (80030,51003 → 8003051003).
 */
function parseOpsLog_(values, kind, m) {
  var cfg = kind === 'manual' ? CONFIG.OPS_HUB.manualLog : CONFIG.OPS_HUB.amzLog;
  var H = cfg.headers;
  var label = 'Ops Hub tab "' + cfg.sheetName + '"';
  if (!values || !values.length) throw new Error(label + ' is empty — it needs its header row (' + cfg.columns + ').');
  var header = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  var second = kind === 'manual' ? H.channel : H.amazon;
  var ix = {};
  [['order', H.order], ['second', second], ['sku', H.sku], ['qty', H.qty], ['orderDate', H.orderDate], ['shipDate', H.shipDate]].forEach(function (p) {
    ix[p[0]] = requireHeader_(header, p[1], label);
  });
  var allowed = CONFIG.OUTBOUND_CHANNELS;
  var blank = function (v) { return v === '' || v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); };
  var out = { rows: [], notShipped: 0, otherMonths: 0 };
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var where = 'in ' + label + ', row ' + (i + 1);
    if (blank(r[ix.sku]) && blank(r[ix.qty]) && blank(r[ix.shipDate])) continue;
    if (blank(r[ix.shipDate])) { out.notShipped++; continue; }
    var ship;
    try {
      ship = parseMDY_(r[ix.shipDate], where + ' (Ship Date)');
    } catch (err) {
      throw new Error(err.message + ' Ship Date must be the date the units left ADS (e.g. 10/02/2026), or blank if they have not shipped yet.');
    }
    if (ship < m.firstSerial || ship > m.endSerial) { out.otherMonths++; continue; }
    var sku = cleanSku_(r[ix.sku]);
    if (!sku) throw new Error('No SKU ' + where + '.');
    if (typeof r[ix.sku] === 'number' && sku.length > 6) {
      throw new Error('SKU "' + sku + '" ' + where + ' looks like a bundle that Google Sheets turned into a number (the commas are gone). ' +
        'Format the SKU column as Plain text (Format → Number → Plain text) and retype it, e.g. 80030,51003.');
    }
    var qty = toNumber_(r[ix.qty], where + ' (Quantity)');
    if (qty === '') throw new Error('No Quantity ' + where + '.');
    var second2 = textCell_(r[ix.second]).trim();
    if (kind === 'manual') {
      if (second2.toLowerCase() === CONFIG.AMAZON_CHANNEL_LABEL.toLowerCase()) {
        throw new Error('Channel "' + second2 + '" ' + where + ': units sent from ADS to Amazon belong in Ops Hub "' +
          CONFIG.OPS_HUB.amzLog.sheetName + '", not "' + cfg.sheetName + '". Move the row there.');
      }
      var match = allowed.filter(function (c) { return c.toLowerCase() === second2.toLowerCase(); })[0];
      if (!match) throw new Error('Channel "' + second2 + '" ' + where + ' is not one of: ' + allowed.join(', ') + '.');
      second2 = match;
    }
    out.rows.push([textCell_(r[ix.order]).trim(), second2, sku, qty, textCell_(r[ix.orderDate]).trim(), ship]);
  }
  return out;
}

/** Rule 5.6: the month's rows of an Ops Hub log, frozen into the workbook as values (C = SKU, D = Quantity). */
function opsLogModel_(name, parsed, kind) {
  var H = (kind === 'manual' ? CONFIG.OPS_HUB.manualLog : CONFIG.OPS_HUB.amzLog).headers;
  var header = [H.order, kind === 'manual' ? H.channel : H.amazon, H.sku, H.qty, H.orderDate, H.shipDate];
  return model_(name, [header].concat(parsed.rows.map(function (r) { return r.slice(); })), {
    textCols: [0, 1, 2, 4], numberFormats: { 3: '#,##0.####', 5: 'MM/dd/yyyy' }
  });
}

/** Rule 6.1: BOM rows from the Ops Hub (identity rows and duplicates removed). */
function bomFromSource_(values) {
  var H = CONFIG.BOM_SOURCE.headers;
  var hr = -1;
  for (var i = 0; i < Math.min(values.length, 10); i++) {
    if (headerIndex_(values[i], H.parent) >= 0) { hr = i; break; }
  }
  if (hr < 0) throw new Error('Could not find the "' + H.parent + '" header in the Ops Hub BOM (columns ' + CONFIG.BOM_SOURCE.columns + ').');
  var h = values[hr].map(function (x) { return String(x).replace(/\s+/g, ' ').trim(); });
  var ix = {};
  ['parent', 'parentDesc', 'child', 'childDesc', 'qty'].forEach(function (k) { ix[k] = requireHeader_(h, H[k], 'Ops Hub BOM'); });
  var rows = [], seen = {}, identity = 0, duplicates = [], invalid = 0, descs = {};
  values.slice(hr + 1).forEach(function (r) {
    var p = cleanSku_(r[ix.parent]), c = cleanSku_(r[ix.child]);
    if (!p && !c) return;
    // Descriptions come from every row, including the parent = child rows (Rule 6.4).
    if (p && textCell_(r[ix.parentDesc]).trim() && !descs[p]) descs[p] = textCell_(r[ix.parentDesc]).trim();
    if (c && textCell_(r[ix.childDesc]).trim() && !descs[c]) descs[c] = textCell_(r[ix.childDesc]).trim();
    var qty = typeof r[ix.qty] === 'number' ? r[ix.qty] : Number(String(r[ix.qty]).trim());
    if (!p || !c || String(r[ix.qty]).trim() === '' || isNaN(qty)) { invalid++; return; }
    if (p === c) { identity++; return; }
    var key = p + '|' + c;
    if (seen[key]) { duplicates.push(p + ' → ' + c); return; }
    seen[key] = true;
    rows.push([p, textCell_(r[ix.parentDesc]), c, textCell_(r[ix.childDesc]), qty]);
  });
  return { rows: rows, descs: descs, identity: identity, duplicates: duplicates, invalid: invalid };
}

function bomModel_(name, bom, todayStr) {
  var values = [['Parent SKU', 'Parent Desc', 'Child SKU', 'Child Desc', 'Qty', '',
    'Copied from Ops Hub 2.0 "' + CONFIG.BOM_SOURCE.sheetName + '" tab (columns ' + CONFIG.BOM_SOURCE.columns + ') on ' + todayStr +
    '. Rows where Parent = Child removed (' + bom.identity + '), duplicate rows removed (' + bom.duplicates.length + ').']];
  bom.rows.forEach(function (r) { values.push(r.concat(['', ''])); });
  return model_(name, values, { textCols: [0, 1, 2, 3], numberFormats: { 4: '0.#########' }, tabColor: TAB_COLORS.reference });
}

/** Rule 6.4: SKU -> description from the BOM; bundles described by their components. */
function skuDescriptions_(bomDescs, neededSkus) {
  var d = {}, src = {};
  Object.keys(bomDescs).forEach(function (s) { d[s] = bomDescs[s]; src[s] = 'Ops Hub BOM'; });
  neededSkus.forEach(function (s) {
    if (d[s] || s.indexOf(',') < 0) return;
    var parts = splitBundle_(s);
    if (parts.every(function (p) { return d[p.sku]; })) {
      d[s] = parts.map(function (p) { return (p.count > 1 ? p.count + ' x ' : '') + d[p.sku]; }).join(' + ');
      src[s] = 'Built from bundle components';
    }
  });
  return { desc: d, source: src };
}

function skuListModel_(name, descs) {
  var skus = uniqueSorted_(Object.keys(descs.desc));
  var values = [['SKU', 'Description', 'Source']].concat(skus.map(function (s) { return [s, descs.desc[s], descs.source[s]]; }));
  return model_(name, values, { textCols: [0, 1, 2], tabColor: TAB_COLORS.reference });
}

function skuMapModel_(name, rows) {
  return model_(name, [['Amazon MSKU', 'ASIN', 'Our SKU', 'Note']].concat(rows), {
    textCols: [0, 1, 2, 3], tabColor: TAB_COLORS.reference
  });
}

/** Header-only manual tab (Rule 7), created once and never overwritten. */
/** Rule 4.4: first run — [[mfg, sku, qty]] from the Raw Material rows of the hand-built workbook's Variance Overview. */
function mfgStartFromBootstrap_(values) {
  var B = CONFIG.BOOTSTRAP_MFG, label = 'the first-run workbook\'s "' + B.tab + '" tab';
  var hr = -1;
  for (var i = 0; i < Math.min(values.length, 10); i++) if (headerIndex_(values[i], B.category) >= 0) { hr = i; break; }
  if (hr < 0) throw new Error('Could not find the "' + B.category + '" column in ' + label + '.');
  var h = values[hr];
  var mi = requireHeader_(h, B.mfg, label), si = requireHeader_(h, B.sku, label), ci = requireHeader_(h, B.category, label), qi = requireHeader_(h, B.qty, label);
  return values.slice(hr + 1).filter(function (r) { return textCell_(r[ci]).trim() === B.categoryValue && cleanSku_(r[si]) !== ''; })
    .map(function (r, k) { return [textCell_(r[mi]).trim(), cleanSku_(r[si]), toNumber_(r[qi], 'in ' + label + ' (' + B.qty + '), MFG row ' + (k + 1))]; });
}

/** Rule 7.1: the MFG Counts tab. New tab = pre-filled with MFG + SKU of every row with a starting balance (quantities blank). */
function mfgCountsRows_(inputs) {
  if (inputs.mfgInv) return inputs.mfgInv;
  return (inputs.mfgStart || []).filter(function (r) { return Number(r[2]) !== 0 && cleanSku_(r[1]) !== ''; })
    .map(function (r) { return [r[0], cleanSku_(r[1]), '', '']; });
}

function manualTabModel_(name, header, rows, numericCols) {
  numericCols = numericCols || [];
  var values = [header].concat((rows || []).map(function (r, i) {
    return header.map(function (h, c) {
      var v = r[c] === undefined || r[c] === null ? '' : r[c];
      // Quantities must be numbers or SUMIFS ignores them (a typed "10000" stored as text would vanish).
      if (numericCols.indexOf(c) >= 0) return toNumber_(v, 'on ' + name + ', row ' + (i + 2) + ', column "' + h + '"');
      return c === 1 ? cleanSku_(v) : textCell_(v);
    });
  }));
  var nf = {};
  numericCols.forEach(function (c) { nf[c] = '#,##0.####'; });
  var text = [];
  header.forEach(function (_, c) { if (numericCols.indexOf(c) < 0) text.push(c); });
  return model_(name, values, { textCols: text, numberFormats: nf, tabColor: TAB_COLORS.manual, preserveIfExists: true });
}

// ---------------------------------------------------------------------------
// Rule 8: helper tabs
// ---------------------------------------------------------------------------

/** Rule 8.1: one row per (Shopify sold SKU, component). */
function bundleMapModel_(name, soldSkus, tabs, shop) {
  var values = [['Sold SKU (Shopify)', 'Component SKU', 'Count of component in Sold SKU', 'Units Sold (all Shopify channels)', 'Component Units Shipped']];
  soldSkus.forEach(function (sold) {
    splitBundle_(sold).forEach(function (p) {
      var r = values.length + 1;
      values.push([sold, p.sku, p.count,
        '=SUMIFS(' + colRef_(tabs.shopify, shop.qty) + ',' + colRef_(tabs.shopify, shop.sku) + ',$A' + r + ')',
        '=C' + r + '*D' + r]);
    });
  });
  return model_(name, values, { textCols: [0, 1], numberFormats: { 2: '0', 3: '#,##0', 4: '#,##0' }, tabColor: TAB_COLORS.helper });
}

/** Rule 8.2: one row per (kit built this month, BOM child). */
function kitConsumptionModel_(name, parents, bomRows, tabs) {
  var values = [['Kit Built (Parent SKU)', 'Child SKU', 'Qty per Kit (from BOM)', 'Kits Built (from Work Orders)', 'Child Units Used']];
  var noBom = [];
  parents.forEach(function (p) {
    var kids = bomRows.filter(function (b) { return b[0] === p; });
    if (!kids.length) { noBom.push(p); return; }
    kids.forEach(function (k) {
      var r = values.length + 1;
      values.push([p, k[2],
        '=SUMIFS(' + colRef_(tabs.bom, 'E') + ',' + colRef_(tabs.bom, 'A') + ',$A' + r + ',' + colRef_(tabs.bom, 'C') + ',$B' + r + ')',
        '=SUMIFS(' + colRef_(tabs.workOrders, 'F') + ',' + colRef_(tabs.workOrders, 'E') + ',$A' + r + ')',
        '=C' + r + '*D' + r]);
    });
  });
  var m = model_(name, values, { textCols: [0, 1], numberFormats: { 2: '0.#########', 3: '#,##0', 4: '#,##0.####' }, tabColor: TAB_COLORS.helper });
  m.kitsWithoutBom = noBom;
  return m;
}

// ---------------------------------------------------------------------------
// Rule 9: Variance Overview
// ---------------------------------------------------------------------------

var VARIANCE_HEADER = ['Location', 'SKU', 'Description', 'Categorization', 'Beginning Inventory', 'Receiving', 'Sold / Used',
  'Expected Ending Inventory', 'Actual Ending Inventory', 'Delta (Actual − Expected)', 'Avg Cost / Unit',
  'Total Expected Cost', 'Total Actual Cost', 'Delta $ (Actual − Expected)'];
var VARIANCE_HEADER_ROW = 4;

function costLookup_(ctx, which, skuCell) {
  return '=IFERROR(INDEX(' + colRef_(ctx.tabs.cogs, ctx.cogs[which]) + ',MATCH(' + skuCell + ',' + colRef_(ctx.tabs.cogs, ctx.cogs.key) +
    ',0)),' + q_(CONFIG.NO_COST_TEXT) + ')';
}

function descLookup_(ctx, skuCell) {
  return '=IFERROR(INDEX(' + colRef_(ctx.tabs.skuList, 'B') + ',MATCH(' + skuCell + ',' + colRef_(ctx.tabs.skuList, 'A') +
    ',0)),' + q_(CONFIG.NO_DESCRIPTION_TEXT) + ')';
}

/** The three location-specific formulas (Beginning, Receiving, Sold/Used, Actual) for one row. */
function varianceSourceFormulas_(kind, ctx, r) {
  var t = ctx.tabs, c = ctx.cols, B = '$B' + r, A = '$A' + r;
  if (kind === 'ADS') {
    return {
      begin: '=SUMIFS(' + colRef_(t.adsStart, c.adsStart.qty) + ',' + colRef_(t.adsStart, c.adsStart.sku) + ',' + B + ')',
      recv: '=SUMIFS(' + colRef_(t.adsReceipts, 'C') + ',' + colRef_(t.adsReceipts, 'B') + ',' + B + ')' +
        '+SUMIFS(' + colRef_(t.workOrders, 'F') + ',' + colRef_(t.workOrders, 'E') + ',' + B + ')',
      sold: '=SUMIFS(' + colRef_(t.bundleMap, 'E') + ',' + colRef_(t.bundleMap, 'B') + ',' + B + ')' +
        '+SUMIFS(' + colRef_(t.manualLog, 'D') + ',' + colRef_(t.manualLog, 'C') + ',' + B + ')' +
        '+SUMIFS(' + colRef_(t.amzLog, 'D') + ',' + colRef_(t.amzLog, 'C') + ',' + B + ')' +
        '+SUMIFS(' + colRef_(t.kit, 'E') + ',' + colRef_(t.kit, 'B') + ',' + B + ')',
      actual: '=SUMIFS(' + colRef_(t.adsEnd, c.adsEnd.qty) + ',' + colRef_(t.adsEnd, c.adsEnd.sku) + ',' + B + ')'
    };
  }
  if (kind === 'AMZ') {
    return {
      begin: amzBeginFormula_(ctx, B),
      recv: '=SUMIFS(' + colRef_(t.ledger, c.ledger.receipts) + ',' + colRef_(t.ledger, c.ledger.mapped) + ',' + B + ')',
      sold: '=0-SUMIFS(' + colRef_(t.ledger, c.ledger.shipments) + ',' + colRef_(t.ledger, c.ledger.mapped) + ',' + B + ')',
      actual: amzLastDayFormula_(ctx, B, ['ending', 'inTransit'])
    };
  }
  // MFG: Used is calculated (Rule 9.3).
  return {
    begin: '=SUMIFS(' + colRef_(t.mfgStart, 'C') + ',' + colRef_(t.mfgStart, 'A') + ',' + A + ',' + colRef_(t.mfgStart, 'B') + ',' + B + ')',
    recv: '=SUMIFS(' + colRef_(t.mfgInv, 'C') + ',' + colRef_(t.mfgInv, 'A') + ',' + A + ',' + colRef_(t.mfgInv, 'B') + ',' + B + ')',
    sold: '=E' + r + '+F' + r + '-I' + r,
    actual: '=SUMIFS(' + colRef_(t.mfgInv, 'D') + ',' + colRef_(t.mfgInv, 'A') + ',' + A + ',' + colRef_(t.mfgInv, 'B') + ',' + B + ')'
  };
}

/**
 * Rule 4.2: Amazon Beginning = 1st-of-month Starting Warehouse Balance + units between Amazon warehouses at the START
 * of the 1st. The ledger's In Transit figure is end-of-day, so start-of-day = that + the 1st's Warehouse Transfer In/Out.
 */
function amzBeginFormula_(ctx, skuCell) {
  var t = ctx.tabs, a = ctx.cols.amzStart;
  return '=' + ['starting', 'inTransit', 'transfers'].map(function (k) {
    return 'SUMIFS(' + colRef_(t.amzStart, a[k]) + ',' + colRef_(t.amzStart, a.mapped) + ',' + skuCell + ')';
  }).join('+');
}

/** Sum of ledger columns on the ledger's LAST date for one SKU (Rule 9.3 Actual Ending = Ending + In Transit). */
function amzLastDayFormula_(ctx, skuCell, keys) {
  var t = ctx.tabs, l = ctx.cols.ledger;
  return '=' + keys.map(function (k) {
    return 'SUMIFS(' + colRef_(t.ledger, l[k]) + ',' + colRef_(t.ledger, l.mapped) + ',' + skuCell + ',' +
      colRef_(t.ledger, l.date) + ',MAX(' + colRef_(t.ledger, l.date) + '))';
  }).join('+');
}

/**
 * Rule 9.5: MFG section row = row `k` of the MFG Counts tab (plain cell links, so reordering that tab reorders
 * this section). Blank SKU on MFG Counts = blank row here. Used is calculated: Beginning + Received − EOM.
 */
function mfgVarianceRow_(ctx, b, r, k) {
  var t = ctx.tabs, C = q2_(t.mfgInv) + '!', S = '$B' + r;
  var blankIf = function (expr) { return '=IF(' + S + '="","",' + expr + ')'; };
  var inner = function (f) { return f.charAt(0) === '=' ? f.slice(1) : f; };
  return [
    '=IF(' + C + 'B' + k + '="","",' + C + 'A' + k + '&"")',
    '=IF(' + C + 'B' + k + '="","",' + C + 'B' + k + '&"")', // &"" = always text, so 70003 typed as a number still matches
    blankIf(inner(descLookup_(ctx, S))),
    blankIf(q_(b.categorization)),
    blankIf('SUMIFS(' + colRef_(t.mfgStart, 'C') + ',' + colRef_(t.mfgStart, 'A') + ',$A' + r + ',' + colRef_(t.mfgStart, 'B') + ',' + S + ')'),
    blankIf('SUM(' + C + 'D' + k + ')'),
    blankIf('E' + r + '+F' + r + '-I' + r),
    blankIf('E' + r + '+F' + r + '-G' + r),
    blankIf('SUM(' + C + 'C' + k + ')'),
    blankIf('I' + r + '-H' + r),
    blankIf(inner(costLookup_(ctx, 'total', S))),
    blankIf('IF(H' + r + '=0,0,IFERROR(H' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))'),
    blankIf('IF(I' + r + '=0,0,IFERROR(I' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))'),
    blankIf('IFERROR(M' + r + '-L' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')')
  ];
}

var BLOCK_EXPLANATIONS = {
  ADS: 'rows = every SKU in ADS start/end snapshots, ADS Receipts, Work Orders, the Ops Hub shipment logs or Shopify sales (Rule 9.2)',
  AMZ: 'rows = every mapped SKU in AMZ Starting Balance, AMZ Inventory Ledger or Business Report sales (Rule 9.2)',
  MFG: 'row by row = the MFG Counts tab, in its order (add or reorder rows there); Sold / Used is calculated (Rule 9.5)'
};

function varianceModel_(ctx, blocks) {
  var values = [
    ['Variance Overview — ' + ctx.month.label],
    ['Expected Ending = Beginning + Receiving − Sold / Used. Delta = Actual − Expected. Every number is a formula; see README and RULES.md section 9.'],
    [],
    VARIANCE_HEADER.slice()
  ];
  var blockRows = [], subtotalRows = [];
  blocks.forEach(function (b) {
    if (b.kind !== 'MFG' && !b.skus.length) return;
    values.push(['▼ ' + b.label + ' — ' + BLOCK_EXPLANATIONS[b.kind]]);
    blockRows.push(values.length);
    var first = values.length + 1;
    if (b.kind === 'MFG') {
      for (var k = 0; k < b.rows; k++) values.push(mfgVarianceRow_(ctx, b, values.length + 1, k + 2));
      b.firstRow = first;
    }
    (b.kind === 'MFG' ? [] : b.skus).forEach(function (sku) {
      var r = values.length + 1;
      var f = varianceSourceFormulas_(b.kind, ctx, r);
      values.push([b.label, sku, descLookup_(ctx, '$B' + r), b.categorization,
        f.begin, f.recv, f.sold,
        '=E' + r + '+F' + r + '-G' + r,
        f.actual,
        '=I' + r + '-H' + r,
        costLookup_(ctx, 'total', '$B' + r),
        '=IF(H' + r + '=0,0,IFERROR(H' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))',
        '=IF(I' + r + '=0,0,IFERROR(I' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))',
        '=IFERROR(M' + r + '-L' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')']);
    });
    var last = values.length;
    var sub = ['Subtotal – ' + b.label, '', '', ''];
    ['E', 'F', 'G', 'H', 'I', 'J'].forEach(function (c) { sub.push('=SUM(' + c + first + ':' + c + last + ')'); });
    sub.push('');
    ['L', 'M', 'N'].forEach(function (c) { sub.push('=SUM(' + c + first + ':' + c + last + ')'); });
    values.push(sub);
    subtotalRows.push(values.length);
  });
  var nf = numFmts_(4, 9, '#,##0.####;-#,##0.####;0');
  nf[10] = '$#,##0.00'; nf[11] = '$#,##0.00'; nf[12] = '$#,##0.00'; nf[13] = '$#,##0.00';
  var mfgBlock = blocks.filter(function (b) { return b.kind === 'MFG'; })[0];
  return model_(ctx.tabs.variance, values, {
    textCols: [1], textFromRow: VARIANCE_HEADER_ROW + 1,
    textToRow: mfgBlock ? mfgBlock.firstRow - 1 : null, // MFG rows are formulas (a text-formatted cell would show the formula as text) numberFormats: nf, numberFromRow: VARIANCE_HEADER_ROW + 1,
    headerRows: [VARIANCE_HEADER_ROW], titleRows: [1], blockRows: blockRows, subtotalRows: subtotalRows,
    frozenRows: VARIANCE_HEADER_ROW, tabColor: TAB_COLORS.summary
  });
}

// ---------------------------------------------------------------------------
// Rule 10: Inventory Valuation
// ---------------------------------------------------------------------------

var VALUATION_HEADER = ['Location', 'SKU', 'Description', 'Categorization', 'Available Inventory', 'COGS / Unit',
  'Freight / Unit', 'Tariffs / Unit', 'COGS + Freight + Tariffs', 'Total Inventory Value'];

function categorizations_() {
  var out = [];
  [CONFIG.LOCATIONS.ADS, CONFIG.LOCATIONS.AMZ, CONFIG.LOCATIONS.MFG].forEach(function (l) {
    if (out.indexOf(l.categorization) < 0) out.push(l.categorization);
  });
  return out;
}

function valuationModel_(ctx, blocks) {
  var t = ctx.tabs;
  var cats = categorizations_();
  var values = [['Inventory Valuation — ' + ctx.month.label + ' (totals box never moves; rows below are blocks by location)']];
  cats.forEach(function (cat) {
    var r = values.length + 1;
    values.push([cat, '=SUMIFS(J:J,D:D,A' + r + ')']);
  });
  values.push(['TOTAL INVENTORY VALUE', '=SUM(B2:B' + (cats.length + 1) + ')']);
  var totalRow = values.length;
  values.push([]);
  values.push(VALUATION_HEADER.slice());
  var headerRow = values.length;
  var blockRows = [], subtotalRows = [], mfgFirst = null;
  blocks.forEach(function (b) {
    if (b.kind !== 'MFG' && !b.skus.length) return;
    values.push(['▼ ' + b.label + ' — Available Inventory = Actual Ending Inventory on Variance Overview']);
    blockRows.push(values.length);
    var first = values.length + 1;
    if (b.kind === 'MFG') {
      mfgFirst = first;
      // Rule 10.1: row k mirrors MFG row k on Variance Overview.
      for (var k = 0; k < b.rows; k++) {
        var r = values.length + 1, vr = b.firstRow + k, V = q2_(t.variance) + '!', S = '$B' + r;
        var bi = function (expr) { return '=IF(' + S + '="","",' + expr + ')'; };
        var inner = function (f) { return f.slice(1); };
        values.push(['=IF(' + V + 'B' + vr + '="","",' + V + 'A' + vr + ')', '=IF(' + V + 'B' + vr + '="","",' + V + 'B' + vr + ')',
          bi(inner(descLookup_(ctx, S))), bi(q_(b.categorization)), bi(V + 'I' + vr),
          bi(inner(costLookup_(ctx, 'cogs', S))), bi(inner(costLookup_(ctx, 'freight', S))), bi(inner(costLookup_(ctx, 'tariffs', S))),
          bi('IFERROR(F' + r + '+G' + r + '+H' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')'),
          bi('IF(E' + r + '=0,0,IFERROR(E' + r + '*I' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))')]);
      }
    }
    (b.kind === 'MFG' ? [] : b.skus).forEach(function (sku) {
      var r = values.length + 1;
      values.push([b.label, sku, descLookup_(ctx, '$B' + r), b.categorization,
        '=SUMIFS(' + colRef_(t.variance, 'I') + ',' + colRef_(t.variance, 'A') + ',$A' + r + ',' + colRef_(t.variance, 'B') + ',$B' + r + ')',
        costLookup_(ctx, 'cogs', '$B' + r), costLookup_(ctx, 'freight', '$B' + r), costLookup_(ctx, 'tariffs', '$B' + r),
        '=IFERROR(F' + r + '+G' + r + '+H' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')',
        '=IF(E' + r + '=0,0,IFERROR(E' + r + '*I' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))']);
    });
    var last = values.length;
    values.push(['Subtotal – ' + b.label, '', '', '', '=SUM(E' + first + ':E' + last + ')', '', '', '', '', '=SUM(J' + first + ':J' + last + ')']);
    subtotalRows.push(values.length);
  });
  var nf = { 4: '#,##0.####', 5: '$#,##0.00', 6: '$#,##0.00', 7: '$#,##0.00', 8: '$#,##0.00', 9: '$#,##0.00' };
  var m = model_(t.valuation, values, {
    textCols: [1], textFromRow: headerRow + 1, textToRow: mfgFirst ? mfgFirst - 1 : null,
    numberFormats: nf, numberFromRow: headerRow + 1,
    headerRows: [headerRow], titleRows: [1], blockRows: blockRows, subtotalRows: subtotalRows.concat([totalRow]),
    frozenRows: headerRow, tabColor: TAB_COLORS.summary,
    extraFormats: [{ row: 2, col: 2, rows: cats.length + 1, cols: 1, format: '$#,##0.00' }]
  });
  m.totalCell = 'B' + totalRow;
  return m;
}

// ---------------------------------------------------------------------------
// Rule 11: Outbound Summary
// ---------------------------------------------------------------------------

function outboundModel_(ctx, skus) {
  var t = ctx.tabs, c = ctx.cols;
  var channels = CONFIG.OUTBOUND_CHANNELS;
  var groups = channels.concat([CONFIG.AMAZON_CHANNEL_LABEL, 'All Channels']);
  var row3 = ['', ''], row4 = ['SKU', 'Avg Cost / Unit'];
  groups.forEach(function (g) { row3.push(g, ''); row4.push('Units', 'Total Cost'); });
  var values = [
    ['Outbound Summary — ' + ctx.month.label],
    ['Units by channel; one row per SKU sold (Shopify bundles kept whole). Channel names in row 3 drive the formulas. Each channel = Shopify orders + Ops Hub ' + CONFIG.OPS_HUB.manualLog.sheetName + ' rows with that Channel (Samples comes only from the log). Amazon = ledger Customer Shipments; ' + CONFIG.OPS_HUB.amzLog.sheetName + ' units are not sales.'],
    row3, row4
  ];
  var first = values.length + 1;
  skus.forEach(function (sku) {
    var r = values.length + 1;
    var row = [sku, costLookup_(ctx, 'total', '$A' + r)];
    var unitCols = [];
    channels.forEach(function (ch, j) {
      var u = colLetter_(3 + 2 * j);
      var f = '=SUMIFS(' + colRef_(t.shopify, c.shop.qty) + ',' + colRef_(t.shopify, c.shop.sku) + ',$A' + r + ',' +
        colRef_(t.shopify, c.shop.channel) + ',' + u + '$3)' +
        '+SUMIFS(' + colRef_(t.manualLog, 'D') + ',' + colRef_(t.manualLog, 'C') + ',$A' + r + ',' + colRef_(t.manualLog, 'B') + ',' + u + '$3)';
      row.push(f, '=IF(' + u + r + '=0,0,IFERROR(' + u + r + '*$B' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))');
      unitCols.push(u);
    });
    var au = colLetter_(3 + 2 * channels.length);
    row.push('=0-SUMIFS(' + colRef_(t.ledger, c.ledger.shipments) + ',' + colRef_(t.ledger, c.ledger.mapped) + ',$A' + r + ')',
      '=IF(' + au + r + '=0,0,IFERROR(' + au + r + '*$B' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))');
    unitCols.push(au);
    var costCols = unitCols.map(function (u) { return colLetter_(columnNumber_(u) + 1); });
    row.push('=' + unitCols.map(function (u) { return u + r; }).join('+'),
      '=IFERROR(' + costCols.map(function (x) { return x + r; }).join('+') + ',' + q_(CONFIG.NO_COST_TEXT) + ')');
    values.push(row);
  });
  var last = values.length;
  var total = ['TOTAL', ''];
  for (var k = 3; k <= 2 + 2 * groups.length; k++) {
    var L = colLetter_(k);
    total.push(last >= first ? '=SUM(' + L + first + ':' + L + last + ')' : 0);
  }
  values.push(total);
  var nf = { 1: '$#,##0.00' };
  for (var g = 0; g < groups.length; g++) { nf[2 + 2 * g] = '#,##0'; nf[3 + 2 * g] = '$#,##0.00'; }
  return model_(t.outbound, values, {
    textCols: [0], textFromRow: 5, numberFormats: nf, numberFromRow: 5,
    headerRows: [3, 4], titleRows: [1], subtotalRows: [values.length], frozenRows: 4, tabColor: TAB_COLORS.summary
  });
}

function columnNumber_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

// ---------------------------------------------------------------------------
// Rule 12: Checks
// ---------------------------------------------------------------------------

function flagIf_(countExpr, flagText) {
  return '=IF(' + countExpr + '=0,"OK","FLAG: "&' + countExpr + '&' + q_(' ' + flagText) + ')';
}

function checksModel_(ctx, info) {
  var t = ctx.tabs, c = ctx.cols;
  var NC = q_(CONFIG.NO_COST_TEXT), UN = q_(CONFIG.UNMAPPED_TEXT);
  var rows = [['#', 'Check', 'Result', 'Details']];
  function add(rule, check, result, details) { rows.push([rule, check, result, details || '']); }

  var noCost = 'COUNTIF(' + colRef_(t.variance, 'K') + ',' + NC + ')+COUNTIF(' + colRef_(t.outbound, 'B') + ',' + NC + ')';
  add('12.1', 'SKUs with no COGS cost', flagIf_('(' + noCost + ')', 'cells show "' + CONFIG.NO_COST_TEXT + '" — add these SKUs to the COGS tab'),
    info.noCostSkus.length ? 'Not on COGS: ' + info.noCostSkus.join(', ') : 'Every SKU has a COGS row.');
  add('12.2', 'SKUs with no description', flagIf_('COUNTIF(' + colRef_(t.variance, 'C') + ',' + q_(CONFIG.NO_DESCRIPTION_TEXT) + ')', 'rows — add them to the Ops Hub BOM'),
    info.noDescSkus.length ? 'No description: ' + info.noDescSkus.join(', ') : '');
  var unmapped = '(COUNTIF(' + colRef_(t.ledger, c.ledger.mapped) + ',' + UN + ')+COUNTIF(' + colRef_(t.amzStart, c.amzStart.mapped) + ',' + UN +
    ')+COUNTIFS(' + colRef_(t.biz, c.biz.mapped) + ',' + UN + ',' + colRef_(t.biz, c.biz.units) + ',">0"))';
  add('12.3', 'Amazon rows with no SKU mapping', flagIf_(unmapped, 'Amazon rows are not counted — add the MSKU/ASIN to AMZ SKU Map'),
    info.unmappedAsins.length ? 'Business Report ASINs with sales but no mapping: ' + info.unmappedAsins.join(', ') : '');
  add('12.3', 'AMZ SKU Map entries added this run', info.mapAdded.length ? 'INFO' : 'OK',
    info.mapAdded.length ? info.mapAdded.map(function (r) { return r[0] + ' (' + r[1] + ') → ' + r[2] + ' [' + r[3] + ']'; }).join('; ') : 'No new Amazon SKUs.');
  var mc = info.mapConflicts || [];
  add('12.3', 'Amazon MSKU/ASIN mapped to more than one of our SKUs', mc.length ? 'FLAG: ' + mc.length : 'OK',
    mc.length ? mc.map(function (x) { return x.kind + ' ' + x.key + ' → ' + x.skus.join(' / '); }).join('; ') +
      '. Only the FIRST matching row on AMZ SKU Map is used, so units may land on the wrong SKU — fix the map so each one points to a single SKU.' : '');
  add('5.4a', 'Shopify lines not counted (cancelled, or refunded/voided and never shipped)',
    '=IF(COUNTIF(' + colRef_(t.shopify, c.shop.counted) + ',"No*")=0,"OK","INFO: "&COUNTIF(' + colRef_(t.shopify, c.shop.counted) +
    ',"No*")&" lines / "&SUMIFS(' + colRef_(t.shopify, c.shop.rawQty) + ',' + colRef_(t.shopify, c.shop.counted) + ',"No*")&" units not counted")',
    'See the Counted column on ' + t.shopify + '. Refunded orders that were shipped still count — the product left ADS.');
  var logs = info.opsLogs;
  var logText = function (name, p) {
    return name + ': ' + p.rows.length + ' rows shipped ' + serialToMDY_(ctx.month.firstSerial) + '–' + ctx.month.endMDY +
      (p.notShipped ? '; ' + p.notShipped + ' rows with no Ship Date (not shipped — not counted)' : '') +
      (p.otherMonths ? '; ' + p.otherMonths + ' rows from other months (ignored)' : '');
  };
  add('5.6', 'Ops Hub shipment logs (shipped out of ADS)',
    (logs.manual.notShipped || logs.amz.notShipped) ? 'CHECK: rows with no Ship Date are not counted — confirm they had not shipped by ' + ctx.month.endMDY : 'INFO',
    logText(CONFIG.OPS_HUB.manualLog.sheetName, logs.manual) + '. ' + logText(CONFIG.OPS_HUB.amzLog.sheetName, logs.amz) + '.');
  add('12.4', 'Shopify lines with no SKU (not counted anywhere)',
    flagIf_('COUNTIFS(' + colRef_(t.shopify, c.shop.sku) + ',"",' + colRef_(t.shopify, c.shop.name) + ',"<>")', 'lines'), '');
  add('12.5', 'Rows where Expected Ending Inventory is negative', flagIf_('COUNTIF(' + colRef_(t.variance, 'H') + ',"<0")',
    'rows — more went out than came in; check kitting, receipts or starting balance'), 'Filter Variance Overview column H for values below 0.');
  var mfgB = colRef_(t.mfgInv, 'B'), mfgC = colRef_(t.mfgInv, 'C');
  add('12.6', 'MFG starting balances', 'INFO', info.mfgStartSource);
  add('12.6', 'MFG Counts filled in', '=IF(COUNTA(' + mfgB + ')<=1,"CHECK: no MFG rows — correct only if no MFG holds stock",IF(COUNTIFS(' + mfgB + ',"<>",' + mfgC +
    ',"")>0,"FLAG: "&COUNTIFS(' + mfgB + ',"<>",' + mfgC + ',"")&" rows with a SKU but no EOM Qty","OK"))',
    'Type each EOM Qty on ' + t.mfgInv + ' (Received Qty is optional). Variance Overview and Inventory Valuation update as you type.');
  add('9.5', 'MFG Counts fits the MFG section', '=IF(COUNTA(' + mfgB + ')-1>' + info.mfgRows + ',"FLAG: "&(COUNTA(' + mfgB + ')-1)&" rows on ' +
    t.mfgInv + ' but the MFG section has ' + info.mfgRows + ' — run buildEOM again (it makes room)","OK")', '');
  add('7', 'SKUs typed as numbers on the yellow tabs', flagIf_('COUNT(' + colRef_(t.adsReceipts, 'B') + ')',
    'SKU cells are stored as numbers — format the SKU column as Plain text and retype them'), '');
  add('7.2', 'ADS Receipts entered', '=IF(COUNTA(' + colRef_(t.adsReceipts, 'A') + ')<=1,"CHECK: none entered — correct only if ADS received nothing","OK")', '');
  add('12.7', 'Inventory Valuation total = sum of block subtotals',
    '=IF(ABS(' + q2_(t.valuation) + '!' + ctx.valuationTotalCell + '-SUMIF(' + colRef_(t.valuation, 'A') + ',"Subtotal*",' + colRef_(t.valuation, 'J') + '))<0.01,"OK","FLAG: totals do not tie")', '');
  add('12.8', 'Work orders parsed completely', 'OK',
    info.workOrders.lines + ' kit lines (' + info.workOrders.fees + ' fee lines skipped); line amounts $' + info.workOrders.lineTotal.toFixed(2) +
    ' = report TOTAL $' + info.workOrders.reportTotal.toFixed(2) + '; billing month ' + info.workOrders.month + '.');
  add('8.2', 'Kits built that have no BOM rows', info.kitsWithoutBom.length ? 'FLAG: ' + info.kitsWithoutBom.length : 'OK',
    info.kitsWithoutBom.length ? 'Components not deducted for: ' + info.kitsWithoutBom.join(', ') + ' — add them to the Ops Hub BOM.' : '');
  add('6.1', 'BOM duplicate rows removed', info.bomDuplicates.length ? 'INFO' : 'OK', info.bomDuplicates.join('; '));
  add('12.9', 'Starting balances came from', 'INFO', info.startSources);
  var tie = info.amzTie || {};
  var first = serialToMDY_(ctx.month.firstSerial), prevEnd = serialToMDY_(ctx.month.firstSerial - 1);
  if (tie.problem) {
    add('12.10', 'Amazon starting balance = last month\'s ending', 'FLAG: not compared', tie.problem);
  } else if (!tie.diffs) {
    add('12.10', 'Amazon starting balance = last month\'s ending', 'INFO', 'Not compared — no ' + prevEnd + ' Amazon ledger found (' + (tie.source || 'none') + ').');
  } else {
    add('12.10', 'Amazon starting balance = last month\'s ending', tie.diffs.length ? 'FLAG: ' + tie.diffs.length + ' SKU(s) differ' : 'OK',
      tie.diffs.length
        ? tie.diffs.map(function (d) { return d.sku + ': ' + prevEnd + ' ending ' + d.prevEnd + ' vs ' + first + ' starting ' + d.start + ' (' + (d.diff > 0 ? '+' : '') + d.diff + ')'; }).join('; ') +
          '. Beginning Inventory uses the ' + first + ' figure. Compared with ' + tie.source + '.'
        : 'Every Amazon SKU\'s ' + first + ' starting balance equals its ' + prevEnd + ' ending balance in ' + tie.source + '.');
  }
  add('5.2', 'Amazon ledger covers the whole month', 'OK', 'Every day from ' + serialToMDY_(ctx.month.firstSerial) + ' to ' + ctx.month.endMDY + ' is present.');
  add('5.3', 'Files with no dates inside', 'CHECK', 'The ADS snapshot and the Amazon Business Report contain no dates. Confirm the ADS snapshot was pulled on ' +
    ctx.month.endMDY + ' and the Business Report covers ' + serialToMDY_(ctx.month.firstSerial) + '–' + ctx.month.endMDY + '.');
  add('13.2', 'Shopify data came from', 'INFO', info.shopifySource);
  if (info.ignoredFiles.length) add('2', 'Files in the folder that were ignored', 'INFO', info.ignoredFiles.join('; '));
  add('', 'Built', 'INFO', info.builtAt);

  // Rule 12.13: Amazon Delta explained by ledger events (table below the checks).
  var skus = ctx.amzSkus || [];
  var tableHeaderRow = rows.length + 7, first = tableHeaderRow + 1, last = tableHeaderRow + skus.length;
  var unexplained = colLetter_(4 + CONFIG.COLUMNS.LEDGER.deltaEvents.length);
  var ordered = colLetter_(columnNumber_(unexplained) + 1), shipped = colLetter_(columnNumber_(unexplained) + 2);
  var rngU = unexplained + first + ':' + unexplained + last;
  add('12.13', 'Amazon Delta explained by ledger events', skus.length
    ? '=IF(COUNTIF(' + rngU + ',"<>0")=0,"OK","FLAG: "&COUNTIF(' + rngU + ',"<>0")&" SKU(s) have Delta the ledger does not explain — see table below")' : 'OK',
    'Table below: Variance Overview Delta per Amazon SKU, split into the ledger events that caused it. Unexplained should be 0.');
  add('12.13', 'Amazon units ordered vs shipped (Sold / Used uses shipped)', skus.length
    ? '="INFO: ordered "&SUM(' + ordered + first + ':' + ordered + last + ')&" / shipped "&SUM(' + shipped + first + ':' + shipped + last + ')' : 'OK',
    'Business Report Units Ordered vs ledger Customer Shipments, per SKU in the table below. Differences are timing (ordered late in the month, shipped next) and cancellations.');
  var checksEnd = rows.length;
  var L = c.ledger, a = c.amzStart;
  var sumL = function (col, r) { return 'SUMIFS(' + colRef_(t.ledger, col) + ',' + colRef_(t.ledger, L.mapped) + ',$A' + r + ')'; };
  var sumA = function (col, r) { return 'SUMIFS(' + colRef_(t.amzStart, col) + ',' + colRef_(t.amzStart, a.mapped) + ',$A' + r + ')'; };
  rows.push([], [], ['Amazon Delta explained (Rule 12.13) — Delta = Actual − Expected on Variance Overview; each column is that ledger event for the whole month (+ adds units, − removes them).'], []);
  rows.push(['Amazon SKU', 'Delta (Variance Overview)'].concat(L.events.map(function (e) { return e.name; }))
    .concat(['Transfers not matched by in-transit', 'Unexplained', 'Units Ordered (Business Report)', 'Units Shipped (ledger)', 'Ordered − Shipped']));
  skus.forEach(function (sku) {
    var r = rows.length + 1;
    var row = [sku, '=SUMIFS(' + colRef_(t.variance, 'J') + ',' + colRef_(t.variance, 'A') + ',' + q_(CONFIG.LOCATIONS.AMZ.label) + ',' + colRef_(t.variance, 'B') + ',$A' + r + ')'];
    L.events.forEach(function (e) { row.push('=' + sumL(e.col, r)); });
    row.push('=' + sumL(L.transfers, r) + '-' + sumA(a.transfers, r) + '+' + amzLastDayFormula_(ctx, '$A' + r, ['inTransit']).slice(1) + '-' + sumA(a.inTransit, r));
    var tCol = colLetter_(row.length);
    row.push('=B' + r + '-SUM(C' + r + ':' + tCol + r + ')');
    row.push('=SUMIFS(' + colRef_(t.biz, c.biz.units) + ',' + colRef_(t.biz, c.biz.mapped) + ',$A' + r + ')');
    row.push('=0-' + sumL(L.shipments, r));
    row.push('=' + ordered + r + '-' + shipped + r);
    rows.push(row);
  });
  var width = rows[tableHeaderRow - 1].length;
  var m = model_(t.checks, rows, { textCols: [0, 1, 3], textToRow: checksEnd, tabColor: TAB_COLORS.summary, isChecks: true,
    checksEndRow: checksEnd, headerRows: [1, tableHeaderRow], titleRows: [tableHeaderRow - 2],
    extraFormats: skus.length ? [{ row: first, col: 1, rows: skus.length, cols: 1, format: '@' },
      { row: first, col: 2, rows: skus.length, cols: width - 1, format: '#,##0;-#,##0;0' }] : [] });
  return m;
}

function q2_(tab) { return "'" + String(tab).replace(/'/g, "''") + "'"; }

// ---------------------------------------------------------------------------
// README (Rule 14.5)
// ---------------------------------------------------------------------------

function readmeModel_(ctx) {
  var t = ctx.tabs;
  var rows = [['Tab', 'What it is', 'Rule (RULES.md)'],
    [t.checks, 'QC only: automatic checks. Anything that says FLAG needs attention. Delete this tab before sending — nothing points at it.', '12'],
    [t.variance, 'Beginning + Receiving − Sold/Used = Expected; compared with Actual. Blocks: ADS, Amazon, MFG (row by row from MFG Counts).', '9'],
    [t.valuation, 'Actual ending units × COGS cost. Totals box at the top.', '10'],
    [t.outbound, 'Units and cost by channel for every SKU sold.', '11'],
    [t.mfgInv, 'YOU TYPE: EOM Qty (and Received Qty if any) per MFG + SKU. Starts with last month\'s MFG + SKU rows; add new ones at the bottom, reorder freely. Never overwritten.', '7.1'],
    [t.adsReceipts, 'YOU TYPE: PO Number, SKU, Qty received at ADS. Never overwritten.', '7.2'],
    [t.mfgStart, 'Last month\'s MFG EOM quantities (from last month\'s MFG Counts; first run: the hand-built workbook).', '4.3'],
    [t.prepaid, 'YOU TYPE: prepaid POs. Feeds nothing.', '7.3'],
    [t.cogs, 'Unit costs. Carried from last month; edit here.', '6.2'],
    [t.skuMap, 'Amazon MSKU / ASIN → our SKU. New Amazon SKUs are added automatically.', '6.3'],
    [t.bundleMap, 'Shopify SKUs split into components (80090,80090 → 80090 × 2).', '8.1'],
    [t.kit, 'Components used by kits built this month (BOM qty × kits built).', '8.2'],
    [t.adsStart, 'Last month\'s ADS ending snapshot.', '4.1'],
    [t.adsEnd, 'ADS snapshot at month end, as received.', '5'],
    [t.amzStart, 'This month\'s Amazon ledger, 1st-of-month rows only; Beginning = Starting Warehouse Balance + units between Amazon warehouses.', '4.2'],
    [t.ledger, 'Amazon Inventory Ledger for the whole month (daily).', '5.2'],
    [t.biz, 'Amazon Business Report — reference only (Units Ordered vs shipped on Checks). Amazon units sold = ledger Customer Shipments.', '5.3'],
    [t.shopify, 'Shopify orders; Order Tags, Channel, Counted and Counted Qty columns added at the right (cancelled / refunded-not-shipped lines don\'t count).', '5.4'],
    [t.workOrders, 'ADS work orders (kits built), fee lines removed.', '5.5'],
    [t.manualLog, 'This month\'s rows of Ops Hub ' + CONFIG.OPS_HUB.manualLog.sheetName + ' (by Ship Date): hand-entered shipments out of ADS, with their sales channel.', '5.6'],
    [t.amzLog, 'This month\'s rows of Ops Hub ' + CONFIG.OPS_HUB.amzLog.sheetName + ' (by Ship Date): units shipped out of ADS to Amazon. They only reduce ADS — Amazon\'s side is the ledger.', '5.6'],
    [t.bom, 'Bill of materials copied from Ops Hub on build day.', '6.1'],
    [t.skuList, 'SKU descriptions from the BOM.', '6.4'],
    ['', '', ''],
    ['Colors', 'Green = summaries, Yellow = you type here, Blue = reference, Purple = helpers, Gray = raw reports.', '']];
  return model_(t.readme, rows, { textCols: [0, 1, 2], tabColor: TAB_COLORS.summary });
}

// ---------------------------------------------------------------------------
// Whole workbook (pure). Main.gs gathers `inputs`, Sheets.gs writes the result.
// ---------------------------------------------------------------------------

/**
 * inputs = {
 *   month, todayStr, builtAt,
 *   ads, adsStart, ledger, biz, shopify  : {header, rows}
 *   manualLog, amzLog : parseOpsLog_ results (this month's rows of the Ops Hub shipment logs)
 *   amzPrevEnd : {rows: {header, rows} | null, source: text, problem: text | null}  (Rule 4.2a tie-out; optional)
 *   workOrders : parseWorkOrdersHtml_ result
 *   bomValues  : raw values from the Ops Hub BOM columns
 *   cogs       : {header, rows}                 (values)
 *   skuMapExisting : [[msku, asin, sku, note]]
 *   mfgInv : [[mfg, sku, eom, recv]] | null (null = MFG Counts tab not created yet), mfgStart : [[mfg, sku, eom]], mfgStartFromPrev : bool
 *   adsReceipts : [[po, sku, qty]]
 *   prepaid : {header, rows} | null
 *   copyFrom : {cogs, prepaid}   (where to copy those tabs from if they don't exist yet)
 *   sources : {startSources, shopifySource, mfgStartSource}, ignoredFiles : []
 * }
 */
function buildWorkbookModel_(inputs) {
  var m = inputs.month;
  var tabs = tabNames_(m);
  var C = CONFIG.COLUMNS;

  checkLedgerCoversMonth_(inputs.ledger, m);
  // Rule 4.2: Amazon starting balance = this month's 1st-of-month rows.
  var amzStart = ledgerFirstDateRows_(inputs.ledger, m);

  // --- AMZ SKU Map (Rule 6.3)
  var pairs = [];
  [amzStart, inputs.ledger].forEach(function (tbl) {
    var mi = headerIndex_(tbl.header, C.LEDGER.msku), ai = headerIndex_(tbl.header, C.LEDGER.asin);
    tbl.rows.forEach(function (r) { pairs.push({ msku: cleanSku_(r[mi]), asin: ai >= 0 ? cleanSku_(r[ai]) : '' }); });
  });
  var map = mergeSkuMap_(inputs.skuMapExisting || [], pairs, inputs.todayStr);

  // Rule 4.2a: tie-out by our SKU (map first; MSKUs only in last month's ledger use the Rule 6.3 rename).
  var tie = inputs.amzPrevEnd || {};
  var skuOf = function (msku) { return lookupMap_(map.rows, 0, msku) || mapAmazonSku_(msku).sku; };
  var amzTie = tie.rows ? { diffs: amzTieOut_(tie.rows, amzStart, skuOf), source: tie.source } : { diffs: null, source: tie.source, problem: tie.problem };

  // --- raw tabs
  var adsStartModel = adsModel_(tabs.adsStart, inputs.adsStart);
  var adsEndModel = adsModel_(tabs.adsEnd, inputs.ads);
  var ledgerM = ledgerModel_(tabs.ledger, inputs.ledger, tabs);
  var amzStartM = ledgerModel_(tabs.amzStart, amzStart, tabs);
  var bizM = bizModel_(tabs.biz, inputs.biz, tabs);
  var shopM = shopifyModel_(tabs.shopify, inputs.shopify);
  if (inputs.shopifyCopyFrom) shopM.copyFrom = inputs.shopifyCopyFrom;
  var woM = workOrdersModel_(tabs.workOrders, inputs.workOrders);
  var manualLogM = opsLogModel_(tabs.manualLog, inputs.manualLog, 'manual');
  var amzLogM = opsLogModel_(tabs.amzLog, inputs.amzLog, 'amz');
  var bom = bomFromSource_(inputs.bomValues);
  var bomM = bomModel_(tabs.bom, bom, inputs.todayStr);

  // --- column letters the summaries use
  var cogsH = inputs.cogs.header;
  var cogs = {};
  for (var k in CONFIG.COGS_COLUMNS) cogs[k] = colLetter_(requireHeader_(cogsH, CONFIG.COGS_COLUMNS[k], 'COGS tab') + 1);
  var ledgerMapped = colLetter_(inputs.ledger.header.length + 1);
  var ctx = {
    month: m, tabs: tabs, cogs: cogs,
    cols: {
      adsStart: { sku: colLetter_(headerIndex_(inputs.adsStart.header, C.ADS.sku) + 1), qty: colLetter_(headerIndex_(inputs.adsStart.header, C.ADS.qty) + 1) },
      adsEnd: { sku: colLetter_(headerIndex_(inputs.ads.header, C.ADS.sku) + 1), qty: colLetter_(headerIndex_(inputs.ads.header, C.ADS.qty) + 1) },
      ledger: {
        date: colLetter_(headerIndex_(inputs.ledger.header, C.LEDGER.date) + 1),
        receipts: colLetter_(headerIndex_(inputs.ledger.header, C.LEDGER.receipts) + 1),
        ending: colLetter_(headerIndex_(inputs.ledger.header, C.LEDGER.ending) + 1),
        inTransit: colLetter_(requireHeader_(inputs.ledger.header, C.LEDGER.inTransit, 'Amazon Inventory Ledger') + 1),
        transfers: colLetter_(requireHeader_(inputs.ledger.header, C.LEDGER.transfers, 'Amazon Inventory Ledger') + 1),
        shipments: colLetter_(requireHeader_(inputs.ledger.header, C.LEDGER.shipments, 'Amazon Inventory Ledger') + 1),
        events: C.LEDGER.deltaEvents.map(function (h) { return { name: h, col: colLetter_(requireHeader_(inputs.ledger.header, h, 'Amazon Inventory Ledger') + 1) }; }),
        mapped: ledgerMapped
      },
      amzStart: {
        starting: colLetter_(requireHeader_(amzStart.header, C.LEDGER.starting, 'Amazon Inventory Ledger') + 1),
        inTransit: colLetter_(requireHeader_(amzStart.header, C.LEDGER.inTransit, 'Amazon Inventory Ledger') + 1),
        transfers: colLetter_(requireHeader_(amzStart.header, C.LEDGER.transfers, 'Amazon Inventory Ledger') + 1),
        mapped: colLetter_(amzStart.header.length + 1)
      },
      biz: { units: colLetter_(headerIndex_(inputs.biz.header, C.BIZ.units) + 1), mapped: colLetter_(inputs.biz.header.length + 1) },
      shop: shopifyLetters_(inputs.shopify.header)
    }
  };

  // --- SKU sets (Rule 9.2 / 11.1)
  function col(tbl, name) { var i = headerIndex_(tbl.header, name); return tbl.rows.map(function (r) { return cleanSku_(r[i]); }); }
  // Rule 5.4a / 5.6: only lines that count create rows.
  var shopCounted = shopifyLinesCounted_(inputs.shopify);
  var shopSkus = uniqueSorted_(col(inputs.shopify, C.SHOPIFY.sku).filter(function (_, i) { return shopCounted[i]; }));
  var bundleComponents = [];
  shopSkus.forEach(function (s) { splitBundle_(s).forEach(function (p) { bundleComponents.push(p.sku); }); });
  var kitParents = uniqueSorted_(inputs.workOrders.lines.filter(function (l) { return Number(l.pieces) > 0; }).map(function (l) { return l.sku; }));
  var manualLogSkus = inputs.manualLog.rows.map(function (r) { return r[2]; });
  var amzLogSkus = inputs.amzLog.rows.map(function (r) { return r[2]; });

  var adsSkus = uniqueSorted_([].concat(
    col(inputs.adsStart, C.ADS.sku), col(inputs.ads, C.ADS.sku),
    (inputs.adsReceipts || []).map(function (r) { return cleanSku_(r[1]); }),
    kitParents, manualLogSkus, amzLogSkus, bundleComponents));

  var ledgerMskus = col(inputs.ledger, C.LEDGER.msku).concat(col(amzStart, C.LEDGER.msku));
  var bizAsins = col(inputs.biz, C.BIZ.asin);
  var bizUnitsIdx = headerIndex_(inputs.biz.header, C.BIZ.units);
  var amzFromLedger = ledgerMskus.map(function (s) { return lookupMap_(map.rows, 0, s); });
  var amzFromBiz = [], unmappedAsins = [];
  inputs.biz.rows.forEach(function (r, i) {
    var units = toNumber_(r[bizUnitsIdx], 'in the Amazon Business Report (Units Ordered), row ' + (i + 2));
    if (!(units > 0)) return;
    var sku = lookupMap_(map.rows, 1, bizAsins[i]);
    if (sku) amzFromBiz.push(sku); else unmappedAsins.push(bizAsins[i]);
  });
  var amzSkus = uniqueSorted_(amzFromLedger.concat(amzFromBiz).filter(function (s) { return s; }));

  // Rule 9.5: one MFG section; its rows mirror the MFG Counts tab row by row.
  var mfgCounts = mfgCountsRows_(inputs);
  var mfgSkus = uniqueSorted_(mfgCounts.map(function (r) { return cleanSku_(r[1]); }));

  var blocks = [{ kind: 'ADS', label: CONFIG.LOCATIONS.ADS.label, categorization: CONFIG.LOCATIONS.ADS.categorization, skus: adsSkus },
    { kind: 'AMZ', label: CONFIG.LOCATIONS.AMZ.label, categorization: CONFIG.LOCATIONS.AMZ.categorization, skus: amzSkus }];
  blocks.push({ kind: 'MFG', label: CONFIG.LOCATIONS.MFG.label, categorization: CONFIG.LOCATIONS.MFG.categorization, skus: mfgSkus,
    rows: Math.max(CONFIG.MFG_ROWS, mfgCounts.length + 10) });

  // Rule 11.1: Amazon SKUs on Outbound = mapped SKUs with Customer Shipments in the ledger.
  var shipI = headerIndex_(inputs.ledger.header, C.LEDGER.shipments), mskuI = headerIndex_(inputs.ledger.header, C.LEDGER.msku);
  var amzShipped = {};
  inputs.ledger.rows.forEach(function (r, i) {
    var q = toNumber_(r[shipI], 'in the Amazon Inventory Ledger (Customer Shipments), row ' + (i + 2));
    var sku = lookupMap_(map.rows, 0, cleanSku_(r[mskuI]));
    if (q && sku) amzShipped[sku] = true;
  });
  var outboundSkus = uniqueSorted_(shopSkus.concat(manualLogSkus).concat(Object.keys(amzShipped)));
  ctx.amzSkus = amzSkus;

  // --- reference + helper tabs
  var allSkus = uniqueSorted_([].concat(adsSkus, amzSkus, outboundSkus,
    blocks.slice(2).reduce(function (a, b) { return a.concat(b.skus); }, [])));
  var descs = skuDescriptions_(bom.descs, allSkus);
  var bundleM = bundleMapModel_(tabs.bundleMap, shopSkus, tabs, ctx.cols.shop);
  var kitM = kitConsumptionModel_(tabs.kit, kitParents, bom.rows, tabs);

  // --- summaries
  var varianceM = varianceModel_(ctx, blocks);
  var valuationM = valuationModel_(ctx, blocks);
  ctx.valuationTotalCell = valuationM.totalCell;
  var outboundM = outboundModel_(ctx, outboundSkus);

  var cogsKeys = {};
  var cogsKeyIdx = headerIndex_(cogsH, CONFIG.COGS_COLUMNS.key);
  inputs.cogs.rows.forEach(function (r) { cogsKeys[cleanSku_(r[cogsKeyIdx])] = true; });
  var costedSkus = uniqueSorted_([].concat(adsSkus, amzSkus, outboundSkus, blocks.slice(2).reduce(function (a, b) { return a.concat(b.skus); }, [])));
  var info = {
    noCostSkus: costedSkus.filter(function (s) { return !cogsKeys[s]; }),
    noDescSkus: allSkus.filter(function (s) { return !descs.desc[s]; }),
    unmappedAsins: uniqueSorted_(unmappedAsins),
    mapAdded: map.added,
    amzTie: amzTie,
    mapConflicts: skuMapConflicts_(map.rows),
    kitsWithoutBom: kitM.kitsWithoutBom,
    bomDuplicates: bom.duplicates,
    workOrders: { lines: inputs.workOrders.lines.length, fees: inputs.workOrders.feeLines, lineTotal: inputs.workOrders.lineTotal,
      reportTotal: inputs.workOrders.reportTotal, month: inputs.workOrders.from },
    startSources: (inputs.sources && inputs.sources.startSources) || '',
    shopifySource: (inputs.sources && inputs.sources.shopifySource) || '',
    mfgStartSource: (inputs.sources && inputs.sources.mfgStartSource) || '',
    mfgRows: blocks[blocks.length - 1].rows,
    ignoredFiles: inputs.ignoredFiles || [],
    opsLogs: { manual: inputs.manualLog, amz: inputs.amzLog },
    builtAt: inputs.builtAt || inputs.todayStr
  };
  var checksM = checksModel_(ctx, info);

  // --- manual / carried tabs
  var H = CONFIG.MANUAL_TABS;
  var mfgInvM = manualTabModel_(tabs.mfgInv, H.MFG_COUNTS, mfgCounts, [2, 3]);
  var mfgStartM = manualTabModel_(tabs.mfgStart, H.MFG_STARTING, inputs.mfgStart, [2]);
  if (inputs.mfgStartFromPrev) { mfgStartM.preserveIfExists = false; mfgStartM.tabColor = TAB_COLORS.raw; }
  var adsRecM = manualTabModel_(tabs.adsReceipts, H.ADS_RECEIPTS, inputs.adsReceipts, [2]);
  var cogsM = model_(tabs.cogs, [inputs.cogs.header].concat(inputs.cogs.rows), {
    preserveIfExists: true, tabColor: TAB_COLORS.manual, copyFrom: inputs.copyFrom ? inputs.copyFrom.cogs : null });
  var prepaidM = inputs.prepaid
    ? model_(tabs.prepaid, [inputs.prepaid.header].concat(inputs.prepaid.rows), { preserveIfExists: true, tabColor: TAB_COLORS.manual,
      copyFrom: inputs.copyFrom ? inputs.copyFrom.prepaid : null })
    : manualTabModel_(tabs.prepaid, H.PREPAID, [], [4, 5, 6, 7]);

  var sheets = [
    readmeModel_(ctx), checksM, varianceM, valuationM, outboundM,
    mfgInvM, adsRecM, mfgStartM, prepaidM, cogsM, skuMapModel_(tabs.skuMap, map.rows),
    bundleM, kitM, adsStartModel, adsEndModel, amzStartM, ledgerM, bizM, shopM, woM, manualLogM, amzLogM,
    bomM, skuListModel_(tabs.skuList, descs)
  ];
  return { tabs: tabs, sheets: sheets, info: info, blocks: blocks, ctx: ctx };
}

/** Every formula in a model list (used by tests and by a safety check before writing). */
function allFormulas_(sheets) {
  var out = [];
  sheets.forEach(function (s) {
    s.values.forEach(function (row, r) {
      row.forEach(function (v, c) { if (typeof v === 'string' && v.charAt(0) === '=') out.push({ sheet: s.name, row: r + 1, col: c + 1, f: v }); });
    });
  });
  return out;
}

/** Rule 14.1: stops if any formula uses a function that breaks in Excel. */
function assertExcelSafe_(sheets) {
  var re = new RegExp('\\b(' + FORBIDDEN_FUNCTIONS.join('|') + ')\\s*\\(', 'i');
  allFormulas_(sheets).forEach(function (x) {
    var stripped = x.f.replace(/"(?:[^"]|"")*"/g, '""').replace(/'(?:[^']|'')*'!/g, "''!");
    var m = re.exec(stripped);
    if (m) throw new Error('Internal check: formula on ' + x.sheet + ' row ' + x.row + ' uses ' + m[1] + ', which breaks in Excel.');
  });
}
