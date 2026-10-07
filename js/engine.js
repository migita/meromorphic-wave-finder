// One front end, two back ends.
//   1. the server of the heavy version, if ./api/ping answers:  POST ./api/analyze {"text", "options"} -> report
//                                                               POST ./api/verify  {"equation", "expr", "options"} -> dict
//   2. otherwise the engine in the browser: a Web Worker with Pyodide (js/worker.js).
// All URLs are relative to the page, so the site works under any sub-path.
//
// The engine in the browser can meet a single computation that does not end; the limits of the engine itself cannot
// stop it from inside. The page can: it terminates the worker. analyze() therefore watches the worker: if there is
// no answer 2 * budget + 30 seconds after the analysis was posted to a ready worker, the worker is terminated and
// the same text is analysed again in a new worker with the option skip_steps = the steps that did not end (their
// labels are the text after "step: " in the lines the engine prints). At most three repetitions; then an error
// that says which steps did not end.

const base = () => document.baseURI;
const url = rel => new URL(rel, base()).href;

let serverPromise = null;               // resolves to null (no server) or to the answer of ./api/ping
export function detectServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(url('./api/ping'), { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) return null;
        const j = JSON.parse(await res.text());      // a static host that answers 200 with a page is not the server
        return (j !== null && typeof j === 'object') ? j : { ok: true };
      } catch { return null; }
    })();
  }
  return serverPromise;
}
export function forgetServer() { serverPromise = null; }

// ---- the worker ----------------------------------------------------------------------------------------------
let worker = null, ready = null, rejectReady = null, engineInfo = null, nextId = 0;
const pending = new Map();
let hooks = {};
let abortServer = null;
let active = 0;
let lastStep = null;                    // label of the last line "step: <label>" of the running analysis
let cancelSeq = 0;                      // counts the calls of cancel(): an analysis that was cancelled is not repeated
export const MAX_REPETITIONS = 3;
export const watchdogSeconds = budget => 2 * (Number(budget) > 0 ? Number(budget) : 30) + 30;

function emit(name, arg) { try { if (hooks[name]) hooks[name](arg); } catch (e) { console.warn(e); } }

function startWorker() {
  if (worker) return ready;
  worker = new Worker(url('./js/worker.js'));
  ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    worker.onmessage = ev => {
      const m = ev.data || {};
      if (m.type === 'status') emit('onStatus', m);
      else if (m.type === 'log') {
        const s = /^(?:step:\s*)+(.*\S)\s*$/.exec(String(m.line));
        if (s) lastStep = s[1];
        emit('onLog', m.line);
      }
      else if (m.type === 'ready') { engineInfo = m.info; emit('onReady', m.info); resolve(m.info); }
      else if (m.type === 'result' || m.type === 'error') {
        if (m.type === 'error' && m.boot) { const e = new Error(m.message); e.boot = true; reject(e); stopWorker(e); return; }
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'result') p.resolve(m.json);
        else { const e = new Error(m.message); e.unavailable = !!m.unavailable; e.python = true; p.reject(e); }
      }
    };
    worker.onerror = ev => {
      const e = new Error('The engine worker failed: ' + (ev && ev.message ? ev.message : 'unknown error'));
      reject(e); stopWorker(e);
    };
  });
  ready.catch(() => {});
  worker.postMessage({ type: 'init', zip: url('./engine/mero.zip') });
  return ready;
}

function stopWorker(err) {
  if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
  if (rejectReady) rejectReady(err);
  worker = null; ready = null; rejectReady = null; engineInfo = null;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

async function callWorker(msg, limitMs = 0) {
  await startWorker();
  const id = ++nextId;
  let timer = null;
  lastStep = null;
  try {
    const out = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg));
      // the watchdog: counted from the moment the request is posted to a worker that is ready
      if (limitMs > 0) {
        timer = setTimeout(() => {
          const e = new Error('The engine in the browser did not answer within the time limit.');
          e.watchdog = true; e.step = lastStep;
          stopWorker(e);                               // terminates the worker; the request is rejected with e
        }, limitMs);
      }
    });
    return typeof out === 'string' ? JSON.parse(out) : out;
  } finally { clearTimeout(timer); }
}

/** the analysis in the browser, repeated without the steps that do not end (see the head of this file) */
async function analyzeInBrowser(textInput, options) {
  const seq = cancelSeq;
  // (options.watchdog_s replaces the limit; it exists for the tests of the two ways in which the watchdog gives up)
  const limitS = Number(options.watchdog_s) > 0 ? Number(options.watchdog_s) : watchdogSeconds(options.budget_s);
  const skipped = [];
  const cancelled = () => { const c = new Error('cancelled'); c.cancelled = true; return c; };
  const quote = list => list.map(s => `“${s}”`).join(', ');
  const within = `${limitS} ${limitS === 1 ? 'second' : 'seconds'}`;
  for (let attempt = 1; ; attempt++) {
    if (seq !== cancelSeq) throw cancelled();
    const opts = Object.assign({ mode: 'light' }, options);
    delete opts.watchdog_s;
    if (skipped.length) opts.skip_steps = skipped.slice();
    try {
      const report = await callWorker({ type: 'analyze', text: textInput, options: opts }, limitS * 1000);
      return { report, repetitions: attempt - 1, skipped: skipped.slice() };
    } catch (e) {
      if (!e || !e.watchdog) throw e;                  // cancelled, or an error of the engine or of its start
      if (seq !== cancelSeq) throw cancelled();
      const step = e.step;
      const fail = msg => { const err = new Error(msg); err.unfinished = true; err.steps = skipped.concat(step && !skipped.includes(step) ? [step] : []); err.limit_s = limitS; err.attempts = attempt; return err; };
      if (!step) {
        throw fail(`The engine in the browser did not answer within ${within} and had not yet named a step of the analysis`
          + (skipped.length ? ` (left out before: ${quote(skipped)})` : '') + '.');
      }
      if (skipped.includes(step)) throw fail(`The analysis did not end within ${within} although the step ${quote([step])} was left out.`);
      if (attempt > MAX_REPETITIONS) {
        throw fail(`The analysis was started ${attempt} times, each time without the steps that had not ended, and did not end: ${quote(skipped.concat([step]))} did not end within ${within} each.`);
      }
      skipped.push(step);
      emit('onRestart', { step, steps: skipped.slice(), repetition: attempt, limit_s: limitS,
        text: `The step ${quote([step])} did not end within ${within}. The analysis is being repeated without ${skipped.length > 1 ? 'the steps ' + quote(skipped) : 'it'}; the answer may be weaker than that of the full analysis.` });
    }
  }
}

async function postServer(path, payload) {
  abortServer = new AbortController();
  try {
    const res = await fetch(url(path), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: abortServer.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      let msg = body.slice(0, 600), timeout = false;
      try { const j = JSON.parse(body); if (j && j.error) { msg = String(j.error); timeout = j.status === 'timeout'; } } catch { /* not JSON */ }
      const e = new Error(timeout ? `The server stopped the analysis at its time limit. ${msg}` : `The server answered HTTP ${res.status}: ${msg}`);
      e.status = res.status; e.timeout = timeout; throw e;
    }
    try { return JSON.parse(body); } catch { throw new Error('The server did not answer with JSON.'); }
  } catch (e) {
    if (e && e.name === 'AbortError') { const c = new Error('cancelled'); c.cancelled = true; throw c; }
    throw e;
  } finally { abortServer = null; }
}

/** Analyse an equation. Returns {report, backend: 'server' | 'browser', info}. */
export async function analyze(textInput, options = {}, h = {}) {
  hooks = h;
  active++;
  try {
    const server = await detectServer();
    if (server) {
      emit('onStatus', { stage: 'server', text: 'The server is analysing the equation…' });
      const report = await postServer('./api/analyze', { text: textInput, options: Object.assign({ mode: 'heavy' }, options) });
      return { report, backend: 'server', info: server };
    }
    const r = await analyzeInBrowser(textInput, options);
    return { report: r.report, backend: 'browser', info: engineInfo, repetitions: r.repetitions, skipped: r.skipped };
  } finally { active--; }
}

/** Substitute a closed-form candidate into an equation. Returns {result, backend}. */
export async function verify(eqText, exprText, options = {}, h = {}) {
  hooks = h;
  active++;
  try { return await verifyInner(eqText, exprText, options); } finally { active--; }
}
async function verifyInner(eqText, exprText, options) {
  const server = await detectServer();
  if (server) {
    emit('onStatus', { stage: 'server', text: 'The server is substituting the candidate…' });
    try {
      const result = await postServer('./api/verify', { equation: eqText, expr: exprText, options });
      return { result, backend: 'server', info: server };
    } catch (e) {
      if (e.cancelled || !(e.status === 404 || e.status === 405 || e.status === 501)) throw e;
      // the server has no checker: use the engine in the browser
    }
  }
  const result = await callWorker({ type: 'verify', eq: eqText, expr: exprText, options });
  return { result, backend: 'browser', info: engineInfo };
}

/** Load the browser engine without a request (returns the versions). */
export async function warmUp(h = {}) { hooks = h; return startWorker(); }

/** Stop whatever is running. The browser engine has to be started again afterwards. */
export function cancel() {
  cancelSeq++;
  const e = new Error('cancelled'); e.cancelled = true;
  if (abortServer) abortServer.abort();
  if (worker) stopWorker(e);
}
export function info() { return engineInfo; }
export function busy() { return active > 0; }
