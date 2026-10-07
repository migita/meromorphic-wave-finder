// The report renderer (SCHEMA section 3). One function, used by the entry page and by the catalogue.
// Every field may be missing, empty or of an unexpected type; unknown fields are kept in "Other data".
//
// A report can contain sub-reports (the equation on a special parameter locus: `strata`; the equation after a
// substitution u = w^m: `substitutions`). They are rendered by the same functions; the context C = {reg, idp}
// carries the registry and a prefix for element ids, so that the ids of a sub-report do not collide with those of
// the report.

import { el, arr, isObj, has, text, tex, mathOf, symbolList, rich, formulaBox, badge, statusChip, meter,
  LEVELS, LABELS, copyButton, downloadJSON, exprModule, safeId, sympyToLatex, markScrollable, substitute } from './common.js';

// engine details: shown together in one collapsed section
const DETAIL_KEYS = ['tier', 'low_order', 'entire', 'ends', 'pole_bound', 'free_coefficients', 'w_search', 'invariants'];
const DETAIL_NAMES = {
  tier: 'What the theorems give (tier)', low_order: 'Decision for equations of low order', entire: 'Solutions without poles',
  ends: 'Behaviour at infinity', pole_bound: 'Bounds on the number of poles', free_coefficients: 'Free Laurent coefficients',
  w_search: 'Search for rational, simply periodic and elliptic solutions', invariants: 'Invariant curves (Darboux polynomials)',
};
const KNOWN_TOP = new Set(['schema', 'engine', 'mode', 'elapsed_s', 'input', 'equation', 'normal_form', 'local',
  'classes', 'theorems', 'verdict', 'found', 'ruled_out', 'not_decided', 'd_summary', 'atlas', 'warnings', 'log',
  'sample_note', 'note', 'cached', 'rejected', 'strata', 'substitutions', 'twists', 'surfaces', 'degenerate_loci',
  'independent_check', 'candidates', 'copies_removed'].concat(DETAIL_KEYS));

const KIND_NAMES = {
  'constant': 'constant', 'polynomial': 'polynomial', 'rational': 'rational function',
  'simply-periodic': 'simply periodic', 'elliptic': 'elliptic', 'entire': 'entire', 'other': 'other',
};

let plotMod = null;
async function loadPlot() {
  if (plotMod === null) {
    try { plotMod = await import('./plot.js'); } catch (e) { plotMod = false; }
  }
  return plotMod || null;
}

// ---- small helpers -----------------------------------------------------------------------------------------
function facts(rows) {
  const dl = el('dl', { class: 'facts' });
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === false || (Array.isArray(v) && !v.length)) continue;
    dl.append(el('dt', null, k), el('dd', null, v));
  }
  return dl.children.length ? dl : null;
}
function ulist(items, cls) {
  const ul = el('ul', cls ? { class: cls } : null);
  for (const it of items) ul.append(el('li', null, it));
  return ul;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
function isLabel(x) { return Object.prototype.hasOwnProperty.call(LABELS, text(x)); }
/** a field that may arrive as a JSON string */
function parseMaybe(v) {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try { return JSON.parse(v); } catch { return v; }
}
function sourceText(src) {
  if (!has(src)) return null;
  if (typeof src === 'string') return src;
  if (isObj(src)) {
    const parts = [src.citation, src.where].filter(has).map(text);
    let s = parts.join(', ');
    if (has(src.path)) s += (s ? ' — ' : '') + text(src.path);
    return s || text(src);
  }
  return text(src);
}
function theoremLink(id) {
  return el('a', { class: 'chip', href: 'method.html#' + encodeURIComponent(text(id)), title: 'The theorem on the method page' }, text(id));
}
/** is this the identifier of a theorem or lemma of the registry (as opposed to a record or a computation)? */
function isTheoremId(id, reg) {
  const s = text(id);
  return (reg && reg.ids && reg.ids.has(s)) || /^[TL]-[A-Za-z0-9_-]+$/.test(s);
}
function basisChip(b, registryIds) {
  const s = text(b);
  if (isTheoremId(s, { ids: registryIds })) return theoremLink(s);
  return el('span', { class: 'chip' }, s);
}
/** one condition on the parameters: a relation in SymPy text, possibly followed by a remark in parentheses */
function condNode(s, latex) {
  s = text(s);
  if (has(latex) || sympyToLatex(s, { jets: false })) return mathOf(s, latex, { jets: false });
  const m = /^(.*\S)\s+\((.*)\)\s*$/.exec(s);
  if (m && sympyToLatex(m[1], { jets: false })) return [mathOf(m[1], null, { jets: false }), ' ', el('span', { class: 'small muted' }, '(' + m[2] + ')')];
  return el('code', { class: 'sympy' }, s);
}
function condList(conds, latexes) {
  const c = arr(conds), l = arr(latexes);
  return c.map((s, i) => condNode(s, l[i]));
}
function inlineList(nodes, sep = ', ') {
  const out = [];
  nodes.forEach((n, i) => { if (i) out.push(sep); out.push(n); });
  return out;
}
/** the conditions of a found family: those on the parameters of the equation, and those that name the level C_I of a
    first integral (C_I is a constant of integration, not a parameter) */
const mentionsCI = c => /(^|[^A-Za-z0-9_])C_I(?![A-Za-z0-9_])/.test(text(c));
function splitConditions(s) {
  const conds = arr(s && s.conditions), lat = arr(s && s.conditions_latex);
  const out = { par: [], parL: [], level: [], levelL: [] };
  conds.forEach((c, i) => { const ci = mentionsCI(c); (ci ? out.level : out.par).push(c); (ci ? out.levelL : out.parL).push(lat[i]); });
  return out;
}
/** a family lives on special parameter values when one of its conditions on the parameters is an equality */
const isSpecialFamily = s => isObj(s) && splitConditions(s).par.some(c => /==/.test(text(c)));
const isDirectSearch = s => isObj(s) && has(s.note) && /found by a direct search on/.test(text(s.note));
/** "any root of P = 0 (remark)" with P typeset; null if the text is not of this form */
function rootNodes(val) {
  const m = /^any root of\s+(.+?)\s*=\s*0\b\s*(.*)$/.exec(text(val).trim());
  if (!m) return null;
  const lx = sympyToLatex(m[1], { jets: false });
  if (lx === null) return null;
  return ['any root of ', el('span', { class: 'math-scroll' }, tex(lx + ' = 0')), m[2] ? ' ' + m[2] : ''];
}
/** a note of the engine made of clauses separated by "; ": a clause "r is any root of P = 0" is typeset */
function clauseNodes(note) {
  const t = text(note);
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0 && t[i + 1] === ' ') { parts.push(t.slice(start, i)); start = i + 2; }
  }
  parts.push(t.slice(start));
  return inlineList(parts.map(p => {
    const m = /^\s*([A-Za-z_]\w*) is (any root of .*)$/.exec(p);
    const r = m ? rootNodes(m[2]) : null;
    return r ? [mathOf(m[1], null, { jets: false }), ' is ', r] : rich(p);
  }), '; ');
}
function genericValue(v) {
  if (!has(v)) return null;
  if (typeof v === 'string') return rich(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every(x => typeof x !== 'object')) return v.map(text).join(', ');
  return el('code', { class: 'sympy' }, JSON.stringify(v));
}
function certLabel(cert) {
  const s = text(cert && cert.status).toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'ok') return 'certificate';
  return null;
}
/** name = value pairs of a change of variables, typeset where possible */
function mapList(map, opts = {}) {
  const entries = isObj(map) ? Object.entries(map).filter(([, v]) => has(v)) : [];
  if (!entries.length) return null;
  return ulist(entries.map(([k, val]) => {
    const v = text(val);
    if (opts.plain && opts.plain.includes(k)) return [el('span', { class: 'k' }, k + ': '), v];
    return sympyToLatex(v, { jets: false }) !== null
      ? [mathOf(text(k), null, { jets: false }), ' = ', mathOf(v, null, { jets: false })]
      : [mathOf(text(k), null, { jets: false }), ': ', el('code', { class: 'sympy' }, v)];
  }));
}
/** a note of the engine may end with "(change of variables: {…})", a JSON object: it is typeset, or dropped when empty */
function noteNodes(note) {
  const t = text(note);
  const m = /^([\s\S]*?)\s*\(change of variables: (\{[\s\S]*\})\)\s*$/.exec(t);
  if (!m) return rich(t);
  let map;
  try { map = JSON.parse(m[2]); } catch (e) { return rich(t); }
  const entries = isObj(map) ? Object.entries(map).filter(([, v]) => has(v)) : [];
  if (!entries.length) return rich(m[1]);
  return [rich(m[1]), ' (change of variables: ', inlineList(entries.map(([k, v]) => el('span', null,
    mathOf(text(k), null, { jets: false }), ' = ',
    sympyToLatex(text(v), { jets: false }) !== null ? mathOf(text(v), null, { jets: false }) : el('code', { class: 'sympy' }, text(v))))), ')'];
}
/** the result of the second, independent substitution check (done by code outside the engine) as a small mark */
function independentMark(v) {
  const t = text(v).toLowerCase().trim();
  const ok = t === 'pass' || t === 'pass (numeric)';
  const msg = t === 'pass (numeric)' ? 'independent check: zero to 30 digits at random points of the parameter locus' : 'independent check: ' + t;
  return el('span', { class: 'ic' + (ok ? ' ic-pass' : ''), title: 'A second substitution check, done by different code outside the engine (see the method page)' }, msg);
}
function independentLine(ic) {
  if (!has(ic)) return null;
  const o = isObj(ic) ? ic : { status: text(ic) };
  const bits = [];
  if (has(o.status)) bits.push(text(o.status));
  if (isObj(o.counts)) { const c = Object.entries(o.counts).filter(([, n]) => has(n)).map(([k, n]) => `${k}: ${text(n)}`); if (c.length) bits.push(c.join(', ')); }
  const removed = Array.isArray(o.removed) ? o.removed.length : (has(o.removed) ? Number(o.removed) : 0);
  if (removed > 0) bits.push(`${plural(removed, 'candidate')} removed from the list by this check`);
  const extra = Object.entries(o).filter(([k, v]) => !['status', 'counts', 'removed'].includes(k) && has(v) && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${text(v)}`);
  return el('p', { class: 'small muted independent' }, 'Independent check of this list (a second substitution, by different code): ', bits.concat(extra).join('; ') || 'recorded', '. ',
    el('a', { href: 'method.html#independent' }, 'What this means'), '.');
}

/** a collapsed block whose raw content is produced when it is first opened */
function lazyRaw(summaryNodes, makeText, attrs) {
  const d = el('details', attrs || null, el('summary', null, summaryNodes));
  let filled = false;
  d.addEventListener('toggle', () => {
    if (!d.open || filled) return;
    filled = true;
    let str = '';
    try { str = makeText(); } catch (e) { str = String(e); }
    d.append(el('pre', { class: 'raw' }, str.length > 200000 ? str.slice(0, 200000) + '\n… (' + (str.length - 200000) + ' more characters; the complete data are in the JSON download)' : str));
  });
  return d;
}
/** open the (collapsed) parts that contain an element, then scroll to it */
function reveal(node) {
  for (let a = node.parentElement; a; a = a.parentElement) if (a.tagName === 'DETAILS') a.open = true;
  if (node.tagName === 'DETAILS') node.open = true;
  node.scrollIntoView({ block: 'start' });
}

// ---- (i) the equation --------------------------------------------------------------------------------------
function equationBox(eq, withHint = true) {
  const unknown = has(eq.unknown) ? text(eq.unknown) : 'w';
  let latex = has(eq.latex) ? text(eq.latex) : sympyToLatex(text(eq.sympy), { unknown });
  if (latex && !/=|\\neq|\\equiv/.test(latex)) latex += ' = 0';
  return formulaBox({ latex, sympy: has(eq.sympy) ? text(eq.sympy) : null, unknown,
    hint: withHint && has(eq.sympy) ? 'SymPy text: E, with the jets w0, w1, … of the unknown; the equation is E = 0' : '' });
}
function equationFacts(eq) {
  const unknown = has(eq.unknown) ? text(eq.unknown) : 'w';
  const v = has(eq.var) ? text(eq.var) : 'z';
  return facts([
    ['unknown', has(eq.unknown) || has(eq.var) ? tex(`${unknown}(${v})`) : null],
    ['order', has(eq.order) ? text(eq.order) : null],
    ['degree', has(eq.degree) ? text(eq.degree) : null],
    ['solved for the highest derivative', eq.solved === true ? 'yes' : (eq.solved === false ? 'no' : null)],
    ['parameters', arr(eq.params).length ? symbolList(eq.params) : (Array.isArray(eq.params) ? 'none' : null)],
  ]);
}
function normalFormBlock(nf, unknown) {
  if (!isObj(nf) || !(has(nf.latex) || has(nf.sympy))) return null;
  const d = el('details', { class: 'normal-form' }, el('summary', null, 'Normal form'));
  const body = el('div', { class: 'evidence-body' });
  let latex = has(nf.latex) ? text(nf.latex) : null;
  if (latex && !/=/.test(latex)) latex += ' = 0';
  body.append(el('p', { class: 'small muted' }, 'The same equation after an affine change of the unknown and of the variable (capital letters: the new ones).'));
  body.append(formulaBox({ latex, sympy: has(nf.sympy) ? text(nf.sympy) : null, unknown }));
  const known = ['latex', 'sympy', 'map', 'conditions', 'conditions_latex', 'steps', 'convention', 'family'];
  const extra = Object.entries(nf).filter(([k, v]) => !known.includes(k) && has(v));
  const mf = facts([
    ['change of variables', mapList(nf.map)],
    ['valid when', arr(nf.conditions).length ? inlineList(condList(nf.conditions, nf.conditions_latex)) : null],
    ['steps', arr(nf.steps).length ? el('ol', null, arr(nf.steps).map(s => el('li', null, rich(s)))) : (has(nf.steps) ? rich(nf.steps) : null)],
    ['convention', has(nf.convention) ? el('span', { class: 'small' }, rich(nf.convention)) : null],
    ['family', has(nf.family) ? el('a', { href: 'catalogue.html?id=' + encodeURIComponent(text(nf.family)) }, text(nf.family)) : null],
    ...extra.map(([k, v]) => [k.replace(/_/g, ' '), genericValue(v)]),
  ]);
  if (mf) body.append(mf);
  d.append(body);
  return d;
}
/** one alternative reduction in words: "u = w(z), z = x - c*t; integrated once; order 2" */
function reductionLabel(alt, isFirst) {
  const n = Number(alt.integrated) || 0;
  const bits = [has(alt.ansatz) ? text(alt.ansatz) : 'reduction ' + text(alt.index)];
  bits.push(n === 0 ? 'not integrated' : (n === 1 ? 'integrated once' : `integrated ${n} times`));
  if (has(alt.order)) bits.push('order ' + text(alt.order));
  return bits.join('; ') + (isFirst ? ' (default)' : '');
}
function equationSection(rep, ctx = {}) {
  const eq = isObj(rep.equation) ? rep.equation : {};
  const input = isObj(rep.input) ? rep.input : {};
  const collapsed = ctx.equation === 'collapsed';
  const sec = collapsed
    ? el('details', { class: 'block r-eq', id: 'equation' }, el('summary', null, 'The equation as analysed'))
    : el('section', { class: 'r-eq', 'aria-labelledby': 'h-eq' }, el('h2', { id: 'h-eq' }, 'The equation as understood'));
  const unknown = has(eq.unknown) ? text(eq.unknown) : 'w';
  const isPde = text(input.kind).toLowerCase() === 'pde' || isObj(input.reduction);
  if (has(input.text)) {
    sec.append(el('p', { class: 'small muted' }, isPde ? 'Input (evolution equation): ' : 'Input: ', el('code', { class: 'sympy' }, text(input.text))));
  }
  if (isObj(input.reduction)) {
    const r = input.reduction;
    const bits = [];
    if (has(r.ansatz)) bits.push(el('span', null, 'the ansatz ', el('code', { class: 'sympy' }, text(r.ansatz))));
    if (has(r.integrated)) bits.push(Number(r.integrated) > 0 ? `integrated ${Number(r.integrated) === 1 ? 'once' : text(r.integrated) + ' times'}` : 'not integrated');
    if (arr(r.constants).length) bits.push(el('span', null, plural(arr(r.constants).length, 'constant') + ' of integration ', symbolList(r.constants)));
    const box = el('div', { class: 'reduction' });
    const p = el('p', null, 'Reduction applied: ', inlineList(bits, '; '), '.');
    if (has(r.note) && !/^(not integrated|integrated once)$/.test(text(r.note))) p.append(' ', el('span', { class: 'muted' }, rich(r.note)));
    if (has(r.steps)) p.append(' ', el('span', { class: 'muted' }, rich(r.steps)));
    box.append(p);
    // constants that the reduction set to a value (the answer then covers only the travelling waves with that value),
    // and what the reader of the input changed (a renamed parameter, ...)
    const assumed = arr(r.assumed).filter(a => isObj(a) && has(a.constant));
    const redWarnings = arr(r.warnings).filter(has);
    const rf = facts([
      ['set in this reduction', assumed.length ? ulist(assumed.map(a => [condNode(`${text(a.constant)} == ${has(a.value) ? text(a.value) : '0'}`), has(a.why) ? [' — ', el('span', { class: 'small' }, rich(a.why))] : null]), 'assumed') : null],
      ['read differently', redWarnings.length ? ulist(redWarnings.map(w => rich(w)), 'red-warnings') : null],
      ['constraints', arr(r.constraints).length ? inlineList(condList(r.constraints, r.constraints_latex)) : null],
      ['conditions', arr(r.conditions).length ? inlineList(condList(r.conditions, r.conditions_latex)) : null],
      ['sign convention', has(r.sign_convention) && text(r.sign_convention) !== text(r.ansatz) ? genericValue(r.sign_convention) : null],
      ['chirp', has(r.chirp) ? genericValue(r.chirp) : null],
    ]);
    if (rf) box.append(rf);
    // other reductions of the same input: the analysis is run again with the engine option reduction_index
    const alts = arr(r.alternatives).filter(isObj);
    if (alts.length > 1 && typeof ctx.onReduction === 'function') {
      let current = Number.isInteger(ctx.reductionIndex) ? ctx.reductionIndex : alts.findIndex(x => text(x.ansatz) === text(r.ansatz) && Number(x.integrated) === Number(r.integrated));
      if (current < 0) current = 0;
      const sel = el('select', { id: 'reduction-select' });
      alts.forEach((alt, i) => {
        const idx = has(alt.index) ? Number(alt.index) : i;
        sel.append(el('option', { value: String(idx), selected: idx === current }, reductionLabel(alt, idx === 0)));
      });
      sel.value = String(current);
      sel.addEventListener('change', () => ctx.onReduction(Number(sel.value)));
      box.append(el('p', { class: 'reduction-choice' }, el('label', { for: 'reduction-select' }, 'Reduction used: '), sel));
    }
    sec.append(box);
  }
  if (has(eq.latex) || has(eq.sympy)) sec.append(equationBox(eq));
  else sec.append(el('p', { class: 'muted' }, 'The report contains no equation.'));
  const f = equationFacts(eq);
  if (f) sec.append(f);
  const nf = normalFormBlock(rep.normal_form, unknown);
  if (nf) sec.append(nf);
  return sec;
}

// ---- (ii) verdict ------------------------------------------------------------------------------------------
function levelWords(level) {
  const info = LEVELS[text(level)];
  return info ? info.name : (has(level) ? text(level) : 'no level');
}
/** "u = w^{3}" from the map of a substitution */
function substitutionTitle(map, name) {
  const m = isObj(map) ? map : {};
  if (has(m.u)) {
    const rhs = sympyToLatex(text(m.u).replace(/\*\*\((\d+)\)/g, '**$1'), { jets: false });
    if (rhs !== null) return ['the substitution ', tex('u = ' + rhs)];
    return ['the substitution ', el('code', { class: 'sympy' }, 'u = ' + text(m.u))];
  }
  return has(name) ? `the substitution “${text(name)}”` : 'a substitution';
}
function verdictSection(rep, reg, opts = {}) {
  const v = isObj(rep.verdict) ? rep.verdict : {};
  // the level shown is the overall one (it takes the special parameter loci into account) when the report has it
  const level = has(v.overall) ? text(v.overall) : text(v.level);
  const info = LEVELS[level];
  const scope = has(v.scope) ? text(v.scope) : '';
  const generic = /generic/i.test(scope) || level === 'complete-generic';
  const sec = el('section', { class: 'verdict verdict-' + (info ? level : 'unknown') + (generic ? ' verdict-generic' : '') + (opts.sub ? ' verdict-sub' : ''), 'aria-label': 'Verdict' });
  sec.dataset.level = level;
  const line = el('p', { class: 'verdict-level' }, meter(level),
    info ? el('span', { title: info.long }, info.name) : (has(level) ? level : 'No verdict in this report'));
  // the label of the verdict: the weakest label among the statements it needs
  if (isLabel(v.label)) line.append(' ', badge(v.label));
  if (level === 'complete-generic') {
    // what is known on the special parameter values: all analysed, or how many sets of them are in the list "not decided"
    const openLoci = arr(rep.not_decided).filter(it => isObj(it) && text(it.kind) === 'parameter-locus').length;
    const sm = has(v.special_min) ? text(v.special_min) : '';
    if (sm === 'complete') line.append(el('span', { class: 'scope scope-generic special-note' }, 'special values analysed'));
    else if (sm && sm !== 'not analysed') line.append(el('span', { class: 'scope scope-generic special-note' }, 'special loci: ' + (LEVELS[sm] ? levelWords(sm).toLowerCase() : sm)));
    if (sm !== 'complete' && openLoci > 0) {
      line.append(el('a', { class: 'scope scope-generic special-open to-part', href: `#${opts.idp || ''}list-open`,
        title: 'The special parameter values that were not analysed are items of the list “Not decided”' },
        `${openLoci} ${openLoci === 1 ? 'set' : 'sets'} of special parameter values not analysed`));
    } else if (sm === 'not analysed') line.append(el('span', { class: 'scope scope-generic special-note' }, 'special values not analysed'));
  } else if (scope) line.append(el('span', { class: 'scope' + (generic ? ' scope-generic' : '') }, generic ? 'for generic values of the parameters only' : scope));
  // what the verdict is about, when the equation analysed is a reduction of the equation entered: the sentence
  // `reduction_scope` under the text, or else the short phrase `about` next to the level
  if (has(v.about) && !has(v.reduction_scope)) line.append(el('span', { class: 'scope about' }, 'about ', rich(v.about)));
  sec.append(line);
  if (has(v.text)) sec.append(el('p', { class: 'verdict-text' }, rich(v.text)));
  else if (info) sec.append(el('p', { class: 'verdict-text' }, info.long.charAt(0).toUpperCase() + info.long.slice(1) + '.'));
  if (has(v.reduction_scope)) sec.append(el('p', { class: 'verdict-text reduction-scope' }, rich(v.reduction_scope)));
  if (isObj(v.record) && (has(v.record.text) || has(v.record.id))) {
    // an earlier record of the project that states a complete list: it is reported, it does not raise the level
    sec.append(el('p', { class: 'verdict-note record-line' },
      has(v.record.text) ? rich(v.record.text) : ['An earlier record of the project contains this equation: ', el('span', { class: 'chip' }, text(v.record.id)), '.'],
      isLabel(v.record.label) ? [' ', badge(v.record.label)] : null,
      ' ', el('a', { href: `#${opts.idp || ''}records`, class: 'to-part' }, 'Earlier records')));
  }
  if (arr(v.conditions).length) {
    sec.append(el('p', { class: 'verdict-note' }, generic ? 'Generic means: ' : 'Under the conditions ', inlineList(condList(v.conditions, v.conditions_latex)),
      generic ? '. Other values of the parameters are treated separately where the report says so.' : '.'));
  }
  // what holds on special parameter loci and after a substitution: one row each, with its own level
  const rows = el('ul', { class: 'verdict-rows' });
  const strata = arr(rep.strata).filter(isObj);
  arr(v.special_loci).filter(isObj).forEach(l => {
    const key = arr(l.conditions).map(text).join(' & ');
    const j = strata.findIndex(s => arr(s.conditions).map(text).join(' & ') === key);
    rows.append(el('li', null, meter(l.level), el('span', null,
      el('strong', null, arr(l.conditions).length ? ['When ', inlineList(condList(l.conditions, l.conditions_latex))] : 'On a special locus', ': ', levelWords(l.level).toLowerCase()), '. ',
      // (the case of a particular exponent is shown in full below, open: its sentence is not repeated here)
      has(l.text) && !(j >= 0 && strata[j].exponent_instance === true) ? rich(l.text) : null,
      j >= 0 ? [' ', el('a', { href: `#${opts.idp || ''}stratum-${j + 1}`, class: 'to-part' }, 'The lists for this case')] : null)));
  });
  const as = v.after_substitution;
  if (isObj(as)) {
    rows.append(el('li', null, meter(as.level), el('span', null,
      el('strong', null, 'After ', substitutionTitle(as.map), ': ', levelWords(as.level).toLowerCase()), '. ',
      has(as.text) ? rich(as.text) : null, has(as.found) ? ` (${plural(Number(as.found) || 0, 'solution')} found)` : '',
      arr(rep.substitutions).length ? [' ', el('a', { href: `#${opts.idp || ''}substitution-1`, class: 'to-part' }, 'The lists for this case')] : null)));
  }
  if (rows.children.length) sec.append(rows);
  const extra = [];
  if (has(v.level_before_check)) extra.push(el('span', null, 'Before the independent check of the found list the level was: ', levelWords(v.level_before_check).toLowerCase()));
  if (extra.length) sec.append(el('p', { class: 'verdict-note' }, inlineList(extra, '; ')));
  const basis = arr(v.basis);
  let basisLine = null;
  if (basis.length) {
    // every statement the verdict rests on carries its own label; those that decide the label of the verdict are marked
    const labels = isObj(v.labels) ? v.labels : {};
    const decisive = new Set(arr(v.label_rests_on).map(text));
    const items = basis.flatMap(b => (typeof b === 'string' ? b.split(/\s*;\s+/) : [b])).filter(has).map(b => {
      const id = text(b);
      const r = reg.byId.get(id);
      const lab = has(labels[id]) ? text(labels[id]) : (r && has(r.label) ? text(r.label) : null);
      const chip = basisChip(b, reg.ids);
      if (!isLabel(lab)) return chip;
      return el('span', { class: 'based' + (decisive.has(id) ? ' decisive' : ''), title: LABELS[lab] + (decisive.has(id) ? ' The label of the verdict comes from this statement.' : '') },
        chip, el('span', { class: 'minibadge badge-' + lab }, lab));
    });
    basisLine = el('p', { class: 'verdict-basis' }, 'Rests on: ', items);
  }
  // the technical sentence of the module that decided (when the verdict text is one of the standard sentences): collapsed,
  // together with the statements the verdict rests on
  const detail = has(v.detail) && text(v.detail).trim() !== text(v.text).trim() ? text(v.detail) : null;
  const method = has(v.method) && !text(v.text).includes(text(v.method)) ? text(v.method) : null;
  if (detail || method) {
    const how = el('details', { class: 'how-decided' }, el('summary', null, 'How this was decided'));
    if (method) how.append(el('p', { class: 'small how-method' }, el('span', { class: 'k' }, 'Method: '), rich(method), '.'));
    if (detail) how.append(el('p', { class: 'small how-detail' }, rich(detail)));
    if (basisLine) how.append(basisLine);
    sec.append(how);
  } else if (basisLine) sec.append(basisLine);
  sec.addEventListener('click', ev => {
    const a = ev.target.closest ? ev.target.closest('a.to-part') : null;
    const target = a ? document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))) : null;
    if (target) { ev.preventDefault(); reveal(target); }
  });
  if (opts.sub) return sec;
  // one fixed line under the verdict of a report: what kind of statement this is
  return [sec, el('p', { class: 'scope-line' }, 'This is a statement about solutions that are meromorphic in the whole complex plane. ',
    'Travelling waves with other singularities in the complex plane — for example fronts that exist for a range of speeds, peakons, compactons — are outside its scope.')];
}

// ---- (iii) the three lists ---------------------------------------------------------------------------------
function hypothesisList(hyps) {
  const ul = el('ul', { class: 'hyp' });
  for (const h of arr(hyps)) {
    const o = isObj(h) ? h : { text: text(h) };
    const st = text(o.status).toLowerCase();
    const ok = st === 'verified' || st === 'holds' || st === 'true' || st === 'pass';
    const failed = /fail|false|violated|does not hold/.test(st);
    const label = ok ? 'verified' : (failed ? 'does not hold' : (has(o.status) ? text(o.status) : 'not verified'));
    ul.append(el('li', null,
      el('span', { class: 'hyp-status ' + (ok ? 'ok' : 'no') }, (ok ? '✓ ' : (failed ? '✗ ' : '○ ')) + label),
      el('span', null, rich(has(o.text) ? o.text : (has(o.key) ? o.key : '')),
        has(o.how) ? el('span', { class: 'hyp-how' }, rich(o.how)) : null)));
  }
  return ul.children.length ? ul : null;
}

function certificateBlock(cert, opts = {}) {
  if (!isObj(cert)) return null;
  const known = ['type', 'method', 'status', 'detail', 'hypotheses'];
  const rows = [
    ['kind of check', has(cert.type) ? text(cert.type) : null],
    ['method', has(cert.method) ? text(cert.method) : null],
    ['status', has(cert.status) ? text(cert.status) : null],
    ['what was checked', has(cert.detail) ? rich(cert.detail) : null],
  ];
  for (const [k, val] of Object.entries(cert)) {
    if (known.includes(k) || !has(val)) continue;
    rows.push([k.replace(/_/g, ' '), genericValue(val)]);
  }
  // hypotheses recorded with the certificate (those of the theorem shown above are not repeated)
  const hs = arr(cert.hypotheses).filter(h => isObj(h) ? !(opts.skipTheorem && text(h.theorem) === opts.skipTheorem) : has(h));
  const out = [facts(rows)];
  if (hs.length) {
    out.push(el('h4', null, opts.skipTheorem ? 'Further conditions verified' : 'Conditions verified'),
      hypothesisList(hs.map(h => {
        if (!isObj(h)) return h;
        let t = has(h.text) ? text(h.text) : null;
        if (!t && opts.reg && has(h.theorem)) {
          const r = opts.reg.byId.get(text(h.theorem));
          const rh = r ? arr(r.hypotheses).find(x => isObj(x) && text(x.key) === text(h.key)) : null;
          if (rh && has(rh.text)) t = `${text(rh.text)} (${text(h.theorem)})`;
        }
        return { text: t || [h.theorem, h.key].filter(has).map(text).join(': '), status: h.status, how: h.how };
      })));
  }
  const kept = out.filter(Boolean);
  return kept.length ? kept : null;
}

function theoremBlock(id, rep, reg) {
  const t = arr(rep.theorems).find(x => isObj(x) && text(x.id) === text(id));
  const r = reg.byId.get(text(id));
  const out = [];
  const name = (r && has(r.name)) ? text(r.name) : null;
  out.push(el('h4', null, 'Theorem ', theoremLink(id), name ? ' ' + name : ''));
  const label = (t && t.label) || (r && r.label);
  const statement = r && has(r.statement) ? r.statement : null;
  if (statement) out.push(el('p', null, rich(statement)));
  const concl = (t && has(t.conclusion)) ? t.conclusion : (r && isObj(r.conclusion) ? r.conclusion.text : (r ? r.conclusion : null));
  if (has(concl) && !statement) out.push(el('p', null, el('span', { class: 'k' }, 'Conclusion: '), rich(concl)));
  const src = sourceText((r && r.source) || (t && t.source));
  if (src) out.push(el('p', { class: 'small' }, el('span', { class: 'k' }, 'Source: '), src, label ? [' ', badge(label)] : null));
  if (t) {
    const hl = hypothesisList(t.hypotheses);
    if (hl) out.push(el('h4', null, 'Hypotheses, for this equation'), hl);
    if (t.applies === false) out.push(el('p', { class: 'small' }, 'The engine reports that this theorem does not apply to the equation as a whole.'));
  } else if (r && arr(r.hypotheses).length) {
    out.push(el('h4', null, 'Hypotheses (the report does not record how they were verified)'), hypothesisList(arr(r.hypotheses).map(h => ({ text: isObj(h) ? h.text : h, status: 'not recorded' }))));
  } else if (!r) {
    out.push(el('p', { class: 'small muted' }, 'The report gives no details for this theorem.'));
  }
  return out;
}

function evidence(children, open = false) {
  const kids = children.flat(Infinity).filter(Boolean);
  if (!kids.length) return null;
  const d = el('details', { class: 'evidence' }, el('summary', null, 'Evidence'));
  if (open) d.open = true;
  d.append(el('div', { class: 'evidence-body' }, kids));
  return d;
}

/** what is needed to rerun the exact check of a found item: the equation, the formula, the values to insert */
function checkData(rep, sol) {
  const eq = isObj(rep.equation) ? rep.equation : {};
  const input = isObj(rep.input) ? rep.input : {};
  if (!has(sol.expr)) return null;
  let eqText = null;
  if (text(input.kind).toLowerCase() !== 'pde' && !isObj(input.reduction) && has(input.text)) eqText = text(input.text);
  else if (has(eq.sympy)) eqText = /=/.test(text(eq.sympy)) ? text(eq.sympy) : text(eq.sympy) + ' = 0';
  if (!eqText) return null;
  const where = [];
  for (const c of arr(sol.conditions)) {
    const m = /^\s*([A-Za-z_]\w*)\s*==\s*(.+?)\s*$/.exec(text(c));
    if (m && sympyToLatex(m[2], { jets: false }) !== null) where.push([m[1], m[2]]);
  }
  if (isObj(sol.constants)) {
    for (const [k, val] of Object.entries(sol.constants)) {
      if (has(val) && /^[A-Za-z_]\w*$/.test(k) && !/^free\b/.test(text(val)) && sympyToLatex(text(val), { jets: false }) !== null) where.push([k, text(val)]);
    }
  }
  const q = new URLSearchParams({ eq: eqText, expr: text(sol.expr) });
  if (where.length) q.set('where', where.map(p => `${p[0]} = ${p[1]}`).join('; '));
  let python = null;
  try {
    const e = JSON.stringify(substitute(eqText, where.filter(p => !isObj(sol.constants) || !(p[0] in sol.constants))));
    const x = JSON.stringify(substitute(text(sol.expr), where));
    python = `from mero.parse import parse_ode\nfrom mero.verify import verify_expr\nprint(verify_expr(parse_ode(${e}), ${x}))`;
  } catch { python = null; }
  return { href: 'check.html?' + q.toString(), python };
}

function plotDefaults(sol) {
  const out = {};
  const mod = exprModule();
  if (!mod) return out;
  for (const c of arr(sol.conditions)) {
    const m = /^\s*([A-Za-z_]\w*)\s*==\s*(.+?)\s*$/.exec(text(c));
    if (!m) continue;
    try {
      const val = mod.compile(m[2])({});
      if (Array.isArray(val) && Number.isFinite(val[0]) && Number.isFinite(val[1])) out[m[1]] = Math.abs(val[1]) < 1e-300 ? val[0] : val;
    } catch { /* a condition that is not a number: the visitor sets the value */ }
  }
  return out;
}

function foundItem(sol, i, rep, C, opts = {}) {
  const s = isObj(sol) ? sol : { expr: text(sol) };
  const eq = isObj(rep.equation) ? rep.equation : {};
  const unknown = has(eq.unknown) ? text(eq.unknown) : 'w';
  const v = has(eq.var) ? text(eq.var) : 'z';
  const key = has(s.id) ? text(s.id) : 'F' + (i + 1);
  // two items of a report can carry the same identifier: the element ids stay unique
  const used = C.used || (C.used = new Set());
  let domId = C.idp + 'found-' + safeId(key);
  if (used.has(domId)) { let k = 2; while (used.has(`${domId}-${k}`)) k++; domId = `${domId}-${k}`; }
  used.add(domId);
  const art = el('article', { class: 'item item-found', id: domId });
  const head = el('div', { class: 'item-head' }, el('span', { class: 'item-key' }, key));
  if (has(s.kind)) head.append(el('span', { class: 'item-kind' }, KIND_NAMES[text(s.kind)] || text(s.kind)));
  if (has(s.d)) head.append(el('span', { class: 'chip', title: 'transcendence degree of the field generated by the solution and its derivatives' }, tex(`d = ${text(s.d)}`)));
  const label = has(s.label) ? text(s.label) : certLabel(s.certificate);
  const cs = splitConditions(s);
  // (inside a group of solutions with the same conditions the heading of the group says that the values are special)
  if (!opts.inGroup && isSpecialFamily(s)) head.append(el('span', { class: 'chip chip-special', title: 'This family exists only on special values of the parameters: one of its conditions is an equality.' }, 'special parameter values'));
  if (isDirectSearch(s)) head.append(el('span', { class: 'chip chip-search', title: 'Found by a direct search on parameter values that the decision procedure did not analyse; the list there is not claimed to be complete.' }, 'direct search'));
  if (has(s.complex_parameters)) head.append(el('span', { class: 'mark-complex', title: 'There is no such solution for real values of the parameters.' }, text(s.complex_parameters)));
  if (has(s.independent_check)) head.append(independentMark(s.independent_check));
  if (label) head.append(badge(label, { right: true }));
  else {
    const st = isObj(s.certificate) && has(s.certificate.status) ? text(s.certificate.status) : 'not run';
    head.append(el('span', { class: 'badge-wrap' }, statusChip('substitution check: ' + st)));
  }
  art.append(head);
  const hasExpr = has(s.expr);
  let latex = has(s.latex) ? text(s.latex) : null;
  let prefix = '';
  const hasLhs = latex && new RegExp('^\\s*' + unknown.replace(/[^A-Za-z]/g, '') + "\\s*('|\\^|_|\\(|\\\\left\\(|=)").test(latex) && /=/.test(latex);
  if (!hasLhs && !(latex && /^\s*[A-Za-z]\s*:/.test(latex))) prefix = `${unknown}(${v}) = `;
  const withLhs = tx => (new RegExp('^\\s*' + unknown.replace(/[^A-Za-z]/g, '') + "\\s*('|\\^|_|\\(|\\\\left\\(|=)").test(tx) && /=/.test(tx)) || /^\s*[A-Za-z]\s*:/.test(tx) ? '' : `${unknown}(${v}) = `;
  const consts = isObj(s.constants) ? Object.entries(s.constants) : [];
  const constsLatex = isObj(s.constants_latex) ? s.constants_latex : {};
  const constItem = ([k, val]) => {
    if (/^free\b/.test(text(val))) return [mathOf(k, null, { jets: false }), ' ', text(val)];
    const root = rootNodes(val);
    if (root) return [mathOf(k, null, { jets: false }), ' is ', root];
    return [mathOf(k, null, { jets: false }), ' = ', mathOf(text(val), constsLatex[k], { jets: false })];
  };
  const constRow = (list = consts) => (list.length ? (items => (list.every(([, val]) => text(val).length <= 22) ? inlineList(items.map(x => el('span', { style: 'white-space:nowrap' }, x)), ', ') : ulist(items)))(
    list.map(constItem)) : null);
  const display = has(s.display_latex) ? text(s.display_latex) : null;
  // the readable form can be the solver's own formula: then there is nothing to keep below it
  const sameForm = !!display && has(latex) && display.replace(/\s+/g, '') === text(latex).replace(/\s+/g, '');
  if (display) {
    // a readable form is the main formula; the form the solver worked with, and its constants, are kept below it
    art.append(formulaBox({ latex: display, sympy: hasExpr ? text(s.expr) : null, prefix: withLhs(display), jets: false }));
    if (has(s.display_note)) art.append(el('p', { class: 'small muted display-note' }, clauseNodes(s.display_note)));
    // a constant given as "any root of …" belongs to the formula: it is said here, not only in the collapsed solver form
    const shownIn = has(s.display_expr) ? text(s.display_expr) : null;
    const noteText = text(s.display_note);
    const name = k => k.replace(/[^A-Za-z0-9_]/g, '');
    const occurs = k => !shownIn || new RegExp('(^|[^A-Za-z0-9_])' + name(k) + '(?![A-Za-z0-9_])').test(shownIn);
    const where = consts.filter(([k, val]) => {
      if (/^free\b/.test(text(val))) return false;
      if (rootNodes(val)) return !noteText.includes(`${k} is any root of`) && (sameForm || occurs(k));
      // a constant with an explicit value that the readable formula still contains
      return !sameForm && !!shownIn && occurs(k) && !new RegExp('(^|;\\s*)' + name(k) + '\\s*=').test(noteText);
    });
    if (where.length) art.append(el('p', { class: 'small muted where-roots' }, 'where ', inlineList(where.map(constItem), '; '), '.'));
  } else if (has(latex) || hasExpr) {
    // (a solution described in words, from an earlier record, has no copy buttons and no plot)
    art.append(formulaBox({ latex, sympy: hasExpr ? text(s.expr) : null, prefix, jets: false, tools: hasExpr }));
  }
  const rf = isObj(s.real_form) && (has(s.real_form.latex) || has(s.real_form.expr)) ? s.real_form : null;
  if (rf) {
    const b = rf.bounded;
    const how = b === true || /^(yes|true|bounded)$/i.test(text(b)) ? ', bounded' : (b === false || /^(no|false)$/i.test(text(b)) ? ', with poles on the real axis' : (has(b) ? ', ' + text(b) : ''));
    const rtex = has(rf.latex) ? text(rf.latex) : null;
    // (the real form can be the formula shown above: then the line says so and the formula is not repeated)
    const mainTex = display || latex;
    const sameReal = !!rtex && !!mainTex && rtex.replace(/\s+/g, '') === text(mainTex).replace(/\s+/g, '');
    art.append(el('p', { class: 'real-form-h' }, 'Real on the real axis' + how + (sameReal ? ': the formula above' : '')));
    if (!sameReal) art.append(formulaBox({ latex: rtex, sympy: has(rf.expr) ? text(rf.expr) : null, prefix: rtex ? withLhs(rtex) : `${unknown}(${v}) = `, jets: false }));
    if (has(rf.note)) art.append(el('p', { class: 'small muted' }, rich(rf.note)));
  }
  if (has(s.description)) art.append(el('p', { class: 'what' }, rich(s.description)));
  if (display && !sameForm && (has(latex) || hasExpr)) {
    const d = el('details', { class: 'solver-form' }, el('summary', null, 'Form used by the solver'));
    const body = el('div', { class: 'evidence-body' }, formulaBox({ latex, sympy: hasExpr ? text(s.expr) : null, prefix, jets: false }));
    const cf = facts([['constants', constRow()]]);
    if (cf) body.append(cf);
    d.append(body);
    art.append(d);
  }
  const real = isObj(s.real) ? s.real : null;
  const f = facts([
    // inside a group of solutions with the same conditions the conditions are in the heading of the group
    ['holds when', cs.par.length && !opts.inGroup ? ulist(condList(cs.par, cs.parL)) : null],
    // C_I is the value of a first integral: a constant of integration, not a parameter of the equation
    ['level of the first integral', cs.level.length ? [inlineList(condList(cs.level, cs.levelL)), ' ',
      el('span', { class: 'small muted' }, '(', tex('C_I'), ': the value of the first integral, a constant of integration)')] : null],
    // (with a readable form the constants are in the collapsed solver form; the roots are named under the formula)
    ['constants', display && !sameForm ? null : constRow(sameForm ? consts.filter(([, val]) => !rootNodes(val)) : consts)],
    ['free constants', arr(s.free).length ? inlineList(arr(s.free).map(n => /^[A-Za-z_]\w*$/.test(text(n)) ? mathOf(text(n), null, { jets: false }) : text(n))) : null],
    ['poles in a period', has(s.poles_per_period) ? text(s.poles_per_period) + (arr(s.pole_orders).length ? ` (order${arr(s.pole_orders).length > 1 ? 's' : ''} ${arr(s.pole_orders).map(text).join(', ')})` : '') : (arr(s.pole_orders).length ? 'orders ' + arr(s.pole_orders).map(text).join(', ') : null)],
    ['on the real axis', real ? [has(real.bounded_on_real_axis) ? 'bounded: ' + text(real.bounded_on_real_axis) : null, has(real.note) ? (has(real.bounded_on_real_axis) ? '; ' : '') + text(real.note) : null] : null],
    ['closed form in the record', has(s.closed_form_record) ? rich(s.closed_form_record) : (has(s.closed_form_card) ? rich(s.closed_form_card) : null)],
    ['occurs in', arr(s.citations).length ? ulist(arr(s.citations).map(c => rich(c))) : null],
  ]);
  if (f) art.append(f);
  if (has(s.note)) art.append(el('p', { class: 'small muted' }, noteNodes(s.note)));
  const chk = checkData(rep, s);
  art.append(evidence([
    el('h4', null, 'Exact check'),
    certificateBlock(s.certificate) || el('p', { class: 'small muted' }, 'The report records no check for this item.'),
    chk ? el('h4', null, 'To rerun the check') : null,
    chk ? el('p', { class: 'small' }, el('a', { href: chk.href, class: 'rerun' }, 'Substitute this formula into the equation on the check page'),
      chk.python ? ', or run the engine in Python:' : '.') : null,
    chk && chk.python ? el('div', { class: 'snippet' }, el('pre', { class: 'raw' }, chk.python), copyButton('copy', chk.python, 'Copy the Python lines')) : null,
  ]));
  // plot (lazy); the real form is drawn when the report gives one
  const plotSol = rf && has(rf.expr) ? Object.assign({}, s, { expr: text(rf.expr) }) : s;
  if ((hasExpr || plotSol !== s) && text(s.kind) !== 'constant') {
    const d = el('details', { class: 'plot', hidden: true }, el('summary', null, 'Plot on the real axis'));
    const body = el('div', { class: 'plot-body' });
    d.append(body);
    loadPlot().then(mod => { try { if (mod && (!mod.canPlot || mod.canPlot(plotSol, rep))) d.hidden = false; } catch { /* stays hidden */ } });
    let done = false;
    d.addEventListener('toggle', async () => {
      if (!d.open || done) return;
      done = true;
      const mod = await loadPlot();
      if (!mod) { body.append(el('p', { class: 'small muted' }, 'The plotting module is not available in this build.')); return; }
      try { mod.plotSolution(body, plotSol, rep, { defaults: plotDefaults(s) }); }
      catch (e) { body.append(el('p', { class: 'small muted' }, 'This formula cannot be drawn here (' + text(e && e.message) + ').')); }
    });
    art.append(d);
  }
  if (has(s.origin)) art.append(el('p', { class: 'origin' }, 'origin: ' + text(s.origin)));
  return art;
}

function ruledItem(item, i, rep, C) {
  const reg = C.reg;
  const r = isObj(item) ? item : { what: text(item) };
  const basis = isObj(r.basis) ? r.basis : (has(r.basis) ? { theorem: text(r.basis) } : {});
  const art = el('article', { class: 'item item-ruled', id: C.idp + 'ruled-' + (i + 1) });
  const head = el('div', { class: 'item-head' }, el('span', { class: 'item-key' }, 'R' + (i + 1)));
  const isThm = has(basis.theorem) && (isTheoremId(basis.theorem, reg) || arr(rep.theorems).some(x => isObj(x) && text(x.id) === text(basis.theorem)));
  if (has(basis.theorem)) head.append(el('span', null, 'by ', isThm ? theoremLink(basis.theorem) : el('span', { class: 'chip' }, text(basis.theorem))));
  else if (isObj(r.certificate) && has(r.certificate.type)) head.append(el('span', { class: 'muted' }, 'by computation (' + text(r.certificate.type) + ')'));
  let label = has(basis.label) ? text(basis.label) : null;
  if (!label && has(basis.theorem)) {
    const t = arr(rep.theorems).find(x => isObj(x) && text(x.id) === text(basis.theorem)) || reg.byId.get(text(basis.theorem));
    if (t && has(t.label)) label = text(t.label);
  }
  if (label) head.append(badge(label, { right: true }));
  else head.append(el('span', { class: 'badge-wrap' }, statusChip('no label recorded')));
  art.append(head);
  // `what_tex`: the same sentence with its conditions typeset
  art.append(el('p', { class: 'what' }, rich(has(r.what_tex) ? r.what_tex : (has(r.what) ? r.what : '(no description)'))));
  if (arr(r.conditions).length) {
    art.append(el('p', null, el('span', { class: 'k' }, 'For parameters with '), inlineList(condList(r.conditions, r.conditions_latex)), '.'));
  }
  if (has(r.note)) art.append(el('p', { class: 'small muted' }, rich(r.note)));
  // the badge is the label of the item; a statement cited from outside the registry keeps its own label only in this note
  if (has(basis.label_cited) || has(basis.label_note)) {
    art.append(el('p', { class: 'small muted label-note' },
      has(basis.label_cited) ? ['The statement cited is ', el('em', null, text(basis.label_cited)), has(basis.label_note) ? '; ' : '.'] : null,
      has(basis.label_note) ? [rich(basis.label_note), /[.!?]\s*$/.test(text(basis.label_note)) ? '' : '.'] : null));
  }
  const parts = [];
  if (isThm) parts.push(theoremBlock(basis.theorem, rep, reg));
  else if (has(basis.theorem)) parts.push(el('h4', null, 'Basis'), el('p', null, el('code', { class: 'sympy' }, text(basis.theorem)),
    /^record:|^atlas:/.test(text(basis.theorem)) ? ' — a record of the project; its statement is given with the report it comes from.' : ''));
  if (isObj(r.certificate)) {
    const tb = arr(rep.theorems).find(x => isObj(x) && text(x.id) === text(basis.theorem));
    const cb = certificateBlock(r.certificate, { reg, skipTheorem: tb && arr(tb.hypotheses).length ? text(basis.theorem) : null });
    if (cb) parts.push(el('h4', null, 'Computation for this equation'), cb);
  }
  if (!parts.length) parts.push(el('p', { class: 'small muted' }, 'The report records neither a theorem nor a computation for this item.'));
  art.append(evidence(parts));
  return art;
}

// the kinds of open questions the engine names: shown as words in the head of the item, never as a raw key
const OPEN_KINDS = { 'parameter-locus': 'special parameter values', 'entire': 'entire solutions', 'class': 'a class of solutions', 'reduction': 'another reduction' };
function openItem(item, i, C, rep) {
  const r = isObj(item) ? item : { what: text(item) };
  const art = el('article', { class: 'item item-open', id: C.idp + 'open-' + (i + 1) });
  const head = el('div', { class: 'item-head' }, el('span', { class: 'item-key' }, 'N' + (i + 1)));
  const kind = has(r.kind) ? (OPEN_KINDS[text(r.kind)] || text(r.kind).replace(/[-_]/g, ' ')) : (r.degenerate === true ? OPEN_KINDS['parameter-locus'] : null);
  if (kind) head.append(el('span', { class: 'item-kind' }, kind));
  // `what_tex`: the sentence of the item with its conditions typeset; it then says itself which parameter values are
  // meant and that the equation loses order or degree there
  const whatTex = has(r.what_tex) ? text(r.what_tex) : null;
  if (r.degenerate === true && !(whatTex && /lower order or degree/.test(whatTex))) head.append(el('span', { class: 'chip' }, 'the equation loses order or degree there'));
  head.append(badge('not-decided', { right: true }));
  art.append(head);
  art.append(el('p', { class: 'what' }, rich(whatTex || (has(r.what) ? r.what : '(no description)'))));
  if (has(r.why)) art.append(el('p', null, el('span', { class: 'k' }, 'Why it is open: '), rich(r.why)));
  if (has(r.partial)) {
    // the engine points to a field of the report by its key: say where the reader finds it on the page
    const strata = isObj(rep) && arr(rep.strata).some(x => isObj(x) && x.exponent_instance !== true);
    const known = typeof r.partial === 'string'
      ? r.partial.replace(/\s*\(see the field 'strata'\)/g, strata ? ' (see “On special values of the parameters” below)' : '') : r.partial;
    art.append(el('p', null, el('span', { class: 'k' }, 'Known anyway: '), rich(known)));
  }
  // (not repeated when the typeset sentence above already consists of these conditions)
  if (arr(r.conditions).length && !(whatTex && /^parameter values (with|at which)\b/.test(whatTex))) {
    art.append(el('p', null, el('span', { class: 'k' }, 'For parameters with '), inlineList(condList(r.conditions, r.conditions_latex)), '.'));
  }
  const extra = Object.entries(r).filter(([k, val]) => !['what', 'what_tex', 'why', 'partial', 'conditions', 'conditions_latex', 'conditions_factored', 'kind'].includes(k) && has(val)
    && !(val === true && (k === 'degenerate' || k === 'scope_note')));
  if (extra.length) art.append(facts(extra.map(([k, val]) => [k.replace(/_/g, ' '), genericValue(val)])));
  return art;
}

/** a solution that an earlier record describes (not derived by the engine): text and label, not counted as found */
function describedItem(o, i, C) {
  const s = isObj(o) ? o : { description: text(o) };
  const art = el('article', { class: 'item item-described', id: `${C.idp}described-${i + 1}` });
  const head = el('div', { class: 'item-head' }, el('span', { class: 'item-key' }, 'E' + (i + 1)));
  if (has(s.kind)) head.append(el('span', { class: 'item-kind' }, KIND_NAMES[text(s.kind)] || text(s.kind)));
  if (has(s.d)) head.append(el('span', { class: 'chip', title: 'transcendence degree of the field generated by the solution and its derivatives' }, tex(`d = ${text(s.d)}`)));
  head.append(isLabel(s.label) ? badge(s.label, { right: true }) : el('span', { class: 'badge-wrap' }, statusChip(has(s.label) ? text(s.label) : 'no label recorded')));
  art.append(head);
  if (has(s.latex)) art.append(formulaBox({ latex: text(s.latex), jets: false, tools: false }));
  if (has(s.description)) art.append(el('p', { class: 'what' }, rich(s.description)));
  const f = facts([
    ['holds when', arr(s.conditions).length ? inlineList(condList(s.conditions, s.conditions_latex)) : null],
    ['closed form in the record', has(s.closed_form_record) ? rich(s.closed_form_record) : null],
    ['occurs in', arr(s.citations).length ? ulist(arr(s.citations).map(c => rich(c))) : null],
  ]);
  if (f) art.append(f);
  if (has(s.note)) art.append(el('p', { class: 'small muted' }, noteNodes(s.note)));
  if (has(s.origin)) art.append(el('p', { class: 'origin' }, 'origin: ' + text(s.origin)));
  return art;
}

/** the found items grouped by their conditions on the parameters, in the order of first appearance */
function strataOf(found) {
  const groups = [], byKey = new Map();
  found.forEach((sol, index) => {
    const s = isObj(sol) ? sol : {};
    // (the level of a first integral is not a condition on the parameters: it stays with the item)
    const cs = splitConditions(s);
    const conds = cs.par.map(text);
    const key = conds.join(' & ');
    let g = byKey.get(key);
    if (!g) { g = { key, conditions: conds, latex: cs.parL, special: conds.some(c => /==/.test(c)), items: [] }; byKey.set(key, g); groups.push(g); }
    g.items.push({ sol, index, id: has(s.id) ? text(s.id) : 'F' + (index + 1), kind: has(s.kind) ? (KIND_NAMES[text(s.kind)] || text(s.kind)) : 'solution' });
  });
  return groups;
}
function stratumConditions(g) {
  return g.conditions.length ? inlineList(condList(g.conditions, g.latex)) : 'all values of the parameters';
}
/** "elliptic: s4; simply periodic: s5, s6" with links to the items */
function stratumMembers(g, C) {
  const kinds = [];
  for (const it of g.items) { let k = kinds.find(x => x.kind === it.kind); if (!k) { k = { kind: it.kind, items: [] }; kinds.push(k); } k.items.push(it); }
  return inlineList(kinds.map(k => [k.kind + ': ', inlineList(k.items.map(it => el('a', { href: '#' + C.idp + 'found-' + safeId(it.id), class: 'to-item' }, it.id)))]), '; ');
}
/** a table of contents for a long list of solutions: one row for each set of conditions on the parameters */
function foundOverview(groups, C) {
  const table = el('table', { class: 'overview' }, el('caption', null, 'Overview: which solutions hold for which values of the parameters'),
    el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Parameters'), el('th', { scope: 'col' }, 'Solutions'))));
  const tb = el('tbody');
  for (const g of groups) tb.append(el('tr', null, el('td', null, stratumConditions(g)), el('td', null, stratumMembers(g, C))));
  table.append(tb);
  return el('div', { class: 'table-wrap' }, table);
}

/** a found item counts only with a passed exact check, or with an explicit label other than not-decided */
function isConfirmed(sol) {
  if (!isObj(sol)) return false;
  if (has(sol.label)) return text(sol.label) !== 'not-decided';
  return certLabel(sol.certificate) !== null;
}

function listsSection(rep, C) {
  const idp = C.idp;
  const allFound = arr(rep.found), ruled = arr(rep.ruled_out), open = arr(rep.not_decided);
  const found = allFound.filter(isConfirmed), unconfirmed = allFound.filter(s => !isConfirmed(s));
  const frag = document.createDocumentFragment();
  if (isObj(rep.verdict) && text(rep.verdict.level) === 'unsupported' && !allFound.length && !ruled.length && !open.length) {
    // nothing was analysed: no empty lists, a pointer to the syntax instead
    frag.append(el('p', { class: 'small muted' }, 'Nothing was analysed. The engine reads one autonomous polynomial equation in one unknown, for instance ',
      el('code', null, "w''' = 12*w*w' + 1"), ' or ', el('code', null, 'u_t + u*u_x + u_xx + u_xxxx = 0'), '; see the ', el('a', { href: 'method.html#question' }, 'method page'), '.'));
    return frag;
  }
  const H = C.sub ? 'h4' : 'h2';
  frag.append(el('nav', { class: 'tally', 'aria-label': 'The three lists' },
    el('a', { href: `#${idp}list-found` }, el('b', null, String(found.length)), el('span', null, 'found')),
    el('a', { href: `#${idp}list-ruled` }, el('b', null, String(ruled.length)), el('span', null, 'ruled out')),
    el('a', { href: `#${idp}list-open` }, el('b', null, String(open.length)), el('span', null, 'not decided'))));
  const wrap = el('div', { class: 'lists' });
  const mk = (id, cls, title, lead, items, render, emptyText) => {
    const sec = el('section', { class: 'list ' + cls, id: idp + id, 'aria-labelledby': idp + id + '-h' },
      el(H, { id: idp + id + '-h', class: 'list-h' }, title, el('span', { class: 'n' }, String(items.length))),
      el('p', { class: 'lead' }, lead));
    if (!items.length) sec.append(el('p', { class: 'empty' }, emptyText));
    items.forEach((it, i) => {
      try { sec.append(render(it, i)); }
      catch (e) { sec.append(el('article', { class: 'item' }, el('p', { class: 'small muted' }, 'This item could not be displayed: '), el('pre', { class: 'raw' }, JSON.stringify(it, null, 1)))); }
    });
    return sec;
  };
  const groups = strataOf(found);
  const grouped = found.length > 8 && groups.length > 1;
  // families on special parameter values (an equality among their conditions) and the others
  const nSpecial = found.filter(isSpecialFamily).length, nGeneric = found.length - nSpecial;
  const both = nSpecial > 0 && nGeneric > 0;
  const foundSec = mk('list-found', 'list-found', 'Found', 'Solutions meromorphic in the whole plane, in closed form, each with an exact check.',
    grouped ? [] : found, (it, i) => foundItem(it, allFound.indexOf(it), rep, C), 'No solution is listed.');
  if (grouped) {
    foundSec.querySelector('.empty').remove();
    foundSec.querySelector('.list-h .n').textContent = both
      ? `${found.length}: ${nGeneric} for generic values of the parameters, ${nSpecial} on special values`
      : `${found.length}, for ${groups.length} sets of conditions on the parameters`;
    const groupEls = groups.map((g, gi) => {
      const d = el('details', { class: 'stratum' + (g.special ? ' stratum-special' : '') }, el('summary', null,
        el('span', { class: 'stratum-cond' }, g.conditions.length ? ['When ', stratumConditions(g)] : 'For all values of the parameters'),
        g.special ? el('span', { class: 'chip chip-special' }, 'special parameter values') : null,
        el('span', { class: 'n' }, plural(g.items.length, 'solution'))));
      if (both ? (!g.special || found.length <= 12) : (gi < 2 || found.length <= 12)) d.open = true;
      for (const it of g.items) {
        try { d.append(foundItem(it.sol, allFound.indexOf(it.sol), rep, C, { inGroup: true })); }
        catch (e) { d.append(el('article', { class: 'item' }, el('p', { class: 'small muted' }, 'This item could not be displayed: '), el('pre', { class: 'raw' }, JSON.stringify(it.sol, null, 1)))); }
      }
      return d;
    });
    // two arrangements of the same groups: the generic families first and the special ones together in one collapsed
    // part, or all groups in the order of the report
    const body = el('div', { class: 'found-body' });
    const overview = gs => { try { return gs.length > 1 ? foundOverview(gs, C) : null; } catch (e) { console.warn('overview failed', e); return null; } };
    const arrange = mode => {
      body.textContent = '';
      if (mode === 'generic' && both) {
        const gen = groups.filter(g => !g.special), spec = groups.filter(g => g.special);
        const ov = overview(gen);
        if (ov) body.append(ov);
        gen.forEach(g => body.append(groupEls[groups.indexOf(g)]));
        const part = el('details', { class: 'stratum special-families', id: idp + 'special-families' }, el('summary', null,
          el('span', { class: 'stratum-cond' }, 'On special values of the parameters'),
          el('span', { class: 'n' }, `${plural(nSpecial, 'solution')}, for ${plural(spec.length, 'set')} of conditions`)));
        part.append(el('p', { class: 'small muted' }, 'Families that exist only where the parameters satisfy an equality; each set of conditions is a part below.'));
        const ovs = overview(spec);
        if (ovs) part.append(ovs);
        spec.forEach(g => part.append(groupEls[groups.indexOf(g)]));
        body.append(part);
      } else {
        const ov = overview(groups);
        if (ov) body.append(ov);
        groupEls.forEach(d => body.append(d));
      }
      requestAnimationFrame(() => markScrollable(body));
    };
    if (both) {
      const toggle = el('p', { class: 'view-toggle', role: 'group', 'aria-label': 'Order of the list of solutions' }, el('span', { class: 'k' }, 'Show: '));
      const setView = mode => {
        for (const b of toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
        arrange(mode);
      };
      for (const [mode, name] of [['generic', 'generic families first'], ['all', 'all, in the order of the report']]) {
        const b = el('button', { type: 'button', class: 'view-btn', 'data-view': mode, 'aria-pressed': 'false' }, name);
        b.addEventListener('click', () => setView(mode));
        toggle.append(b);
      }
      foundSec.append(toggle, body);
      setView('generic');
    } else {
      foundSec.append(body);
      arrange('all');
    }
  } else if (found.length > 4 && groups.length > 1) {
    try { foundSec.querySelector('.lead').after(foundOverview(groups, C)); } catch (e) { console.warn('overview failed', e); }
  }
  try { const il = independentLine(rep.independent_check); if (il) foundSec.querySelector('.lead').after(il); } catch (e) { console.warn('independent check line failed', e); }
  const dl = rep.degenerate_loci;
  const loci = isObj(dl) ? arr(dl.loci) : arr(dl);
  if (loci.length) {
    // one grey line: where the equation loses order or degree it is another equation, whose solutions are not listed
    foundSec.append(el('p', { class: 'small muted degenerate', title: isObj(dl) && has(dl.note) ? text(dl.note) : '' },
      'Not analysed here: parameter loci on which the equation loses order or degree (', inlineList(loci.map(l => inlineList(text(l).split(/\s*,\s+/).map(c => condNode(c)), ', ')), '; '), ').'));
  }
  // solutions that an earlier record only describes: a short block under the list, not counted
  const described = isObj(rep.atlas) ? arr(rep.atlas.described) : [];
  if (described.length) {
    const box = el('div', { class: 'described', id: idp + 'described' }, el(C.sub ? 'h5' : 'h3', { class: 'sub-h' }, 'Described in earlier records (not derived here)', el('span', { class: 'n' }, String(described.length))),
      el('p', { class: 'small muted' }, 'Solutions that an earlier record of the project describes for this equation. The engine did not derive them and did not check them; each carries the label of its record. They are not counted as found.'));
    described.forEach((it, i) => {
      try { box.append(describedItem(it, i, C)); } catch (e) { box.append(el('pre', { class: 'raw' }, JSON.stringify(it, null, 1))); }
    });
    foundSec.append(box);
  }
  // formulas whose substitution check did not run or did not pass: their own collapsed part under the three lists,
  // never inside "Found", not counted anywhere
  const candidates = arr(rep.candidates);
  let candidatesBlock = null;
  if (unconfirmed.length || candidates.length) {
    const n = unconfirmed.length + candidates.length;
    const d = el('details', { class: 'block unconfirmed-list', id: idp + 'candidates' }, el('summary', null,
      'Candidates (not verified)', el('span', { class: 'n' }, `${n}, not counted`)));
    candidatesBlock = d;
    d.append(el('p', { class: 'small muted' }, 'Formulas of the shape of a solution whose exact substitution check did not run or did not pass. Nothing is claimed about them; they are not in the list “Found” and are not counted anywhere.'));
    const Cc = Object.assign({}, C, { idp: idp + 'cand-' });
    unconfirmed.forEach(it => {
      try { const node = foundItem(it, allFound.indexOf(it), rep, C); node.classList.add('unconfirmed'); d.append(node); }
      catch (e) { d.append(el('pre', { class: 'raw' }, JSON.stringify(it, null, 1))); }
    });
    candidates.forEach((it, i) => {
      try {
        const node = foundItem(it, i, rep, Cc); node.classList.add('unconfirmed');
        if (isObj(it) && has(it.why)) node.querySelector('.item-head').after(el('p', { class: 'small' }, el('span', { class: 'k' }, 'Why the check did not run: '), rich(it.why)));
        d.append(node);
      } catch (e) { d.append(el('pre', { class: 'raw' }, JSON.stringify(it, null, 1))); }
    });
    const empty = foundSec.querySelector('.empty');
    if (empty && !found.length) empty.textContent = 'No solution with a passed check is listed.';
    foundSec.append(el('p', { class: 'small muted candidates-pointer' }, `${plural(n, 'candidate')} without a passed check ${n === 1 ? 'is' : 'are'} kept apart: `,
      el('a', { href: `#${idp}candidates`, class: 'to-item' }, 'Candidates (not verified)'), '.'));
  }
  foundSec.addEventListener('click', ev => {
    const a = ev.target.closest ? ev.target.closest('a.to-item') : null;
    const target = a ? document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))) : null;
    if (target) { ev.preventDefault(); reveal(target); history.replaceState(null, '', a.getAttribute('href')); }
  });
  wrap.append(
    foundSec,
    mk('list-ruled', 'list-ruled', 'Ruled out', 'Kinds of meromorphic solutions that cannot exist, each with its basis.',
      ruled, (it, i) => ruledItem(it, i, rep, C), 'Nothing is ruled out in this report.'),
    mk('list-open', 'list-open', 'Not decided', 'What remains open for this equation, with what is known anyway.',
      open, (it, i) => openItem(it, i, C, rep), 'Nothing is listed as open.'));
  frag.append(wrap);
  if (candidatesBlock) frag.append(candidatesBlock);
  return frag;
}

// ---- sub-reports: special parameter loci, substitutions ------------------------------------------------------------
function hasAnalysis(sub) {
  return isObj(sub.verdict) || Array.isArray(sub.found) || Array.isArray(sub.ruled_out) || Array.isArray(sub.not_decided);
}
/** the body of a sub-report: its equation, verdict, three lists, local analysis */
function subReportBody(sub, C) {
  const body = el('div', { class: 'sub-body' });
  const parts = [
    () => (isObj(sub.equation) && (has(sub.equation.latex) || has(sub.equation.sympy)) ? [el('p', { class: 'k' }, 'The equation in this case'), equationBox(sub.equation, false), equationFacts({ order: sub.equation.order, degree: sub.equation.degree, params: sub.equation.params })] : null),
    () => (isObj(sub.verdict) ? verdictSection(sub, C.reg, { sub: true, idp: C.idp }) : null),
    () => (hasAnalysis(sub) ? listsSection(sub, C) : null),
    () => localSection(sub, C),
  ];
  for (const p of parts) {
    try { const node = p(); if (node) body.append(...[].concat(node).filter(Boolean)); }
    catch (e) { console.warn('sub-report part failed', e); body.append(el('p', { class: 'small muted' }, 'A part of this case could not be displayed.')); }
  }
  requestAnimationFrame(() => markScrollable(body));
  return body;
}
/** a collapsible sub-report whose body is built when it is first opened */
function subReportDetails(id, summaryNodes, sub, C, leadNodes, opts = {}) {
  const d = el('details', { class: 'block sub-report', id }, el('summary', null, summaryNodes));
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    if (leadNodes) d.append(...[].concat(leadNodes).filter(Boolean));
    d.append(subReportBody(sub, C));
  };
  d.addEventListener('toggle', () => { if (d.open) build(); });
  if (opts.open) { build(); d.open = true; }
  return d;
}
function subSummary(title, sub, opts = {}) {
  const v = isObj(sub.verdict) ? sub.verdict : null;
  const out = [el('span', { class: 'sub-title' }, title)];
  if (v) {
    // the level as in the verdict box of the case; of a standard sentence, the part before "Method: …"
    const lvl = has(v.overall) ? v.overall : v.level;
    out.push(el('span', { class: 'sub-verdict' }, meter(lvl), el('strong', null, levelWords(lvl)), has(v.text) && opts.text !== false ? [' — ', rich(text(v.text).split(/\s+Method:\s/)[0])] : null));
  }
  else if (has(sub.status)) out.push(el('span', { class: 'sub-verdict muted' }, text(sub.status)));
  return out;
}

function strataSection(rep, C) {
  const st = arr(rep.strata).filter(isObj);
  if (!st.length) return null;
  // (the element ids count all strata, so that the links of the verdict box find both kinds)
  const isExponent = s => s.exponent_instance === true;
  const expo = st.filter(isExponent), rest = st.filter(s => !isExponent(s));
  const out = [];
  if (expo.length) {
    const sec = el('section', { class: 'sub-reports exponents', id: C.idp + 'exponents', 'aria-labelledby': C.idp + 'h-exponents' },
      el('h2', { id: C.idp + 'h-exponents' }, 'For particular exponents', el('span', { class: 'n' }, plural(expo.length, 'case'))));
    sec.append(el('p', { class: 'small muted' }, 'The equation of this page for particular values of the exponent, each analysed on its own. Each case has its own verdict and its own three lists.'));
    st.forEach((s, i) => {
      if (!isExponent(s)) return;
      const where = arr(s.conditions).length ? ['For ', inlineList(condList(s.conditions, s.conditions_latex))] : 'A particular exponent';
      const id = `${C.idp}stratum-${i + 1}`;
      if (!hasAnalysis(s) && !isObj(s.equation)) {
        sec.append(el('p', { class: 'sub-row', id }, el('strong', null, where), ': ', has(s.status) ? text(s.status) : 'no analysis recorded', has(s.note) ? [' — ', rich(s.note)] : null));
        return;
      }
      const lead = [];
      if (has(s.note)) lead.push(el('p', { class: 'small muted' }, rich(text(s.note).replace(/^(\w)/, c => c.toUpperCase())), /[.!?]\s*$/.test(text(s.note)) ? '' : '.'));
      if (has(s.status) && text(s.status) !== 'analysed') lead.push(el('p', { class: 'small' }, 'Status: ' + text(s.status)));
      // (open from the start: the title is the condition and the level; the sentence is in the verdict box below it)
      sec.append(subReportDetails(id, subSummary(where, s, { text: false }), s, { reg: C.reg, idp: `${C.idp}st${i + 1}-`, sub: true }, lead, { open: true }));
    });
    out.push(sec);
  }
  if (!rest.length) return out;
  const sec = el('section', { class: 'sub-reports', id: C.idp + 'strata', 'aria-labelledby': C.idp + 'h-strata' },
    el('h2', { id: C.idp + 'h-strata' }, 'On special values of the parameters', el('span', { class: 'n' }, plural(rest.length, 'case'))));
  sec.append(el('p', { class: 'small muted' }, 'Where the parameters satisfy one of these conditions the equation changes its character; it was analysed again there. Each case has its own verdict and its own three lists.'));
  st.forEach((s, i) => {
    if (isExponent(s)) return;
    const where = arr(s.conditions).length ? ['On the locus ', inlineList(condList(s.conditions, s.conditions_latex))] : 'A special case';
    const id = `${C.idp}stratum-${i + 1}`;
    const degenerate = /^degenerate/i.test(text(s.status));
    if (degenerate || (!hasAnalysis(s) && !isObj(s.equation))) {
      const extra = degenerate ? [] : Object.entries(s).filter(([k, v]) => !['conditions', 'conditions_latex', 'status', 'substitution'].includes(k) && has(v));
      sec.append(el('p', { class: 'sub-row', id }, el('strong', null, where), ': ', has(s.status) ? text(s.status) : 'no analysis recorded',
        extra.length ? el('span', { class: 'bar-text' }, extra.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ')) : null));
      return;
    }
    const lead = [];
    if (isObj(s.substitution) && Object.keys(s.substitution).length) lead.push(el('p', { class: 'small muted' }, 'Parameters set to: ', el('code', { class: 'sympy' }, Object.entries(s.substitution).map(([k, v]) => `${k} = ${text(v)}`).join(', '))));
    if (has(s.status) && text(s.status) !== 'analysed') lead.push(el('p', { class: 'small' }, 'Status: ' + text(s.status)));
    sec.append(subReportDetails(id, subSummary(where, s), s, { reg: C.reg, idp: `${C.idp}st${i + 1}-`, sub: true }, lead));
  });
  out.push(sec);
  return out;
}

function substitutionsSection(rep, C) {
  const subs = arr(rep.substitutions).filter(isObj);
  if (!subs.length) return null;
  const sec = el('section', { class: 'sub-reports', id: C.idp + 'substitutions', 'aria-labelledby': C.idp + 'h-subst' },
    el('h2', { id: C.idp + 'h-subst' }, 'After a substitution', el('span', { class: 'n' }, plural(subs.length, 'case'))));
  sec.append(el('p', { class: 'small muted' }, 'A solution with a branch point of rational order becomes meromorphic after a power substitution. The equation for the new unknown was analysed in the same way.'));
  subs.forEach((s, i) => {
    const lead = [];
    if (has(s.note)) lead.push(el('p', null, rich(s.note)));
    const ml = mapList(s.map, { plain: ['relation'] });
    if (ml) lead.push(facts([['the substitution', ml], ['valid when', arr(s.conditions).length ? inlineList(condList(s.conditions, s.conditions_latex)) : null]]));
    sec.append(subReportDetails(`${C.idp}substitution-${i + 1}`, subSummary(['After ', substitutionTitle(s.map, s.name)], s), s, { reg: C.reg, idp: `${C.idp}su${i + 1}-`, sub: true }, lead));
  });
  return sec;
}

/** invariant algebraic surfaces G = 0 (dG/dz = L G along solutions) and first integrals G = C, with the analysis of the
    equation of lower order on them */
function surfacesSection(rep, C) {
  const sf = arr(rep.surfaces).filter(isObj);
  if (!sf.length) return null;
  const sec = el('section', { class: 'sub-reports', id: C.idp + 'surfaces', 'aria-labelledby': C.idp + 'h-surf' },
    el('h2', { id: C.idp + 'h-surf' }, 'On invariant surfaces', el('span', { class: 'n' }, plural(sf.length, 'case'))));
  sec.append(el('p', { class: 'small muted' }, 'A polynomial ', tex('G'), ' in ', tex("w, w', \\dots"), ' with ', tex("G' = L\\,G"),
    ' along the solutions: a solution that satisfies ', tex('G = 0'), ' at one point satisfies it everywhere, and there it solves an equation of lower order. If ',
    tex('L = 0'), ', ', tex('G'), ' is a first integral. The solutions found in this way are also in the list “Found”.'));
  sf.forEach((s, i) => {
    const G = has(s.latex) ? text(s.latex) : (sympyToLatex(text(s.G)) || null);
    const L = has(s.cofactor_latex) ? text(s.cofactor_latex) : (has(s.cofactor) ? sympyToLatex(text(s.cofactor)) : null);
    // G can be a long polynomial: the formula scrolls inside the title
    const Gnode = G ? el('span', { class: 'math-scroll' }, tex(`${G} = ${s.first_integral === true ? 'C' : '0'}`)) : el('code', { class: 'sympy' }, text(s.G) + (s.first_integral === true ? ' = C' : ' = 0'));
    const title = s.first_integral === true ? ['On the levels of the first integral ', Gnode]
      : ['On the invariant surface ', Gnode, L ? [' (cofactor ', el('span', { class: 'math-scroll' }, tex(L)), ')'] : (has(s.cofactor) ? ` (cofactor ${text(s.cofactor)})` : '')];
    const id = `${C.idp}surface-${i + 1}`;
    const sub = Object.assign({}, s, { equation: isObj(s.reduced) ? s.reduced : s.equation });
    if (!hasAnalysis(sub)) {
      sec.append(el('p', { class: 'sub-row', id }, el('strong', null, title), ': ', has(s.status) ? text(s.status) : 'no analysis recorded'));
      return;
    }
    const lead = [];
    if (arr(s.conditions).length) lead.push(el('p', { class: 'small' }, 'Holds when ', inlineList(condList(s.conditions, s.conditions_latex)), '.'));
    if (has(s.status) && !/^(ok|analysed)$/i.test(text(s.status))) lead.push(el('p', { class: 'small' }, 'Status: ' + text(s.status)));
    sec.append(subReportDetails(id, subSummary(title, sub), sub, { reg: C.reg, idp: `${C.idp}sf${i + 1}-`, sub: true }, lead));
  });
  return sec;
}

function twistsSection(rep, C) {
  const tw = arr(rep.twists).filter(isObj);
  if (!tw.length) return null;
  const d = el('details', { class: 'block', id: C.idp + 'twists' }, el('summary', null, 'Change of variable', el('span', { class: 'n' }, String(tw.length))));
  d.append(el('p', { class: 'small muted' }, 'An exponential change of the variable that turns the equation into an autonomous equation of pure-power type. The solutions it produced are in the list “Found”.'));
  for (const t of tw) {
    const art = el('article', { class: 'item' });
    if (has(t.note)) art.append(el('p', { class: 'what' }, rich(t.note)));
    const target = isObj(t.target) ? t.target : null;
    const tv = isObj(t.target_verdict) ? t.target_verdict : null;
    const known = ['map', 'conditions', 'conditions_latex', 'note', 'solutions', 'target', 'target_verdict'];
    const extra = Object.entries(t).filter(([k, v]) => !known.includes(k) && has(v));
    const f = facts([
      ['the change', mapList(t.map, { plain: ['relation'] })],
      ['valid when', arr(t.conditions).length ? inlineList(condList(t.conditions, t.conditions_latex)) : null],
      ['solutions obtained', has(t.solutions) ? text(t.solutions) : null],
      ['the equation obtained', target && (has(target.latex) || has(target.sympy)) ? mathOf(target.sympy, target.latex, { unknown: has(target.unknown) ? text(target.unknown) : 'w' }) : null],
      ['its verdict', tv ? [meter(tv.level), el('strong', null, levelWords(tv.level)), has(tv.text) ? [' — ', rich(tv.text)] : null] : null],
      ...extra.map(([k, v]) => [k.replace(/_/g, ' '), genericValue(v)]),
    ]);
    if (f) art.append(f);
    d.append(art);
  }
  return d;
}

// ---- (iv) d: which values occur, directly under the verdict ---------------------------------------------------
function dSection(rep, reg) {
  const ds = rep.d_summary;
  if (!isObj(ds) || !Object.keys(ds).length) return null;
  const sec = el('section', { class: 'dsec', 'aria-label': 'Which values of d occur' });
  sec.append(el('p', { class: 'small muted dcap' }, 'Which ', tex('d'), ' occur — ', tex('d'), ' is the transcendence degree over ', tex('\\mathbb{C}'),
    ' of the field generated by a solution and its derivatives (', el('a', { href: 'method.html#d' }, 'definition'), ').'));
  const row = el('div', { class: 'dsum compact' });
  const verdictBasis = isObj(rep.verdict) ? arr(rep.verdict.basis).flatMap(b => text(b).split(/\s*[,;]\s+/)).filter(has) : [];
  const names = { '0': ['d = 0', 'constants'], '1': ['d = 1', 'rational, simply periodic, elliptic'], '2': ['d = 2', ''], '3+': ['d \\geq 3', ''] };
  const keys = ['0', '1', '2', '3+'].concat(Object.keys(ds).filter(k => !['0', '1', '2', '3+'].includes(k)));
  for (const k of keys) {
    let o = isObj(ds[k]) ? ds[k] : (has(ds[k]) ? { status: text(ds[k]) } : null);
    if (k === '0' && !o) {
      // not in the report: what the list itself shows
      const n = arr(rep.found).filter(s => isObj(s) && isConfirmed(s) && (text(s.d) === '0' || (!has(s.d) && text(s.kind) === 'constant'))).length;
      o = { status: n ? 'found' : 'none listed', count: n };
    }
    const nm = names[k] || ['d = ' + k, ''];
    const cell = el('div', { 'data-d': k }, el('span', { class: 'dk' }, tex(nm[0])), nm[1] ? el('span', { class: 'dn' }, nm[1]) : null);
    if (!o) cell.append(el('span', { class: 'ds muted' }, 'no information'));
    else {
      cell.append(el('span', { class: 'ds' }, has(o.status) ? text(o.status) : 'no information',
        has(o.count) && Number(o.count) > 0 ? ` (${text(o.count)} listed)` : ''));
      if (has(o.basis)) {
        // the same basis as the verdict is not repeated in every cell
        const items = arr(o.basis).flatMap(b => text(b).split(/\s*[,;]\s+/)).filter(has);
        const same = items.length > 2 && items.join('|') === verdictBasis.join('|');
        cell.append(el('span', { class: 'db' }, 'basis: ', same ? 'as for the verdict' : inlineList(items.map(b => basisChip(b, reg.ids)), ' ')));
      }
      if (has(o.note)) cell.append(el('span', { class: 'db' }, rich(o.note)));
    }
    row.append(cell);
  }
  sec.append(row);
  return sec;
}

// ---- (v) local analysis ------------------------------------------------------------------------------------
function localSection(rep, C) {
  const loc = rep.local;
  if (!isObj(loc)) return null;
  const bal = arr(loc.balances).filter(isObj);
  const d = el('details', { class: 'block', id: C.idp + 'local' },
    el('summary', null, 'Local analysis', el('span', { class: 'n' }, bal.length ? plural(bal.length, 'balance') : 'no pole balance')));
  const body = el('div');
  body.append(el('p', { class: 'small muted' }, 'At a pole of order ', tex('p'), ' the solution is ',
    tex('w = \\sum_{k \\ge 0} c_k (z - z_0)^{k-p}'), ', ', tex('c_0 = a_0 \\neq 0'),
    '. A positive integer Fuchs index gives a compatibility condition and, if it holds, a free coefficient.'));
  if (bal.length) {
    const table = el('table', { class: 'local' });
    table.append(el('thead', null, el('tr', null,
      el('th', { scope: 'col' }, 'Pole order ', tex('p')),
      el('th', { scope: 'col' }, 'Leading coefficient ', tex('a_0')),
      el('th', { scope: 'col' }, 'Fuchs indices'),
      el('th', { scope: 'col' }, 'Compatibility conditions'),
      el('th', { scope: 'col' }, 'Laurent series'))));
    const tb = el('tbody');
    bal.forEach(b => {
      const idx = arr(b.indices), idxL = arr(b.indices_latex);
      const conds = isObj(b.conditions) ? b.conditions : {};
      const condsL = isObj(b.conditions_latex) ? b.conditions_latex : {};
      const free = isObj(b.free) ? b.free : {};
      const pos = arr(b.positive_integer_indices).map(text);
      const ks = Array.from(new Set(pos.concat(Object.keys(conds)))).sort((a, c) => Number(a) - Number(c));
      const condCell = ks.length ? ulist(ks.map(k => {
        const c = conds[k];
        const zero = has(c) && text(c).trim() === '0';
        const out = [tex('k = ' + k), ': '];
        if (!has(c)) out.push('no condition recorded');
        else if (zero) out.push('holds identically');
        else out.push(mathOf(text(c), condsL[k], { jets: false }), ' ', tex('= 0'));
        if (has(free[k])) out.push(zero ? '; ' : '; then ', mathOf(text(free[k]), null, { jets: false }), ' is free');
        return out;
      })) : el('span', { class: 'muted' }, 'none (no positive integer index)');
      const a0cell = [mathOf(text(b.a0), b.a0_latex, { jets: false })];
      if (has(b.a0_minpoly)) a0cell.push(el('span', { class: 'small muted' }, ' root of ', mathOf(text(b.a0_minpoly), b.a0_minpoly_latex, { jets: false })));
      tb.append(el('tr', null,
        el('td', null, has(b.p) ? text(b.p) : ''),
        el('td', null, a0cell),
        el('td', null, idx.length ? inlineList(idx.map((s, i) => mathOf(text(s), idxL[i], { jets: false }))) : ''),
        el('td', null, condCell),
        el('td', null, has(b.series_count) ? text(b.series_count) : '')));
    });
    table.append(tb);
    body.append(el('div', { class: 'table-wrap' }, table));
    const shown = ['p', 'a0', 'a0_latex', 'a0_minpoly', 'a0_minpoly_latex', 'weight', 'dominant', 'dominant_latex', 'indicial', 'indicial_latex', 'indices', 'indices_latex', 'positive_integer_indices', 'coeffs', 'coeffs_latex', 'free', 'conditions', 'conditions_latex', 'series_count'];
    bal.forEach(b => {
      const a0tex = has(b.a0_latex) ? text(b.a0_latex) : sympyToLatex(text(b.a0), { jets: false });
      const dd = el('details', null, el('summary', null, 'Balance ', tex('p = ' + text(b.p)),
        a0tex && a0tex.length <= 60 ? [', ', tex('a_0 = ' + a0tex)] : null, ': dominant part, indicial polynomial, coefficients'));
      const inner = el('div', { class: 'evidence-body' });
      // built when the balance is opened: the coefficients can be long
      let built = false;
      dd.addEventListener('toggle', () => {
        if (!dd.open || built) return;
        built = true;
        const dom = arr(b.dominant), domL = arr(b.dominant_latex);
        const coeffs = arr(b.coeffs), coeffsL = arr(b.coeffs_latex);
        const f = facts([
          ['weight', has(b.weight) ? text(b.weight) : null],
          ['dominant terms', dom.length ? inlineList(dom.map((s, i) => mathOf(text(s), domL[i], {}))) : null],
          ['indicial polynomial', has(b.indicial) || has(b.indicial_latex) ? mathOf(text(b.indicial), b.indicial_latex, { jets: false }) : null],
        ]);
        if (f) inner.append(f);
        if (coeffs.length) {
          inner.append(el('h4', null, 'First coefficients'));
          coeffs.forEach((c, k) => {
            const src = has(coeffsL[k]) ? text(coeffsL[k]) : null;
            if (text(c) === '...' || text(c) === '…') { inner.append(el('p', { class: 'small muted' }, '…')); return; }
            inner.append(formulaBox({ latex: src, sympy: text(c), prefix: `c_{${k}} = `, jets: false }));
          });
        }
        const extra = Object.entries(b).filter(([k, val]) => !shown.includes(k) && has(val));
        if (extra.length) inner.append(lazyRaw('Further data of this balance', () => JSON.stringify(Object.fromEntries(extra), null, 1)));
        requestAnimationFrame(() => markScrollable(inner));
      });
      dd.append(inner);
      body.append(dd);
    });
  } else {
    body.append(el('p', null, 'No balance with an integer pole order is recorded.'));
  }
  const nib = arr(loc.non_integer_balances);
  const strata = arr(loc.strata).filter(isObj);
  const f = facts([
    ['finiteness property', loc.finiteness === true ? 'holds: only finitely many Laurent series with a pole at a given point satisfy the equation'
      : (loc.finiteness === false ? 'does not hold: a family of Laurent series exists at a pole' : (has(loc.finiteness) ? text(loc.finiteness) : null))],
    ['poles', loc.no_pole_possible === true ? 'no pole is possible: every meromorphic solution is entire' : null],
    ['non-integer balances', nib.length ? ulist(nib.map(n => isObj(n) ? [tex('p = ' + text(n.p).replace(/^(\d+)\/(\d+)$/, '\\tfrac{$1}{$2}')), has(n.note) ? ' — ' + text(n.note) : ''] : text(n))) : null],
    ['notes', arr(loc.notes).length ? ulist(arr(loc.notes).map(n => rich(text(n)))) : null],
  ]);
  if (f) body.append(f);
  if (strata.length) {
    const t = el('table', null, el('caption', null, 'Parameter conditions that change the local answer'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Conditions'), el('th', { scope: 'col' }, 'Laurent series'))));
    const tb = el('tbody');
    strata.forEach(s => tb.append(el('tr', null,
      el('td', null, arr(s.conditions).length ? inlineList(condList(s.conditions, s.conditions_latex)) : 'generic parameters'),
      el('td', null, has(s.series_count) ? text(s.series_count) : (has(s.note) ? text(s.note) : '')))));
    t.append(tb);
    body.append(el('div', { class: 'table-wrap' }, t));
  }
  d.append(body);
  return d;
}

// ---- candidates rejected by the check -------------------------------------------------------------------------------
function rejectedSection(rep, C) {
  const rej = arr(rep.rejected);
  if (!rej.length) return null;
  const d = el('details', { class: 'block', id: C.idp + 'rejected' }, el('summary', null, 'Candidates rejected by the substitution check', el('span', { class: 'n' }, String(rej.length))));
  d.append(el('p', { class: 'small muted' }, 'Formulas that a search or an earlier record proposed and that did not pass the exact substitution check. They are not solutions of this equation as written; they are kept here as a record of what was tried.'));
  rej.forEach(r => {
    const o = isObj(r) ? r : { expr: text(r) };
    const art = el('article', { class: 'item' });
    if (has(o.expr) || has(o.latex)) art.append(formulaBox({ latex: has(o.latex) ? text(o.latex) : null, sympy: has(o.expr) ? text(o.expr) : null, jets: false }));
    const extra = Object.entries(o).filter(([k, v]) => !['expr', 'latex', 'why', 'origin'].includes(k) && has(v));
    const f = facts([
      ['why', has(o.why) ? rich(o.why) : null],
      ...extra.map(([k, v]) => [k.replace(/_/g, ' '), genericValue(v)]),
    ]);
    if (f) art.append(f);
    if (has(o.origin)) art.append(el('p', { class: 'origin' }, 'origin: ' + text(o.origin)));
    d.append(art);
  });
  return d;
}

// ---- (vi) atlas, theorems, details, log ----------------------------------------------------------------------------
/** an earlier record of the project: its id, kind, kind of match, label, statement and the description of its solution */
function atlasMatch(m) {
  const art = el('article', { class: 'item' });
  const head = el('div', { class: 'item-head' }, el('span', { class: 'item-key' }, has(m.id) ? text(m.id) : 'record'));
  if (has(m.kind)) head.append(el('span', { class: 'item-kind' }, text(m.kind)));
  if (has(m.match)) head.append(el('span', { class: 'chip' }, 'match: ' + text(m.match)));
  if (has(m.label)) head.append(isLabel(m.label) ? badge(m.label, { right: true }) : el('span', { class: 'chip' }, text(m.label)));
  art.append(head);
  const sol = parseMaybe(m.solution);
  const description = isObj(sol) ? sol.description : (typeof sol === 'string' ? sol : null);
  if (has(m.statement)) art.append(el('p', { class: 'what' }, rich(text(parseMaybe(m.statement)))));
  if (has(description)) art.append(el('p', null, rich(text(description))));
  return art;
}

function atlasSection(rep) {
  const a = rep.atlas;
  if (!isObj(a)) return null;
  const matches = arr(a.matches).map(parseMaybe).filter(isObj);
  const notes = [a.note, a.summary].filter(x => has(x) && typeof x === 'string');
  if (!matches.length && !notes.length) return null;
  const d = el('details', { class: 'block', id: 'records' },
    el('summary', null, 'Earlier records', el('span', { class: 'n' }, plural(matches.length, 'record'))));
  const body = el('div');
  body.append(el('p', { class: 'small muted' }, 'Earlier records of the project whose equation coincides with this one after an affine change of ',
    tex('w'), ' and ', tex('z'), '. Each record carries its own label.'));
  for (const n of notes) body.append(el('p', { class: 'small' }, rich(n)));
  for (const m of matches) {
    try { body.append(atlasMatch(m)); }
    catch (e) { body.append(el('p', { class: 'small muted' }, 'A record could not be displayed' + (has(m.id) ? ' (' + text(m.id) + ').' : '.'))); }
  }
  const und = arr(a.undecided);
  if (und.length) body.append(el('p', { class: 'small muted' }, plural(und.length, 'record') + ' could not be compared within the time limit.'));
  d.append(body);
  return d;
}

function theoremsSection(rep, reg) {
  const ths = arr(rep.theorems).filter(isObj), classes = arr(rep.classes).filter(isObj);
  if (!ths.length && !classes.length) return null;
  const d = el('details', { class: 'block', id: 'theorems' },
    el('summary', null, 'Theorems consulted', el('span', { class: 'n' }, `${ths.filter(t => t.applies === true).length} of ${ths.length} apply`)));
  const body = el('div');
  for (const t of ths) {
    const art = el('article', { class: 'item' });
    const r = reg.byId.get(text(t.id));
    const head = el('div', { class: 'item-head' }, theoremLink(t.id),
      el('span', { class: 'item-kind' }, r && has(r.name) ? text(r.name) : ''),
      el('span', null, t.applies === true ? 'applies' : (t.applies === false ? 'does not apply' : 'not evaluated')));
    if (has(t.label)) head.append(badge(t.label, { right: true }));
    art.append(head);
    const hl = hypothesisList(t.hypotheses);
    if (hl) art.append(hl);
    if (has(t.conclusion) && t.applies !== false) art.append(el('p', null, el('span', { class: 'k' }, 'Conclusion: '), rich(t.conclusion)));
    const src = sourceText(t.source);
    if (src) art.append(el('p', { class: 'small' }, el('span', { class: 'k' }, 'Source: '), src));
    body.append(art);
  }
  if (classes.length) {
    const t = el('table', null, el('caption', null, 'Classes of equations tested'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Class'), el('th', { scope: 'col' }, 'Holds'), el('th', { scope: 'col' }, 'Witness'))));
    const tb = el('tbody');
    classes.forEach(c => tb.append(el('tr', null, el('td', null, text(c.id)),
      el('td', null, c.holds === true ? 'yes' : (c.holds === false ? 'no' : text(c.holds))),
      el('td', null, isObj(c.witness) ? Object.entries(c.witness).map(([k, val]) => `${k} = ${text(val)}`).join('; ') : text(c.witness)))));
    t.append(tb);
    body.append(el('div', { class: 'table-wrap' }, t));
  }
  d.append(body);
  return d;
}

/** the normal form in which the search for solutions was made (`w_search.normal_form`) and the special parameter values
    the search treated separately (`w_search.special_loci`): typeset, as a part of the technical section */
function solverNormalForm(ws) {
  const nf = isObj(ws) && isObj(ws.normal_form) ? ws.normal_form : null;
  const loci = isObj(ws) ? arr(ws.special_loci).filter(isObj) : [];
  if (!(nf && (has(nf.reduced_equation) || isObj(nf.map))) && !loci.length) return null;
  const d = el('details', { class: 'detail solver-nf', 'data-key': 'solver_normal_form' }, el('summary', null, 'Normal form used by the solver'));
  const body = el('div', { class: 'evidence-body' });
  const condsOf = c => (Array.isArray(c) ? c : text(c).split(/\s*,\s+/)).filter(has);
  if (nf) {
    const map = isObj(nf.map) ? nf.map : {};
    body.append(el('p', { class: 'small muted' }, 'The search for rational, simply periodic and elliptic solutions was made for an equation with fewer parameters, for an unknown ',
      tex('W(Z)'), '.', has(nf.note) ? [' ', rich(text(nf.note).replace(/^(\w)/, c => c.toUpperCase()).replace(/\(1 parameters /, '(1 parameter ')), '.'] : null));
    if (has(nf.reduced_equation)) {
      let lx = sympyToLatex(text(nf.reduced_equation), { unknown: 'W' });
      if (lx && !/=/.test(lx)) lx += ' = 0';
      body.append(el('p', { class: 'k' }, 'The reduced equation'), formulaBox({ latex: lx, sympy: text(nf.reduced_equation), unknown: 'W' }));
    }
    const syms = isObj(nf.symbols) ? Object.entries(nf.symbols).filter(([, val]) => has(val)) : [];
    if (syms.length) {
      const t = el('table', { class: 'mini symbols' }, el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Symbol'), el('th', { scope: 'col' }, 'In the parameters of the equation'))));
      const tb = el('tbody');
      for (const [k, val] of syms) {
        const lx = sympyToLatex(text(val), { jets: false });
        tb.append(el('tr', null, el('td', null, mathOf(k, null, { jets: false })),
          el('td', null, lx !== null ? el('span', { class: 'math-scroll' }, tex('\\displaystyle ' + lx)) : el('code', { class: 'sympy' }, text(val)))));
      }
      t.append(tb);
      body.append(el('div', { class: 'table-wrap' }, t));
    }
    const greek = [['alpha', '\\alpha'], ['beta', '\\beta'], ['gamma', '\\gamma']].filter(([k]) => has(map[k]));
    if (greek.length || has(map.rule)) {
      body.append(el('p', { class: 'small nf-rule' }, 'Solutions correspond by ', tex('w(z) = \\alpha\\, W(z/\\gamma) + \\beta'),
        greek.length ? [', where ', inlineList(greek.map(([k, name]) => el('span', { class: 'math-scroll' }, (lx => (lx !== null ? tex(`${name} = ${lx}`) : [tex(name + ' = '), el('code', { class: 'sympy' }, text(map[k]))]))(sympyToLatex(text(map[k]), { jets: false })))), ', ')] : null, '.'));
    }
    if (has(map.rho)) {
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*(any root of .*)$/.exec(text(map.rho));
      const r = m ? rootNodes(m[2]) : null;
      body.append(el('p', { class: 'small nf-rho' }, 'Here ', r ? [mathOf(m[1], null, { jets: false }), ' is ', r] : rich(map.rho), '.'));
    }
    const f = facts([
      ['valid when', condsOf(nf.conditions).length ? inlineList(condList(condsOf(nf.conditions), nf.conditions_latex)) : null],
      ['what the correspondence gives', has(nf.statement) ? el('span', { class: 'small' }, rich(nf.statement)) : null],
      ['parameter values not covered', arr(nf.loci_not_covered).length ? inlineList(arr(nf.loci_not_covered).map(c => condNode(c)), '; ') : null],
    ]);
    if (f) body.append(f);
  }
  if (loci.length) {
    const t = el('table', { class: 'mini' }, el('caption', null, 'Special parameter values searched separately'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Parameter values'), el('th', { scope: 'col' }, 'Searches finished'), el('th', { scope: 'col' }, 'Not finished'))));
    const tb = el('tbody');
    for (const l of loci) {
      const where = el('td', null, condsOf(l.conditions).length ? inlineList(condList(condsOf(l.conditions), l.conditions_latex)) : '');
      if (l.degenerate === true) {
        // the equation is another one there: the note of the engine instead of the two lists of searches
        tb.append(el('tr', { class: 'locus-degenerate' }, where, el('td', { colspan: '2' }, has(l.note) ? rich(l.note) : 'the equation loses order or degree there; not searched')));
        continue;
      }
      const under = condsOf(l.under);
      tb.append(el('tr', null, where,
        el('td', null, arr(l.finished).length ? arr(l.finished).map(text).join('; ') : 'none',
          under.length && arr(l.finished).length ? el('span', { class: 'locus-under' }, ' — finished under ', inlineList(condList(under))) : null,
          has(l.note) ? el('span', { class: 'small muted' }, ' ', rich(l.note)) : null),
        el('td', null, arr(l.unfinished).length ? arr(l.unfinished).map(text).join('; ') : 'none')));
    }
    t.append(tb);
    body.append(el('div', { class: 'table-wrap' }, t));
  }
  d.append(body);
  return d;
}

/** engine details (tier, low_order, entire, ends, pole_bound, free_coefficients, w_search, invariants) in one collapsed section */
function detailsSection(rep) {
  const present = DETAIL_KEYS.filter(k => has(rep[k]) && !(isObj(rep[k]) && !Object.keys(rep[k]).length));
  const facts_used = isObj(rep.verdict) ? arr(rep.verdict.facts_used).filter(has) : [];
  let solverNf = null;
  try { solverNf = solverNormalForm(parseMaybe(rep.w_search)); } catch (e) { console.warn('normal form of the solver failed', e); }
  const copies = arr(rep.copies_removed).map(c => (isObj(c) ? c : { why: text(c) })).filter(c => has(c.id) || has(c.why));
  if (!present.length && !facts_used.length && !solverNf && !copies.length) return null;
  const d = el('details', { class: 'block', id: 'computation' }, el('summary', null, 'Details of the computation', el('span', { class: 'n' }, plural(present.length + (facts_used.length ? 1 : 0) + (solverNf ? 1 : 0) + (copies.length ? 1 : 0), 'part'))));
  d.append(el('p', { class: 'small muted' }, 'What each module of the engine returned, as recorded in the report. The three lists and the verdict above are assembled from these data.'));
  if (facts_used.length) {
    d.append(el('details', { class: 'detail', 'data-key': 'facts_used' }, el('summary', null, 'Facts used by the verdict'), ulist(facts_used.map(x => el('span', { class: 'small' }, rich(text(x)))))));
  }
  if (solverNf) d.append(solverNf);
  if (copies.length) {
    const cd = el('details', { class: 'detail copies-removed', 'data-key': 'copies_removed' },
      el('summary', null, `${plural(copies.length, 'repetition')} ${copies.length === 1 ? 'was' : 'were'} removed from the list`));
    cd.append(el('p', { class: 'small muted' }, 'A solution that is another listed solution in a different form is listed once. The reasons given by the engine:'),
      ulist(copies.map(c => [has(c.id) ? [el('code', { class: 'sympy' }, text(c.id)), ': '] : null, has(c.why) ? rich(c.why) : 'no reason recorded']), 'small'));
    d.append(cd);
  }
  for (const k of present) {
    const v = parseMaybe(rep[k]);
    const summary = [DETAIL_NAMES[k] || k];
    const line = isObj(v) && typeof v.text === 'string' && v.text.length < 600 ? v.text : null;
    const block = lazyRaw(summary, () => (typeof v === 'string' ? v : JSON.stringify(v, null, 1)), { class: 'detail', 'data-key': k });
    if (line) block.append(el('p', { class: 'small' }, rich(line)));
    d.append(block);
  }
  return d;
}

function tailSection(rep) {
  const frag = document.createDocumentFragment();
  const log = arr(rep.log);
  if (log.length) {
    frag.append(el('details', { class: 'block', id: 'log' }, el('summary', null, 'Engine log', el('span', { class: 'n' }, plural(log.length, 'step'))),
      el('pre', { class: 'raw' }, log.map(text).join('\n'))));
  }
  const other = Object.entries(rep).filter(([k, v]) => !KNOWN_TOP.has(k) && has(v));
  if (other.length) {
    const d = el('details', { class: 'block', id: 'other' }, el('summary', null, 'Other data in the report', el('span', { class: 'n' }, other.map(([k]) => k).join(', '))));
    // filled when the part is opened: these fields can be large
    let filled = false;
    d.addEventListener('toggle', () => {
      if (!d.open || filled) return;
      filled = true;
      for (const [k, v] of other) {
        const str = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
        d.append(el('h4', null, k), el('pre', { class: 'raw' }, str.length > 200000 ? str.slice(0, 200000) + '\n… (' + (str.length - 200000) + ' more characters; the complete data are in the JSON download)' : str));
      }
    });
    frag.append(d);
  }
  return frag;
}

// ---- the whole report --------------------------------------------------------------------------------------
/**
 * renderReport(report, container, ctx)
 * ctx: { registry: array of registry entries (optional), source: text shown above the result,
 *        permalink: URL string (optional), filename: for the download (optional),
 *        equation: 'collapsed' (the equation section as a collapsed block after the lists; for pages that show
 *                  the equation themselves),
 *        onReduction: function(index) called when the visitor chooses another reduction; reductionIndex: the one in use }
 */
export function renderReport(report, container, ctx = {}) {
  container.textContent = '';
  container.classList.add('result');
  if (!isObj(report)) {
    container.append(el('div', { class: 'notice' }, el('p', null, 'The engine returned no report.')));
    return;
  }
  const regList = arr(ctx.registry).filter(isObj);
  const reg = { byId: new Map(regList.map(r => [text(r.id), r])), ids: new Set(regList.map(r => text(r.id))) };
  const C = { reg, idp: '' };

  const tools = el('div', { class: 'result-tools' });
  const src = [];
  if (has(ctx.source)) src.push(ctx.source);
  if (has(report.engine)) src.push('engine: ' + text(report.engine));
  if (has(report.mode)) src.push((text(report.mode) === 'heavy' ? 'full' : text(report.mode)) + ' mode');
  if (has(report.elapsed_s) && Number(report.elapsed_s) > 0) src.push(Number(report.elapsed_s).toFixed(Number(report.elapsed_s) < 10 ? 1 : 0) + ' s');
  tools.append(el('span', { class: 'source' }, src.join('; ')));
  if (has(ctx.permalink)) tools.append(copyButton('Copy link', ctx.permalink, 'Copy a link to this result'));
  const dl = el('button', { type: 'button', id: 'download-report' }, 'Download report (JSON)');
  dl.addEventListener('click', () => downloadJSON(report, (ctx.filename || 'report') + '.json'));
  tools.append(dl);
  container.append(tools);

  for (const k of ['sample_note', 'note']) {
    if (has(report[k])) container.append(el('div', { class: 'notice plain' }, el('p', null, rich(report[k]))));
  }
  const warnings = arr(report.warnings).filter(has);
  if (warnings.length) {
    container.append(el('div', { class: 'notice', role: 'note' }, el('p', null, el('strong', null, warnings.length === 1 ? 'Warning from the engine: ' : 'Warnings from the engine:'),
      warnings.length === 1 ? rich(warnings[0]) : null), warnings.length > 1 ? ulist(warnings.map(w => rich(w))) : null));
  }
  const parts = [
    () => (ctx.equation === 'collapsed' ? null : equationSection(report, ctx)),
    () => verdictSection(report, reg, { idp: '' }),
    () => dSection(report, reg),
    () => listsSection(report, C),
    () => strataSection(report, C),
    () => substitutionsSection(report, C),
    () => surfacesSection(report, C),
    () => (ctx.equation === 'collapsed' ? equationSection(report, ctx) : null),
    () => localSection(report, C),
    () => rejectedSection(report, C),
    () => twistsSection(report, C),
    () => atlasSection(report),
    () => theoremsSection(report, reg),
    () => detailsSection(report),
    () => tailSection(report),
  ];
  requestAnimationFrame(() => {
    markScrollable(container);
    if (location.hash.length > 1) {
      let target = null;
      try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { target = null; }
      if (target && container.contains(target)) reveal(target);
    }
  });
  for (const p of parts) {
    try { const node = p(); if (node) container.append(...[].concat(node).filter(Boolean)); }
    catch (e) {
      console.warn('report section failed', e);
      container.append(el('div', { class: 'notice' }, el('p', null, 'A part of the report could not be displayed (' + text(e && e.message) + '). The complete data are in the JSON download.')));
    }
  }
}
