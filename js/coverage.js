// Coverage page, rendered from data/coverage.json (shape: site/README.md, "coverage.json").
import { initPage, el, fetchJSONor, text, has, isObj, arr, LEVELS, COUNT_KEYS, COUNT_NAMES, LABELS, badge, rich, mathOf,
  formulaBox, sympyToLatex, tex, markScrollable } from './common.js';

const $ = id => document.getElementById(id);
// the keys and their names are those of the method page (common.js: LEVELS, COUNT_KEYS, COUNT_NAMES)
const KEYS = COUNT_KEYS;
const nameOf = k => (LEVELS[k] ? LEVELS[k].name : (COUNT_NAMES[k] || text(k)));

function bar(levels, total) {
  const lv = isObj(levels) ? levels : {};
  const sum = total || KEYS.reduce((s, k) => s + (Number(lv[k]) || 0), 0);
  const parts = KEYS.filter(k => Number(lv[k]) > 0);
  const label = parts.map(k => `${lv[k]} ${nameOf(k).toLowerCase()}`).join(', ');
  const b = el('span', { class: 'bar', role: 'img', 'aria-label': label || 'no equations' });
  if (sum > 0) for (const k of parts) b.append(el('i', { class: 'lv-' + k, style: `width:${(100 * lv[k] / sum).toFixed(2)}%`, title: `${lv[k]} ${nameOf(k).toLowerCase()}` }));
  return [b, el('span', { class: 'bar-text' }, label)];
}

function levelTable(rows, firstHead, keyName) {
  const t = el('table');
  t.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, firstHead), el('th', { scope: 'col', class: 'num' }, 'Equations'),
    el('th', { scope: 'col', style: 'min-width:12rem' }, 'Levels of the answers'))));
  const tb = el('tbody');
  for (const r of rows) {
    tb.append(el('tr', null, el('th', { scope: 'row' }, text(r[keyName])), el('td', { class: 'num' }, text(r.corpus)), el('td', null, bar(r.levels, Number(r.corpus)))));
  }
  t.append(tb);
  return t;
}

async function main() {
  await initPage();
  const cov = await fetchJSONor('data/coverage.json', null);
  if (!isObj(cov)) {
    $('notes').append(el('div', { class: 'notice' }, el('p', null, 'The coverage data could not be loaded.')));
    document.documentElement.dataset.ready = '1';
    return;
  }
  for (const n of arr(cov.notes).filter(has)) $('notes').append(el('div', { class: 'notice plain' }, el('p', null, text(n))));

  const legend = $('legend');
  for (const k of KEYS) {
    legend.append(el('li', null, el('span', { class: 'sw bar' }, el('i', { class: 'lv-' + k, style: 'width:100%' })),
      el('span', { title: LEVELS[k] ? LEVELS[k].long : (k === 'timeout' ? 'the analysis was stopped at its time limit; there is no report' : 'in the catalogue, not yet analysed') }, nameOf(k))));
  }

  const grid = isObj(cov.grid) ? cov.grid : {};
  const orders = arr(grid.orders), degrees = arr(grid.degrees);
  const cells = new Map(arr(grid.cells).filter(isObj).map(c => [`${c.order}/${c.degree}`, c]));
  const table = $('grid');
  table.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Order \\ degree'), degrees.map(n => el('th', { scope: 'col' }, 'degree ' + text(n))))));
  const tb = el('tbody');
  for (const K of orders) {
    const tr = el('tr', null, el('th', { scope: 'row' }, 'order ' + text(K)));
    for (const n of degrees) {
      const c = cells.get(`${K}/${n}`);
      const count = c ? Number(c.corpus) || 0 : 0;
      if (!count) { tr.append(el('td', null, el('span', { class: 'cell-empty' }, 'none in the catalogue'), c && has(c.note) ? el('span', { class: 'bar-text' }, text(c.note)) : null)); continue; }
      const a = el('a', { href: `catalogue.html?order=${encodeURIComponent(K)}&degree=${encodeURIComponent(n)}`, title: 'Show these equations in the catalogue' },
        el('span', { class: 'cell-n' }, String(count), ' ', el('small', null, count === 1 ? 'equation' : 'equations')), bar(c.levels, count));
      tr.append(el('td', null, a, has(c.note) ? el('span', { class: 'bar-text' }, text(c.note)) : null));
    }
    tb.append(tr);
  }
  table.append(tb);

  const out = arr(cov.outside_grid).filter(isObj);
  if (out.length) {
    $('outside').append(el('p', { class: 'small' }, `${out.length} catalogue ${out.length === 1 ? 'entry lies' : 'entries lie'} outside the grid (another order or degree, or not polynomial before a substitution): `,
      out.map((o, i) => [i ? ', ' : '', el('a', { href: 'catalogue.html?id=' + encodeURIComponent(text(o.id)) }, text(o.name || o.id))]), '.'));
  }

  const c = isObj(cov.corpus) ? cov.corpus : {};
  const dl = el('dl', { class: 'facts' });
  const add = (k, v) => { if (has(v)) dl.append(el('dt', null, k), el('dd', null, v)); };
  add('equations in the catalogue', has(c.total) ? text(c.total) : null);
  add('polynomial and autonomous', has(c.polynomial_autonomous) ? text(c.polynomial_autonomous) : null);
  add('with a report', has(c.with_report) ? text(c.with_report) : null);
  if (isObj(c.levels)) add('levels of the answers', bar(c.levels, Number(c.total) || 0));
  $('totals').append(dl);
  const fields = arr(c.by_field).filter(isObj);
  const many = fields.filter(f => Number(f.corpus) > 1), single = fields.filter(f => !(Number(f.corpus) > 1));
  if (many.length) $('by-field').append(levelTable(many.length >= 5 ? many : fields, 'Field', 'field'));
  else if (fields.length) $('by-field').append(levelTable(fields, 'Field', 'field'));
  else $('by-field').append(el('p', { class: 'muted' }, 'No data.'));
  if (many.length >= 5 && single.length) {
    $('by-field').append(el('p', { class: 'small muted' }, `Fields with one equation (${single.length}): `, single.map(f => text(f.field)).join(', '), '. An equation can belong to several fields.'));
  } else if (fields.length) $('by-field').append(el('p', { class: 'small muted' }, 'An equation can belong to several fields.'));
  if (arr(c.by_weight).length) $('by-weight').append(levelTable(arr(c.by_weight).filter(isObj), 'Weight', 'weight'));
  else $('by-weight').append(el('p', { class: 'muted' }, 'No data.'));
  if (has(cov.source)) $('source').textContent = 'Source of these numbers: ' + text(cov.source) + '.';
  try { renderDemand(await fetchJSONor('data/demand.json', null)); }
  catch (e) { console.warn('demand table failed', e); $('demand').hidden = true; }
  try { renderTypes(await fetchJSONor('data/types.json', null)); }
  catch (e) { console.warn('theorem map failed', e); $('types').hidden = true; }
  document.documentElement.dataset.ready = '1';
}

// ---- the demand table of the corpus census: data/demand.json, made by build.py from corpus/demand_C.md --------
const pct = (a, b) => (has(a) ? `${Number(a).toFixed(1)} %` + (has(b) ? ` (${Number(b).toFixed(1)} %)` : '') : '');
function renderDemand(doc) {
  const sec = $('demand');
  if (!isObj(doc) || !(doc.parsed || has(doc.html_a) || has(doc.html_b))) { sec.hidden = true; return; }
  sec.hidden = false;
  const works = isObj(doc.works) ? doc.works : {};
  const idx = Object.keys(works);
  const names = { s2: 'Semantic Scholar', doaj: 'DOAJ' };
  const intro = [];
  if (has(doc.neutral)) intro.push(text(doc.neutral) + ' ');
  if (has(doc.method)) intro.push(text(doc.method) + ' ');
  if (idx.length) intro.push('Works counted: ' + idx.map(k => `${works[k]} (${names[k] || k})`).join(' and ') + (idx.length > 1 ? `; the shares of the second count are in brackets.` : '.'));
  $('demand-method').textContent = intro.join('');
  if (has(doc.method_full)) { const d = $('demand-method-full'); d.hidden = false; d.querySelector('p').textContent = text(doc.method_full); }
  const ta = $('demand-classes'), tb2 = $('demand-orders');
  if (!doc.parsed) {
    // the tables as HTML made at build time from the markdown file (cells escaped there)
    if (has(doc.html_a)) ta.parentNode.innerHTML = doc.html_a;
    if (has(doc.html_b)) tb2.parentNode.innerHTML = doc.html_b;
    return;
  }
  const rows = arr(doc.classes).filter(isObj);
  const classes = rows.filter(r => r.group === 'class'), family = rows.filter(r => r.group === 'family'), uncl = rows.filter(r => r.group === 'unclassified');
  ta.append(el('caption', null, 'Classes of travelling-wave equations, after the standard integrations, by their share of the works; for each class, the levels of the answers for the catalogue equations of that class.'),
    el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Equation (class)'), el('th', { scope: 'col' }, 'Name'),
      el('th', { scope: 'col', class: 'num' }, 'Share of the works'), el('th', { scope: 'col', style: 'min-width:13rem' }, 'In the catalogue: levels of the answers'))));
  const tb = el('tbody');
  for (const c of classes) {
    const members = arr(c.members).filter(isObj);
    const cell = el('td');
    if (!members.length) cell.append(el('span', { class: 'cell-empty' }, 'no entry'));
    else {
      cell.append(el('span', { class: 'cell-n' }, String(members.length), ' ', el('small', null, members.length === 1 ? 'equation' : 'equations')), ...bar(c.levels, members.length));
      const d = el('details', null, el('summary', null, 'the equations'));
      d.append(el('p', { class: 'small' }, members.map((m, i) => [i ? ', ' : '', el('a', { href: 'catalogue.html?id=' + encodeURIComponent(text(m.id)), title: nameOf(text(m.level)) }, text(m.name || m.id))])));
      cell.append(d);
    }
    tb.append(el('tr', null, el('td', null, el('code', { class: 'sympy' }, text(c.class))), el('td', null, text(c.name)),
      el('td', { class: 'num' }, pct(c.share, c.share_second)), cell));
  }
  ta.append(tb);
  const rest = $('demand-rest');
  rest.textContent = '';
  const sum = (xs, k) => xs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  rest.append(el('p', { class: 'small' }, `The classes above account for ${pct(sum(classes, 'share'), sum(classes, 'share_second'))} of the works.`));
  if (family.length) {
    rest.append(el('details', null, el('summary', null, `Works that name a family but no identified equation: ${pct(sum(family, 'share'), sum(family, 'share_second'))}`),
      el('ul', { class: 'small' }, family.map(f => el('li', null, text(f.name).replace(/^(generic|tail):\s*/, '') + ': ' + pct(f.share, f.share_second))))));
  }
  for (const u of uncl) rest.append(el('p', { class: 'small' }, `Unclassified: ${pct(u.share, u.share_second)}. `, el('span', { class: 'muted' }, text(u.name))));

  const orders = arr(doc.orders).filter(isObj);
  if (orders.length) {
    const label = { '<= 2': 'order at most 2', '3-4': 'orders 3 and 4', '>= 5': 'order 5 or more', 'unclassified': 'unclassified' };
    tb2.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Order of the equation'),
      orders.flatMap(o => [el('th', { scope: 'col', class: 'num' }, `${names[o.index] || o.index}: works`), el('th', { scope: 'col', class: 'num' }, 'of all'), el('th', { scope: 'col', class: 'num' }, 'of the classified')]))));
    const b = el('tbody');
    arr(orders[0].rows).forEach((r0, i) => {
      b.append(el('tr', null, el('th', { scope: 'row' }, label[r0.order] || text(r0.order)),
        orders.flatMap(o => { const r = arr(o.rows)[i] || {}; return [el('td', { class: 'num' }, has(r.works) ? text(r.works) : ''), el('td', { class: 'num' }, has(r.of_all) ? pct(r.of_all) : ''), el('td', { class: 'num' }, has(r.of_classified) ? pct(r.of_classified) : '–')]; })));
    });
    tb2.append(b);
    const oc = k => arr(orders[0].rows).find(r => r.order === k), oc2 = k => (orders[1] ? arr(orders[1].rows).find(r => r.order === k) : null);
    const f = k => (oc(k) ? pct(oc(k).of_classified, oc2(k) ? oc2(k).of_classified : null) : '');
    $('demand-order-note').textContent = `Of the classified works: order at most 2: ${f('<= 2')}; orders 3 and 4: ${f('3-4')}; order 5 or more: ${f('>= 5')}. The unclassified works name no catalogue equation and no family in the title.`;
  }
  requestAnimationFrame(() => markScrollable(sec));
}

// ---- the theorem map over the types (K, p): data/types.json, a slim copy of RUN/atlas/types.json ----------------
const KIND = { 'pure-power': 'pure power', 'J1': 'J1', 'slice': 'slice', 'mixed': 'mixed' };
const SHORT = { 'W∪rational': 'W', 'entire only': 'no poles', 'entire (not classified)': 'no poles (solutions without poles not classified)',
  'unknown': '—', 'complete list (not all in W)': 'listed (not all W)', 'listed (not all in W)': 'listed' };
/** the strongest statement of a sub-type and its level, as in atlas/types.md */
function shortGuarantee(s) {
  const g = isObj(s.guarantee) ? s.guarantee : {}, em = isObj(g.every_member) ? g.every_member : {};
  if (s.guarantee_level === 'every member') {
    const c = Object.prototype.hasOwnProperty.call(SHORT, em.class) ? SHORT[em.class] : text(em.class);
    const b = has(em.pole_bound) ? text(em.pole_bound).split(' ')[0] : '';
    return { text: c + (b && c === 'W' ? ', ≤ ' + b : ''), level: 'all' };
  }
  if (s.guarantee_level === 'generic') {
    const c = Object.prototype.hasOwnProperty.call(SHORT, g.class) ? SHORT[g.class] : text(g.class);
    const b = g.pole_bound;
    return { text: c + (has(b) && !['None', '0'].includes(text(b)) && c === 'W' ? ', ≤ ' + text(b) : ''), level: 'generic',
      all: has(em.with_finiteness_property) && em.with_finiteness_property !== false ? 'for all: W with the finiteness property' : '' };
  }
  return { text: '—', level: 'none' };
}
function subName(s) { return `${KIND[s.kind] || text(s.kind)}${s.kind === 'mixed' || !has(s.n) ? '' : ', n = ' + text(s.n)}`; }
function monomials(list) {
  const out = [];
  arr(list).forEach((m, i) => { if (i) out.push(', '); out.push(mathOf(text(m), null, {})); });
  return out;
}
/** "T-X: label" -> the theorem, linked, with the badge of its label */
function theoremChips(labels, theorems) {
  const seen = new Set(), out = [];
  for (const item of arr(labels)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(text(item));
    if (!m) { out.push(el('span', { class: 'chip' }, text(item))); continue; }
    seen.add(m[1]);
    const lab = m[2].split(/\s*\(/)[0].trim();
    out.push(el('span', { style: 'white-space:nowrap' }, el('a', { class: 'chip', href: 'method.html#' + encodeURIComponent(m[1]) }, m[1]), ' ',
      Object.prototype.hasOwnProperty.call(LABELS, lab) ? badge(lab) : el('span', { class: 'small muted' }, m[2])),
      /\(/.test(m[2]) ? el('span', { class: 'small muted' }, ' (' + m[2].split(/\(/).slice(1).join('(')) : null);
  }
  for (const t of arr(theorems)) if (!seen.has(text(t))) out.push(el('a', { class: 'chip', href: 'method.html#' + encodeURIComponent(text(t)) }, text(t)));
  const flat = [];
  out.filter(Boolean).forEach((n, i) => { if (i) flat.push(' '); flat.push(n); });
  return flat;
}

function renderTypes(doc) {
  const sec = $('types');
  if (!isObj(doc) || !arr(doc.types).length) { sec.hidden = true; return; }
  sec.hidden = false;
  const types = arr(doc.types).filter(isObj);
  const sum = isObj(doc.summary) ? doc.summary : {};
  const byKind = isObj(sum.subtypes_by_kind) ? sum.subtypes_by_kind : {};
  const n = k => (isObj(sum[k]) && has(sum[k].count) ? sum[k].count : null);
  const nSub = types.reduce((a, t) => a + arr(t.subtypes).length, 0);
  const counts = [`${types.length} types and ${nSub} sub-types`];
  if (Object.keys(byKind).length) counts[0] += ' (' + Object.entries(byKind).map(([k, v]) => `${KIND[k] || k} ${v}`).join(', ') + ')';
  if (n('class_for_every_member') !== null) counts.push(`the class of the solutions is known for every equation in ${n('class_for_every_member')} sub-types`);
  if (n('class_for_generic_members_only') !== null) counts.push(`for the generic member only in ${n('class_for_generic_members_only')}`);
  if (n('no_class_even_for_generic_members') !== null) counts.push(`not even for the generic member in ${n('no_class_even_for_generic_members')}`);
  $('types-counts').textContent = counts.join('; ') + '. Orders up to 6, degrees up to 5.';

  // the map: rows K, columns p
  const Ks = Array.from(new Set(types.map(t => Number(t.K)))).sort((a, b) => a - b);
  const ps = Array.from(new Set(types.map(t => Number(t.p)))).sort((a, b) => a - b);
  const table = $('typemap');
  table.textContent = '';
  table.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Order K \\ pole order p'), ps.map(p => el('th', { scope: 'col' }, tex('p = ' + p))))));
  const tb = el('tbody');
  for (const K of Ks) {
    const tr = el('tr', null, el('th', { scope: 'row' }, tex('K = ' + K)));
    for (const p of ps) {
      const t = types.find(x => Number(x.K) === K && Number(x.p) === p);
      const td = el('td');
      if (!t) { if (p > K) td.className = 'void'; tr.append(td); continue; }
      const ul = el('ul', { class: 'subs' });
      for (const s of arr(t.subtypes).filter(isObj)) {
        const g = shortGuarantee(s);
        ul.append(el('li', { class: 'lv-' + g.level },
          el('a', { href: '#' + encodeURIComponent(text(s.id)), class: 'to-sub', title: 'core: ' + arr(s.core).map(text).join(', ') }, subName(s)),
          el('span', { class: 'st-line' }, el('span', { class: 'st' }, g.level === 'none' ? 'no class from the theorems' : g.text), g.level === 'none' ? null : el('span', { class: 'lvl' }, ' (' + g.level + ')')),
          g.all ? el('span', { class: 'bar-text' }, g.all) : null));
      }
      td.append(ul);
      tr.append(td);
    }
    tb.append(tr);
  }
  table.append(tb);

  // the sub-types
  const list = $('subtype-list');
  list.textContent = '';
  $('subtypes-n').textContent = String(nSub);
  for (const t of types) {
    for (const s of arr(t.subtypes).filter(isObj)) {
      const g = isObj(s.guarantee) ? s.guarantee : {}, em = isObj(g.every_member) ? g.every_member : {};
      const sg = shortGuarantee(s);
      const art = el('article', { class: 'theorem subtype', id: text(s.id) });
      art.append(el('h3', null, tex(`(K, p) = (${text(t.K)}, ${text(t.p)})`), ' ', subName(s), el('span', { class: 'tid' }, text(s.id)),
        el('span', { class: 'chip' }, sg.level === 'none' ? 'no class from the theorems' : `${sg.text} (${sg.level})`)));
      const dl = el('dl', { class: 'facts' });
      const add = (k, v) => { if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) dl.append(el('dt', null, k), el('dd', null, v)); };
      add('core', monomials(s.core));
      if (has(em.text)) add('for every equation', [rich(em.text), arr(em.labels).length || arr(em.theorems).length ? el('div', { class: 'chips-line' }, theoremChips(em.labels, em.theorems)) : null]);
      if (s.guarantee_level === 'generic' && has(g.text)) add('for the generic member', [rich(g.text), arr(g.labels).length || arr(g.theorems).length ? el('div', { class: 'chips-line' }, theoremChips(g.labels, g.theorems)) : null]);
      const special = arr(g.special_members).filter(isObj);
      if (special.length) {
        const ul = el('ul');
        for (const m of special) ul.append(el('li', null, rich(text(m.members)), ': ', rich(text(m.statement)), arr(m.theorems).length ? [' ', theoremChips([], m.theorems)] : null));
        add('special members', ul);
      }
      const sectors = arr(g.atlas_sectors).filter(isObj);
      if (sectors.length) add('records of the atlas', el('ul', null, sectors.map(a => el('li', null, el('span', { class: 'chip' }, text(a.id)), ' ', text(a.what), has(a.label) ? el('span', { class: 'small muted' }, ' — ' + text(a.label)) : null))));
      if (has(s.not_guaranteed)) add('not guaranteed', rich(s.not_guaranteed));
      if (has(s.computable)) add('computed per equation', rich(s.computable));
      if (has(s.corpus_count)) add('in the catalogue', `${text(s.corpus_count)} ${Number(s.corpus_count) === 1 ? 'equation' : 'equations'}` + (has(s.corpus_weight) && Number(s.corpus_count) > 0 ? `, total weight ${text(s.corpus_weight)}` : ''));
      const ex = arr(s.physical_examples).map(x => (isObj(x) ? (x.name || x.id) : x)).filter(has).map(text);
      if (ex.length) add('examples', ex.slice(0, 12).join('; ') + (ex.length > 12 ? '; …' : ''));
      art.append(dl);
      if (has(s.example)) art.append(el('details', null, el('summary', null, 'The generic member'), formulaBox({ sympy: text(s.example), hint: 'c: core coefficients; a: coefficients of the lower terms' })));
      list.append(art);
    }
  }

  // the catalogue by type
  const st = isObj(doc.corpus_status) ? doc.corpus_status : {};
  const rows = Object.entries(st).sort((a, b) => b[1] - a[1]);
  const box = $('types-corpus');
  box.textContent = '';
  if (rows.length) {
    const names = { 'type': 'has a type (K, p): solved for the top derivative, integer pole order' };
    const tt = el('table', null, el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Catalogue equations'), el('th', { scope: 'col', class: 'num' }, 'Number'))));
    const b2 = el('tbody');
    for (const [k, v] of rows) b2.append(el('tr', null, el('td', null, names[k] || text(k)), el('td', { class: 'num' }, String(v))));
    tt.append(b2);
    box.append(tt);
  }
  $('types-source').textContent = has(doc.generated) ? `Theorem map generated ${text(doc.generated)} from the list of theorems and the engine.` : '';

  // links from the map open the list and scroll to the sub-type
  const go = id => { const target = id ? document.getElementById(id) : null; if (target && list.contains(target)) { $('subtypes').open = true; target.scrollIntoView({ block: 'start' }); return true; } return false; };
  table.addEventListener('click', ev => {
    const a = ev.target.closest ? ev.target.closest('a.to-sub') : null;
    if (a && go(decodeURIComponent(a.getAttribute('href').slice(1)))) { ev.preventDefault(); history.replaceState(null, '', a.getAttribute('href')); }
  });
  if (location.hash.length > 1) { try { go(decodeURIComponent(location.hash.slice(1))); } catch { /* not a sub-type */ } }
  requestAnimationFrame(() => markScrollable(sec));
}
main();
