// 把 plugins/cookiecloud/index.js 载入 Node vm，注入与宿主同形的 stub facade（crypto 用 node:crypto 真算，
// 与 devrt 一致），供 cookiecloud.test.js 使用。定时器是可手动触发的假实现。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const { normalizeCookie } = require('../../devrt/cookie-normalize');

const INDEX_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'cookiecloud', 'index.js'), 'utf-8');

function toBuf(v) {
  if (typeof v === 'string') return Buffer.from(v, 'utf-8');
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

const cryptoFacade = {
  sha256: (v) => nodeCrypto.createHash('sha256').update(toBuf(v)).digest('hex'),
  md5: (v) => nodeCrypto.createHash('md5').update(toBuf(v)).digest('hex'),
  base64Decode: (s) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('crypto.base64Decode: illegal base64 data');
    return new Uint8Array(Buffer.from(s, 'base64'));
  },
  evpBytesToKey: (password, salt, keyLen, ivLen) => {
    const pwd = toBuf(password);
    const s = salt ? toBuf(salt) : Buffer.alloc(0);
    let out = Buffer.alloc(0), prev = Buffer.alloc(0);
    while (out.length < keyLen + ivLen) {
      prev = nodeCrypto.createHash('md5').update(Buffer.concat([prev, pwd, s])).digest();
      out = Buffer.concat([out, prev]);
    }
    return { key: new Uint8Array(out.subarray(0, keyLen)), iv: new Uint8Array(out.subarray(keyLen, keyLen + ivLen)) };
  },
  aesDecryptCBC: (key, iv, data) => {
    const k = toBuf(key), i = toBuf(iv), d = toBuf(data);
    if (d.length === 0 || d.length % 16 !== 0) throw new Error('crypto.aesDecryptCBC: data length must be a positive multiple of 16');
    try {
      const dec = nodeCrypto.createDecipheriv('aes-' + (k.length * 8) + '-cbc', k, i);
      return new Uint8Array(Buffer.concat([dec.update(d), dec.final()]));
    } catch (e) {
      throw new Error('crypto.aesDecryptCBC: invalid PKCS7 padding (wrong key or corrupted data)');
    }
  },
};

function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function fingerprint(plain) {
  return plain ? nodeCrypto.createHash('sha256').update(normalizeCookie(plain), 'utf8').digest('hex') : '';
}

// opts: { config, sites: [{id,name,adapter,auth_kind,hosts,cookie}], http: async (url) => resp, doubanValidation,
//         failWrite: (id) => bool, writeGate: (id) => Promise（setCookie 等它 resolve 之后才落库） }
function load(opts) {
  opts = opts || {};
  const configStore = Object.assign({}, opts.config || {});
  const logs = [];
  const apis = {};
  const writes = [];
  const sites = (opts.sites || []).map((s) => Object.assign({ enabled: true, apikey: '', cookie: '', hosts: [] }, s));
  let doubanCookie = opts.doubanCookie || '';
  const timers = [];
  let nextTimer = 1;

  const view = (s) => ({ id: s.id, name: s.name, adapter: s.adapter, enabled: s.enabled, auth_kind: s.auth_kind,
    has_cookie: s.cookie !== '', has_apikey: s.apikey !== '', hosts: s.hosts.slice() });

  const ctx = {
    plugin: {
      on() { throw new Error('no hooks expected'); },
      registerAPI(p, fn) { apis[p] = fn; },
    },
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
    },
    config: {
      get: (k) => (k in configStore ? configStore[k] : null),
      set: (k, v) => { if (typeof v !== 'string') throw new Error('config.set value must be string'); configStore[k] = v; },
    },
    crypto: cryptoFacade,
    http: {
      get: (url, headers) => Promise.resolve().then(() => (opts.http ? opts.http(url, headers) : { status: 404, body: '', headers: {}, truncated: false })),
    },
    ptsite: {
      list: () => sites.map(view),
      get: (id) => { const s = sites.find((x) => x.id === id); return s ? view(s) : null; },
      getCookieMeta: (id) => { const s = sites.find((x) => x.id === id); return s ? { configured: s.cookie !== '', sha256: fingerprint(s.cookie) } : null; },
      setCookie: (id, value) => {
        writes.push({ target: id, value });
        const gate = opts.writeGate ? opts.writeGate(id) : Promise.resolve();
        return gate.then(() => new Promise((resolve, reject) => setImmediate(() => {
          const s = sites.find((x) => x.id === id);
          if (!s) return reject(new Error('pt credential: site not found: "' + id + '"'));
          if (opts.failWrite && opts.failWrite(id)) return reject(new Error('pt credential: boom for ' + id));
          s.cookie = value;
          resolve({ ok: true });
        })));
      },
    },
    douban: {
      getCookie: () => (doubanCookie ? { configured: true, sha256: fingerprint(doubanCookie) } : { configured: false, sha256: '' }),
      setCookie: (value, o) => {
        writes.push({ target: 'douban', value, validate: !!(o && o.validate) });
        return new Promise((resolve) => setImmediate(() => { doubanCookie = value; resolve({ ok: true, validation: opts.doubanValidation || 'ok' }); }));
      },
    },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, ms, repeat: true, cleared: false }); return id; },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, ms, repeat: false, cleared: false }); return id; },
    clearInterval: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
  };
  vm.createContext(ctx);
  vm.runInContext(INDEX_JS, ctx, { filename: 'plugins/cookiecloud/index.js' });

  const h = {
    ctx, apis, logs, writes, configStore, sites, timers,
    doubanCookie: () => doubanCookie,
    activeTimers: () => timers.filter((t) => !t.cleared),
    // 返回值按宿主那样导出成普通 JSON 值（也消掉 vm 跨 realm 的原型差异）
    call: (p, req) => plain(apis[p](req || { method: 'POST', body: '', query: {} })),
    startSync: (trigger) => plain(ctx.startSync(trigger)),
    // 触发一次同步并等它结束，返回 /status
    async syncAndWait(trigger) {
      const r = trigger === 'timer' ? h.startSync('timer') : h.call('/sync');
      for (let i = 0; i < 200; i++) {
        const st = h.call('/status');
        if (!st.running) return Object.assign({ start: r }, st);
        await new Promise((res) => setImmediate(res));
      }
      throw new Error('sync did not finish');
    },
  };
  return h;
}

module.exports = { load, fingerprint, cryptoFacade };
