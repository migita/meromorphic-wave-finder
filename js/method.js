// Method page: the tables of levels and labels, and the theorems of data/registry.json (SCHEMA section 4).
import { initPage, el, fetchJSONor, text, has, isObj, arr, badge, meter, rich, LABELS, LEVELS, LEVEL_ORDER } from './common.js';

function sourceNode(src) {
  if (!has(src)) return null;
  if (typeof src === 'string') return rich(src);
  if (!isObj(src)) return text(src);
  const out = [];
  if (has(src.citation)) out.push(rich(src.citation));
  if (has(src.where)) out.push(out.length ? ', ' : '', text(src.where));
  if (has(src.path)) {
    const p = text(src.path);
    out.push(out.length ? '; ' : '');
    if (/^10\.\d{4,9}\//.test(p)) out.push(el('a', { href: 'https://doi.org/' + encodeURI(p), rel: 'noopener' }, 'doi:' + p));
    else if (/^https?:\/\//.test(p)) out.push(el('a', { href: p, rel: 'noopener' }, p));
    else out.push(el('code', { class: 'sympy' }, p));
  }
  if (has(src.doi)) out.push(' ', el('a', { href: 'https://doi.org/' + encodeURI(text(src.doi)), rel: 'noopener' }, 'doi:' + text(src.doi)));
  return out;
}

function theorem(t) {
  const id = text(t.id);
  const art = el('article', { class: 'theorem', id });
  art.append(el('h3', null, has(t.name) ? text(t.name) : id, el('span', { class: 'tid' }, id), has(t.label) ? badge(t.label) : null));
  // what qualifies the label: a note on the label, a caveat, a proof not yet read by a second agent
  const remarks = [];
  if (has(t.label_note)) remarks.push(rich(t.label_note));
  if (has(t.caveat)) remarks.push([el('strong', null, 'Caveat: '), rich(text(t.caveat).replace(/^\((.*)\)$/, '$1'))]);
  if (t.second_reading === false) remarks.push(['The proof has not been read by a second agent.', has(t.second_reading_detail) ? [' ', rich(t.second_reading_detail)] : null]);
  for (const r of remarks) art.append(el('p', { class: 'remark' }, r));
  if (has(t.statement)) art.append(el('p', { class: 'statement' }, rich(t.statement)));
  const hyps = arr(t.hypotheses);
  if (hyps.length) {
    art.append(el('p', { class: 'small muted' }, 'Hypotheses verified for each equation:'));
    const ul = el('ul');
    for (const h of hyps) ul.append(el('li', null, rich(isObj(h) ? (has(h.text) ? h.text : text(h.key)) : text(h))));
    art.append(ul);
  }
  const c = t.conclusion;
  if (isObj(c)) {
    const dl = el('dl', { class: 'facts' });
    const add = (k, v) => { if (has(v)) dl.append(el('dt', null, k), el('dd', null, rich(v))); };
    add('conclusion', c.text);
    add('class of the solutions', c.class);
    add('bound on the poles', c.pole_bound);
    for (const [k, v] of Object.entries(c)) if (!['text', 'class', 'pole_bound'].includes(k) && has(v)) add(k.replace(/_/g, ' '), typeof v === 'string' ? v : JSON.stringify(v));
    if (dl.children.length) art.append(dl);
  } else if (has(c)) {
    art.append(el('p', null, el('span', { class: 'small muted' }, 'Conclusion: '), rich(c)));
  }
  const dl = el('dl', { class: 'facts' });
  const src = sourceNode(t.source);
  if (src) dl.append(el('dt', null, 'source'), el('dd', null, src));
  const dns = arr(t.does_not_say).filter(has);
  if (dns.length) dl.append(el('dt', null, 'what it does not say'), el('dd', null, dns.length === 1 ? rich(dns[0]) : el('ul', null, dns.map(x => el('li', null, rich(text(x)))))));
  else if (has(t.notes)) dl.append(el('dt', null, 'what it does not say'), el('dd', null, rich(t.notes)));
  if (has(t.check)) dl.append(el('dt', null, 'checked by'), el('dd', null, el('code', { class: 'sympy' }, text(t.check))));
  if (has(t.decided_by)) dl.append(el('dt', null, 'decided by'), el('dd', null, el('code', { class: 'sympy' }, text(t.decided_by))));
  if (dl.children.length) art.append(dl);
  return art;
}

async function main() {
  await initPage();
  const lv = document.querySelector('#levels-table tbody');
  for (const k of LEVEL_ORDER) {
    const info = LEVELS[k];
    lv.append(el('tr', null, el('td', null, meter(k), info.name), el('td', null, info.long.charAt(0).toUpperCase() + info.long.slice(1) + '.')));
  }
  const lb = document.querySelector('#labels-table tbody');
  for (const [k, v] of Object.entries(LABELS)) lb.append(el('tr', null, el('td', null, badge(k)), el('td', null, v)));

  const box = document.getElementById('registry');
  const reg = arr(await fetchJSONor('data/registry.json', null)).filter(isObj);
  box.textContent = '';
  if (!reg.length) box.append(el('p', { class: 'muted' }, 'The list of theorems could not be loaded.'));
  if (reg.length > 3) {
    const toc = el('ul', { class: 'toc', 'aria-label': 'The theorems' });
    for (const t of reg) toc.append(el('li', null, el('a', { href: '#' + encodeURIComponent(text(t.id)) }, has(t.name) ? text(t.name) : text(t.id))));
    box.append(toc);
  }
  for (const t of reg) {
    try { box.append(theorem(t)); } catch (e) { box.append(el('pre', { class: 'raw' }, JSON.stringify(t, null, 1))); }
  }
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
  }
  document.documentElement.dataset.ready = '1';
}
main();
