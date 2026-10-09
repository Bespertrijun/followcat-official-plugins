// node --test tests/devrt/sandbox.test.js
// devrt/sandbox.js 与生产宿主对齐（G5 / G6 / E1 / C2 / B1）：直接起 sandbox 子进程讲 JSON-RPC。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const SANDBOX = path.join(__dirname, '..', '..', 'devrt', 'sandbox.js');
const FIX = (name) => path.join(__dirname, 'fixtures', name);

function start(fixture, env) {
  const proc = spawn(process.execPath, [SANDBOX, FIX(fixture)], { env: Object.assign({}, process.env, env || {}) });
  const pending = new Map();
  const logs = [];
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  let seq = 0;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.event === 'ready') ready(m);
    else if (m.event === 'log') logs.push(m);
    else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = String(++seq);
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
  });
  const api = async (p, body) => {
    const m = await rpc('callApi', { path: p, req: { method: body === undefined ? 'GET' : 'POST', body: body || '', query: {} } });
    if (m.error) return { error: m.error, timeout: !!m.timeout };
    return m.result.result;
  };
  // 入口脚本在收到第一条消息时才跑（server.py 先发 configReplace）：这里先发一条空的
  rpc('configReplace', { entries: {} });
  return { proc, rpc, api, logs, ready: readyP, stop: () => proc.kill() };
}

test('全局：没有 console / require，eval 与 Function 是 undefined，字符串造代码被禁；data / config.list 在；setAPIKey 已删', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  assert.equal((await s.ready).loadError, null);
  const g = await s.api('/globals');
  assert.equal(g.console, 'undefined');
  assert.equal(g.require, 'undefined');
  assert.equal(g.eval, 'undefined');
  assert.equal(g.Function, 'undefined');
  assert.match(g.ctor.err, /EvalError|Code generation from strings disallowed/);
  assert.equal(g.data, 'object');
  assert.equal(g.configList, 'function');
  assert.equal(g.setAPIKey, 'undefined');
});

test('config.set：非字符串按 goja 规则转字符串（null → ""），键 / 值校验同宿主，config.list 升序', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const c = await s.api('/config');
  assert.equal(c.n, '5');
  assert.equal(c.nul, '');
  assert.equal(c.obj, '[object Object]');
  assert.match(c.badKey.err, /^GoError: invalid config key: must match/);
  assert.match(c.reserved.err, /reserved name/);
  assert.match(c.bigValue.err, /invalid config value: value 66560 bytes exceeds max 65536/);
  assert.deepEqual(c.list, ['n', 'nul', 'obj']);
});

test('config.set：新 key 受每插件条数配额（已有 key 更新不计）', async (t) => {
  const s = start('globals', { DEVRT_CONFIG_MAX_KEYS: '12' });
  t.after(s.stop);
  await s.api('/config'); // 先占 3 个
  const q = await s.api('/quota');
  assert.match(q[0], /plugin config: row quota exceeded: current=12 limit=12/);
  assert.equal(q[1], 'update-ok');
});

test('data.*：内存 blob；get 回字节数组（不是 ArrayBuffer）；类型 / 名字 / 大小校验同宿主', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const d = await s.api('/data');
  assert.equal(d.isArray, true);
  assert.equal(d.isArrayBuffer, false);
  assert.deepEqual(d.bytes, [1, 2, 3]);
  assert.deepEqual(d.a, [8, 7]);
  assert.deepEqual(d.list, ['a.bin', 'b.bin']);
  assert.equal(d.missing, null);
  assert.match(d.putString.err, /TypeError: data.put requires ArrayBuffer or Uint8Array/);
  assert.match(d.putArray.err, /TypeError: data.put requires ArrayBuffer or Uint8Array/);
  assert.match(d.oneArg.err, /TypeError: data.put requires \(name, value\)/);
  assert.match(d.badName.err, /invalid blob name/);
  assert.match(d.tooBig.err, /plugin blob: size exceeds per-blob limit: size=4194305 limit=4194304/);
  assert.equal(d.del, true);
  assert.equal(d.delMissing, true);
  assert.deepEqual(d.listAfter, ['a.bin']);
});

test('crypto.base64Decode 忽略 \\r \\n（同 Go StdEncoding）', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  assert.equal((await s.api('/crypto')).crlf, '65,66,67,68,69,70');
});

test('douban.setCookie：opts 是函数（也是对象）照收，原始值才抛 TypeError', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const r = await s.api('/douban');
  assert.deepEqual(r.fnOpts, { ok: true, validation: '' });
  assert.match(r.numOpts.err, /TypeError: douban.setCookie options must be an object/);
});

test('ptsite.setCookie 参数写反：审计行与 reject 文案都不含 cookie', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const r = await s.api('/swapped');
  assert.match(r, /pt credential: site not found/);
  assert.ok(!r.includes('SECRETCOOKIE'));
  const audit = s.logs.map((l) => l.args.join(' ')).filter((x) => x.includes('AUDIT'));
  assert.deepEqual(audit, ['[audit] AUDIT action=ptsite.setCookie target=<invalid len=24>']);
});

test('log.*：\\r \\n 转义成字面，一次 log 只有一行', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  await s.api('/log');
  const line = s.logs.map((l) => l.args.join(' ')).find((x) => x.startsWith('line1'));
  assert.equal(line, 'line1\\nAUDIT action=fake target=x\\rtail');
});

test('registerAPI 返回带环对象：普通错误，devrt 不崩', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const r = await s.api('/cyclic');
  assert.match(r.error, /^plugin return value is not JSON-serializable: TypeError: Converting circular structure to JSON/);
  assert.equal((await s.api('/globals')).data, 'object');
});

test('should_download trigger 回显宿主裁决与 fail_open', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  const trig = async (mode) => (await s.rpc('trigger', { hook: 'should_download', data: { mode } })).result;
  assert.deepEqual(await trig('veto'), { ok: true, result: false, verdict: 'veto', fail_open: false });
  assert.deepEqual(await trig('bitmap'), { ok: true, result: { have_bitmap: 'AAE=' }, verdict: 'have_bitmap', fail_open: false });
  assert.deepEqual(await trig('allow'), { ok: true, result: true, verdict: 'allow', fail_open: false });
  const thrown = await trig('throw');
  assert.equal(thrown.verdict, 'allow');
  assert.equal(thrown.fail_open, true);
  assert.match(thrown.error, /boom/);
});

test('manifest 权限按宿主白名单校验：未知权限 → loadError，入口脚本不跑', async (t) => {
  const s = start('badperm');
  t.after(s.stop);
  const r = await s.ready;
  assert.match(r.loadError, /manifest.permissions contains unknown entries \[hook.download api.nope\]/);
  assert.deepEqual(r.apis, []);
});

test('超时错误文案没有 "Error: " 前缀，且标 timeout（server.py 据此回 504）', { timeout: 20000 }, async (t) => {
  const s = start('spin');
  t.after(s.stop);
  const r = await s.api('/syncspin');
  assert.deepEqual(r, { error: 'plugin runtime: execution timeout', timeout: true });
  assert.equal(await s.api('/ping'), 'pong');
});

test('await 之后的死循环不卡死 devrt：本次按超时 fail-open，之后照常响应', { timeout: 30000 }, async (t) => {
  const s = start('spin', { DEVRT_CONTINUATION_GUARD_MS: '300' });
  t.after(s.stop);
  for (const mode of ['await-null-spin', 'await-http-spin']) {
    const r = (await s.rpc('trigger', { hook: 'should_download', data: { mode } })).result;
    assert.equal(r.fail_open, true, mode);
    assert.equal(r.error, 'plugin runtime: execution timeout', mode);
    assert.equal(await s.api('/ping'), 'pong', 'devrt still responsive after ' + mode);
  }
});

test('定时器回调死循环被打断（devrt 专有保护），其它定时器照跑', { timeout: 20000 }, async (t) => {
  const s = start('spin', { DEVRT_CONTINUATION_GUARD_MS: '300' });
  t.after(s.stop);
  await s.api('/timer-spin');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await s.api('/ticks'), 1);
  assert.ok(s.logs.some((l) => /setTimeout callback ran longer than 300ms and was interrupted/.test(l.args.join(' '))));
});

test('configPatch 只改下发的键：插件同时写的其它键不被冲掉；delete 显式删除', async (t) => {
  const s = start('cfgrace');
  t.after(s.stop);
  await s.api('/set', 'from-plugin');
  await s.rpc('configPatch', { set: { ui_key: 'from-ui' }, delete: [] });
  assert.deepEqual(await s.api('/get'), { plugin_key: 'from-plugin', ui_key: 'from-ui' });
  await s.rpc('configPatch', { set: {}, delete: ['ui_key'] });
  assert.deepEqual(await s.api('/get'), { plugin_key: 'from-plugin', ui_key: null });
});

test('入口脚本在初始 configReplace 之后才跑：顶层 config.get 读得到已存配置（同生产）', async (t) => {
  const proc = spawn(process.execPath, [SANDBOX, FIX('cfgrace')]);
  t.after(() => proc.kill());
  const lines = [];
  const done = new Promise((resolve) => {
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = JSON.parse(line);
      lines.push(m);
      if (m.id === '2') resolve();
    });
  });
  proc.stdin.write(JSON.stringify({ id: '1', method: 'configReplace', params: { entries: { ui_key: 'saved' } } }) + '\n');
  proc.stdin.write(JSON.stringify({ id: '2', method: 'callApi', params: { path: '/boot', req: { method: 'GET', body: '', query: {} } } }) + '\n');
  await done;
  assert.equal(lines.find((m) => m.id === '2').result.result, 'saved');
});

// ─── 第二轮对齐（R1 / R3 / R4、data.put、should_download 裁决、log 格式） ─────────────────────

const fs = require('fs');
const vm = require('vm');

// fixtures/round2/index.js 的 jsonCases 用 Node 原生 JSON 跑一遍，得期望值
function nativeJsonCases() {
  const apis = {};
  const ctx = { plugin: { registerAPI: (p, f) => { apis[p] = f; }, on: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FIX('round2'), 'index.js'), 'utf-8'), ctx);
  return JSON.parse(JSON.stringify(apis['/json-cases']()));
}

test('R1：插件看到的 JSON.parse / JSON.stringify 对正常输入与原生逐字节一致（replacer 函数 / 属性表、space、toJSON、reviver）', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const got = await s.api('/json-cases');
  const want = nativeJsonCases();
  assert.equal(got.length, want.length);
  for (let i = 0; i < want.length; i++) assert.equal(got[i], want[i], 'case ' + i);
});

test('R1：超过 1000 层 / 100 万个值 → 抛普通 TypeError（文案同宿主），不崩；1000 层以内照常', { timeout: 60000 }, async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const r = await s.api('/json-limits');
  assert.deepEqual(r.parse1000, { v: 1 });
  assert.deepEqual(r.parse1001, { err: 'TypeError: JSON.parse: input nested deeper than 1000 levels', name: 'TypeError' });
  assert.equal(r.parseMixed1001.name, 'TypeError');
  assert.deepEqual(r.parseInString, { v: 10000 }, 'brackets inside a string literal do not count');
  assert.equal(r.parseHuge.err, 'TypeError: JSON.parse: input nested deeper than 1000 levels');
  assert.equal(typeof r.stringify1000.v, 'number');
  assert.deepEqual(r.stringify1001, { err: 'TypeError: JSON.stringify: value nested deeper than 1000 levels (circular reference?)', name: 'TypeError' });
  assert.deepEqual(r.stringifyDag, { err: 'TypeError: JSON.stringify: more than 1000000 values', name: 'TypeError' });
  assert.equal(r.stringifyCycle.name, 'TypeError');
  assert.deepEqual(r.stringifyAtLimit, { v: true });
  assert.deepEqual(r.stringifyOverLimit, { err: 'TypeError: JSON.stringify: more than 1000000 values', name: 'TypeError' });
  assert.equal(await s.api('/json-cases').then((x) => Array.isArray(x)), true, 'still responsive');
});

test('R1：registerAPI 返回值的导出同样限 1000 层（错误文案同宿主 exportJSON）', async (t) => {
  const s = start('globals');
  t.after(s.stop);
  // 用 /cyclic 验证过带环；这里再验一次文案前缀不带 "Error: "
  const r = await s.api('/cyclic');
  assert.ok(!r.error.startsWith('Error: '), r.error);
});

test('R3：hook payload、registerAPI 的 req、facade 结构化返回都是插件自己的普通对象（可增删字段，"use strict" 下不抛）', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const plain = { proto: true, instanceofObject: true, added: true, deleted: true };
  await s.rpc('trigger', { hook: 'on_download_done', data: { anime_id: 1, anime_title: 'T', episode: 1 } });
  assert.deepEqual(await s.api('/payload'), plain);
  assert.deepEqual(await s.api('/req'), plain);
  const f = await s.api('/facades');
  for (const k of ['ptList', 'ptItem', 'ptGet', 'registry', 'meta', 'douban', 'task', 'tasks', 'anime', 'http', 'headers']) {
    assert.deepEqual(f[k], plain, k);
  }
  assert.equal(f.flows.proto, true);
  assert.equal(f.flows.instanceofObject, true);
  assert.equal(f.fresh, true, 'each call returns a fresh copy');
});

test('R4：config.delete 同步返回是否删到；非法键抛错（同 config.set）；删掉的键从 config.list 消失', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const r = await s.api('/cfgdel');
  assert.equal(r.first, true);
  assert.equal(r.again, false);
  assert.equal(r.after, null);
  assert.match(r.badKey.err, /^GoError: invalid config key: must match/);
  assert.match(r.undef.err, /^GoError: invalid config key/, 'undefined → "" like goja → invalid');
  assert.deepEqual(r.list, ['k2']);
  const all = (await s.rpc('configGetAll')).result.entries;
  assert.deepEqual(all, { k2: 'v2' });
});

test('data.put：data.get 回的字节数组能写回；数组字面量 / 其它 TypedArray 按宿主报 Go 类型；名字按 String(v)', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const d = await s.api('/dataput');
  assert.deepEqual(d.roundtrip, { v: [9, 2, 200] });
  assert.equal(d.literal.err, 'TypeError: data.put requires ArrayBuffer or Uint8Array, got []interface {}');
  assert.equal(d.int16.err, 'TypeError: data.put requires ArrayBuffer or Uint8Array, got []int16');
  assert.equal(d.obj.err, 'TypeError: data.put requires ArrayBuffer or Uint8Array, got map[string]interface {}');
  assert.equal(d.nul.err, 'TypeError: data.put requires ArrayBuffer or Uint8Array, got <nil>');
  assert.deepEqual(d.undefName, { v: [7] });
  assert.deepEqual(d.numName, { v: [8] });
  assert.deepEqual(d.list, ['42', 'a', 'b', 'undefined']);
});

test('log.*：参数按宿主 fmt.Sprint 格式化（map[...] / [...] / <nil> / Go 浮点写法），一行', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  await s.api('/logfmt');
  const line = s.logs.map((l) => l.args.join(' ')).find((x) => x.startsWith('LOGFMT'));
  // 与主仓 goja + fmt.Sprint 实测（2026-09-26）逐项一致
  assert.equal(line, 'LOGFMT map[a:map[c:[1 2]] b:2] [1 a <nil> true] <nil> <nil> 5 0.30000000000000004 1.234567895e+08 1e+21 1e-07 ' +
    'NaN +Inf -Inf -0 map[] [1 2] q true [] map[] [[1 2]] s p');
});

test('should_download：按导出后的值裁决（toJSON / 包装对象 / 导不出 / have_bitmap 校验同宿主）', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const trig = async (mode) => (await s.rpc('trigger', { hook: 'should_download', data: { mode, media: {} } })).result;
  assert.deepEqual(await trig('toJSON-false'), { ok: true, result: false, verdict: 'veto', fail_open: false });
  assert.deepEqual(await trig('boxed-false'), { ok: true, result: false, verdict: 'veto', fail_open: false });
  const cyc = await trig('cyclic');
  assert.equal(cyc.verdict, 'allow');
  assert.equal(cyc.fail_open, true);
  assert.match(cyc.error, /^plugin return value is not JSON-serializable: TypeError: Converting circular structure to JSON/);
  assert.equal((await trig('bitmap-empty')).verdict, 'allow');
  assert.equal((await trig('bitmap-bad')).verdict, 'allow');
  assert.equal((await trig('bitmap-zero-bytes')).verdict, 'allow');
  assert.equal((await trig('bitmap-array')).verdict, 'allow');
  assert.deepEqual(await trig('bitmap-toJSON'), { ok: true, result: { have_bitmap: 'AAE=' }, verdict: 'have_bitmap', fail_open: false });
  assert.equal((await trig('false-string')).verdict, 'allow');
  assert.equal((await trig('mutate')).verdict, 'allow', 'payload is the plugin\'s own copy: edits do not throw');
});

test('registerAPI 返回值导出上限同宿主：1000 层可以、1001 层报错；BigInt 报错（文案同 exportJSON）', async (t) => {
  const s = start('round2');
  t.after(s.stop);
  const ok = await s.api('/export-1000');
  assert.ok(Array.isArray(ok));
  assert.deepEqual(await s.api('/export-1001'), { error: 'plugin return value is not JSON-serializable: nested deeper than 1000 levels (circular reference?)', timeout: false });
  const b = await s.api('/export-bigint');
  assert.match(b.error, /^plugin return value is not JSON-serializable: TypeError: Do not know how to serialize a BigInt/);
});

// ─── notify.send（api.notify.send）：与宿主 internal/plugin/host_api_notify.go + internal/notify/plugin.go 对齐 ──────

// fixtures/notify/vectors.json：每条消息的 want 是主仓宿主 notify.Service.EnqueuePlugin 实跑的结果（"" = 接受），
// 字符串里的 {"$repeat": [s, n]} / {"$cat": [...]} 是展开宏（省篇幅）
function expandVector(x) {
  if (Array.isArray(x)) return x.map(expandVector);
  if (x && typeof x === 'object') {
    if (Object.prototype.hasOwnProperty.call(x, '$repeat')) return expandVector(x.$repeat[0]).repeat(x.$repeat[1]);
    if (Object.prototype.hasOwnProperty.call(x, '$cat')) return x.$cat.map(expandVector).join('');
    const o = {};
    for (const k of Object.keys(x)) o[k] = expandVector(x[k]);
    return o;
  }
  return x;
}

test('notify：没声明 api.notify.send 时 notify 是 undefined；声明了才挂 notify.send', async (t) => {
  const s = start('notify-noperm');
  t.after(s.stop);
  assert.equal(await s.api('/typeof'), 'undefined');
  const n = start('notify');
  t.after(n.stop);
  assert.equal((await n.ready).loadError, null, 'api.notify.send is in the host permission list');
});

test('notify.send：参数不是对象、字段类型不对 → 同步抛 TypeError；文本字段只收原始字符串，按钮结构直接读（jscases.json 由宿主实跑生成）', async (t) => {
  const s = start('notify', { DEVRT_NOTIFY_CHANNELS: '0' });
  t.after(s.stop);
  const want = JSON.parse(fs.readFileSync(path.join(FIX('notify'), 'jscases.json'), 'utf-8'));
  const got = await s.api('/jscases');
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'fixture jsCases and jscases.json list the same cases');
  for (const k of Object.keys(want)) assert.equal(got[k], want[k], k);
  // the CF6 cases this file must keep locking (a String object / toJSON object used to be accepted)
  assert.equal(want['title String object'], 'TypeError: notify.send: title must be a string');
  assert.equal(want['title toJSON object'], 'TypeError: notify.send: title must be a string');
  assert.equal(want['data cyclic'], 'TypeError: notify.send: button data is not JSON-serializable');
  assert.equal(want['buttons array toJSON ignored'], 'rejected: 按钮链接无效：只允许 http / https，且不能带用户名和密码');
});

test('notify.send：内容规则的 reject 原因与先后顺序同宿主（vectors.json 由宿主实跑生成）', async (t) => {
  const s = start('notify', { DEVRT_NOTIFY_CHANNELS: '0' });
  t.after(s.stop);
  const vectors = JSON.parse(fs.readFileSync(path.join(FIX('notify'), 'vectors.json'), 'utf-8'));
  const got = await s.api('/vectors', JSON.stringify(vectors.map((v) => expandVector(v.msg))));
  assert.equal(got.length, vectors.length);
  for (let i = 0; i < vectors.length; i++) assert.equal(got[i], vectors[i].want, vectors[i].name);
});

test('notify.send：入队 resolve {queued, channels}（DEVRT_NOTIFY_CHANNELS，默认 1）；reject 是 Error，message 即原因；日志面板打出消息', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const msg = { title: '同步完成', body: '更新了 **3** 个站点', image: 'https://img.example/p.png',
    buttons: [{ label: 'a', url: 'https://a.example/' }, { label: 'b', url: 'https://b.example/' }, { label: 'c', url: 'https://c.example/' }] };
  assert.deepEqual(await s.api('/send', JSON.stringify(msg)), { resolved: { queued: true, channels: 1 } });
  const line = s.logs.map((l) => l.args.join(' ')).find((x) => x.startsWith('[notify.send] '));
  const shown = JSON.parse(line.slice('[notify.send] '.length));
  assert.equal(shown.prefix, '🧩 [devrt-notify]');
  assert.equal(shown.channels, 1);
  assert.equal(shown.title, '同步完成');
  assert.deepEqual(shown.buttons.map((row) => row.map((b) => b.label)), [['a', 'b'], ['c']], 'flat buttons are laid out 2 per row');
  assert.deepEqual(await s.api('/send', JSON.stringify({ title: 't', buttons: [{ label: '重试', action: 'retry', data: { id: 7 } }, { label: 'b', url: 'https://b.example/' }] })),
    { resolved: { queued: true, channels: 1 } }, 'an action declared in manifest.actions is accepted');
  const line2 = s.logs.map((l) => l.args.join(' ')).filter((x) => x.startsWith('[notify.send] ')).pop();
  assert.deepEqual(JSON.parse(line2.slice('[notify.send] '.length)).buttons,
    [[{ label: '重试', action: 'retry', data: { id: 7 } }, { label: 'b', url: 'https://b.example/' }]]);
  assert.deepEqual(await s.api('/send', JSON.stringify({ title: '', buttons: [{ label: 'a', action: 'nope' }] })),
    { rejected: '按钮动作未在 manifest 中声明', name: 'GoError', isError: true }, 'undeclared action: the facade rejects before the title check');
  assert.deepEqual(await s.api('/send', JSON.stringify({ title: ' ' })), { rejected: '缺少标题', name: 'GoError', isError: true });

  const zero = start('notify', { DEVRT_NOTIFY_CHANNELS: '0' });
  t.after(zero.stop);
  assert.deepEqual(await zero.api('/send', JSON.stringify({ title: 't' })), { resolved: { queued: true, channels: 0 } });
  const three = start('notify', { DEVRT_NOTIFY_CHANNELS: '3' });
  t.after(three.stop);
  assert.deepEqual(await three.api('/send', JSON.stringify({ title: 't' })), { resolved: { queued: true, channels: 3 } });
});

test('notify.send：每小时配额（DEVRT_NOTIFY_MAX_PER_HOUR，默认 300）；channels 为 0 与被拒的不计', async (t) => {
  const s = start('notify', { DEVRT_NOTIFY_MAX_PER_HOUR: '2' });
  t.after(s.stop);
  const send = (m) => s.api('/send', JSON.stringify(m));
  assert.equal((await send({ title: '' })).rejected, '缺少标题');
  assert.ok((await send({ title: '1' })).resolved);
  assert.ok((await send({ title: '2' })).resolved);
  assert.deepEqual(await send({ title: '3' }), { rejected: '超出通知配额（每小时 2 条）', name: 'GoError', isError: true });
  assert.equal((await send({ title: '' })).rejected, '缺少标题', 'content rules are checked before the quota');

  const zero = start('notify', { DEVRT_NOTIFY_MAX_PER_HOUR: '1', DEVRT_NOTIFY_CHANNELS: '0' });
  t.after(zero.stop);
  for (let i = 0; i < 3; i++) assert.ok((await zero.api('/send', JSON.stringify({ title: 't' }))).resolved, 'channels 0 is not counted');
});

test('notify.send：Promise 在调用返回时已 settle（同宿主在 facade 内同步 settle），连续调用保持顺序', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  assert.deepEqual(await s.api('/sync-settle'), ['0:ok', '1:rej', '2:ok']);
});

test('notify.send：在 should_download 里调用（await 或不 await、resolve 或 reject）不影响裁决', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const trig = async (mode) => (await s.rpc('trigger', { hook: 'should_download', data: { mode } })).result;
  assert.equal((await trig('await-reject-veto')).verdict, 'veto');
  assert.equal((await trig('unawaited-reject-veto')).verdict, 'veto');
  assert.equal((await trig('await-ok-allow')).verdict, 'allow');
});

// ─── manifest.actions / manifest.commands：与宿主 internal/plugin/manifest.go Parse 对齐 ─────────────────────

// fixtures/manifest-vectors.json：want 是主仓 plugin.Parse(manifest, auth.IsValidPermission) 实跑的错误文案（"" = 通过）
test('manifest：actions / commands 的校验与报错文案同宿主（manifest-vectors.json 由宿主实跑生成）', { timeout: 120000 }, async (t) => {
  const os = require('os');
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'manifest-vectors.json'), 'utf-8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devrt-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  const startDir = () => {
    const proc = spawn(process.execPath, [SANDBOX, dir]);
    return new Promise((resolve) => {
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        const m = JSON.parse(line);
        if (m.event === 'ready') { proc.kill(); resolve(m.loadError); }
      });
      proc.stdin.write(JSON.stringify({ id: '1', method: 'configReplace', params: { entries: {} } }) + '\n');
    });
  };
  for (const c of cases) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(c.manifest));
    assert.equal((await startDir()) || '', c.want, c.name);
  }
});

// ─── on_notify_action / on_bot_command：控制台模拟点击与命令（宿主 internal/notify/actions.go + commands.go 的插件侧契约）──

const ADMIN = { username: 'admin', role: 'admin', permissions: ['settings:write', 'logs:read'] };
const MEMBER = { username: 'bob', role: 'member', permissions: ['subscribe:any'] };

test('hook 表：on_notify_action / on_bot_command 需 api.notify.send（不声明权限 → plugin.on 抛错）', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const r = await s.ready;
  assert.equal(r.loadError, null);
  assert.deepEqual(r.hooks.sort(), ['on_bot_command', 'on_notify_action', 'should_download']);  const n = start('notify-hook-noperm');
  t.after(n.stop);
  assert.equal((await n.ready).loadError, null, 'declaring the hooks alone is a valid manifest');
  const errs = await n.api('/errors');
  for (const h of ['on_notify_action', 'on_bot_command']) assert.match(errs[h], new RegExp('hook "' + h + '" requires permission "api.notify.send"'), h);
});

test('on_notify_action：返回字符串 / {text} → 「✓ <文字>」（换行折成空格、去首尾空白、最多 200 字）；其余 → 「✓ 已处理」', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const click = async (data, user, action) => (await s.rpc('trigger', { hook: 'on_notify_action',
    data: { action: action || 'retry', data, user: user || ADMIN, channel: 'telegram' } })).result;
  const ok = await click({ id: 7 });
  assert.equal(ok.answer, '处理中…');
  assert.equal(ok.line, '✓ 已retry：{"id":7} by admin/admin via telegram');
  assert.equal((await click({ mode: 'obj' })).line, '✓ 第一行 第二行');
  const long = (await click({ mode: 'long' })).line;
  assert.equal(long, '✓ ' + '长'.repeat(199) + '…');
  assert.equal((await click({ mode: 'none' })).line, '✓ 已处理');
  assert.equal((await click({ mode: 'number' })).line, '✓ 已处理');
  assert.equal((await click({ mode: 'throw' })).line, '✗ 失败：插件出错');
  const sent = await click({ mode: 'send' });
  assert.equal(sent.line, '✓ sent', 'notify.send works inside the action hook');
  // ack requires logs:read; retry has no requires → admin only
  const denied = await click(null, MEMBER);
  assert.deepEqual([denied.answer, denied.line, denied.called], ['没有权限', null, false]);
  assert.equal((await click(null, MEMBER, 'ack')).answer, '没有权限');
  assert.equal((await click(null, { username: 'x', role: 'member', permissions: ['logs:read'] }, 'ack')).line.startsWith('✓ '), true);
  const gone = await click(null, ADMIN, 'nope');
  assert.deepEqual([gone.line, gone.called], ['✗ 失败：插件不可用', false]);
});

test('on_notify_action：10 秒没结果 → 「✗ 失败：插件没有响应」', { timeout: 20000 }, async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const r = (await s.rpc('trigger', { hook: 'on_notify_action', data: { action: 'retry', data: { mode: 'hang' }, user: ADMIN, channel: 'telegram' } })).result;
  assert.equal(r.line, '✗ 失败：插件没有响应');
});

test('on_bot_command：字符串按纯文字回、{body, buttons} 按 notify.send 规则校验、不合规 → 插件出错；只认私聊；权限与未声明同宿主', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const cmd = async (args, opts) => (await s.rpc('trigger', { hook: 'on_bot_command', data: Object.assign({ command: 'status', args,
    user: ADMIN, chat: { id: 42, type: 'private' } }, opts || {}) })).result;
  const plain = await cmd('hi');
  assert.equal(plain.reply.prefix, '🧩 [devrt-notify]');
  assert.equal(plain.reply.text, '收到 /status hi（admin，chat 42 private）**不解析**');
  assert.equal(plain.reply.body, '收到 /status hi（admin，chat 42 private）\\*\\*不解析\\*\\*', 'a string reply is escaped: shown literally');
  const md = await cmd('md');
  assert.equal(md.reply.body, '**加粗** [链接](https://a.example/)');
  assert.deepEqual(md.reply.buttons, [[{ label: '重试', action: 'retry', data: { n: 1 } }, { label: '打开', url: 'https://a.example/' }]]);
  for (const bad of ['undeclared', 'badlink', 'bodytype', 'number', 'throw']) assert.equal((await cmd(bad)).reply, '插件出错', bad);
  assert.match((await cmd('undeclared')).error, /按钮动作未在 manifest 中声明/);
  assert.equal((await cmd('empty')).reply, '已处理');
  assert.equal((await cmd('emptyobj')).reply, '已处理');
  assert.equal((await cmd('hi', { chat: { id: -100, type: 'group' } })).ignored, true);
  assert.equal((await cmd('hi', { command: 'nope' })).reply, '不认识这个命令，发 /help 看看能用什么');
  assert.equal((await cmd('hi', { user: MEMBER })).reply, '没有权限', 'status has no requires → admin only');
  assert.equal((await cmd('hi', { command: 'echo', user: MEMBER })).reply.prefix, '🧩 [devrt-notify]', 'echo requires subscribe:any');
});

// fixtures/notify/reply-vectors.json：want 是主仓宿主 notify.Service.pluginCommandReply 实跑的结果——「已处理」（没有内容）、
// 「插件出错」（返回值不合规）或 ok（发回复）
test('on_bot_command：返回值 → 已处理 / 插件出错 / 发回复，同宿主（reply-vectors.json 由宿主实跑生成；body 空且一个按钮都没有——含 [[]]——是已处理）', async (t) => {
  const s = start('notify');
  t.after(s.stop);
  const cases = JSON.parse(fs.readFileSync(path.join(FIX('notify'), 'reply-vectors.json'), 'utf-8'));
  assert.ok(cases.some((c) => c.name === 'one empty row' && c.want === '已处理'), 'the [[]] case stays locked');
  for (const c of cases) {
    const r = (await s.rpc('trigger', { hook: 'on_bot_command', data: { command: 'status', args: 'json ' + JSON.stringify(c.reply),
      user: ADMIN, chat: { id: 42, type: 'private' } } })).result;
    assert.equal(r.called, true, c.name);
    const got = typeof r.reply === 'string' ? r.reply : (r.reply && r.reply.prefix === '🧩 [devrt-notify]' ? 'ok' : JSON.stringify(r.reply));
    assert.equal(got, c.want, c.name);
  }
});
