// An in-memory stand-in for the Google Apps Script services the EOM script uses (DriveApp,
// SpreadsheetApp, Utilities, Session, MimeType). It imitates the behaviour that matters for
// correctness: text-formatted cells keep text; other cells turn number-looking text into
// numbers (as Google Sheets does); getValues returns calculated values, not formulas.
'use strict';
const { Workbook } = require('./formulaEngine');

let nextId = 1;
const newId = (p) => p + (nextId++);
let clock = 1000;
const tick = () => new Date(++clock * 1000);

function looksNumeric(s) { return /^-?[\d,]*\d(\.\d+)?$/.test(s) && !/^0\d/.test(s); }

class MockFile {
  constructor(drive, name, mime, content, parent) {
    Object.assign(this, { drive, name, mime, content, parent, id: newId('file'), trashed: false, updated: tick() });
    drive.files.set(this.id, this);
  }
  getId() { return this.id; }
  getName() { return this.name; }
  setName(n) { this.name = n; this.updated = tick(); return this; }
  getMimeType() { return this.mime; }
  isTrashed() { return this.trashed; }
  getLastUpdated() { return this.updated; }
  getBlob() { const c = this.content; return { getDataAsString: () => c }; }
  makeCopy(name, folder) { return new MockFile(this.drive, name, this.mime, this.content, folder); }
  moveTo(folder) { this.parent = folder; return this; }
  touch() { this.updated = tick(); }
}

class MockFolder {
  constructor(drive, name, parent) { Object.assign(this, { drive, name, parent, id: newId('folder') }); drive.folders.set(this.id, this); }
  getId() { return this.id; }
  getName() { return this.name; }
  getFoldersByName(n) { return iter([...this.drive.folders.values()].filter((f) => f.parent === this && f.name === n)); }
  getFilesByName(n) { return iter([...this.drive.files.values()].filter((f) => f.parent === this && f.name === n)); }
  getFiles() { return iter([...this.drive.files.values()].filter((f) => f.parent === this)); }
  createFolder(n) { return new MockFolder(this.drive, n, this); }
  createFile(name, content, mime) { return new MockFile(this.drive, name, mime || 'text/csv', content, this); }
}
function iter(list) { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; }

class MockRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  setNumberFormat(f) { this.each((r, c) => { this.sheet.formats[r + ',' + c] = f; }); return this; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) throw new Error('setValues: size mismatch');
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.setCell(this.r + i, this.c + j, v)));
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.computed(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j); }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setBackground() { return this; }
  setWrap() { return this; }
  setBorder() { return this; }
}

class MockSheet {
  constructor(ss, name) { Object.assign(this, { ss, name, cells: [], formats: {}, maxRows: 1000, maxCols: 26 }); }
  getName() { return this.name; }
  setName(n) { this.name = n; this.ss.dirty = true; return this; }
  setCell(r, c, v) {
    if (r > this.maxRows || c > this.maxCols) throw new Error('Write outside the sheet (' + r + ',' + c + ') on ' + this.name);
    if (typeof v === 'string' && !v.startsWith('=') && this.formats[r + ',' + c] !== '@' && looksNumeric(v)) v = Number(v.replace(/,/g, ''));
    if (typeof v === 'string' && v.startsWith('=') && this.formats[r + ',' + c] === '@') throw new Error('Formula written into a text cell at ' + this.name + ' ' + r + ',' + c);
    while (this.cells.length < r) this.cells.push([]);
    this.cells[r - 1][c - 1] = v;
    this.ss.dirty = true;
  }
  raw(r, c) { const row = this.cells[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ''; }
  computed(r, c) {
    const v = this.raw(r, c);
    if (typeof v === 'string' && v.startsWith('=')) {
      const val = this.ss.engine().value(this.name, r, c);
      return val && typeof val === 'object' && 'error' in val ? '#' + val.error : val;
    }
    return v;
  }
  lastRow() { let n = 0; this.cells.forEach((row, i) => { if (row && row.some((x) => x !== '' && x !== undefined)) n = i + 1; }); return n; }
  lastCol() { let n = 0; this.cells.forEach((row) => { if (row) row.forEach((x, j) => { if (x !== '' && x !== undefined && j + 1 > n) n = j + 1; }); }); return n; }
  getDataRange() { return new MockRange(this, 1, 1, Math.max(this.lastRow(), 1), Math.max(this.lastCol(), 1)); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(a);
      const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      const r1 = m[2] ? Number(m[2]) : 1, r2 = m[4] ? Number(m[4]) : this.maxRows;
      return new MockRange(this, r1, col(m[1]), r2 - r1 + 1, col(m[3]) - col(m[1]) + 1);
    }
    return new MockRange(this, a, b, c || 1, d || 1);
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  setFrozenRows() {}
  setTabColor() {}
  setConditionalFormatRules() {}
  setColumnWidth() {}
  autoResizeColumns() {}
  copyTo(ss) {
    const s = ss.insertSheet('Copy of ' + this.name);
    s.cells = this.cells.map((r) => (r ? r.slice() : []));
    s.formats = Object.assign({}, this.formats);
    s.maxRows = this.maxRows; s.maxCols = this.maxCols;
    return s;
  }
  /** Raw values (formulas as text) — for the test to calculate with its own engine. */
  rawValues() { return this.cells.map((r) => (r ? Array.from(r, (x) => (x === undefined ? '' : x)) : [])); }
}

class MockSpreadsheet {
  constructor(drive, name, folder) {
    this.file = new MockFile(drive, name, 'application/vnd.google-apps.spreadsheet', null, folder);
    this.file.ss = this;
    this.sheets = [new MockSheet(this, 'Sheet1')];
    this.dirty = true;
  }
  getId() { return this.file.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.file.id; }
  getName() { return this.file.name; }
  getSheets() { return this.sheets.slice(); }
  getSpreadsheetTimeZone() { return 'America/New_York'; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) {
    if (this.sheets.some((s) => s.name.toLowerCase() === n.toLowerCase())) throw new Error('Sheet already exists: ' + n);
    const s = new MockSheet(this, n); this.sheets.push(s); this.dirty = true; this.file.touch(); return s;
  }
  deleteSheet(s) {
    if (this.sheets.length === 1) throw new Error('Cannot delete the only sheet');
    this.sheets = this.sheets.filter((x) => x !== s); this.dirty = true; this.file.touch();
  }
  setActiveSheet(s) { this.active = s; return s; }
  moveActiveSheet(i) { this.sheets = this.sheets.filter((x) => x !== this.active); this.sheets.splice(i - 1, 0, this.active); }
  engine() {
    if (this.dirty || !this._engine) {
      const map = {};
      for (const s of this.sheets) map[s.name] = s.rawValues();
      this._engine = new Workbook(map);
      this.dirty = false;
    }
    return this._engine;
  }
}

function createGas(opts) {
  const drive = { files: new Map(), folders: new Map() };
  const root = new MockFolder(drive, 'My Drive', null);
  const ruleBuilder = () => { const b = { whenTextStartsWith: () => b, whenTextEqualTo: () => b, setBackground: () => b, setRanges: () => b, build: () => ({}) }; return b; };
  const sandbox = {
    console: { log: () => {} },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', MICROSOFT_EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    DriveApp: {
      getFolderById: (id) => { const f = drive.folders.get(id); if (!f) throw new Error('No folder ' + id); return f; },
      getFileById: (id) => { const f = drive.files.get(id); if (!f) throw new Error('No file ' + id); return f; }
    },
    SpreadsheetApp: {
      create: (name) => new MockSpreadsheet(drive, name, root),
      open: (file) => { if (!file.ss) throw new Error('Not a spreadsheet: ' + file.name); return file.ss; },
      openById: (id) => { const f = drive.files.get(id); if (!f || !f.ss) throw new Error('No spreadsheet ' + id); return f.ss; },
      flush: () => {},
      newConditionalFormatRule: ruleBuilder,
      BorderStyle: { SOLID: 'solid' }
    },
    Utilities: { formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM-dd' ? (opts && opts.today) || '2026-10-05' : ((opts && opts.today) || '2026-10-05') + ' 09:00') },
    Session: { getScriptTimeZone: () => 'America/New_York', getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) }
  };
  return {
    drive, root, sandbox,
    /** A Google Sheet with a given id (used for the Ops Hub BOM and the first-run workbook). */
    spreadsheetWithId: (id, name, folder, tabs) => {
      const ss = new MockSpreadsheet(drive, name, folder || root);
      drive.files.delete(ss.file.id); ss.file.id = id; drive.files.set(id, ss.file);
      ss.sheets = [];
      for (const [tab, rows] of Object.entries(tabs)) {
        const s = new MockSheet(ss, tab);
        s.maxRows = Math.max(1000, rows.length); s.maxCols = Math.max(26, ...rows.map((r) => r.length));
        s.cells = rows.map((r) => r.slice());
        ss.sheets.push(s);
      }
      return ss;
    },
    newSpreadsheet: (name, folder) => new MockSpreadsheet(drive, name, folder || root),
    MockSheet
  };
}

module.exports = { createGas };
