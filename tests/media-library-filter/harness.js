// 把 plugins/media-library-filter/index.js 载入 Node vm，注入与宿主同形的 stub facade，驱动 should_download /
// registerAPI。收编自 2026-09-25 审核复现（/tmp/fcp-rv/rv-repro/mlf-harness.js）。
//
// 时钟可控：插件里的 Date 换成读 h.now() 的版本，h.advance(ms) 快进——测「宿主 3s 超时之后才回来」
// 不用真等 3 秒。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'media-library-filter', 'index.js'), 'utf-8');

// opts: { config, httpGet: (url, headers) => resp | Promise<resp>, flows: [{id,name}], maxConfigKeys,
//         noConfigDelete: true → 模拟没有 config.delete 的旧宿主,
//         onConfigGet: (key) => void（可以 throw，用来在指定时刻制造异常） }
function load(opts) {
  opts = opts || {};
  const hooks = {}, apis = {}, logs = [];
  const cfg = Object.assign(Object.create(null), opts.config || {});
  const maxKeys = opts.maxConfigKeys || 500;
  let clock = opts.startMs || Date.UTC(2026, 8, 25, 0, 0, 0);
  const httpCalls = [];
  const ctx = {
    plugin: { on: (n, f) => { hooks[n] = f; }, registerAPI: (p, f) => { apis[p] = f; } },
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
    },
    config: {
      get: (k) => { if (opts.onConfigGet) opts.onConfigGet(k); return k in cfg ? cfg[k] : null; },
      // 同宿主：value 按字符串存；新 key 受每插件条数配额限制（已有 key 更新不计）
      set: (k, v) => {
        if (!(k in cfg) && Object.keys(cfg).length >= maxKeys) {
          throw new Error('plugin config: row quota exceeded: current=' + Object.keys(cfg).length + ' limit=' + maxKeys);
        }
        cfg[k] = String(v);
      },
      list: () => Object.keys(cfg).sort(),
    },
    http: { get: (url, h) => { httpCalls.push(url); return Promise.resolve().then(() => opts.httpGet(url, h)); } },
    ruleflow: { list: () => (opts.flows || []).slice() },
    __nowMs: () => clock,
  };
  // 宿主 R4：config.delete(key) 同步返回是否删到
  const deletes = [];
  if (!opts.noConfigDelete) {
    ctx.config.delete = (k) => { k = String(k); deletes.push(k); if (!(k in cfg)) return false; delete cfg[k]; return true; };
  }
  vm.createContext(ctx);
  vm.runInContext(`(function () {
    var RealDate = Date;
    function FakeDate() {
      var a = Array.prototype.slice.call(arguments);
      if (a.length === 0) a = [__nowMs()];
      return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return __nowMs(); };
    FakeDate.UTC = RealDate.UTC;
    FakeDate.parse = RealDate.parse;
    Date = FakeDate;
  })();`, ctx);
  vm.runInContext(INDEX_JS, ctx, { filename: 'plugins/media-library-filter/index.js' });
  return {
    hooks, apis, logs, cfg, ctx, httpCalls, deletes,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    counters: () => JSON.parse(JSON.stringify(apis['/stats']({ method: 'GET', body: '', query: {} }).counters)),
    cacheKeys: () => Object.keys(cfg).filter((k) => k.startsWith('lib_cache_')),
  };
}

function resp(body, status) {
  return { status: status || 200, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body), truncated: false };
}

// Emby mock：一部剧（tmdb 1429），episodes 里每集的副本属性由 copiesByEp 给出
// copiesByEp: { <ep>: [{height, codec, range, bitDepth, container}] }（缺省 ep 8）
function embyLib(copiesByEp, opts) {
  opts = opts || {};
  if (Array.isArray(copiesByEp)) copiesByEp = { 8: copiesByEp };
  return function (url) {
    if (opts.onRequest) opts.onRequest(url);
    if (url.indexOf('IncludeItemTypes=Series') >= 0) {
      return resp({ Items: [{ Id: 's1', ProviderIds: { Tmdb: '1429' } }] });
    }
    if (url.indexOf('IncludeItemTypes=Episode') >= 0) {
      const items = Object.keys(copiesByEp).map((ep) => ({
        ParentIndexNumber: 1, IndexNumber: Number(ep),
        MediaSources: copiesByEp[ep].map((c) => ({ Container: c.container || 'mkv', MediaStreams: [
          { Type: 'Video', Height: c.height, Width: 1920, Codec: c.codec, BitDepth: c.bitDepth || 10, VideoRange: c.range },
          { Type: 'Audio', Codec: 'aac' }] })),
      }));
      return resp({ Items: items });
    }
    return resp('', 404);
  };
}

const EMBY_CFG = { emby_enabled: '1', emby_url: 'http://emby.local', emby_api_key: 'k' };

function flowCfg(dims) {
  return Object.assign({}, EMBY_CFG, { flow_f1_enabled: '1', flow_f1_dims: JSON.stringify(dims) });
}

// 宿主真实形态的 should_download payload（domain.PreDownloadCheck；hdr / dv 是字符串，没识别到是 "无"）
function payload(over) {
  over = over || {};
  return {
    flow_id: 'f1',
    media: Object.assign({ tmdb_id: '1429', tmdb_type: 'tv', imdb_id: '', season: 1, episode: 8, episode_end: 0,
      title: 'T', original_title: '', aka: [], year: 2024 }, over.media),
    tags: Object.assign({ resolution: '1080p', video_encode: 'HEVC', audio_encode: 'AAC', dv: '无', hdr: '无', code_bits: '10bit',
      format: 'MKV', language: '', source: '', group: '', special_content: '', part_alias: '' }, over.tags),
    ctx: {},
  };
}

module.exports = { load, embyLib, resp, EMBY_CFG, flowCfg, payload };
