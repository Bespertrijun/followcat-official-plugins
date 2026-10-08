// Plugin Dev Runtime — Node sandbox
// =====================================
//
// Loads <plugin>/index.js inside Node's `vm` module with goja-compatible globals
// injected (plugin / log / config / crypto / http / anime / task / ruleflow /
// ptsite / douban), then talks JSON-RPC to
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
];
const HOST_HOOKS = [
  'on_episode_found', 'on_download_done', 'on_download_failed', 'on_link_done', 'on_link_failed',
  'on_task_completed', 'on_task_reopened', 'on_episode_acquired', 'on_task_subscribed', 'should_download',
];

function validateManifest(m) {
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
  return null;
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
