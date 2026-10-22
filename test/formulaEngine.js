// A small spreadsheet formula evaluator for tests. It understands only the functions the
// EOM builder is allowed to use (Rule 14.1), so a formula using anything else fails loudly.
'use strict';

class FormulaError extends Error {}
const ERR = (code) => ({ error: code });
const isErr = (v) => v && typeof v === 'object' && 'error' in v;

function colNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ---------------------------------------------------------------- tokenizer
function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (c === '"') {
      let s = ''; i++;
      while (true) {
        if (i >= src.length) throw new FormulaError('Unclosed string in ' + src);
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      t.push({ type: 'str', v: s }); continue;
    }
    if (c === "'") { // quoted sheet name
      let s = ''; i++;
      while (true) {
        if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      if (src[i] !== '!') throw new FormulaError('Expected ! after sheet name in ' + src);
      i++;
      t.push({ type: 'sheet', v: s }); continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { t.push({ type: 'op', v: two }); i += 2; continue; }
    if ('+-*/&=<>(),:'.includes(c)) { t.push({ type: 'op', v: c }); i++; continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num && !/^[0-9]+[A-Za-z$]/.test(src.slice(i)) ) { t.push({ type: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[$A-Za-z_][$A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (src[i + w.length] === '!') { t.push({ type: 'sheet', v: w }); i += w.length + 1; continue; }
      t.push({ type: 'word', v: w }); i += w.length; continue;
    }
    // row-only tokens like 2 in "B2:B3" are handled inside words; bare numbers handled above
    throw new FormulaError('Unexpected "' + c + '" in ' + src);
  }
  return t;
}

// ---------------------------------------------------------------- parser -> AST
function parse(src) {
  const toks = tokenize(src.replace(/^=/, ''));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().type === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new FormulaError('Expected ' + v + ' in ' + src); p++; };

  function comparison() {
    let left = concat();
    while (peek() && peek().type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = toks[p++].v; left = { k: 'bin', op, a: left, b: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) { p++; left = { k: 'bin', op: '&', a: left, b: additive() }; }
    return left;
  }
  function additive() {
    let left = mult();
    while (isOp('+') || isOp('-')) { const op = toks[p++].v; left = { k: 'bin', op, a: left, b: mult() }; }
    return left;
  }
  function mult() {
    let left = unary();
    while (isOp('*') || isOp('/')) { const op = toks[p++].v; left = { k: 'bin', op, a: left, b: unary() }; }
    return left;
  }
  function unary() {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return primary();
  }
  function ref(sheet) {
    const w = toks[p];
    if (!w || w.type !== 'word') throw new FormulaError('Expected a reference in ' + src);
    p++;
    const a = parseCellOrCol(w.v);
    if (isOp(':')) {
      p++;
      const w2 = toks[p++];
      const b = parseCellOrCol(w2.v);
      return { k: 'range', sheet, a, b };
    }
    if (a.row === null) throw new FormulaError('Bare column ' + w.v + ' in ' + src);
    return { k: 'cell', sheet, a };
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new FormulaError('Unexpected end of ' + src);
    if (tk.type === 'num') { p++; return { k: 'lit', v: tk.v }; }
    if (tk.type === 'str') { p++; return { k: 'lit', v: tk.v }; }
    if (tk.type === 'op' && tk.v === '(') { p++; const e = comparison(); expect(')'); return e; }
    if (tk.type === 'sheet') { p++; return ref(tk.v); }
    if (tk.type === 'word') {
      const up = tk.v.toUpperCase();
      if (toks[p + 1] && toks[p + 1].type === 'op' && toks[p + 1].v === '(') {
        p += 2;
        const args = [];
        if (!isOp(')')) { args.push(comparison()); while (isOp(',')) { p++; args.push(comparison()); } }
        expect(')');
        return { k: 'fn', name: up, args };
      }
      if (up === 'TRUE' || up === 'FALSE') { p++; return { k: 'lit', v: up === 'TRUE' }; }
      return ref(null);
    }
    throw new FormulaError('Unexpected token in ' + src);
  }
  const ast = comparison();
  if (p !== toks.length) throw new FormulaError('Trailing tokens in ' + src);
  return ast;
}

function parseCellOrCol(w) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)?$/.exec(w);
  if (!m) throw new FormulaError('Bad reference ' + w);
  return { col: colNum(m[1]), row: m[2] ? Number(m[2]) : null };
}

// ---------------------------------------------------------------- evaluation
class Workbook {
  constructor(sheets) { // {name: 2-D array}
    this.sheets = {};
    for (const [name, values] of Object.entries(sheets)) this.sheets[name.toLowerCase()] = { name, values };
    this.cache = new Map();
    this.asts = new Map();
  }
  sheet(name) {
    const s = this.sheets[String(name).toLowerCase()];
    if (!s) throw new FormulaError('Formula refers to a missing tab: ' + name);
    return s;
  }
  raw(sheetName, row, col) {
    const v = this.sheet(sheetName).values[row - 1];
    return v ? v[col - 1] : undefined;
  }
  value(sheetName, row, col) {
    const key = sheetName.toLowerCase() + '|' + row + '|' + col;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      if (v === IN_PROGRESS) throw new FormulaError('Circular reference at ' + key);
      return v;
    }
    const raw = this.raw(sheetName, row, col);
    if (typeof raw === 'string' && raw.startsWith('=')) {
      this.cache.set(key, IN_PROGRESS);
      let ast = this.asts.get(raw);
      if (!ast) { ast = parse(raw); this.asts.set(raw, ast); }
      const v = scalar(this.eval(ast, this.sheet(sheetName).name));
      this.cache.set(key, v);
      return v;
    }
    const v = raw === undefined || raw === null ? '' : raw;
    this.cache.set(key, v);
    return v;
  }
  rangeValues(r) {
    const s = this.sheet(r.sheet);
    const height = s.values.length;
    const r1 = r.a.row || 1, r2 = r.b.row || height;
    const out = [];
    for (let i = r1; i <= Math.min(r2, height); i++) {
      const row = [];
      for (let c = r.a.col; c <= r.b.col; c++) row.push(this.value(s.name, i, c));
      out.push(row);
    }
    return out;
  }
  eval(n, here) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'cell': return this.value(n.sheet || here, n.a.row, n.a.col);
      case 'range': return { range: { ...n, sheet: n.sheet || here }, wb: this };
      case 'neg': { const v = num(scalar(this.eval(n.a, here))); return isErr(v) ? v : -v; }
      case 'bin': return binop(n.op, scalar(this.eval(n.a, here)), scalar(this.eval(n.b, here)));
      case 'fn': return callFn(this, n, here);
    }
    throw new FormulaError('Unknown node');
  }
}
const IN_PROGRESS = Symbol('in progress');

function scalar(v) {
  if (v && v.range) throw new FormulaError('Range used where a single value is expected');
  return v;
}
function num(v) {
  if (isErr(v)) return v;
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return v.trim() !== '' && !isNaN(n) ? n : ERR('#VALUE!');
}
function binop(op, a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (op === '&') return String(a === '' ? '' : a) + String(b === '' ? '' : b);
  if (['+', '-', '*', '/'].includes(op)) {
    const x = num(a), y = num(b);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    if (op === '+') return x + y;
    if (op === '-') return x - y;
    if (op === '*') return x * y;
    return y === 0 ? ERR('#DIV/0!') : x / y;
  }
  const c = compare(a, b);
  return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
}
function compare(a, b) {
  if (a === '') a = typeof b === 'number' ? 0 : '';
  if (b === '') b = typeof a === 'number' ? 0 : '';
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** SUMIFS-style criterion matcher (equality, comparisons, wildcards, blank). */
function criterion(crit) {
  if (isErr(crit)) return () => false;
  if (typeof crit === 'number') return (v) => (typeof v === 'number' ? v === crit : String(v).trim() !== '' && Number(v) === crit);
  const s = String(crit);
  const m = /^(<>|>=|<=|=|<|>)(.*)$/.exec(s);
  if (m) {
    const op = m[1], rhs = m[2];
    const rn = rhs.trim() !== '' && !isNaN(Number(rhs)) ? Number(rhs) : null;
    return (v) => {
      if (op === '<>' && rhs === '') return v !== '' && v !== null && v !== undefined;
      if (op === '=' && rhs === '') return v === '' || v === null || v === undefined;
      if (rn !== null) {
        const vn = typeof v === 'number' ? v : (String(v).trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);
        if (vn === null) return op === '<>';
        return { '=': vn === rn, '<>': vn !== rn, '<': vn < rn, '>': vn > rn, '<=': vn <= rn, '>=': vn >= rn }[op];
      }
      const c = String(v).toLowerCase().localeCompare(rhs.toLowerCase());
      return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
    };
  }
  if (s === '') return (v) => v === '' || v === null || v === undefined;
  if (/[*?]/.test(s)) {
    const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (v) => typeof v === 'string' && re.test(v);
  }
  const sn = !isNaN(Number(s)) && s.trim() !== '' ? Number(s) : null;
  return (v) => {
    if (typeof v === 'number') return sn !== null && v === sn;
    return String(v).toLowerCase() === s.toLowerCase();
  };
}

function flat(wb, arg) {
  if (arg && arg.range) return wb.rangeValues(arg.range);
  return [[arg]];
}

function callFn(wb, n, here) {
  const A = (i) => wb.eval(n.args[i], here);
  const S = (i) => scalar(A(i));
  switch (n.name) {
    case 'SUM': {
      let t = 0;
      for (let i = 0; i < n.args.length; i++) {
        const v = A(i);
        if (v && v.range) { for (const row of wb.rangeValues(v.range)) for (const x of row) { if (isErr(x)) return x; if (typeof x === 'number') t += x; } }
        else { const x = num(v); if (isErr(x)) return x; t += x; }
      }
      return t;
    }
    case 'SUMIFS': case 'COUNTIFS': {
      const isSum = n.name === 'SUMIFS';
      const sumRange = isSum ? flat(wb, A(0)) : null;
      const pairs = [];
      for (let i = isSum ? 1 : 0; i < n.args.length; i += 2) pairs.push([flat(wb, A(i)), criterion(S(i + 1))]);
      const len = (sumRange || pairs[0][0]).length;
      let t = 0;
      for (let r = 0; r < len; r++) {
        if (pairs.every(([rng, f]) => f(rng[r] ? rng[r][0] : ''))) {
          if (isSum) { const x = sumRange[r][0]; if (isErr(x)) return x; if (typeof x === 'number') t += x; } else t++;
        }
      }
      return t;
    }
    case 'SUMIF': case 'COUNTIF': {
      const rng = flat(wb, A(0)); const f = criterion(S(1));
      const sumR = n.name === 'SUMIF' && n.args.length > 2 ? flat(wb, A(2)) : rng;
      let t = 0;
      for (let r = 0; r < rng.length; r++) if (f(rng[r][0])) {
        if (n.name === 'COUNTIF') t++; else { const x = sumR[r] ? sumR[r][0] : ''; if (typeof x === 'number') t += x; }
      }
      return t;
    }
    case 'COUNT': { let t = 0; for (const row of flat(wb, A(0))) for (const x of row) if (typeof x === 'number') t++; return t; }
    case 'COUNTA': { let t = 0; for (const row of flat(wb, A(0))) for (const x of row) if (x !== '' && x !== null && x !== undefined) t++; return t; }
    case 'MAX': {
      let best = -Infinity;
      for (let i = 0; i < n.args.length; i++) for (const row of flat(wb, A(i))) for (const x of row) { if (isErr(x)) return x; if (typeof x === 'number' && x > best) best = x; }
      return best === -Infinity ? 0 : best;
    }
    case 'MATCH': {
      const key = S(0); const rng = flat(wb, A(1)); const mode = n.args.length > 2 ? num(S(2)) : 1;
      if (mode !== 0) throw new FormulaError('Only exact MATCH(…,0) is allowed');
      if (isErr(key)) return key;
      for (let r = 0; r < rng.length; r++) {
        const v = rng[r][0];
        if (typeof key === 'number' ? v === key : (typeof v === 'string' && v.toLowerCase() === String(key).toLowerCase())) return r + 1;
      }
      return ERR('#N/A');
    }
    case 'INDEX': {
      const rng = flat(wb, A(0)); const i = num(S(1));
      if (isErr(i)) return i;
      return rng[i - 1] ? rng[i - 1][0] : ERR('#REF!');
    }
    case 'IFERROR': { const v = S(0); return isErr(v) ? S(1) : v; }
    case 'IF': { const c = S(0); if (isErr(c)) return c; return (typeof c === 'boolean' ? c : num(c) !== 0) ? S(1) : (n.args.length > 2 ? S(2) : false); }
    case 'ISNUMBER': { const v = S(0); return typeof v === 'number'; }
    case 'SEARCH': {
      const needle = String(S(0)).toLowerCase(), hay = String(S(1)).toLowerCase();
      const i = hay.indexOf(needle);
      return i < 0 ? ERR('#VALUE!') : i + 1;
    }
    case 'ABS': { const v = num(S(0)); return isErr(v) ? v : Math.abs(v); }
    case 'TRIM': return String(S(0)).trim().replace(/\s+/g, ' ');
  }
  throw new FormulaError('Function not allowed in the EOM workbook: ' + n.name);
}

/** Builds a Workbook from EOM sheet models. */
function workbookFromModels(models) {
  const sheets = {};
  for (const m of models) sheets[m.name] = m.values;
  return new Workbook(sheets);
}

module.exports = { Workbook, workbookFromModels, parse, isErr, FormulaError };

/** Evaluates every cell of a tab top-to-bottom (keeps long fill-down chains shallow). */
Workbook.prototype.evaluateAll = function (sheetName) {
  const s = this.sheet(sheetName);
  for (let r = 1; r <= s.values.length; r++) {
    const row = s.values[r - 1] || [];
    for (let c = 1; c <= row.length; c++) this.value(s.name, r, c);
  }
};
