// expr.js — SymPy-style expression strings: parser, LaTeX printer, numeric (complex) evaluator,
// Weierstrass functions.  No dependencies; runs in the browser and under node as an ES module.
//
//   parse(text)                -> AST
//   toLatex(textOrAst, opts)   -> LaTeX string (KaTeX)
//   freeSymbols(textOrAst)     -> sorted array of names
//   compile(textOrAst)         -> f(env) -> [re, im]
//   weierstrass(z, g2, g3)     -> {wp, wpp, zeta}   (complex arguments)
//   realPeriod(g2, g3), imagHalfPeriod(g2, g3)      (real invariants; realLattice gives both and the type)
//   cx                         -> complex helpers
//
// AST nodes: {t:'num',v}, {t:'sym',name}, {t:'add',args}, {t:'mul',args}, {t:'div',num,den},
//            {t:'pow',base,exp}, {t:'neg',arg}, {t:'call',fn,args}, {t:'rel',op,lhs,rhs}.

/* ------------------------------------------------------------------ tokenizer and parser */

const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_Ͱ-Ͽ][A-Za-z0-9_Ͱ-Ͽ]*/y;
const OPS2 = ['**', '==', '!=', '<=', '>='];
const OPS1 = '+-*/^(),<>=';
const RELOPS = new Set(['==', '!=', '<', '<=', '>', '>=', '=']);
const RELCALLS = {Eq: '==', Ne: '!=', Lt: '<', Le: '<=', Gt: '>', Ge: '>='};

function tokenize(text) {
  const toks = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ') { i++; continue; }
    NUM_RE.lastIndex = i;
    let m = NUM_RE.exec(text);
    if (m) { toks.push({k: 'num', v: m[0], at: i}); i += m[0].length; continue; }
    NAME_RE.lastIndex = i;
    m = NAME_RE.exec(text);
    if (m) { toks.push({k: 'name', v: m[0], at: i}); i += m[0].length; continue; }
    const two = text.substr(i, 2);
    if (OPS2.includes(two)) { toks.push({k: 'op', v: two, at: i}); i += 2; continue; }
    if (ch === '−') { toks.push({k: 'op', v: '-', at: i}); i++; continue; }      // typographic minus
    if (OPS1.includes(ch)) { toks.push({k: 'op', v: ch, at: i}); i++; continue; }
    throw new Error(`unexpected character "${ch}" at position ${i + 1}`);
  }
  return toks;
}

export function parse(text) {
  if (typeof text !== 'string') throw new Error('the expression must be a string');
  const toks = tokenize(text);
  if (!toks.length) throw new Error('empty expression');
  let pos = 0;
  const isOp = v => pos < toks.length && toks[pos].k === 'op' && toks[pos].v === v;
  const describe = t => (t ? `"${t.v}" at position ${t.at + 1}` : 'the end of the expression');
  const expect = v => {
    if (!isOp(v)) throw new Error(`expected "${v}" but found ${describe(toks[pos])}`);
    pos++;
  };
  let depth = 0;

  function parseRel() {
    const lhs = parseAdd();
    const t = toks[pos];
    if (t && t.k === 'op' && RELOPS.has(t.v)) {
      pos++;
      const rhs = parseAdd();
      return {t: 'rel', op: t.v === '=' ? '==' : t.v, lhs, rhs};
    }
    return lhs;
  }
  function parseAdd() {
    const args = [parseMul()];
    while (isOp('+') || isOp('-')) {
      const op = toks[pos++].v;
      const term = parseMul();
      args.push(op === '-' ? {t: 'neg', arg: term} : term);
    }
    return args.length === 1 ? args[0] : {t: 'add', args};
  }
  function parseMul() {
    let factors = [parseUnary()];
    while (isOp('*') || isOp('/')) {
      const op = toks[pos++].v;
      const rhs = parseUnary();
      if (op === '*') factors.push(rhs);
      else {
        const num = factors.length === 1 ? factors[0] : {t: 'mul', args: factors};
        factors = [{t: 'div', num, den: rhs}];
      }
    }
    return factors.length === 1 ? factors[0] : {t: 'mul', args: factors};
  }
  function parseUnary() {
    if (isOp('-')) { pos++; return {t: 'neg', arg: parseUnary()}; }
    if (isOp('+')) { pos++; return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (isOp('**') || isOp('^')) {
      pos++;
      const exp = parseUnary();          // right-associative; the exponent may carry a sign
      return {t: 'pow', base, exp};
    }
    return base;
  }
  function parseAtom() {
    const t = toks[pos];
    if (!t) throw new Error('unexpected end of the expression');
    if (++depth > 400) throw new Error('the expression is nested too deeply');
    try {
      pos++;
      if (t.k === 'num') return {t: 'num', v: t.v};
      if (t.k === 'name') {
        if (isOp('(')) {
          pos++;
          const args = [];
          if (!isOp(')')) {
            args.push(parseRel());
            while (isOp(',')) { pos++; args.push(parseRel()); }
          }
          expect(')');
          if (Object.prototype.hasOwnProperty.call(RELCALLS, t.v) && args.length === 2) {
            return {t: 'rel', op: RELCALLS[t.v], lhs: args[0], rhs: args[1]};
          }
          return {t: 'call', fn: t.v, args};
        }
        return {t: 'sym', name: t.v};
      }
      if (t.v === '(') {
        const e = parseRel();
        expect(')');
        return e;
      }
      throw new Error(`unexpected ${describe(t)}`);
    } finally { depth--; }
  }

  const ast = parseRel();
  if (pos < toks.length) throw new Error(`unexpected ${describe(toks[pos])}`);
  return ast;
}

const asAst = x => (typeof x === 'string' ? parse(x) : x);

/* ------------------------------------------------------------------ LaTeX */

const GREEK = {
  alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta', epsilon: '\\epsilon',
  varepsilon: '\\varepsilon', zeta: '\\zeta', eta: '\\eta', theta: '\\theta', vartheta: '\\vartheta',
  iota: '\\iota', kappa: '\\kappa', lambda: '\\lambda', lamda: '\\lambda', mu: '\\mu', nu: '\\nu',
  xi: '\\xi', omicron: 'o', rho: '\\rho', sigma: '\\sigma', tau: '\\tau', upsilon: '\\upsilon',
  phi: '\\phi', varphi: '\\varphi', chi: '\\chi', psi: '\\psi', omega: '\\omega',
  Alpha: 'A', Beta: 'B', Gamma: '\\Gamma', Delta: '\\Delta', Epsilon: 'E', Zeta: 'Z', Eta: 'H',
  Theta: '\\Theta', Iota: 'I', Kappa: 'K', Lambda: '\\Lambda', Mu: 'M', Nu: 'N', Xi: '\\Xi',
  Omicron: 'O', Pi: '\\Pi', Rho: 'P', Sigma: '\\Sigma', Tau: 'T', Upsilon: '\\Upsilon',
  Phi: '\\Phi', Chi: 'X', Psi: '\\Psi', Omega: '\\Omega',
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const CONST_TEX = {I: 'i', pi: '\\pi', E: 'e', oo: '\\infty', zoo: '\\tilde{\\infty}', nan: '\\mathrm{NaN}'};
const UPRIGHT = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan', cot: '\\cot', sec: '\\sec', csc: '\\csc',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', coth: '\\coth',
  sech: '\\operatorname{sech}', csch: '\\operatorname{csch}',
  log: '\\ln', ln: '\\ln',
  asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan', acot: '\\operatorname{arccot}',
  asinh: '\\operatorname{arsinh}', acosh: '\\operatorname{arcosh}', atanh: '\\operatorname{artanh}',
  re: '\\operatorname{Re}', im: '\\operatorname{Im}', arg: '\\arg', sign: '\\operatorname{sgn}',
  Min: '\\min', Max: '\\max', gamma: '\\Gamma',
  zeta_w: '\\zeta', sigma_w: '\\sigma', wp: '\\wp', wpp: "\\wp'",
};
const POWER_INSIDE = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch']);

function escapeTex(s) {
  return String(s).replace(/[\\{}$&#%_^~]/g, c => (c === '\\' ? '\\backslash ' : c === '^' ? '\\hat{}' : c === '~' ? '\\sim ' : '\\' + c));
}

function texName(name) {
  if (own(GREEK, name)) return GREEK[name];
  if (name[0] === '_') return '\\mathit{' + escapeTex(name) + '}';
  let head = name;
  let subs = [];
  const us = name.indexOf('_');
  if (us > 0) {
    head = name.slice(0, us);
    subs = name.slice(us + 1).split('_').filter(s => s.length);
  }
  const m = /^([A-Za-zͰ-Ͽ]+?)(\d+)$/.exec(head);
  if (m) { head = m[1]; subs.unshift(m[2]); }
  const h = own(GREEK, head) ? GREEK[head]
    : (head.length === 1 || /^[Ͱ-Ͽ]+$/.test(head)) ? head : '\\mathit{' + escapeTex(head) + '}';
  if (!subs.length) return h;
  const parts = subs.map(p => (own(GREEK, p) ? GREEK[p]
    : (/^\d+$/.test(p) || p.length === 1) ? p : '\\mathrm{' + escapeTex(p) + '}'));
  return h + '_{' + parts.join(',') + '}';
}

function texSym(name, o) {
  if (o.jets !== false) {
    const m = /^w(\d+)$/.exec(name);
    if (m) {
      const j = Number(m[1]);
      const letter = texName(typeof o.unknown === 'string' && o.unknown ? o.unknown : 'w');
      if (j === 0) return letter;
      if (j <= 3) return letter + "'".repeat(j);
      return letter + '^{(' + j + ')}';
    }
  }
  if (own(CONST_TEX, name)) return CONST_TEX[name];
  return texName(name);
}

function isJetWithPrime(n, o) {
  if (n.t !== 'sym' || o.jets === false) return false;
  const m = /^w(\d+)$/.exec(n.name);
  return !!m && Number(m[1]) >= 1;
}

function flattenMul(node, out = []) {
  for (const a of node.args) {
    if (a.t === 'mul') flattenMul(a, out); else out.push(a);
  }
  return out;
}

// [negative?, node without its sign]
function unsign(node) {
  if (node.t === 'neg') { const [s, n] = unsign(node.arg); return [!s, n]; }
  if (node.t === 'mul') {
    let neg = false;
    let args = [];
    for (const a of flattenMul(node)) {
      const [s, n] = unsign(a);
      if (s) neg = !neg;
      if (n.t === 'mul') args.push(...flattenMul(n)); else args.push(n);
    }
    if (args.length > 1) {
      const kept = args.filter(a => !(a.t === 'num' && a.v === '1'));
      args = kept.length ? kept : [args[0]];
    }
    return [neg, args.length === 1 ? args[0] : {t: 'mul', args}];
  }
  if (node.t === 'div') {
    const [s1, n1] = unsign(node.num);
    const [s2, n2] = unsign(node.den);
    return [s1 !== s2, {t: 'div', num: n1, den: n2}];
  }
  return [false, node];
}

const paren = s => '\\left(' + s + '\\right)';

function texNum(v) {
  const m = /^(.*?)[eE]([+-]?)(\d+)$/.exec(v);
  if (!m) return v;
  const e = (m[2] === '-' ? '-' : '') + String(Number(m[3]));
  return (m[1] === '1' ? '' : m[1] + '\\cdot ') + '10^{' + e + '}';
}

// node is free of a leading sign (callers use unsign first where it matters)
function tex(node, o) {
  switch (node.t) {
    case 'num': return texNum(node.v);
    case 'sym': return texSym(node.name, o);
    case 'neg': case 'mul': case 'div': {
      const [s, n] = unsign(node);
      if (n.t === 'neg') return '-' + texFactor(n.arg, o);          // cannot happen; kept for safety
      const body = n.t === 'mul' ? texMul(n, o) : n.t === 'div' ? texDiv(n, o)
        : (n.t === 'add' || n.t === 'rel') ? paren(tex(n, o)) : tex(n, o);
      return (s ? '-' : '') + body;
    }
    case 'add': return texAdd(node, o);
    case 'pow': return texPow(node, o);
    case 'call': return texCall(node, o);
    case 'rel': {
      const op = {'==': '=', '!=': '\\neq', '<=': '\\leq', '>=': '\\geq', '<': '<', '>': '>'}[node.op] || node.op;
      return tex(node.lhs, o) + ' ' + op + ' ' + tex(node.rhs, o);
    }
    default: return '\\text{?}';
  }
}

function texAdd(node, o) {
  let out = '';
  node.args.forEach((a, i) => {
    const [s, n] = unsign(a);
    let body = tex(n, o);
    if (n.t === 'rel' || (n.t === 'add' && s)) body = paren(body);
    if (i === 0) out += (s ? '-' : '') + body;
    else out += (s ? ' - ' : ' + ') + body;
  });
  return out;
}

// a factor inside a product
function texFactor(n, o) {
  if (n.t === 'add' || n.t === 'rel') return paren(tex(n, o));
  if (n.t === 'neg') return paren(tex(n, o));
  return tex(n, o);
}

function texMul(node, o) {
  const parts = flattenMul(node).map(a => texFactor(a, o));
  let out = parts[0] || '1';
  for (let i = 1; i < parts.length; i++) out += (/^[0-9.]/.test(parts[i]) ? '\\cdot ' : '\\,') + parts[i];
  return out;
}

const isSimple = n => n.t === 'num' || n.t === 'sym';

function texDiv(node, o) {
  if (o.inline && isSimple(node.num) && isSimple(node.den)) return tex(node.num, o) + '/' + tex(node.den, o);
  const inner = o.inline ? {...o, inline: false} : o;
  return '\\frac{' + tex(node.num, inner) + '}{' + tex(node.den, inner) + '}';
}

function texPow(node, o) {
  const b = node.base;
  const e = tex(node.exp, {...o, inline: true});
  if (b.t === 'call' && POWER_INSIDE.has(b.fn) && b.args.length === 1 && node.exp.t === 'num' && /^\d+$/.test(node.exp.v)) {
    return UPRIGHT[b.fn] + '^{' + e + '}' + paren(tex(b.args[0], o));
  }
  let base = tex(b, o);
  const compound = b.t === 'add' || b.t === 'mul' || b.t === 'div' || b.t === 'neg' || b.t === 'pow' || b.t === 'rel'
    || (b.t === 'num' && /[eE]/.test(b.v))
    || (b.t === 'call' && (b.fn === 'exp' || b.fn === 'sqrt' || b.fn === 'cbrt' || b.fn === 'root' || b.fn === 'factorial' || b.fn === 'conjugate'))
    || isJetWithPrime(b, o)
    || (b.t === 'sym' && o.jets !== false && /^w\d+$/.test(b.name) && Number(b.name.slice(1)) >= 4);
  if (compound) base = paren(base);
  return base + '^{' + e + '}';
}

function texArgs(args, o) { return args.map(a => tex(a, o)).join(', '); }

function texCall(node, o) {
  const fn = node.fn;
  const a = node.args;
  const plain = {...o, inline: false};
  if (fn === 'sqrt' && a.length === 1) return '\\sqrt{' + tex(a[0], plain) + '}';
  if (fn === 'cbrt' && a.length === 1) return '\\sqrt[3]{' + tex(a[0], plain) + '}';
  if (fn === 'root' && a.length === 2) return '\\sqrt[' + tex(a[1], plain) + ']{' + tex(a[0], plain) + '}';
  if (fn === 'exp' && a.length === 1) {
    const inner = tex(a[0], {...o, inline: true});
    return inner.length <= 40 ? 'e^{' + inner + '}' : '\\exp' + paren(tex(a[0], plain));
  }
  if (fn === 'Abs' && a.length === 1) return '\\left|' + tex(a[0], plain) + '\\right|';
  if (fn === 'conjugate' && a.length === 1) return '\\overline{' + tex(a[0], plain) + '}';
  if (fn === 'factorial' && a.length === 1) return (isSimple(a[0]) ? tex(a[0], plain) : paren(tex(a[0], plain))) + '!';
  if (fn === 'binomial' && a.length === 2) return '\\binom{' + tex(a[0], plain) + '}{' + tex(a[1], plain) + '}';
  if (fn === 'Rational' && a.length === 2) return '\\frac{' + tex(a[0], plain) + '}{' + tex(a[1], plain) + '}';
  if ((fn === 'Integer' || fn === 'Float') && a.length === 1) return tex(a[0], plain);
  if ((fn === 'wp' || fn === 'wpp' || fn === 'zeta_w' || fn === 'sigma_w') && a.length >= 1) {
    const rest = a.slice(1);
    return UPRIGHT[fn] + paren(tex(a[0], plain) + (rest.length ? '; ' + texArgs(rest, plain) : ''));
  }
  if (own(UPRIGHT, fn)) return UPRIGHT[fn] + paren(texArgs(a, plain));
  return '\\operatorname{' + escapeTex(fn) + '}' + paren(texArgs(a, plain));
}

export function toLatex(textOrAst, opts = {}) {
  const ast = asAst(textOrAst);                 // throws on unparsable input
  try {
    return tex(ast, opts || {});
  } catch (err) {
    const raw = typeof textOrAst === 'string' ? textOrAst : '';
    return '\\texttt{' + escapeTex(raw) + '}';
  }
}

/* ------------------------------------------------------------------ symbols */

const NOT_SYMBOLS = new Set(['I', 'pi', 'E', 'oo', 'zoo', 'nan']);

export function freeSymbols(textOrAst) {
  const out = new Set();
  (function walk(n) {
    if (!n) return;
    switch (n.t) {
      case 'sym': if (!NOT_SYMBOLS.has(n.name)) out.add(n.name); break;
      case 'add': case 'mul': case 'call': n.args.forEach(walk); break;
      case 'div': walk(n.num); walk(n.den); break;
      case 'pow': walk(n.base); walk(n.exp); break;
      case 'neg': walk(n.arg); break;
      case 'rel': walk(n.lhs); walk(n.rhs); break;
      default: break;
    }
  })(asAst(textOrAst));
  return Array.from(out).sort();
}

/* ------------------------------------------------------------------ complex numbers */

const C = v => (typeof v === 'number' ? [v, 0] : v);
const NANC = [NaN, NaN];
const INFC = [Infinity, 0];
const finite = z => Number.isFinite(z[0]) && Number.isFinite(z[1]);

function cadd(a, b) { a = C(a); b = C(b); return [a[0] + b[0], a[1] + b[1]]; }
function csub(a, b) { a = C(a); b = C(b); return [a[0] - b[0], a[1] - b[1]]; }
function cmul(a, b) {
  a = C(a); b = C(b);
  if (a[1] === 0 && b[1] === 0) return [a[0] * b[0], 0];
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cinv(b) {
  b = C(b);
  if (b[1] === 0) return b[0] === 0 ? INFC : [1 / b[0], 0];
  if (!finite(b)) return (Number.isNaN(b[0]) || Number.isNaN(b[1])) ? NANC : [0, 0];
  // Smith's method
  if (Math.abs(b[0]) >= Math.abs(b[1])) {
    const r = b[1] / b[0], d = b[0] + b[1] * r;
    return [1 / d, -r / d];
  }
  const r = b[0] / b[1], d = b[0] * r + b[1];
  return [r / d, -1 / d];
}
function cdiv(a, b) {
  a = C(a); b = C(b);
  if (b[0] === 0 && b[1] === 0) return (a[0] === 0 && a[1] === 0) || !finite(a) ? NANC : INFC;
  if (b[1] === 0) return [a[0] / b[0], a[1] / b[0]];
  if (!finite(b)) return (Number.isNaN(b[0]) || Number.isNaN(b[1]) || !finite(a)) ? NANC : [0, 0];
  if (Math.abs(b[0]) >= Math.abs(b[1])) {
    const r = b[1] / b[0], d = b[0] + b[1] * r;
    return [(a[0] + a[1] * r) / d, (a[1] - a[0] * r) / d];
  }
  const r = b[0] / b[1], d = b[0] * r + b[1];
  return [(a[0] * r + a[1]) / d, (a[1] * r - a[0]) / d];
}
function cabs(a) { a = C(a); return Math.hypot(a[0], a[1]); }
function cexp(a) {
  a = C(a);
  const e = Math.exp(a[0]);
  if (a[1] === 0) return [e, 0];
  if (e === 0) return [0, 0];
  return [e * Math.cos(a[1]), e * Math.sin(a[1])];
}
function clog(a) {
  a = C(a);
  return [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1] === 0 ? 0 : a[1], a[0])];   // -0 is treated as +0
}
function csqrt(a) {
  a = C(a);
  const [x, y] = a;
  if (y === 0) return x >= 0 ? [Math.sqrt(x), 0] : [0, Math.sqrt(-x)];
  const r = Math.hypot(x, y);
  const t = Math.sqrt((r + Math.abs(x)) / 2);
  if (x >= 0) return [t, y / (2 * t)];
  return [Math.abs(y) / (2 * t), y < 0 ? -t : t];
}
// integer power by repeated multiplication
function cipow(a, n) {
  a = C(a);
  if (n < 0) return cinv(cipow(a, -n));
  let r = [1, 0], b = a;
  while (n > 0) {
    if (n & 1) r = cmul(r, b);
    n = Math.floor(n / 2);
    if (n > 0) b = cmul(b, b);
  }
  return r;
}
function cpow(a, e) {
  a = C(a); e = C(e);
  if (e[1] === 0 && Number.isInteger(e[0]) && Math.abs(e[0]) <= 4096) return cipow(a, e[0]);
  if (a[0] === 0 && a[1] === 0) {
    if (e[0] > 0) return [0, 0];
    return e[0] === 0 && e[1] === 0 ? [1, 0] : INFC;
  }
  return cexp(cmul(e, clog(a)));
}
function csinh(a) {
  a = C(a);
  if (a[1] === 0) return [Math.sinh(a[0]), 0];
  return [Math.sinh(a[0]) * Math.cos(a[1]), Math.cosh(a[0]) * Math.sin(a[1])];
}
function ccosh(a) {
  a = C(a);
  if (a[1] === 0) return [Math.cosh(a[0]), 0];
  return [Math.cosh(a[0]) * Math.cos(a[1]), Math.sinh(a[0]) * Math.sin(a[1])];
}
function ctanh(a) {
  a = C(a);
  const [x, y] = a;
  if (y === 0) return [Math.tanh(x), 0];
  if (Math.abs(x) > 20) {
    const s = x > 0 ? 1 : -1;
    return [s, 4 * Math.sin(2 * y) * Math.exp(-2 * Math.abs(x))];
  }
  const d = Math.cosh(2 * x) + Math.cos(2 * y);
  if (d === 0) return INFC;
  return [Math.sinh(2 * x) / d, Math.sin(2 * y) / d];
}
const timesI = a => [-a[1], a[0]];
const timesMinusI = a => [a[1], -a[0]];
function csin(a) { a = C(a); if (a[1] === 0) return [Math.sin(a[0]), 0]; return timesMinusI(csinh(timesI(a))); }
function ccos(a) { a = C(a); if (a[1] === 0) return [Math.cos(a[0]), 0]; return ccosh(timesI(a)); }
function ctan(a) { a = C(a); if (a[1] === 0) return [Math.tan(a[0]), 0]; return timesMinusI(ctanh(timesI(a))); }

export const cx = {
  from: C, add: cadd, sub: csub, mul: cmul, div: cdiv, inv: cinv, neg: a => { a = C(a); return [-a[0], -a[1]]; },
  exp: cexp, log: clog, sqrt: csqrt, abs: cabs, pow: cpow, ipow: cipow,
  sin: csin, cos: ccos, tan: ctan, sinh: csinh, cosh: ccosh, tanh: ctanh,
  isFinite: a => finite(C(a)),
};

/* ------------------------------------------------------------------ Weierstrass functions */

// Laurent coefficients of wp for normalised invariants: wp(u) = u^-2 + sum_{k>=2} c_k u^(2k-2).
const WK = 26;          // last index k of the series
const WR = 1.2;         // the series is used for |u| < WR  (u = z * max(|g2|^(1/4), |g3|^(1/6)); the nearest
                        // nonzero lattice point then has |u| > 3)
const WT = 2;           // |wp| above this value (normalised): the point is close to a lattice point
const WHALVINGS = 64;
let wCache = null;

function wCoefficients(G2, G3) {
  if (wCache && wCache.key[0] === G2[0] && wCache.key[1] === G2[1] && wCache.key[2] === G3[0] && wCache.key[3] === G3[1]) return wCache.c;
  const c = new Array(WK + 1);
  c[2] = [G2[0] / 20, G2[1] / 20];
  c[3] = [G3[0] / 28, G3[1] / 28];
  for (let k = 4; k <= WK; k++) {
    let re = 0, im = 0;
    for (let m = 2; m <= k - 2; m++) {
      const a = c[m], b = c[k - m];
      re += a[0] * b[0] - a[1] * b[1];
      im += a[0] * b[1] + a[1] * b[0];
    }
    const f = 3 / ((2 * k + 1) * (k - 3));
    c[k] = [f * re, f * im];
  }
  wCache = {key: [G2[0], G2[1], G3[0], G3[1]], c};
  return c;
}

// wp, wp', zeta from the Laurent series at the origin (|u| < WR, normalised invariants)
function wSeries(c, u) {
  const ui = cinv(u), ui2 = cmul(ui, ui);
  const t = cmul(u, u);
  let pw = t;                                       // u^(2k-2), starting at k = 2
  let A0 = 0, A1 = 0, B0 = 0, B1 = 0, D0 = 0, D1 = 0;
  for (let k = 2; k <= WK; k++) {
    const term = cmul(c[k], pw);
    A0 += term[0]; A1 += term[1];
    B0 += (2 * k - 2) * term[0]; B1 += (2 * k - 2) * term[1];
    D0 += term[0] / (2 * k - 1); D1 += term[1] / (2 * k - 1);
    pw = cmul(pw, t);
  }
  const ui3 = cmul(ui2, ui);
  const Bu = cmul([B0, B1], ui);
  const Du = cmul([D0, D1], u);
  return {P: [ui2[0] + A0, ui2[1] + A1], Q: [-2 * ui3[0] + Bu[0], -2 * ui3[1] + Bu[1]], Z: [ui[0] - Du[0], ui[1] - Du[1]]};
}

// the small e with wp(e) = P, wp'(e) = Q (Newton iteration from e = -2P/Q), or null
function wLocal(c, P, Q) {
  let e = cdiv([-2 * P[0], -2 * P[1]], Q);
  const size = cabs(P);
  for (let it = 0; it < 10; it++) {
    const ae = cabs(e);
    if (!(ae > 0) || !(ae < 0.85 * WR)) return null;
    const s = wSeries(c, e);
    const dP = csub(s.P, P);
    if (cabs(dP) <= 1e-15 * size) {
      return cabs(csub(s.Q, Q)) <= 1e-6 * cabs(Q) ? e : null;
    }
    e = csub(e, cdiv(dP, s.Q));
  }
  return null;
}

const W_POLE = () => ({wp: [Infinity, 0], wpp: [Infinity, 0], zeta: [Infinity, 0]});
const W_NAN = () => ({wp: [NaN, NaN], wpp: [NaN, NaN], zeta: [NaN, NaN]});

/**
 * Weierstrass functions with invariants g2, g3 (wpp^2 = 4 wp^3 - g2 wp - g3) at a complex point.
 * Method: scale the invariants to size <= 1, halve the argument into the disc of fast convergence of
 * the Laurent series at the origin, then apply the duplication formulas
 *     L = wp''/wp' = (6 wp^2 - g2/2)/wp',   wp(2u) = L^2/4 - 2 wp(u),
 *     wp'(2u) = -(wp'(u) + L (wp(2u) - wp(u))),   zeta(2u) = 2 zeta(u) + L/2.
 * A pair (wp, wp') of large numbers does not determine g3 in floating point, so whenever a doubled point
 * comes close to a lattice point the computation continues with the distance to that lattice point and
 * the Laurent series.  At a lattice point the three values are returned as [Infinity, 0].
 */
export function weierstrass(z, g2, g3) {
  z = C(z); g2 = C(g2); g3 = C(g3);
  const az = Math.hypot(z[0], z[1]);
  if (Number.isNaN(az) || !finite(g2) || !finite(g3) || az === Infinity) return W_NAN();
  if (az === 0) return W_POLE();
  const s = Math.max(Math.pow(Math.hypot(g2[0], g2[1]), 0.25), Math.pow(Math.hypot(g3[0], g3[1]), 1 / 6));
  if (!(s > 0)) {                                   // g2 = g3 = 0
    const zi = cinv(z), zi2 = cmul(zi, zi), zi3 = cmul(zi2, zi);
    return {wp: zi2, wpp: [-2 * zi3[0], -2 * zi3[1]], zeta: zi};
  }
  const s2 = s * s;                                 // divisions one after another: no overflow of s^4, s^6
  const G2 = [g2[0] / s2 / s2, g2[1] / s2 / s2], G3 = [g3[0] / s2 / s2 / s2, g3[1] / s2 / s2 / s2];
  let eps = [z[0] * s, z[1] * s];                   // distance to the nearest tracked lattice point
  let au = az * s;
  let n = 0;
  while (au >= WR && n < WHALVINGS) { eps = [eps[0] / 2, eps[1] / 2]; au /= 2; n++; }
  if (au >= WR) return W_NAN();                     // too far from the origin for double precision
  const c = wCoefficients(G2, G3);
  const halfG2 = [G2[0] / 2, G2[1] / 2];
  let local = true;                                 // true: the point is (lattice point) + eps
  let zoff = [0, 0];                                // zeta(point) = zeta_series(eps) + zoff
  let P = null, Q = null, Z = null;
  for (let j = 0; j < n; j++) {
    if (local) {
      const e2 = [2 * eps[0], 2 * eps[1]];
      if (Math.hypot(e2[0], e2[1]) < WR) { eps = e2; zoff = [2 * zoff[0], 2 * zoff[1]]; continue; }
      const r = wSeries(c, eps);
      P = r.P; Q = r.Q; Z = [r.Z[0] + zoff[0], r.Z[1] + zoff[1]];
      local = false;
    }
    if (!finite(P) || !finite(Q) || (Q[0] === 0 && Q[1] === 0)) return W_POLE();
    const P2 = cmul(P, P);
    const L = cdiv([6 * P2[0] - halfG2[0], 6 * P2[1] - halfG2[1]], Q);
    const L2 = cmul(L, L);
    const Pn = [L2[0] / 4 - 2 * P[0], L2[1] / 4 - 2 * P[1]];
    const step = cmul(L, csub(Pn, P));
    Q = [-(Q[0] + step[0]), -(Q[1] + step[1])];
    Z = [2 * Z[0] + L[0] / 2, 2 * Z[1] + L[1] / 2];
    P = Pn;
    if (!finite(P) || !finite(Q)) return W_POLE();
    if (j < n - 1 && Math.hypot(P[0], P[1]) > WT) {
      const e = wLocal(c, P, Q);
      if (e) {
        const r = wSeries(c, e);
        zoff = [Z[0] - r.Z[0], Z[1] - r.Z[1]];
        eps = e;
        local = true;
      }
    }
  }
  if (local) {
    const r = wSeries(c, eps);
    P = r.P; Q = r.Q; Z = [r.Z[0] + zoff[0], r.Z[1] + zoff[1]];
  }
  if (!finite(P) || !finite(Q)) return W_POLE();
  return {wp: [P[0] * s2, P[1] * s2], wpp: [Q[0] * s2 * s, Q[1] * s2 * s], zeta: [Z[0] * s, Z[1] * s]};
}

// The next function follows `geometry` in meromorphic-wave-atlas/wave_math.js (roots of the cubic for
// real invariants; complete elliptic integral by the arithmetic-geometric mean).
function agmK(mc) {                                 // K(m) from the complementary parameter mc = 1 - m
  let x = 1, y = Math.sqrt(Math.max(0, mc));
  for (let j = 0; j < 40 && Math.abs(x - y) > 2e-15 * x; j++) { const next = (x + y) / 2; y = Math.sqrt(x * y); x = next; }
  return Math.PI / (2 * x);
}

/** Real lattice data for real g2, g3: {type, period, imag, roots}. period = smallest positive real period or null. */
export function realLattice(g2, g3) {
  if (typeof g2 !== 'number' || typeof g3 !== 'number' || !Number.isFinite(g2) || !Number.isFinite(g3)) return null;
  if (g2 === 0 && g3 === 0) return {type: 'rational', period: null, imag: null, disc: 0};
  const scale = Math.max(Math.sqrt(Math.abs(g2)), Math.cbrt(Math.abs(g3)));
  const a = g2 / scale / scale, b = g3 / scale / scale / scale;
  const disc = a * a * a - 27 * b * b, den = Math.abs(a * a * a) + 27 * b * b;
  if (Math.abs(disc) <= 2e-12 * den && g2 >= 0) {
    const e = Math.sign(-g3) * Math.sqrt(g2 / 12);
    if (e > 0) return {type: 'hyperbolic', period: null, imag: null, disc: 0, roots: [e, e, -2 * e]};
    const G = -3 * e;
    return {type: 'trigonometric', period: Math.PI / Math.sqrt(G), imag: null, disc: 0, roots: [-2 * e, e, e]};
  }
  if (disc > 0) {
    const r = Math.sqrt(a / 12);
    const theta = Math.acos(Math.max(-1, Math.min(1, 3 * Math.sqrt(3) * b / Math.pow(a, 1.5)))) / 3;
    const e = [0, 1, -1].map(j => 2 * r * Math.cos(theta - j * 2 * Math.PI / 3) * scale);
    const G = e[0] - e[2], D = e[1] - e[2], mc = (e[0] - e[1]) / G, m = D / G;
    return {type: 'rectangular', period: 2 * agmK(mc) / Math.sqrt(G), imag: agmK(m) / Math.sqrt(G), disc: 1, roots: e};
  }
  const rad = Math.sqrt(Math.max(0, b * b / 64 - a * a * a / 1728));
  const en = Math.cbrt(b / 8 + rad) + Math.cbrt(b / 8 - rad), hn = Math.sqrt(3 * en * en - a / 4);
  const H = hn * scale, mc = 0.5 + 3 * en / (4 * hn);
  return {type: 'rhombic', period: 2 * agmK(mc) / Math.sqrt(H), imag: null, disc: -1, roots: [en * scale]};
}

/** Smallest positive real period of wp(.; g2, g3) for real invariants; null if there is none. */
export function realPeriod(g2, g3) {
  const L = realLattice(g2, g3);
  return L && Number.isFinite(L.period) && L.period > 0 ? L.period : null;
}

/** omega'/i > 0 (half of the purely imaginary period) when g2^3 - 27 g3^2 > 0; null otherwise. */
export function imagHalfPeriod(g2, g3) {
  const L = realLattice(g2, g3);
  return L && L.type === 'rectangular' && Number.isFinite(L.imag) && L.imag > 0 ? L.imag : null;
}

/* ------------------------------------------------------------------ numeric evaluation */

const CONSTS = {I: [0, 1], pi: [Math.PI, 0], E: [Math.E, 0], oo: [Infinity, 0]};

const FUNCS = {
  exp: [1, cexp], log: [1, clog], sqrt: [1, csqrt],
  sin: [1, csin], cos: [1, ccos], tan: [1, ctan],
  cot: [1, a => cinv(ctan(a))], sec: [1, a => cinv(ccos(a))], csc: [1, a => cinv(csin(a))],
  sinh: [1, csinh], cosh: [1, ccosh], tanh: [1, ctanh],
  coth: [1, a => cinv(ctanh(a))], sech: [1, a => cinv(ccosh(a))], csch: [1, a => cinv(csinh(a))],
  Abs: [1, a => [Math.hypot(a[0], a[1]), 0]], re: [1, a => [a[0], 0]], im: [1, a => [a[1], 0]],
  conjugate: [1, a => [a[0], -a[1]]],
  wp: [3, (z, g2, g3) => weierstrass(z, g2, g3).wp],
  wpp: [3, (z, g2, g3) => weierstrass(z, g2, g3).wpp],
  zeta_w: [3, (z, g2, g3) => weierstrass(z, g2, g3).zeta],
};

function intLiteral(n) {
  if (n.t === 'num' && /^\d+$/.test(n.v) && Number(n.v) <= 4096) return Number(n.v);
  if (n.t === 'neg') { const k = intLiteral(n.arg); return k === null ? null : -k; }
  return null;
}

function comp(n) {
  switch (n.t) {
    case 'num': { const v = [Number(n.v), 0]; return () => v; }
    case 'sym': {
      const name = n.name;
      return env => {
        if (own(env, name)) {
          const v = env[name];
          if (typeof v === 'number') return [v, 0];
          if (Array.isArray(v) && v.length === 2) return v;
        }
        if (own(CONSTS, name)) return CONSTS[name];
        throw new Error('missing symbol: ' + name);
      };
    }
    case 'add': {
      const fs = n.args.map(comp);
      return env => { let re = 0, im = 0; for (const f of fs) { const v = f(env); re += v[0]; im += v[1]; } return [re, im]; };
    }
    case 'mul': {
      const fs = n.args.map(comp);
      return env => { let r = fs[0](env); for (let i = 1; i < fs.length; i++) r = cmul(r, fs[i](env)); return r; };
    }
    case 'neg': { const f = comp(n.arg); return env => { const v = f(env); return [-v[0], -v[1]]; }; }
    case 'div': { const fa = comp(n.num), fb = comp(n.den); return env => cdiv(fa(env), fb(env)); }
    case 'pow': {
      const fb = comp(n.base);
      const k = intLiteral(n.exp);
      if (k !== null) return env => cipow(fb(env), k);
      const fe = comp(n.exp);
      return env => cpow(fb(env), fe(env));
    }
    case 'call': {
      if (!own(FUNCS, n.fn)) throw new Error('unsupported function: ' + n.fn);
      const [arity, impl] = FUNCS[n.fn];
      if (n.args.length !== arity) throw new Error(`unsupported function: ${n.fn} with ${n.args.length} argument${n.args.length === 1 ? '' : 's'}`);
      const fs = n.args.map(comp);
      if (arity === 1) { const f = fs[0]; return env => impl(f(env)); }
      return env => impl(...fs.map(f => f(env)));
    }
    case 'rel': {
      const fa = comp(n.lhs), fb = comp(n.rhs), op = n.op;
      return env => {
        const a = fa(env), b = fb(env);
        const tol = 1e-9 * Math.max(1, cabs(a), cabs(b));
        const eq = cabs(csub(a, b)) <= tol;
        let r;
        if (op === '==') r = eq;
        else if (op === '!=') r = !eq;
        else if (op === '<') r = a[0] < b[0] && !eq;
        else if (op === '<=') r = a[0] < b[0] || eq;
        else if (op === '>') r = a[0] > b[0] && !eq;
        else r = a[0] > b[0] || eq;
        return [r ? 1 : 0, 0];
      };
    }
    default: throw new Error('cannot evaluate this expression');
  }
}

/** compile(textOrAst) -> f(env) -> [re, im]; env: name -> number | [re, im]. */
export function compile(textOrAst) {
  const f = comp(asAst(textOrAst));
  return env => f(env || {});
}
