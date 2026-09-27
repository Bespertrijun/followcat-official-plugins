// node --test tests/cookiecloud/cookiecloud.test.js
// cookiecloud 插件：解密（官方算法两种向量）、§0.5 匹配规则、同步流程、定时重排。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, fingerprint } = require('./harness');
const { BROWSER_COOKIES, groupByKeywords, groupByRawDomain } = require('./fixtures');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf-8'));
const NOW = 1790000000; // 2026-09 左右（秒）

const HHAN = { id: 'site-hhan', name: '憨憨', adapter: 'hhan', auth_kind: 'cookie', hosts: ['hhanclub.top'] };
const OURBITS = { id: 'site-ob', name: '我堡', adapter: 'ourbits', auth_kind: 'cookie', hosts: ['ourbits.club'] };
const NORSS = { id: 'site-norss', name: '没 RSS', adapter: 'hhan', auth_kind: 'cookie', hosts: [] };
const NOCK = { id: 'site-nock', name: '观众', adapter: 'audiences', auth_kind: 'cookie', hosts: ['audiences.me'] };
const MTEAM = { id: 'site-mt', name: '馒头', adapter: 'mteam', auth_kind: 'apikey', hosts: ['api.m-team.cc'] };

function header(h, cookies, hosts) {
  return h.ctx.buildCookieHeader(h.ctx.flattenCookies(cookies), hosts, NOW).header;
}

// ─── 解密 ───────────────────────────────────────────────────────────────────

for (const type of ['legacy', 'aes-128-cbc-fixed']) {
  test('解密官方 ' + type + ' 密文还原原 JSON（含中文 / emoji）', () => {
    const h = load();
    const data = h.ctx.decryptPayload(V.vectors[type], V.uuid, V.password);
    assert.equal(JSON.stringify(data), V.plaintext);
    assert.match(JSON.stringify(data), /中文值/);
    assert.match(JSON.stringify(data), /😀/);
  });
}

test('crypto_type 缺省按 legacy', () => {
  const h = load();
  const data = h.ctx.decryptPayload({ encrypted: V.vectors.legacy.encrypted }, V.uuid, V.password);
  assert.equal(JSON.stringify(data), V.plaintext);
});

test('未知 crypto_type 报「不支持的加密方式」', () => {
  const h = load();
  assert.throws(() => h.ctx.decryptPayload({ encrypted: V.vectors.legacy.encrypted, crypto_type: 'rot13' }, V.uuid, V.password),
    /不支持的加密方式 rot13/);
});

test('密码错 / 类型对不上 → 解密失败（不 panic）', () => {
  const h = load();
  assert.throws(() => h.ctx.decryptPayload(V.vectors.legacy, V.uuid, 'wrong'), /解密失败|不是 JSON/);
  assert.throws(() => h.ctx.decryptPayload(V.vectors['aes-128-cbc-fixed'], V.uuid, 'wrong'), /解密失败|不是 JSON/);
  // fixed 密文被当成 legacy：没有 Salted__ 头
  assert.throws(() => h.ctx.decryptPayload({ encrypted: V.vectors['aes-128-cbc-fixed'].encrypted, crypto_type: 'legacy' }, V.uuid, V.password),
    /解密失败/);
});

// ─── §0.5 匹配 ───────────────────────────────────────────────────────────────

test('前导点 domain：本域与子域都命中，只按点边界', () => {
  const h = load();
  const c = { name: 'a', value: '1', domain: '.hhanclub.top' };
  assert.equal(h.ctx.cookieMatchesHost(c, 'hhanclub.top'), true);
  assert.equal(h.ctx.cookieMatchesHost(c, 'rss.hhanclub.top'), true);
  assert.equal(h.ctx.cookieMatchesHost(c, 'a.b.hhanclub.top'), true);
  assert.equal(h.ctx.cookieMatchesHost(c, 'nothhanclub.top'), false);
  assert.equal(h.ctx.cookieMatchesHost(c, 'hhanclub.top.evil.com'), false);
  assert.equal(h.ctx.cookieMatchesHost({ name: 'a', value: '1', domain: '.HHANCLUB.top' }, 'Rss.HhanClub.top'), true);
});

test('host-only cookie 不跨子域', () => {
  const h = load();
  const c = { name: 'a', value: '1', domain: 'hhanclub.top', hostOnly: true };
  assert.equal(h.ctx.cookieMatchesHost(c, 'hhanclub.top'), true);
  assert.equal(h.ctx.cookieMatchesHost(c, 'rss.hhanclub.top'), false);
  // 父域的 cookie 不会发给更短的主机
  assert.equal(h.ctx.cookieMatchesHost({ name: 'a', value: '1', domain: '.rss.hhanclub.top' }, 'hhanclub.top'), false);
});

test('展平 + (name,domain,path) 去重 + 跳过过期 + 同名不同 path 都保留', () => {
  const h = load();
  const grouped = groupByKeywords(BROWSER_COOKIES, ['hhanclub', 'hhanclub.top', 'ourbits']); // 同一条进两组
  assert.equal(header(h, grouped, ['hhanclub.top']),
    'c_secure_uid=10086; c_secure_pass=hhan-pass-中文值; cf_clearance=cf-token; sess=session-cookie');
  assert.equal(header(h, grouped, ['ourbits.club']), 'uid=42; pref=a; pref=b');
});

test('多个 hosts 取并集（RSS 在子域时 host-only 的子域 cookie 也要）', () => {
  const h = load();
  const grouped = groupByRawDomain(BROWSER_COOKIES); // 按原始域名分组：".hhanclub.top" 组在 "hhanclub.top" 组前
  assert.equal(header(h, grouped, ['hhanclub.top', 'tracker.hhanclub.top']),
    'c_secure_uid=10086; c_secure_pass=hhan-pass-中文值; sess=session-cookie; cf_clearance=cf-token; tracker_only=tk');
  assert.equal(header(h, grouped, ['tracker.hhanclub.top']),
    'c_secure_uid=10086; c_secure_pass=hhan-pass-中文值; sess=session-cookie; tracker_only=tk');
});

test('豆瓣固定 m.douban.com：www 的 host-only cookie 不要', () => {
  const h = load();
  assert.equal(header(h, groupByRawDomain(BROWSER_COOKIES), ['m.douban.com']), 'dbcl2="123456:abc😀"; ck=Xy12; frodo=mobile');
});

test('关键词分组与原始域名分组（含黑名单）对每个目标得到同一结果（按指纹比）', () => {
  const h = load();
  const byKw = groupByKeywords(BROWSER_COOKIES, ['hhanclub', 'ourbits', 'douban']);
  const byRaw = groupByRawDomain(BROWSER_COOKIES, ['example.com']);
  for (const hosts of [['hhanclub.top'], ['tracker.hhanclub.top'], ['ourbits.club'], ['m.douban.com']]) {
    const a = header(h, byKw, hosts), b = header(h, byRaw, hosts);
    assert.ok(a.length > 0, 'non-empty for ' + hosts);
    assert.equal(fingerprint(a), fingerprint(b), 'grouping mismatch for ' + hosts);
  }
});

// ─── 同步流程 ────────────────────────────────────────────────────────────────

function cloud(type, counter) {
  return (url) => {
    if (counter) counter.n++;
    assert.equal(url, 'https://cc.example.com/get/' + encodeURIComponent(V.uuid));
    return { status: 200, headers: {}, truncated: false, body: JSON.stringify(V.vectors[type]) };
  };
}

function baseConfig(extra) {
  return Object.assign({ host: 'https://cc.example.com/', cloud_uuid: V.uuid, cloud_pwd: V.password }, extra);
}

test('首次同步写入；第二次指纹命中不写；每站状态可读', async () => {
  const counter = { n: 0 };
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id, OURBITS.id, NORSS.id, NOCK.id, MTEAM.id, 'site-deleted']), sync_douban: 'true' }),
    sites: [HHAN, OURBITS, NORSS, NOCK, MTEAM],
    http: cloud('aes-128-cbc-fixed', counter),
    doubanValidation: 'cookie_invalid',
  });
  const st = await h.syncAndWait();
  assert.deepEqual(st.start, { started: true });
  const by = Object.fromEntries(st.results.map((r) => [r.target, r]));
  assert.equal(by[HHAN.id].status, 'written');
  assert.equal(by[OURBITS.id].status, 'written');
  assert.equal(by[NORSS.id].status, 'no_rss');
  assert.equal(by[NOCK.id].status, 'no_cookie');
  assert.equal(by[MTEAM.id].status, 'not_cookie_site');
  assert.equal(by['site-deleted'].status, 'site_missing');
  assert.equal(by.douban.status, 'written');
  assert.equal(by.douban.validation, 'cookie_invalid');
  assert.match(by.douban.message, /未登录或已失效/);
  assert.match(by[NORSS.id].message, /没配 RSS/);
  assert.match(by[NOCK.id].message, /没有该站的 cookie/);
  assert.match(by['site-deleted'].message, /已删除/);
  assert.equal(h.sites.find((s) => s.id === HHAN.id).cookie,
    'c_secure_uid=10086; c_secure_pass=hhan-pass-中文值; cf_clearance=cf-token; sess=session-cookie');
  assert.equal(h.doubanCookie(), 'dbcl2="123456:abc😀"; ck=Xy12; frodo=mobile');
  assert.equal(h.writes.length, 3);
  assert.equal(h.writes.find((w) => w.target === 'douban').validate, true);
  assert.equal(st.last_error, '');
  assert.equal(st.synced_count, 1);
  assert.ok(st.last_synced_at);
  assert.equal(st.last_trigger, 'manual');

  const st2 = await h.syncAndWait();
  assert.equal(h.writes.length, 3, 'unchanged cookies must not be written again');
  for (const id of [HHAN.id, OURBITS.id, 'douban']) {
    assert.equal(st2.results.find((r) => r.target === id).status, 'unchanged');
  }
  assert.equal(st2.synced_count, 2);
  assert.equal(counter.n, 2);
});

test('写法不同但归一化相同的已存 cookie 视为未变化', async () => {
  const site = Object.assign({}, HHAN, { cookie: ' sess=session-cookie;cf_clearance=cf-token; c_secure_pass=hhan-pass-中文值 ;c_secure_uid=10086;' });
  const h = load({ config: baseConfig({ sites: JSON.stringify([HHAN.id]) }), sites: [site], http: cloud('legacy') });
  const st = await h.syncAndWait();
  assert.equal(st.results[0].status, 'unchanged');
  assert.equal(h.writes.length, 0);
});

test('某站写入失败按站收集，不影响其它站；last_error 记下', async () => {
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id, OURBITS.id]) }),
    sites: [HHAN, OURBITS], http: cloud('legacy'), failWrite: (id) => id === HHAN.id,
  });
  const st = await h.syncAndWait();
  assert.equal(st.results[0].status, 'failed');
  assert.match(st.results[0].message, /写入失败：pt credential: boom/);
  assert.equal(st.results[1].status, 'written');
  assert.match(st.last_error, /憨憨/);
  assert.equal(st.synced_count, 1);
});

test('已在跑时再触发（手动 / 定时）都跳过', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id]) }), sites: [HHAN],
    http: async () => { await gate; return cloud('legacy')('https://cc.example.com/get/' + encodeURIComponent(V.uuid)); },
  });
  assert.deepEqual(h.call('/sync'), { started: true });
  assert.equal(h.call('/status').running, true);
  assert.deepEqual(h.call('/sync'), { started: false, reason: 'already_running' });
  assert.deepEqual(h.startSync('timer'), { started: false, reason: 'already_running' });
  release();
  for (let i = 0; i < 100 && h.call('/status').running; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.call('/status').running, false);
  assert.equal(h.writes.length, 1);
});

test('配置缺失 / 网络失败 / 404 / 非 JSON / sites 非法：报错不 panic，running 复位，UUID 不进错误文案', async () => {
  const cases = [
    [{ host: '', cloud_uuid: '', cloud_pwd: '' }, null, /还没配置：CookieCloud 地址、UUID、密码/],
    [baseConfig({ host: 'cc.example.com' }), null, /要以 http/],
    [baseConfig({ sites: '{bad' }), null, /sites 不是合法的 JSON/],
    [baseConfig(), () => { throw new Error('http GET https://cc.example.com/get/' + V.uuid + ': dial tcp: refused'); }, /连不上 CookieCloud/],
    [baseConfig(), () => ({ status: 404, body: 'Not Found', headers: {}, truncated: false }), /找不到这个 UUID/],
    [baseConfig(), () => ({ status: 429, body: '', headers: {}, truncated: false }), /限流/],
    [baseConfig(), () => ({ status: 200, body: '<html>', headers: {}, truncated: false }), /不是 JSON/],
    [baseConfig(), () => ({ status: 200, body: '{}', headers: {}, truncated: false }), /没有密文/],
    [baseConfig({ cloud_pwd: 'wrong' }), cloud('legacy'), /解密失败|不是 JSON/],
  ];
  for (const [config, http, re] of cases) {
    const h = load({ config, sites: [HHAN], http });
    const st = await h.syncAndWait();
    assert.equal(st.running, false);
    assert.match(st.last_error, re);
    assert.ok(!st.last_error.includes(V.uuid), 'uuid leaked: ' + st.last_error);
    assert.equal(st.synced_count, 0);
    assert.deepEqual(st.results, []);
  }
});

// ─── 定时 ────────────────────────────────────────────────────────────────────

test('启动时不立刻同步，按间隔排一个 setInterval；间隔没变不重排；改间隔即时重排；0 关闭；超上限截住', async () => {
  const counter = { n: 0 };
  const h = load({ config: baseConfig({ sites: JSON.stringify([HHAN.id]), sync_interval_min: '30' }), sites: [HHAN], http: cloud('legacy', counter) });
  assert.equal(counter.n, 0);
  assert.equal(h.activeTimers().length, 1);
  assert.equal(h.activeTimers()[0].ms, 30 * 60000);
  const st = h.call('/status');
  assert.equal(st.interval_min, 30);
  assert.ok(st.next_run_at);

  h.call('/reschedule');
  assert.equal(h.timers.length, 1, 'same interval must not re-arm');

  h.configStore.sync_interval_min = '5';
  h.call('/reschedule');
  assert.equal(h.activeTimers().length, 1);
  assert.equal(h.activeTimers()[0].ms, 5 * 60000);

  // 定时器触发走同一个入口
  h.activeTimers()[0].fn();
  assert.equal(h.call('/status').last_trigger, 'timer');
  for (let i = 0; i < 100 && h.call('/status').running; i++) await new Promise((r) => setImmediate(r));
  assert.equal(counter.n, 1);

  h.configStore.sync_interval_min = '0';
  h.call('/reschedule');
  assert.equal(h.activeTimers().length, 0);
  assert.equal(h.call('/status').next_run_at, null);

  h.configStore.sync_interval_min = '99999999';
  h.call('/reschedule');
  assert.equal(h.activeTimers()[0].ms, 2147483647);

  for (const bad of ['', 'abc', '-5', '1.5']) {
    h.configStore.sync_interval_min = bad;
    h.call('/reschedule');
    assert.equal(h.activeTimers().length, 0, 'interval ' + JSON.stringify(bad) + ' must disable');
  }
});

test('/sites：只列 cookie 站；勾选了但找不到 / 变成非 cookie 站的单列', () => {
  const h = load({ config: { sites: JSON.stringify([HHAN.id, MTEAM.id, 'gone']) }, sites: [HHAN, OURBITS, MTEAM] });
  const r = h.call('/sites', { method: 'GET', body: '', query: {} });
  assert.deepEqual(r.sites.map((s) => s.id), [HHAN.id, OURBITS.id]);
  assert.deepEqual(r.sites[0].hosts, ['hhanclub.top']);
  assert.deepEqual(r.selected, [HHAN.id, MTEAM.id, 'gone']);
  assert.deepEqual(r.missing, [{ id: MTEAM.id, name: '馒头', reason: 'not_cookie_site' }, { id: 'gone', name: '', reason: 'site_missing' }]);
});

// ─── 2026-09-25 审核修复（I1 / I6 / 存活突变） ────────────────────────────────

const NORMALIZE_VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'plugins', 'cookie-normalize-vectors.json'), 'utf-8'));

test('插件内的 normalizeCookie 跑共享向量（与宿主 / devrt 同一组）', () => {
  const h = load();
  assert.ok(NORMALIZE_VECTORS.length >= 10);
  for (const v of NORMALIZE_VECTORS) {
    assert.equal(h.ctx.normalizeCookie(v.in), v.out, v.name);
  }
});

test('decodeUtf8：与 Node 的 UTF-8 解码逐字符一致（含 4 字节字符、跨 8192 分块边界）', () => {
  const h = load();
  const samples = ['', 'ascii', '中文值', '😀🍪', 'a😀'.repeat(5000), '中'.repeat(3000) + '😀' + 'x'.repeat(8191)];
  for (const s of samples) {
    const u8 = new Uint8Array(Buffer.from(s, 'utf-8'));
    assert.equal(h.ctx.decodeUtf8(u8), s);
  }
  // 4 字节字符正好跨在 8192 分块边界上
  const edge = Buffer.concat([Buffer.alloc(8190, 0x61), Buffer.from('😀', 'utf-8'), Buffer.from('尾', 'utf-8')]);
  assert.equal(h.ctx.decodeUtf8(new Uint8Array(edge)), edge.toString('utf-8'));
});

test('decodeUtf8：非法 UTF-8 一律抛错（不静默替换成 U+FFFD）', () => {
  const h = load();
  const bad = [[0xff], [0xe4, 0xb8], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80], [0x61, 0xf0, 0x9f, 0x98]];
  for (const b of bad) {
    assert.throws(() => h.ctx.decodeUtf8(new Uint8Array(b)), (e) => e && e.name === 'URIError', JSON.stringify(b));
  }
});

test('解密出非法 UTF-8 → 按「解密失败」报（不是「不是 JSON」）', () => {
  const h = load();
  // aes-128-cbc-fixed 密钥 = md5(uuid-pwd) 前 16 个十六进制字符；明文里放一个非法字节
  const nodeCrypto = require('crypto');
  const key = Buffer.from(nodeCrypto.createHash('md5').update(V.uuid + '-' + V.password).digest('hex').substring(0, 16), 'ascii');
  const c = nodeCrypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  const enc = Buffer.concat([c.update(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])), c.final()]).toString('base64');
  assert.throws(() => h.ctx.decryptPayload({ encrypted: enc, crypto_type: 'aes-128-cbc-fixed' }, V.uuid, V.password),
    /解密失败.*UTF-8/);
});

test('服务端没返回 crypto_type：按密文是否以 Salted__ 开头自动识别两种方式', () => {
  const h = load();
  for (const type of ['legacy', 'aes-128-cbc-fixed']) {
    const data = h.ctx.decryptPayload({ encrypted: V.vectors[type].encrypted }, V.uuid, V.password);
    assert.equal(JSON.stringify(data), V.plaintext, type);
  }
});

test('声明 legacy 但密文没有 Salted__ 头：报 Salted__ 格式错误（不是去解密）', () => {
  const h = load();
  assert.throws(() => h.ctx.decryptPayload({ encrypted: V.vectors['aes-128-cbc-fixed'].encrypted, crypto_type: 'legacy' }, V.uuid, V.password),
    /解密失败.*Salted__/);
});

test('无名 cookie（name 为空）只拼 value，不写成 "=value"', () => {
  const h = load();
  const cookies = { g: [
    { name: '', value: 'bare-token', domain: '.hhanclub.top' },
    { name: 'uid', value: '1', domain: '.hhanclub.top' },
  ] };
  assert.equal(header(h, cookies, ['hhanclub.top']), 'bare-token; uid=1');
});

test('各站写入并发发出：第一枪还没落库时第二枪已经发出', async () => {
  const pending = [];
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id, OURBITS.id]) }), sites: [HHAN, OURBITS], http: cloud('legacy'),
    writeGate: () => new Promise((r) => pending.push(r)),
  });
  h.call('/sync');
  for (let i = 0; i < 100 && h.writes.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.writes.length, 2, 'both setCookie calls must be issued before either resolves');
  assert.equal(h.call('/status').running, true);
  pending.forEach((r) => r());
  for (let i = 0; i < 100 && h.call('/status').running; i++) await new Promise((r) => setImmediate(r));
  const st = h.call('/status');
  assert.deepEqual(st.results.map((r) => r.status), ['written', 'written']);
});

test('有站写入失败时仍算一次「完成的同步」：last_synced_at 与次数照样更新', async () => {
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id]) }), sites: [HHAN], http: cloud('legacy'), failWrite: () => true,
  });
  const st = await h.syncAndWait();
  assert.equal(st.results[0].status, 'failed');
  assert.ok(st.last_synced_at, 'last_synced_at must be set even when a write failed');
  assert.equal(st.synced_count, 1);
});

test('整次同步出错时清掉上一次的每站结果（不留过期结果误导）', async () => {
  let fail = false;
  const ok = cloud('legacy');
  const h = load({
    config: baseConfig({ sites: JSON.stringify([HHAN.id]) }), sites: [HHAN],
    http: (url) => (fail ? { status: 500, body: '', headers: {}, truncated: false } : ok(url)),
  });
  const st1 = await h.syncAndWait();
  assert.equal(st1.results.length, 1);
  fail = true;
  const st2 = await h.syncAndWait();
  assert.match(st2.last_error, /HTTP 500/);
  assert.deepEqual(st2.results, []);
});

test('404 提示同时提到 UUID 与服务端路径前缀（API_ROOT）', async () => {
  const h = load({ config: baseConfig(), sites: [HHAN], http: () => ({ status: 404, body: '', headers: {}, truncated: false }) });
  const st = await h.syncAndWait();
  assert.match(st.last_error, /UUID/);
  assert.match(st.last_error, /API_ROOT/);
});

test('地址里的 user:pass@ 不进错误文案与日志', async () => {
  const h = load({
    config: baseConfig({ host: 'https://alice:s3cr%40t@cc.example.com' }), sites: [HHAN],
    http: (url) => { throw new Error('http GET ' + url + ': dial tcp: connection refused'); },
  });
  const st = await h.syncAndWait();
  assert.match(st.last_error, /连不上 CookieCloud：http GET https:\/\/cc\.example\.com\/get\/<UUID>: dial tcp/);
  for (const text of [st.last_error].concat(h.logs.map((l) => l[1]))) {
    assert.ok(!/alice|s3cr/.test(text), 'userinfo leaked: ' + text);
  }
});

test('stripUrlUserinfo：只去 authority 里的账号密码，路径里的 @ 不动', () => {
  const h = load();
  assert.equal(h.ctx.stripUrlUserinfo('x https://u:p@a.b/c@d y http://h/x'), 'x https://a.b/c@d y http://h/x');
  assert.equal(h.ctx.stripUrlUserinfo('HTTP://u@h:8088/get'), 'HTTP://h:8088/get');
});

test('I6 补漏：账号密码按「:// 之后、第一个 / 之前的最后一个 @」去掉（密码里有 ? # 空格 @ 也不漏）', () => {
  const h = load();
  const strip = (x) => h.ctx.stripUrlUserinfo(x);
  assert.equal(strip('http GET https://al:p?w@cc.example.com/get/<UUID>: refused'), 'http GET https://cc.example.com/get/<UUID>: refused');
  assert.equal(strip('http GET https://al:p#w@cc.example.com/get/x'), 'http GET https://cc.example.com/get/x');
  assert.equal(strip('http GET https://al:p w@cc.example.com/get/x'), 'http GET https://cc.example.com/get/x');
  assert.equal(strip('http GET https://al:p@w@cc.example.com/get/a@b'), 'http GET https://cc.example.com/get/a@b');
  assert.equal(strip('x http://a:b@h1/p y https://c:d?@h2/q'), 'x http://h1/p y https://h2/q');
});

test('I6 补漏：密码含 ? # @ 的地址出错时，错误文案与日志里没有账号密码', async () => {
  const h = load({
    config: baseConfig({ host: 'https://alice:s3?c#r@t@cc.example.com' }), sites: [HHAN],
    http: (url) => { throw new Error('http GET ' + url + ': dial tcp: connection refused'); },
  });
  const st = await h.syncAndWait();
  assert.match(st.last_error, /连不上 CookieCloud：http GET https:\/\/cc\.example\.com\/get\/<UUID>: dial tcp/);
  for (const text of [st.last_error].concat(h.logs.map((l) => l[1]))) {
    assert.ok(!/alice|s3\?c|r@t/.test(text), 'userinfo leaked: ' + text);
  }
});

test('≥1 MB 的真实形态数据：两种加密方式都能在 2s 内解完并同步', async () => {
  const nodeCrypto = require('crypto');
  // 与扩展上传同形：很多站、每站很多 cookie，混中文 / emoji
  const cookieData = {};
  let n = 0;
  while (JSON.stringify(cookieData).length < 1100000) {
    const dom = 'site' + n + '.example.org';
    cookieData[dom] = [];
    for (let i = 0; i < 20; i++) {
      cookieData[dom].push({ name: '__utm' + i, value: '30149280.1790000000.1.1.utmcsr=(direct)|中文值😀' + n, domain: '.' + dom,
        hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'unspecified', session: false, expirationDate: 4102444800, storeId: '0' });
    }
    n++;
  }
  cookieData.hhanclub = [{ name: 'uid', value: 'big-中文', domain: '.hhanclub.top', path: '/', expirationDate: 4102444800 }];
  const plaintext = JSON.stringify({ cookie_data: cookieData, local_storage_data: {}, update_time: '2026-09-25T00:00:00.000Z' });
  assert.ok(Buffer.byteLength(plaintext) >= 1024 * 1024);
  const pass = nodeCrypto.createHash('md5').update(V.uuid + '-' + V.password).digest('hex').substring(0, 16);
  const enc = {};
  { // legacy：CryptoJS 口令模式 = "Salted__" + salt + AES-256-CBC(EVP_BytesToKey(MD5))
    const salt = nodeCrypto.randomBytes(8);
    const { cryptoFacade } = require('./harness');
    const kv = cryptoFacade.evpBytesToKey(pass, salt, 32, 16);
    const c = nodeCrypto.createCipheriv('aes-256-cbc', Buffer.from(kv.key), Buffer.from(kv.iv));
    enc.legacy = Buffer.concat([Buffer.from('Salted__'), salt, c.update(plaintext, 'utf-8'), c.final()]).toString('base64');
  }
  {
    const c = nodeCrypto.createCipheriv('aes-128-cbc', Buffer.from(pass, 'ascii'), Buffer.alloc(16));
    enc['aes-128-cbc-fixed'] = Buffer.concat([c.update(plaintext, 'utf-8'), c.final()]).toString('base64');
  }
  for (const type of Object.keys(enc)) {
    const h = load({
      config: baseConfig({ sites: JSON.stringify([HHAN.id]) }), sites: [HHAN],
      http: () => ({ status: 200, headers: {}, truncated: false, body: JSON.stringify({ encrypted: enc[type], crypto_type: type }) }),
    });
    const t0 = Date.now();
    const st = await h.syncAndWait();
    const ms = Date.now() - t0;
    assert.equal(st.last_error, '', type);
    assert.equal(h.sites[0].cookie, 'uid=big-中文', type);
    assert.ok(ms < 2000, type + ' took ' + ms + 'ms');
  }
});
