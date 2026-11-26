// node --test tests/media-library-filter/media-library-filter.test.js
// media-library-filter：await 迁移（http.* 返回 Promise）、宿主 3s 超时之后才回来的结果（late）、
// hdr / dv 宿主真实形态、纯内存按季 LRU 缓存（cache_max_mb）、短负缓存 TTL、零 DB 热路径、
// 配置实时+定时兜底刷新、tmdbID→seriesID 缓存自愈、in-flight 并发复用、旧版库缓存迁移清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, embyLib, flowCfg, payload, resp } = require('./harness');

const SDR = { height: 1080, codec: 'hevc', range: 'SDR' };
const HDR10 = { height: 1080, codec: 'hevc', range: 'HDR10' };
const DOVI = { height: 1080, codec: 'hevc', range: 'DOVI' };
const HOUR = 3600;

function outcomeCounters(c) {
  return Object.keys(c).filter((k) => /^(vetoed|allowed_|dry_run_would_veto|batch_partial_filtered)/.test(k) && c[k] > 0);
}

function matchingBatch(start, end) {
  const out = {};
  for (let ep = start; ep <= end; ep++) out[ep] = [SDR];
  return out;
}

function assertBitmapRange(base64, first, last, max) {
  const bytes = Buffer.from(base64, 'base64');
  for (let ep = 1; ep <= max; ep++) {
    const have = (bytes[(ep - 1) >> 3] & (1 << ((ep - 1) & 7))) !== 0;
    assert.equal(have, ep >= first && ep <= last, 'bitmap episode ' + ep);
  }
}

// 多季多剧 Emby mock：shows = { <tmdbID>: { id?: 's1', seasons: { <season>: { <ep>: [copy...] } } } }
function multiEmbyLib(shows, opts) {
  opts = opts || {};
  return function (url) {
    if (opts.onRequest) opts.onRequest(url);
    if (url.indexOf('IncludeItemTypes=Series') >= 0) {
      const m = url.match(/AnyProviderIdEquals=tmdb\.([^&]+)/);
      const tid = m ? decodeURIComponent(m[1]) : '';
      const show = shows[tid];
      if (!show) return resp({ Items: [] });
      return resp({ Items: [{ Id: show.id || ('s-' + tid), ProviderIds: { Tmdb: tid } }] });
    }
    if (url.indexOf('IncludeItemTypes=Episode') >= 0) {
      const m = url.match(/ParentId=([^&]+)/);
      const pid = m ? decodeURIComponent(m[1]) : '';
      let matchedShow = null;
      for (const tid of Object.keys(shows)) {
        const show = shows[tid];
        if ((show.id || ('s-' + tid)) === pid) { matchedShow = show; break; }
      }
      if (!matchedShow) return resp('', 404);
      const items = [];
      for (const sNum of Object.keys(matchedShow.seasons || {})) {
        const eps = matchedShow.seasons[sNum] || {};
        for (const epNum of Object.keys(eps)) {
          items.push({
            ParentIndexNumber: Number(sNum),
            IndexNumber: Number(epNum),
            MediaSources: eps[epNum].map((c) => ({
              Container: c.container || 'mkv',
              MediaStreams: [
                { Type: 'Video', Height: c.height, Width: 1920, Codec: c.codec, BitDepth: c.bitDepth || 10, VideoRange: c.range },
                { Type: 'Audio', Codec: 'aac' },
              ],
            })),
          });
        }
      }
      return resp({ Items: items });
    }
    return resp('', 404);
  };
}

// 多季多剧 Plex mock：shows = { <tmdbID>: { key?: 'pk-1', seasons: { <season>: { <ep>: [copy...] } } } }
function multiPlexLib(shows, opts) {
  opts = opts || {};
  return function (url) {
    if (opts.onRequest) opts.onRequest(url);
    if (url.indexOf('/library/all') >= 0) {
      const metas = Object.keys(shows).map((tid) => ({
        ratingKey: shows[tid].key || ('pk-' + tid),
        Guid: [{ id: 'tmdb://' + tid }],
      }));
      return resp({ MediaContainer: { Metadata: metas } });
    }
    const m = url.match(/\/library\/metadata\/([^/]+)\/allLeaves/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      let matchedShow = null;
      for (const tid of Object.keys(shows)) {
        const show = shows[tid];
        if ((show.key || ('pk-' + tid)) === key) { matchedShow = show; break; }
      }
      if (!matchedShow) return resp('', 404);
      const metas = [];
      for (const sNum of Object.keys(matchedShow.seasons || {})) {
        const eps = matchedShow.seasons[sNum] || {};
        for (const epNum of Object.keys(eps)) {
          metas.push({
            parentIndex: Number(sNum),
            index: Number(epNum),
            Media: eps[epNum].map((c) => ({
              videoResolution: c.height >= 2160 ? '4k' : String(c.height || 1080),
              videoCodec: c.codec || 'hevc',
              audioCodec: 'aac',
              container: c.container || 'mkv',
              videoProfile: c.range === 'HDR10' ? 'main 10 hdr' : 'main 10',
              colorTrc: c.range === 'HDR10' ? 'hdr10' : '',
              Part: [{
                Stream: [
                  { streamType: 1, bitDepth: c.bitDepth || 10, DOVIPresent: c.range === 'DOVI' ? 1 : 0 },
                  { streamType: 2, codec: 'aac' },
                ],
              }],
            })),
          });
        }
      }
      return resp({ MediaContainer: { Metadata: metas } });
    }
    return resp('', 404);
  };
}

// ─── await 迁移与基础行为 ──────────────────────────────────────────────────────

test('should_download 回调是 async：http 返回 Promise，同规格副本 → resolve false，vetoed 计数', async () => {
  const p = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: embyLib([SDR]) });
  const r = p.hooks.should_download(payload());
  assert.equal(typeof r.then, 'function', 'handler must return a Promise');
  assert.equal(await r, false);
  assert.equal(p.counters().vetoed, 1);
  assert.equal(p.counters().late, 0);
  assert.ok(p.logs.some((l) => /should_download flow=f1 .*decision=veto/.test(l[1])));
});

test('库里没有这一集 → 放行（allowed_not_in_lib）并进内存缓存；http 故障（reject）→ fail-open 放行、不写缓存', async () => {
  const miss = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: embyLib({ 9: [SDR] }) });
  assert.equal(await miss.hooks.should_download(payload()), true);
  assert.equal(miss.counters().allowed_not_in_lib, 1);
  assert.equal(miss.cacheStats().entries, 1, 'a clean miss is cached in memory');
  assert.deepEqual(miss.cacheKeys(), [], 'cache stays purely in memory (never written to DB)');

  // 8（operator）：请求失败不是「库里没有」——计 allowed_error、不计 allowed_not_in_lib、不写缓存
  const down = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: () => { throw new Error('http GET x: connection refused'); } });
  assert.equal(await down.hooks.should_download(payload()), true);
  assert.equal(down.counters().allowed_error, 1);
  assert.equal(down.counters().allowed_not_in_lib, 0);
  assert.equal(down.counters().vetoed, 0);
  assert.equal(down.cacheStats().entries, 0);
  assert.match(down.stats().errors.emby_last_error, /connection refused/);
  await down.runTimers();
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

test('单集：结果在宿主 3s 超时之后才回来 → 放行、计 late、打一条不带裁决的 warn、不记决策日志、不动其它计数、内存缓存照写', async () => {
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
  assert.equal(p.cacheStats().entries, 1, 'late result still fills the memory cache');

  // 后续同集直接命中刚写进来的内存缓存，0 HTTP
  const httpAfter = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.httpCalls.length, httpAfter);
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
  assert.equal(p.cacheStats().entries, 1, 'late batch result still warms the season cache');
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
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.equal(p.cacheStats().entries, 0);
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

test('G4：单集查库外层 catch 抛异常在 3s 之内 → allowed_error + error 日志；超 3s → late、不计 allowed_error、不打 error', async () => {
  // 在 embyGet 成功返回后，让下一次 nowSec/nowMs 抛异常一次，真正命中 decideShouldDownload 的 catch 分支
  const runCase = async (advanceMs) => {
    let p;
    let armThrow = false;
    p = load({
      config: flowCfg({ resolution: { op: '==' } }),
      httpGet: (url) => {
        if (url.indexOf('Episode') >= 0) {
          if (advanceMs) p.advance(advanceMs);
          armThrow = true;
        }
        return embyLib({ 9: [SDR] })(url);
      },
    });
    const origNow = p.ctx.__nowMs;
    p.ctx.__nowMs = () => {
      if (armThrow) { armThrow = false; throw new Error('outer-lib-boom'); }
      return origNow();
    };
    const r = await p.hooks.should_download(payload());
    return { p, r };
  };

  // < 3s：计 allowed_error 并打 error 日志
  const fast = await runCase(0);
  assert.equal(fast.r, true);
  assert.equal(fast.p.counters().allowed_error, 1);
  assert.equal(fast.p.counters().late, 0);
  assert.ok(fast.p.logs.some((l) => l[0] === 'error' && /outer-lib-boom/.test(l[1])), 'fast exception logs error');

  // > 3s：按 late 处理、不计 allowed_error、不打 error 日志
  const late = await runCase(3500);
  assert.equal(late.r, true);
  assert.equal(late.p.counters().late, 1);
  assert.equal(late.p.counters().allowed_error, 0);
  assert.ok(!late.p.logs.some((l) => l[0] === 'error'), 'no error log for a late exception');
});

test('G4：合集查库外层 catch 抛异常在 3s 之内 → allowed_error + error 日志；超 3s → late', async () => {
  const runBatchCase = async (advanceMs) => {
    let p;
    let armThrow = false;
    p = load({
      config: flowCfg({ resolution: { op: '==' } }),
      httpGet: (url) => {
        if (url.indexOf('Episode') >= 0) {
          if (advanceMs) p.advance(advanceMs);
          armThrow = true;
        }
        return embyLib({ 9: [SDR] })(url);
      },
    });
    const origNow = p.ctx.__nowMs;
    p.ctx.__nowMs = () => {
      if (armThrow) { armThrow = false; throw new Error('outer-batch-boom'); }
      return origNow();
    };
    const r = await p.hooks.should_download(payload({ media: { episode: 9, episode_end: 10 } }));
    return { p, r };
  };

  const fast = await runBatchCase(0);
  assert.equal(fast.r, true);
  assert.equal(fast.p.counters().allowed_error, 1);
  assert.equal(fast.p.counters().late, 0);
  assert.ok(fast.p.logs.some((l) => l[0] === 'error' && /outer-batch-boom/.test(l[1])));

  const late = await runBatchCase(3500);
  assert.equal(late.r, true);
  assert.equal(late.p.counters().late, 1);
  assert.equal(late.p.counters().allowed_error, 0);
  assert.ok(!late.p.logs.some((l) => l[0] === 'error'));
});

test('G4：handler 判定阶段抛异常且已过 3s → 兜底按 late 处理，warn 带 error=', async () => {
  let p;
  p = load({ config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => { if (url.indexOf('Episode') >= 0) p.advance(3500); return embyLib([SDR])(url); } });
  const badPayload = payload();
  Object.defineProperty(badPayload.tags, 'resolution', {
    get() { p.advance(3500); throw new Error('boom-late'); },
    enumerable: true,
  });
  assert.equal(await p.hooks.should_download(badPayload), true);
  const c = p.counters();
  assert.equal(c.late, 1);
  assert.equal(c.allowed_error, 0);
  const warns = p.logs.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /error=Error: boom-late/);
  assert.ok(!p.logs.some((l) => l[0] === 'error'));
});

// ─── 0.4.2 零 DB 热路径 + 纯内存按季缓存 + 计数器延迟落盘 ───────────────────────

test('热路径 0 DB 读写：单集、200 集合集、flow_disabled 期间不触发任何 config.get/set/list/delete', async () => {
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: embyLib(matchingBatch(1, 200)),
  });
  const getsBefore = p.configGets.length;
  const setsBefore = p.configSets.length;
  const listsBefore = p.configListCalls();
  const deletesBefore = p.deletes.length;

  assert.equal(await p.hooks.should_download(payload({ flow_id: 'disabled_flow' })), true);
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 200 } })), false);
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 200 } })), false);
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 150 } })), false);

  assert.equal(p.configGets.length, getsBefore, '0 config.get during should_download');
  assert.equal(p.configSets.length, setsBefore, '0 config.set during should_download');
  assert.equal(p.configListCalls(), listsBefore, '0 config.list during should_download');
  assert.equal(p.deletes.length, deletesBefore, '0 config.delete during should_download');
  assert.equal(p.httpCalls.length, 2, 'batch + cached batch + single ep share 1 Emby fetch');
  assert.deepEqual(p.cacheKeys(), [], 'no lib_cache_* persisted to DB');
  assert.equal(p.cacheStats().entries, 1, 'entire 200-ep season stored as 1 memory entry');

  // 统计数字已在内存里实时累加，跑定时器后分步落盘
  assert.equal(p.counters().should_download_seen, 4);
  assert.equal(p.counters().vetoed, 3);
  await p.runTimers();
  assert.equal(p.cfg.should_download_seen, '4');
  assert.equal(p.cfg.vetoed, '3');
  assert.deepEqual(p.cacheKeys(), [], 'timer flush writes stats only, never lib_cache_*');
});

test('100 集部分命中返回精确 have_bitmap，且单集查一次整季所有季均进内存缓存', async () => {
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: multiEmbyLib({
      1429: {
        seasons: {
          1: matchingBatch(1, 50),
          2: matchingBatch(1, 12),
        },
      },
    }),
  });

  // 单集触发查剧
  assert.equal(await p.hooks.should_download(payload({ media: { season: 1, episode: 5 } })), false);
  assert.equal(p.httpCalls.length, 2);
  assert.equal(p.cacheStats().entries, 2, 'both S1 and S2 cached from one fetch');

  // S1 合集 1-100（1-50 命中、51-100 缺集，60s 短负缓存窗口内）→ 0 HTTP 直接出精确 bitmap
  const res = await p.hooks.should_download(payload({ media: { season: 1, episode: 1, episode_end: 100 } }));
  assertBitmapRange(res.have_bitmap, 1, 50, 100);
  assert.equal(p.httpCalls.length, 2, 'S1 batch reuses season cache');

  // S2 任何集也直接命中内存 → 0 HTTP
  assert.equal(await p.hooks.should_download(payload({ media: { season: 2, episode: 1, episode_end: 12 } })), false);
  assert.equal(p.httpCalls.length, 2, 'S2 was cached along with S1');
});

// ─── 正/负缓存分级 TTL（命中 3600s，缺集/不匹配 60s） ───────────────────────────

test('分级 TTL：正命中沿用 3600s；缺集 60s 内复用缓存、超过 60s 自动重查感知新入库集', async () => {
  const showState = { 1429: { seasons: { 1: { 1: [SDR], 2: [SDR] } } } };
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: multiEmbyLib(showState),
  });

  // t=0: 合集 E1-3 → 缺 E3，返回 have_bitmap (1,2)
  const r1 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 3 } }));
  assertBitmapRange(r1.have_bitmap, 1, 2, 3);
  assert.equal(p.httpCalls.length, 2);

  // t=30s（< 60s）: 同合集 E1-3 与单集 E3 走短负缓存，不打 Emby
  p.advance(30 * 1000);
  const r2 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 3 } }));
  assertBitmapRange(r2.have_bitmap, 1, 2, 3);
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 3 } })), true);
  assert.equal(p.httpCalls.length, 2, 'missing episodes stay cached within 60s negative TTL');

  // t=120s（> 60s, < 3600s）:
  // 1) 已存在的 E1 依然走正命中缓存（0 HTTP）
  p.advance(90 * 1000);
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1 } })), false);
  assert.equal(p.httpCalls.length, 2, 'positive hit stays cached for full cache_ttl_sec');

  // 2) 现在 Emby 入库了 E3：再查 E1-3 时超过 60s 短负缓存 → 自动刷新 Emby（且复用 seriesID，只发 1 次 HTTP！）→ 整包否决
  showState[1429].seasons[1][3] = [SDR];
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 3 } })), false);
  assert.equal(p.httpCalls.length, 3, 'refreshed via cached seriesID (only 1 Episode HTTP call)');
  assert.equal(p.httpCalls[2].indexOf('IncludeItemTypes=Episode') >= 0, true);
});

test('分级 TTL：规格不匹配（库里 SDR 遇 HDR 种子）超过 60s 后刷新，能感知 Emby 洗版成 HDR', async () => {
  const showState = { 1429: { seasons: { 1: { 8: [SDR] } } } };
  const p = load({
    config: flowCfg({ resolution: { op: '==' }, hdr: { op: '==' } }),
    httpGet: multiEmbyLib(showState),
  });
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: 'HDR' } })), true);
  assert.equal(p.httpCalls.length, 2);

  // 30s 内不重查
  p.advance(30 * 1000);
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: 'HDR' } })), true);
  assert.equal(p.httpCalls.length, 2);

  // 超过 60s 且 Emby 已升级 HDR10 → 刷新后立即否决
  p.advance(40 * 1000);
  showState[1429].seasons[1][8] = [HDR10];
  assert.equal(await p.hooks.should_download(payload({ tags: { hdr: 'HDR' } })), false);
  assert.equal(p.httpCalls.length, 3);
});

// ─── cache_max_mb 按字节 LRU 淘汰、关闭缓存与 /clear-cache ──────────────────────

test('cache_max_mb 字节上限按 LRU 淘汰：访问过的旧季保活，最久未访问的季被踢出', async () => {
  const shows = {
    1001: { seasons: { 1: matchingBatch(1, 20) } },
    1002: { seasons: { 1: matchingBatch(1, 20) } },
    1003: { seasons: { 1: matchingBatch(1, 20) } },
  };
  // 先测单季大约占多少字节，把上限设到刚好能装下 2 季但装不下 3 季
  const probe = load({ config: flowCfg({ resolution: { op: '==' } }), httpGet: multiEmbyLib(shows) });
  await probe.hooks.should_download(payload({ media: { tmdb_id: '1001', episode: 1 } }));
  const oneSeasonBytes = probe.cacheStats().bytes;
  assert.ok(oneSeasonBytes > 1000);
  const limitMb = String((oneSeasonBytes * 2.5) / (1024 * 1024));

  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_max_mb: limitMb }),
    httpGet: multiEmbyLib(shows),
  });

  // 依次缓存 1001、1002
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1001', episode: 1 } })), false);
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1002', episode: 1 } })), false);
  assert.equal(p.cacheStats().entries, 2);

  // 再次访问 1001，刷新其 LRU 顺序（现在 1002 变成最久未访问）
  const callsBeforeTouch = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1001', episode: 2 } })), false);
  assert.equal(p.httpCalls.length, callsBeforeTouch);

  // 写入 1003 → 触发 LRU 淘汰，应踢掉 1002、保留 1001 和 1003
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1003', episode: 1 } })), false);
  assert.equal(p.cacheStats().entries, 2);
  assert.ok(p.cacheStats().bytes <= p.cacheStats().max_bytes);

  const callsAfterEvict = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1001', episode: 3 } })), false);
  assert.equal(p.httpCalls.length, callsAfterEvict, '1001 stayed in LRU cache');

  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '1002', episode: 1 } })), false);
  assert.ok(p.httpCalls.length > callsAfterEvict, '1002 was evicted and had to re-fetch');
});

test('cache_max_mb=0 或 cache_ttl_sec=0 关闭缓存；/clear-cache 仅接受 POST；cache_max_mb 硬上限 256MB', async () => {
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: embyLib([SDR]),
  });
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.cacheStats().entries, 1);
  assert.equal(p.cacheStats().series_id_entries, 1);

  // GET /clear-cache 被拒绝且不清空缓存
  const getRes = p.apis['/clear-cache']({ method: 'GET', body: '', query: {} });
  assert.equal(getRes.ok, false);
  assert.equal(p.cacheStats().entries, 1);
  assert.equal(p.cacheStats().series_id_entries, 1);

  const cleared = p.apis['/clear-cache']({ method: 'POST', body: '', query: {} });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared_entries, 1);
  assert.equal(cleared.cleared_series_ids, 1);
  assert.equal(p.cacheStats().entries, 0);
  assert.equal(p.cacheStats().series_id_entries, 0);

  // 设 cache_max_mb=0 后不再缓存
  const saveRes = p.apis['/save-config']({ method: 'POST', body: JSON.stringify({ cache_max_mb: '0' }), query: {} });
  assert.equal(saveRes.ok, true);
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.cacheStats().entries, 0);
  const calls1 = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.httpCalls.length, calls1 + 2, 'cache_max_mb=0 disables both season and seriesID cache');

  // 非法或超 256MB 上限的 cache_max_mb 被 /save-config 拒绝；256 允许
  assert.equal(p.apis['/save-config']({ method: 'POST', body: JSON.stringify({ cache_max_mb: '-5' }), query: {} }).ok, false);
  assert.equal(p.apis['/save-config']({ method: 'POST', body: JSON.stringify({ cache_max_mb: '257' }), query: {} }).ok, false);
  assert.equal(p.apis['/save-config']({ method: 'POST', body: JSON.stringify({ cache_max_mb: '256' }), query: {} }).ok, true);
  assert.equal(p.stats().config.cache_max_mb, 256);

  // 绕开 UI/API 直接改库写超大值时，运行时兜底 clamp 到 256MB
  p.cfg.cache_max_mb = '99999';
  assert.equal(p.stats().config.cache_max_mb, 256);
  assert.equal(p.cacheStats().max_bytes, 256 * 1024 * 1024);
});

test('关闭缓存（cache_ttl_sec=0）时不打断其它剧的 in-flight 并发复用', async () => {
  const lib = multiEmbyLib({
    A: { id: 'sA', seasons: { 1: { 8: [SDR] } } },
    B: { id: 'sB', seasons: { 1: { 8: [SDR] } } },
  });
  let releaseB = [];
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_ttl_sec: '0' }),
    httpGet: (url) => {
      if (url.indexOf('ParentId=sB') >= 0) {
        return new Promise((resolve) => { releaseB.push(() => resolve(lib(url))); });
      }
      return lib(url);
    },
  });

  const b1 = p.hooks.should_download(payload({ media: { tmdb_id: 'B' } }));
  for (let i = 0; i < 20 && !releaseB.length; i++) await Promise.resolve();
  assert.equal(releaseB.length, 1);

  // 剧 A 完成后走 putMemCache（ttl=0），不能清空 inFlight
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: 'A' } })), false);
  const before = p.httpCalls.length;
  const b2 = p.hooks.should_download(payload({ media: { tmdb_id: 'B' } }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(p.httpCalls.length - before, 0, 'concurrent same-show call must still reuse in-flight when cache is disabled');

  releaseB.forEach((f) => f());
  assert.deepEqual(await Promise.all([b1, b2]), [false, false]);
});

// ─── tmdbID → seriesID 缓存与 404 自愈 ──────────────────────────────────────────

test('seriesID 缓存失效返回 404 时自动清掉并重查 Series 拿到新 ID 写回缓存', async () => {
  let activeSeriesId = 'old-id';
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), { cache_ttl_sec: '3600' }),
    httpGet: (url) => {
      if (url.indexOf('IncludeItemTypes=Series') >= 0) {
        return resp({ Items: [{ Id: activeSeriesId, ProviderIds: { Tmdb: '1429' } }] });
      }
      if (url.indexOf('ParentId=' + activeSeriesId) >= 0) {
        return resp({
          Items: [{
            ParentIndexNumber: 1,
            IndexNumber: 8,
            MediaSources: [{ Container: 'mkv', MediaStreams: [{ Type: 'Video', Height: 1080, Width: 1920, Codec: 'hevc', BitDepth: 10, VideoRange: 'SDR' }, { Type: 'Audio', Codec: 'aac' }] }],
          }],
        });
      }
      return resp('', 404);
    },
  });

  // 首次查：拿 old-id 并缓存
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length, 2);

  // 超过 60s 短负缓存且 Emby 重建了条目（id 变成 new-id）
  p.advance(70 * 1000);
  activeSeriesId = 'new-id';
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 8 } })), false);
  // 第 1 次用缓存命中 ep8（正命中！）；改查缺失的 ep9 触发刷新：
  // 1) ParentId=old-id → 404
  // 2) 重查 Series → new-id
  // 3) ParentId=new-id → 200
  const callsBeforeRefresh = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length - callsBeforeRefresh, 3, '404 on stale seriesID triggers 1 fresh Series + 1 Episode retry');

  // 再过 70s 刷新 ep9：此时已缓存 new-id，直接 1 次 Episode HTTP 成功
  p.advance(70 * 1000);
  const callsAfterHeal = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length - callsAfterHeal, 1, 'healed new seriesID is cached for subsequent refreshes');
});

test('Emby seriesID 缓存失效返回 200+空列表 时自动清掉并重查拿到新 ID', async () => {
  let activeId = 'old';
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => {
      if (url.indexOf('IncludeItemTypes=Series') >= 0) {
        return resp({ Items: [{ Id: activeId, ProviderIds: { Tmdb: '1429' } }] });
      }
      if (url.indexOf('ParentId=' + activeId) >= 0) {
        return resp({
          Items: [{
            ParentIndexNumber: 1,
            IndexNumber: 8,
            MediaSources: [{ Container: 'mkv', MediaStreams: [{ Type: 'Video', Height: 1080, Width: 1920, Codec: 'hevc', BitDepth: 10, VideoRange: 'SDR' }] }],
          }],
        });
      }
      return resp({ Items: [] }); // 200 + empty for stale ParentId
    },
  });

  // 首次查 ep9 缓存 old-id；随后 Emby 重建该剧为 new
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  activeId = 'new';

  for (let i = 0; i < 5; i++) {
    p.advance(10 * 60 * 1000);
    assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
    assert.equal(await p.hooks.should_download(payload({ media: { episode: 8 } })), false, 'S1E8 must be vetoed after 200+empty self-heal');
  }
});

test('Plex showKey 缓存复用 + 404 与 200空列表 自愈；空剧壳(0集)不缓存 ID', async () => {
  let activeKey = 'pk-old';
  let staleStatus = 404;
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), { emby_enabled: '0' }, PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('/library/all') >= 0) {
        return resp({
          MediaContainer: {
            Metadata: [
              { ratingKey: activeKey, Guid: [{ id: 'tmdb://1429' }] },
              { ratingKey: 'pk-empty', Guid: [{ id: 'tmdb://8888' }] },
            ],
          },
        });
      }
      if (url.indexOf('/library/metadata/' + activeKey + '/allLeaves') >= 0) {
        return resp({
          MediaContainer: {
            Metadata: [{ parentIndex: 1, index: 8, Media: [{ videoResolution: '1080', videoCodec: 'hevc', container: 'mkv' }] }],
          },
        });
      }
      if (url.indexOf('/library/metadata/pk-empty/allLeaves') >= 0) {
        return resp({ MediaContainer: { Metadata: [] } });
      }
      return staleStatus === 404 ? resp('', 404) : resp({ MediaContainer: { Metadata: [] } });
    },
  });

  // 0 集空剧壳不写入 seriesIdCache
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '8888', episode: 1 } })), true);
  assert.equal(p.cacheStats().series_id_entries, 0, '0-episode show must not be cached in seriesIdCache');

  // 首次查 1429 缓存 pk-old
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.cacheStats().series_id_entries, 1);

  // 404 自愈
  p.advance(70 * 1000);
  activeKey = 'pk-v2';
  staleStatus = 404;
  const before404 = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length - before404, 3, 'Plex 404 triggers show refresh + allLeaves retry');
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 8 } })), false);

  // 200 空列表自愈
  p.advance(70 * 1000);
  activeKey = 'pk-v3';
  staleStatus = 200;
  const beforeEmpty = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length - beforeEmpty, 3, 'Plex 200+empty triggers show refresh + allLeaves retry');

  // 再次刷新直接复用 pk-v3（1 次 allLeaves 请求）
  p.advance(70 * 1000);
  const beforeReuse = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 9 } })), true);
  assert.equal(p.httpCalls.length - beforeReuse, 1, 'healed Plex showKey is reused');
});

test('整剧重查成功时清理该剧已消失的旧季缓存（不残留已删季）', async () => {
  let hasSeason2 = true;
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => multiEmbyLib({
      1429: {
        seasons: hasSeason2
          ? { 1: { 8: [SDR] }, 2: { 1: [SDR] } }
          : { 1: { 8: [SDR] } },
      },
    })(url),
  });

  // 首次查 S1E9：S1 和 S2 都写进内存缓存
  assert.equal(await p.hooks.should_download(payload({ media: { season: 1, episode: 9 } })), true);
  assert.equal(p.cacheStats().entries, 2);
  assert.equal(await p.hooks.should_download(payload({ media: { season: 2, episode: 1 } })), false);

  // Emby 删掉 S2；70s 后查 S1E9 触发整剧刷新 → 旧 S2 缓存应一并清除，不再误否决 S2E1
  hasSeason2 = false;
  p.advance(70 * 1000);
  assert.equal(await p.hooks.should_download(payload({ media: { season: 1, episode: 9 } })), true);
  assert.equal(p.cacheStats().entries, 1, 'deleted season S2 removed from memory cache on full-series refresh');
  assert.equal(await p.hooks.should_download(payload({ media: { season: 2, episode: 1 } })), true);
});

test('整剧重查成功时保留并续期已存在的空季短缓存（60s 内再查该空季 0 HTTP）', async () => {
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: multiEmbyLib({ 1429: { seasons: { 1: { 8: [SDR] } } } }),
  });

  // t=0: 查不存在的 S2E1 → 写入 S1(有集) 和 S2(空季短缓存)
  assert.equal(await p.hooks.should_download(payload({ media: { season: 2, episode: 1 } })), true);
  assert.equal(p.cacheStats().entries, 2);

  // t=70s: 查缺失的 S1E9 触发整剧刷新（Emby 仍无 S2）→ S2 空季短缓存保留并续期到 t=70s
  p.advance(70 * 1000);
  assert.equal(await p.hooks.should_download(payload({ media: { season: 1, episode: 9 } })), true);
  assert.equal(p.cacheStats().entries, 2, 'existing empty-season miss cache kept and renewed');

  // t=100s（距整剧刷新仅 30s < 60s）：再查 S2E1 直接命中续期后的空季短缓存，0 HTTP
  p.advance(30 * 1000);
  const callsBeforeS2 = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload({ media: { season: 2, episode: 1 } })), true);
  assert.equal(p.httpCalls.length, callsBeforeS2, 'renewed empty-season cache serves S2 with 0 HTTP');
});

// ─── in-flight 并发复用（singleflight） ────────────────────────────────────────

test('同剧并发请求复用在途 Promise：只发 1 轮 Emby HTTP，不同标签种子各自独立判定', async () => {
  const lib = multiEmbyLib({
    1429: { seasons: { 1: { 8: [SDR] }, 2: { 1: [SDR] } } },
  });
  let releaseEpisode = null;
  const p = load({
    config: flowCfg({ resolution: { op: '==' }, hdr: { op: '==' } }),
    httpGet: (url) => {
      if (url.indexOf('IncludeItemTypes=Episode') >= 0) {
        return new Promise((resolve) => {
          releaseEpisode = () => resolve(lib(url));
        });
      }
      return lib(url);
    },
  });

  // 三个并发请求：S1E8(SDR→应否决)、S1E8(HDR→应放行)、S2E1(SDR→应否决)
  const p1 = p.hooks.should_download(payload({ media: { season: 1, episode: 8 }, tags: { hdr: '无' } }));
  const p2 = p.hooks.should_download(payload({ media: { season: 1, episode: 8 }, tags: { hdr: 'HDR' } }));
  const p3 = p.hooks.should_download(payload({ media: { season: 2, episode: 1 }, tags: { hdr: '无' } }));

  for (let i = 0; i < 20 && !releaseEpisode; i++) await Promise.resolve();
  assert.equal(typeof releaseEpisode, 'function');
  assert.equal(p.httpCalls.length, 2, 'all 3 concurrent calls for same show share 1 Series + 1 Episode HTTP');

  releaseEpisode();
  assert.deepEqual(await Promise.all([p1, p2, p3]), [false, true, false]);
  assert.equal(p.httpCalls.length, 2);
});

test('跨剧并发互不阻塞；同剧第 1 个超时(late)时，较晚到达的第 2 个仍可通过共享在途请求及时否决', async () => {
  const shows = {
    1429: { seasons: { 1: { 8: [SDR] } } },
    9999: { seasons: { 1: { 1: [SDR] } } },
  };
  const lib = multiEmbyLib(shows);
  let release1429 = null;
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => {
      if (url.indexOf('ParentId=s-1429') >= 0) {
        return new Promise((resolve) => { release1429 = () => resolve(lib(url)); });
      }
      return lib(url);
    },
  });

  // t=0: 1429 开始挂起
  const first1429 = p.hooks.should_download(payload({ media: { tmdb_id: '1429', episode: 8 } }));
  for (let i = 0; i < 20 && !release1429; i++) await Promise.resolve();

  // 9999 不受 1429 挂起影响，立刻完成否决
  assert.equal(await p.hooks.should_download(payload({ media: { tmdb_id: '9999', episode: 1 } })), false);

  // t=2000ms: 第二个 1429 进来搭便车
  p.advance(2000);
  const second1429 = p.hooks.should_download(payload({ media: { tmdb_id: '1429', episode: 8 } }));

  // t=3500ms: Emby 回包（对 first 已超 3s → late；对 second 仅 1.5s → 按时 veto！）
  p.advance(1500);
  release1429();
  const [r1, r2] = await Promise.all([first1429, second1429]);
  assert.equal(r1, true, 'first caller exceeded 3s and returns late');
  assert.equal(r2, false, 'second caller finished within 1.5s and vetoes via shared in-flight');
  assert.equal(p.counters().late, 1);
  assert.equal(p.counters().vetoed, 2); // 9999 + second1429
});

// ─── 配置实时刷新（/flows）+ 30s 定时兜底 + 改后端自动清缓存 ─────────────────────

test('配置同步：网页保存后调 /flows 立即生效；绕开 UI 改库经 30s 后台定时刷新兜底生效，且改 emby_url 自动清缓存', async () => {
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: embyLib([SDR]),
    flows: [{ id: 'f1', name: 'Flow 1' }],
  });
  assert.equal(p.registeredIntervals(), 1, '30s fallback config refresh interval registered');

  // 先预热缓存
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.cacheStats().entries, 1);

  // 模拟 UI 通过宿主 FC.config.put 禁用 f1，随后 UI 调 /flows → 立刻生效
  p.cfg.flow_f1_enabled = '0';
  assert.equal(await p.hooks.should_download(payload()), false, 'before /flows, hot path reads memory snapshot');
  p.apis['/flows']({ method: 'GET', body: '', query: {} });
  assert.equal(await p.hooks.should_download(payload()), true, 'after /flows, disabled flow takes effect immediately');

  // 模拟外部直接改底层库：重新启用 f1 且更换 emby_url → 跑 30s 定时器 + 分步读完后自动生效并清空旧 Emby 缓存
  p.cfg.flow_f1_enabled = '1';
  p.cfg.emby_url = 'http://emby-new.local';
  await p.runIntervals();
  await p.runTimers();
  assert.equal(p.cacheStats().entries, 0, 'changing emby_url clears memory cache automatically');
  assert.equal(p.cacheStats().series_id_entries, 0);
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.ok(p.httpCalls[p.httpCalls.length - 1].startsWith('http://emby-new.local'));
});

test('旧宿主没有 setTimeout/setInterval 时仍正常工作并使用纯内存缓存', async () => {
  const p = load({
    noSetTimeout: true,
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: embyLib([SDR]),
  });
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.pendingTimers(), 0);
  assert.deepEqual(p.cacheKeys(), []);
  const httpCallsAfterFirst = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.httpCalls.length, httpCallsAfterFirst);
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

test('/stats 带 late 计数、cache 用量和 cache_max_mb 配置', () => {
  const p = load({ config: Object.assign(flowCfg({}), { late: '3', cache_max_mb: '16' }) });
  assert.equal(p.counters().late, 3);
  assert.equal(p.stats().config.cache_max_mb, 16);
  assert.equal(p.cacheStats().max_bytes, 16 * 1024 * 1024);
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
  assert.equal(p.cacheStats().entries, 0);
  assert.equal(p.stats().errors.plex_last_error, 'status=502');
  await p.runTimers();
  assert.equal(p.cfg.plex_last_error, 'status=502');
});

test('Emby 失败、Plex 正常但没找到 → 计 allowed_error；Plex 独立缓存写入，下次仅重试 Emby', async () => {
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => { if (url.indexOf('emby.local') >= 0) throw new Error('http GET x: timeout'); return plexEmpty(url); } });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.equal(p.cacheStats().entries, 1, 'Plex clean miss is cached independently while failed Emby is not');

  // 60s 短缓存内再次查询：Plex 命中缓存 0 HTTP，只重试失败的 Emby
  const plexCallsBefore = p.httpCalls.filter((u) => u.indexOf('plex.local') >= 0).length;
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.httpCalls.filter((u) => u.indexOf('plex.local') >= 0).length, plexCallsBefore, 'Plex not re-queried within 60s');
});

test('Emby 与 Plex 都正常查完、都没有这一集 → allowed_not_in_lib 并各自写内存缓存（与失败区分开）', async () => {
  const p = load({ config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => (url.indexOf('emby.local') >= 0 ? embyLib({ 9: [SDR] })(url) : plexEmpty(url)) });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_not_in_lib, 1);
  assert.equal(p.counters().allowed_error, 0);
  assert.equal(p.cacheStats().entries, 2, 'each backend caches its own clean season result');
  const callsAfterFirst = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.httpCalls.length, callsAfterFirst, 'both backends hit short negative cache (0 HTTP)');
});

test('单后端多步请求间超软预算（Plex 找剧耗 2600ms）→ 不发 allLeaves，计 allowed_error 且不写 Plex 缓存', async () => {
  let p;
  const plex = multiPlexLib({ 1429: { seasons: { 1: { 8: [SDR] } } } });
  p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), { emby_enabled: '0' }, PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('/library/all') >= 0) p.advance(2600);
      return plex(url);
    },
  });
  assert.equal(await p.hooks.should_download(payload()), true);
  assert.equal(p.counters().allowed_error, 1);
  assert.equal(p.counters().allowed_not_in_lib, 0);
  assert.ok(!p.httpCalls.some((u) => u.indexOf('allLeaves') >= 0), 'allLeaves must not be sent after soft budget');
  assert.equal(p.cacheStats().entries, 0);
});

// ─── 双后端并行竞速（方案 B）与按后端独立缓存 ──────────────────────────────────────

test('双后端并行：Emby 命中、Plex 挂起超 3.5s → Emby 立刻否决（不 late），后续走 Emby 缓存 0 HTTP', async () => {
  let releasePlex = null;
  const emby = embyLib([SDR]);
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('plex.local') >= 0) {
        return new Promise((_, reject) => {
          releasePlex = () => reject(new Error('http GET plex: context deadline exceeded'));
        });
      }
      return emby(url);
    },
  });

  // 首次：Emby 立刻返回否决，不等挂起的 Plex
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.counters().vetoed, 1);
  assert.equal(p.counters().late, 0);
  assert.equal(p.cacheStats().entries, 1, 'Emby season cached immediately');

  // 后续 2 次在 Plex 还没返回时仍直接命中 Emby 缓存 0 HTTP
  const callsAfter1 = p.httpCalls.length;
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.httpCalls.length, callsAfter1, 'subsequent hits served from Emby cache with 0 HTTP');
  assert.equal(p.counters().vetoed, 3);

  // 后台挂起的 Plex 最终超 3.5s 失败：不产生未捕获异常、不影响已返回结果
  p.advance(3500);
  releasePlex();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(p.counters().late, 0);
});

test('双后端并行对称性：Plex 命中、Emby 挂起超 3.5s → Plex 立刻否决（不 late），后续走 Plex 缓存 0 HTTP', async () => {
  let releaseEmby = null;
  const plex = multiPlexLib({ 1429: { seasons: { 1: { 8: [SDR] } } } });
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('emby.local') >= 0) {
        return new Promise((_, reject) => {
          releaseEmby = () => reject(new Error('http GET emby: context deadline exceeded'));
        });
      }
      return plex(url);
    },
  });

  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.counters().vetoed, 1);
  assert.equal(p.counters().late, 0);
  const callsAfter1 = p.httpCalls.length;

  // Plex 缓存已命中 → 后续请求对称短路，不查 Emby 也不查 Plex
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.httpCalls.length, callsAfter1);

  p.advance(3500);
  releaseEmby();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(p.counters().late, 0);
});

test('双后端容错：一端快速 502、另一端命中 → 仍正常否决且健康端写缓存（第 2 次 0 HTTP）', async () => {
  // Emby 命中 + Plex 502
  const p1 = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => (url.indexOf('plex.local') >= 0 ? resp('', 502) : embyLib([SDR])(url)),
  });
  assert.equal(await p1.hooks.should_download(payload()), false);
  assert.equal(p1.cacheStats().entries, 1);
  const c1 = p1.httpCalls.length;
  assert.equal(await p1.hooks.should_download(payload()), false);
  assert.equal(p1.httpCalls.length, c1, '2nd request hits Emby cache (0 HTTP, does not hammer dead Plex)');

  // Emby 502 + Plex 命中
  const plex = multiPlexLib({ 1429: { seasons: { 1: { 8: [SDR] } } } });
  const p2 = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => (url.indexOf('emby.local') >= 0 ? resp('', 502) : plex(url)),
  });
  assert.equal(await p2.hooks.should_download(payload()), false);
  assert.equal(p2.cacheStats().entries, 1);
  const c2 = p2.httpCalls.length;
  assert.equal(await p2.hooks.should_download(payload()), false);
  assert.equal(p2.httpCalls.length, c2, '2nd request hits Plex cache (0 HTTP, does not hammer dead Emby)');
});

test('双后端互补：单集 Emby 只有 SDR、Plex 有 HDR → 遇 HDR 种子照常否决；合集 Emby 1-20 + Plex 21-40 合并整包否决', async () => {
  const emby = multiEmbyLib({ 1429: { seasons: { 1: matchingBatch(1, 20) } } });
  const plexEpisodes = {};
  for (let ep = 21; ep <= 40; ep++) plexEpisodes[ep] = [SDR];
  plexEpisodes[8] = [HDR10];
  const plex = multiPlexLib({ 1429: { seasons: { 1: plexEpisodes } } });

  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' }, hdr: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => (url.indexOf('emby.local') >= 0 ? emby(url) : plex(url)),
  });

  // 单集 S1E8 HDR：Emby 是 SDR 不匹配，Plex 有 HDR → 否决
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 8 }, tags: { hdr: 'HDR' } })), false);
  assert.equal(p.cacheStats().entries, 2);
  const callsAfterSingle = p.httpCalls.length;

  // 合集 S1E1-40 SDR：Emby 缓存有 1-20（SDR），Plex 缓存有 21-40（SDR）→ 两端缓存合并覆盖全部 40 集，0 HTTP 整包否决！
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 40 }, tags: { hdr: '无' } })), false);
  assert.equal(p.httpCalls.length, callsAfterSingle, 'combined Emby+Plex positive caches veto 1-40 with 0 HTTP');

  // 合集 S1E1-45 SDR：两端共有 1-40、缺 41-45 → 60s 短缓存内直接返回 1-40 bitmap（0 HTTP）
  const partial = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 45 }, tags: { hdr: '无' } }));
  assert.equal(typeof partial, 'object');
  assertBitmapRange(partial.have_bitmap, 1, 40, 45);
  assert.equal(p.httpCalls.length, callsAfterSingle);
});

test('合集双后端并行：Emby 已覆盖 1-40、Plex 挂起超 3.5s → Emby 立刻整包否决不等 Plex', async () => {
  let releasePlex = null;
  const emby = multiEmbyLib({ 1429: { seasons: { 1: matchingBatch(1, 40) } } });
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('plex.local') >= 0) {
        return new Promise((_, reject) => {
          releasePlex = () => reject(new Error('plex hang'));
        });
      }
      return emby(url);
    },
  });

  assert.equal(await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 40 } })), false);
  assert.equal(p.counters().vetoed, 1);
  assert.equal(p.counters().late, 0);
  p.advance(3500);
  releasePlex();
  for (let i = 0; i < 10; i++) await Promise.resolve();
});

test('合集：正缓存过 60s 后重查遇 502，仍回退到有效正缓存返回部分 bitmap 并记排查日志（与单集一致）', async () => {
  let down = false;
  const emby = embyLib(matchingBatch(1, 10));
  const p = load({
    config: flowCfg({ resolution: { op: '==' } }),
    httpGet: (url) => (down ? resp('', 502) : emby(url)),
  });

  // t=0: 查 1-12 集，命中 1-10 集，返回 bitmap /wM=
  const r0 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 12 } }));
  assert.equal(typeof r0, 'object');
  assert.equal(r0.have_bitmap, '/wM=');
  assertBitmapRange(r0.have_bitmap, 1, 10, 12);

  // t=120s（过 60s 短缓存、仍在 3600s 正缓存期内）Emby 返回 502
  p.advance(120 * 1000);
  down = true;
  assert.equal(await p.hooks.should_download(payload({ media: { episode: 5 } })), false, 'single ep5 vetoed from positive cache');

  const r1 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 12 } }));
  assert.equal(typeof r1, 'object');
  assert.equal(r1.have_bitmap, '/wM=', 'batch falls back to valid positive cache bitmap instead of redownloading 1-10');
  assert.equal(p.counters().allowed_error, 0);
  assert.ok(p.logs.some((l) => l[0] === 'warn' && /falling back to valid memory cache \(age=120s\)/.test(l[1]) && /status_502/.test(l[1])),
    'warn log records fallback reason and cache age');
  assert.ok(p.logs.some((l) => l[0] === 'info' && /cache_fallback=emby/.test(l[1])),
    'batch decision log marks cache_fallback=emby');
});

test('合集双后端：Emby 旧缓存未贡献命中集且刷新 502、命中的集全来自 Plex → 不误打 cache_fallback=emby 与回退 warn', async () => {
  let embyDown = false;
  const plex = multiPlexLib({ 1429: { seasons: { 1: matchingBatch(1, 5) } } });
  const p = load({
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), PLEX_CFG),
    httpGet: (url) => {
      if (url.indexOf('emby.local') >= 0) {
        if (embyDown) return resp('', 502);
        return resp({ Items: [] }); // Emby 里原本就没有这部剧（空缓存）
      }
      return plex(url);
    },
  });

  // t=0: Emby 空缓存，Plex 有 1-5 集
  const r0 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 12 } }));
  assert.equal(typeof r0, 'object');
  assertBitmapRange(r0.have_bitmap, 1, 5, 12);

  // t=120s: Emby 502，Plex 正常返回 1-5 集；Emby 旧缓存为空未贡献命中集，不该标 cache_fallback=emby
  p.advance(120 * 1000);
  embyDown = true;
  p.logs.length = 0;
  const r1 = await p.hooks.should_download(payload({ media: { episode: 1, episode_end: 12 } }));
  assert.equal(typeof r1, 'object');
  assertBitmapRange(r1.have_bitmap, 1, 5, 12);
  assert.ok(!p.logs.some((l) => /cache_fallback=/.test(l[1])), 'empty stale cache must not be logged as cache_fallback');
  assert.ok(!p.logs.some((l) => l[0] === 'warn' && /falling back to valid memory cache/.test(l[1])),
    'no fallback warn when stale cache contributed 0 matching episodes');
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

// ─── 升级自 <= 0.4.1 的旧版库缓存分步清理 ───────────────────────────────────────

function legacyCacheEntries(n, tsOf) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out['lib_cache_tv_' + (5000 + i) + '_s1_e1'] = JSON.stringify({ copies: [], source: 'emby', ts: tsOf(i) });
  }
  return out;
}

test('升级自 0.4.1 / 0.3.x（500 配额已满）：启动同步删 10 个立释配额，其余后台分步删光并写 cache_gen=3', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const base = flowCfg({ resolution: { op: '==' } });
  const legacyCount = 500 - Object.keys(base).length - 2; // 留 2 个给 vetoed + cache_gen="2"
  const cfg = Object.assign({}, base, { vetoed: '7', cache_gen: '2' }, legacyCacheEntries(legacyCount, () => s0 - 10));
  assert.equal(Object.keys(cfg).length, 500);

  const p = load({ config: cfg, startMs: start, httpGet: embyLib({ 9: [SDR] }) });
  // 启动同步只删 10 个（避免慢库上撞 10s 启动超时），同时已经腾出 10 个配额
  assert.equal(p.deletes.length, 10, 'startup deletes at most 10 legacy keys synchronously');
  assert.equal(p.cfg.vetoed, '7', 'non-cache keys untouched');
  assert.equal(p.cfg.flow_f1_enabled, '1');

  // 即使后台还没清完，should_download 与统计落盘都不再撞 500 配额
  assert.equal(await p.hooks.should_download(payload()), true);
  await p.runTimers();
  assert.deepEqual(p.cacheKeys(), [], 'all legacy lib_cache_* keys removed after background cleanup');
  assert.equal(p.cfg.cache_gen, '3');
  assert.equal(p.counters().should_download_seen, 1);
  assert.equal(p.cfg.should_download_seen, '1');
  assert.ok(p.logs.some((l) => /removed \d+ legacy cache keys/.test(l[1])));
});

test('已是 cache_gen=3 时启动不再扫删旧缓存', () => {
  const p = load({ config: Object.assign(flowCfg({}), { cache_gen: '3' }) });
  assert.equal(p.deletes.length, 0);
  assert.equal(p.pendingTimers(), 0);
});

test('旧宿主没有 config.delete 时不报错、不写 cache_gen，仍用纯内存缓存工作', async () => {
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  const s0 = Math.floor(start / 1000);
  const p = load({
    noConfigDelete: true,
    config: Object.assign(flowCfg({ resolution: { op: '==' } }), legacyCacheEntries(3, () => s0 - 2 * HOUR)),
    startMs: start,
    httpGet: embyLib([SDR]),
  });
  assert.equal(p.cfg.cache_gen, undefined);
  assert.equal(await p.hooks.should_download(payload()), false);
  assert.equal(p.cacheStats().entries, 1);
  assert.equal(p.cacheKeys().length, 3, 'no new lib_cache_* keys added to DB');
});
