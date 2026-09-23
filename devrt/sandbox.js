// Plugin Dev Runtime — Node sandbox
// =====================================
//
// Loads <plugin>/index.js inside Node's `vm` module with goja-compatible globals
// injected (plugin / log / config / http / anime / task), then talks JSON-RPC to
// the Python parent over stdin/stdout.
//
// Protocol (newline-delimited JSON):
//
//   parent → child:
//     { id, method: "init",            params: {} }
//     { id, method: "trigger",         params: { hook, data } }
//     { id, method: "callApi",         params: { path, req: {method, body, query} } }
//     { id, method: "configReplace",   params: { entries: { k: v } } }
//     { id, method: "shutdown",        params: {} }
//
//   child → parent:
//     { id, result }                   ← rpc reply
//     { id, error: "..." }
//     { event: "log",   level, args }  ← unsolicited events
//     { event: "config", key, value }  ← when plugin code calls config.set
//     { event: "ready", hooks: [...], apis: [...] }
//
// http.* mirrors the host (async facade): every method returns a Promise.
// Requests are resolved with 200/{} stubs unless ALLOW_HTTP=1 env is set, in
// which case Node's built-in fetch is used (10s per request, 5 MiB body cap,
// 60 req/min token bucket, failures reject with a GoError-shaped Error whose
// message is "http <METHOD> <url>: <cause>" like the host).
//
// Callbacks (hook / registerAPI / should_download) may return a Promise; the
// dispatcher awaits it with the host's wall-clock timeouts (including await
// time): hook 10s, API 10s, should_download 3s (fail-open). A rejection is
// handled like a throw; a late settlement after the timeout is ignored.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { types: utilTypes } = require('util');

const pluginDir = process.argv[2];
if (!pluginDir) {
  process.stderr.write('usage: node sandbox.js <plugin_dir>\n');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf-8'));
const indexJs = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf-8');
const allowHttp = process.env.ALLOW_HTTP === '1';

// ─── outbound wire ──────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitEvent(event, extra) {
  send(Object.assign({ event }, extra));
}

// ─── host facades ───────────────────────────────────────────────────────────

const hooks = Object.create(null);   // hookName → fn
const apis = Object.create(null);    // path     → fn
let configStore = Object.create(null);

const log = {
  info:  function () { emitEvent('log', { level: 'info',  args: Array.from(arguments).map(String) }); },
  warn:  function () { emitEvent('log', { level: 'warn',  args: Array.from(arguments).map(String) }); },
  error: function () { emitEvent('log', { level: 'error', args: Array.from(arguments).map(String) }); },
};

const config = {
  get: function (key) {
    const v = configStore[key];
    return v === undefined ? null : v;
  },
  set: function (key, value) {
    if (typeof value !== 'string') {
      throw new Error('config.set: value must be a string (got ' + typeof value + ')');
    }
    configStore[key] = value;
    emitEvent('config', { key, value });
  },
};

// Host constants (internal/plugin/host_api.go, engine.go, worker.go)
const HTTP_TIMEOUT_MS = 10000;          // asyncCallTimeout: fixed 10s per request
const HTTP_RESPONSE_LIMIT = 5 * 1024 * 1024;
const HTTP_RATE_BURST = 60;             // token bucket: 60 burst, +1 / second
const HOOK_TIMEOUT_MS = 10000;          // workerHookTimeout
const API_TIMEOUT_MS = 10000;           // workerAPITimeout
const FILTER_TIMEOUT_MS = 3000;         // workerFilterTimeout (fail-open)
const ERR_RUNTIME_TIMEOUT = 'plugin runtime: execution timeout';

// Filled in once the vm context exists: Promise / Error of the plugin realm, so
// `http.get(...) instanceof Promise` and `e instanceof Error` hold inside the plugin.
let CtxPromise = Promise;
let CtxError = Error;

// Host rejects with rt.NewGoError(err): an Error whose name is "GoError".
function goError(message) {
  const e = new CtxError(message);
  e.name = 'GoError';
  return e;
}

const rateBucket = { tokens: HTTP_RATE_BURST, lastRefill: Date.now() };
function rateAllow() {
  const now = Date.now();
  const elapsed = Math.floor((now - rateBucket.lastRefill) / 1000);
  if (elapsed > 0) {
    rateBucket.tokens = Math.min(HTTP_RATE_BURST, rateBucket.tokens + elapsed);
    rateBucket.lastRefill = now;
  }
  if (rateBucket.tokens <= 0) return false;
  rateBucket.tokens--;
  return true;
}

// Go's http.CanonicalHeaderKey: "content-type" → "Content-Type"
function canonicalHeaderKey(k) {
  return String(k).split('-').map(function (p) {
    return p.length ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p;
  }).join('-');
}

// Host keeps the first value per header. Node's fetch joins repeated headers
// with ", " (except Set-Cookie), so repeated non-cookie headers show the joined value.
function headersMap(h) {
  const out = {};
  h.forEach(function (v, k) { out[canonicalHeaderKey(k)] = v; });
  if (typeof h.getSetCookie === 'function') {
    const sc = h.getSetCookie();
    if (sc.length > 0) out['Set-Cookie'] = sc[0];
  }
  return out;
}

async function httpReal(method, url, body, headers) {
  let resp;
  try {
    resp = await fetch(url, {
      method: method,
      headers: headers || {},
      body: body == null || body === '' ? undefined : body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e && e.name === 'TimeoutError') ? 'context deadline exceeded'
      : String((e && e.cause && e.cause.message) || (e && e.message) || e);
    throw goError('http ' + method + ' ' + url + ': ' + cause);
  }
  let buf;
  try {
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    throw goError('read response: ' + String((e && e.message) || e));
  }
  const truncated = buf.length > HTTP_RESPONSE_LIMIT;
  if (truncated) buf = buf.subarray(0, HTTP_RESPONSE_LIMIT);
  return { status: resp.status, headers: headersMap(resp.headers), body: buf.toString('utf-8'), truncated: truncated };
}

async function httpMock(method, url, body, headers) {
  log.info('[http stub] ' + method + ' ' + url + ' (set ALLOW_HTTP=1 for real requests)');
  return { status: 200, headers: {}, body: '{"mocked":true}', truncated: false };
}

const httpFn = allowHttp ? httpReal : httpMock;

// Every http.* call returns a Promise (no sync alias). Rate limit is checked at
// call time like the host and surfaces as a rejection, not a synchronous throw.
function httpCall(method, url, body, headers) {
  return new CtxPromise(function (resolve, reject) {
    if (!rateAllow()) {
      reject(goError('plugin http rate limit exceeded (60 req/min)'));
      return;
    }
    httpFn(method, String(url), body == null ? '' : String(body), headers).then(resolve, reject);
  });
}

const http = {
  get:    function (url, headers)        { return httpCall('GET',    url, null, headers); },
  post:   function (url, body, headers)  { return httpCall('POST',   url, body, headers); },
  put:    function (url, body, headers)  { return httpCall('PUT',    url, body, headers); },
  delete: function (url, headers)        { return httpCall('DELETE', url, null, headers); },
};

const anime = {
  get: function (id) {
    return { id, title: 'Mock Anime ' + id, mikan_id: '', douban_id: '', total_ep: 12, ep_num: 1, status: 'tracking' };
  },
};

const task = {
  get: function (id) {
    return { task_id: id, anime_title: 'Mock Anime', status: 'running', episodes_done: 1, episodes_total: 12, last_event_at: new Date().toISOString() };
  },
  list: function () {
    return [
      { task_id: 'task-1', anime_title: 'Mock Anime A', status: 'running', episodes_done: 3, episodes_total: 12, last_event_at: new Date().toISOString() },
      { task_id: 'task-2', anime_title: 'Mock Anime B', status: 'done',    episodes_done: 12, episodes_total: 12, last_event_at: new Date().toISOString() },
    ];
  },
};

const declaredHooks = new Set(manifest.hooks || []);
const declaredPerms = new Set(manifest.permissions || []);

const HOOK_PERM_REQ = {
  on_episode_found: 'hook.download',
  on_download_done: 'hook.download',
  on_download_failed: 'hook.download',
  on_link_done: 'hook.link',
  on_link_failed: 'hook.link',
  on_task_completed: 'hook.task',
  on_task_reopened: 'hook.task',
  on_notification_before_send: 'hook.notify',
  on_notification_after_send: 'hook.notify',
  should_download: 'hook.download',
};

const plugin = {
  on: function (name, fn) {
    if (!declaredHooks.has(name)) {
      throw new Error('plugin.on: hook "' + name + '" not in manifest.hooks');
    }
    const reqPerm = HOOK_PERM_REQ[name];
    if (reqPerm && !declaredPerms.has(reqPerm)) {
      throw new Error('plugin.on: hook "' + name + '" requires permission "' + reqPerm + '"');
    }
    hooks[name] = fn;
  },
  registerAPI: function (path, fn) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('plugin.registerAPI: path must start with "/"');
    }
    apis[path] = fn;
  },
};

// ─── execution ──────────────────────────────────────────────────────────────

const ruleflow = {
  list: function () { return []; },
};

const sandbox = {
  plugin, log, config,
  // Conditionally inject anime/task/http/ruleflow only when the matching
  // permission is declared, mirror host (internal/plugin/runtime.go)
  anime: declaredPerms.has('api.anime.read') ? anime : undefined,
  task: declaredPerms.has('api.task.read') ? task : undefined,
  http: declaredPerms.has('api.http') ? http : undefined,
  ruleflow: declaredPerms.has('api.ruleflow') ? ruleflow : undefined,
  // utility: runtime needs Date / JSON / Math / etc — vm provides them by default
  setTimeout: undefined,        // goja: no timers
  setInterval: undefined,
  console: { log: log.info, warn: log.warn, error: log.error },
};

vm.createContext(sandbox);
CtxPromise = vm.runInContext('Promise', sandbox);
CtxError = vm.runInContext('Error', sandbox);

let loadError = null;
try {
  vm.runInContext(indexJs, sandbox, {
    filename: path.join(pluginDir, 'index.js'),
    timeout: 10000,
  });
} catch (e) {
  loadError = String(e && e.stack || e);
}

emitEvent('ready', {
  hooks: Object.keys(hooks),
  apis: Object.keys(apis),
  manifest,
  loadError,
});

// ─── callback invocation (mirrors host worker.invoke) ────────────────────────

function timeoutError() {
  const e = new Error(ERR_RUNTIME_TIMEOUT);
  e.devrtTimeout = true;
  return e;
}

// Runs fn(...args) with the host's wall-clock budget (including await time).
//   - synchronous segment runs via vm with `timeout` → a pure-JS infinite loop is
//     interrupted, like the host's rt.Interrupt
//   - a returned Promise is awaited for the remaining budget; late settlement ignored
//   - throw / rejection → rejected Promise (handled as a throw)
// Continuations after an await are not policed (same as the host).
let invokeSeq = 0;
function invokeWithTimeout(fn, args, budgetMs) {
  const start = Date.now();
  const slot = '__devrt_call_' + (++invokeSeq);
  let value;
  sandbox[slot] = { fn: fn, args: args };
  try {
    value = vm.runInContext(slot + '.fn.apply(undefined, ' + slot + '.args)', sandbox, { timeout: budgetMs });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Promise.reject(timeoutError());
    return Promise.reject(e);
  } finally {
    delete sandbox[slot];
  }
  if (!utilTypes.isPromise(value)) return Promise.resolve(value);
  const remaining = Math.max(0, budgetMs - (Date.now() - start));
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(timeoutError()); }, remaining);
    value.then(function (v) { clearTimeout(timer); resolve(v); },
               function (e) { clearTimeout(timer); reject(e); });
  });
}

// ─── rpc loop ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', function (line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  function reply(result) { send({ id, result }); }
  function fail(err)     { send({ id, error: String(err && err.stack || err) }); }

  try {
    switch (method) {
      case 'init':
        reply({ hooks: Object.keys(hooks), apis: Object.keys(apis), manifest, loadError });
        break;

      case 'configReplace':
        configStore = Object.assign(Object.create(null), params.entries || {});
        reply({ ok: true });
        break;

      case 'configGetAll':
        reply({ entries: Object.assign({}, configStore) });
        break;

      case 'trigger': {
        const fn = hooks[params.hook];
        if (!fn) return fail('hook not registered: ' + params.hook);
        const isFilter = params.hook === 'should_download';
        invokeWithTimeout(fn, [params.data || {}], isFilter ? FILTER_TIMEOUT_MS : HOOK_TIMEOUT_MS).then(function (result) {
          // should_download is the veto hook — capture its (awaited) return value
          if (isFilter) {
            reply({ ok: true, result: result === undefined ? null : result });
          } else {
            reply({ ok: true });
          }
        }, function (e) {
          if (isFilter && e && e.devrtTimeout) {
            // Host: should_download timeout → fail-open (allow); late result ignored
            log.warn('[devrt] should_download timed out after ' + FILTER_TIMEOUT_MS + 'ms → fail-open (allow)');
            reply({ ok: true, result: null, fail_open: true, error: ERR_RUNTIME_TIMEOUT });
            return;
          }
          // Real host swallows hook errors / rejections (WARN + last_error); here we surface them
          fail(e);
        });
        break;
      }

      case 'callApi': {
        const fn = apis[params.path];
        if (!fn) return fail('api not registered: ' + params.path);
        invokeWithTimeout(fn, [params.req || { method: 'GET', body: '', query: {} }], API_TIMEOUT_MS).then(function (out) {
          reply({ result: out });
        }, fail);
        break;
      }

      case 'shutdown':
        reply({ ok: true });
        process.exit(0);
        break;

      default:
        fail('unknown method: ' + method);
    }
  } catch (e) {
    fail(e);
  }
});

rl.on('close', function () { process.exit(0); });
