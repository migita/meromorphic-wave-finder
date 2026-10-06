// The catalogue: a searchable, filterable, sortable table of the corpus; a row opens the precomputed report.
import { initPage, el, append, fetchJSONor, text, has, isObj, arr, safeId, meter, levelName, LEVEL_ORDER, LEVELS,
  formulaBox, mathOf, symbolList, rich, sympyToLatex } from './common.js';
import { renderReport } from './render.js';

const $ = id => document.getElementById(id);
let catalogue = [], registry = [];
let sortKey = 'weight', sortDir = -1;

const fieldsOf = e => arr(e.field).map(text).filter(Boolean);
const levelOf = e => (e.has_report && has(e.verdict) ? text(e.verdict) : '');
const levelRank = e => { const i = LEVEL_ORDER.indexOf(levelOf(e)); return i < 0 ? 99 : i; };
const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function noReportText(e) {
  switch (text(e.batch_status)) {
    case 'timeout': return 'time limit reached';
    case 'no-ode': return 'no single equation';
    case 'running': return 'being computed';
    case 'error': return 'the engine failed';
    default: return 'no report yet';
  }
}
function entryUrl(id) { return 'catalogue.html?id=' + encodeURIComponent(text(id)); }

function fillSelect(sel, values, labelOf) {
  for (const v of values) sel.append(el('option', { value: String(v) }, labelOf ? labelOf(v) : String(v)));
}

function filters() {
  return { q: $('f-q').value.trim().toLowerCase(), field: $('f-field').value, order: $('f-order').value,
    degree: $('f-degree').value, level: $('f-level').value, report: $('f-report').checked };
}
function matches(e, f) {
  if (f.report && !e.has_report) return false;
  if (f.field && !fieldsOf(e).includes(f.field)) return false;
  if (f.order && String(e.order) !== f.order) return false;
  if (f.degree && String(e.degree) !== f.degree) return false;
  if (f.level) {
    if (f.level === 'no-report') { if (e.has_report) return false; }
    else if (f.level === 'partial-record') { if (!(levelOf(e) === 'partial' && e.record_complete)) return false; }
    else if (levelOf(e) !== f.level) return false;
  }
  if (f.q) {
    const hay = [e.id, e.name, arr(e.aliases).join(' '), e.pde, e.ode, e.input, fieldsOf(e).join(' ')].map(text).join(' ').toLowerCase();
    if (!f.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function compare(a, b) {
  let x, y;
  switch (sortKey) {
    case 'name': x = text(a.name).toLowerCase(); y = text(b.name).toLowerCase(); break;
    case 'field': x = fieldsOf(a).join(', ').toLowerCase(); y = fieldsOf(b).join(', ').toLowerCase(); break;
    case 'level': x = levelRank(a); y = levelRank(b); break;
    default: x = num(a[sortKey]); y = num(b[sortKey]);
  }
  if (x === null && y === null) return 0;
  if (x === null) return 1;                       // entries without a value go last in both directions
  if (y === null) return -1;
  if (typeof x === 'string') { const c = x.localeCompare(y); if (c) return c * sortDir; }
  else if (x < y) return -sortDir;
  else if (x > y) return sortDir;
  return text(a.name).localeCompare(text(b.name));
}

/** the reduced equation, typeset, as a second line under the name */
function eqLine(e) {
  let latex = has(e.ode_latex) ? text(e.ode_latex) : null;
  if (!latex && has(e.ode) && text(e.ode).length <= 300) { latex = sympyToLatex(text(e.ode)); if (latex) latex += ' = 0'; }
  if (!latex && has(e.pde_latex)) latex = text(e.pde_latex);
  if (!latex) return null;
  if (!/=/.test(latex)) latex += ' = 0';
  if (latex.length > 400) return null;
  return el('span', { class: 'eq' }, mathOf(null, latex, { jets: false }));
}

function draw() {
  const f = filters();
  const rows = catalogue.filter(e => matches(e, f)).sort(compare);
  const tb = $('rows');
  tb.textContent = '';
  for (const e of rows) {
    const cnt = (k, label) => el('td', { class: 'num', 'data-label': label }, e.has_report && has(e[k]) ? text(e[k]) : el('span', { class: 'muted' }, '–'));
    const lvl = levelOf(e);
    tb.append(el('tr', { 'data-id': text(e.id) },
      el('td', { class: 'name' }, el('a', { href: entryUrl(e.id) }, text(e.name || e.id)),
        eqLine(e),
        arr(e.aliases).length ? el('span', { class: 'aka' }, arr(e.aliases).map(text).join(', ')) : null),
      el('td', { class: 'field' }, fieldsOf(e).join(', ')),
      el('td', { class: 'num', 'data-label': 'order' }, has(e.order) ? text(e.order) : el('span', { class: 'muted' }, '–')),
      el('td', { class: 'num', 'data-label': 'degree' }, has(e.degree) ? text(e.degree) : el('span', { class: 'muted' }, '–')),
      el('td', { class: 'lvl' }, e.has_report ? [meter(lvl), el('span', { title: LEVELS[lvl] ? LEVELS[lvl].long : '' }, levelName(lvl, true)),
        lvl === 'partial' && e.record_complete ? el('span', { class: 'aka' }, 'complete list in an earlier record') : null] : el('span', { class: 'muted' }, noReportText(e))),
      cnt('found', 'found'), cnt('ruled_out', 'ruled out'), cnt('not_decided', 'not decided'),
      el('td', { class: 'num', 'data-label': 'weight' }, has(e.weight) ? text(e.weight) : el('span', { class: 'muted' }, '–'))));
  }
  $('count').textContent = `${rows.length} of ${catalogue.length} equations` + (rows.length === 0 ? '. No entry matches these filters.' : '');
  for (const th of document.querySelectorAll('#cat thead th')) {
    if (th.dataset.key === sortKey) th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
  const sel = $('f-sort'), want = `${sortKey}:${sortDir}`;
  if ([...sel.options].some(o => o.value === want)) sel.value = want;
  else { let o = sel.querySelector('option[data-custom]'); if (!o) { o = el('option', { 'data-custom': '1' }); sel.append(o); } o.value = want; o.textContent = `${sortKey.replace(/_/g, ' ')}${sortDir > 0 ? '' : ', descending'}`; sel.value = want; }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && k !== 'report') q.set(k, v);
  if (sortKey !== 'weight' || sortDir !== -1) q.set('sort', `${sortKey}:${sortDir}`);
  if (f.report) q.set('report', '1');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
}

function refList(items, withMethod) {
  const ol = el('ol', { class: 'refs' });
  for (const s of arr(items)) {
    const o = isObj(s) ? s : { cite: text(s) };
    const li = el('li', null, text(o.cite));
    if (has(o.doi)) li.append(' ', el('a', { href: 'https://doi.org/' + encodeURI(text(o.doi)), rel: 'noopener' }, 'doi:' + text(o.doi)));
    else if (has(o.url) && /^https?:\/\//.test(text(o.url))) li.append(' ', el('a', { href: text(o.url), rel: 'noopener' }, 'link'));
    if (withMethod && has(o.method)) li.append(el('span', { class: 'muted' }, ' — method: ' + text(o.method)));
    if (has(o.what)) li.append(el('span', { class: 'muted' }, ' — ' + text(o.what)));
    ol.append(li);
  }
  return ol;
}

/** a collapsed list of references with the number of entries in the summary line */
function refBlock(title, items, withMethod, id) {
  const list = arr(items);
  if (!list.length) return null;
  return el('details', { class: 'block refs', id }, el('summary', null, title, el('span', { class: 'n' }, String(list.length))), refList(list, withMethod));
}

// The page of one entry. Order: title line, the evolution equation, the reduction (ansatz and reduced equation in
// one block), the report (verdict first), then the two bibliographies, collapsed.
async function showEntry(id) {
  $('list-view').hidden = true;
  $('entry-view').hidden = false;
  document.body.dataset.view = 'entry';
  const e = catalogue.find(x => text(x.id) === id);
  const head = $('entry-head'), refs = $('entry-refs');
  head.textContent = ''; refs.textContent = '';
  if (!e) {
    head.append(el('h1', null, 'No such entry'), el('p', null, `The catalogue has no equation with the identifier “${id}”.`));
    document.documentElement.dataset.ready = '1';
    return;
  }
  document.title = `${text(e.name || e.id)} — Catalogue — Meromorphic solutions`;
  head.append(el('h1', null, text(e.name || e.id)));
  const meta = [];
  if (arr(e.aliases).length) meta.push('also: ' + arr(e.aliases).map(text).join(', '));
  if (fieldsOf(e).length) meta.push('field: ' + fieldsOf(e).join(', '));
  if (has(e.weight)) meta.push('weight ' + text(e.weight) + ' of 5');
  if (meta.length) head.append(el('p', { class: 'aka' }, meta.join('; ')));
  if (arr(e.system).length) {
    head.append(el('h2', null, 'The system'), el('pre', { class: 'sympy' }, arr(e.system).map(text).join('\n')));
  }
  if (has(e.pde) || has(e.pde_latex)) {
    head.append(el('h2', null, text(e.kind) === 'system' ? 'The evolution equations' : 'The evolution equation'),
      formulaBox({ latex: has(e.pde_latex) ? text(e.pde_latex) + (/=/.test(text(e.pde_latex)) ? '' : ' = 0') : null, sympy: has(e.pde) ? text(e.pde) : null, jets: false }));
  }
  const red = isObj(e.reduction) ? e.reduction : null;
  if (red || has(e.ode) || has(e.ode_latex)) {
    head.append(el('h2', null, red ? 'The reduction' : (arr(e.system).length ? 'The scalar equation' : 'The equation')));
    const block = el('div', { class: 'reduction-block' });
    if (red) {
      const p = el('p', null);
      // the steps often begin by repeating the ansatz: it is printed once
      let steps = has(red.steps) ? text(red.steps).replace(/\.\s*$/, '') : '';
      if (has(red.ansatz) && steps.startsWith(text(red.ansatz))) steps = steps.slice(text(red.ansatz).length).replace(/^[;,.\s]+/, '');
      if (has(red.ansatz)) append(p, ['Ansatz ', el('code', { class: 'sympy' }, text(red.ansatz)), steps ? '; ' : '. ']);
      if (steps) append(p, [rich(steps), '. ']);
      if (arr(red.constraints).length) append(p, ['Constraints: ', el('code', { class: 'sympy' }, arr(red.constraints).map(text).join('; ')), '.']);
      if (p.childNodes.length) block.append(p);
    }
    const ode = has(e.ode) ? text(e.ode) : (red && has(red.ode) ? text(red.ode) : null);
    let olx = has(e.ode_latex) ? text(e.ode_latex) : null;
    if (olx && !/=/.test(olx)) olx += ' = 0';
    if (ode || olx) block.append(formulaBox({ latex: olx, sympy: ode, hint: ode ? 'SymPy text: E, with the jets w0 = w, w1 = w′, …; the equation is E = 0' : '' }));
    const bits = [];
    if (has(e.order)) bits.push('order ' + text(e.order));
    if (has(e.degree)) bits.push('degree ' + text(e.degree));
    const line = el('p', { class: 'small eq-line' }, bits.join(', '));
    if (arr(e.params).length) append(line, [bits.length ? '; parameters ' : 'parameters ', symbolList(e.params)]);
    if (has(e.param_notes)) append(line, [' (', rich(e.param_notes), ')']);
    if (e.polynomial === false) append(line, ['; not polynomial' + (has(e.substitution) ? ', polynomial after the substitution ' + text(e.substitution) : '')]);
    if (e.autonomous === false) append(line, ['; not autonomous']);
    if (isObj(e.type)) {
      const ty = e.type;
      if (text(ty.status) === 'type' && has(ty.K) && has(ty.p)) {
        append(line, [`; type: order ${text(ty.K)}, pole order ${text(ty.p)}`, has(ty.kind) ? `, ${text(ty.kind).replace('-', ' ')}` : '',
          has(ty.subtype) ? [' (', el('a', { href: 'coverage.html#' + encodeURIComponent(text(ty.subtype)) }, 'what the theorems say for this type'), ')'] : '']);
      } else if (has(ty.status)) append(line, [`; no type (K, p): ${text(ty.status)}`]);
    }
    if (line.childNodes.length) block.append(line);
    head.append(block);
  }
  if (has(e.notes)) head.append(el('p', { class: 'small muted' }, rich(e.notes)));

  const res = $('result'), msg = $('message');
  res.textContent = ''; msg.textContent = '';
  const live = has(e.input) ? e.input : (has(e.ode) ? text(e.ode) + ' = 0' : (has(e.pde) ? e.pde : null));
  const liveLink = live ? el('a', { href: 'index.html?' + new URLSearchParams({ eq: live, engine: 'live' }).toString() }, 'Analyse this equation with the live engine') : null;
  if (e.has_report) {
    const rep = await fetchJSONor(`data/reports/${safeId(e.id)}.json`, null);
    if (isObj(rep)) {
      head.append(el('h2', { id: 'report' }, 'The answer'));
      // the reduced equation is shown just above: in the report it is a collapsed block after the lists
      renderReport(rep, res, { registry, source: 'Precomputed report of the catalogue', permalink: new URL(entryUrl(e.id), document.baseURI).href, filename: 'report-' + safeId(e.id), equation: 'collapsed' });
      window.__lastReport = rep;
    } else {
      msg.append(el('div', { class: 'notice' }, el('p', null, 'The report of this entry could not be loaded. ', liveLink)));
    }
  } else {
    const why = { timeout: 'The analysis of this entry was stopped at its time limit; there is no report.', 'no-ode': 'This entry has no single reduced equation; there is no report.',
      running: 'The report of this entry is being computed.', error: 'The engine failed on this entry; there is no report.' }[text(e.batch_status)] || 'There is no precomputed report for this entry yet.';
    msg.append(el('div', { class: 'notice plain' }, el('p', null, why + ' ', liveLink ? [liveLink, '.'] : null)));
  }
  // the bibliographies come after the answer, collapsed
  const r1 = refBlock('Where the equation occurs', e.sources, false, 'refs-sources');
  const r2 = refBlock('Papers with exact solutions by an ansatz', e.ansatz_papers, true, 'refs-ansatz');
  if (r1) refs.append(r1);
  if (r2) refs.append(r2);
  if (e.has_report && liveLink) refs.append(el('p', { class: 'small' }, liveLink, '.'));
  document.documentElement.dataset.ready = '1';
}

async function main() {
  await initPage();
  [catalogue, registry] = await Promise.all([fetchJSONor('data/catalogue.json', []), fetchJSONor('data/registry.json', [])]);
  catalogue = arr(catalogue).filter(isObj); registry = arr(registry).filter(isObj);
  const q = new URLSearchParams(location.search);
  if (has(q.get('id'))) { await showEntry(q.get('id')); return; }

  const uniq = xs => Array.from(new Set(xs));
  fillSelect($('f-field'), uniq(catalogue.flatMap(fieldsOf)).sort((a, b) => a.localeCompare(b)));
  fillSelect($('f-order'), uniq(catalogue.map(e => num(e.order)).filter(v => v !== null)).sort((a, b) => a - b));
  fillSelect($('f-degree'), uniq(catalogue.map(e => num(e.degree)).filter(v => v !== null)).sort((a, b) => a - b));
  const levelOptions = [];
  for (const l of LEVEL_ORDER) {
    if (!catalogue.some(e => levelOf(e) === l)) continue;
    levelOptions.push(l);
    if (l === 'partial' && catalogue.some(e => levelOf(e) === 'partial' && e.record_complete)) levelOptions.push('partial-record');
  }
  if (catalogue.some(e => !e.has_report)) levelOptions.push('no-report');
  fillSelect($('f-level'), levelOptions,
    l => (l === 'no-report' ? 'no report yet' : (l === 'partial-record' ? 'partial, with a complete list in an earlier record' : levelName(l, true))));
  for (const [k, id] of [['q', 'f-q'], ['field', 'f-field'], ['order', 'f-order'], ['degree', 'f-degree'], ['level', 'f-level']]) {
    const v = q.get(k);
    if (has(v)) { const n = $(id); n.value = v; if (n.value !== v && n.tagName === 'SELECT') n.value = ''; }
  }
  if (q.get('report')) $('f-report').checked = true;
  if (/^[a-z_]+:-?1$/.test(q.get('sort') || '')) { const [k, d] = q.get('sort').split(':'); sortKey = k; sortDir = Number(d); }
  $('f-sort').addEventListener('input', ev => { const [k, d] = ev.target.value.split(':'); sortKey = k; sortDir = Number(d) || 1; });
  $('filters').addEventListener('input', draw);
  $('filters').addEventListener('reset', () => setTimeout(() => { sortKey = 'weight'; sortDir = -1; draw(); }, 0));
  $('filters').addEventListener('submit', ev => ev.preventDefault());
  for (const th of document.querySelectorAll('#cat thead th')) {
    th.querySelector('button').addEventListener('click', () => {
      const k = th.dataset.key;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === 'name' || k === 'field' || k === 'level' || k === 'order' || k === 'degree') ? 1 : -1; }
      draw();
    });
  }
  draw();
  document.documentElement.dataset.ready = '1';
}
main();
