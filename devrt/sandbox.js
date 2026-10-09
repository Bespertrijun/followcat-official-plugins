// Plugin Dev Runtime — Node sandbox
// =====================================
//
// Loads <plugin>/index.js inside Node's `vm` module with goja-compatible globals
// injected (plugin / log / config / crypto / http / anime / task / ruleflow /
// ptsite / douban / notify), then talks JSON-RPC to
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
// Always-injected globals (mirror internal/plugin/runtime.go setupRuntime):
//   plugin / log / config (get/set/list/delete) / data (in-memory blobs) / crypto + timers.
//   No console, no require; eval and Function are undefined (and string code generation is
//   off at the vm level, so `(function(){}).constructor("...")` fails too).
//   log.* formats each argument like the host's fmt.Sprint of the goja-exported value (objects →
//   "map[a:1 b:x]", arrays → "[1 2]", null / undefined → "<nil>", Error objects → "map[]", floats in Go
//   %v style such as "1.5e+07") and joins them with " "; then escapes \r and \n into the literal
//   two-character sequences (host C2: a plugin log line cannot fake a second line such as an audit row).
//   config.set coerces non-string values like goja does (null / undefined → "", others String(v)),
//   then applies the host's key / value / quota checks (500 keys, 64 KiB per value).
//   config.delete(key) (host R4) is synchronous: same key check as set (bad key → throw), returns
//   whether a key was actually deleted.
//   data.get returns a byte *array* (Go []byte seen from JS: Array.isArray === true, not an
//   ArrayBuffer); wrap it with `new Uint8Array(x)`. data.put accepts that array back (like the host,
//   where it is still a Go []byte) but, like the host, not an array literal such as [1, 2, 3].
//   JSON.parse / JSON.stringify seen by the plugin are guarded like the host (R1): nesting deeper
//   than 1000 levels (parse and stringify) or more than 1,000,000 values (stringify) throws a
//   TypeError instead of taking the process down. Normal input behaves exactly like the built-ins.
//   Everything handed to the plugin (hook / should_download payload, the registerAPI req envelope,
//   structured facade results) is a plain object of the plugin realm (host R3), a fresh copy each time:
//   add / delete fields freely, also under "use strict".
//
// Batch-1 facades (mirror internal/plugin/host_api_{crypto,ptsite,douban}.go):
//   - crypto.*  always injected, synchronous, REAL (node:crypto) so CookieCloud
//     decryption can be exercised locally; returns plugin-realm Uint8Array.
//     base64Decode ignores \r / \n like Go's StdEncoding.
//   - ptsite.*  api.ptsite.read  → list/get/registry/getCookieMeta (sync)
//               api.ptsite.write → setCookie (Promise<{ok}>)
//   - douban.*  api.douban.cookie.read  → getCookie() (sync)
//               api.douban.cookie.write → setCookie(v, {validate}) (Promise<{ok, validation}>)
//   Objects are injected per domain and methods mounted per permission (read-only
//   ⇒ no write methods). Mock data lives in memory; writes emit an "[audit]" log line
//   (action + target only, never the value) like the host's audit/plugin/<id> rows.
//   ptsite.list/get carry the read-only `hosts` (hostnames of the row's mock RSS URLs,
//   lowercased, de-duplicated, first-seen order; never the URL itself).
//   DEVRT_DOUBAN_VALIDATION=<ok|cookie_invalid|rate_limited|unreachable> picks the
//   mocked validation result (default "ok").
//
// notify.send (api.notify.send; mirror internal/plugin/host_api_notify.go + internal/notify/plugin.go):
//   injected only with the permission. Same synchronous TypeErrors ("notify.send: ...") for a non-object
//   argument / wrong field types (text fields must be primitive strings; the button structure is read
//   directly, only button data goes through JSON), same Chinese reject reasons in the host's order (an action
//   button whose action is not in manifest.actions first, then title, body, body links, image, buttons, then
//   the quota). The body is parsed with a port of the host's FC-Markdown parser: invalid [text](url) links,
//   bare "scheme://userinfo@" in text nodes (not code) and over-long links. URLs are checked with a port of
//   Go net/url + the host's IDNA chain — Node's domainToASCII stands in for the strict x/net/idna lookup
//   profile, so unusual internationalized hosts may differ. Nothing is delivered: an accepted message is
//   printed to the log panel ("[notify.send] {...}", with the host's "🧩 [<name>]" prefix and the button
//   rows) and resolves {queued: true, channels: N}. DEVRT_NOTIFY_CHANNELS sets N (default 1; 0 = nothing
//   configured, which is not counted against the quota); DEVRT_NOTIFY_MAX_PER_HOUR sets the quota (default
//   300, like the host). The queue-full reject, image download and button label truncation are not simulated.
//
// on_notify_action / on_bot_command (api.notify.send; mirror internal/notify/actions.go + commands.go and
// the plugin side of internal/plugin/manager_interact.go): the "trigger" RPC plays a click / a command with
// the payload it is given and replies with what the user would see (answer / line for a click, reply for a
// command), applying the manifest declaration and requires checks, the 10s budget and the R10 reply rules.
// manifest.actions / manifest.commands are validated like internal/plugin/manifest.go Parse.
//
// Timers (host opened them 2026-09-25): setTimeout / setInterval / setImmediate and the
// clear* functions are Node's own. Like the host, a callback that throws or returns a
// rejected Promise only logs a WARN ("<kind> callback error: ...") — it never kills the
// sandbox, and other callbacks keep running. Handles are Node Timeout objects (the host
// returns numbers); treat them as opaque and only pass them back to clear*.
//
// Callbacks (hook / registerAPI / should_download) may return a Promise; the
// dispatcher awaits it with the host's wall-clock timeouts (including await
// time): hook 10s, API 10s, should_download 3s (fail-open). A rejection is
// handled like a throw; a late settlement after the timeout is ignored.
//
// Microtasks: the context runs with microtaskMode "afterEvaluate", so every piece of plugin
// code — the entry script, a hook / API call, a timer callback, and the continuations after
// an `await` — runs inside a vm evaluation that has a timeout. An infinite loop written after
// an `await` (or in a timer callback) is interrupted after CONTINUATION_GUARD_MS instead of
// freezing devrt. DEVRT-ONLY: the host does not police continuations / timer callbacks (such
// a loop hangs the plugin there until it is disabled). When host code settles a plugin
// Promise from outside (http.* replies), drainMicrotasks() runs the queued continuations.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const nodeCrypto = require('crypto');
const { types: utilTypes } = require('util');
const { normalizeCookie } = require('./cookie-normalize');

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

// Host (C2): \r and \n in a plugin log message become the literal two characters, so a plugin
// cannot start a fake second line (e.g. something that looks like an audit row)
function escapeLogText(s) {
  return String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

// ── host log formatting: joinArgs = fmt.Sprint(Export(arg)) for each argument, joined with " " ──
// goja exports: integer-valued safe numbers → int64, other numbers → float64, objects → map (own
// enumerable keys; Go prints maps sorted by key), arrays → slices, Date → time.Time, TypedArray →
// []T, Map → [][2]any, null / undefined → nil.
function goFloat(n) {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Object.is(n, -0)) return '-0';
  // Go %v on float64 = strconv 'g' with the shortest digits: exponent form when exp < -4 || exp >= 6
  // (fmt.Println(1e6) → "1e+06", 123456789.5 → "1.234567895e+08"), exponent at least two digits
  const e = n.toExponential();              // shortest round-trip mantissa, e.g. "1.234567895e+8"
  const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(e);
  const exp = Number(m[2] + m[3]);
  if (exp < -4 || exp >= 6) return m[1] + 'e' + m[2] + (m[3].length < 2 ? '0' + m[3] : m[3]);
  return String(n);
}
function goNumber(n) {
  if (Number.isSafeInteger(n) && !Object.is(n, -0)) return String(n);
  return goFloat(n);
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
// Go time.Time.String(): "2006-01-02 15:04:05.999999999 -0700 MST" (local zone; zone name approximated)
function goTime(d) {
  if (Number.isNaN(d.getTime())) return '0001-01-01 00:00:00 +0000 UTC';
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  let frac = '';
  if (d.getMilliseconds()) frac = ('.' + String(d.getMilliseconds()).padStart(3, '0')).replace(/0+$/, '');
  let zone = '';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
    zone = part ? part.value : '';
  } catch (e) { zone = ''; }
  if (off === 0) zone = 'UTC';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + frac + ' ' +
    sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60) + (zone ? ' ' + zone : '');
}
function goSprint(v, seen) {
  if (v === null || v === undefined) return '<nil>';
  switch (typeof v) {
    case 'string': return v;
    case 'number': return goNumber(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return String(v);
    case 'symbol': return v.description === undefined ? '' : v.description;
    case 'function': return '0x0'; // the host prints the Go function pointer address, e.g. 0x7523a0
  }
  seen = seen || new Set();
  if (seen.has(v)) return '<cycle>';
  seen.add(v);
  try {
    if (utilTypes.isDate(v)) return goTime(v);
    if (utilTypes.isTypedArray(v)) return '[' + Array.from(v, (x) => goSprint(x, seen)).join(' ') + ']';
    if (Array.isArray(v)) return '[' + Array.from(v, (x) => goSprint(x, seen)).join(' ') + ']';
    if (utilTypes.isMap(v)) return '[' + Array.from(v, (kv) => '[' + goSprint(kv[0], seen) + ' ' + goSprint(kv[1], seen) + ']').join(' ') + ']';
    if (utilTypes.isSet(v)) return '[' + Array.from(v, (x) => goSprint(x, seen)).join(' ') + ']';
    const keys = Object.keys(v).sort(byteOrder);
    return 'map[' + keys.map((k) => k + ':' + goSprint(v[k], seen)).join(' ') + ']';
  } finally {
    seen.delete(v);
  }
}
function pluginLog(level) {
  return function () {
    let text;
    try {
      text = Array.from(arguments, (a) => goSprint(a)).join(' ');
    } catch (e) {
      text = Array.from(arguments, (a) => { try { return String(a); } catch (e2) { return '?'; } }).join(' ');
    }
    emitEvent('log', { level: level, args: [escapeLogText(text)] });
  };
}
const log = { info: pluginLog('info'), warn: pluginLog('warn'), error: pluginLog('error') };

// Host: internal/plugin/config/validate.go + store quota (plugin.config.max_keys_per_plugin, default 500)
const CONFIG_KEY_RE = /^[a-zA-Z0-9_.\-]{1,128}$/;
const CONFIG_DENIED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONFIG_MAX_VALUE_BYTES = 64 * 1024;
const CONFIG_MAX_KEYS = Number(process.env.DEVRT_CONFIG_MAX_KEYS) || 500;

// goja converts a JS argument bound to a Go string parameter like this (null / undefined → "")
function gojaString(v) {
  return v === undefined || v === null ? '' : String(v);
}

function validateConfigKey(key) {
  if (!CONFIG_KEY_RE.test(key)) return 'invalid config key: must match ^[a-zA-Z0-9_.\\-]{1,128}$';
  if (CONFIG_DENIED_KEYS.has(key)) return 'invalid config key: ' + JSON.stringify(key) + ' is a reserved name';
  return null;
}

function validateConfigValue(value) {
  const n = Buffer.byteLength(value, 'utf-8');
  if (n > CONFIG_MAX_VALUE_BYTES) return 'invalid config value: value ' + n + ' bytes exceeds max ' + CONFIG_MAX_VALUE_BYTES;
  return null;
}

const config = {
  get: function (key) {
    const v = configStore[gojaString(key)];
    return v === undefined ? null : v;
  },
  set: function (key, value) {
    key = gojaString(key);
    value = gojaString(value);
    const bad = validateConfigKey(key) || validateConfigValue(value);
    if (bad) throw goError(bad);
    if (!(key in configStore)) {
      const current = Object.keys(configStore).length;
      if (current >= CONFIG_MAX_KEYS) {
        throw goError('plugin config: row quota exceeded: current=' + current + ' limit=' + CONFIG_MAX_KEYS);
      }
    }
    configStore[key] = value;
    emitEvent('config', { key, value });
  },
  // Host R4: synchronous; same key check as set (a bad key throws); returns whether a key was deleted
  delete: function (key) {
    key = gojaString(key);
    const bad = validateConfigKey(key);
    if (bad) throw goError(bad);
    if (!(key in configStore)) return false;
    delete configStore[key];
    emitEvent('configDelete', { key });
    return true;
  },
  // Host: keys only, sorted (Go sort.Strings = byte order)
  list: function () {
    return CtxArray.from(Object.keys(configStore).sort(byteOrder));
  },
};

function byteOrder(a, b) {
  const x = Buffer.from(a, 'utf-8'), y = Buffer.from(b, 'utf-8');
  return Buffer.compare(x, y);
}

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
let CtxTypeError = TypeError;
let CtxUint8Array = Uint8Array;
let CtxArray = Array;
let CtxObject = Object;
// The plugin realm's built-in JSON.parse, captured before the R1 guard replaces the global
let ctxJSONParse = JSON.parse;

// Host R3: everything handed to the plugin is a plain object of the plugin realm, a fresh copy each
// time (Go value → JSON → the sandbox's built-in JSON.parse)
function toPlugin(v) {
  if (v === undefined || v === null) return v;
  return ctxJSONParse(JSON.stringify(v));
}

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

function copyHeaders(h) {
  const out = {};
  if (h && typeof h === 'object') {
    for (const k of Object.keys(h)) out[k] = gojaString(h[k]);
  }
  return out;
}

// Every http.* call returns a Promise (no sync alias). Rate limit is checked at
// call time like the host and surfaces as a rejection, not a synchronous throw.
function httpCall(method, url, body, headers) {
  return new CtxPromise(function (resolve, reject) {
    if (!rateAllow()) {
      reject(goError('plugin http rate limit exceeded (60 req/min)'));
      return;
    }
    // Copy the headers map now (host A.4: reference arguments are copied on the loop thread
    // before the request goroutine sees them) — a later mutation by the plugin changes nothing
    const hdrs = copyHeaders(headers);
    httpFn(method, String(url), body == null ? '' : String(body), hdrs).then(
      function (v) { resolve(toPlugin(v)); drainMicrotasks(); },
      function (e) { reject(e); drainMicrotasks(); });
  });
}

const http = {
  get:    function (url, headers)        { return httpCall('GET',    url, null, headers); },
  post:   function (url, body, headers)  { return httpCall('POST',   url, body, headers); },
  put:    function (url, body, headers)  { return httpCall('PUT',    url, body, headers); },
  delete: function (url, headers)        { return httpCall('DELETE', url, null, headers); },
};

// ─── batch-1 facades: crypto / ptsite / douban ──────────────────────────────

function typeError(message) { return new CtxTypeError(message); }

// Plugin-realm Uint8Array (so `x instanceof Uint8Array` holds inside the plugin)
function u8(buf) {
  const out = new CtxUint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i];
  return out;
}

// Host accepts Uint8Array (incl. subarray views) / ArrayBuffer; string only where allowed (UTF-8)
function argBytes(v, what, allowString) {
  if (v === undefined || v === null) throw typeError(what + ' is required');
  if (typeof v === 'string') {
    if (allowString) return Buffer.from(v, 'utf-8');
  } else if (utilTypes.isUint8Array(v)) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  } else if (utilTypes.isArrayBuffer(v)) {
    return Buffer.from(v);
  }
  throw typeError(what + (allowString ? ' must be a string, Uint8Array or ArrayBuffer' : ' must be a Uint8Array or ArrayBuffer'));
}

const EVP_MAX_LEN = 256;
function argLen(v, what) {
  if (typeof v !== 'number') throw typeError(what + ' must be a number');
  if (!Number.isInteger(v)) throw typeError(what + ' must be an integer');
  if (v < 0 || v > EVP_MAX_LEN) throw typeError(what + ' must be within [0, ' + EVP_MAX_LEN + ']');
  return v;
}

function hashHex(alg, v, name) {
  return nodeCrypto.createHash(alg).update(argBytes(v, 'crypto.' + name + ' input', true)).digest('hex');
}

const cryptoFacade = {
  sha256: function (v) { return hashHex('sha256', v, 'sha256'); },
  md5: function (v) { return hashHex('md5', v, 'md5'); },
  base64Decode: function (s) {
    if (typeof s !== 'string') throw typeError('crypto.base64Decode requires a string');
    // Host: Go's StdEncoding skips \r and \n; standard alphabet (+/), trailing '=' optional,
    // anything else is an error
    s = s.replace(/[\r\n]/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || (s.length % 4 === 1) || (s.includes('=') && s.length % 4 !== 0)) {
      throw goError('crypto.base64Decode: illegal base64 data');
    }
    return u8(Buffer.from(s, 'base64'));
  },
  // OpenSSL EVP_BytesToKey (digest=MD5, count=1)
  evpBytesToKey: function (password, salt, keyLen, ivLen) {
    const pwd = argBytes(password, 'crypto.evpBytesToKey password', true);
    const saltBuf = (salt === undefined || salt === null) ? Buffer.alloc(0) : argBytes(salt, 'crypto.evpBytesToKey salt', false);
    const kl = argLen(keyLen, 'crypto.evpBytesToKey keyLen');
    const il = argLen(ivLen, 'crypto.evpBytesToKey ivLen');
    let out = Buffer.alloc(0);
    let prev = Buffer.alloc(0);
    while (out.length < kl + il) {
      prev = nodeCrypto.createHash('md5').update(Buffer.concat([prev, pwd, saltBuf])).digest();
      out = Buffer.concat([out, prev]);
    }
    const res = new CtxObject();
    res.key = u8(out.subarray(0, kl));
    res.iv = u8(out.subarray(kl, kl + il));
    return res;
  },
  // AES-CBC decrypt + PKCS7 unpad (key 16/24/32 bytes, iv 16 bytes)
  aesDecryptCBC: function (key, iv, data) {
    const k = argBytes(key, 'crypto.aesDecryptCBC key', false);
    const i = argBytes(iv, 'crypto.aesDecryptCBC iv', false);
    const d = argBytes(data, 'crypto.aesDecryptCBC data', false);
    if (![16, 24, 32].includes(k.length)) throw goError('crypto.aesDecryptCBC: key must be 16, 24 or 32 bytes (got ' + k.length + ')');
    if (i.length !== 16) throw goError('crypto.aesDecryptCBC: iv must be 16 bytes (got ' + i.length + ')');
    if (d.length === 0 || d.length % 16 !== 0) throw goError('crypto.aesDecryptCBC: data length must be a positive multiple of 16 (got ' + d.length + ')');
    try {
      const decipher = nodeCrypto.createDecipheriv('aes-' + (k.length * 8) + '-cbc', k, i);
      return u8(Buffer.concat([decipher.update(d), decipher.final()]));
    } catch (e) {
      throw goError('crypto.aesDecryptCBC: invalid PKCS7 padding (wrong key or corrupted data)');
    }
  },
};

// Host audit rows are written under source "audit/plugin/<id>"; devrt surfaces them as log lines
function sanitizeAuditTarget(t) {
  if (!t) return '-';
  return String(t).slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
}
function audit(action, target, invalidLen) {
  const t = target === null ? '<invalid len=' + invalidLen + '>' : sanitizeAuditTarget(target);
  emitEvent('log', { level: 'info', args: ['[audit] AUDIT action=' + action + ' target=' + t] });
}

function fingerprint(plain) {
  return plain ? nodeCrypto.createHash('sha256').update(normalizeCookie(plain), 'utf8').digest('hex') : '';
}

// Mock PT registry + site rows (auth_kind: cookie / apikey / none)
const PT_REGISTRY = [
  { site_id: 'hhan', name: '憨憨', auth_kind: 'cookie' },
  { site_id: 'ourbits', name: '我堡', auth_kind: 'cookie' },
  { site_id: 'audiences', name: '观众', auth_kind: 'cookie' },
  { site_id: 'mteam', name: '馒头', auth_kind: 'apikey' },
  { site_id: 'pter', name: '猫站', auth_kind: 'none' },
];
// rss_urls stays inside the mock (the host never exposes it); only its hostnames go out as `hosts`
const ptRows = [
  { id: 'mock-hhan', name: 'Mock 憨憨', adapter: 'hhan', enabled: true, cookie: 'uid=1; pass=mockcookie0001', apikey: '',
    rss_urls: ['https://hhanclub.top/torrentrss.php?passkey=mockpasskey0001&rows=50'] },
  { id: 'mock-ourbits', name: 'Mock 我堡', adapter: 'ourbits', enabled: true, cookie: '', apikey: '', rss_urls: [] },
  { id: 'mock-audiences', name: 'Mock 观众', adapter: 'audiences', enabled: true, cookie: '', apikey: '',
    rss_urls: ['https://audiences.me/torrentrss.php?passkey=mockpasskey0002'] },
  { id: 'mock-mteam', name: 'Mock 馒头', adapter: 'mteam', enabled: false, cookie: '', apikey: '',
    rss_urls: ['https://rss.m-team.cc/api/rss/fetch?sign=mocksign'] },
  { id: 'mock-pter', name: 'Mock 猫站', adapter: 'pter', enabled: true, cookie: '', apikey: '',
    rss_urls: ['https://pterclub.com/torrentrss.php?passkey=mockpasskey0003'] },
];
function ptAuthKind(row) {
  const m = PT_REGISTRY.find((r) => r.site_id === row.adapter);
  return m ? m.auth_kind : null;
}
// Mirror of host pt.RSSHostnames: URL hostname, lowercased, de-duplicated, first-seen order;
// unparsable / hostless entries skipped; no RSS → []
function rssHostnames(urls) {
  const out = [];
  for (const u of urls || []) {
    let host;
    try { host = new URL(u).hostname.toLowerCase(); } catch (e) { continue; }
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // Go Hostname() drops IPv6 brackets
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}
function ptView(row) {
  return { id: row.id, name: row.name, adapter: row.adapter, enabled: row.enabled,
    auth_kind: ptAuthKind(row), has_cookie: row.cookie !== '', has_apikey: row.apikey !== '',
    hosts: rssHostnames(row.rss_urls) };
}
function ptFind(id) {
  const row = ptRows.find((r) => r.id === id);
  return row && ptAuthKind(row) ? row : null;
}

function buildPTSite(perms) {
  const api = {};
  if (perms.has('api.ptsite.read')) {
    api.list = function () { return toPlugin(ptRows.filter((r) => ptAuthKind(r)).map(ptView)); };
    api.get = function (id) { const r = ptFind(String(id)); return r ? toPlugin(ptView(r)) : null; };
    api.registry = function () { return toPlugin(PT_REGISTRY); };
    api.getCookieMeta = function (id) {
      const r = ptFind(String(id));
      if (!r) return null;
      return toPlugin({ configured: r.cookie !== '', sha256: fingerprint(r.cookie) });
    };
  }
  // Plugins only sync cookies (host E1, 2026-09-25): ptsite.setAPIKey no longer exists
  if (perms.has('api.ptsite.write')) {
    api.setCookie = function (id, value) {
      if (typeof id !== 'string' || typeof value !== 'string') {
        throw typeError('ptsite.setCookie requires (id: string, value: string)');
      }
      const row = ptRows.find((r) => r.id === id);
      // Host (C1): the audit target is the real id only once the row is known to exist;
      // otherwise only its length (a swapped (cookie, id) call must not log the cookie)
      audit('ptsite.setCookie', row ? id : null, id.length);
      return new CtxPromise(function (resolve, reject) {
        if (!row) return reject(goError('pt credential: site not found'));
        const authKind = ptAuthKind(row);
        if (!authKind) return reject(goError('pt credential: pt adapter not registered: "' + row.adapter + '"'));
        if (value !== '' && authKind !== 'cookie') {
          return reject(goError('pt credential: credential kind does not match the site\'s auth kind: site auth kind is "' + authKind + '", got a cookie write'));
        }
        row.cookie = value;
        resolve(toPlugin({ ok: true }));
      });
    };
  }
  return api;
}

let doubanCookie = '';
const DOUBAN_VALIDATION = process.env.DEVRT_DOUBAN_VALIDATION || 'ok';

function buildDouban(perms) {
  const api = {};
  if (perms.has('api.douban.cookie.read')) {
    api.getCookie = function () {
      return toPlugin(doubanCookie
        ? { configured: true, sha256: fingerprint(doubanCookie) }
        : { configured: false, sha256: '' });
    };
  }
  if (perms.has('api.douban.cookie.write')) {
    api.setCookie = function (value, opts) {
      if (typeof value !== 'string') {
        throw typeError('douban.setCookie requires (value: string, options?: {validate?: boolean})');
      }
      // Host: any JS object (functions included) is accepted; only primitives are rejected
      if (opts !== undefined && opts !== null && typeof opts !== 'object' && typeof opts !== 'function') {
        throw typeError('douban.setCookie options must be an object');
      }
      const validate = !!(opts && opts.validate);
      audit('douban.setCookie', 'douban_cookie');
      return new CtxPromise(function (resolve) {
        doubanCookie = value;
        // Host: "" clears → no_cookie; validate=false → ""; otherwise the 5-state result
        // (plugin path caps validation at 8s; hitting the cap resolves "rate_limited")
        const validation = value === '' ? 'no_cookie' : (validate ? DOUBAN_VALIDATION : '');
        resolve(toPlugin({ ok: true, validation: validation }));
      });
    };
  }
  return api;
}

// ─── notify.send (api.notify.send) ──────────────────────────────────────────
// Mirror of internal/plugin/host_api_notify.go (the facade: argument / field type checks → synchronous
// TypeError) and internal/notify/plugin.go EnqueuePlugin (content rules → rejected Promise with the host's
// Chinese reason, then the quota). Nothing is delivered: an accepted message is printed to the log panel
// and resolves {queued: true, channels: DEVRT_NOTIFY_CHANNELS}.

const NOTIFY_CHANNELS = (function () {
  const raw = process.env.DEVRT_NOTIFY_CHANNELS;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isSafeInteger(n) && n >= 0 ? n : 1;
})();
// Host: plugin.notify.max_per_hour, default 300, admin range [1, 3600]
const NOTIFY_MAX_PER_HOUR = (function () {
  const n = Number(process.env.DEVRT_NOTIFY_MAX_PER_HOUR);
  return Number.isSafeInteger(n) && n >= 1 && n <= 3600 ? n : 300;
})();
const NOTIFY_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const NOTIFY_MAX_TITLE_BYTES = 1024;
const NOTIFY_MAX_BODY_BYTES = 16 * 1024;
const NOTIFY_MAX_URL_LEN = 2048;            // bytes, raw and re-serialized
const NOTIFY_MAX_BUTTON_DATA_BYTES = 4096;
const NOTIFY_MAX_BUTTONS = 6;
const NOTIFY_MAX_BUTTONS_IN_ROW = 3;
const NOTIFY_AUTO_BUTTONS_PER_ROW = 2;      // flat button list → the facade lays it out 2 per row
const NOTIFY_LINK_RULE = '只允许 http / https，且不能带用户名和密码';

function utf8Len(s) { return Buffer.byteLength(s, 'utf8'); }

// Go unicode.IsSpace
function goIsSpace(cp) {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0x85 || cp === 0xa0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}
// Go strings.TrimSpace(s) === "" (JS trim() differs: it strips U+FEFF and keeps U+0085)
function goIsBlank(s) {
  for (const ch of s) if (!goIsSpace(ch.codePointAt(0))) return false;
  return true;
}

// ── Go net/url port (Parse + String), on byte strings: each char is one UTF-8 byte (latin1) ──
const URL_ENC_PATH = 'path', URL_ENC_HOST = 'host', URL_ENC_ZONE = 'zone', URL_ENC_FRAGMENT = 'fragment';
function goIsHexByte(c) { return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); }
function goUnhex(c) { return c <= 57 ? c - 48 : (c >= 97 ? c - 87 : c - 55); }
function goShouldEscape(c, mode) {
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return false;
  const ch = String.fromCharCode(c);
  if ((mode === URL_ENC_HOST || mode === URL_ENC_ZONE) && '!$&\'()*+,;=:[]<>"'.includes(ch)) return false;
  if ('-_.~'.includes(ch)) return false;
  if ('$&+,/:;=?@'.includes(ch)) {
    if (mode === URL_ENC_PATH) return ch === '?';
    if (mode === URL_ENC_FRAGMENT) return false;
  }
  if (mode === URL_ENC_FRAGMENT && '!()*'.includes(ch)) return false;
  return true;
}
function goUnescape(s, mode) {
  let n = 0;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 37) { // %
      n++;
      if (i + 2 >= s.length || !goIsHexByte(s.charCodeAt(i + 1)) || !goIsHexByte(s.charCodeAt(i + 2))) throw new Error('invalid URL escape');
      if (mode === URL_ENC_HOST && goUnhex(s.charCodeAt(i + 1)) < 8 && s.slice(i, i + 3) !== '%25') throw new Error('invalid URL escape');
      if (mode === URL_ENC_ZONE) {
        const v = goUnhex(s.charCodeAt(i + 1)) << 4 | goUnhex(s.charCodeAt(i + 2));
        if (s.slice(i, i + 3) !== '%25' && v !== 32 && goShouldEscape(v, URL_ENC_HOST)) throw new Error('invalid URL escape');
      }
      i += 3;
    } else {
      if ((mode === URL_ENC_HOST || mode === URL_ENC_ZONE) && c < 0x80 && goShouldEscape(c, mode)) throw new Error('invalid character in host name');
      i++;
    }
  }
  if (n === 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 37) {
      out += String.fromCharCode(goUnhex(s.charCodeAt(i + 1)) << 4 | goUnhex(s.charCodeAt(i + 2)));
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}
function goEscape(s, mode) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += goShouldEscape(c, mode) ? '%' + c.toString(16).toUpperCase().padStart(2, '0') : s[i];
  }
  return out;
}
function goValidEncoded(s, mode) {
  for (let i = 0; i < s.length; i++) {
    if ('!$&\'()*+,;=:@[]%'.includes(s[i])) continue;
    if (goShouldEscape(s.charCodeAt(i), mode)) return false;
  }
  return true;
}
function goValidOptionalPort(p) { return p === '' || /^:[0-9]*$/.test(p); }
function goParseHost(host) {
  if (host.startsWith('[')) {
    const i = host.lastIndexOf(']');
    if (i < 0) throw new Error("missing ']' in host");
    if (!goValidOptionalPort(host.slice(i + 1))) throw new Error('invalid port');
    const zone = host.slice(0, i).indexOf('%25');
    if (zone >= 0) {
      return goUnescape(host.slice(0, zone), URL_ENC_HOST) + goUnescape(host.slice(zone, i), URL_ENC_ZONE) +
        goUnescape(host.slice(i), URL_ENC_HOST);
    }
  } else {
    const i = host.lastIndexOf(':');
    if (i !== -1 && !goValidOptionalPort(host.slice(i))) throw new Error('invalid port');
  }
  return goUnescape(host, URL_ENC_HOST);
}
// url.Parse; throws where Go returns an error. Only the absolute (scheme://host) shape matters here.
function goURLParse(raw) {
  const hash = raw.indexOf('#');
  const u = { scheme: '', opaque: '', user: false, host: '', path: '', rawPath: '', forceQuery: false, rawQuery: '',
    fragment: '', rawFragment: '', omitHost: false };
  let rest = hash < 0 ? raw : raw.slice(0, hash);
  if (/[\x00-\x1f\x7f]/.test(rest)) throw new Error('invalid control character in URL');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (rest.startsWith(':')) throw new Error('missing protocol scheme');
  if (m) { u.scheme = m[1].toLowerCase(); rest = rest.slice(m[0].length); }
  if (rest.endsWith('?') && rest.indexOf('?') === rest.length - 1) {
    u.forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf('?');
    if (q >= 0) { u.rawQuery = rest.slice(q + 1); rest = rest.slice(0, q); }
  }
  if (!rest.startsWith('/')) {
    if (u.scheme !== '') { u.opaque = rest; return u; }
    if (rest.split('/')[0].includes(':')) throw new Error('first path segment in URL cannot contain colon');
  }
  if ((u.scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    let authority = rest.slice(2);
    rest = '';
    const i = authority.indexOf('/');
    if (i >= 0) { rest = authority.slice(i); authority = authority.slice(0, i); }
    const at = authority.lastIndexOf('@');
    u.host = goParseHost(at < 0 ? authority : authority.slice(at + 1));
    if (at >= 0) u.user = true; // ValidateLinkURL refuses any userinfo (or Go fails to parse it): same outcome
  } else if (u.scheme !== '' && rest.startsWith('/')) {
    u.omitHost = true;
  }
  u.path = goUnescape(rest, URL_ENC_PATH);
  u.rawPath = goEscape(u.path, URL_ENC_PATH) === rest ? '' : rest;
  if (hash >= 0) {
    const f = raw.slice(hash + 1);
    if (f !== '') {
      u.fragment = goUnescape(f, URL_ENC_FRAGMENT);
      u.rawFragment = goEscape(u.fragment, URL_ENC_FRAGMENT) === f ? '' : f;
    }
  }
  return u;
}
function goEscapedPart(raw, decoded, mode) {
  if (raw !== '' && goValidEncoded(raw, mode)) {
    try { if (goUnescape(raw, mode) === decoded) return raw; } catch (e) { /* fall through */ }
  }
  return goEscape(decoded, mode);
}
// URL.EscapedPath
function goEscapedPath(u) {
  if (u.rawPath !== '' && goValidEncoded(u.rawPath, URL_ENC_PATH)) {
    try { if (goUnescape(u.rawPath, URL_ENC_PATH) === u.path) return u.rawPath; } catch (e) { /* fall through */ }
  }
  return u.path === '*' ? '*' : goEscape(u.path, URL_ENC_PATH);
}
function goURLString(u) {
  let s = u.scheme ? u.scheme + ':' : '';
  if (u.opaque) {
    s += u.opaque;
  } else {
    if ((u.scheme || u.host || u.user) && !(u.omitHost && u.host === '' && !u.user)) {
      if (u.host || u.path || u.user) s += '//';
      if (u.host) s += goEscape(u.host, URL_ENC_HOST);
    }
    const path = goEscapedPath(u);
    if (path !== '' && path[0] !== '/' && u.host !== '') s += '/';
    s += path;
  }
  if (u.forceQuery || u.rawQuery !== '') s += '?' + u.rawQuery;
  if (u.fragment !== '') s += '#' + goEscapedPart(u.rawFragment, u.fragment, URL_ENC_FRAGMENT);
  return s;
}
// url.URL Hostname() / Port()
function goSplitHostPort(hostPort) {
  let host = hostPort, port = '';
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && goValidOptionalPort(host.slice(colon))) { port = host.slice(colon + 1); host = host.slice(0, colon); }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port };
}

// RFC 3492 punycode (golang.org/x/net/idna's Punycode profile: encode non-ASCII labels, xn-- labels must decode)
const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 };
function punyAdapt(delta, numPoints, first) {
  delta = first ? Math.floor(delta / PUNY.damp) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  for (; delta > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1; k += PUNY.base) delta = Math.floor(delta / (PUNY.base - PUNY.tMin));
  return k + Math.floor((PUNY.base - PUNY.tMin + 1) * delta / (delta + PUNY.skew));
}
function punyDigit(d) { return String.fromCharCode(d < 26 ? d + 97 : d + 22); }
function punyEncode(label) {
  const cps = Array.from(label, (c) => c.codePointAt(0));
  let out = cps.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join('');
  const b = out.length;
  let h = b;
  if (b > 0) out += '-';
  let n = PUNY.initialN, delta = 0, bias = PUNY.initialBias;
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = PUNY.base; ; k += PUNY.base) {
          const t = k <= bias ? PUNY.tMin : (k >= bias + PUNY.tMax ? PUNY.tMax : k - bias);
          if (q < t) break;
          out += punyDigit(t + (q - t) % (PUNY.base - t));
          q = Math.floor((q - t) / (PUNY.base - t));
        }
        out += punyDigit(q);
        bias = punyAdapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}
function punyDecodes(s) {
  const d = s.lastIndexOf('-');
  const output = [];
  for (let i = 0; i < Math.max(d, 0); i++) {
    if (s.charCodeAt(i) >= 0x80) return false;
    output.push(s.charCodeAt(i));
  }
  let n = PUNY.initialN, bias = PUNY.initialBias, i = 0;
  for (let pos = d > 0 ? d + 1 : 0; pos < s.length;) {
    const oldi = i;
    for (let w = 1, k = PUNY.base; ; k += PUNY.base) {
      if (pos >= s.length) return false;
      const c = s.charCodeAt(pos++);
      const digit = c >= 48 && c <= 57 ? c - 22 : (c >= 65 && c <= 90 ? c - 65 : (c >= 97 && c <= 122 ? c - 97 : -1));
      if (digit < 0) return false;
      i += digit * w;
      if (i > 0x7fffffff) return false;
      const t = k <= bias ? PUNY.tMin : (k >= bias + PUNY.tMax ? PUNY.tMax : k - bias);
      if (digit < t) break;
      w *= PUNY.base - t;
      if (w > 0x7fffffff) return false;
    }
    const len = output.length + 1;
    bias = punyAdapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return false;
    output.splice(i, 0, n);
    i++;
  }
  return true;
}
const nodeURL = require('url');
const nodeNet = require('net');
// Mirror of notify idnaASCII: (1) strict lookup — approximated by Node's WHATWG domainToASCII, (2) punycode-only
// fallback on the lowercased host, (3) an ASCII host as-is. null = no ASCII form (link refused).
function notifyIDNAASCII(hostBytes) {
  const host = Buffer.from(hostBytes, 'latin1').toString('utf8');
  const isAscii = (x) => !/[^\x00-\x7f]/.test(x);
  const a = nodeURL.domainToASCII(host);
  if (a !== '' && isAscii(a)) return a.toLowerCase();
  let ok = true;
  const labels = host.toLowerCase().split('.').map(function (l) {
    if (l.startsWith('xn--')) { if (!punyDecodes(l.slice(4))) ok = false; return l; }
    return isAscii(l) ? l : 'xn--' + punyEncode(l);
  });
  if (ok) return labels.join('.');
  if (isAscii(host)) return host.toLowerCase();
  return null;
}
// Mirror of notify.ValidateLinkURL: the re-serialized href (as a byte string), or null when the host refuses it
function notifyValidateLinkURL(raw) {
  let u;
  try { u = goURLParse(Buffer.from(raw, 'utf8').toString('latin1')); } catch (e) { return null; }
  if (u.scheme !== 'http' && u.scheme !== 'https') return null;
  if (u.user) return null;
  const hp = goSplitHostPort(u.host);
  if (u.host === '' || hp.host === '') return null;
  if (!u.host.startsWith('[') && nodeNet.isIP(hp.host) === 0) {
    const ascii = notifyIDNAASCII(hp.host);
    if (ascii === null) return null;
    u.host = ascii + (hp.port !== '' ? ':' + hp.port : '');
  }
  return goURLString(u);
}
// Mirror of notify checkPluginURL: '' = ok, else 'too_long' / 'invalid'
function notifyCheckURL(raw) {
  if (utf8Len(raw) > NOTIFY_MAX_URL_LEN) return 'too_long';
  const href = notifyValidateLinkURL(raw);
  if (href === null) return 'invalid';
  return href.length > NOTIFY_MAX_URL_LEN ? 'too_long' : '';
}

// ── FC-Markdown parser port (internal/notify/fcmd.go ParseFCMarkdown) ──
// Only what the plugin checks need: the block split (code fences hide their lines), and the inline tree —
// text / code / link nodes and the emphasis wrappers. Works on UTF-16 code units: every structural character is
// ASCII, and the only non-ASCII tests (unicode.IsSpace, ASCII alnum) give the same answer per code unit as per rune.
// Result: { blocks: [{ lines: [[node]] }], issues: N } with nodes {kind: 'text', text} | {kind: 'code'} |
// {kind: 'link', href (re-serialized, as a byte string), children} | {kind: 'wrap', children}.
function fcmdParse(src) {
  const lines = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const doc = { blocks: [], issues: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fcmdFenceOpen(line)) {
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) if (lines[j] === '```') { end = j; break; }
      if (end < 0) { // unclosed fence: from the opening line to the end, every line is literal text
        for (const l of lines.slice(i)) doc.blocks.push({ lines: [l === '' ? [] : [{ kind: 'text', text: l }]] });
        break;
      }
      doc.blocks.push({ lines: [] }); // BlockCode: no inline lines
      i = end;
      continue;
    }
    let seg = line;
    if (line.startsWith('>> ')) seg = line.slice(3);
    else if (line.startsWith('> ') || line.startsWith('- ')) seg = line.slice(2);
    doc.blocks.push({ lines: [fcmdInlines(seg, true, doc)] });
  }
  return doc;
}
function fcmdFenceOpen(l) {
  return l.startsWith('```') && !Array.from(l.slice(3)).some((c) => c === '`' || goIsSpace(c.codePointAt(0)));
}
function fcmdIsASCIIPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function fcmdIsASCIIAlnum(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57); }
function fcmdRunLen(s, i, ch) { let n = 0; while (i + n < s.length && s[i + n] === ch) n++; return n; }
function fcmdLowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
// inlineParser.codeSpan: n backticks at i → {content, end}, or null when no closing run of exactly n backticks
function fcmdCodeSpan(p, i, n) {
  if (!p.ticks) {
    p.ticks = new Map();
    for (let k = 0; k < p.seg.length;) {
      if (p.seg[k] !== '`') { k++; continue; }
      const m = fcmdRunLen(p.seg, k, '`');
      if (!p.ticks.has(m)) p.ticks.set(m, []);
      p.ticks.get(m).push(k);
      k += m;
    }
  }
  const starts = p.ticks.get(n) || [];
  const k = fcmdLowerBound(starts, i + n);
  if (k === starts.length) return null;
  const j = starts[k];
  let content = p.seg.slice(i + n, j);
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return { content, end: j + n };
}
// inlineParser.matchBracket, including its cache (a miss rescans from i and caches every '[' on the way)
function fcmdMatchBracket(p, i) {
  if (p.bracketMap && p.bracketMap.has(i)) return p.bracketMap.get(i);
  p.bracketMap = new Map();
  const seg = p.seg;
  const stack = [];
  for (let j = i; j < seg.length;) {
    const c = seg[j];
    if (c === '\\' && j + 1 < seg.length && fcmdIsASCIIPunct(seg.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === '`') {
      const n = fcmdRunLen(seg, j, '`');
      const cs = fcmdCodeSpan(p, j, n);
      j = cs ? cs.end : j + n;
      continue;
    }
    if (c === '[') {
      stack.push(j);
    } else if (c === ']' && stack.length > 0) {
      const o = stack.pop();
      p.bracketMap.set(o, j);
      if (o === i) return j;
    }
    j++;
  }
  for (const o of stack) p.bracketMap.set(o, -1);
  return p.bracketMap.get(i);
}
// inlineParser.tryLink: {res: 'none'} | {res: 'invalid', text, end} | {res: 'ok', node, end}
function fcmdTryLink(p, i) {
  const seg = p.seg;
  const j = fcmdMatchBracket(p, i);
  if (j < 0 || j + 1 >= seg.length || seg[j + 1] !== '(' || j === i + 1) return { res: 'none' };
  if (!p.nextParen) {
    const n = seg.length;
    p.nextParen = new Int32Array(n + 1);
    p.nextSpace = new Int32Array(n + 1);
    p.nextParen[n] = n;
    p.nextSpace[n] = n;
    for (let k = n - 1; k >= 0; k--) {
      p.nextParen[k] = seg[k] === ')' ? k : p.nextParen[k + 1];
      p.nextSpace[k] = goIsSpace(seg.charCodeAt(k)) ? k : p.nextSpace[k + 1];
    }
  }
  const k = p.nextParen[j + 2];
  if (k >= seg.length || p.nextSpace[j + 2] < k) return { res: 'none' };
  const urlSrc = seg.slice(j + 2, k);
  const end = k + 1;
  if (urlSrc.indexOf('`') >= 0) p.bracketMap = null; // same cache reset as the host
  const href = notifyValidateLinkURL(urlSrc);
  if (href === null) {
    p.doc.issues++;
    return { res: 'invalid', text: seg.slice(i, end), end };
  }
  return { res: 'ok', node: { kind: 'link', href, children: fcmdInlines(seg.slice(i + 1, j), false, p.doc) }, end };
}
const FCMD_DK = { '*1': 1, '*2': 2, '*3': 3, '~2': 4, '+2': 8, '|2': 16 }; // italic, bold, bold+italic, strike, underline, spoiler
// parseInlines
function fcmdInlines(seg, allowLinks, doc) {
  const p = { seg, doc, ticks: null, nextParen: null, nextSpace: null, bracketMap: null };
  const toks = [];
  let buf = '';
  const flush = function () { if (buf !== '') { toks.push({ kind: 'text', text: buf, pair: -1 }); buf = ''; } };
  for (let i = 0; i < seg.length;) {
    const c = seg[i];
    if (c === '\\') {
      if (i + 1 < seg.length && fcmdIsASCIIPunct(seg.charCodeAt(i + 1))) { buf += seg[i + 1]; i += 2; continue; }
      buf += c;
      i++;
    } else if (c === '`') {
      const n = fcmdRunLen(seg, i, '`');
      const cs = fcmdCodeSpan(p, i, n);
      if (cs) { flush(); toks.push({ kind: 'code', pair: -1 }); i = cs.end; continue; }
      buf += seg.slice(i, i + n);
      i += n;
    } else if (c === '[' && allowLinks) {
      const r = fcmdTryLink(p, i);
      if (r.res === 'ok') { flush(); toks.push({ kind: 'link', node: r.node, pair: -1 }); i = r.end; }
      else if (r.res === 'invalid') { buf += r.text; i = r.end; }
      else { buf += c; i++; }
    } else if (c === '*' || c === '~' || c === '+' || c === '|') {
      const n = fcmdRunLen(seg, i, c);
      const run = seg.slice(i, i + n);
      const dk = FCMD_DK[c + n];
      if (dk) {
        // flanking
        const hasBefore = i > 0, hasAfter = i + n < seg.length;
        const before = hasBefore ? seg.charCodeAt(i - 1) : 0, after = hasAfter ? seg.charCodeAt(i + n) : 0;
        let canOpen = false, canClose = false;
        if (!(hasBefore && hasAfter && fcmdIsASCIIAlnum(before) && fcmdIsASCIIAlnum(after))) {
          canOpen = hasAfter && !goIsSpace(after);
          canClose = hasBefore && !goIsSpace(before);
        }
        if (canOpen || canClose) {
          flush();
          toks.push({ kind: 'delim', text: run, dk, canOpen, canClose, pair: -1 });
          i += n;
          continue;
        }
      }
      buf += run;
      i += n;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  fcmdMatchDelims(toks);
  return fcmdBuild(toks, 0, toks.length);
}
// matchDelims: per-kind nearest pairing; crossing pairs both literal; same-kind nesting (bold+italic overlaps
// both) makes the inner pair literal
function fcmdMatchDelims(toks) {
  const stacks = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'delim') continue;
    const st = stacks.get(t.dk) || [];
    stacks.set(t.dk, st);
    if (t.canClose && st.length > 0) {
      const o = st.pop();
      toks[o].pair = i;
      t.pair = o;
      continue;
    }
    if (t.canOpen) st.push(i);
  }
  const pairs = [];
  for (let i = 0; i < toks.length; i++) if (toks[i].kind === 'delim' && toks[i].pair > i) pairs.push([i, toks[i].pair]);
  if (pairs.length === 0) return;
  for (const q of fcmdCrossingPairs(pairs)) { toks[q[0]].pair = -1; toks[q[1]].pair = -1; }
  const open = new Array(8).fill(0);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'delim' || t.pair < 0) continue;
    if (t.pair > i) {
      let overlaps = false;
      for (let b = 0; b < 8; b++) if ((t.dk & (1 << b)) && open[b] > 0) overlaps = true;
      if (overlaps) { toks[t.pair].pair = -1; t.pair = -1; continue; }
      for (let b = 0; b < 8; b++) if (t.dk & (1 << b)) open[b]++;
      continue;
    }
    for (let b = 0; b < 8; b++) if (t.dk & (1 << b)) open[b]--;
  }
}
// crossingPairs: every pair that crosses another (p.open < q.open < p.close < q.close or the reverse); pairs
// sorted by open. Sorted lists + a sparse table instead of the host's segment tree (same answer).
function fcmdCrossingPairs(pairs) {
  const n = pairs.length;
  if (n < 2) return [];
  const opens = pairs.map((q) => q[0]);
  const byClose = pairs.slice().sort((a, b) => a[1] - b[1]);
  const closes = byClose.map((q) => q[1]);
  const rangeQuery = function (vals, f) {
    const table = [vals.slice()];
    for (let w = 1; (1 << w) <= vals.length; w++) {
      const prev = table[w - 1], cur = [];
      for (let i = 0; i + (1 << w) <= vals.length; i++) cur.push(f(prev[i], prev[i + (1 << (w - 1))]));
      table.push(cur);
    }
    return function (l, r) { // [l, r), l < r
      const w = 31 - Math.clz32(r - l);
      return f(table[w][l], table[w][r - (1 << w)]);
    };
  };
  const maxClose = rangeQuery(pairs.map((q) => q[1]), Math.max);
  const minOpen = rangeQuery(byClose.map((q) => q[0]), Math.min);
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = pairs[i];
    let crossed = false;
    const r = fcmdLowerBound(opens, q[1]);
    if (i + 1 < r && maxClose(i + 1, r) > q[1]) crossed = true;
    if (!crossed) {
      const l = fcmdLowerBound(closes, q[0] + 1), r2 = fcmdLowerBound(closes, q[1]);
      if (l < r2 && minOpen(l, r2) < q[0]) crossed = true;
    }
    if (crossed) out.push(q);
  }
  return out;
}
// buildInlines + mergeTexts (adjacent text nodes become one; empty text dropped)
function fcmdBuild(toks, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.kind === 'text') out.push({ kind: 'text', text: t.text });
    else if (t.kind === 'code') out.push({ kind: 'code' });
    else if (t.kind === 'link') out.push(t.node);
    else if (t.pair > i && t.pair < to) {
      out.push({ kind: 'wrap', children: fcmdBuild(toks, i + 1, t.pair) });
      i = t.pair;
    } else {
      out.push({ kind: 'text', text: t.text });
    }
  }
  const merged = [];
  for (const node of out) {
    const last = merged[merged.length - 1];
    if (node.kind === 'text' && last && last.kind === 'text') last.text += node.text;
    else merged.push(node);
  }
  return merged.filter((node) => node.kind !== 'text' || node.text !== '');
}
function fcmdSomeNode(doc, pred) {
  const walk = (nodes) => nodes.some((node) => pred(node) || (node.children ? walk(node.children) : false));
  return doc.blocks.some((b) => b.lines.some(walk));
}
// notify bareUserinfoURL: Go RE2 \s is [\t\n\f\r ] (no \v, no Unicode spaces)
const NOTIFY_BARE_USERINFO = /[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^/\t\n\f\r ]*@/;
// Mirror of the body checks in notify.buildPluginContent, in the host's order: any invalid [text](url)
// (Doc.Issues) → 'invalid'; a bare scheme://userinfo@ in a text node (not code) → 'bare_userinfo'; a link
// whose re-serialized URL exceeds 2048 bytes → 'too_long'; else ''.
function fcmdBodyProblem(src) {
  const doc = fcmdParse(src);
  if (doc.issues > 0) return 'invalid';
  if (fcmdSomeNode(doc, (node) => node.kind === 'text' && NOTIFY_BARE_USERINFO.test(node.text))) return 'bare_userinfo';
  if (fcmdSomeNode(doc, (node) => node.kind === 'link' && node.href.length > NOTIFY_MAX_URL_LEN)) return 'too_long';
  return '';
}

// Mirror of notify.EscapeFCMarkdown (a plain-text bot command reply is escaped with it)
function fcmdEscape(s) {
  let out = '';
  let lineStart = true;
  for (const c of s) {
    if ('\\*~+|`[]'.includes(c) || ((c === '>' || c === '-') && lineStart)) out += '\\';
    out += c;
    lineStart = c === '\n' || c === '\r';
  }
  return out;
}

const NOTIFY_REASON_UNDECLARED = '按钮动作未在 manifest 中声明';
// manifest.actions names: the only actions an action button may use (host: declaredActions of the facade,
// and the notify service's lookup through the plugin's enabled manifest)
const NOTIFY_DECLARED_ACTIONS = new Set((Array.isArray(manifest.actions) ? manifest.actions : [])
  .map((a) => (a && typeof a.name === 'string' ? a.name : '')));

// Mirror of notify.buildPluginNotification: the reject reason, or null
function notifyContentReason(msg) {
  if (goIsBlank(msg.title)) return '缺少标题';
  if (utf8Len(msg.title) > NOTIFY_MAX_TITLE_BYTES) return '标题过长（上限 ' + NOTIFY_MAX_TITLE_BYTES + ' 字节）';
  return notifyBodyReason(msg);
}
// Mirror of notify.buildPluginContent + buildPluginButtons (body, image, buttons; a bot command reply goes
// through the same checks without a title)
function notifyBodyReason(msg) {
  if (utf8Len(msg.body) > NOTIFY_MAX_BODY_BYTES) return '正文过长（上限 ' + NOTIFY_MAX_BODY_BYTES + ' 字节）';
  if (!goIsBlank(msg.body)) {
    const p = fcmdBodyProblem(msg.body);
    if (p === 'invalid' || p === 'bare_userinfo') return '正文里的链接无效：' + NOTIFY_LINK_RULE;
    if (p === 'too_long') return '正文里的链接过长（上限 ' + NOTIFY_MAX_URL_LEN + ' 字节）';
  }
  if (msg.image !== '') {
    const p = notifyCheckURL(msg.image);
    if (p === 'too_long') return '图片地址过长（上限 ' + NOTIFY_MAX_URL_LEN + ' 字节）';
    if (p) return '图片地址无效：' + NOTIFY_LINK_RULE;
  }
  let total = 0;
  for (const row of msg.buttons) {
    total += row.length;
    if (row.length > NOTIFY_MAX_BUTTONS_IN_ROW) return '每行按钮最多 ' + NOTIFY_MAX_BUTTONS_IN_ROW + ' 个';
  }
  if (total > NOTIFY_MAX_BUTTONS) return '按钮最多 ' + NOTIFY_MAX_BUTTONS + ' 个';
  for (const row of msg.buttons) {
    for (const b of row) {
      if (goIsBlank(b.label)) return '按钮文字不能为空';
      if (b.url !== '' && b.action !== '') return '按钮只能是链接（url）或动作（action）其中一种';
      if (b.url === '' && b.action === '') return '按钮缺少链接（url）或动作（action）';
      if (b.data !== null && b.action === '') return '只有动作按钮可以带 data';
      if (b.data !== null && utf8Len(b.data) > NOTIFY_MAX_BUTTON_DATA_BYTES) return '按钮数据过大（上限 ' + NOTIFY_MAX_BUTTON_DATA_BYTES + ' 字节）';
      if (b.action !== '') {
        if (!NOTIFY_DECLARED_ACTIONS.has(b.action)) return NOTIFY_REASON_UNDECLARED;
        continue; // action buttons have no URL to check
      }
      const p = notifyCheckURL(b.url);
      if (p === 'too_long') return '按钮链接过长（上限 ' + NOTIFY_MAX_URL_LEN + ' 字节）';
      if (p) return '按钮链接无效：' + NOTIFY_LINK_RULE;
    }
  }
  return null;
}

// Go encoding/json Marshal of a decoded JSON value with SetEscapeHTML(false): object keys sorted (byte order ==
// code point order), U+2028 / U+2029 still escaped. Used for button data, whose 4 KB limit counts these bytes.
function goCompareCodePoints(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}
function goJSONString(s) { return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function goJSONEncode(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return goJSONString(v);
  if (Array.isArray(v)) return '[' + v.map(goJSONEncode).join(',') + ']';
  return '{' + Object.keys(v).sort(goCompareCodePoints).map((k) => goJSONString(k) + ':' + goJSONEncode(v[k])).join(',') + '}';
}

// ── facade type checks (host: synchronous TypeError "notify.send: ...") ──
function notifyTypeError(msg) { return typeError('notify.send: ' + msg); }
// Text fields must be primitive strings (host CF6: checked before any JSON export, so a String object or an
// object with toJSON is refused instead of being turned into a string); undefined / null → absent
function notifyStringField(v, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw notifyTypeError(field + ' must be a string');
  return v;
}
const NOTIFY_MAX_WALK = 1000000; // exportJSONMaxValues: array elements read for buttons, all levels together
// The elements of a JS array (read by index, holes are undefined), or null when v is not an array. The button
// structure is read directly (no JSON round trip, so a toJSON on the arrays does nothing).
function notifyElements(walk, v) {
  if (!Array.isArray(v)) return null;
  const n = Math.trunc(Number(v.length)) || 0;
  if (n > NOTIFY_MAX_WALK) throw notifyTypeError('buttons is not JSON-serializable');
  const out = [];
  for (let i = 0; i < n; i++) {
    if (++walk.count > NOTIFY_MAX_WALK) throw notifyTypeError('buttons is not JSON-serializable');
    out.push(v[i]);
  }
  return out;
}
// One button object: label / url / action primitive strings (absent / null = ""); data any JSON value (absent /
// null / exports to nothing = no data). Any non-function object counts as a button object (an array inside a
// row too).
function notifyButton(x) {
  if (x === null || typeof x !== 'object') throw notifyTypeError('each button must be an object');
  const b = {
    label: notifyStringField(x.label, 'button label'),
    url: notifyStringField(x.url, 'button url'),
    action: notifyStringField(x.action, 'button action'),
    data: null,
  };
  const d = x.data;
  if (d !== undefined && d !== null) {
    let ex;
    try {
      ex = exportValue(d);
    } catch (e) {
      throw notifyTypeError('button data is not JSON-serializable');
    }
    if (ex !== null) b.data = goJSONEncode(ex);
  }
  return b;
}
function notifyButtons(v) {
  const shape = 'buttons must be an array of button objects or an array of button rows';
  if (v === undefined || v === null) return [];
  const walk = { count: 0 };
  const arr = notifyElements(walk, v);
  if (arr === null) throw notifyTypeError(shape);
  if (arr.length === 0) return [];
  if (Array.isArray(arr[0])) {
    return arr.map(function (r) {
      const row = notifyElements(walk, r);
      if (row === null) throw notifyTypeError(shape);
      return row.map(notifyButton);
    });
  }
  const flat = arr.map(function (b) {
    if (Array.isArray(b)) throw notifyTypeError(shape);
    return notifyButton(b);
  });
  return notifyLayoutFlat(flat);
}
function notifyLayoutFlat(flat) {
  const rows = [];
  for (let i = 0; i < flat.length; i += NOTIFY_AUTO_BUTTONS_PER_ROW) rows.push(flat.slice(i, i + NOTIFY_AUTO_BUTTONS_PER_ROW));
  return rows;
}
function notifyReadMessage(arg) {
  if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) throw notifyTypeError('argument must be a message object');
  return {
    title: notifyStringField(arg.title, 'title'),
    body: notifyStringField(arg.body, 'body'),
    image: notifyStringField(arg.image, 'image'),
    buttons: notifyButtons(arg.buttons),
  };
}
// The facade's own check (before the notify service is called): every action button names a declared action
function notifyActionsDeclared(rows) {
  return rows.every((row) => row.every((b) => b.action === '' || NOTIFY_DECLARED_ACTIONS.has(b.action)));
}
// Button rows as shown in the log panel
function notifyShownButtons(rows) {
  return rows.map((row) => row.map((b) => (b.action !== ''
    ? { label: b.label, action: b.action, data: b.data === null ? null : JSON.parse(b.data) }
    : { label: b.label, url: b.url })));
}

const notifySent = []; // ms timestamps of messages queued on at least one channel (rolling 60-minute window)

function buildNotify() {
  return {
    // Settles synchronously (like the host, which resolves / rejects on the loop thread inside the call):
    // consecutive sends keep their order. Plugins must await or .catch it — the host ignores unhandled rejections.
    send: function (msg) {
      const m = notifyReadMessage(msg);
      return new CtxPromise(function (resolve, reject) {
        // the facade refuses undeclared actions before the notify service sees the message (so before the title)
        if (!notifyActionsDeclared(m.buttons)) return reject(goError(NOTIFY_REASON_UNDECLARED));
        const reason = notifyContentReason(m);
        if (reason) return reject(goError(reason));
        const now = Date.now();
        while (notifySent.length > 0 && notifySent[0] <= now - NOTIFY_QUOTA_WINDOW_MS) notifySent.shift();
        if (notifySent.length >= NOTIFY_MAX_PER_HOUR) {
          return reject(goError('超出通知配额（每小时 ' + NOTIFY_MAX_PER_HOUR + ' 条）'));
        }
        if (NOTIFY_CHANNELS > 0) notifySent.push(now); // channels: 0 is not counted against the quota
        const shown = {
          prefix: '🧩 [' + manifest.name + ']', // the host puts this in front of every plugin message
          channels: NOTIFY_CHANNELS,
          title: m.title, body: m.body, image: m.image,
          buttons: notifyShownButtons(m.buttons),
        };
        emitEvent('log', { level: 'info', args: [escapeLogText('[notify.send] ' + JSON.stringify(shown))], notify: shown });
        resolve(toPlugin({ queued: true, channels: NOTIFY_CHANNELS }));
      });
    },
  };
}

// ── interaction hooks (on_notify_action / on_bot_command; mirror internal/notify/actions.go + commands.go) ──
// devrt has no Telegram: the "trigger" RPC plays the click / command with the payload it is given and reports what
// the host would show. Checks that need a real chat (bound account, button token / message copy, one click per
// notification) are not simulated; the manifest declaration and the clicker's permissions are.
const ACTION_TIMEOUT_MS = 10000;             // workerActionTimeout (including await time)
const ACTION_FEEDBACK_MAX = 200;             // actionFeedbackMax (characters)
const INTERACT_ROLE_ADMIN = 'admin';

function manifestList(key) { return Array.isArray(manifest[key]) ? manifest[key].filter((x) => x && typeof x === 'object') : []; }
// userAllowed for a plugin button / command: every listed permission, or admin only when requires is empty
function interactUserAllowed(user, requires) {
  const u = user && typeof user === 'object' ? user : {};
  const perms = Array.isArray(u.permissions) ? u.permissions : [];
  const req = Array.isArray(requires) ? requires : [];
  if (req.length === 0) return u.role === INTERACT_ROLE_ADMIN;
  return req.every((p) => perms.indexOf(p) >= 0);
}
function goTrimSpace(s) {
  const cps = Array.from(s);
  let a = 0, b = cps.length;
  while (a < b && goIsSpace(cps[a].codePointAt(0))) a++;
  while (b > a && goIsSpace(cps[b - 1].codePointAt(0))) b--;
  return cps.slice(a, b).join('');
}
function truncateRunes(s, max) {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max - 1).join('') + '…';
}
// feedbackText: plain text, line breaks folded into spaces, trimmed, at most 200 characters
function interactFeedbackText(s) {
  return truncateRunes(goTrimSpace(s.replace(/\r\n|\r|\n/g, ' ')), ACTION_FEEDBACK_MAX);
}
// pluginActionFeedback (R10): a string or {text: string}; anything else is "no feedback"
function interactActionFeedback(v) {
  if (typeof v === 'string') return interactFeedbackText(v);
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.text === 'string') return interactFeedbackText(v.text);
  return '';
}
// pluginFailureReason: what the user sees when the plugin call itself failed
function interactFailure(e) {
  return e && e.devrtTimeout ? '插件没有响应' : '插件出错';
}
// replyButtons / replyButton (on the exported reply): same two layouts as notify.send; null = wrong shape
function interactReplyButtons(v) {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return [];
  const one = function (m) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
    const str = (k) => (m[k] === undefined || m[k] === null ? '' : (typeof m[k] === 'string' ? m[k] : null));
    const b = { label: str('label'), url: str('url'), action: str('action'), data: null };
    if (b.label === null || b.url === null || b.action === null) return null;
    if (m.data !== undefined && m.data !== null) b.data = goJSONEncode(m.data);
    return b;
  };
  if (Array.isArray(v[0])) {
    const rows = [];
    for (const r of v) {
      if (!Array.isArray(r)) return null;
      const row = r.map(one);
      if (row.some((b) => b === null)) return null;
      rows.push(row);
    }
    return rows;
  }
  const flat = v.map(one);
  return flat.some((b) => b === null) ? null : notifyLayoutFlat(flat);
}
// pluginCommandReply (R10): {reply: null} = nothing to send ("已处理"), {error} = invalid reply ("插件出错"),
// {reply: {body, buttons, text?}} = the message sent back (body is FC-Markdown; a string reply is escaped)
function interactCommandReply(v) {
  let body = '', buttons = [], text;
  if (v === null) return { reply: null };
  if (typeof v === 'string') {
    if (goIsBlank(v)) return { reply: null };
    body = fcmdEscape(v);
    text = v;
  } else if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.body !== undefined && v.body !== null && typeof v.body !== 'string') return { error: 'body must be a string' };
    body = typeof v.body === 'string' ? v.body : '';
    if (v.buttons !== undefined && v.buttons !== null) {
      const rows = interactReplyButtons(v.buttons);
      if (rows === null) return { error: 'buttons shape' };
      buttons = rows;
    }
    if (goIsBlank(body) && buttons.length === 0) return { reply: null };
  } else {
    return { error: 'reply must be a string or {body, buttons}' };
  }
  const reason = notifyBodyReason({ body, image: '', buttons });
  if (reason) return { error: reason };
  return { reply: { body, buttons, text } };
}

// trigger on_notify_action / on_bot_command: reply {ok, hook, ...outcome}; also logged to the panel
function triggerInteraction(hook, fn, data, reply) {
  const report = function (out) {
    const r = Object.assign({ ok: true, hook }, out);
    log.info('[devrt] ' + hook + ' → ' + JSON.stringify(out));
    reply(r);
  };
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (hook === 'on_notify_action') {
    const name = typeof payload.action === 'string' ? payload.action : '';
    const decl = manifestList('actions').find((a) => a.name === name);
    if (!decl) {
      // DispatchAction precondition: the manifest no longer declares it → plugin not called
      return report({ answer: '处理中…', line: '✗ 失败：插件不可用', called: false,
        error: 'manifest.actions does not declare "' + name + '"' });
    }
    if (!interactUserAllowed(payload.user, decl.requires)) {
      return report({ answer: '没有权限', line: null, called: false });
    }
    invokeWithTimeout(fn, [toPlugin(payload)], ACTION_TIMEOUT_MS).then(function (res) {
      let out;
      try { out = exportValue(res); } catch (e) {
        return report({ answer: '处理中…', line: '✗ 失败：插件出错', called: true, error: errString(e).replace(/^Error: /, '') });
      }
      const text = interactActionFeedback(out) || '已处理';
      report({ answer: '处理中…', line: '✓ ' + text, called: true, result: out });
    }, function (e) {
      report({ answer: '处理中…', line: '✗ 失败：' + interactFailure(e), called: true,
        error: e && e.devrtTimeout ? ERR_RUNTIME_TIMEOUT : errString(e) });
    });
    return;
  }
  // on_bot_command
  const chat = payload.chat && typeof payload.chat === 'object' ? payload.chat : {};
  if (chat.type !== 'private') return report({ ignored: true, reply: null, called: false, error: 'commands are handled in private chats only' });
  const short = typeof payload.command === 'string' ? payload.command : '';
  const decl = manifestList('commands').find((c) => c.name === short);
  if (!decl) return report({ reply: '不认识这个命令，发 /help 看看能用什么', called: false });
  if (!interactUserAllowed(payload.user, decl.requires)) return report({ reply: '没有权限', called: false });
  invokeWithTimeout(fn, [toPlugin(payload)], ACTION_TIMEOUT_MS).then(function (res) {
    let out;
    try { out = exportValue(res); } catch (e) {
      return report({ reply: '插件出错', called: true, error: errString(e).replace(/^Error: /, '') });
    }
    const r = interactCommandReply(out);
    if (r.error) return report({ reply: '插件出错', called: true, error: 'invalid reply: ' + r.error, result: out });
    if (r.reply === null) return report({ reply: '已处理', called: true, result: out });
    report({ reply: { prefix: '🧩 [' + manifest.name + ']', body: r.reply.body, text: r.reply.text,
      buttons: notifyShownButtons(r.reply.buttons) }, called: true, result: out });
  }, function (e) {
    report({ reply: interactFailure(e), called: true, error: e && e.devrtTimeout ? ERR_RUNTIME_TIMEOUT : errString(e) });
  });
}

const anime = {
  get: function (id) {
    return toPlugin({ id, title: 'Mock Anime ' + id, mikan_id: '', douban_id: '', total_ep: 12, ep_num: 1, status: 'tracking' });
  },
};

const task = {
  // Host PluginTaskView: task_id is a number (uint)
  get: function (id) {
    return toPlugin({ task_id: Number(id) || 0, anime_title: 'Mock Anime', status: 'running', episodes_done: 1, episodes_total: 12, last_event_at: new Date().toISOString() });
  },
  list: function () {
    return toPlugin([
      { task_id: 1, anime_title: 'Mock Anime A', status: 'running', episodes_done: 3, episodes_total: 12, last_event_at: new Date().toISOString() },
      { task_id: 2, anime_title: 'Mock Anime B', status: 'done',    episodes_done: 12, episodes_total: 12, last_event_at: new Date().toISOString() },
    ]);
  },
};

// ─── data.* (in-memory blobs; mirror internal/plugin/host_api.go buildDataAPI + blob store) ──

const BLOB_MAX_BYTES = Number(process.env.DEVRT_BLOB_MAX_BYTES) || 4 * 1024 * 1024;              // per blob
const BLOB_MAX_TOTAL = Number(process.env.DEVRT_BLOB_MAX_TOTAL) || 16 * 1024 * 1024;             // per plugin
const blobs = new Map(); // name → Buffer

// Byte arrays handed out by data.get. On the host they are still Go []byte underneath, so data.put
// takes them back (e.g. data.put("b", data.get("a"))); a plain array literal like [1, 2, 3] is a
// []interface{} there and is rejected. devrt remembers which arrays it handed out to tell them apart.
const hostByteArrays = new WeakSet();

// The Go type name the host puts into "data.put requires ArrayBuffer or Uint8Array, got <T>"
function goTypeName(v) {
  if (v === null || v === undefined) return '<nil>';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? 'int64' : 'float64';
  if (typeof v === 'function') return 'func(goja.FunctionCall) goja.Value';
  if (Array.isArray(v)) return '[]interface {}';
  if (utilTypes.isTypedArray(v)) {
    const t = { Int8Array: '[]int8', Uint16Array: '[]uint16', Int16Array: '[]int16', Uint32Array: '[]uint32',
      Int32Array: '[]int32', Float32Array: '[]float32', Float64Array: '[]float64', BigInt64Array: '[]int64',
      BigUint64Array: '[]uint64' }[Object.prototype.toString.call(v).slice(8, -1)];
    if (t) return t;
  }
  return 'map[string]interface {}';
}

const data = {
  // Host returns Go []byte: JS sees a byte *array* (Array.isArray === true), not an ArrayBuffer
  get: function (name) {
    const b = blobs.get(gojaString(name));
    if (!b) return null;
    const arr = CtxArray.from(b);
    hostByteArrays.add(arr);
    return arr;
  },
  put: function (name, value) {
    if (arguments.length !== 2) throw typeError('data.put requires (name, value)');
    let bytes;
    if (utilTypes.isArrayBuffer(value)) bytes = Buffer.from(new Uint8Array(value));
    else if (utilTypes.isUint8Array(value) || utilTypes.isUint8ClampedArray(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (Array.isArray(value) && hostByteArrays.has(value)) bytes = Buffer.from(Array.from(value, (x) => Number(x) & 0xff));
    else throw typeError('data.put requires ArrayBuffer or Uint8Array, got ' + goTypeName(value));
    // Host reads the name with goja's Value.String(): undefined → "undefined", 42 → "42"
    name = String(name);
    const bad = validateConfigKey(name);
    if (bad) throw goError('invalid blob name: ' + bad);
    if (bytes.length > BLOB_MAX_BYTES) {
      throw goError('plugin blob: size exceeds per-blob limit: size=' + bytes.length + ' limit=' + BLOB_MAX_BYTES);
    }
    let sum = 0;
    blobs.forEach(function (b) { sum += b.length; });
    const existing = blobs.has(name) ? blobs.get(name).length : 0;
    const newTotal = sum - existing + bytes.length;
    if (newTotal > BLOB_MAX_TOTAL) {
      throw goError('plugin blob: total exceeds per-plugin limit: current=' + sum + ' new=' + newTotal + ' limit=' + BLOB_MAX_TOTAL);
    }
    blobs.set(name, Buffer.from(bytes)); // own copy
    return undefined;
  },
  list: function () {
    return CtxArray.from(Array.from(blobs.keys()).sort(byteOrder));
  },
  delete: function (name) {
    blobs.delete(gojaString(name));
    return true; // host: store.Delete(...) == nil — deleting a missing name is not an error
  },
};

const declaredHooks = new Set(manifest.hooks || []);
const declaredPerms = new Set(manifest.permissions || []);

// Mirror of host internal/plugin/permission.go allPluginPerms / manifest.go knownHooks.
// Unknown entries make the host refuse the manifest (install / load fails) — devrt refuses to run it.
const HOST_PERMISSIONS = [
  'hook.download.read', 'hook.download.write', 'hook.link.read', 'hook.task.read',
  'api.http', 'api.anime.read', 'api.task.read', 'api.ruleflow', 'ui.embed', 'api.ruleflow.read',
  'api.ptsite.read', 'api.ptsite.write', 'api.douban.cookie.read', 'api.douban.cookie.write',
  'api.notify.send',
];
const HOST_HOOKS = [
  'on_episode_found', 'on_download_done', 'on_download_failed', 'on_link_done', 'on_link_failed',
  'on_task_completed', 'on_task_reopened', 'on_episode_acquired', 'on_task_subscribed', 'should_download',
  'on_notify_action', 'on_bot_command',
];
// Mirror of auth.IsValidPermission (internal/module/auth/permissions.go allPerms): the FC user permission keys
// that manifest.actions[].requires / manifest.commands[].requires may list
const FC_PERMISSIONS = [
  'settings:write', 'logs:read', 'mikan:refresh', 'series:recompute', 'subscribe:auto', 'subscribe:any',
  'users:manage', 'resources:delete', 'sites:write', 'servers:write', 'downloads:write', 'linkrules:write',
  'plugins:manage', 'manual_link:write', 'progress:write',
];
// manifest.go: actions / commands rules (notify stage D, R1)
const MANIFEST_MAX_ACTIONS = 20;
const MANIFEST_MAX_COMMANDS = 20;
const MAX_BOT_COMMAND_LEN = 32;          // a plugin command's full name (bytes)
const MAX_ACTION_LABEL_RUNES = 64;
const MAX_COMMAND_DESCRIPTION_RUNES = 256;
const ACTION_NAME_RE = /^[a-z0-9_]{1,32}$/;
const COMMAND_NAME_RE = /^[a-z0-9]{1,32}$/;

// Go strconv.Quote (%q): printable characters stay, the rest is escaped
function goQuote(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (cp === 7) out += '\\a';
    else if (cp === 8) out += '\\b';
    else if (cp === 12) out += '\\f';
    else if (cp === 10) out += '\\n';
    else if (cp === 13) out += '\\r';
    else if (cp === 9) out += '\\t';
    else if (cp === 11) out += '\\v';
    else if (cp === 0x20 || /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(ch)) out += ch;
    else if (cp < 0x80) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\ufffd'; // JSON decoding already made a lone surrogate U+FFFD
    else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return out + '"';
}
function goRuneCount(s) { return Array.from(s).length; }

// encoding/json decode errors for the actions / commands fields (Parse reports the first one, in document order,
// before any other check). Only these two fields are type-checked here; JSON null is the zero value (no error).
function manifestJSONKind(v) {
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'bool';
  return typeof v; // object / string / number
}
function manifestDecodeError(m) {
  const specs = {
    actions: { slice: '[]plugin.ManifestAction', elem: 'plugin.ManifestAction', struct: 'ManifestAction', fields: { name: 'string', label: 'string', requires: '[]string' } },
    commands: { slice: '[]plugin.ManifestCommand', elem: 'plugin.ManifestCommand', struct: 'ManifestCommand', fields: { name: 'string', description: 'string', requires: '[]string' } },
  };
  const bad = (v, where, type) => 'parse manifest json: json: cannot unmarshal ' + manifestJSONKind(v) + ' into Go struct field ' + where + ' of type ' + type;
  for (const key of Object.keys(m)) {
    const spec = specs[key];
    const list = m[key];
    if (!spec || list === null) continue;
    if (!Array.isArray(list)) return bad(list, 'Manifest.' + key, spec.slice);
    for (const el of list) {
      if (el === null) continue;
      if (typeof el !== 'object' || Array.isArray(el)) return bad(el, 'Manifest.' + key, spec.elem);
      for (const f of Object.keys(el)) {
        const type = spec.fields[f];
        const v = el[f];
        if (!type || v === null) continue;
        const where = spec.struct + '.' + key + '.' + f;
        if (type === 'string' && typeof v !== 'string') return bad(v, where, 'string');
        if (type === '[]string') {
          if (!Array.isArray(v)) return bad(v, where, '[]string');
          for (const item of v) if (item !== null && typeof item !== 'string') return bad(item, where, 'string');
        }
      }
    }
  }
  return null;
}
function manifestRuneLen(field, s, max) {
  const n = goRuneCount(s);
  if (n === 0) return field + ' is required';
  if (n > max) return field + ' is ' + n + ' characters, max ' + max;
  return null;
}
function manifestRequires(field, requires) {
  for (const p of requires || []) {
    const key = p === null ? '' : p;
    if (FC_PERMISSIONS.indexOf(key) < 0) return field + ' contains unknown permission ' + goQuote(key);
  }
  return null;
}
// validateActions / validateCommands + the rule that declaring them needs api.notify.send and the matching hook
function manifestInteractionError(m) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const actions = Array.isArray(m.actions) ? m.actions.map((a) => a || {}) : [];
  const commands = Array.isArray(m.commands) ? m.commands.map((c) => c || {}) : [];
  if (actions.length > MANIFEST_MAX_ACTIONS) return 'manifest.actions has ' + actions.length + ' entries, max ' + MANIFEST_MAX_ACTIONS;
  const seenA = new Map();
  for (let i = 0; i < actions.length; i++) {
    const name = str(actions[i].name);
    if (!ACTION_NAME_RE.test(name)) return 'manifest.actions[' + i + '].name ' + goQuote(name) + ' invalid: must match ' + ACTION_NAME_RE.source;
    if (seenA.has(name)) return 'manifest.actions[' + i + '].name ' + goQuote(name) + ' duplicates manifest.actions[' + seenA.get(name) + ']';
    seenA.set(name, i);
    const e = manifestRuneLen('manifest.actions[' + i + '].label', str(actions[i].label), MAX_ACTION_LABEL_RUNES) ||
      manifestRequires('manifest.actions[' + i + '].requires', actions[i].requires);
    if (e) return e;
  }
  if (commands.length > MANIFEST_MAX_COMMANDS) return 'manifest.commands has ' + commands.length + ' entries, max ' + MANIFEST_MAX_COMMANDS;
  const seenC = new Map();
  const pluginName = str(m.name);
  for (let i = 0; i < commands.length; i++) {
    const name = str(commands[i].name);
    if (!COMMAND_NAME_RE.test(name)) return 'manifest.commands[' + i + '].name ' + goQuote(name) + ' invalid: must match ' + COMMAND_NAME_RE.source;
    if (seenC.has(name)) return 'manifest.commands[' + i + '].name ' + goQuote(name) + ' duplicates manifest.commands[' + seenC.get(name) + ']';
    seenC.set(name, i);
    const full = commandFullName(pluginName, name);
    if (utf8Len(full) > MAX_BOT_COMMAND_LEN) {
      return 'manifest.commands[' + i + ']: full command name ' + goQuote(full) + ' is ' + utf8Len(full) + ' characters, max ' + MAX_BOT_COMMAND_LEN;
    }
    const e = manifestRuneLen('manifest.commands[' + i + '].description', str(commands[i].description), MAX_COMMAND_DESCRIPTION_RUNES) ||
      manifestRequires('manifest.commands[' + i + '].requires', commands[i].requires);
    if (e) return e;
  }
  const perms = m.permissions || [], hooks = m.hooks || [];
  if (actions.length > 0 && (perms.indexOf('api.notify.send') < 0 || hooks.indexOf('on_notify_action') < 0)) {
    return 'manifest.actions requires permission "api.notify.send" and hook "on_notify_action"';
  }
  if (commands.length > 0 && (perms.indexOf('api.notify.send') < 0 || hooks.indexOf('on_bot_command') < 0)) {
    return 'manifest.commands requires permission "api.notify.send" and hook "on_bot_command"';
  }
  return null;
}
// CommandFullName (R1): the plugin name with - → _, then _ and the short name (what users type after /)
function commandFullName(pluginName, command) { return pluginName.replace(/-/g, '_') + '_' + command; }

function validateManifest(m) {
  const decodeErr = manifestDecodeError(m);
  if (decodeErr) return decodeErr;
  const unknownPerms = (m.permissions || []).filter((p) => HOST_PERMISSIONS.indexOf(p) < 0);
  if (unknownPerms.length) {
    return 'manifest.permissions contains unknown entries [' + unknownPerms.join(' ') + ']; valid keys are [' + HOST_PERMISSIONS.join(' ') + ']';
  }
  const unknownHooks = (m.hooks || []).filter((h) => HOST_HOOKS.indexOf(h) < 0);
  if (unknownHooks.length) {
    return 'manifest.hooks contains unknown entries [' + unknownHooks.join(' ') + ']; valid hooks are [' + HOST_HOOKS.join(' ') + ']';
  }
  if (m.ui && m.ui.entry && (m.permissions || []).indexOf('ui.embed') < 0) {
    return 'manifest.ui.entry requires "ui.embed" in permissions';
  }
  return manifestInteractionError(m);
}

// Mirror of host internal/plugin/permission.go hookToPerm (2026-09-24 hard rename, no aliases)
const HOOK_PERM_REQ = {
  on_episode_found: 'hook.download.read',
  on_download_done: 'hook.download.read',
  on_download_failed: 'hook.download.read',
  on_link_done: 'hook.link.read',
  on_link_failed: 'hook.link.read',
  on_episode_acquired: 'hook.task.read',
  on_task_completed: 'hook.task.read',
  on_task_reopened: 'hook.task.read',
  on_task_subscribed: 'hook.task.read',
  should_download: 'hook.download.write',
  // notify interaction (stage D): called by the host through Manager.DispatchAction / DispatchCommand, not bridged
  on_notify_action: 'api.notify.send',
  on_bot_command: 'api.notify.send',
};

const plugin = {
  on: function (name, fn) {
    if (!declaredHooks.has(name)) {
      throw new CtxError('plugin.on: hook "' + name + '" not in manifest.hooks');
    }
    const reqPerm = HOOK_PERM_REQ[name];
    if (reqPerm && !declaredPerms.has(reqPerm)) {
      throw new CtxError('plugin.on: hook "' + name + '" requires permission "' + reqPerm + '"');
    }
    hooks[name] = fn;
  },
  registerAPI: function (path, fn) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new CtxError('plugin.registerAPI: path must start with "/"');
    }
    apis[path] = fn;
  },
};

// ─── running plugin code (every entry goes through a vm evaluation with a timeout) ──────

// Guard for code the host does not police (continuations after await, timer callbacks).
// DEVRT-ONLY — see the header comment.
const CONTINUATION_GUARD_MS = Number(process.env.DEVRT_CONTINUATION_GUARD_MS) || 10000;
let runSeq = 0;

// Runs fn(...args) inside the plugin context with a vm timeout. With microtaskMode
// "afterEvaluate" the microtasks queued by this run (e.g. the continuations of an async
// callback that awaited something already settled) also run here, under the same timeout.
function runInPlugin(fn, args, timeoutMs) {
  const slot = '__devrt_call_' + (++runSeq);
  sandbox[slot] = { fn: fn, args: args };
  try {
    return vm.runInContext(slot + '.fn.apply(undefined, ' + slot + '.args)', sandbox, { timeout: timeoutMs });
  } finally {
    delete sandbox[slot];
  }
}

// Host code (http.* replies) settled a plugin Promise from outside: run the continuations now.
function drainMicrotasks() {
  try {
    vm.runInContext('void 0', sandbox, { timeout: CONTINUATION_GUARD_MS });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      log.warn('[devrt] a continuation (code after an await) ran longer than ' + CONTINUATION_GUARD_MS +
        'ms and was interrupted — devrt only; the real host does not interrupt it and the plugin would hang');
    } else {
      log.warn('[devrt] microtask error: ' + errString(e));
    }
  }
}

// ─── timers (mirror internal/plugin/timers.go) ───────────────────────────────

function errString(e) {
  if (e && typeof e === 'object' && e.name && e.message !== undefined) return e.name + ': ' + e.message;
  return String(e);
}

function timerWarn(kind, e) {
  log.warn(kind + ' callback error: ' + errString(e));
}

// A throw or a rejected returned Promise is only logged (host: WARN + last_error), never fatal
function guardTimerCallback(kind, fn) {
  return function () {
    let r;
    try {
      r = runInPlugin(fn, Array.from(arguments), CONTINUATION_GUARD_MS);
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        log.warn('[devrt] ' + kind + ' callback ran longer than ' + CONTINUATION_GUARD_MS +
          'ms and was interrupted — devrt only; the real host does not interrupt timer callbacks and the plugin would hang');
      } else {
        timerWarn(kind, e);
      }
      return;
    }
    if (r && typeof r.then === 'function') {
      r.then(undefined, function (e) { timerWarn(kind, e); });
      drainMicrotasks();
    }
  };
}

const timers = {
  setTimeout: function (fn, ms, ...rest) {
    if (typeof fn !== 'function') throw typeError('setTimeout: callback must be a function');
    return setTimeout(guardTimerCallback('setTimeout', fn), ms, ...rest);
  },
  setInterval: function (fn, ms, ...rest) {
    if (typeof fn !== 'function') throw typeError('setInterval: callback must be a function');
    return setInterval(guardTimerCallback('setInterval', fn), ms, ...rest);
  },
  setImmediate: function (fn, ...rest) {
    if (typeof fn !== 'function') throw typeError('setImmediate: callback must be a function');
    return setImmediate(guardTimerCallback('setImmediate', fn), ...rest);
  },
  clearTimeout: function (h) { clearTimeout(h); },
  clearInterval: function (h) { clearInterval(h); },
  clearImmediate: function (h) { clearImmediate(h); },
};

// The host ignores rejections nobody handles; Node would kill the sandbox process over one
process.on('unhandledRejection', function (e) {
  log.warn('unhandled promise rejection: ' + errString(e));
});

// ─── execution ──────────────────────────────────────────────────────────────

const ruleflow = {
  list: function () { return toPlugin([]); },
};

const sandbox = {
  plugin, log, config, data,
  // crypto: pure functions, always injected (no permission semantics)
  crypto: cryptoFacade,
  // Conditionally inject anime/task/http/ruleflow only when the matching
  // permission is declared, mirror host (internal/plugin/runtime.go)
  anime: declaredPerms.has('api.anime.read') ? anime : undefined,
  task: declaredPerms.has('api.task.read') ? task : undefined,
  http: declaredPerms.has('api.http') ? http : undefined,
  // api.ruleflow is the deprecated alias of api.ruleflow.read — either one injects ruleflow.list
  ruleflow: (declaredPerms.has('api.ruleflow.read') || declaredPerms.has('api.ruleflow')) ? ruleflow : undefined,
  // Object per domain, methods per permission (read-only ⇒ no write methods)
  ptsite: (declaredPerms.has('api.ptsite.read') || declaredPerms.has('api.ptsite.write')) ? buildPTSite(declaredPerms) : undefined,
  douban: (declaredPerms.has('api.douban.cookie.read') || declaredPerms.has('api.douban.cookie.write')) ? buildDouban(declaredPerms) : undefined,
  // notify.send only with api.notify.send (otherwise typeof notify === "undefined", like the host)
  notify: declaredPerms.has('api.notify.send') ? buildNotify() : undefined,
  // utility: runtime needs Date / JSON / Math / etc — vm provides them by default
  // timers: open since 2026-09-25 (host timers.go); callback errors only log a WARN
  setTimeout: timers.setTimeout,
  setInterval: timers.setInterval,
  setImmediate: timers.setImmediate,
  clearTimeout: timers.clearTimeout,
  clearInterval: timers.clearInterval,
  clearImmediate: timers.clearImmediate,
  // no console (the host has none either): use log.*
};

vm.createContext(sandbox, {
  microtaskMode: 'afterEvaluate',
  codeGeneration: { strings: false, wasm: false },
});
// Host sets eval and Function to undefined (runtime.go "关闭动态求值入口") and has no console
// (eventloop.EnableConsole(false)); V8 gives every vm context its own console — remove it
vm.runInContext('eval = undefined; Function = undefined; delete globalThis.console;', sandbox);
CtxPromise = vm.runInContext('Promise', sandbox);
CtxError = vm.runInContext('Error', sandbox);
CtxTypeError = vm.runInContext('TypeError', sandbox);
CtxUint8Array = vm.runInContext('Uint8Array', sandbox);
CtxArray = vm.runInContext('Array', sandbox);
CtxObject = vm.runInContext('Object', sandbox);
ctxJSONParse = vm.runInContext('JSON.parse', sandbox);

// Host R1: the JSON.parse / JSON.stringify the plugin sees are guarded (goja's built-ins recurse on
// the Go stack; a deep / huge value would kill the process). Same limits as the host's exportJSON.
//   - parse: a linear scan (string literals skipped) counts the nesting first; deeper than 1000 →
//     TypeError, otherwise the built-in parse runs (reviver unchanged)
//   - stringify: nesting deeper than 1000 or more than 1,000,000 visited values → TypeError; the
//     plugin's own replacer (function or property list), toJSON and space keep their meaning and
//     normal output is byte-for-byte the built-in's
vm.runInContext(`(function () {
  var nativeParse = JSON.parse, nativeStringify = JSON.stringify;
  var MAX_DEPTH = 1000, MAX_VALUES = 1000000;
  var isArray = Array.isArray;
  function tooDeep(s) {
    var depth = 0, inStr = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (inStr) {
        if (c === 92) i++;            // backslash: skip the escaped char
        else if (c === 34) inStr = false;
      } else if (c === 34) {
        inStr = true;
      } else if (c === 91 || c === 123) {
        if (++depth > MAX_DEPTH) return true;
      } else if (c === 93 || c === 125) {
        depth--;
      }
    }
    return false;
  }
  JSON.parse = function parse(text, reviver) {
    var s = String(text);
    if (tooDeep(s)) throw new TypeError("JSON.parse: input nested deeper than " + MAX_DEPTH + " levels");
    return arguments.length > 1 ? nativeParse(s, reviver) : nativeParse(s);
  };
  JSON.stringify = function stringify(value, replacer, space) {
    var fn = typeof replacer === "function" ? replacer : null;
    var list = null;
    if (!fn && isArray(replacer)) {
      list = [];
      for (var i = 0; i < replacer.length; i++) {
        var item = replacer[i], key;
        if (typeof item === "string") key = item;
        else if (typeof item === "number") key = String(item);
        else if (item && typeof item === "object" &&
                 (Object.prototype.toString.call(item) === "[object String]" ||
                  Object.prototype.toString.call(item) === "[object Number]")) key = String(item);
        else continue;
        if (list.indexOf(key) < 0) list.push(key);
      }
    }
    var depth = new Map(), values = 0;
    function guard(k, v) {
      if (fn) v = fn.call(this, k, v);
      else if (list && v !== null && typeof v === "object" && !isArray(v)) {
        // property list: keep only the listed keys, in list order, at every level (like the built-in)
        var o = {};
        for (var j = 0; j < list.length; j++) {
          Object.defineProperty(o, list[j], { value: v[list[j]], enumerable: true, writable: true, configurable: true });
        }
        v = o;
      }
      values++;
      if (values > MAX_VALUES) throw new TypeError("JSON.stringify: more than " + MAX_VALUES + " values");
      if (v !== null && (typeof v === "object" || typeof v === "function")) {
        var d = (depth.get(this) || 0) + 1;
        if (d > MAX_DEPTH) throw new TypeError("JSON.stringify: value nested deeper than " + MAX_DEPTH + " levels (circular reference?)");
        depth.set(v, d);
      }
      return v;
    }
    return nativeStringify(value, guard, space);
  };
})();`, sandbox);

// Host B3: the entry script (including timer callbacks / microtasks it triggers while running)
// gets 10 seconds; past that the plugin fails to enable.
const ENTRY_TIMEOUT_MS = 10000;

// The entry script runs when the first RPC message arrives — after the initial configReplace
// (server.py sends it first), so top-level config.get sees the saved config like on the host.
let loadError = validateManifest(manifest);
let entryDone = false;
function runEntry() {
  if (entryDone) return;
  entryDone = true;
  if (!loadError) {
    try {
      vm.runInContext(indexJs, sandbox, {
        filename: path.join(pluginDir, 'index.js'),
        timeout: ENTRY_TIMEOUT_MS,
      });
    } catch (e) {
      loadError = (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
        ? 'run entry script: entry script exceeded ' + (ENTRY_TIMEOUT_MS / 1000) + 's (interrupted)' // host R2 wording
        : String(e && e.stack || e);
    }
  }
  emitEvent('ready', {
    hooks: Object.keys(hooks),
    apis: Object.keys(apis),
    manifest,
    loadError,
  });
}

// ─── callback invocation (mirrors host worker.invoke) ────────────────────────

// Host returns the Go sentinel ErrRuntimeTimeout: its message has no "Error: " prefix
function timeoutError() {
  return { devrtTimeout: true, message: ERR_RUNTIME_TIMEOUT, toString: function () { return ERR_RUNTIME_TIMEOUT; } };
}

// Runs fn(...args) with the host's wall-clock budget (including await time).
//   - synchronous segment runs via vm with `timeout` → a pure-JS infinite loop is
//     interrupted, like the host's rt.Interrupt
//   - a returned Promise is awaited for the remaining budget; late settlement ignored
//   - throw / rejection → rejected Promise (handled as a throw)
// Continuations after an await run in drainMicrotasks() under CONTINUATION_GUARD_MS (devrt only).
function invokeWithTimeout(fn, args, budgetMs) {
  const start = Date.now();
  let value;
  try {
    value = runInPlugin(fn, args, budgetMs);
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Promise.reject(timeoutError());
    return Promise.reject(e);
  }
  if (!utilTypes.isPromise(value)) return Promise.resolve(value);
  const remaining = Math.max(0, budgetMs - (Date.now() - start));
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(timeoutError()); }, remaining);
    value.then(function (v) { clearTimeout(timer); resolve(v); },
               function (e) { clearTimeout(timer); reject(e); });
    drainMicrotasks();
  });
}

// Plain JSON copy of what the plugin returned (host A.1 exportJSON: a cyclic value is an ordinary
// error; nesting deeper than 1000 levels or more than 1,000,000 values is refused the same way).
// Uses devrt's own JSON, so a plugin that overwrites its global JSON changes nothing (like the host).
const EXPORT_PREFIX = 'plugin return value is not JSON-serializable: ';
const EXPORT_MAX_DEPTH = 1000;
const EXPORT_MAX_VALUES = 1000000;
function exportValue(v) {
  if (v === undefined || v === null) return null;
  const depth = new Map();
  let values = 0;
  let limitErr = null;
  let str;
  try {
    str = JSON.stringify(v, function (k, val) {
      values++;
      if (values > EXPORT_MAX_VALUES) limitErr = 'more than ' + EXPORT_MAX_VALUES + ' values';
      else if (val !== null && (typeof val === 'object' || typeof val === 'function')) {
        const d = (depth.get(this) || 0) + 1;
        if (d > EXPORT_MAX_DEPTH) limitErr = 'nested deeper than ' + EXPORT_MAX_DEPTH + ' levels (circular reference?)';
        else depth.set(val, d);
      }
      if (limitErr) throw new TypeError(limitErr);
      return val;
    });
  } catch (e) {
    if (limitErr) throw new Error(EXPORT_PREFIX + limitErr);
    throw new Error(EXPORT_PREFIX + String(errString(e)).split('\n')[0]);
  }
  if (str === undefined) return null;
  return JSON.parse(str);
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

  if (!entryDone) {
    if (method === 'configReplace') configStore = Object.assign(Object.create(null), params.entries || {});
    runEntry();
  }

  function reply(result) { send({ id, result }); }
  function fail(err) {
    if (err && err.devrtTimeout) { send({ id, error: ERR_RUNTIME_TIMEOUT, timeout: true }); return; }
    send({ id, error: String(err && err.stack || err) });
  }

  try {
    switch (method) {
      case 'init':
        reply({ hooks: Object.keys(hooks), apis: Object.keys(apis), manifest, loadError });
        break;

      case 'configReplace':
        configStore = Object.assign(Object.create(null), params.entries || {});
        reply({ ok: true });
        break;

      // Only the changed keys: a concurrent plugin config.set to another key is not clobbered
      case 'configPatch': {
        const set = params.set || {};
        for (const k of Object.keys(set)) configStore[k] = String(set[k]);
        for (const k of params.delete || []) delete configStore[k];
        reply({ ok: true });
        break;
      }

      case 'configGetAll':
        reply({ entries: Object.assign({}, configStore) });
        break;

      case 'trigger': {
        const fn = hooks[params.hook];
        if (!fn) return fail('hook not registered: ' + params.hook);
        if (params.hook === 'on_notify_action' || params.hook === 'on_bot_command') {
          triggerInteraction(params.hook, fn, params.data, reply);
          break;
        }
        const isFilter = params.hook === 'should_download';
        invokeWithTimeout(fn, [toPlugin(params.data || {})], isFilter ? FILTER_TIMEOUT_MS : HOOK_TIMEOUT_MS).then(function (result) {
          // should_download is the veto hook — echo what the host would conclude. The host decides on
          // the *exported* (JSON-copied) value: e.g. an object whose toJSON returns false vetoes; a value
          // that cannot be exported (cyclic, BigInt, too deep) is an error → fail-open
          if (isFilter) {
            let out;
            try {
              out = exportValue(result);
            } catch (e) {
              const why = errString(e).replace(/^Error: /, '');
              log.warn('[devrt] should_download failed: ' + why + ' → fail-open (allow)');
              reply({ ok: true, result: null, verdict: 'allow', fail_open: true, error: why });
              return;
            }
            reply({ ok: true, result: out, verdict: filterVerdict(out), fail_open: false });
          } else {
            reply({ ok: true });
          }
        }, function (e) {
          if (isFilter) {
            // Host: should_download timeout / throw / reject → fail-open (allow); late result ignored
            const why = e && e.devrtTimeout ? ERR_RUNTIME_TIMEOUT : errString(e);
            log.warn('[devrt] should_download ' + (e && e.devrtTimeout ? 'timed out after ' + FILTER_TIMEOUT_MS + 'ms' : 'failed: ' + why) + ' → fail-open (allow)');
            reply({ ok: true, result: null, verdict: 'allow', fail_open: true, error: why });
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
        invokeWithTimeout(fn, [toPlugin(params.req || { method: 'GET', body: '', query: {} })], API_TIMEOUT_MS).then(function (out) {
          let v;
          // Host: the exportJSON error text is what the caller sees
          try { v = exportValue(out); } catch (e) { return fail(e.message); }
          reply({ result: v });
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

// What the host's gate (Manager.ShouldDownload) concludes from the exported should_download value:
// only JSON false vetoes; an object whose have_bitmap is a non-empty string that decodes (standard
// padded base64) to at least one byte filters a batch; everything else allows
function filterVerdict(v) {
  if (v === false) return 'veto';
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.have_bitmap === 'string' && v.have_bitmap !== '') {
    const b64 = v.have_bitmap.replace(/[\r\n]/g, '');
    if (b64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(b64) && Buffer.from(b64, 'base64').length > 0) return 'have_bitmap';
  }
  return 'allow';
}

rl.on('close', function () { process.exit(0); });
