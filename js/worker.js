/* Web Worker: the engine in the browser.
 *
 * A classic worker (importScripts). It loads Pyodide from the jsDelivr CDN (pinned version), the packages sympy and
 * mpmath, unpacks engine/mero.zip (built by site/build.py) and calls
 *      mero.report.analyze(text, mode="light", budget_s=...)   -> report (JSON string or dict)
 *      mero.verify.verify_expr(eq_text, expr_text)             -> dict
 * Messages in :  {type: 'init', zip: <absolute URL of mero.zip>}
 *                {type: 'analyze', id, text, options}      {type: 'verify', id, eq, expr, options}
 * Messages out:  {type: 'status', stage, text}   {type: 'log', line}   {type: 'ready', info}
 *                {type: 'result', id, json}      {type: 'error', id, message, unavailable}
 * Cancelling = the page terminates the worker.
 */
const PYODIDE_VERSION = '0.29.5';              // Python 3.13.2, SymPy 1.13.3, mpmath 1.3.0
const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';

let pyodide = null;
let booting = null;

function post(type, data) { self.postMessage(Object.assign({ type: type }, data || {})); }

const GLUE = `
import sys, os, json, time, importlib, inspect
os.environ.setdefault("MERO_ROOT", "/mero_engine")
os.environ.setdefault("MERO_MODE", "light")
if "/mero_engine/engine" not in sys.path:
    sys.path.insert(0, "/mero_engine/engine")

def _mero_boot():
    info = {"python": sys.version.split()[0]}
    t = time.time()
    import sympy, mpmath
    info["sympy"] = sympy.__version__
    info["mpmath"] = mpmath.__version__
    try:
        import mero
        info["mero"] = getattr(mero, "__version__", "unversioned")
    except Exception as e:
        info["mero"] = None
        info["mero_error"] = "%s: %s" % (type(e).__name__, e)
    for name in ("report", "verify"):
        try:
            importlib.import_module("mero." + name)
            info[name] = True
        except Exception as e:
            info[name] = False
            info[name + "_error"] = "%s: %s" % (type(e).__name__, e)
    info["import_s"] = round(time.time() - t, 2)
    return json.dumps(info)

def _mero_kwargs(fn, kwargs):
    try:
        sig = inspect.signature(fn)
    except Exception:
        return kwargs
    if any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in sig.parameters}

def _mero_json(out):
    if hasattr(out, "to_dict"):
        out = out.to_dict()
    return out if isinstance(out, str) else json.dumps(out, default=str)

def _mero_progress(msg):
    # one line "step: <label>" for each step (the engine may or may not put the prefix itself)
    msg = str(msg)
    print(msg if msg.startswith("step: ") else "step: %s" % (msg,))

def _mero_instrument(R):
    """Live progress: if the report module has no progress hook of its own, announce each step it times."""
    try:
        src = inspect.getsource(R)
    except Exception:
        src = ""
    if "progress" in src:
        return True
    orig = getattr(R, "_call", None)
    if orig is None or getattr(orig, "_mero_wrapped", False):
        return False
    def _call(log, label, fn, *a, **k):
        print("step: %s" % (label,))
        return orig(log, label, fn, *a, **k)
    _call._mero_wrapped = True
    R._call = _call
    return False

def _mero_analyze(text, options_json):
    R = importlib.import_module("mero.report")
    kw = {"mode": "light"}
    kw.update(json.loads(options_json) if options_json else {})
    if _mero_instrument(R):
        kw["progress"] = _mero_progress
    return _mero_json(R.analyze(text, **_mero_kwargs(R.analyze, kw)))

def _mero_verify(eq_text, expr_text, options_json):
    try:
        V = importlib.import_module("mero.verify")
    except Exception as e:
        return json.dumps({"status": "unavailable",
                           "detail": "mero.verify cannot be imported (%s: %s)" % (type(e).__name__, e)})
    f = getattr(V, "verify_expr", None)
    if f is None:
        return json.dumps({"status": "unavailable", "detail": "mero.verify has no function verify_expr"})
    kw = json.loads(options_json) if options_json else {}
    eq = eq_text
    try:
        P = importlib.import_module("mero.parse")
    except Exception:
        P = None
    if P is not None and hasattr(P, "parse_ode"):
        try:
            eq = P.parse_ode(eq_text)
        except Exception as e:
            return json.dumps({"status": "undecided",
                               "detail": "the equation could not be read (%s: %s)" % (type(e).__name__, e)})
    return _mero_json(f(eq, expr_text, **_mero_kwargs(f, kw)))
`;

async function boot(zipUrl) {
  post('status', { stage: 'pyodide', text: 'Loading Pyodide, a Python interpreter for the browser (10–15 MB the first time; the browser keeps it afterwards)…' });
  try {
    importScripts(PYODIDE_BASE + 'pyodide.js');
  } catch (e) {
    throw new Error('Pyodide could not be loaded from cdn.jsdelivr.net (' + (e && e.message ? e.message : e) + '). The engine in the browser needs this download once.');
  }
  pyodide = await self.loadPyodide({
    indexURL: PYODIDE_BASE,
    stdout: function (line) { post('log', { line: line }); },
    stderr: function (line) { post('log', { line: line }); },
  });
  post('status', { stage: 'packages', text: 'Loading SymPy and mpmath…' });
  await pyodide.loadPackage(['sympy', 'mpmath'], {
    messageCallback: function (m) { post('log', { line: m }); },
    errorCallback: function (m) { post('log', { line: m }); },
  });
  post('status', { stage: 'engine', text: 'Unpacking the engine…' });
  const res = await fetch(zipUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('The engine archive could not be fetched (HTTP ' + res.status + ').');
  const buf = await res.arrayBuffer();
  pyodide.FS.mkdirTree('/mero_engine');
  pyodide.unpackArchive(buf, 'zip', { extractDir: '/mero_engine' });
  atlasUrl = zipUrl.replace(/mero\.zip(\?.*)?$/, 'atlas.zip');
  post('status', { stage: 'import', text: 'Starting SymPy (ten to twenty seconds)…' });
  const info = JSON.parse(await pyodide.runPythonAsync(GLUE + '\n_mero_boot()'));
  info.pyodide = PYODIDE_VERSION;
  post('ready', { info: info });
  return info;
}

// The records of the earlier atlas (read by mero.atlasdb; same relative layout as in the repository). They are
// fetched only when an analysis asks for the look-up. Absence is not an error: the look-up is then switched off.
let atlasUrl = null, atlasState = 'none';
async function ensureAtlas() {
  if (atlasState !== 'none') return atlasState === 'loaded';
  atlasState = 'absent';
  try {
    post('status', { stage: 'atlas', text: 'Loading the atlas records (4 MB, once)…' });
    const res = await fetch(atlasUrl, { cache: 'no-cache' });
    if (res.ok && !/text\/html/.test(res.headers.get('content-type') || '')) {
      pyodide.unpackArchive(await res.arrayBuffer(), 'zip', { extractDir: '/mero_engine' });
      atlasState = 'loaded';
    }
  } catch (e) { post('log', { line: 'atlas records not loaded: ' + (e && e.message ? e.message : e) }); }
  return atlasState === 'loaded';
}

function callPython(name, args) {
  const f = pyodide.globals.get(name);
  try { return f.apply(null, args); } finally { if (f && f.destroy) f.destroy(); }
}

function describe(e) {
  let msg = e && e.message ? String(e.message) : String(e);
  const unavailable = /ModuleNotFoundError: No module named 'mero\.report'|No module named 'mero'/.test(msg);
  return { message: msg, unavailable: unavailable };
}

self.onmessage = async function (ev) {
  const m = ev.data || {};
  try {
    if (m.type === 'init') {
      if (!booting) booting = boot(m.zip);
      await booting;
      return;
    }
    if (!booting) throw new Error('The worker was not initialised.');
    await booting;
    if (m.type === 'analyze') {
      const options = Object.assign({}, m.options || {});
      if (options.atlas !== false && !(await ensureAtlas())) options.atlas = false;
      post('status', { stage: 'run', text: 'Analysing the equation…' });
      const json = callPython('_mero_analyze', [String(m.text), JSON.stringify(options)]);
      post('result', { id: m.id, json: json });
    } else if (m.type === 'verify') {
      post('status', { stage: 'run', text: 'Substituting the candidate into the equation…' });
      const json = callPython('_mero_verify', [String(m.eq), String(m.expr), JSON.stringify(m.options || {})]);
      post('result', { id: m.id, json: json });
    }
  } catch (e) {
    const d = describe(e);
    post('error', { id: m.id, message: d.message, unavailable: d.unavailable, boot: m.type === 'init' });
  }
};
