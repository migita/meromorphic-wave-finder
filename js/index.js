// The entry page: one input box, the result below.
import { initPage, el, fetchJSONor, norm, text, has, isObj, arr, safeId } from './common.js';
import { renderReport } from './render.js';
import * as engine from './engine.js';

const EXAMPLES = [
  { label: 'Kuramoto–Sivashinsky', ids: ['kuramoto-sivashinsky', 'rich-kuramoto-sivashinsky', 'ks'], eq: 'u_t + u*u_x + u_xx + u_xxxx = 0' },
  { label: 'KdV–Burgers', ids: ['kdv-burgers', 'kdvb'], eq: 'u_t + u*u_x - a*u_xx + b*u_xxx = 0' },
  { label: 'Fisher', ids: ['fisher-kpp', 'fisher'], eq: 'u_t = u_xx + u*(1 - u)' },
  { label: 'Kawahara', ids: ['kawahara'], eq: 'u_t + u*u_x + u_xxx - u_xxxxx = 0' },
  { label: 'Swift–Hohenberg', ids: ['swift-hohenberg-cubic', 'swift-hohenberg'], eq: 'u_t = r*u - u - 2*u_xx - u_xxxx - u^3' },
  { label: 'A third-order family with five parameters', ids: ['family-F', 'third-order-family-F'], eq: "w''' = 12*w*w' + alpha*w'' - 6*mu*w^2 + gamma*w' + delta*w + epsilon" },
  { label: 'Forced KdV, travelling wave', ids: ['kdv-forced', 'rich-forced-kdv'], eq: "w''' = 12*w*w' + 1" },
];

const $ = id => document.getElementById(id);
let catalogue = [], registry = [], runNo = 0, timer = null;

function pageUrl(params) {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  for (const [k, v] of Object.entries(params || {})) if (has(v)) u.searchParams.set(k, v);
  return u.href;
}
function message(node) { const m = $('message'); m.textContent = ''; if (node) m.append(node); }
function notice(children, cls = '') { return el('div', { class: 'notice ' + cls, role: 'note' }, children); }

function showStatus(now) {
  $('status').hidden = false;
  $('status-now').textContent = now;
  $('status-log').textContent = '';
  const t0 = performance.now();
  clearInterval(timer);
  const tick = () => { $('status-elapsed').textContent = `${Math.round((performance.now() - t0) / 1000)} s`; };
  tick(); timer = setInterval(tick, 1000);
}
function hideStatus() { clearInterval(timer); $('status').hidden = true; }
const hooks = {
  onStatus: m => { $('status-now').textContent = text(m.text); },
  onLog: line => {
    const m = /^step:\s*(.+)$/.exec(text(line));
    if (m) $('status-now').textContent = `Analysing the equation: ${m[1]}…`;
    const log = $('status-log');
    log.textContent += (log.textContent ? '\n' : '') + text(line);
    log.scrollTop = log.scrollHeight;
  },
};

// reports computed in this session (the engine in the browser is slow; a repeated request is answered at once)
function cacheKey(eqText, options) { return 'mero-report:' + norm(eqText) + '|' + (options.atlas === false ? 'noatlas' : 'atlas'); }
function cacheGet(key) { try { const s = sessionStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } }
function cachePut(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* full or unavailable: no cache */ } }

function matchCatalogue(eqText) {
  const key = norm(eqText);
  if (!key) return null;
  return catalogue.find(e => e.has_report && [e.input, e.pde, e.ode].some(t => has(t) && norm(t) === key)) || null;
}

function show(report, ctx) {
  const eqText = isObj(report.input) && has(report.input.text) ? text(report.input.text) : ctx.eq;
  renderReport(report, $('result'), {
    registry, source: ctx.source,
    permalink: ctx.id ? pageUrl({ id: ctx.id }) : (has(ctx.eq) ? pageUrl({ eq: ctx.eq }) : null),
    filename: 'report-' + safeId(ctx.id || (eqText || 'equation')).slice(0, 60),
  });
  const shown = has(eqText) ? text(eqText) : '';
  document.title = (shown ? (shown.length > 70 ? shown.slice(0, 67) + '…' : shown) + ' — ' : '') + 'Meromorphic solutions';
  window.__lastReport = report;                    // for the browser test and for the console
  document.dispatchEvent(new CustomEvent('report-rendered', { detail: { source: ctx.source } }));
}

async function showPrecomputed(entry, eqText) {
  const rep = await fetchJSONor(`data/reports/${safeId(entry.id)}.json`, null);
  if (!isObj(rep)) return false;
  show(rep, { source: `Precomputed report of the catalogue (${text(entry.name || entry.id)})`, eq: eqText, id: eqText ? null : entry.id });
  const again = el('button', { type: 'button', class: 'quiet', id: 'run-live' }, 'run the engine on this input now');
  again.addEventListener('click', () => run(eqText || entry.input || entry.ode || entry.pde, { forceLive: true, push: false, again: true }));
  const inCatalogue = catalogue.some(e => text(e.id) === text(entry.id));
  message(notice(el('p', null, 'This report was computed in advance for the catalogue',
    inCatalogue ? [' entry ', el('a', { href: 'catalogue.html?id=' + encodeURIComponent(text(entry.id)) }, text(entry.name || entry.id)),
      ', which also gives the reduction and the sources'] : null,
    '. You can also ', again, '.'), 'plain'));
  return true;
}

async function run(eqText, { forceLive = false, push = true, again = false } = {}) {
  eqText = text(eqText).trim();
  if (!eqText) { message(notice(el('p', null, 'Enter an equation, or choose one of the examples.'), 'plain')); return; }
  const my = ++runNo;
  if (engine.busy()) engine.cancel();
  $('eq').value = eqText;
  if (push) history.pushState({ eq: eqText }, '', pageUrl({ eq: eqText }));
  $('result').textContent = '';
  message(null);
  const server = await engine.detectServer();
  if (my !== runNo) return;
  if (!server && !forceLive) {
    const entry = matchCatalogue(eqText);
    if (entry && await showPrecomputed(entry, eqText)) return;
    if (my !== runNo) return;
  }
  const budget = Number($('budget').value) || 60;
  const options = { budget_s: budget };
  if (!$('atlas').checked) options.atlas = false;
  const key = cacheKey(eqText, options);
  const kept = !server && !again ? cacheGet(key) : null;
  if (kept && isObj(kept.report) && Number(kept.budget) >= budget) {
    show(kept.report, { source: 'Computed in your browser earlier in this session', eq: eqText });
    const redo = el('button', { type: 'button', class: 'quiet' }, 'compute it again');
    redo.addEventListener('click', () => run(eqText, { forceLive: true, push: false, again: true }));
    message(notice(el('p', null, 'This is the report computed earlier in this session. You can also ', redo, '.'), 'plain'));
    return;
  }
  showStatus(server ? 'Sending the equation to the server…' : 'Starting the engine in your browser…');
  $('go').disabled = true;
  try {
    const { report, backend, info } = await engine.analyze(eqText, options, hooks);
    if (my !== runNo) return;
    if (backend === 'browser' && isObj(report)) cachePut(key, { report, budget });
    show(report, { source: backend === 'server' ? (report && report.cached ? 'Computed by the server (answer from its cache)' : 'Computed by the server') : 'Computed in your browser', eq: eqText });
    if (backend === 'browser' && info) noteBackend(`engine in the browser (Pyodide ${text(info.pyodide)}, Python ${text(info.python)}, SymPy ${text(info.sympy)})`);
  } catch (e) {
    if (my !== runNo) return;
    if (e && e.cancelled) message(notice(el('p', null, cancelText(server)), 'plain'));
    else if (e && e.unavailable) message(notice(el('p', null, 'The engine is not yet available in this build: the archive ', el('code', null, 'engine/mero.zip'), ' has no module ', el('code', null, 'mero.report'), '. Reports of the catalogue can be read meanwhile.')));
    else {
      console.warn('engine error', e);
      message(notice([el('p', null, el('strong', null, 'The engine stopped with an error. '), 'Nothing is claimed about this equation. The message of the engine follows.'),
        el('pre', { class: 'raw' }, text(e && e.message ? e.message : e))]));
    }
  } finally {
    if (my === runNo) { hideStatus(); $('go').disabled = false; }
  }
}

function cancelText(server) {
  return server ? 'Cancelled.' : 'Cancelled. The engine in the browser starts again with the next request.';
}

function noteBackend(s) {
  $('backend').textContent = 'Runs with: ' + s;
  const f = document.getElementById('backend-note');
  if (f) f.textContent = 'Live analysis: ' + s + '.';
}

async function route() {
  const q = new URLSearchParams(location.search);
  if (q.get('budget') && [...$('budget').options].some(o => o.value === q.get('budget'))) $('budget').value = q.get('budget');
  const id = q.get('id'), eq = q.get('eq');
  if (has(id)) {
    const entry = catalogue.find(e => text(e.id) === id) || { id, name: id };
    $('eq').value = text(entry.input || entry.pde || entry.ode || '');
    if (!(await showPrecomputed(entry, null))) {
      message(notice(el('p', null, `There is no precomputed report with the identifier “${id}”. `, el('a', { href: 'catalogue.html' }, 'Open the catalogue'), '.')));
    }
  } else if (has(eq)) {
    await run(eq, { push: false, forceLive: q.get('engine') === 'live' });
  }
}

async function main() {
  await initPage();
  const ul = $('examples');
  const chips = EXAMPLES.map(ex => {
    const a = el('a', { href: pageUrl({ eq: ex.eq }), title: ex.eq }, ex.label);
    a.addEventListener('click', ev => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
      ev.preventDefault();
      run(new URL(a.href).searchParams.get('eq'));
    });
    ul.append(el('li', null, a));
    return a;
  });
  for (const a of document.querySelectorAll('#syntax a.try')) {
    a.addEventListener('click', ev => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
      ev.preventDefault();
      run(new URL(a.href).searchParams.get('eq'));
    });
  }
  $('ask').addEventListener('submit', ev => { ev.preventDefault(); run($('eq').value); });
  $('cancel').addEventListener('click', async () => {
    runNo++; engine.cancel(); hideStatus(); $('go').disabled = false;
    message(notice(el('p', null, cancelText(await engine.detectServer())), 'plain'));
  });
  window.addEventListener('popstate', () => { route(); });

  [catalogue, registry] = await Promise.all([fetchJSONor('data/catalogue.json', []), fetchJSONor('data/registry.json', [])]);
  catalogue = arr(catalogue).filter(isObj); registry = arr(registry).filter(isObj);
  // examples that have a precomputed report use the text of that report, so that they open at once
  EXAMPLES.forEach((ex, i) => {
    const ids = ex.ids.concat(ex.ids.map(id => 'sample-' + id));
    const entry = ids.map(id => catalogue.find(e => text(e.id) === id && e.has_report && has(e.input))).find(Boolean)
      || ids.map(id => catalogue.find(e => text(e.id) === id && (has(e.pde) || has(e.ode)))).find(Boolean);
    if (!entry) return;
    // the evolution equation if the entry has one (a typed text that equals it opens the precomputed report)
    const eq = has(entry.pde) && text(entry.kind) !== 'system' ? entry.pde : (entry.has_report && has(entry.input) ? entry.input : text(entry.ode) + ' = 0');
    chips[i].href = pageUrl({ eq }); chips[i].title = text(eq);
  });
  engine.detectServer().then(s => {
    if (s) {
      const ev = has(s.engine) ? s.engine : (isObj(s.version) ? s.version.engine : s.version);
      noteBackend(`the server${s.mode ? ' (' + text(s.mode) + ' mode)' : ''}${has(ev) ? ', engine ' + text(ev) : ''}${arr(s.tools).length ? '; tools: ' + arr(s.tools).map(text).join(', ') : ''}`);
      // the server has its own, longer limits
      const sel = $('budget'), q = new URLSearchParams(location.search).get('budget');
      sel.textContent = '';
      for (const [v, label] of [['120', '2 minutes'], ['600', '10 minutes'], ['3600', '1 hour']]) sel.append(el('option', { value: v }, label));
      sel.value = [...sel.options].some(o => o.value === q) ? q : '120';
    } else {
      noteBackend('the engine in your browser (loaded on the first request); catalogue reports are precomputed');
    }
  });
  await route();
  document.documentElement.dataset.ready = '1';
}
main();
