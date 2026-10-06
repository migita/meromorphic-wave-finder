// Method page: the tables of levels and labels, and the theorems of data/registry.json (SCHEMA section 4).
import { initPage, el, fetchJSONor, text, has, isObj, arr, badge, meter, rich, LABELS, LEVELS, COUNT_KEYS } from './common.js';

const words = k => text(k).replace(/_/g, ' ');
const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** any value of the registry as readable text: sentences, lists, small tables — never raw JSON */
function readable(v, depth = 0) {
  if (!has(v)) return null;
  if (scalar(v)) return rich(text(v));
  if (Array.isArray(v)) {
    const items = v.filter(has);
    if (!items.length) return null;
    if (items.every(isObj)) return tableOf(items.map((o, i) => [String(i + 1), o]), '');
    return el('ul', null, items.map(x => el('li', null, readable(x, depth + 1))));
  }
  const entries = Object.entries(v).filter(([, x]) => has(x));
  if (!entries.length) return null;
  const rows = entries.filter(([, x]) => isObj(x)), plain = entries.filter(([, x]) => !isObj(x));
  const out = [];
  for (const [k, x] of plain) out.push(el('p', { class: 'kv' }, el('span', { class: 'k' }, words(k) + ': '), readable(x, depth + 1)));
  if (rows.length) out.push(tableOf(rows, 'case'));
  return out;
}
/** a small table: one row for each [name, object]; the columns are the keys that occur. A long text does not fit a
    column: it goes under its row, as a line "key: text" over the full width */
function tableOf(rows, firstHead) {
  const all = [];
  for (const [, o] of rows) for (const k of Object.keys(o)) if (has(o[k]) && !all.includes(k)) all.push(k);
  const isLong = k => rows.some(([, o]) => has(o[k]) && (!scalar(o[k]) || text(o[k]).length > 40));
  const cols = all.filter(k => !isLong(k)), wide = all.filter(isLong);
  const t = el('table', { class: 'mini' }, el('thead', null, el('tr', null, el('th', { scope: 'col' }, firstHead), cols.map(c => el('th', { scope: 'col' }, words(c))))));
  const tb = el('tbody');
  for (const [name, o] of rows) {
    tb.append(el('tr', null, el('th', { scope: 'row' }, words(name)), cols.map(c => el('td', null, readable(o[c], 2)))));
    const more = wide.filter(k => has(o[k]));
    if (more.length) tb.append(el('tr', { class: 'more' }, el('td', { colspan: String(cols.length + 1) },
      more.map(k => el('p', { class: 'kv' }, el('span', { class: 'k' }, words(k) + ': '), readable(o[k], 2))))));
  }
  t.append(tb);
  return el('div', { class: 'table-wrap' }, t);
}

/** the source of a theorem; for a proof of this project the line is fixed: the note is not public */
function sourceNode(t) {
  const src = t.source;
  if (text(t.label) === 'agent-proof') return 'note of this project (not public)';
  if (!has(src)) return null;
  if (typeof src === 'string') return rich(src);
  if (!isObj(src)) return text(src);
  const out = [];
  if (has(src.citation)) out.push(rich(src.citation));
  if (has(src.where)) out.push(out.length ? ', ' : '', text(src.where));
  if (has(src.path)) {
    const p = text(src.path).replace(/^doi:\s*/i, '');
    if (/^10\.\d{4,9}\//.test(p)) out.push(out.length ? '; ' : '', el('a', { href: 'https://doi.org/' + encodeURI(p), rel: 'noopener' }, 'doi:' + p));
    else if (/^https?:\/\//.test(p)) out.push(out.length ? '; ' : '', el('a', { href: p, rel: 'noopener' }, p));
  }
  if (has(src.doi)) out.push(' ', el('a', { href: 'https://doi.org/' + encodeURI(text(src.doi)), rel: 'noopener' }, 'doi:' + text(src.doi)));
  for (const k of ['secondary', 'restated_in', 'published_cases']) {
    if (has(src[k])) out.push(el('span', { class: 'src-more' }, ' ' + words(k) + ': ', Array.isArray(src[k]) ? src[k].map(text).join('; ') : text(src[k])));
  }
  return out;
}

function theorem(t) {
  const id = text(t.id);
  const art = el('article', { class: 'theorem', id });
  art.append(el('h3', null, has(t.name) ? text(t.name) : id, el('span', { class: 'tid' }, id), has(t.label) ? badge(t.label) : null));
  // what qualifies the label: a note on the label, a caveat, a proof not yet read by a second AI model
  const remarks = [];
  if (has(t.label_note)) remarks.push(rich(t.label_note));
  if (has(t.caveat)) remarks.push([el('strong', null, 'Caveat: '), rich(text(t.caveat).replace(/^\((.*)\)$/, '$1'))]);
  if (t.second_reading === false) remarks.push(['The proof has not been read by a second AI model.',
    has(t.second_reading_detail) ? [' ', rich(text(t.second_reading_detail).replace(/\bsecond agent\b/g, 'second AI model'))] : null]);
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
    const add = (k, v) => { const node = readable(v); if (node) dl.append(el('dt', null, k), el('dd', null, node)); };
    add('conclusion', c.text);
    add('class of the solutions', c.class);
    // the registry may point to another field by its key: say it with the words of the row below
    add('bound on the poles', typeof c.pole_bound === 'string' && has(c.pole_bound_detail)
      ? c.pole_bound.replace(/`?pole_bound_detail`?/g, '“the bound in detail” below') : c.pole_bound);
    for (const [k, v] of Object.entries(c)) if (!['text', 'class', 'pole_bound'].includes(k) && has(v)) add(k === 'pole_bound_detail' ? 'the bound in detail' : words(k), v);
    if (dl.children.length) art.append(dl);
  } else if (has(c)) {
    art.append(el('p', null, el('span', { class: 'small muted' }, 'Conclusion: '), rich(c)));
  }
  const dl = el('dl', { class: 'facts' });
  const src = sourceNode(t);
  if (src) dl.append(el('dt', null, 'source'), el('dd', null, src));
  const dns = arr(t.does_not_say).filter(has);
  if (dns.length) dl.append(el('dt', null, 'what it does not say'), el('dd', null, dns.length === 1 ? rich(dns[0]) : el('ul', null, dns.map(x => el('li', null, rich(text(x)))))));
  else if (has(t.notes)) dl.append(el('dt', null, 'what it does not say'), el('dd', null, rich(t.notes)));
  if (dl.children.length) art.append(dl);
  return art;
}

async function main() {
  await initPage();
  const lv = document.querySelector('#levels-table tbody');
  for (const k of COUNT_KEYS.filter(x => LEVELS[x])) {
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
  // "Who made this": the statements labelled agent-proof whose proof has not had its second reading yet
  const agentProofs = reg.filter(t => text(t.label) === 'agent-proof');
  const unread = agentProofs.filter(t => t.second_reading === false);
  const wu = document.getElementById('who-unread');
  if (wu && unread.length) {
    wu.append(` For ${unread.length} of the ${agentProofs.length} statements with this label the second reading has not taken place yet; their entries below say so: `);
    unread.forEach((t, i) => wu.append(i ? ', ' : '', el('a', { href: '#' + encodeURIComponent(text(t.id)) }, text(t.id))));
    wu.append('.');
  }
  for (const t of reg) {
    try { box.append(theorem(t)); }
    catch (e) {
      // never raw JSON on this page: the identifier, the name and the statement as plain text
      box.append(el('article', { class: 'theorem', id: text(t.id) },
        el('h3', null, has(t.name) ? text(t.name) : text(t.id)),
        typeof t.statement === 'string' ? el('p', null, rich(t.statement)) : null,
        el('p', { class: 'small muted' }, 'The other fields of this entry could not be displayed.')));
    }
  }
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
  }
  document.documentElement.dataset.ready = '1';
}
main();
