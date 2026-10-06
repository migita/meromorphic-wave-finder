// One front end, two back ends.
//   1. the server of the heavy version, if ./api/ping answers:  POST ./api/analyze {"text", "options"} -> report
//                                                               POST ./api/verify  {"equation", "expr", "options"} -> dict
//   2. otherwise the engine in the browser: a Web Worker with Pyodide (js/worker.js).
// All URLs are relative to the page, so the site works under any sub-path.

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

function emit(name, arg) { try { if (hooks[name]) hooks[name](arg); } catch (e) { console.warn(e); } }

function startWorker() {
  if (worker) return ready;
  worker = new Worker(url('./js/worker.js'));
  ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    worker.onmessage = ev => {
      const m = ev.data || {};
      if (m.type === 'status') emit('onStatus', m);
      else if (m.type === 'log') emit('onLog', m.line);
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

async function callWorker(msg) {
  await startWorker();
  const id = ++nextId;
  const out = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ id }, msg));
  });
  return typeof out === 'string' ? JSON.parse(out) : out;
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
    const report = await callWorker({ type: 'analyze', text: textInput, options: Object.assign({ mode: 'light' }, options) });
    return { report, backend: 'browser', info: engineInfo };
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
  const e = new Error('cancelled'); e.cancelled = true;
  if (abortServer) abortServer.abort();
  if (worker) stopWorker(e);
}
export function info() { return engineInfo; }
export function busy() { return active > 0; }
