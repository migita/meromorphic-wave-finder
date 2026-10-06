// plot.js — a solution of the report on the real axis, drawn as SVG.
//
//   plotSolution(container, solution, report, opts = {})  -> {redraw, destroy}
//   canPlot(solution)                                     -> boolean
//
// `solution` is a Solution object (SCHEMA §2), `report` the report it belongs to; every field may be
// missing.  The picture is an illustration: floating point, never part of a certificate.
// No DOM access at module level (the module can be imported under node).

import {parse, compile, freeSymbols, realLattice} from './expr.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SAMPLES = 800;
let uid = 0;

/* ------------------------------------------------------------------ names and numbers */

const GREEK_U = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function prettyName(name) {
  const m = /^([A-Za-z]+?)_?(\d+)$/.exec(name);
  const head = m ? m[1] : name;
  const sub = m ? m[2] : '';
  return (own(GREEK_U, head) ? GREEK_U[head] : head) + sub.replace(/\d/g, d => SUBSCRIPTS[Number(d)]);
}

const isShiftName = name => /^z_?\d+$/.test(name) || /^zeta_?0$/.test(name);

// a real number, a fraction, or a complex value such as "1.5i", "2-0.5i", "I*2", "pi/3"
function parseValue(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? [text, 0] : null;
  if (Array.isArray(text) && text.length === 2 && text.every(v => typeof v === 'number' && Number.isFinite(v))) return [text[0], text[1]];
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/−/g, '-');
  if (!s) return null;
  s = s.replace(/(\d|\.)\s*[ij]\b/g, '$1*I').replace(/\b[ij]\b/g, 'I');
  try {
    const v = compile(parse(s))({});
    return Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;
  } catch (err) {
    return null;
  }
}

function fmtNum(v, digits = 6) {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : 'undefined';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const s = (a >= 1e6 || a < 1e-4)
    ? v.toExponential(Math.max(0, digits - 3)).replace(/\.?0+e/, 'e').replace('e+', 'e')
    : String(Number(v.toPrecision(digits)));
  return s.replace(/-/g, '−');
}

function fmtComplex(v, digits = 6) {
  const [re, im] = v;
  const tiny = 1e-12 * Math.max(Math.abs(re), Math.abs(im));
  if (Math.abs(im) <= tiny) return fmtNum(re, digits);
  const imPart = a => (a === 1 ? '' : fmtNum(a, digits)) + 'i';
  if (Math.abs(re) <= tiny) return (im < 0 ? '−' : '') + imPart(Math.abs(im));
  return fmtNum(re, digits) + (im < 0 ? ' − ' : ' + ') + imPart(Math.abs(im));
}

const fmtTick = v => fmtNum(v, 3);

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(k === 0 ? 0 : k * step);
  return out;
}

/* ------------------------------------------------------------------ what has to be evaluated */

function findWeierstrassCall(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.t === 'call') {
    if ((node.fn === 'wp' || node.fn === 'wpp' || node.fn === 'zeta_w') && node.args.length === 3) return node;
    for (const a of node.args) { const r = findWeierstrassCall(a); if (r) return r; }
    return null;
  }
  switch (node.t) {
    case 'add': case 'mul': for (const a of node.args) { const r = findWeierstrassCall(a); if (r) return r; } return null;
    case 'div': return findWeierstrassCall(node.num) || findWeierstrassCall(node.den);
    case 'pow': return findWeierstrassCall(node.base) || findWeierstrassCall(node.exp);
    case 'neg': return findWeierstrassCall(node.arg);
    case 'rel': return findWeierstrassCall(node.lhs) || findWeierstrassCall(node.rhs);
    default: return null;
  }
}

function reaches(syms, target, defs, seen = new Set()) {
  for (const s of syms) {
    if (s === target) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    if (defs.has(s) && reaches(defs.get(s).syms, target, defs, seen)) return true;
  }
  return false;
}

// Returns {error, detail} or the data needed to evaluate the formula.
function analyse(solution, report) {
  const sol = solution && typeof solution === 'object' ? solution : {};
  const text = typeof sol.expr === 'string' ? sol.expr.trim() : '';
  if (!text) return {error: 'none'};
  let ast;
  try { ast = parse(text); } catch (err) { return {error: 'parse', detail: err.message}; }
  if (ast.t === 'rel') {
    if (ast.op === '==' && ast.lhs.t === 'sym') ast = ast.rhs;
    else return {error: 'parse', detail: 'the formula is a relation'};
  }
  let f;
  try { f = compile(ast); } catch (err) {
    const m = /^unsupported function: (.*)$/.exec(err.message);
    return m ? {error: 'function', detail: m[1]} : {error: 'parse', detail: err.message};
  }
  const eq = report && typeof report === 'object' && report.equation && typeof report.equation === 'object' ? report.equation : {};
  let varName = typeof eq.var === 'string' && eq.var ? eq.var : 'z';
  const unknown = typeof eq.unknown === 'string' && eq.unknown ? eq.unknown : 'w';
  const params = Array.isArray(eq.params) ? eq.params.filter(p => typeof p === 'string') : [];
  const freeList = Array.isArray(sol.free) ? sol.free.filter(p => typeof p === 'string') : [];
  const consts = sol.constants && typeof sol.constants === 'object' && !Array.isArray(sol.constants) ? sol.constants : {};

  const defs = new Map();          // name -> {f, syms, ast, text, source}
  const loose = [];                // constants whose definition cannot be evaluated here
  for (const [name, raw] of Object.entries(consts)) {
    if (name === varName) continue;
    const val = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!val || /^free\b/i.test(val)) continue;
    try {
      const a = parse(val);
      if (a.t === 'rel') throw new Error('relation');
      defs.set(name, {f: compile(a), syms: freeSymbols(a), ast: a, text: val, source: 'constant'});
    } catch (err) {
      loose.push(name);
    }
  }

  // If the variable named by the report does not occur in the formula but a usual letter does, that
  // letter is the variable (a formula written in z for an equation typed in another letter).
  const known = new Set([...params, ...freeList, ...Object.keys(consts)]);
  const reachable = new Set();
  (function walk(names) {
    for (const s of names) {
      if (reachable.has(s)) continue;
      reachable.add(s);
      if (defs.has(s)) walk(defs.get(s).syms);
    }
  })(freeSymbols(ast));
  if (!reachable.has(varName)) {
    for (const cand of ['z', 'xi', 'x', 't', 'zeta']) {
      if (reachable.has(cand) && !known.has(cand) && !defs.has(cand)) { varName = cand; break; }
    }
  }

  // conditions of the family: "name == expression" fixes the name; anything else is checked numerically
  const checks = [];
  const conds = Array.isArray(sol.conditions) ? sol.conditions.filter(c => typeof c === 'string') : [];
  for (const c of conds) {
    let a;
    try { a = parse(c); } catch (err) { continue; }
    if (a.t !== 'rel') continue;
    let fixed = false;
    if (a.op === '==') {
      for (const [L, R] of [[a.lhs, a.rhs], [a.rhs, a.lhs]]) {
        if (L.t !== 'sym' || L.name === varName || defs.has(L.name)) continue;
        try {
          const syms = freeSymbols(R);
          if (syms.includes(varName) || reaches(syms, L.name, defs)) continue;
          defs.set(L.name, {f: compile(R), syms, ast: R, text: c, source: 'condition'});
          fixed = true;
          break;
        } catch (err) { /* not evaluable: fall through to the numeric check */ }
      }
    }
    if (!fixed) {
      try { checks.push({text: c, f: compile(a), syms: freeSymbols(a)}); } catch (err) { /* ignored */ }
    }
  }

  // BRIEF §3: simply periodic solutions are written with s = exp(nu z)
  if (varName !== 's' && !defs.has('s') && !known.has('s') && (known.has('nu') || defs.has('nu'))
      && reaches(freeSymbols(ast), 's', defs)) {
    const a = parse('exp(nu*' + varName + ')');
    defs.set('s', {f: compile(a), syms: ['nu', varName], ast: a, text: 'exp(nu*' + varName + ')', source: 'notation'});
  }

  // dependency order
  const order = [];
  const state = new Map();
  const inputSet = new Set();
  let cyclic = false;
  (function visitAll(names) {
    for (const name of names) {
      if (name === varName) continue;
      if (!defs.has(name)) { inputSet.add(name); continue; }
      const st = state.get(name);
      if (st === 2) continue;
      if (st === 1) { cyclic = true; continue; }
      state.set(name, 1);
      visitAll(defs.get(name).syms);
      state.set(name, 2);
      order.push(name);
    }
  })(freeSymbols(ast));
  if (cyclic) return {error: 'cycle'};

  const dynamic = new Set();
  for (const name of order) {
    if (defs.get(name).syms.some(s => s === varName || dynamic.has(s))) dynamic.add(name);
  }

  const inputs = [];
  for (const p of params) if (inputSet.has(p) && !inputs.includes(p)) inputs.push(p);
  for (const p of freeList) if (inputSet.has(p) && !inputs.includes(p)) inputs.push(p);
  for (const p of Array.from(inputSet).sort()) if (!inputs.includes(p)) inputs.push(p);

  let wcall = findWeierstrassCall(ast);
  for (const name of order) { if (wcall) break; wcall = findWeierstrassCall(defs.get(name).ast); }
  let wfun = null;
  if (wcall) {
    try { wfun = {arg: compile(wcall.args[0]), g2: compile(wcall.args[1]), g3: compile(wcall.args[2])}; } catch (err) { wfun = null; }
  }
  return {ast, f, varName, unknown, params, defs, order, dynamic, inputs, loose, checks, wfun,
    elliptic: sol.kind === 'elliptic' || !!wcall};
}

export function canPlot(solution) {
  try {
    return !analyse(solution, null).error;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ sampling */

function magnitude(v) {
  return v && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? Math.hypot(v[0], v[1]) : Infinity;
}

// Positions on the axis where |w| grows without bound under refinement (`poles`); `gaps` is true when
// the formula is not finite on a whole stretch of the interval (overflow, not a pole).
function findPoles(xs, vals, evalAt) {
  const n = xs.length;
  const mags = vals.map(magnitude);
  const fin = mags.filter(Number.isFinite).sort((a, b) => a - b);
  if (!fin.length) return {poles: [], gaps: true};
  const med = fin[Math.floor(fin.length / 2)];
  const poles = [];
  let gaps = false;
  let budget = 120;
  for (let i = 0; i < n; i++) {
    if (mags[i] === Infinity) {
      let j = i;
      while (j + 1 < n && mags[j + 1] === Infinity) j++;
      if (j - i <= 1) poles.push((xs[i] + xs[j]) / 2); else gaps = true;
      i = j;
      continue;
    }
    const l = i > 0 ? mags[i - 1] : -Infinity, r = i < n - 1 ? mags[i + 1] : -Infinity;
    if (!(mags[i] >= l && mags[i] >= r && (mags[i] > l || mags[i] > r))) continue;
    if (!(mags[i] > 4 * med) || budget <= 0) continue;
    budget--;
    let a = xs[Math.max(0, i - 1)], b = xs[Math.min(n - 1, i + 1)], best = mags[i], at = xs[i];
    for (let it = 0; it < 44 && Number.isFinite(best); it++) {
      const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
      const f1 = magnitude(evalAt(m1)), f2 = magnitude(evalAt(m2));
      if (f1 > best) { best = f1; at = m1; }
      if (f2 > best) { best = f2; at = m2; }
      if (f1 < f2) a = m1; else b = m2;
    }
    if (!Number.isFinite(best) || best > 1e3 * mags[i] || best > 1e8 * Math.max(med, 1e-300)) poles.push(at);
  }
  poles.sort((p, q) => p - q);
  const dx = n > 1 ? (xs[n - 1] - xs[0]) / (n - 1) : 1;
  const merged = [];
  for (const p of poles) {
    if (!merged.length || p - merged[merged.length - 1] > 1.01 * dx) merged.push(p);
  }
  return {poles: merged, gaps};
}

function quantile(sorted, q) {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))))];
}

/* ------------------------------------------------------------------ the widget */

const MESSAGES = {
  none: () => 'No formula is available for a plot.',
  parse: () => 'The formula cannot be read for plotting.',
  function: info => 'The formula uses a function that cannot be evaluated here' + (info.detail ? ' (' + info.detail + ').' : '.'),
  cycle: () => 'The constants of this solution are defined in terms of each other; the formula cannot be evaluated here.',
};

export function plotSolution(container, solution, report, opts = {}) {
  const inert = {redraw() {}, destroy() {}};
  if (!container || typeof container !== 'object') return inert;
  const doc = container.ownerDocument || document;
  const options = opts && typeof opts === 'object' ? opts : {};
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svgEl = (tag, attrs) => {
    const e = doc.createElementNS(SVGNS, tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  };

  container.textContent = '';
  container.classList.add('plot');

  let info;
  try { info = analyse(solution, report); } catch (err) { info = {error: 'parse', detail: String(err && err.message)}; }
  if (info.error) {
    const p = el('p', 'plot-message', (MESSAGES[info.error] || MESSAGES.parse)(info));
    container.appendChild(p);
    return inert;
  }

  const id = 'plot-' + (++uid);
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {};
  const samples = Number.isInteger(options.samples) && options.samples >= 50 ? Math.min(options.samples, 4000) : SAMPLES;
  const varLabel = prettyName(info.varName);
  const unknownLabel = prettyName(info.unknown);

  /* ---- controls ---- */
  const controls = el('div', 'plot-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Constants and interval of the plot');
  const fields = new Map();          // name -> input
  const addField = (key, labelText, value, title) => {
    const label = el('label', 'plot-field');
    const span = el('span', 'plot-field-name', labelText);
    const input = el('input', 'plot-input');
    input.type = 'text';
    input.id = id + '-' + key.replace(/[^A-Za-z0-9_-]/g, '_');
    input.name = key;
    input.value = value;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('inputmode', 'text');
    if (title) input.title = title;
    label.htmlFor = input.id;
    label.appendChild(span);
    label.appendChild(input);
    controls.appendChild(label);
    return input;
  };
  for (const name of info.inputs) {
    let start = isShiftName(name) ? '0' : '1';
    if (own(defaults, name)) {
      const d = defaults[name];
      const v = parseValue(d);
      if (v) start = typeof d === 'string' ? d.trim() : fmtComplex(v, 12).replace(/−/g, '-').replace(/\s/g, '');
    }
    fields.set(name, addField(name, prettyName(name), start, name + ': a number, a fraction such as 3/5, or a complex value such as 1.5i'));
  }
  const rangeDefault = Array.isArray(options.range) && options.range.length === 2 && options.range.every(Number.isFinite) && options.range[0] < options.range[1]
    ? options.range : null;
  const xminInput = addField('plot-from', varLabel + ' from', rangeDefault ? String(rangeDefault[0]) : '-10', 'left end of the interval');
  const xmaxInput = addField('plot-to', 'to', rangeDefault ? String(rangeDefault[1]) : '10', 'right end of the interval');
  let rangeTouched = !!rangeDefault;

  const shiftName = info.elliptic && info.wfun ? info.inputs.find(isShiftName) : undefined;
  let shiftButton = null;
  if (shiftName) {
    shiftButton = el('button', 'plot-button', 'Shift by the imaginary half-period');
    shiftButton.type = 'button';
    shiftButton.hidden = true;
    shiftButton.setAttribute('aria-pressed', 'false');
    shiftButton.title = 'Sets ' + prettyName(shiftName) + ' to i times the imaginary half-period: on that line the Weierstrass function is real and has no poles.';
    controls.appendChild(shiftButton);
  }
  container.appendChild(controls);

  const message = el('p', 'plot-message');
  message.setAttribute('role', 'status');
  message.hidden = true;
  container.appendChild(message);

  const figure = el('div', 'plot-figure');
  const svg = svgEl('svg', {class: 'plot-svg', role: 'img', tabindex: '0', focusable: 'true', preserveAspectRatio: 'xMidYMid meet'});
  figure.appendChild(svg);
  container.appendChild(figure);

  const legend = el('div', 'plot-legend');
  const legendRe = el('span', 'plot-legend-item');
  legendRe.appendChild(el('span', 'plot-key plot-key-re'));
  legendRe.appendChild(doc.createTextNode('Re ' + unknownLabel));
  const legendIm = el('span', 'plot-legend-item');
  legendIm.appendChild(el('span', 'plot-key plot-key-im'));
  legendIm.appendChild(doc.createTextNode('Im ' + unknownLabel));
  const readout = el('span', 'plot-readout');
  legend.appendChild(legendRe);
  legend.appendChild(legendIm);
  legend.appendChild(readout);
  container.appendChild(legend);

  const caption = el('p', 'plot-caption');
  container.appendChild(caption);
  const notes = el('div', 'plot-notes');
  container.appendChild(notes);

  /* ---- evaluation ---- */
  let current = null;                // data of the last successful drawing

  function readInputs() {
    const values = Object.create(null);
    let bad = null;
    for (const [name, input] of fields) {
      const v = parseValue(input.value);
      if (v) { values[name] = v; input.removeAttribute('aria-invalid'); }
      else { input.setAttribute('aria-invalid', 'true'); bad = bad || name; }
    }
    return {values, bad};
  }

  function staticEnv(values) {
    const env = {};
    for (const name of Object.keys(values)) env[name] = values[name];
    for (const name of info.order) {
      if (!info.dynamic.has(name)) env[name] = info.defs.get(name).f(env);
    }
    return env;
  }

  function evaluator(env0) {
    const dyn = info.order.filter(name => info.dynamic.has(name)).map(name => [name, info.defs.get(name).f]);
    const fullEnv = x => {
      const env = Object.assign({}, env0);
      env[info.varName] = [x, 0];
      for (const [name, g] of dyn) env[name] = g(env);
      return env;
    };
    const at = x => {
      try { return info.f(fullEnv(x)); } catch (err) { return null; }
    };
    return {at, fullEnv};
  }

  // lattice of the first Weierstrass function in the formula, in units of the variable
  function lattice(ev) {
    if (!info.wfun) return null;
    try {
      const e0 = ev.fullEnv(0), e1 = ev.fullEnv(1), e2 = ev.fullEnv(2);
      const g2 = info.wfun.g2(e0), g3 = info.wfun.g3(e0);
      const real = v => Math.abs(v[1]) <= 1e-12 * Math.max(1, Math.abs(v[0]));
      if (!real(g2) || !real(g3)) return null;
      const a0 = info.wfun.arg(e0), a1 = info.wfun.arg(e1), a2 = info.wfun.arg(e2);
      const k = [a1[0] - a0[0], a1[1] - a0[1]];
      const curv = Math.hypot(a2[0] - 2 * a1[0] + a0[0], a2[1] - 2 * a1[1] + a0[1]);
      const size = Math.hypot(k[0], k[1]);
      if (!(size > 0) || curv > 1e-9 * size || Math.abs(k[1]) > 1e-12 * size) return null;
      const L = realLattice(g2[0], g3[0]);
      if (!L) return null;
      return {
        period: L.period ? L.period / Math.abs(k[0]) : null,
        imag: L.type === 'rectangular' && L.imag ? L.imag / Math.abs(k[0]) : null,
      };
    } catch (err) {
      return null;
    }
  }

  function showMessage(text) {
    message.textContent = text;
    message.hidden = !text;
  }

  function setRangeInputs(half) {
    const h = Number(half.toPrecision(4));
    xminInput.value = String(-h);
    xmaxInput.value = String(h);
  }

  function redraw() {
    const {values, bad} = readInputs();
    if (bad) {
      showMessage('Enter a number for ' + prettyName(bad) + ', for example 0.5, 3/5 or 1+2i.');
      return;
    }
    let env0, ev;
    try {
      env0 = staticEnv(values);
      ev = evaluator(env0);
    } catch (err) {
      showMessage('The formula cannot be evaluated for these constants.');
      return;
    }
    const lat = lattice(ev);
    if (!rangeTouched) setRangeInputs(lat && lat.period ? 1.5 * lat.period : 10);
    const lo = parseValue(xminInput.value), hi = parseValue(xmaxInput.value);
    const rangeOk = lo && hi && lo[1] === 0 && hi[1] === 0 && lo[0] < hi[0];
    for (const [inp, ok] of [[xminInput, lo && lo[1] === 0], [xmaxInput, hi && hi[1] === 0 && (!lo || hi[0] > lo[0])]]) {
      if (ok) inp.removeAttribute('aria-invalid'); else inp.setAttribute('aria-invalid', 'true');
    }
    if (!rangeOk) {
      showMessage('The interval needs two real numbers, the first smaller than the second.');
      return;
    }
    const x0 = lo[0], x1 = hi[0];

    if (shiftButton) {
      const possible = !!(lat && lat.imag);
      shiftButton.hidden = !possible;
      const zv = values[shiftName];
      const pressed = possible && zv && Math.abs(zv[0]) <= 1e-9 * lat.imag && Math.abs(Math.abs(zv[1]) - lat.imag) <= 1e-9 * lat.imag;
      shiftButton.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      shiftButton.dataset.value = possible ? String(Number(lat.imag.toPrecision(13))) : '';
    }

    const xs = new Array(samples), vals = new Array(samples);
    let maxAbs = 0, maxIm = 0, finiteCount = 0;
    for (let i = 0; i < samples; i++) {
      const x = x0 + (x1 - x0) * i / (samples - 1);
      xs[i] = x;
      const v = ev.at(x);
      if (v && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
        vals[i] = v;
        finiteCount++;
        maxAbs = Math.max(maxAbs, Math.abs(v[0]), Math.abs(v[1]));
        maxIm = Math.max(maxIm, Math.abs(v[1]));
      } else vals[i] = null;
    }
    if (!finiteCount) {
      svg.textContent = '';
      current = null;
      readout.textContent = '';
      caption.textContent = '';
      showMessage('The formula has no finite values on this interval for these constants.');
      return;
    }
    showMessage('');
    const showIm = maxIm > 1e-9 * maxAbs;
    const {poles, gaps} = findPoles(xs, vals, ev.at);

    // vertical range
    const all = [];
    for (const v of vals) { if (v) { all.push(v[0]); if (showIm) all.push(v[1]); } }
    all.sort((a, b) => a - b);
    let ylo, yhi;
    const clipped = poles.length > 0 || gaps;
    if (clipped) {
      // The values away from the poles decide the range: samples closer to a pole than a fifth of
      // the typical distance between poles are left out.
      const inside = poles.filter(p => p >= x0 && p <= x1);
      const delta = 0.2 * (x1 - x0) / (inside.length + 1);
      let lo = Infinity, hi = -Infinity, k = 0;
      for (let i = 0; i < samples; i++) {
        const v = vals[i];
        if (!v) continue;
        while (k < inside.length && inside[k] < xs[i] - delta) k++;
        if (k < inside.length && Math.abs(inside[k] - xs[i]) < delta) continue;
        lo = Math.min(lo, v[0]);
        hi = Math.max(hi, v[0]);
        if (showIm) { lo = Math.min(lo, v[1]); hi = Math.max(hi, v[1]); }
      }
      if (!inside.length || !(hi >= lo)) { lo = quantile(all, 0.08); hi = quantile(all, 0.92); }
      let span = hi - lo;
      if (!(span > 0)) span = Math.max(Math.abs(hi), 1e-6);
      ylo = lo - 0.6 * span;
      yhi = hi + 0.6 * span;
      if (ylo > 0 && ylo < 2 * span) ylo = -0.05 * yhi;
      if (yhi < 0 && -yhi < 2 * span) yhi = -0.05 * ylo;
    } else {
      ylo = all[0];
      yhi = all[all.length - 1];
      let span = yhi - ylo;
      if (span < 1e-12 * Math.max(Math.abs(yhi), Math.abs(ylo), 1e-20)) {
        span = Math.max(Math.abs(yhi) * 0.2, 1e-4);
        ylo -= span / 2;
        yhi += span / 2;
      } else {
        ylo -= 0.1 * span;
        yhi += 0.1 * span;
      }
    }

    current = {xs, vals, x0, x1, ylo, yhi, showIm, poles, clipped, values};
    paint();

    legendIm.hidden = !showIm;
    const parts = [];
    for (const name of info.inputs) parts.push(prettyName(name) + ' = ' + fmtComplex(values[name]));
    for (const name of info.order) {
      const d = info.defs.get(name);
      if (d.source === 'condition' && !info.dynamic.has(name)) parts.push(prettyName(name) + ' = ' + fmtComplex(env0[name]) + ' (condition of the family)');
      if (d.source === 'notation') parts.push('s = exp(' + prettyName('nu') + ' ' + varLabel + ')');
    }
    caption.textContent = (parts.length ? parts.join(', ') + '; ' : '') + 'real axis'
      + (poles.length ? '; the vertical range is cut off near the poles' : '')
      + (gaps ? '; the formula is not finite on part of the interval' : '') + '.';

    notes.textContent = '';
    for (const name of info.loose) {
      if (info.inputs.includes(name)) notes.appendChild(el('p', 'plot-note', 'The constant ' + prettyName(name) + ' is not given in a form that can be evaluated here; the value entered above is used.'));
    }
    const envCheck = ev.fullEnv(0);
    for (const c of info.checks) {
      if (c.syms.includes(info.varName)) continue;
      try {
        const r = c.f(envCheck);
        if (r[0] === 0) notes.appendChild(el('p', 'plot-note', 'These constants do not satisfy the condition ' + c.text + ' of this family; the curve shows the formula, not a solution.'));
      } catch (err) { /* the condition involves symbols that are not part of the formula */ }
    }
  }

  /* ---- drawing ---- */
  let geom = null;
  let cross = null;

  function paint() {
    if (!current) return;
    const {xs, vals, x0, x1, ylo, yhi, showIm, poles, clipped} = current;
    const W = Math.max(280, Math.round(figure.clientWidth || 640));
    const H = Math.max(180, Math.min(360, Math.round(W * 7 / 16)));
    const m = {l: 54, r: 14, t: 12, b: 28};
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const sx = x => m.l + (x - x0) / (x1 - x0) * pw;
    const sy = y => m.t + (yhi - y) / (yhi - ylo) * ph;
    const clampY = Y => Math.max(-4 * H, Math.min(5 * H, Y));
    geom = {W, H, m, pw, ph, sx, sy};

    svg.textContent = '';
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('aria-label', 'Plot of ' + (showIm ? 'the real and imaginary parts of ' : '') + unknownLabel
      + ' on the real axis, ' + varLabel + ' from ' + fmtTick(x0) + ' to ' + fmtTick(x1)
      + (poles.length ? ', with ' + poles.length + (poles.length === 1 ? ' pole' : ' poles') + ' on the interval' : '') + '.');

    const defsEl = svgEl('defs');
    const clip = svgEl('clipPath', {id: id + '-clip'});
    clip.appendChild(svgEl('rect', {x: m.l, y: m.t, width: pw, height: ph}));
    defsEl.appendChild(clip);
    svg.appendChild(defsEl);

    // horizontal grid and labels
    for (const t of niceTicks(ylo, yhi, 4)) {
      const Y = Math.round(sy(t)) + 0.5;
      svg.appendChild(svgEl('line', {class: t === 0 ? 'plot-zero' : 'plot-grid', x1: m.l, x2: m.l + pw, y1: Y, y2: Y}));
      const label = svgEl('text', {class: 'plot-tick', x: m.l - 8, y: Y, 'text-anchor': 'end', 'dominant-baseline': 'middle'});
      label.textContent = fmtTick(t);
      svg.appendChild(label);
    }
    // baseline and ticks of the horizontal axis
    const base = Math.round(m.t + ph) + 0.5;
    svg.appendChild(svgEl('line', {class: 'plot-axis', x1: m.l, x2: m.l + pw, y1: base, y2: base}));
    for (const t of niceTicks(x0, x1, W < 420 ? 4 : 7)) {
      const X = Math.round(sx(t)) + 0.5;
      svg.appendChild(svgEl('line', {class: 'plot-axis', x1: X, x2: X, y1: base, y2: base + 4}));
      const label = svgEl('text', {class: 'plot-tick', x: X, y: base + 16, 'text-anchor': 'middle'});
      label.textContent = fmtTick(t);
      svg.appendChild(label);
    }
    const axisName = svgEl('text', {class: 'plot-tick plot-axis-name', x: m.l + pw, y: m.t + ph - 6, 'text-anchor': 'end'});
    axisName.textContent = varLabel;
    svg.appendChild(axisName);

    // poles
    for (const p of poles) {
      if (p < x0 || p > x1) continue;
      const X = sx(p);
      svg.appendChild(svgEl('line', {class: 'plot-pole', x1: X, x2: X, y1: m.t, y2: m.t + ph}));
    }

    // curves
    const dx = (x1 - x0) / (xs.length - 1);
    const breakAfter = new Uint8Array(xs.length);
    for (const p of poles) {
      const i = Math.floor((p - x0) / dx);
      if (i >= 0 && i < xs.length) breakAfter[i] = 1;
      if (i - 1 >= 0 && Math.abs(xs[i] - p) < 1e-9 * Math.abs(dx)) breakAfter[i - 1] = 1;
    }
    const pathOf = part => {
      let d = '', pen = false, prev = 0;
      for (let i = 0; i < xs.length; i++) {
        const v = vals[i];
        if (!v) { pen = false; continue; }
        const y = v[part];
        if (pen && i > 0 && breakAfter[i - 1]) pen = false;
        if (pen && clipped && ((prev > yhi && y < ylo) || (prev < ylo && y > yhi))) pen = false;
        d += (pen ? 'L' : 'M') + sx(xs[i]).toFixed(2) + ' ' + clampY(sy(y)).toFixed(2);
        pen = true;
        prev = y;
      }
      return d;
    };
    const group = svgEl('g', {'clip-path': 'url(#' + id + '-clip)'});
    if (showIm) group.appendChild(svgEl('path', {class: 'plot-line-im', d: pathOf(1)}));
    group.appendChild(svgEl('path', {class: 'plot-line-re', d: pathOf(0)}));
    svg.appendChild(group);

    // hover layer
    const line = svgEl('line', {class: 'plot-cross', y1: m.t, y2: m.t + ph, x1: 0, x2: 0, visibility: 'hidden'});
    const dotRe = svgEl('circle', {class: 'plot-dot', r: 4, cx: 0, cy: 0, visibility: 'hidden'});
    const dotIm = svgEl('circle', {class: 'plot-dot plot-dot-im', r: 4, cx: 0, cy: 0, visibility: 'hidden'});
    svg.appendChild(line);
    svg.appendChild(dotIm);
    svg.appendChild(dotRe);
    cross = {line, dotRe, dotIm, index: -1};
  }

  function showCross(i) {
    if (!current || !geom || !cross) return;
    const {xs, vals, ylo, yhi, showIm} = current;
    i = Math.max(0, Math.min(xs.length - 1, i));
    cross.index = i;
    const X = geom.sx(xs[i]);
    cross.line.setAttribute('x1', X);
    cross.line.setAttribute('x2', X);
    cross.line.setAttribute('visibility', 'visible');
    const v = vals[i];
    const place = (dot, y, on) => {
      const visible = on && Number.isFinite(y) && y >= ylo && y <= yhi;
      dot.setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (visible) { dot.setAttribute('cx', X); dot.setAttribute('cy', geom.sy(y)); }
    };
    place(cross.dotRe, v ? v[0] : NaN, true);
    place(cross.dotIm, v ? v[1] : NaN, showIm);
    let text = varLabel + ' = ' + fmtNum(xs[i], 4) + '   ';
    if (!v) text += unknownLabel + ' is not finite here';
    else {
      text += 'Re ' + unknownLabel + ' = ' + fmtNum(v[0], 5);
      if (showIm) text += '   Im ' + unknownLabel + ' = ' + fmtNum(v[1], 5);
    }
    readout.textContent = text;
  }

  function hideCross() {
    if (!cross) return;
    cross.index = -1;
    for (const e of [cross.line, cross.dotRe, cross.dotIm]) e.setAttribute('visibility', 'hidden');
    readout.textContent = '';
  }

  function indexFromPointer(ev) {
    const r = svg.getBoundingClientRect();
    if (!geom || !current || !(r.width > 0)) return -1;
    const px = (ev.clientX - r.left) * geom.W / r.width;
    return Math.round((px - geom.m.l) / geom.pw * (current.xs.length - 1));
  }

  /* ---- events ---- */
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; safeRedraw(); }, 150);
  };
  function safeRedraw() {
    try { redraw(); } catch (err) { showMessage('The plot could not be drawn for these constants.'); }
  }
  const onInput = ev => {
    if (ev.target === xminInput || ev.target === xmaxInput) rangeTouched = true;
    schedule();
  };
  controls.addEventListener('input', onInput);
  if (shiftButton) {
    shiftButton.addEventListener('click', () => {
      const input = fields.get(shiftName);
      if (!input || !shiftButton.dataset.value) return;
      input.value = shiftButton.getAttribute('aria-pressed') === 'true' ? '0' : shiftButton.dataset.value + 'i';
      safeRedraw();
    });
  }
  svg.addEventListener('pointermove', ev => { const i = indexFromPointer(ev); if (i >= 0) { readout.removeAttribute('aria-live'); showCross(i); } });
  svg.addEventListener('pointerdown', ev => { const i = indexFromPointer(ev); if (i >= 0) showCross(i); });
  svg.addEventListener('pointerleave', hideCross);
  svg.addEventListener('blur', hideCross);
  svg.addEventListener('keydown', ev => {
    if (!current) return;
    const n = current.xs.length;
    const step = ev.shiftKey ? 25 : 1;
    let i = cross && cross.index >= 0 ? cross.index : Math.floor(n / 2);
    if (ev.key === 'ArrowLeft') i -= step;
    else if (ev.key === 'ArrowRight') i += step;
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = n - 1;
    else if (ev.key === 'Escape') { hideCross(); return; }
    else return;
    ev.preventDefault();
    readout.setAttribute('aria-live', 'polite');
    showCross(i);
  });

  let observer = null;
  let lastWidth = 0;
  const View = doc.defaultView;
  if (View && typeof View.ResizeObserver === 'function') {
    observer = new View.ResizeObserver(() => {
      const w = Math.round(figure.clientWidth || 0);
      if (w && w !== lastWidth) { lastWidth = w; try { paint(); } catch (err) { /* keep the previous drawing */ } }
    });
    observer.observe(figure);
  }

  safeRedraw();
  lastWidth = Math.round(figure.clientWidth || 0);

  return {
    redraw: safeRedraw,
    destroy() {
      if (timer) clearTimeout(timer);
      if (observer) observer.disconnect();
      controls.removeEventListener('input', onInput);
      container.textContent = '';
    },
  };
}
