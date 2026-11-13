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
    woFixes: 'WO SKU Fixes',
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
    t.mfgInv, t.adsReceipts, t.woFixes, t.mfgStart, t.prepaid, t.cogs, t.skuMap,
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

/** Rule 8.1a: does one unit sold of this Shopify SKU use a mailer? Listed SKUs, plus any bundle containing a pouch. */
function usesMailer_(sku) {
  var mr = CONFIG.MAILER_RULE;
  if (mr.soldSkus.indexOf(sku) >= 0) return true;
  return String(sku).indexOf(',') >= 0 && splitBundle_(sku).some(function (p) { return mr.bundlePouches.indexOf(p.sku) >= 0; });
}

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

// ---------------------------------------------------------------------------
// Rule 5.5a: which SKU each work-order kit line is for
// ---------------------------------------------------------------------------

function woKey_(text) { return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim().toUpperCase(); }

/** The distinct BOM kit SKUs (Parent SKU) that appear as whole words in `text` ("AMAZON KIT A0030" → ['A0030']). */
function kitSkusInText_(text, parents) {
  var out = [];
  String(text || '').split(/[\s,;:()\/]+/).forEach(function (w) {
    var c = cleanSku_(w);
    if (c && parents[c] && out.indexOf(c) < 0) out.push(c);
  });
  return out;
}

/**
 * Rule 5.5a. ADS sometimes leaves Job blank or types words in it ("AMAZON KIT A0030"). For each kit line:
 *   1. Job is one word (a SKU)                                → Job, as before.
 *   2. "Reported as" (Job, or Description when Job is blank) is on the WO SKU Fixes tab with a SKU → that SKU.
 *   3. exactly one BOM kit SKU appears as a word in Job (else in Description) → that SKU (added to WO SKU Fixes).
 *   4. otherwise → no SKU: the kits are not counted, the line is added to WO SKU Fixes for you to fill, FLAG on Checks.
 * fixRows = [[reported as, our SKU, note]] carried from the tab. Never guesses beyond an exact SKU word.
 */
function resolveWorkOrderSkus_(lines, bomRows, fixRows, todayStr) {
  var parents = {};
  bomRows.forEach(function (b) { parents[b[0]] = true; });
  var rows = (fixRows || []).map(function (r) { return [textCell_(r[0]), cleanSku_(r[1]), textCell_(r[2])]; })
    .filter(function (r) { return r[0] !== ''; });
  var byKey = {};
  rows.forEach(function (r) { if (!byKey[woKey_(r[0])]) byKey[woKey_(r[0])] = r; });
  var corrected = [], unresolved = [];
  var out = lines.map(function (l) {
    var job = cleanSku_(l.sku);
    var x = {}; for (var k in l) x[k] = l[k];
    x.job = job;
    x.reportedAs = job !== '' ? job : String(l.description || '').replace(/\s+/g, ' ').trim();
    var how = '', sku = '';
    if (job !== '' && !/\s/.test(job)) {
      sku = job; how = 'Job';
    } else {
      var fix = byKey[woKey_(x.reportedAs)];
      if (fix && fix[1] !== '') {
        sku = fix[1]; how = 'WO SKU Fixes tab';
      } else {
        var found = job !== '' ? kitSkusInText_(job, parents) : [];
        var where = 'Job';
        if (!found.length) { found = kitSkusInText_(l.description, parents); where = 'Description'; }
        if (found.length === 1) {
          sku = found[0]; how = 'found ' + sku + ' in ' + where;
          var note = 'Added ' + todayStr + ': ' + how + ' — change the SKU if this is wrong';
          if (fix) { fix[1] = sku; fix[2] = note; } else { fix = [x.reportedAs, sku, note]; rows.push(fix); byKey[woKey_(x.reportedAs)] = fix; }
        } else if (!fix && x.reportedAs !== '') {
          fix = [x.reportedAs, '', 'Added ' + todayStr + ': type our SKU — these kits are NOT counted until you do' +
            (found.length > 1 ? ' (more than one kit SKU in the text: ' + found.join(', ') + ')' : '')];
          rows.push(fix); byKey[woKey_(x.reportedAs)] = fix;
        }
      }
    }
    x.sku = sku;
    x.how = sku ? how : 'NOT COUNTED — no SKU (see Checks / WO SKU Fixes)';
    if (!sku) unresolved.push(x); else if (how !== 'Job') corrected.push(x);
    return x;
  });
  return { lines: out, fixRows: rows, corrected: corrected, unresolved: unresolved };
}

/** Rule 5.5a: the WO SKU Fixes tab (yellow; carried month to month like AMZ SKU Map; your SKUs are kept). */
function woFixesModel_(name, rows) {
  return model_(name, [['Reported as (Job, or Description when Job is blank)', 'Our SKU', 'Note']].concat(rows), {
    textCols: [0, 1, 2], tabColor: TAB_COLORS.manual
  });
}

/** One line of a work-order list for Checks. */
function woLineText_(l) {
  return l.wo + ' ' + l.date + ': ' + (l.job === '' ? 'Job blank, Description "' + l.description + '"' : 'Job "' + l.job + '"') +
    (l.sku ? ' → ' + l.sku + ' (' + l.how + ')' : '') + ' — ' + l.pieces + ' kits';
}

/** Rule 5.5: one row per kit line. */
function workOrdersModel_(name, parsed) {
  var header = ['Work Order', 'Ticket Number', 'Description (from report)', 'Date', 'SKU', 'Pieces', 'Rate', 'Rate Type', 'Amount',
    'Job (as reported)', 'How the SKU was found (Rule 5.5a)'];
  var rows = parsed.lines.map(function (l) {
    return [l.wo, l.ticket, l.description, l.date, l.sku, l.pieces, l.rate, l.rateType, l.amount,
      l.job === undefined ? l.sku : l.job, l.how || 'Job'];
  });
  return model_(name, [header].concat(rows), {
    textCols: [0, 1, 2, 3, 4, 7, 9, 10],
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

/** Rule 8.1b: is this BOM line the mailer a pouch gets only when it ships on its own (not in the pouch on the shelf)? */
function mailerAddedWhenShipped_(parent, child) {
  return child === CONFIG.MAILER_RULE.sku && usesMailer_(parent);
}

function bomModel_(name, bom, todayStr) {
  var mr = CONFIG.MAILER_RULE;
  var values = [['Parent SKU', 'Parent Desc', 'Child SKU', 'Child Desc', 'Qty', mr.bomFlagHeader,
    'Copied from Ops Hub 2.0 "' + CONFIG.BOM_SOURCE.sheetName + '" tab (columns ' + CONFIG.BOM_SOURCE.columns + ') on ' + todayStr +
    '. Rows where Parent = Child removed (' + bom.identity + '), duplicate rows removed (' + bom.duplicates.length + '). ' +
    '"' + mr.bomFlag + '" in column F = the mailer a pouch gets only when it ships on its own: it is not in the pouch on the shelf, ' +
    'so it is taken out of on-hand cost and added back on Outbound Summary (Rule 8.1b).']];
  bom.rows.forEach(function (r) { values.push(r.concat([mailerAddedWhenShipped_(r[0], r[2]) ? mr.bomFlag : '', ''])); });
  return model_(name, values, { textCols: [0, 1, 2, 3, 5], numberFormats: { 4: '0.#########' }, tabColor: TAB_COLORS.reference });
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

/** Rule 6.2: a new COGS tab — one row per SKU (A→Z), costs blank, Total / Unit = sum (blank until a cost is typed). */
function blankCogsModel_(name, skus, descs) {
  var H = CONFIG.COGS_HEADER, C = CONFIG.COGS_COLUMNS;
  var col = function (n) { return colLetter_(requireHeader_(H, n, 'COGS_HEADER in Config') + 1); };
  var parts = [col(C.cogs), col(C.freight), col(C.tariffs)];
  var keyI = headerIndex_(H, C.key), descI = headerIndex_(H, 'Description'), totalI = headerIndex_(H, C.total);
  var values = [H.slice()];
  skus.forEach(function (sku) {
    var r = values.length + 1, row = H.map(function () { return ''; });
    var cells = parts.map(function (p) { return p + r; }).join(',');
    row[keyI] = sku;
    if (descI >= 0) row[descI] = descs.desc[sku] || '';
    row[totalI] = '=IF(COUNT(' + cells + ')=0,"",SUM(' + cells + '))';
    values.push(row);
  });
  var nf = {};
  H.forEach(function (h, i) { if (i !== keyI && i !== descI) nf[i] = '$#,##0.00'; });
  return model_(name, values, { textCols: [keyI], numberFormats: nf, tabColor: TAB_COLORS.manual, preserveIfExists: true });
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
  var values = [['Sold SKU (Shopify)', 'Component SKU', 'Count of component in Sold SKU', 'Units Sold (all Shopify channels)', 'Component Units Shipped', 'Why']];
  function add(sold, comp, count, why) {
    var r = values.length + 1;
    values.push([sold, comp, count,
      '=SUMIFS(' + colRef_(tabs.shopify, shop.qty) + ',' + colRef_(tabs.shopify, shop.sku) + ',$A' + r + ')',
      '=C' + r + '*D' + r, why]);
  }
  soldSkus.forEach(function (sold) {
    splitBundle_(sold).forEach(function (p) { add(sold, p.sku, p.count, ''); });
  });
  // Rule 8.1a: mailer rows, after the bundle rows.
  var mr = CONFIG.MAILER_RULE;
  soldSkus.forEach(function (sold) {
    if (usesMailer_(sold)) add(sold, mr.sku, mr.perUnit, 'Mailer rule (Rule 8.1a)');
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
  // Rule 6.2: match the SKU as text, then as a number (a COGS SKU typed as 10030 is a number; ours is text "10030").
  var val = colRef_(ctx.tabs.cogs, ctx.cogs[which]), key = colRef_(ctx.tabs.cogs, ctx.cogs.key);
  var byText = 'INDEX(' + val + ',MATCH(' + skuCell + ',' + key + ',0))', byNumber = 'INDEX(' + val + ',MATCH(' + skuCell + '*1,' + key + ',0))';
  // Total / Unit must be a number: blank (cost not typed yet) → NO COST, never $0. (0/0 = an error, so the next try runs.)
  var num = function (x) { return which === 'total' ? 'IF(ISNUMBER(' + x + '),' + x + ',0/0)' : x; };
  return '=IFERROR(' + num(byText) + ',IFERROR(' + num(byNumber) + ',' + q_(CONFIG.NO_COST_TEXT) + '))';
}

/**
 * Rule 11.2a: one SKU's COGS Total / Unit as a formula expression (no "=") that ERRORS when there is no number —
 * SKU matched as text, then as a number. `skuExpr` is a cell ("$A5") or a quoted SKU ("\"80030\"").
 * `positiveOnly`: a $0 Total also errors (a bundle never really costs $0, so its parts are used instead).
 */
function cogsTotalExpr_(ctx, skuExpr, positiveOnly) {
  var val = colRef_(ctx.tabs.cogs, ctx.cogs.total), key = colRef_(ctx.tabs.cogs, ctx.cogs.key);
  var num = function (x) { return 'IF(ISNUMBER(' + x + '),' + (positiveOnly ? 'IF(' + x + '>0,' + x + ',0/0)' : x) + ',0/0)'; };
  return 'IFERROR(' + num('INDEX(' + val + ',MATCH(' + skuExpr + ',' + key + ',0))') + ',' +
    num('INDEX(' + val + ',MATCH(' + skuExpr + '*1,' + key + ',0))') + ')';
}

/** Rule 8.1b: the mailer's COGS Total / Unit as an expression (no "=") that ERRORS when the mailer has no cost. */
function mailerCostExpr_(ctx) { return cogsTotalExpr_(ctx, q_(CONFIG.MAILER_RULE.sku), false); }

/**
 * Rule 8.1b: the mailer dollars inside one unit's COGS cost that are NOT in the unit on the shelf: the qty on this
 * SKU's BOM-tab lines marked "added when shipped" (column F) × the mailer's COGS Total / Unit. 0 when there is no
 * such line (then the mailer's cost is not needed). `skuExpr` is a cell ("$B5") or a quoted SKU ("\"80030\"").
 */
function mailerInCostExpr_(ctx, skuExpr) {
  var t = ctx.tabs;
  var qty = 'SUMIFS(' + colRef_(t.bom, 'E') + ',' + colRef_(t.bom, 'A') + ',' + skuExpr + ',' + colRef_(t.bom, 'F') + ',' + q_(CONFIG.MAILER_RULE.bomFlag) + ')';
  return 'IF(' + qty + '=0,0,' + qty + '*' + mailerCostExpr_(ctx) + ')';
}

/** Rule 8.1b: on-hand cost = COGS Total / Unit − the mailer added when shipped, as an expression that ERRORS when there is no cost. */
function shelfCostExpr_(ctx, skuExpr, positiveOnly) {
  return cogsTotalExpr_(ctx, skuExpr, positiveOnly) + '-' + mailerInCostExpr_(ctx, skuExpr);
}

/** Rule 8.1b / 9.3 / 10.1: on-hand cost per unit (Variance Overview, Inventory Valuation), or NO COST. */
function shelfCostFormula_(ctx, skuCell) {
  return '=IFERROR(' + shelfCostExpr_(ctx, skuCell, false) + ',' + q_(CONFIG.NO_COST_TEXT) + ')';
}

/** Rule 10.1: Inventory Valuation "Less: Mailer (added when shipped)" — the mailer dollars taken out of COGS (0 for most SKUs). */
function mailerDeductionFormula_(ctx, skuCell) {
  return '=IFERROR(' + mailerInCostExpr_(ctx, skuCell) + ',' + q_(CONFIG.NO_COST_TEXT) + ')';
}

/**
 * Rule 11.2a / 8.1b: Outbound Summary Avg Cost / Unit. A plain SKU = its COGS Total / Unit (rule 6.2). A bundle SKU
 * ("80030,51002") = its own COGS Total / Unit when that is above $0, otherwise the sum of its parts
 * (split on commas exactly like the Bundle Map, rule 8.1: count × each part's COGS Total / Unit).
 * A SKU that ships in a mailer on Shopify (rule 8.1a) = on-hand cost (own, or parts) + exactly ONE mailer:
 * that is what one Shopify unit costs as shipped. Any part (or the mailer) without a cost → NO COST.
 */
function outboundCostFormula_(ctx, sku, skuCell) {
  var parts = splitBundle_(sku), NC = q_(CONFIG.NO_COST_TEXT);
  var mailer = usesMailer_(sku);
  var plusMailer = mailer ? '+' + mailerCostExpr_(ctx) : '';
  if (String(sku).indexOf(',') < 0 || !parts.length) {
    return mailer ? '=IFERROR(' + shelfCostExpr_(ctx, skuCell, false) + plusMailer + ',' + NC + ')' : costLookup_(ctx, 'total', skuCell);
  }
  var partCost = function (p) {
    var e = mailer ? '(' + shelfCostExpr_(ctx, q_(p.sku), false) + ')' : cogsTotalExpr_(ctx, q_(p.sku), false);
    return (p.count === 1 ? '' : p.count + '*') + e;
  };
  var own = mailer ? shelfCostExpr_(ctx, skuCell, true) : cogsTotalExpr_(ctx, skuCell, true);
  var sum = parts.map(partCost).join('+');
  return '=IFERROR(' + own + plusMailer + ',IFERROR(' + sum + plusMailer + ',' + NC + '))';
}

/** Rule 11.2: description typed on the COGS tab (SKU matched as text, then as a number; blank → "(no description)"). */
function cogsDescLookup_(ctx, skuCell) {
  var val = colRef_(ctx.tabs.cogs, ctx.cogs.desc), key = colRef_(ctx.tabs.cogs, ctx.cogs.key);
  var nonBlank = function (x) { return 'IF(' + x + '&""="",0/0,' + x + '&"")'; };
  return '=IFERROR(' + nonBlank('INDEX(' + val + ',MATCH(' + skuCell + ',' + key + ',0))') +
    ',IFERROR(' + nonBlank('INDEX(' + val + ',MATCH(' + skuCell + '*1,' + key + ',0))') + ',' + q_(CONFIG.NO_DESCRIPTION_TEXT) + '))';
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
    blankIf(inner(shelfCostFormula_(ctx, S))), // Rule 8.1b: on-hand cost (no mailer added when shipped)
    blankIf('IF(H' + r + '=0,0,IFERROR(H' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))'),
    blankIf('IF(I' + r + '=0,0,IFERROR(I' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))'),
    blankIf('IFERROR(M' + r + '-L' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')')
  ];
}

// Rule 9.1: the totals box sits to the right of the table (one empty column between).
var VARIANCE_BOX = { labelCol: VARIANCE_HEADER.length + 2, row: VARIANCE_HEADER_ROW };

function varianceModel_(ctx, blocks) {
  var values = [
    ['Variance Overview — ' + ctx.month.label],
    ['Expected Ending = Beginning + Receiving − Sold / Used. Delta = Actual − Expected. Every number is a formula; see README and RULES.md section 9.'],
    [],
    VARIANCE_HEADER.slice()
  ];
  blocks.forEach(function (b) {
    if (b.kind !== 'MFG' && !b.skus.length) return;
    if (b.kind === 'MFG') {
      b.firstRow = values.length + 1;
      for (var k = 0; k < b.rows; k++) values.push(mfgVarianceRow_(ctx, b, values.length + 1, k + 2));
      return;
    }
    b.skus.forEach(function (sku) {
      var r = values.length + 1;
      var f = varianceSourceFormulas_(b.kind, ctx, r);
      values.push([b.label, sku, descLookup_(ctx, '$B' + r), b.categorization,
        f.begin, f.recv, f.sold,
        '=E' + r + '+F' + r + '-G' + r,
        f.actual,
        '=I' + r + '-H' + r,
        shelfCostFormula_(ctx, '$B' + r), // Rule 8.1b: on-hand cost (no mailer added when shipped)
        '=IF(H' + r + '=0,0,IFERROR(H' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))',
        '=IF(I' + r + '=0,0,IFERROR(I' + r + '*K' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))',
        '=IFERROR(M' + r + '-L' + r + ',' + q_(CONFIG.NO_COST_TEXT) + ')']);
    });
  });
  // Totals box (Rule 9.1): whole-column SUM, so it never depends on row positions (Rule 14.4).
  var box = VARIANCE_BOX, hdr = values[box.row - 1];
  while (hdr.length < box.labelCol - 1) hdr.push('');
  hdr.push('Total Variance ($)', '=SUM(N:N)');
  var nf = numFmts_(4, 9, '#,##0.####;-#,##0.####;0');
  nf[10] = '$#,##0.00'; nf[11] = '$#,##0.00'; nf[12] = '$#,##0.00'; nf[13] = '$#,##0.00';
  var mfgBlock = blocks.filter(function (b) { return b.kind === 'MFG'; })[0];
  var m = model_(ctx.tabs.variance, values, {
    textCols: [1], textFromRow: VARIANCE_HEADER_ROW + 1,
    textToRow: mfgBlock ? mfgBlock.firstRow - 1 : null, // MFG rows are formulas (a text-formatted cell would show the formula as text)
    numberFormats: nf, numberFromRow: VARIANCE_HEADER_ROW + 1,
    headerRows: [VARIANCE_HEADER_ROW], tableWidth: VARIANCE_HEADER.length, titleRows: [1],
    boxes: [{ row: box.row, col: box.labelCol, rows: 1, format: '$#,##0.00;-$#,##0.00;$0.00' }],
    frozenRows: VARIANCE_HEADER_ROW, tabColor: TAB_COLORS.summary
  });
  m.totalCell = colLetter_(box.labelCol + 1) + box.row;
  return m;
}

// ---------------------------------------------------------------------------
// Rule 10: Inventory Valuation
// ---------------------------------------------------------------------------

var VALUATION_HEADER = ['Location', 'SKU', 'Description', 'Categorization', 'Available Inventory', 'Base Cost',
  'Freight In', 'Tariff', 'Less: Mailer (added when shipped)', 'Total / Unit', 'Total Inventory Value'];
// Rule 10.1: Total Inventory Value is the last column (the totals box and Checks 12.7 sum it).
var VALUATION_VALUE_COL = colLetter_(VALUATION_HEADER.length);

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
  var values = [
    ['Inventory Valuation — ' + ctx.month.label],
    ['Available Inventory = Actual Ending Inventory on Variance Overview. Total / Unit = COGS Base Cost + Freight In + Tariff − the mailer a pouch only gets when it ships (Rule 8.1b). Total Inventory Value = Available × Total / Unit. See RULES.md section 10.'],
    [],
    VALUATION_HEADER.slice()
  ];
  var headerRow = values.length;
  var mfgFirst = null;
  blocks.forEach(function (b) {
    if (b.kind !== 'MFG' && !b.skus.length) return;
    if (b.kind === 'MFG') {
      mfgFirst = values.length + 1;
      // Rule 10.1: row k mirrors MFG row k on Variance Overview.
      for (var k = 0; k < b.rows; k++) {
        var r = values.length + 1, vr = b.firstRow + k, V = q2_(t.variance) + '!', S = '$B' + r;
        var bi = function (expr) { return '=IF(' + S + '="","",' + expr + ')'; };
        var inner = function (f) { return f.slice(1); };
        values.push(['=IF(' + V + 'B' + vr + '="","",' + V + 'A' + vr + ')', '=IF(' + V + 'B' + vr + '="","",' + V + 'B' + vr + ')',
          bi(inner(descLookup_(ctx, S))), bi(q_(b.categorization)), bi(V + 'I' + vr),
          bi(inner(costLookup_(ctx, 'cogs', S))), bi(inner(costLookup_(ctx, 'freight', S))), bi(inner(costLookup_(ctx, 'tariffs', S))),
          bi(inner(mailerDeductionFormula_(ctx, S))), bi(inner(shelfCostFormula_(ctx, S))),
          bi('IF(E' + r + '=0,0,IFERROR(E' + r + '*J' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))')]);
      }
      return;
    }
    b.skus.forEach(function (sku) {
      var r = values.length + 1;
      values.push([b.label, sku, descLookup_(ctx, '$B' + r), b.categorization,
        '=SUMIFS(' + colRef_(t.variance, 'I') + ',' + colRef_(t.variance, 'A') + ',$A' + r + ',' + colRef_(t.variance, 'B') + ',$B' + r + ')',
        costLookup_(ctx, 'cogs', '$B' + r), costLookup_(ctx, 'freight', '$B' + r), costLookup_(ctx, 'tariffs', '$B' + r),
        mailerDeductionFormula_(ctx, '$B' + r), shelfCostFormula_(ctx, '$B' + r), // Rule 8.1b
        '=IF(E' + r + '=0,0,IFERROR(E' + r + '*J' + r + ',' + q_(CONFIG.NO_COST_TEXT) + '))']);
    });
  });
  // Rule 10.2: totals box to the right of the table — one line per categorization, then the total.
  var labelCol = VALUATION_HEADER.length + 2, L = colLetter_(labelCol), Vc = colLetter_(labelCol + 1);
  cats.concat(['TOTAL INVENTORY VALUE']).forEach(function (label, i) {
    var r = headerRow + i;
    while (values.length < r) values.push([]);
    var row = values[r - 1];
    while (row.length < labelCol - 1) row.push('');
    row.push(label, i < cats.length ? '=SUMIFS(' + VALUATION_VALUE_COL + ':' + VALUATION_VALUE_COL + ',D:D,' + L + r + ')' : '=SUM(' + Vc + headerRow + ':' + Vc + (r - 1) + ')');
  });
  var totalRow = headerRow + cats.length;
  var nf = { 4: '#,##0.####', 5: '$#,##0.00', 6: '$#,##0.00', 7: '$#,##0.00', 8: '$#,##0.00', 9: '$#,##0.00', 10: '$#,##0.00' };
  var m = model_(t.valuation, values, {
    textCols: [1], textFromRow: headerRow + 1, textToRow: mfgFirst ? mfgFirst - 1 : null,
    numberFormats: nf, numberFromRow: headerRow + 1,
    headerRows: [headerRow], tableWidth: VALUATION_HEADER.length, titleRows: [1],
    boxes: [{ row: headerRow, col: labelCol, rows: cats.length + 1, totalRow: totalRow, format: '$#,##0.00;-$#,##0.00;$0.00' }],
    frozenRows: headerRow, tabColor: TAB_COLORS.summary
  });
  m.totalCell = Vc + totalRow;
  return m;
}

// ---------------------------------------------------------------------------
// Rule 11: Outbound Summary
// ---------------------------------------------------------------------------

function outboundModel_(ctx, skus) {
  var t = ctx.tabs, c = ctx.cols;
  var channels = CONFIG.OUTBOUND_CHANNELS;
  var groups = channels.concat([CONFIG.AMAZON_CHANNEL_LABEL, 'All Channels']);
  var row3 = ['', '', ''], row4 = ['SKU', 'Description', 'Avg Cost / Unit'];
  groups.forEach(function (g) { row3.push(g, ''); row4.push('Units', 'Total Cost'); });
  var values = [
    ['Outbound Summary — ' + ctx.month.label],
    ['Units by channel; one row per SKU sold (Shopify bundles kept whole). Description comes from the COGS tab. Channel names in row 3 drive the formulas. Each channel = Shopify orders + Ops Hub ' + CONFIG.OPS_HUB.manualLog.sheetName + ' rows with that Channel (Samples comes only from the log). Amazon = ledger Customer Shipments; ' + CONFIG.OPS_HUB.amzLog.sheetName + ' units are not sales. Avg Cost of a pouch or pouch bundle = cost as shipped on Shopify, incl. one mailer (Rule 8.1b); ' + CONFIG.OPS_HUB.manualLog.sheetName + ' and Amazon units of it are costed without the mailer.'],
    row3, row4
  ];
  var first = values.length + 1;
  var NC = q_(CONFIG.NO_COST_TEXT);
  skus.forEach(function (sku) {
    var r = values.length + 1;
    var row = [sku, cogsDescLookup_(ctx, '$A' + r), outboundCostFormula_(ctx, sku, '$A' + r)];
    // Rule 8.1b: Avg Cost of a mailer SKU includes one mailer — charged on Shopify units only. manualorder_log
    // units (samples, marketing, replacements) and Amazon units ship without one, so it is taken back off them.
    var mailer = usesMailer_(sku), m = mailer ? mailerCostExpr_(ctx) : '';
    var unitCols = [];
    channels.forEach(function (ch, j) {
      var u = colLetter_(4 + 2 * j);
      var logUnits = 'SUMIFS(' + colRef_(t.manualLog, 'D') + ',' + colRef_(t.manualLog, 'C') + ',$A' + r + ',' + colRef_(t.manualLog, 'B') + ',' + u + '$3)';
      var f = '=SUMIFS(' + colRef_(t.shopify, c.shop.qty) + ',' + colRef_(t.shopify, c.shop.sku) + ',$A' + r + ',' +
        colRef_(t.shopify, c.shop.channel) + ',' + u + '$3)' + '+' + logUnits;
      row.push(f, '=IF(' + u + r + '=0,0,IFERROR(' + u + r + '*$C' + r + (mailer ? '-' + logUnits + '*' + m : '') + ',' + NC + '))');
      unitCols.push(u);
    });
    var au = colLetter_(4 + 2 * channels.length);
    row.push('=0-SUMIFS(' + colRef_(t.ledger, c.ledger.shipments) + ',' + colRef_(t.ledger, c.ledger.mapped) + ',$A' + r + ')',
      '=IF(' + au + r + '=0,0,IFERROR(' + au + r + '*' + (mailer ? '($C' + r + '-' + m + ')' : '$C' + r) + ',' + NC + '))');
    unitCols.push(au);
    var costCols = unitCols.map(function (u) { return colLetter_(columnNumber_(u) + 1); });
    row.push('=' + unitCols.map(function (u) { return u + r; }).join('+'),
      '=IFERROR(' + costCols.map(function (x) { return x + r; }).join('+') + ',' + q_(CONFIG.NO_COST_TEXT) + ')');
    values.push(row);
  });
  var last = values.length;
  var total = ['TOTAL', '', ''];
  for (var k = 4; k <= 3 + 2 * groups.length; k++) {
    var L = colLetter_(k);
    total.push(last >= first ? '=SUM(' + L + first + ':' + L + last + ')' : 0);
  }
  values.push(total);
  var nf = { 2: '$#,##0.00' };
  for (var g = 0; g < groups.length; g++) { nf[3 + 2 * g] = '#,##0'; nf[4 + 2 * g] = '$#,##0.00'; }
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

  var noCost = 'COUNTIF(' + colRef_(t.variance, 'K') + ',' + NC + ')+COUNTIF(' + colRef_(t.outbound, 'C') + ',' + NC + ')';
  add('12.1', 'SKUs with no COGS cost', flagIf_('(' + noCost + ')', 'cells show "' + CONFIG.NO_COST_TEXT + '" — add these SKUs to the COGS tab'),
    (info.cogsCreated ? 'COGS was created this run with every SKU and blank costs — type Base Cost, Freight In and Tariff; the NO COST cells clear as you type (no rerun). ' : '') +
    (info.noCostSkus.length ? 'Not on COGS (add a row): ' + info.noCostSkus.join(', ') : 'Every SKU has a COGS row.'));
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
  var ivTotal = q2_(t.valuation) + '!' + ctx.valuationTotalCell;
  add('12.7', 'Inventory Valuation total = sum of every row',
    '=IF(ABS(' + ivTotal + '-SUM(' + colRef_(t.valuation, VALUATION_VALUE_COL) + '))<0.01,"OK","FLAG: totals do not tie — a row has a Categorization the totals box does not list")', '');
  add('12.7a', 'Inventory Valuation total = Variance Overview Total Actual Cost',
    '=IF(ABS(' + ivTotal + '-SUM(' + colRef_(t.variance, 'M') + '))<0.01,"OK","FLAG: the two totals differ — a row was added, copied, deleted or typed over on one of the two tabs")',
    'Both tabs list the same rows at the same on-hand cost, so they must agree. A difference means one was changed by hand (e.g. a row copied twice) — compare the two tabs row by row.');
  add('12.8', 'Work orders parsed completely', 'OK',
    info.workOrders.lines + ' kit lines (' + info.workOrders.fees + ' fee lines skipped); line amounts $' + info.workOrders.lineTotal.toFixed(2) +
    ' = report TOTAL $' + info.workOrders.reportTotal.toFixed(2) + '; billing month ' + info.workOrders.month + '.');
  var unres = info.woUnresolved || [], corr = info.woCorrected || [];
  var unresKits = unres.reduce(function (a, l) { return a + (Number(l.pieces) || 0); }, 0);
  add('5.5a', 'Work-order lines with no usable SKU (kits NOT counted)',
    unres.length ? 'FLAG: ' + unres.length + ' line(s) / ' + unresKits + ' kits not counted' : 'OK',
    unres.length ? unres.map(woLineText_).join('; ') + '. Type our SKU next to each on the "' + t.woFixes + '" tab, then run buildEOM again (it is remembered for later months).' : '');
  add('5.5a', 'Work-order SKUs not taken from Job (confirm)', corr.length ? 'CHECK: ' + corr.length + ' line(s)' : 'OK',
    corr.length ? corr.map(woLineText_).join('; ') + '. Change any wrong one on the "' + t.woFixes + '" tab and run again.' : 'Every kit line had its SKU in the Job column.');
  add('8.2', 'Kits built that have no BOM rows', info.kitsWithoutBom.length ? 'FLAG: ' + info.kitsWithoutBom.length : 'OK',
    info.kitsWithoutBom.length ? 'Components not deducted for: ' + info.kitsWithoutBom.join(', ') + ' — add them to the Ops Hub BOM.' : '');
  add('6.1', 'BOM duplicate rows removed', info.bomDuplicates.length ? 'INFO' : 'OK', info.bomDuplicates.join('; '));
  var ml = info.mailer, mrs = CONFIG.MAILER_RULE;
  add('12.7b', 'Mailer: out of on-hand cost, into Outbound cost',
    ml.noLine.length ? 'CHECK: ' + ml.noLine.length + ' SKU(s) with no mailer line on the BOM'
      : '="INFO: "&SUMIFS(' + colRef_(t.bundleMap, 'E') + ',' + colRef_(t.bundleMap, 'B') + ',' + q_(mrs.sku) + ')&" mailers on Shopify orders, costed on Outbound Summary"',
    (ml.lines.length ? 'Taken out of on-hand cost (BOM lines marked "' + mrs.bomFlag + '" in column F): ' + ml.lines.join('; ') + '. '
      : 'No BOM line marks the mailer as added when shipped, so nothing is taken out of on-hand cost. ') +
    'Outbound Avg Cost of these SKUs and of pouch bundles = on-hand cost + one mailer; charged on Shopify units only (' +
    CONFIG.OPS_HUB.manualLog.sheetName + ' and Amazon units get none).' +
    (ml.noLine.length ? ' No mailer line on the BOM for: ' + ml.noLine.join(', ') + ' — their COGS cost is taken as having no mailer in it and one is added on Outbound. ' +
      'If their COGS cost already includes a mailer, add the mailer line in the Ops Hub BOM.' : ''));
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
    [t.variance, 'Beginning + Receiving − Sold/Used = Expected; compared with Actual. One table: ADS rows, Amazon rows, then MFG (row by row from MFG Counts). Total Variance ($) to the right.', '9'],
    [t.valuation, 'Actual ending units × on-hand cost (COGS cost less the mailer a pouch only gets when it ships). Totals by categorization and TOTAL INVENTORY VALUE to the right.', '10, 8.1b'],
    [t.outbound, 'Units and cost by channel for every SKU sold. A pouch sold on Shopify is costed as shipped: on-hand cost + one mailer.', '11, 8.1b'],
    [t.mfgInv, 'YOU TYPE: EOM Qty (and Received Qty if any) per MFG + SKU. Starts with last month\'s MFG + SKU rows; add new ones at the bottom, reorder freely. Never overwritten.', '7.1'],
    [t.adsReceipts, 'YOU TYPE: PO Number, SKU, Qty received at ADS. Never overwritten.', '7.2'],
    [t.woFixes, 'YOU TYPE (when Checks asks): our SKU for work-order lines whose Job is blank or not a SKU. Kept month to month.', '5.5a'],
    [t.mfgStart, 'Last month\'s MFG EOM quantities (from last month\'s MFG Counts; first run: the hand-built workbook).', '4.3'],
    [t.prepaid, 'YOU TYPE: prepaid POs. Feeds nothing.', '7.3'],
    [t.cogs, 'YOU TYPE: Base Cost, Freight In, Tariff per SKU (created blank each month; Total / Unit is a sum). Never overwritten.', '6.2'],
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
    [t.bom, 'Bill of materials copied from Ops Hub on build day. Column F marks the mailer lines that are only added when a pouch ships.', '6.1, 8.1b'],
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
 *   skuMapExisting : [[msku, asin, sku, note]]
 *   mfgInv : [[mfg, sku, eom, recv]] | null (null = MFG Counts tab not created yet), mfgStart : [[mfg, sku, eom]], mfgStartFromPrev : bool
 *   adsReceipts : [[po, sku, qty]]
 *   prepaid : {header, rows} | null
 *   cogs : {header, rows} of this month's COGS tab, or null (then a blank one is created — Rule 6.2)
 *   copyFrom : {prepaid}   (where to copy Prepaid from if it doesn't exist yet)
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
  var manualLogM = opsLogModel_(tabs.manualLog, inputs.manualLog, 'manual');
  var amzLogM = opsLogModel_(tabs.amzLog, inputs.amzLog, 'amz');
  var bom = bomFromSource_(inputs.bomValues);
  var bomM = bomModel_(tabs.bom, bom, inputs.todayStr);
  // Rule 5.5a: give every kit line a SKU (or flag it) before anything counts kits.
  var wo = resolveWorkOrderSkus_(inputs.workOrders.lines, bom.rows, inputs.woFixesExisting || [], inputs.todayStr);
  var woParsed = {}; for (var wk in inputs.workOrders) woParsed[wk] = inputs.workOrders[wk];
  woParsed.lines = wo.lines;
  var woM = workOrdersModel_(tabs.workOrders, woParsed);

  // --- column letters the summaries use
  // Rule 6.2: COGS = this month's tab as you typed it; if there is none, a blank one is created below.
  var cogsTable = inputs.cogs || { header: CONFIG.COGS_HEADER.slice(), rows: [] };
  var cogsH = cogsTable.header;
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
  if (shopSkus.some(usesMailer_)) bundleComponents.push(CONFIG.MAILER_RULE.sku); // Rule 8.1a
  var kitParents = uniqueSorted_(wo.lines.filter(function (l) { return Number(l.pieces) > 0 && l.sku !== ''; }).map(function (l) { return l.sku; }));
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
  var cogsFilled = {};
  var totalIdx = headerIndex_(cogsH, CONFIG.COGS_COLUMNS.total);
  cogsTable.rows.forEach(function (r) {
    cogsKeys[cleanSku_(r[cogsKeyIdx])] = true;
    if (typeof r[totalIdx] === 'number') cogsFilled[cleanSku_(r[cogsKeyIdx])] = true;
  });
  var costedSkus = uniqueSorted_([].concat(adsSkus, amzSkus, outboundSkus, blocks.slice(2).reduce(function (a, b) { return a.concat(b.skus); }, [])));
  // Rule 8.1b: BOM lines whose mailer is only added when the item ships; mailer SKUs with a COGS row but no such line.
  var mailerLines = bom.rows.filter(function (r) { return mailerAddedWhenShipped_(r[0], r[2]); });
  var hasMailerLine = {};
  mailerLines.forEach(function (r) { hasMailerLine[r[0]] = true; });
  var info = {
    mailer: {
      lines: mailerLines.map(function (r) { return r[0] + ' → ' + r[4] + ' × ' + r[2]; }),
      noLine: costedSkus.filter(function (s) { return usesMailer_(s) && cogsFilled[s] && !hasMailerLine[s]; }) // own cost typed, no BOM mailer line
    },
    // Rule 11.2a: a bundle not on COGS is costed from its parts (bundles only appear on Outbound Summary), so it is only listed when a part is missing too.
    noCostSkus: costedSkus.filter(function (s) {
      if (cogsKeys[s]) return false;
      if (s.indexOf(',') < 0) return true;
      return splitBundle_(s).some(function (p) { return !cogsKeys[p.sku]; });
    }),
    cogsCreated: !inputs.cogs,
    noDescSkus: allSkus.filter(function (s) { return !descs.desc[s]; }),
    unmappedAsins: uniqueSorted_(unmappedAsins),
    mapAdded: map.added,
    amzTie: amzTie,
    mapConflicts: skuMapConflicts_(map.rows),
    kitsWithoutBom: kitM.kitsWithoutBom,
    woCorrected: wo.corrected, woUnresolved: wo.unresolved,
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
  var cogsM = inputs.cogs
    ? model_(tabs.cogs, [cogsTable.header].concat(cogsTable.rows), { preserveIfExists: true, tabColor: TAB_COLORS.manual })
    : blankCogsModel_(tabs.cogs, costedSkus, descs);
  var prepaidM = inputs.prepaid
    ? model_(tabs.prepaid, [inputs.prepaid.header].concat(inputs.prepaid.rows), { preserveIfExists: true, tabColor: TAB_COLORS.manual,
      copyFrom: inputs.copyFrom ? inputs.copyFrom.prepaid : null })
    : manualTabModel_(tabs.prepaid, H.PREPAID, [], [4, 5, 6, 7]);

  var sheets = [
    readmeModel_(ctx), checksM, varianceM, valuationM, outboundM,
    mfgInvM, adsRecM, woFixesModel_(tabs.woFixes, wo.fixRows), mfgStartM, prepaidM, cogsM, skuMapModel_(tabs.skuMap, map.rows),
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

// ---------------------------------------------------------------------------
// Rule 15: writeOpsHub — the finished month copied into Ops Hub 2.0
// (inventory_eom, sell_thru monthly, wo_log, sku_matrix). Everything here is
// pure: Main.gs reads the tabs, these functions decide exactly what to write.
// ---------------------------------------------------------------------------

/** "Oct 2026" for a month-end date number (messages only). */
function serialMonthLabel_(serial) {
  var d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  return MONTH_NAMES[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear();
}

function blankCell_(v) { return v === '' || v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }

/** Index of the first of the first `maxRows` rows that has every header in `names` (or -1). */
function findHeaderRow_(values, names, maxRows) {
  for (var i = 0; i < Math.min(values.length, maxRows || 10); i++) {
    var row = values[i] || [];
    if (names.every(function (n) { return headerIndex_(row, n) >= 0; })) return i;
  }
  return -1;
}

/** Stops with every problem listed (at most 15 shown). */
function throwIfProblems_(problems, intro, outro) {
  if (!problems.length) return;
  var shown = problems.slice(0, 15).join('; ') + (problems.length > 15 ? '; and ' + (problems.length - 15) + ' more' : '');
  throw new Error(intro + ' ' + shown + '.' + (outro ? ' ' + outro : ''));
}

/**
 * Rule 15.2: the month's ending inventory from the workbook's Variance Overview (calculated values):
 * [{group: Location, sku, qty: Actual Ending Inventory}] for every row with a SKU (ADS, Amazon, each MFG).
 */
function eomInventoryFromVariance_(values, tabName) {
  var H = ['Location', 'SKU', 'Actual Ending Inventory'];
  var hr = findHeaderRow_(values, H);
  if (hr < 0) throw new Error('The "' + tabName + '" tab has no header row with ' + H.join(', ') + '. Run buildEOM for this month first.');
  var h = values[hr], li = headerIndex_(h, H[0]), si = headerIndex_(h, H[1]), ai = headerIndex_(h, H[2]);
  var out = [], problems = [];
  for (var i = hr + 1; i < values.length; i++) {
    var r = values[i], sku = cleanSku_(r[si]);
    if (!sku) continue;
    var loc = textCell_(r[li]).trim();
    if (!loc) { problems.push('row ' + (i + 1) + ' (SKU ' + sku + ') has no Location'); continue; }
    if (typeof r[ai] !== 'number') { problems.push('row ' + (i + 1) + ' (' + loc + ' ' + sku + ') shows "' + textCell_(r[ai]) + '"'); continue; }
    out.push({ group: loc, sku: sku, qty: r[ai] });
  }
  throwIfProblems_(problems, 'Nothing was written to Ops Hub: Actual Ending Inventory on "' + tabName + '" is not a number in', 'Fix the workbook, then run writeOpsHub again.');
  if (!out.length) throw new Error('The "' + tabName + '" tab has no rows. Run buildEOM for this month first.');
  return out;
}

/**
 * Rule 15.3: units sold per channel from the workbook's Outbound Summary (calculated values):
 * [{group: Channel, sku, qty: Units}] — every SKU row × every channel (All Channels left out). Channel names
 * come from the row above the "Units" headers, so the tab's column order doesn't matter.
 */
function soldByChannelFromOutbound_(values, tabName) {
  var hr = findHeaderRow_(values, ['SKU', 'Units']);
  if (hr < 1) throw new Error('The "' + tabName + '" tab has no "SKU … Units" header row. Run buildEOM for this month first.');
  var h = values[hr], above = values[hr - 1], si = headerIndex_(h, 'SKU');
  var cols = [];
  h.forEach(function (x, j) {
    if (normHeader_(x) !== 'units') return;
    var ch = textCell_(above[j]).trim();
    if (ch && ch.toLowerCase() !== 'all channels') cols.push({ j: j, channel: ch });
  });
  var expected = CONFIG.OUTBOUND_CHANNELS.concat([CONFIG.AMAZON_CHANNEL_LABEL]);
  var missing = expected.filter(function (c) { return !cols.some(function (x) { return x.channel.toLowerCase() === c.toLowerCase(); }); });
  if (missing.length) throw new Error('The "' + tabName + '" tab has no Units column for: ' + missing.join(', ') + '. Run buildEOM for this month again.');
  var out = [], problems = [];
  for (var i = hr + 1; i < values.length; i++) {
    var r = values[i], sku = cleanSku_(r[si]);
    if (!sku || sku.toUpperCase() === 'TOTAL') continue;
    cols.forEach(function (c) {
      var u = r[c.j];
      if (typeof u !== 'number') { problems.push('row ' + (i + 1) + ' (' + sku + ', ' + c.channel + ') shows "' + textCell_(u) + '"'); return; }
      out.push({ group: c.channel, sku: sku, qty: u });
    });
  }
  throwIfProblems_(problems, 'Nothing was written to Ops Hub: Units on "' + tabName + '" is not a number in', 'Fix the workbook, then run writeOpsHub again.');
  return out;
}

/**
 * Rule 15.4: the month's kit lines from the workbook's Work Orders tab (calculated values):
 * [{serial, qty: Pieces, sku, cost: Rate, wo}] for every line with Pieces ≠ 0. A line with no SKU (rule 5.5a),
 * no Rate, or dated outside the month stops the run — wo_log would get a wrong or blank row.
 */
function kitLinesFromWorkOrders_(values, m, tabName) {
  var H = ['Work Order', 'Date', 'SKU', 'Pieces', 'Rate'];
  if (!values.length || findHeaderRow_(values, H, 1) !== 0) throw new Error('The "' + tabName + '" tab has no header row with ' + H.join(', ') + '. Run buildEOM for this month first.');
  var h = values[0], ix = {};
  H.forEach(function (n) { ix[n] = headerIndex_(h, n); });
  var out = [], noSku = [], problems = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (H.every(function (n) { return blankCell_(r[ix[n]]); })) continue;
    var wo = textCell_(r[ix['Work Order']]).trim(), where = wo + ' (row ' + (i + 1) + ')';
    var qty = r[ix.Pieces];
    if (typeof qty !== 'number') { problems.push(where + ': Pieces "' + textCell_(qty) + '" is not a number'); continue; }
    if (qty === 0) continue;
    var sku = cleanSku_(r[ix.SKU]);
    if (!sku) { noSku.push(where + ', ' + qty + ' kits'); continue; }
    var serial;
    try { serial = parseMDY_(r[ix.Date], ''); } catch (e) { problems.push(where + ': Date "' + textCell_(r[ix.Date]) + '" is not a date'); continue; }
    if (serial < m.firstSerial || serial > m.endSerial) { problems.push(where + ': dated ' + serialToMDY_(serial) + ', outside ' + m.label); continue; }
    if (typeof r[ix.Rate] !== 'number') { problems.push(where + ': Rate "' + textCell_(r[ix.Rate]) + '" is not a number'); continue; }
    out.push({ serial: serial, qty: qty, sku: sku, cost: r[ix.Rate], wo: wo });
  }
  throwIfProblems_(noSku, 'Nothing was written to Ops Hub: these work-order lines on "' + tabName + '" have no SKU:',
    'Type the SKU on the WO SKU Fixes tab, run buildEOM again, then run writeOpsHub.');
  throwIfProblems_(problems, 'Nothing was written to Ops Hub: problems on "' + tabName + '":', 'Fix the work-order report, run buildEOM again, then run writeOpsHub.');
  return out;
}

/** Rule 15.5: SKU → description from the workbook's SKU List tab ("(no description)" counts as none). */
function skuDescsFromList_(values) {
  var out = {};
  var hr = findHeaderRow_(values, ['SKU', 'Description'], 3);
  if (hr < 0) return out;
  var si = headerIndex_(values[hr], 'SKU'), di = headerIndex_(values[hr], 'Description');
  for (var i = hr + 1; i < values.length; i++) {
    var sku = cleanSku_(values[i][si]), d = textCell_(values[i][di]).trim();
    if (sku && d && d !== CONFIG.NO_DESCRIPTION_TEXT) out[sku] = d;
  }
  return out;
}

/**
 * Rules 15.2 / 15.3: what to write on a "one row per group + SKU, one column per month" tab
 * (inventory_eom: group = Location; sell_thru monthly: group = Channel).
 *   values : the whole tab as calculated values, dates as date numbers. Row cfg.headerRow holds the headers;
 *            month columns are the header cells holding a date (the month-end date).
 *   data   : [{group, sku, qty}] — repeated group + SKU pairs are added together.
 * The month's column is the one headed with this month's end date. If there is none, it is added right after
 * the last month column, which must be LAST month (months stay in order, never a gap). Every existing row gets
 * a number in that column (0 when the month had none). A group + SKU not on the tab is added at the bottom —
 * only when its number isn't 0. Group matching ignores capitals; SKUs match as text ("10030" = 10030).
 * Returns {col, isNew, copyFromCol, headerSerial, firstRow, colValues (rows firstRow…), newRows:[{row, group, sku,
 * code, desc}], templateRow, codeCol, descCol, groupCol, skuCol, updated, added, rowsNeeded, colsNeeded}.
 */
function planMonthColumn_(values, cfg, m, data, descs) {
  var label = 'Ops Hub tab "' + cfg.sheetName + '"';
  var hIdx = cfg.headerRow - 1;
  var header = values[hIdx];
  if (!header) throw new Error(label + ' has no header row (row ' + cfg.headerRow + ').');
  var gi = requireHeader_(header, cfg.group, label + ' (row ' + cfg.headerRow + ')');
  var si = requireHeader_(header, cfg.sku, label + ' (row ' + cfg.headerRow + ')');
  var ci = cfg.code ? headerIndex_(header, cfg.code) : -1;
  var di = cfg.desc ? headerIndex_(header, cfg.desc) : -1;
  var width = 0;
  values.forEach(function (r) { if (r.length > width) width = r.length; });

  // Month columns: header cells after the key columns that hold a date number.
  var firstMonth = Math.max(gi, si, ci, di) + 1;
  var months = [];
  for (var j = firstMonth; j < header.length; j++) if (typeof header[j] === 'number' && header[j] > 20000) months.push({ j: j, serial: header[j] });
  if (!months.length) throw new Error(label + ': no month columns found in row ' + cfg.headerRow + ' (dates like Sep 2026).');
  var same = months.filter(function (x) { return x.serial === m.endSerial; });
  if (same.length > 1) throw new Error(label + ' has ' + same.length + ' columns for ' + m.shortLabel + ' in row ' + cfg.headerRow + '. Keep only one.');
  var col, isNew, last = months[months.length - 1];
  if (same.length) {
    col = same[0].j; isNew = false;
  } else {
    if (last.serial !== m.prevEndSerial) {
      throw new Error(label + ' has no ' + m.shortLabel + ' column, and its last month column is ' + serialMonthLabel_(last.serial) +
        ', not ' + serialMonthLabel_(m.prevEndSerial) + '. Months are added in order with no gaps: write ' + serialMonthLabel_(m.prevEndSerial) +
        ' first (or add its column by hand), then run again.');
    }
    col = last.j + 1; isNew = true;
    var used = [];
    values.forEach(function (r, i) { if (!blankCell_(r[col])) used.push('row ' + (i + 1)); });
    if (used.length) {
      throw new Error(label + ': the column after ' + serialMonthLabel_(last.serial) + ' (column ' + colLetter_(col + 1) + ') is where ' + m.shortLabel +
        ' goes, but it is not empty (' + used.slice(0, 5).join(', ') + '). Clear it or move what is there, then run again.');
    }
  }

  // Existing rows, keyed by group + SKU.
  var key = function (g, s) { return String(g).trim().toLowerCase() + '|' + s; };
  var rowOf = {}, dupes = [], lastData = hIdx;
  for (var i = hIdx + 1; i < values.length; i++) {
    var g = textCell_(values[i][gi]).trim(), s = cleanSku_(values[i][si]);
    if (!g && !s) continue;
    if (!g || !s) throw new Error(label + ', row ' + (i + 1) + ' has a ' + (g ? cfg.group + ' but no ' + cfg.sku : cfg.sku + ' but no ' + cfg.group) + '. Fill it in or clear the row, then run again.');
    var k = key(g, s);
    if (rowOf[k] !== undefined) dupes.push(g + ' ' + s + ' (rows ' + (rowOf[k] + 1) + ' and ' + (i + 1) + ')');
    else rowOf[k] = i;
    lastData = i;
  }
  if (dupes.length) throw new Error(label + ' has the same ' + cfg.group + ' + ' + cfg.sku + ' twice: ' + dupes.join('; ') + '. Merge them into one row, then run again.');

  // This month's numbers by group + SKU (in data order).
  var totals = {}, order = [];
  data.forEach(function (d) {
    var k = key(d.group, d.sku);
    if (totals[k] === undefined) { totals[k] = 0; order.push(d); }
    totals[k] += d.qty;
  });
  var round = function (x) { return Math.round(x * 1e6) / 1e6; };

  var newRows = [];
  order.forEach(function (d) {
    var k = key(d.group, d.sku);
    if (rowOf[k] !== undefined || round(totals[k]) === 0) return;
    newRows.push({ row: lastData + 2 + newRows.length, group: d.group, sku: d.sku, code: d.group + d.sku,
      desc: (descs && descs[d.sku]) || '', qty: round(totals[k]) });
  });
  var firstRow = cfg.headerRow + 1;
  var lastRow = Math.max(lastData + 1, firstRow - 1) + newRows.length;
  var colValues = [], updated = 0;
  for (var r = firstRow; r <= lastRow; r++) {
    var idx = r - 1;
    if (idx <= lastData) {
      var gg = textCell_((values[idx] || [])[gi]).trim(), ss = cleanSku_((values[idx] || [])[si]);
      if (!gg && !ss) { colValues.push([isNew ? '' : ((values[idx] || [])[col] === undefined ? '' : values[idx][col])]); continue; }
      var kk = key(gg, ss);
      colValues.push([totals[kk] === undefined ? 0 : round(totals[kk])]);
      updated++;
    } else {
      colValues.push([newRows[r - lastData - 2].qty]);
    }
  }
  return {
    col: col + 1, isNew: isNew, copyFromCol: isNew ? last.j + 1 : null, headerSerial: m.endSerial,
    firstRow: firstRow, lastRow: lastRow, lastDataRowBefore: lastData + 1, colValues: colValues, newRows: newRows,
    templateRow: lastData >= hIdx + 1 ? lastData + 1 : null,
    groupCol: gi + 1, skuCol: si + 1, codeCol: ci >= 0 ? ci + 1 : null, descCol: di >= 0 ? di + 1 : null,
    updated: updated, added: newRows.length, rowsNeeded: lastRow, colsNeeded: col + 1, width: width
  };
}

/** Rule 15.4: row comparison key for wo_log (numbers rounded so 0.38 = 0.3800000001). */
function woLogRowKey_(cells) {
  return cells.map(function (v) {
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    return v === null || v === undefined ? '' : String(v).trim();
  }).join('|');
}

/**
 * Rule 15.4: how wo_log must change so its rows dated in month m are exactly the month's kit lines.
 * `values` = the whole tab (row 1 = headers), dates as date numbers. Rows dated in the month are replaced;
 * every other row is kept, in order. The month's rows go where its old rows were (else before the first
 * later-dated row, else at the end), oldest first. Only Date / Quantity / SKU / Cost are written.
 * Returns {cols (1-based), changed, firstRow, rows ([date, qty, sku, cost] from firstRow; blank rows clear what
 * moved up), removed, added, monthFirstRow, monthLastRow}.
 */
function planWoLog_(values, kits, m) {
  var W = CONFIG.OPS_HUB_WRITE.woLog, H = W.headers;
  var tab = 'Ops Hub tab "' + W.sheetName + '"';
  if (!values.length) throw new Error(tab + ' is empty — it needs the headers ' + [H.date, H.qty, H.sku, H.cost].join(', ') + ' in row 1.');
  var keys = ['date', 'qty', 'sku', 'cost'];
  var cols = {};
  keys.forEach(function (k) { cols[k] = requireHeader_(values[0], H[k], tab + ' (row 1)'); }); // first match: the rate table to the right also has "SKU"
  var cell = function (r, k) { return r[cols[k]]; };

  var last = 0;
  for (var i = 1; i < values.length; i++) if (keys.some(function (k) { return !blankCell_(cell(values[i], k)); })) last = i;
  var existing = [];
  for (i = 1; i <= last; i++) {
    var r = values[i];
    var empty = keys.every(function (k) { return blankCell_(cell(r, k)); });
    var serial = '';
    if (!blankCell_(cell(r, 'date'))) {
      try { serial = parseMDY_(cell(r, 'date'), ''); } catch (e) {
        throw new Error(tab + ', row ' + (i + 1) + ': ' + H.date + ' "' + textCell_(cell(r, 'date')) + '" is not a date. Fix it, then run again.');
      }
    } else if (!empty) {
      throw new Error(tab + ', row ' + (i + 1) + ' has a ' + H.qty + '/' + H.sku + '/' + H.cost + ' but no ' + H.date + '. Fill in the date or clear the row, then run again.');
    }
    existing.push({ row: i + 1, serial: serial,
      cells: [serial, blankCell_(cell(r, 'qty')) ? '' : cell(r, 'qty'), cleanSku_(cell(r, 'sku')), blankCell_(cell(r, 'cost')) ? '' : cell(r, 'cost')] });
  }

  var fresh = kits.map(function (l, n) { return { serial: l.serial, n: n, cells: [l.serial, l.qty, l.sku, l.cost] }; })
    .sort(function (a, b) { return a.serial - b.serial || a.n - b.n; });
  var inMonth = function (e) { return e.serial !== '' && e.serial >= m.firstSerial && e.serial <= m.endSerial; };
  var old = existing.filter(inMonth);
  var kept = existing.filter(function (e) { return !inMonth(e); });
  var at;
  if (old.length) {
    at = kept.filter(function (e) { return e.row < old[0].row; }).length;
  } else {
    at = kept.length;
    for (i = 0; i < kept.length; i++) if (kept[i].serial !== '' && kept[i].serial > m.endSerial) { at = i; break; }
  }
  var cellsOf = function (e) { return e.cells; };
  var target = kept.slice(0, at).map(cellsOf).concat(fresh.map(cellsOf), kept.slice(at).map(cellsOf));
  var before = existing.map(cellsOf);
  var size = Math.max(target.length, before.length);
  var blank = ['', '', '', ''];
  var first = -1;
  for (i = 0; i < size; i++) if (woLogRowKey_(target[i] || blank) !== woLogRowKey_(before[i] || blank)) { first = i; break; }
  var rows = [];
  if (first >= 0) for (i = first; i < size; i++) rows.push(target[i] || blank.slice());
  var colsOut = {};
  keys.forEach(function (k) { colsOut[k] = cols[k] + 1; });
  return {
    cols: colsOut, changed: first >= 0, firstRow: first >= 0 ? first + 2 : null, rows: rows,
    removed: old.length, added: fresh.length, monthFirstRow: at + 2, monthLastRow: at + 1 + fresh.length
  };
}

/**
 * Rule 15.5: SKUs written anywhere this run that sku_matrix doesn't list yet. Returns {startRow, rows:[[sku, desc, status]],
 * cols {sku, desc, status} (1-based)}; rows go right after the last row with a SKU.
 */
function planSkuMatrix_(values, skus, descs) {
  var S = CONFIG.OPS_HUB_WRITE.skuMatrix, H = S.headers;
  var tab = 'Ops Hub tab "' + S.sheetName + '"';
  if (!values.length) throw new Error(tab + ' is empty — it needs the headers ' + [H.sku, H.desc, H.status].join(', ') + ' in row 1.');
  var cols = {};
  ['sku', 'desc', 'status'].forEach(function (k) { cols[k] = requireHeader_(values[0], H[k], tab + ' (row 1)'); });
  var have = {}, last = 0;
  for (var i = 1; i < values.length; i++) {
    var s = cleanSku_(values[i][cols.sku]);
    if (s) { have[s] = true; last = i; }
  }
  var add = [];
  skus.forEach(function (s) { if (s && !have[s]) { have[s] = true; add.push([s, (descs && descs[s]) || '', S.newStatus]); } });
  return { startRow: last + 2, rows: add, cols: { sku: cols.sku + 1, desc: cols.desc + 1, status: cols.status + 1 } };
}

/**
 * Rule 15: every write planned from the workbook's tabs and the Ops Hub tabs (all as calculated values,
 * dates as date numbers). Stops before anything is written if any input is wrong.
 */
function planOpsHubWrite_(wbValues, hubValues, m) {
  var t = tabNames_(m), W = CONFIG.OPS_HUB_WRITE;
  var inventory = eomInventoryFromVariance_(wbValues.variance, t.variance);
  var sold = soldByChannelFromOutbound_(wbValues.outbound, t.outbound);
  var kits = kitLinesFromWorkOrders_(wbValues.workOrders, m, t.workOrders);
  var descs = skuDescsFromList_(wbValues.skuList || []);
  // Rule 15.5: every SKU that lands on an Ops Hub tab with a number other than 0, or in a kit line.
  var nonZero = function (d) { return Math.round(d.qty * 1e6) !== 0; };
  var skus = uniqueSorted_([].concat(inventory.filter(nonZero).map(function (d) { return d.sku; }), sold.filter(nonZero).map(function (d) { return d.sku; }),
    kits.map(function (k) { return k.sku; })));
  return {
    month: m,
    skuMatrix: planSkuMatrix_(hubValues.skuMatrix, skus, descs),
    woLog: planWoLog_(hubValues.woLog, kits, m),
    inventoryEom: planMonthColumn_(hubValues.inventoryEom, W.inventoryEom, m, inventory, descs),
    sellThru: planMonthColumn_(hubValues.sellThru, W.sellThru, m, sold, descs)
  };
}

/** Rule 15: plain-English lines saying what writeOpsHub did (run log). */
function opsHubSummary_(plan) {
  var m = plan.month, W = CONFIG.OPS_HUB_WRITE, out = [];
  [['inventoryEom', 'rows'], ['sellThru', 'rows']].forEach(function (p) {
    var x = plan[p[0]];
    out.push(W[p[0]].sheetName + ': ' + m.shortLabel + ' column ' + colLetter_(x.col) + (x.isNew ? ' added' : ' replaced') + ' — ' +
      x.updated + ' existing rows filled' + (x.added ? ', ' + x.added + ' new rows added at the bottom (' +
      x.newRows.map(function (r) { return r.group + ' ' + r.sku; }).join(', ') + ')' : '') + '.');
  });
  var wo = plan.woLog;
  out.push(W.woLog.sheetName + ': ' + (wo.added ? 'rows ' + wo.monthFirstRow + '–' + wo.monthLastRow + ' hold the ' + wo.added + ' ' + m.label + ' kit lines' : 'no ' + m.label + ' kit lines') +
    (wo.changed ? ' (replaced ' + wo.removed + ' ' + m.label + ' row' + (wo.removed === 1 ? '' : 's') + ' that were there).' : ' — already up to date.'));
  var sk = plan.skuMatrix;
  out.push(W.skuMatrix.sheetName + ': ' + (sk.rows.length ? sk.rows.length + ' new SKU(s) added with Status ' + W.skuMatrix.newStatus + ': ' +
    sk.rows.map(function (r) { return r[0]; }).join(', ') + '.' : 'no new SKUs.'));
  return out;
}
