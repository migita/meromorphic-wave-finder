// The page "Checks": the notes of the project on the checks made on the data (data/checks.json, written by build.py
// from site/build_notes.json and the totals of the independent substitution check), the numbers of catalogue
// equations by level, and the limits. The wording is that of the file; this script adds none.
import { initPage, el, fetchJSONor, text, has, isObj, arr, rich, LEVELS, COUNT_KEYS, COUNT_NAMES } from './common.js';

const $ = id => document.getElementById(id);

async function main() {
  await initPage();
  const doc = await fetchJSONor('data/checks.json', null);
  if (!isObj(doc) || !doc.present) {
    $('checks-intro').textContent = 'The notes on the checks are not part of this build.';
    $('made').hidden = true;
    $('limits').hidden = true;
  } else {
    if (has(doc.intro)) $('checks-intro').append(rich(doc.intro));
    const list = $('checks-list');
    for (const c of arr(doc.checks).filter(isObj)) {
      list.append(el('article', { class: 'check-note' },
        el('h3', null, text(c.name)),
        has(c.what) ? el('p', null, rich(c.what)) : null,
        el('p', { class: 'check-outcome' }, el('span', { class: 'k' }, 'Result: '), has(c.result) ? rich(c.result) : 'not recorded in this build.')));
    }
    const limits = arr(doc.limits).filter(has);
    for (const l of limits) $('checks-limits').append(el('li', null, rich(l)));
    if (!limits.length) $('limits').hidden = true;
  }
  // the numbers of catalogue equations by the level of their answer (the keys and names of the method page)
  const levels = isObj(doc) && isObj(doc.levels) ? doc.levels : {};
  const keys = COUNT_KEYS.filter(k => Number(levels[k]) > 0);
  const table = $('checks-levels');
  if (!keys.length) $('levels').hidden = true;
  else {
    table.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Level of the answer'), el('th', { scope: 'col', class: 'num' }, 'Equations'))));
    const tb = el('tbody');
    let total = 0;
    for (const k of keys) {
      const n = Number(levels[k]);
      total += n;
      const name = LEVELS[k] ? LEVELS[k].name : (COUNT_NAMES[k] || k);
      tb.append(el('tr', null,
        el('td', null, el('span', { class: 'sw bar' }, el('i', { class: 'lv-' + k, style: 'width:100%' })), ' ',
          LEVELS[k] ? el('a', { href: 'catalogue.html?level=' + encodeURIComponent(k) }, name) : name),
        el('td', { class: 'num' }, String(n))));
    }
    tb.append(el('tr', { class: 'total' }, el('td', null, 'All equations of the catalogue'), el('td', { class: 'num' }, String(has(doc.total) ? doc.total : total))));
    table.append(tb);
  }
  document.documentElement.dataset.ready = '1';
}

main().catch(e => {
  console.error(e);
  $('checks-intro').textContent = 'This page could not be displayed.';
  document.documentElement.dataset.ready = '1';
});
