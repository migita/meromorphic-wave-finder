// "Check a solution": substitute a closed-form candidate into an equation with mero.verify.verify_expr.
import { initPage, el, text, has, isObj, mathOf, rich, parseWhere, substitute } from './common.js';
import * as engine from './engine.js';

const $ = id => document.getElementById(id);
let runNo = 0, timer = null;

const STATUS = {
  zero: { cls: 'zero', title: 'The residual is exactly zero', text: 'The candidate satisfies the equation identically. The check is exact.' },
  nonzero: { cls: 'nonzero', title: 'The residual is not zero', text: 'The candidate does not satisfy the equation.' },
  undecided: { cls: 'undecided', title: 'Could not decide', text: 'The engine could not reduce the residual to zero and could not show that it is different from zero. Nothing is claimed.' },
  unavailable: { cls: 'unavailable', title: 'The checker is not available', text: 'This build of the engine has no checker (mero.verify.verify_expr).' },
};
function statusKey(s) {
  const t = text(s).toLowerCase().trim();
  if (['zero', 'pass', 'exact zero', 'ok', 'true'].includes(t)) return 'zero';
  if (['not zero', 'nonzero', 'non-zero', 'fail', 'false'].includes(t)) return 'nonzero';
  if (t === 'unavailable') return 'unavailable';
  return 'undecided';
}

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
  onLog: line => { const log = $('status-log'); log.textContent += (log.textContent ? '\n' : '') + text(line); log.scrollTop = log.scrollHeight; },
};

function showResult(res, ctx) {
  const out = $('result');
  out.textContent = '';
  const r = isObj(res) ? res : { status: 'undecided', detail: text(res) };
  const key = statusKey(r.status);
  const info = STATUS[key];
  const box = el('section', { class: 'check-result ' + info.cls, 'data-status': key, 'aria-label': 'Result of the check' },
    el('h2', null, info.title), el('p', null, info.text));
  const dl = el('dl', { class: 'facts' });
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') dl.append(el('dt', null, k), el('dd', null, v)); };
  add('equation', el('code', { class: 'sympy' }, ctx.eq));
  if (has(r.expr)) add('candidate as read', mathOf(text(r.expr), r.expr_latex || r.latex, { jets: false }));
  if (ctx.pairs.length) add('with', el('code', { class: 'sympy' }, ctx.pairs.map(p => `${p[0]} = ${p[1]}`).join('; ')));
  if (has(r.detail)) add('what the engine did', rich(r.detail));
  if (has(r.numeric)) add('numerical residual (not a proof)', text(r.numeric));
  for (const [k, v] of Object.entries(r)) {
    if (['status', 'detail', 'expr', 'expr_latex', 'latex', 'numeric'].includes(k) || !has(v)) continue;
    add(k.replace(/_/g, ' '), typeof v === 'string' ? rich(v) : el('code', { class: 'sympy' }, JSON.stringify(v)));
  }
  add('computed', ctx.backend === 'server' ? 'by the server' : 'in your browser');
  box.append(dl);
  out.append(box);
  window.__lastCheck = r;
}

async function run() {
  const eq0 = $('c-eq').value.trim(), expr0 = $('c-expr').value.trim();
  const out = $('result');
  out.textContent = '';
  if (!eq0 || !expr0) { out.append(el('div', { class: 'notice plain' }, el('p', null, 'Enter an equation and a candidate.'))); return; }
  let pairs;
  try { pairs = parseWhere($('c-where').value); }
  catch (e) { out.append(el('div', { class: 'notice' }, el('p', null, 'Values: ' + e.message + '.'))); return; }
  const eq = substitute(eq0, pairs), expr = substitute(expr0, pairs);
  const q = new URLSearchParams({ eq: eq0, expr: expr0 });
  if ($('c-where').value.trim()) q.set('where', $('c-where').value.trim());
  history.replaceState(null, '', location.pathname + '?' + q.toString());
  const my = ++runNo;
  if (engine.busy()) engine.cancel();
  showStatus('Starting the engine…');
  $('c-go').disabled = true;
  try {
    const { result, backend } = await engine.verify(eq, expr, {}, hooks);
    if (my !== runNo) return;
    showResult(result, { eq, pairs, backend });
  } catch (e) {
    if (my !== runNo) return;
    if (e && e.cancelled) out.append(el('div', { class: 'notice plain' }, el('p', null, 'Cancelled.')));
    else {
      console.warn('check failed', e);
      out.append(el('div', { class: 'notice' }, el('p', null, el('strong', null, 'The engine stopped with an error. '), 'Nothing is claimed about this candidate.'),
        el('pre', { class: 'raw' }, text(e && e.message ? e.message : e))));
    }
  } finally {
    if (my === runNo) { hideStatus(); $('c-go').disabled = false; }
  }
}

async function main() {
  await initPage();
  const q = new URLSearchParams(location.search);
  if (has(q.get('eq'))) $('c-eq').value = q.get('eq');
  if (has(q.get('expr'))) $('c-expr').value = q.get('expr');
  if (has(q.get('where'))) $('c-where').value = q.get('where');
  $('check').addEventListener('submit', ev => { ev.preventDefault(); run(); });
  $('cancel').addEventListener('click', () => { runNo++; engine.cancel(); hideStatus(); $('c-go').disabled = false;
    $('result').textContent = ''; $('result').append(el('div', { class: 'notice plain' }, el('p', null, 'Cancelled.'))); });
  engine.detectServer().then(s => { $('backend').textContent = s ? 'Runs on the server.' : 'Runs in your browser; the engine (10–15 MB) is loaded on the first check.'; });
  document.documentElement.dataset.ready = '1';
  if (q.get('run') === '1' && has(q.get('eq')) && has(q.get('expr'))) run();
}
main();
