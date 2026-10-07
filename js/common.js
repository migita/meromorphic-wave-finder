// Shared helpers: DOM, mathematics (KaTeX), badges, copy buttons, data loading.
// No framework. Every function tolerates missing input.

export const LABELS = {
  'published': 'A statement from a refereed publication; the citation and the statement number are given.',
  'preprint': 'A statement from a public preprint that has not been refereed; the citation and the statement number are given.',
  'agent-proof': 'A proof written by an AI model in this project and read by at least one other; not checked by a person.',
  'certificate': 'An exact computation that anyone can rerun.',
  'search': 'The result of a bounded search; the bound is stated; nothing is claimed beyond it.',
  'not-decided': 'Open for this equation.',
};

export const LEVELS = {
  'complete': { n: 4, name: 'Complete', long: 'every meromorphic solution is listed' },
  'complete-generic': { n: 3.5, name: 'Complete for generic parameters',
    long: 'every meromorphic solution is listed for generic values of the parameters; on special parameter loci the answer can be weaker, and the report says what holds there' },
  'complete-W': { n: 3, name: 'Complete among rational, simply periodic and elliptic solutions',
    short: 'Complete in the class', long: 'every rational, simply periodic or elliptic solution is listed; other meromorphic solutions are not decided' },
  'partial-record': { n: 2.5, name: 'Partial, with a complete list in an earlier record',
    long: 'the level is partial; an earlier record of the project states a complete list, which was not used for the level' },
  'partial': { n: 2, name: 'Partial', long: 'solutions were found; the list is not known to be complete, and the report says what is not decided' },
  'formal': { n: 1, name: 'Local analysis only', long: 'only local data: pole orders, Fuchs indices, compatibility conditions' },
  'unsupported': { n: 0, name: 'Not supported', long: 'the input is outside what the engine reads' },
};
// the levels a verdict can have (verdict.overall, or verdict.level in older reports) ...
export const LEVEL_ORDER = ['complete', 'complete-generic', 'complete-W', 'partial', 'formal', 'unsupported'];
// ... and the keys under which the catalogue and the coverage page count the entries (defined on the method page)
export const COUNT_KEYS = ['complete', 'complete-generic', 'complete-W', 'partial-record', 'partial', 'formal', 'unsupported', 'timeout', 'no-report'];
export const COUNT_NAMES = { 'timeout': 'Time limit reached', 'no-report': 'No report yet' };

// ---- DOM ---------------------------------------------------------------------------------------------------
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}
export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const arr = x => (Array.isArray(x) ? x : (x === null || x === undefined ? [] : [x]));
export const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const has = x => x !== null && x !== undefined && x !== '';
export function text(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  try { return JSON.stringify(x); } catch { return String(x); }
}

// ---- mathematics -------------------------------------------------------------------------------------------
let exprMod = null;
export async function loadExpr() {
  if (exprMod === null) {
    try { exprMod = await import('./expr.js'); } catch (e) { exprMod = false; }
  }
  return exprMod || null;
}
export function exprModule() { return exprMod || null; }

/** KaTeX element for a LaTeX string; raw text if KaTeX is absent or rejects the string. */
export function tex(latex, display = false) {
  const node = document.createElement(display ? 'div' : 'span');
  node.className = 'math';
  const src = text(latex);
  try {
    if (!window.katex) throw new Error('KaTeX not loaded');
    window.katex.render(src, node, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, maxExpand: 2000 });
  } catch (e) {
    node.textContent = src;
    node.classList.add('math-raw');
    node.title = 'shown as text: the formula could not be typeset';
  }
  return node;
}

/** LaTeX for a SymPy-style string, or null when it cannot be converted. */
export function sympyToLatex(s, opts) {
  if (!has(s) || !exprMod || typeof s !== 'string') return null;
  if (s === '...' || s === '…') return '\\dots';
  try { return exprMod.toLatex(s, opts || {}); } catch { return null; }
}

/** Inline mathematics for a SymPy string, preferring a LaTeX string supplied next to it. */
export function mathOf(sympy, latex, opts = {}) {
  const src = has(latex) ? text(latex) : sympyToLatex(sympy, opts);
  let node;
  if (has(src)) {
    node = tex(src, !!opts.display);
    if (node.classList.contains('math-raw') && has(sympy)) node.textContent = text(sympy);
  } else {
    node = el('code', { class: 'sympy', text: text(sympy) });
  }
  if (opts.display) return node;
  return el('span', { class: 'math-scroll' }, node);
}

/** A comma-separated list of names (parameters, constants) typeset as symbols. */
export function symbolList(names) {
  const out = [];
  arr(names).forEach((n, i) => { if (i) out.push(', '); out.push(mathOf(text(n), null, { jets: false })); });
  return out;
}

/** Prose that may contain $…$ (mathematics) and `…` (code). */
export function rich(s) {
  const frag = document.createDocumentFragment();
  const src = text(s);
  const re = /\$([^$\n]+)\$|`([^`\n]+)`/g;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) frag.append(src.slice(last, m.index));
    if (m[1] !== undefined) {
      // a long inline formula does not wrap: it scrolls inside its own box instead of widening the page
      if (m[1].length > 48) frag.append(el('span', { class: 'tex-long' }, tex(m[1])));
      else frag.append(tex(m[1]));
    } else frag.append(el('code', { text: m[2] }));
    last = m.index + m[0].length;
  }
  if (last < src.length) frag.append(src.slice(last));
  return frag;
}

// ---- copy --------------------------------------------------------------------------------------------------
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch { /* fall through */ }
  try {
    const ta = el('textarea', { style: 'position:fixed;left:-99rem;top:0', 'aria-hidden': 'true' });
    ta.value = s; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
export function copyButton(label, value, title) {
  const b = el('button', { type: 'button', class: 'quiet', title: title || ('Copy ' + label), 'data-copy': value }, label);
  b.addEventListener('click', async () => {
    const ok = await copyText(value);
    const old = b.textContent;
    b.textContent = ok ? 'copied' : 'copy failed';
    setTimeout(() => { b.textContent = old; }, 1200);
  });
  return b;
}

/** A formula box: display mathematics that scrolls sideways, with copy buttons for LaTeX and SymPy text. */
export function formulaBox({ latex, sympy, prefix = '', hint = '', jets = true, unknown = 'w', tools: withTools = true }) {
  let src = has(latex) ? text(latex) : sympyToLatex(sympy, { jets, unknown });
  const box = el('div', { class: 'formula' });
  const body = el('div', { class: 'formula-body' });
  if (has(src) && src.length > 6000) {
    // too long to typeset usefully: the text, in a box that scrolls
    body.classList.add('formula-long');
    body.append(el('code', { class: 'sympy math-raw' }, has(sympy) ? text(sympy) : src));
    if (!hint) hint = 'a long formula, shown as text';
  } else if (has(src)) {
    const node = tex(prefix + src, true);
    if (node.classList.contains('math-raw')) node.textContent = has(sympy) ? text(sympy) : src;
    body.append(node);
  } else {
    body.append(el('code', { class: 'sympy math-raw', text: text(sympy) }));
  }
  box.append(body);
  const tools = el('div', { class: 'formula-tools' });
  if (hint) tools.append(el('span', { class: 'hint', text: hint }));
  if (withTools && has(src)) tools.append(copyButton('LaTeX', src, 'Copy the formula as LaTeX'));
  if (withTools && has(sympy)) tools.append(copyButton('SymPy', text(sympy), 'Copy the formula as SymPy text'));
  if (tools.children.length) box.append(tools);
  return box;
}

// ---- badges and meters -------------------------------------------------------------------------------------
let tipCount = 0;
export function badge(label, opts = {}) {
  const name = text(label);
  const known = Object.prototype.hasOwnProperty.call(LABELS, name);
  const id = 'tip' + (++tipCount);
  const wrap = el('span', { class: 'badge-wrap' + (opts.right ? ' right' : '') });
  const b = el('button', {
    type: 'button', class: 'badge ' + (known ? 'badge-' + name : 'badge-other'),
    'aria-describedby': id, 'aria-expanded': 'false',
  }, name);
  const tip = el('span', { class: 'tip', role: 'tooltip', id },
    known ? LABELS[name] : (opts.tip || 'Not one of the labels of the site; see the method page.'));
  wrap.append(b, tip);
  return wrap;
}
export function statusChip(s) { return el('span', { class: 'badge badge-other', text: text(s) }); }

export function meter(level) {
  const info = LEVELS[level];
  const n = info ? info.n : 0;
  const m = el('span', { class: 'meter', role: 'img', 'aria-label': info ? `level ${n} of 4` : 'no level' });
  for (let i = 0; i < 4; i++) m.append(el('i', { class: i + 1 <= n ? 'on' : (i < n ? 'half' : '') }));
  return m;
}
export function levelName(level, short = false) {
  const info = LEVELS[level];
  if (!info) return has(level) ? text(level) : 'no report';
  return short && info.short ? info.short : info.name;
}

/**
 * Boxes that scroll sideways (formulas, tables) must be reachable from the keyboard, but only those that really
 * overflow: a tab stop on every formula would make the page tedious. Called after rendering and when a part opens.
 */
export function markScrollable(root = document) {
  for (const n of root.querySelectorAll('.formula-body, .table-wrap, .math-scroll')) {
    if (n.scrollWidth > n.clientWidth + 1) {
      n.setAttribute('tabindex', '0');
      if (!n.hasAttribute('role')) { n.setAttribute('role', 'group'); n.setAttribute('aria-label', n.classList.contains('table-wrap') ? 'Table; scroll sideways' : 'Formula; scroll sideways'); }
    } else if (n.hasAttribute('tabindex')) {
      n.removeAttribute('tabindex'); n.removeAttribute('role'); n.removeAttribute('aria-label');
    }
  }
}
let scrollWatch = false;
export function watchScrollable() {
  if (scrollWatch) return;
  scrollWatch = true;
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => markScrollable(), 120); };
  document.addEventListener('toggle', later, true);
  window.addEventListener('resize', later);
}

// ---- data --------------------------------------------------------------------------------------------------
export async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.text();
  try { return JSON.parse(body); } catch { throw new Error(`${url}: not JSON`); }
}
export async function fetchJSONor(url, fallback) {
  try { return await fetchJSON(url); } catch { return fallback; }
}
/** "a = 3/5; k = sqrt(2)" -> [[name, value], …]; throws on a malformed piece */
export function parseWhere(s) {
  const out = [];
  for (const piece of text(s).split(/[;\n]+/)) {
    if (!piece.trim()) continue;
    const m = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=+\s*(.+?)\s*$/.exec(piece);
    if (!m) throw new Error(`“${piece.trim()}” is not of the form name = value`);
    out.push([m[1], m[2]]);
  }
  return out;
}
/**
 * Replace whole names by (value) in a formula given as text. Names followed by "(" (functions) are left alone.
 * Values may refer to other names of the list; the replacement is repeated until nothing changes (at most 8 rounds).
 */
export function substitute(src, pairs) {
  if (!pairs.length) return src;
  const map = new Map(pairs);
  const names = pairs.map(p => p[0]).sort((a, b) => b.length - a.length).map(n => n.replace(/[^A-Za-z0-9_]/g, ''));
  const re = new RegExp('(?<![A-Za-z_0-9.])(' + names.join('|') + ')(?![A-Za-z_0-9(])', 'g');
  let out = src;
  for (let round = 0; round < 8; round++) {
    const next = out.replace(re, (m, name) => '(' + map.get(name) + ')');
    if (next === out || next.length > 200000) break;
    out = next;
  }
  return out;
}

export function safeId(s) { return text(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'entry'; }
export function norm(s) { return text(s).replace(/\s+/g, '').replace(/\^/g, '**').toLowerCase(); }

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 1) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- page frame --------------------------------------------------------------------------------------------
export async function initPage() {
  const page = document.body.dataset.page;
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === page) a.setAttribute('aria-current', 'page');
  }
  // badges: tap toggles the explanation; Escape or a tap elsewhere closes it
  document.addEventListener('click', ev => {
    const b = ev.target.closest ? ev.target.closest('.badge-wrap > .badge') : null;
    for (const w of document.querySelectorAll('.badge-wrap.open')) {
      if (!b || w !== b.parentNode) { w.classList.remove('open'); w.firstChild.setAttribute('aria-expanded', 'false'); }
    }
    if (b) {
      const open = b.parentNode.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') for (const w of document.querySelectorAll('.badge-wrap.open')) w.classList.remove('open');
  });
  // static mathematics in the pages: <span data-tex="..."> (the text inside is the fallback)
  for (const n of document.querySelectorAll('[data-tex]')) {
    const t = tex(n.dataset.tex, n.hasAttribute('data-display'));
    if (!t.classList.contains('math-raw')) { n.textContent = ''; n.append(t); }
  }
  await loadExpr();
  watchScrollable();
  requestAnimationFrame(() => markScrollable());
}
