// node --test tests/media-library-filter/media-library-filter.test.js
// media-library-filter：await 迁移（http.* 返回 Promise）、宿主 3s 超时之后才回来的结果（late）、
// hdr / dv 的宿主真实形态（字符串）。收编自 2026-09-25 审核复现 /tmp/fcp-rv/rv-repro/。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, embyLib, flowCfg, payload, resp } = require('./harness');

const SDR = { height: 1080, codec: 'hevc', range: 'SDR' };
const HDR10 = { height: 1080, codec: 'hevc', range: 'HDR10' };
const DOVI = { height: 1080, codec: 'hevc', range: 'DOVI' };

function outcomeCounters(c) {
  return Object.keys(c).filter((k) => /^(vetoed|allowed_|dry_run_would_veto|batch_partial_filtered)/.test(k) && c[k] > 0);
}

// ─── await 迁移 ───────────────────────────────────────────────────────────────

test('should_download 回调是 async：http 返回 Promise，同规格副本 → resolve false，vetoed 计数', async () => {
  const p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: embyLib([SDR]) });
  const r = p.hooks.should_download(payload());
  assert.equal(typeof r.then, 'function', 'handler must return a Promise');
  assert.equal(await r, false);
  assert.equal(p.counters().vetoed, 1);
  assert.equal(p.counters().late, 0);
  assert.ok(p.logs.some((l) => /should_download flow=f1 .*decision=veto/.test(l[1])));
});

test('库里没有这一集 → 放行（allowed_not_in_lib）；http 故障（reject）→ fail-open 放行、不写缓存', async () => {
  const miss = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: embyLib({ 9: [SDR] }) });
  assert.equal(await miss.hooks.should_download(payload()), true);
  assert.equal(miss.counters().allowed_not_in_lib, 1);
  assert.equal(miss.cacheKeys().length, 1, 'a clean miss is cached');

  // 8（operator）：请求失败不是「库里没有」——计 allowed_error、不计 allowed_not_in_lib、不写缓存
  const down = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: () => { throw new Error('http GET x: connection refused'); } });
  assert.equal(await down.hooks.should_download(payload()), true);
  assert.equal(down.counters().allowed_error, 1);
  assert.equal(down.counters().allowed_not_in_lib, 0);
  assert.equal(down.counters().vetoed, 0);
  assert.deepEqual(down.cacheKeys(), []);
  assert.match(down.cfg.emby_last_error, /connection refused/);
  assert.ok(down.logs.some((l) => /reason=lib_error/.test(l[1])), 'decision log names the failure');
});

test('合集：部分集在库 → resolve { have_bitmap }（await 之后照样拿到结构化返回）', async () => {
  const p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: embyLib({ 9: [SDR] }) });
  const r = await p.hooks.should_download(payload({ media: { episode: 9, episode_end: 10 } }));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { have_bitmap: 'AAE=' });
  assert.equal(p.counters().batch_partial_filtered, 1);
});

// ─── 超时之后才回来的结果（G4） ────────────────────────────────────────────────

function slowLib(p, lib, delayMs) {
  return (url) => {
    if (url.indexOf('Episode') >= 0) p.advance(delayMs); // 这枪在途期间墙钟走过 delayMs
    return lib(url);
  };
}

test('单集：结果在宿主 3s 超时之后才回来 → 放行、计 late、打一条不带裁决的 warn、不记决策日志、不动其它计数、缓存照写', async () => {
  let p;
  p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: (url) => slowLib(p, embyLib([SDR]), 3100)(url) });
  assert.equal(await p.hooks.should_download(payload()), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.deepEqual(outcomeCounters(c), []);
  assert.equal(c.should_download_seen, 1);
  assert.ok(!p.logs.some((l) => /should_download flow=/.test(l[1])), 'no decision log line');
  const warns = p.logs.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /after the host's 3000ms timeout/);
  assert.match(warns[0][1], /flow=f1 tmdb=1429 s1e8/);
  assert.ok(!/decision|veto|allow=/.test(warns[0][1].replace('host already allowed the download', '')), 'warn must not carry a verdict: ' + warns[0][1]);
  assert.deepEqual(p.cacheKeys().length, 1, 'late result still fills the cache');
});

test('合集：批量拉取在 3s 之后才回来 → 放行、计 late、warn 带集号区间', async () => {
  let p;
  p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: (url) => slowLib(p, embyLib({ 9: [SDR], 10: [SDR] }), 3500)(url) });
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9, episode_end: 10 } })), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.equal(c.vetoed, 0);
  const warns = p.logs.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /s1e9-10/);
});

test('按时回来（2.9s）不算 late', async () => {
  let p;
  p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: (url) => slowLib(p, embyLib([SDR]), 2900)(url) });
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.counters().late, 0);
  assert.equal(p.counters().vetoed, 1);
});

test('软预算只在两次请求之间检查：第一枪（series 查询）就拖过 2500ms → 第二枪不发，放行、不写缓存', async () => {
  let p;
  const lib = embyLib([SDR]);
  p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: (url) => { if (url.indexOf('Series') >= 0) p.advance(2600); return lib(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.httpCalls.length, 1, 'episode query must not be sent after the soft budget');
  assert.equal(p.counters().vetoed, 0);
  assert.equal(p.counters().late, 0);
  // 8：超了软预算没查完 = allowed_error，不是 allowed_not_in_lib
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.deepEqual(p.cacheKeys(), []);
});

test('软预算挡不住在途请求：已发出的那一枪自己拖过 3s → 宿主已放行，结果按 late 处理', async () => {
  let p;
  const lib = embyLib([SDR]);
  p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: (url) => { if (url.indexOf('Episode') >= 0) p.advance(9000); return lib(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.httpCalls.length, 2);
  assert.equal(p.counters().late, 1);
});

test('G4：合集批量拉取失败、但失败时已过宿主 3s → 按 late 处理（不计 allowed_error）', async () => {
  let p;
  p = load({ config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) { p.advance(3500); throw new Error('http GET x: context deadline exceeded'); } return embyLib({ 9: [SDR] })(url); } });
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9, episode_end: 10 } })), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.equal(c.allowed_error, 0);
  assert.deepEqual(outcomeCounters(c), []);
  assert.equal(p.logs.filter((l) => l[0] === 'warn').length, 1);
  assert.ok(!p.logs.some((l) => /should_download \[batch\]/.test(l[1])), 'no decision log line');
});

test('G4：单集查库过程抛异常、且已过宿主 3s → 按 late 处理（不计 allowed_error、不打 error）', async () => {
  let p, armed = false;
  p = load({ config: flowCfg({ resolution: { op: '==' } }),
    onConfigGet: (k) => { if (armed && k === 'plex_enabled') { armed = false; throw new Error('store gone'); } },
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) { p.advance(3500); armed = true; } return embyLib({ 9: [SDR] })(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.equal(c.allowed_error, 0);
  assert.ok(!p.logs.some((l) => l[0] === 'error'), 'no error log for a late result');
});

test('G4：同样的异常在 3s 之内 → allowed_error + error 日志（与 late 区分开）', async () => {
  let p, armed = false;
  p = load({ config: flowCfg({ resolution: { op: '==' } }),
    onConfigGet: (k) => { if (armed && k === 'plex_enabled') { armed = false; throw new Error('store gone'); } },
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) armed = true; return embyLib({ 9: [SDR] })(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().late, 0);
  assert.ok(p.logs.some((l) => l[0] === 'error' && /lib check exception: Error: store gone/.test(l[1])));
});

test('G4：判定阶段（查完库之后）抛异常且已过 3s → handler 兜底也按 late 处理，warn 带 error=', async () => {
  let p, armed = false;
  p = load({ config: flowCfg({ resolution: { op: '==' } }),
    onConfigGet: (k) => { if (armed && k === 'allowed_no_match') { armed = false; throw new Error('boom-late'); } },
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) { p.advance(2000); armed = true; } return embyLib([HDR10])(url); } });
  // 查库 2s 回来、没过 3s；判定阶段读计数器时再「卡」1.5s 后抛错
  const origGet = p.ctx.config.get;
  p.ctx.config.get = (k) => { if (armed && k === 'allowed_no_match') p.advance(1500); return origGet(k); };
  assert.equal(await p.hooks.should_download(payload({ tags: { resolution: '2160p' } })), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.equal(c.allowed_error, 0);
  const warns = p.logs.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /error=Error: boom-late/);
  assert.ok(!p.logs.some((l) => l[0] === 'error'));
});

// ─── hdr / dv：宿主真实形态（G1） ──────────────────────────────────────────────

test('SDR 库遇 HDR 种子（tags.hdr="HDR"）→ 放行（库里没有 HDR 版）', async () => {
  const p = load({ config: flowCfg({ resolution: { op: '==' }, hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: 'HDR' } })), true);
  assert.equal(p.counters().allowed_no_match, 1);
});

test('HDR 库遇 HDR 种子 → 否决（同规格已在库）', async () => {
  const p = load({ config: flowCfg({ resolution: { op: '==' }, hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: 'HDR' } })), false);
});

test('种子字典值（HDR10 / HDR10+ / hdr，大小写不敏感）都算「是」', async () => {
  for (const v of ['HDR10', 'HDR10+', 'hdr', ' Hdr ']) {
    const p = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
    assert.equal(await p.hooks.should_download(payload({ tags: { hdr: v } })), false, v);
  }
});

test('"无" / none / no / false / 0 都算「否」：SDR 库遇非 HDR 种子 → 否决；HDR 库遇非 HDR 种子 → 放行', async () => {
  for (const v of ['无', 'none', 'NO', 'false', '0', false]) {
    const sdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
    assert.equal(await sdr.hooks.should_download(payload({ tags: { hdr: v } })), false, 'sdr lib, hdr=' + JSON.stringify(v));
    const hdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
    assert.equal(await hdr.hooks.should_download(payload({ tags: { hdr: v } })), true, 'hdr lib, hdr=' + JSON.stringify(v));
  }
});

test('"无" 是有值的「否」：不触发 tag_empty 短路（会去查库）', async () => {
  const p = load({ config: flowCfg({ hdr: { op: '==' }, dv: { op: '==' } }), httpGet: embyLib([SDR]) });
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.counters().allowed_tag_empty, 0);
  assert.ok(p.httpCalls.length > 0);
});

test('hdr 为空串（宿主没算出 tags）→ tag_empty 短路放行，不查库', async () => {
  const p = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: '' } })), true);
  assert.equal(p.counters().allowed_tag_empty, 1);
  assert.equal(p.httpCalls.length, 0);
});

test('dv：DolbyVision 种子遇杜比视界库副本 → 否决；遇 HDR10（非 DV）副本 → 放行', async () => {
  const dovi = load({ config: flowCfg({ dv: { op: '==' } }), httpGet: embyLib([DOVI]) });
  assert.equal(await dovi.hooks.should_download(payload({ tags: { dv: 'DolbyVision' } })), false);
  const hdr = load({ config: flowCfg({ dv: { op: '==' } }), httpGet: embyLib([HDR10]) });
  assert.equal(await hdr.hooks.should_download(payload({ tags: { dv: 'DolbyVision' } })), true);
});

test('/check POST mock：hdr 字符串与布尔两种写法结论一致', async () => {
  const p = load({ config: flowCfg({}) });
  const run = async (hdrTag, libHdr) => JSON.parse(JSON.stringify(await p.apis['/check']({ method: 'POST', query: {},
    body: JSON.stringify({ mock_copies: [{ height: 1080, hdr: libHdr }], tags: { hdr: hdrTag }, dims: { hdr: { op: '==' } } }) })));
  assert.equal((await run('HDR', false)).would_decision, 'allow');
  assert.equal((await run(true, false)).would_decision, 'allow');
  assert.equal((await run('HDR', true)).would_decision, 'veto');
  assert.equal((await run('无', false)).would_decision, 'veto');
  assert.equal((await run(false, false)).would_decision, 'veto');
});

test('/stats 带 late 计数', () => {
  const p = load({ config: Object.assign(flowCfg({}), { late: '3' }) });
  assert.equal(p.counters().late, 3);
});



// ─── 8：Emby / Plex 请求失败计入 allowed_error ─────────────────────────────────

const PLEX_CFG = { plex_enabled: '1', plex_url: 'http://plex.local', plex_token: 't' };

function plexEmpty(url) {
  if (url.indexOf('plex.local') >= 0) return resp({ MediaContainer: { Metadata: [] } });
  return null;
}

test('Plex 返回 5xx → allowed_error（不是 allowed_not_in_lib），不写缓存，plex_last_error 记原因', async () => {
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), { emby_enabled: '0' }, PLEX_CFG),
    httpGet: () => resp('', 502) });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.deepEqual(p.cacheKeys(), []);
  assert.equal(p.cfg.plex_last_error, 'status=502');
});

test('Emby 失败、Plex 正常但没找到 → 仍按查库没做完计 allowed_error（Emby 那边的情况未知），不写缓存', async () => {
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => { if (url.indexOf('emby.local') >= 0) throw new Error('http GET x: timeout'); return plexEmpty(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.deepEqual(p.cacheKeys(), []);
});

test('Emby 与 Plex 都正常查完、都没有这一集 → allowed_not_in_lib 并写缓存（与失败区分开）', async () => {
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => (url.indexOf('emby.local') >= 0 ? embyLib({ 9: [SDR] })(url) : plexEmpty(url)) });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_not_in_lib, 1);
  assert.equal(p.counters().allowed_error, 0);
  assert.equal(p.cacheKeys().length, 1);
});

test('Emby 查完没有、轮到 Plex 前已超软预算（没查完）→ allowed_error、不写缓存', async () => {
  let p;
  const lib = embyLib({ 9: [SDR] });
  p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) p.advance(2600); return url.indexOf('emby.local') >= 0 ? lib(url) : plexEmpty(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.ok(!p.httpCalls.some((u) => u.indexOf('plex.local') >= 0), 'plex must not be queried after the budget');
  assert.deepEqual(p.cacheKeys(), []);
});

// ─── G1 补漏：SDR / HLG / HDR Vivid；14：种子 dv 为「是」时 hdr 也算「是」 ──────────

test('SDR 是「否」：SDR 种子遇 SDR 副本 → 否决；遇 HDR10 副本 → 放行', async () => {
  for (const v of ['SDR', 'sdr', ' Sdr ']) {
    const sdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
    assert.equal(await sdr.hooks.should_download(payload({ tags: { hdr: v } })), false, 'sdr lib, hdr=' + v);
    const hdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
    assert.equal(await hdr.hooks.should_download(payload({ tags: { hdr: v } })), true, 'hdr lib, hdr=' + v);
  }
});

test('HLG / HDR Vivid 是「是」：遇 HDR 副本 → 否决；遇 SDR 副本 → 放行', async () => {
  for (const v of ['HLG', 'HDR Vivid', 'hdr vivid']) {
    const hdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
    assert.equal(await hdr.hooks.should_download(payload({ tags: { hdr: v } })), false, 'hdr lib, hdr=' + v);
    const sdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
    assert.equal(await sdr.hooks.should_download(payload({ tags: { hdr: v } })), true, 'sdr lib, hdr=' + v);
  }
});

test('14：只带 DV 关键字的种子（hdr="无", dv="DV"）按 HDR 算——配 hdr+dv 两维遇 DOVI 副本 → 否决', async () => {
  const p = load({ config: flowCfg({ hdr: { op: '==' }, dv: { op: '==' } }), httpGet: embyLib([DOVI]) });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: '无', dv: 'DV' } })), false);
});

test('14：只配 hdr 维度，dv="DolbyVision" 的种子遇 SDR 副本 → 放行；遇 HDR10 副本 → 否决', async () => {
  const sdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([SDR]) });
  assert.equal(await sdr.hooks.should_download(payload({ tags: { hdr: '无', dv: 'DolbyVision' } })), true);
  const hdr = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
  assert.equal(await hdr.hooks.should_download(payload({ tags: { hdr: '无', dv: 'DolbyVision' } })), false);
});

test('14：dv 为「否」时 hdr 保持原值（hdr="无", dv="无" 遇 HDR10 副本 → 放行）', async () => {
  const p = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib([HDR10]) });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: '无', dv: '无' } })), true);
});

test('14：合集路径同样按 dv→hdr 归一（全部集都是 HDR10 副本 → 整包否决）', async () => {
  const p = load({ config: flowCfg({ hdr: { op: '==' } }), httpGet: embyLib({ 9: [HDR10], 10: [HDR10] }) });
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9, episode_end: 10 }, tags: { hdr: '无', dv: 'DV' } })), false);
});

test('14：/check POST mock 的结论与明细同样按 dv→hdr 归一', async () => {
  const p = load({ config: flowCfg({}) });
  const r = JSON.parse(JSON.stringify(await p.apis['/check']({ method: 'POST', query: {},
    body: JSON.stringify({ mock_copies: [{ height: 1080, hdr: true, dv: true }], tags: { hdr: '无', dv: 'DV' }, dims: { hdr: { op: '==' } } }) })));
  assert.equal(r.would_decision, 'veto');
  assert.equal(r.copies[0].dims.hdr.tag_value, true);
  assert.equal(r.copies[0].dims.hdr.match, true);
});

// ─── G2：缓存淘汰（配合宿主 config.delete） ────────────────────────────────────

const HOUR = 3600;

function cacheEntries(n, tsOf) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out['lib_cache_tv_' + (5000 + i) + '_s1_e1'] = JSON.stringify({ copies: [], source: 'emby', ts: tsOf(i) });
  }
  return out;
}

function nowSecOf(h) { return Math.floor(h.now() / 1000); }

test('写缓存时删掉过期项（按 cache_ttl_sec），没过期的留着', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const cfg = Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_gen: '2' },
    cacheEntries(3, (i) => s0 - 100 * (i + 1)));      // 启动时都还新鲜
  const p = load({ config: cfg, startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  assert.equal(p.cacheKeys().length, 3, 'nothing expired at startup');
  p.advance((HOUR - 150) * 1000); // 现在 ts=s0-200 / s0-300 已满 1 小时，s0-100 还差 50 秒
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.deepEqual(p.cacheKeys().sort(), ['lib_cache_tv_1429_s1_e8', 'lib_cache_tv_5000_s1_e1']);
  assert.deepEqual(p.deletes.sort(), ['lib_cache_tv_5001_s1_e1', 'lib_cache_tv_5002_s1_e1']);
});

test('缓存键总数上限 300：已有 300 个新鲜缓存，再写一个 → 删最旧的一个，总数仍是 300', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const cfg = Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_gen: '2' },
    cacheEntries(300, (i) => s0 - 1000 + i));          // i=0 最旧
  const p = load({ config: cfg, startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  assert.equal(p.cacheKeys().length, 300);
  assert.equal(await p.hooks.should_download(payload()), true);
  const keys = p.cacheKeys();
  assert.equal(keys.length, 300);
  assert.ok(keys.includes('lib_cache_tv_1429_s1_e8'), 'the new entry is written');
  assert.ok(!keys.includes('lib_cache_tv_5000_s1_e1'), 'the oldest entry is evicted');
  assert.ok(keys.includes('lib_cache_tv_5001_s1_e1'));
  assert.deepEqual(p.deletes, ['lib_cache_tv_5000_s1_e1']);
});

test('上限按缓存键算：合集一次写 N 集也不会超过 300', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const cfg = Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_gen: '2' }, cacheEntries(299, (i) => s0 - 1000 + i));
  const p = load({ config: cfg, startMs: start, httpGet: embyLib({ 1: [SDR], 2: [SDR] }) });
  await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 12 } }));
  assert.equal(p.cacheKeys().length, 300);
  for (let e = 1; e <= 12; e++) assert.ok(p.cacheKeys().includes('lib_cache_tv_1429_s1_e' + e), 'ep ' + e);
});

test('配额 500 已被旧版缓存写满（升级自 0.3.x）：启动时删掉全部旧缓存键，之后计数器与缓存都写得进去', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const base = flowCfg({ resolution: { op: '==' } });
  const cfg = Object.assign({}, base, { vetoed: '7' },
    cacheEntries(500 - Object.keys(base).length - 1, () => s0 - 10)); // 正好 500 个 key，全是新鲜的旧版缓存
  assert.equal(Object.keys(cfg).length, 500);
  const p = load({ config: cfg, startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  assert.deepEqual(p.cacheKeys(), [], 'old-version cache keys are removed at startup');
  assert.equal(p.cfg.cache_gen, '2');
  assert.equal(p.cfg.vetoed, '7', 'non-cache keys untouched');
  assert.equal(p.cfg.flow_f1_enabled, '1');
  assert.ok(p.logs.some((l) => /removed \d+ cache keys left by an older version/.test(l[1])));
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().should_download_seen, 1, 'counter write no longer hits the quota');
  assert.equal(p.cacheKeys().length, 1);
  assert.equal(p.counters().cache_write_fail, 0);
});

test('重启（已是 0.4.0 缓存）：不整批删，只删过期的并裁到 300', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const fresh = cacheEntries(305, (i) => s0 - 400 + i);
  const stale = { lib_cache_movie_1_s0_e0: JSON.stringify({ copies: [], ts: s0 - 2 * HOUR }), lib_cache_tv_2_s1_e1: 'not json' };
  const p = load({ config: Object.assign(flowCfg({}), { cache_gen: '2' }, fresh, stale), startMs: start });
  const keys = p.cacheKeys();
  assert.equal(keys.length, 300);
  assert.ok(!keys.includes('lib_cache_movie_1_s0_e0') && !keys.includes('lib_cache_tv_2_s1_e1'), 'expired / unparsable removed');
  for (let i = 0; i < 5; i++) assert.ok(!keys.includes('lib_cache_tv_' + (5000 + i) + '_s1_e1'), 'oldest trimmed: ' + i);
  assert.ok(keys.includes('lib_cache_tv_5005_s1_e1'));
});

test('启动之后才出现的缓存键（如管理页手动加的）也算进上限：写缓存前按 config.list() 对账', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_gen: '2' }), startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  Object.assign(p.cfg, cacheEntries(300, (i) => s0 - 1000 + i), { lib_cache_tv_1_s1_e1: JSON.stringify({ copies: [], ts: s0 - 2 * HOUR }) });
  assert.equal(await p.hooks.should_download(payload()), true);
  const keys = p.cacheKeys();
  assert.equal(keys.length, 300);
  assert.ok(keys.includes('lib_cache_tv_1429_s1_e8'));
  assert.ok(!keys.includes('lib_cache_tv_1_s1_e1'), 'expired external key removed');
  assert.ok(!keys.includes('lib_cache_tv_5000_s1_e1'), 'oldest external key evicted');
});

test('cache_ttl_sec=0（关缓存）：不写缓存，已有的缓存键在下次写时删掉', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_gen: '2', cache_ttl_sec: '0' }, cacheEntries(2, () => s0)),
    startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.deepEqual(p.cacheKeys(), []);
});

test('旧宿主没有 config.delete：不淘汰、不写 cache_gen、照常工作（同 0.3.x）', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const p = load({ noConfigDelete: true, config: Object.assign(flowCfg({ resolution: { op: '==' } }), cacheEntries(3, () => s0 - 2 * HOUR)),
    startMs: start, httpGet: embyLib([SDR]) });
  assert.equal(p.cfg.cache_gen, undefined);
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.cacheKeys().length, 4);
});
