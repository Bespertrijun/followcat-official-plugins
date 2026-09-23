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
// http.* mocking: requests are returned as 200/{} stubs unless ALLOW_HTTP=1 env
// is set, in which case Node's built-in fetch is used synchronously via a
// child node process (slow but accurate).

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { spawnSync } = require('child_process');

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

function httpReal(method, url, body, headers) {
  // Spawn a fresh node -e to run async fetch synchronously (dev-only convenience)
  const code = `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          headers: ${JSON.stringify(headers || {})},
          body: ${body == null ? 'undefined' : JSON.stringify(body)}
        });
        const text = await r.text();
        const out = {
          status: r.status,
          headers: Object.fromEntries(r.headers),
          body: text.length > 5 * 1024 * 1024 ? text.slice(0, 5 * 1024 * 1024) : text,
          truncated: text.length > 5 * 1024 * 1024
        };
        process.stdout.write(JSON.stringify(out));
      } catch (e) {
        process.stdout.write(JSON.stringify({ __err: String(e) }));
      }
    })();`;
  const child = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  if (child.status !== 0) throw new Error('http subprocess failed: ' + child.stderr);
  const result = JSON.parse(child.stdout || '{}');
  if (result.__err) throw new Error(result.__err);
  return result;
}

function httpMock(method, url, body, headers) {
  log.info('[http stub] ' + method + ' ' + url + ' (set ALLOW_HTTP=1 for real requests)');
  return { status: 200, headers: {}, body: '{"mocked":true}', truncated: false };
}

const httpFn = allowHttp ? httpReal : httpMock;
const http = {
  get:    function (url, headers)        { return httpFn('GET',    url, null, headers); },
  post:   function (url, body, headers)  { return httpFn('POST',   url, body, headers); },
  put:    function (url, body, headers)  { return httpFn('PUT',    url, body, headers); },
  delete: function (url, headers)        { return httpFn('DELETE', url, null, headers); },
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
        try {
          const result = fn(params.data || {});
          // should_download is a synchronous veto hook — capture its return value
          if (params.hook === 'should_download') {
            reply({ ok: true, result: result === undefined ? null : result });
          } else {
            reply({ ok: true });
          }
        } catch (e) {
          // Real host swallows hook errors and increments panic_count; here we surface them
          fail(e);
        }
        break;
      }

      case 'callApi': {
        const fn = apis[params.path];
        if (!fn) return fail('api not registered: ' + params.path);
        try {
          const out = fn(params.req || { method: 'GET', body: '', query: {} });
          reply({ result: out });
        } catch (e) {
          fail(e);
        }
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
