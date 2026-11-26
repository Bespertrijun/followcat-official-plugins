// media-library-filter — like-for-like 下载去重器（should_download）
//
// 在 ruleflow 把种子推给 qBittorrent 之前同步查询 Emby / Plex 媒体库：
// 拿种子自身的 p.tags（分辨率/编码等）与库内副本属性逐维比对，
// 若库内任意一份副本在**用户为该 flow 勾选的全部维度**上都匹配，
// 则 return false 跳过下载（去重），否则放行。
//
// 核心语义（v3 like-for-like）：
//   * 比对的值来自 p.tags（种子标题解析），不是用户手填的 spec。
//   * 用户只配「比哪些维度」+「每个维度用什么操作符」（==、>=、regex）。
//   * 双端 fail-open：tag 端或库端任一端拿不到值 → 该维度不匹配 → 放行。
//   * 已配维度全部匹配才算「库里有」→ return false；其余一切 → return true。
//   * 宿主硬超时 3s（墙钟，含 await）；库查询软预算 2500ms 只在两次请求之间检查，挡不住已经
//     发出的请求——在途请求拖过 3s 时宿主已 fail-open 放行，迟到的结果只写缓存、计 late、打一条 warn。
//   * tmdb_id 缺失 → 无法精确查库 → 放行。
//
// === 0.4.2 性能与缓存架构 ===
//   * 查库缓存改为纯内存、按后端独立按季（电影按条）存储逐集副本明细，按估算字节数 LRU 淘汰
//     （默认 10MB，上限 256MB，由 cache_max_mb 控制）；彻底移除 should_download 热路径上的同步 DB 读/写。
//   * 区分正/负缓存 TTL：命中匹配走 cache_ttl_sec（默认 3600s）；缺集或规格不匹配走短 TTL
//     （min(cache_ttl_sec, 60s)），防 RSS 同波并发击穿的同时 1 分钟内感知新入库/洗版。
//   * 双后端（Emby + Plex）缓存与在途请求相互独立：查缓存阶段两端对称，冷查时并行发出，
//     任意一端先 100% 确认否决即刻返回，不被慢/故障的另一端拖累；单端成功结果照常写各自缓存。
//   * 单集与合集共享整剧拉取与按季缓存：一次查剧覆盖该剧在该后端返回的所有季并清理已消失的旧季；
//     内存缓存 tmdbID → Emby seriesID / Plex showKey（404/400 或 200 空列表自动清掉重查），
//     并按后端+同剧/同片做 in-flight Promise 并发复用。
//   * 全局与 per-flow 配置常驻内存（UI 保存触发 /flows 等接口实时刷新 + 30s 定时兜底），
//     统计计数器与 last_error 在内存累加并延迟分步落盘；升级时分步清理旧版遗留的 lib_cache_*。
//
// === 7 个比对维度 ===
//   resolution(==/>=)  video_encode(==/regex)  audio_encode(==/regex)
//   code_bits(==/>=)   hdr(==)  dv(==)  format(==/regex)
//
// === 全局配置 key ===
//   emby_enabled / emby_url / emby_api_key
//   plex_enabled / plex_url / plex_token
//   cache_ttl_sec / cache_max_mb / dry_run
//   （插件自己写的：计数器、emby_/plex_last_error[_at]、cache_gen）
//
// === per-flow 配置 key ===
//   flow_<id>_enabled   "1" 启用本 flow 否决
//   flow_<id>_dims      维度+操作符 JSON，例：
//                       {"resolution":{"op":">="},"video_encode":{"op":"regex","pattern":"hevc|h265|x265"}}
//                       键缺失/损坏 → 放行；空 {} → 放行（无维度可比）

// ====== 常量与工具 ======

var CACHE_PREFIX = "lib_cache_";
var DEFAULT_CACHE_TTL_SEC = 3600;
// 缺集 / 规格不匹配时的短缓存 TTL（秒）：防同波 RSS 多站并发重复查库，同时 1 分钟内感知新入库
var NEGATIVE_CACHE_TTL_SEC = 60;
// 默认纯内存缓存上限（MB），由 cache_max_mb 配置覆盖；<= 0 关闭缓存，硬上限 256 MB 防误配吃爆进程内存
var DEFAULT_CACHE_MAX_MB = 10;
var MAX_CACHE_MAX_MB = 256;
var BYTES_PER_MB = 1024 * 1024;
// tmdbID → seriesID / showKey 内存映射上限（条）
var SERIES_ID_CACHE_MAX = 1000;
// 缓存代号：0.4.2 起改为纯内存缓存；启动时发现不是 "3" 则清理旧版留在 plugin_configs 的 lib_cache_*
var CACHE_GEN_KEY = "cache_gen";
var CACHE_GEN = "3";
// 启动时同步清理旧缓存键上限：先立刻腾出少量配额防 500 键写满，其余交后台定时器分步删（避开 10s 启动超时）
var LEGACY_CLEANUP_SYNC_LIMIT = 10;
var LEGACY_CLEANUP_STEP_DELAY_MS = 50;
// 配置后台兜底刷新间隔（UI 保存会立刻调 /flows 实时刷新，定时器兜底绕开 UI 的底层 API 改库）
var CONFIG_REFRESH_INTERVAL_MS = 30000;
var CONFIG_REFRESH_STEP_DELAY_MS = 25;
// 计数器 / last_error 延迟落盘参数
var STATS_FLUSH_DELAY_MS = 15000;
var STATS_FLUSH_STEP_DELAY_MS = 50;

var LIB_CHECK_SOFT_BUDGET_MS = 2500;
// 镜像宿主 should_download 超时（3s 墙钟，含 await）：过了这个点宿主已 fail-open 放行、
// 结果被丢弃，迟到的续体只写缓存 + 计 late + 打一条不带裁决的 warn，不记决策日志、不动其它计数
var HOST_FILTER_TIMEOUT_MS = 3000;

var MATCH_DIMS = ["resolution", "video_encode", "audio_encode", "code_bits", "hdr", "dv", "format"];

var MATCH_OPS = {
    resolution: ["==", ">="],
    video_encode: ["==", "regex"],
    audio_encode: ["==", "regex"],
    code_bits: ["==", ">="],
    hdr: ["=="],
    dv: ["=="],
    format: ["==", "regex"]
};

var GLOBAL_CONFIG_KEYS = [
    "emby_enabled", "emby_url", "emby_api_key",
    "plex_enabled", "plex_url", "plex_token",
    "cache_ttl_sec", "cache_max_mb", "dry_run"
];

var BACKEND_CACHE_AFFECTING_KEYS = [
    "emby_enabled", "emby_url", "emby_api_key",
    "plex_enabled", "plex_url", "plex_token"
];

var COUNTER_KEYS = [
    "should_download_seen",
    "vetoed",
    "allowed_not_in_lib",
    "allowed_no_tmdb",
    "allowed_no_match",
    "allowed_no_dims",
    "allowed_tag_empty",
    "allowed_error",
    "dry_run_would_veto",
    "batch_partial_filtered",
    "late"
];

var ERROR_KEYS = [
    "emby_last_error", "emby_last_error_at",
    "plex_last_error", "plex_last_error_at"
];

var cache_write_fail = 0;

function nowMs() { return new Date().getTime(); }
function nowSec() { return Math.floor(nowMs() / 1000); }

function safeNum(s, def) {
    if (s === null || s === undefined || s === "") return def;
    var n = parseInt(s, 10);
    return isNaN(n) ? def : n;
}

function safeFloat(s, def) {
    if (s === null || s === undefined || s === "") return def;
    var n = parseFloat(String(s));
    if (isNaN(n) || !isFinite(n)) return def;
    return n;
}

function nonEmpty(v) { return typeof v === "string" && v.length > 0; }

function trim(s) {
    return String(s == null ? "" : s).replace(/^\s+|\s+$/g, "");
}

function safeJsonParse(raw, fallback) {
    if (raw === null || raw === undefined || raw === "") return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
}

function qs(params) {
    var parts = [];
    for (var k in params) {
        if (!params.hasOwnProperty(k)) continue;
        var v = params[k];
        if (v === undefined || v === null) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
    return parts.join("&");
}

function joinUrl(base, pathSeg) {
    var b = String(base || "").replace(/\/+$/, "");
    var p = String(pathSeg || "");
    if (p && p.charAt(0) !== "/") p = "/" + p;
    return b + p;
}

// ====== 内存配置快照与计数器延迟落盘 ======

var cfgSnapshot = {};
var parsedFlowConfigs = {};
var cfgLoaded = false;
var configRefreshTimer = null;
var stagedRefreshTimer = null;
var stagedRefreshEpoch = 0;

var memCounters = {};
var memErrors = {};
var dirtyStats = {};
var statsFlushTimer = null;

function cfgGet(key) {
    if (Object.prototype.hasOwnProperty.call(cfgSnapshot, key)) {
        return cfgSnapshot[key];
    }
    return null;
}

function isEnabled(key) { return cfgGet(key) === "1"; }

function cacheTtlSec() {
    return safeNum(cfgGet("cache_ttl_sec"), DEFAULT_CACHE_TTL_SEC);
}

function cacheMaxMb() {
    var raw = cfgGet("cache_max_mb");
    if (raw === null || raw === undefined || trim(String(raw)) === "") {
        return DEFAULT_CACHE_MAX_MB;
    }
    var n = safeFloat(raw, DEFAULT_CACHE_MAX_MB);
    if (n < 0) return DEFAULT_CACHE_MAX_MB;
    if (n > MAX_CACHE_MAX_MB) return MAX_CACHE_MAX_MB;
    return n;
}

function cacheMaxBytes() {
    var mb = cacheMaxMb();
    if (mb <= 0) return 0;
    return Math.floor(mb * BYTES_PER_MB);
}

function effectiveNegativeTtlSec(ttl) {
    if (ttl <= 0) return 0;
    return ttl < NEGATIVE_CACHE_TTL_SEC ? ttl : NEGATIVE_CACHE_TTL_SEC;
}

function buildParsedFlowConfig(enabledRaw, dimsRaw) {
    var enabled = enabledRaw === "1";
    if (dimsRaw === null || dimsRaw === undefined || dimsRaw === "") {
        return { enabled: enabled, dims: null };
    }
    var parsed = safeJsonParse(dimsRaw, null);
    if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
        return { enabled: enabled, dims: null };
    }
    var clean = sanitizeDims(parsed);
    if (dimCount(clean) === 0) {
        return { enabled: enabled, dims: null };
    }
    return { enabled: enabled, dims: clean };
}

function flowConfig(flowID) {
    var id = String(flowID == null ? "" : flowID);
    if (Object.prototype.hasOwnProperty.call(parsedFlowConfigs, id)) {
        return parsedFlowConfigs[id];
    }
    return { enabled: false, dims: null };
}

function parseFlowKeyName(k) {
    if (k.indexOf("flow_") !== 0) return null;
    if (k.length > 13 && k.slice(-8) === "_enabled") {
        return { id: k.slice(5, -8), field: "enabled" };
    }
    if (k.length > 10 && k.slice(-5) === "_dims") {
        return { id: k.slice(5, -5), field: "dims" };
    }
    return null;
}

function applyConfigSnapshot(next, flowIDs) {
    var prev = cfgSnapshot;
    var hadPrev = cfgLoaded;

    var nextFlows = {};
    for (var fid in flowIDs) {
        if (!Object.prototype.hasOwnProperty.call(flowIDs, fid)) continue;
        var enKey = "flow_" + fid + "_enabled";
        var dmKey = "flow_" + fid + "_dims";
        nextFlows[fid] = buildParsedFlowConfig(
            Object.prototype.hasOwnProperty.call(next, enKey) ? next[enKey] : null,
            Object.prototype.hasOwnProperty.call(next, dmKey) ? next[dmKey] : null
        );
    }

    cfgSnapshot = next;
    parsedFlowConfigs = nextFlows;
    cfgLoaded = true;

    if (hadPrev) {
        var backendChanged = false;
        for (var b = 0; b < BACKEND_CACHE_AFFECTING_KEYS.length; b++) {
            var bk = BACKEND_CACHE_AFFECTING_KEYS[b];
            var oldV = Object.prototype.hasOwnProperty.call(prev, bk) ? prev[bk] : null;
            var newV = Object.prototype.hasOwnProperty.call(next, bk) ? next[bk] : null;
            if (oldV !== newV) { backendChanged = true; break; }
        }
        var ttl = cacheTtlSec();
        var maxBytes = cacheMaxBytes();
        if (backendChanged || ttl <= 0 || maxBytes <= 0) {
            clearAllCaches();
        } else if (memCacheBytes > maxBytes) {
            evictMemCache(nowSec(), ttl, maxBytes, null);
        }
    } else {
        if (cacheTtlSec() <= 0 || cacheMaxBytes() <= 0) {
            clearAllCaches();
        }
    }
}

function collectConfigKeysToRead() {
    var keys = GLOBAL_CONFIG_KEYS.slice();
    var flowIDs = {};
    var allKeys = [];
    try { allKeys = config.list() || []; } catch (e) { allKeys = []; }
    for (var j = 0; j < allKeys.length; j++) {
        var fk = String(allKeys[j]);
        var parsedKey = parseFlowKeyName(fk);
        if (!parsedKey || !parsedKey.id) continue;
        flowIDs[parsedKey.id] = true;
        keys.push(fk);
    }
    return { keys: keys, flowIDs: flowIDs };
}

function cancelStagedConfigRefresh() {
    stagedRefreshEpoch++;
    if (stagedRefreshTimer !== null && typeof clearTimeout === "function") {
        clearTimeout(stagedRefreshTimer);
    }
    stagedRefreshTimer = null;
}

// 从宿主存储同步重读全局与 per-flow 配置到内存（用于启动、/flows、/save-config 等即时刷新入口）
function reloadConfig() {
    cancelStagedConfigRefresh();
    var plan = collectConfigKeysToRead();
    var next = {};
    for (var i = 0; i < plan.keys.length; i++) {
        var k = plan.keys[i];
        var v = config.get(k);
        if (v !== null && v !== undefined) next[k] = String(v);
    }
    applyConfigSnapshot(next, plan.flowIDs);
}

function reloadConfigSafe() {
    try { reloadConfig(); } catch (e) { log.warn("media-library-filter: config refresh failed: " + e); }
}

// 后台定时兜底刷新：分步每次只读 1 个 key，避免在慢库上阻塞单个事件循环回合
function startStagedConfigRefresh() {
    if (stagedRefreshTimer !== null) return;
    if (typeof setTimeout !== "function") {
        reloadConfigSafe();
        return;
    }
    var plan;
    try { plan = collectConfigKeysToRead(); }
    catch (e) { log.warn("media-library-filter: background config list failed: " + e); return; }

    var epoch = ++stagedRefreshEpoch;
    var next = {};
    var idx = 0;
    function step() {
        stagedRefreshTimer = null;
        if (epoch !== stagedRefreshEpoch) return;
        if (idx >= plan.keys.length) {
            try { applyConfigSnapshot(next, plan.flowIDs); }
            catch (e) { log.warn("media-library-filter: background config apply failed: " + e); }
            return;
        }
        var k = plan.keys[idx++];
        try {
            var v = config.get(k);
            if (v !== null && v !== undefined) next[k] = String(v);
        } catch (e) {
            log.warn("media-library-filter: background config read failed for " + k + ": " + e);
            return;
        }
        stagedRefreshTimer = setTimeout(step, CONFIG_REFRESH_STEP_DELAY_MS);
    }
    stagedRefreshTimer = setTimeout(step, CONFIG_REFRESH_STEP_DELAY_MS);
}

function startConfigRefreshTimer() {
    if (configRefreshTimer !== null || typeof setInterval !== "function") return;
    configRefreshTimer = setInterval(startStagedConfigRefresh, CONFIG_REFRESH_INTERVAL_MS);
}

function loadStatsFromStore() {
    for (var i = 0; i < COUNTER_KEYS.length; i++) {
        var ck = COUNTER_KEYS[i];
        memCounters[ck] = safeNum(config.get(ck), 0);
    }
    for (var j = 0; j < ERROR_KEYS.length; j++) {
        var ek = ERROR_KEYS[j];
        var ev = config.get(ek);
        memErrors[ek] = ev == null ? "" : String(ev);
    }
}

function scheduleStatsFlush(delayMs) {
    if (statsFlushTimer !== null || typeof setTimeout !== "function") return;
    statsFlushTimer = setTimeout(flushStatsStep, delayMs === undefined ? STATS_FLUSH_DELAY_MS : delayMs);
}

// 每次只刷一个脏计数/错误键，避免在单个事件循环回合连续执行多次同步 DB 写事务
function flushStatsStep() {
    statsFlushTimer = null;
    var keys = Object.keys(dirtyStats);
    if (keys.length === 0) return;
    var key = keys[0];
    var val = dirtyStats[key];
    delete dirtyStats[key];
    try {
        config.set(key, val);
    } catch (e) {
        log.warn("media-library-filter: stats flush failed for " + key + ": " + e);
    }
    if (Object.keys(dirtyStats).length > 0) {
        scheduleStatsFlush(STATS_FLUSH_STEP_DELAY_MS);
    }
}

function incCounter(key) {
    var n = (memCounters[key] || 0) + 1;
    memCounters[key] = n;
    dirtyStats[key] = String(n);
    scheduleStatsFlush();
}

function rememberError(scope, err) {
    var errStr = String(err == null ? "" : err);
    var errAt = new Date().toISOString();
    memErrors[scope + "_last_error"] = errStr;
    memErrors[scope + "_last_error_at"] = errAt;
    dirtyStats[scope + "_last_error"] = errStr;
    dirtyStats[scope + "_last_error_at"] = errAt;
    scheduleStatsFlush();
}

// ====== 比对工具（纯函数） ======

function pixelHeight(width, height) {
    var h = safeNum(String(height || ""), 0);
    if (h > 0) return h;
    var w = safeNum(String(width || ""), 0);
    if (w > 0) return Math.round(w * 9 / 16);
    return 0;
}

function resolutionBucket(height) {
    var h = safeNum(String(height == null ? "" : height), 0);
    if (h >= 1800) return "2160p";
    if (h >= 900) return "1080p";
    if (h >= 600) return "720p";
    return null;
}

function resolutionBucketOrder(bucket) {
    if (bucket === "2160p") return 3;
    if (bucket === "1080p") return 2;
    if (bucket === "720p") return 1;
    return 0;
}

// tag 端分辨率归一：已知 bucket 直接用；纯数字走 resolutionBucket；其余 null
function normalizeTagResolution(v) {
    if (v === null || v === undefined) return null;
    var s = trim(String(v)).toLowerCase();
    if (s === "4k") return "2160p";
    if (s === "2160p" || s === "1080p" || s === "720p") return s;
    var n = safeNum(s.replace(/p$/i, ""), -1);
    if (n > 0) return resolutionBucket(n);
    return null;
}

function rangeFlags(videoRange) {
    var v = String(videoRange || "").toLowerCase();
    var isDV = v.indexOf("dolby") >= 0 || v.indexOf("dovi") >= 0 || v.indexOf("dv") >= 0;
    var isHDR = isDV || v.indexOf("hdr") >= 0;
    return { hdr: isHDR, dv: isDV };
}

function pathBasename(p) {
    return String(p == null ? "" : p).replace(/^.*[\/\\]/, "") || "";
}

function strEq(observed, want) {
    if (observed === null || observed === undefined) return false;
    if (want === null || want === undefined) return false;
    return trim(String(observed)).toLowerCase() === trim(String(want)).toLowerCase();
}

// hdr / dv 的 tag 端归一成布尔。宿主给的是字符串（mediatag 识别原文如 "HDR"、种子字典值如
// "HDR10" / "HDR10+" / "HLG" / "HDR Vivid" / "SDR" / "DolbyVision"；没识别到填 "无"），也兼容布尔。
// 空 / "无" / none / no / false / 0 / sdr（大小写不敏感）= 否，其余非空值 = 是。
var TAG_FALSE_WORDS = { "": 1, "无": 1, "none": 1, "no": 1, "false": 1, "0": 1, "sdr": 1 };
function tagBool(v) {
    if (v === true) return true;
    if (v === false) return false;
    var s = trim(String(v == null ? "" : v)).toLowerCase();
    return !TAG_FALSE_WORDS.hasOwnProperty(s);
}

// tag 值是否「有值」（null/undefined/"" 算空；boolean false、hdr/dv 的 "无" 都是有效值「否」）
function tagHasValue(v) {
    return v !== null && v !== undefined && v !== "";
}

// 取种子端某维度参与比对的值。hdr 与库端一致：种子 dv 为「是」时 hdr 也算「是」（杜比视界就是一种 HDR；
// 库端 rangeFlags / plexItemCopies 同样把 DV 副本记成 hdr=true）
function tagDimValue(tags, dim) {
    if (!tags || typeof tags !== "object") return undefined;
    if (dim === "hdr" && tagHasValue(tags.dv) && tagBool(tags.dv)) return true;
    return tags[dim];
}

// 从 copy 对象取某维度对应的库端观测值
function copyDimValue(copy, dim) {
    if (dim === "resolution") return copy.height;
    if (dim === "video_encode") return copy.video_codec;
    if (dim === "audio_encode") return copy.audio_codec;
    if (dim === "code_bits") return copy.bit_depth;
    if (dim === "hdr") return copy.hdr;
    if (dim === "dv") return copy.dv;
    if (dim === "format") return copy.format;
    return undefined;
}

// 单维度比对：tag 值 vs 库端观测值，按操作符判定
function dimMatch(dim, op, tagValue, libValue, pattern) {
    if (!tagHasValue(tagValue)) return false;
    if (libValue === null || libValue === undefined) return false;

    if (op === "regex") {
        if (!pattern || typeof pattern !== "string") return false;
        if (pattern.length > 200) return false;
        try {
            var re = new RegExp(pattern, "i");
            return re.test(String(tagValue)) && re.test(String(libValue));
        } catch (e) {
            log.warn("media-library-filter: invalid regex: " + e);
            return false;
        }
    }

    if (dim === "resolution") {
        var tagBucket = normalizeTagResolution(tagValue);
        var libBucket = resolutionBucket(libValue);
        if (!tagBucket || !libBucket) return false;
        if (op === ">=") return resolutionBucketOrder(libBucket) >= resolutionBucketOrder(tagBucket);
        return libBucket === tagBucket;
    }

    if (dim === "hdr" || dim === "dv") {
        return !!libValue === tagBool(tagValue);
    }

    if (dim === "code_bits") {
        var tagBits = safeNum(String(tagValue).replace(/[^0-9]/g, ""), -1);
        var libBits = safeNum(String(libValue == null ? "" : libValue), -1);
        if (tagBits < 0 || libBits < 0) return false;
        if (op === ">=") return libBits >= tagBits;
        return libBits === tagBits;
    }

    return strEq(libValue, tagValue);
}

// 单副本：全部已配维度都匹配 → true
function copyMatchesTags(copy, tags, dims) {
    if (!copy || typeof copy !== "object") return false;
    if (!tags || typeof tags !== "object") return false;
    if (!dims || typeof dims !== "object") return false;
    for (var dim in dims) {
        if (!dims.hasOwnProperty(dim)) continue;
        var cfg = dims[dim];
        if (!cfg || typeof cfg !== "object") continue;
        var op = cfg.op || "==";
        var tagValue = tagDimValue(tags, dim);
        var libValue = copyDimValue(copy, dim);
        if (!dimMatch(dim, op, tagValue, libValue, cfg.pattern)) return false;
    }
    return true;
}

// 多副本：任一副本全维度匹配 → true
function anyCopyMatchesTags(copies, tags, dims) {
    if (!isArray(copies) || copies.length === 0) return false;
    for (var i = 0; i < copies.length; i++) {
        if (copyMatchesTags(copies[i], tags, dims)) return true;
    }
    return false;
}

// dims 对象中有效维度数
function dimCount(dims) {
    var n = 0;
    if (dims && typeof dims === "object") {
        for (var k in dims) {
            if (dims.hasOwnProperty(k) && dims[k] && typeof dims[k] === "object") n++;
        }
    }
    return n;
}

// ====== 纯内存按季 / 电影 LRU 缓存（按字节上限淘汰） ======

var memCache = {};
var memCacheBytes = 0;
var memCacheCount = 0;
var memCacheSeq = 0;
var cacheEpoch = 0;

// tmdbID → seriesID / showKey 内存缓存
var seriesIdCache = {};
var seriesIdCount = 0;
var seriesIdSeq = 0;

// 同剧/同片在途请求去重表：key → Promise
var inFlight = {};

function seasonCacheKey(backend, tmdbID, season) {
    return backend + ":tv:" + String(tmdbID) + ":s" + String(season || 0);
}

function movieCacheKey(backend, tmdbID) {
    return backend + ":movie:" + String(tmdbID);
}

function seriesFlightKey(backend, tmdbID) {
    return backend + ":tv:" + String(tmdbID);
}

function movieFlightKey(backend, tmdbID) {
    return backend + ":movie:" + String(tmdbID);
}

function seriesIdCacheKey(backend, tmdbID) {
    return backend + ":" + String(tmdbID);
}

function hasAnyEpisode(epMap) {
    if (!epMap || typeof epMap !== "object") return false;
    for (var k in epMap) {
        if (Object.prototype.hasOwnProperty.call(epMap, k)) return true;
    }
    return false;
}

// 整剧刷新成功时对账该剧在该后端的旧季缓存：
// - 返回里已有的季随后会被新数据覆盖；
// - 返回里消失且原本非空的旧季（如库里删了整季）立即删除，避免残留误拦截；
// - 原本就是空的未过期短缓存季（episodes={}），借本次整剧结果把 ts 续期，60s 内免重复查库。
function reconcileBackendSeriesSeasons(backend, tmdbID, freshSeasons, ts, ttl) {
    var prefix = backend + ":tv:" + String(tmdbID) + ":s";
    var toDel = [];
    for (var k in memCache) {
        if (!Object.prototype.hasOwnProperty.call(memCache, k) || k.indexOf(prefix) !== 0) continue;
        var sKey = k.slice(prefix.length);
        if (freshSeasons && Object.prototype.hasOwnProperty.call(freshSeasons, sKey)) continue;
        var entry = memCache[k];
        if (entry && !hasAnyEpisode(entry.episodes) && (ts - entry.ts) < ttl) {
            entry.ts = ts;
            entry.lastAccess = ++memCacheSeq;
        } else {
            toDel.push(k);
        }
    }
    for (var i = 0; i < toDel.length; i++) {
        deleteMemCacheKey(toDel[i]);
    }
}

function estimateEntryBytes(key, payload) {
    var rawLen = 0;
    try { rawLen = JSON.stringify(payload).length; } catch (e) { rawLen = 512; }
    // UTF-16 字符串 + JS 对象头估算（×2 + 固定开销）
    return 128 + key.length * 2 + rawLen * 2;
}

function deleteMemCacheKey(key) {
    if (!Object.prototype.hasOwnProperty.call(memCache, key)) return;
    memCacheBytes -= memCache[key].bytes || 0;
    if (memCacheBytes < 0) memCacheBytes = 0;
    delete memCache[key];
    memCacheCount--;
    if (memCacheCount < 0) memCacheCount = 0;
}

function evictMemCache(nowS, ttl, maxBytes, keepKey) {
    var k;
    // 第一轮：先清掉所有已过期的条目
    for (k in memCache) {
        if (!Object.prototype.hasOwnProperty.call(memCache, k) || k === keepKey) continue;
        if (ttl <= 0 || (nowS - memCache[k].ts) >= ttl) {
            deleteMemCacheKey(k);
        }
    }
    if (memCacheBytes <= maxBytes) return;

    // 第二轮：仍超容量则按 LRU（lastAccess 升序）淘汰
    var keys = [];
    for (k in memCache) {
        if (Object.prototype.hasOwnProperty.call(memCache, k) && k !== keepKey) {
            keys.push(k);
        }
    }
    keys.sort(function (a, b) {
        return (memCache[a].lastAccess || 0) - (memCache[b].lastAccess || 0);
    });
    for (var i = 0; i < keys.length && memCacheBytes > maxBytes; i++) {
        deleteMemCacheKey(keys[i]);
    }
}

function getMemCache(key, ttl) {
    if (!nonEmpty(key) || ttl <= 0 || cacheMaxBytes() <= 0) return null;
    if (!Object.prototype.hasOwnProperty.call(memCache, key)) return null;
    var entry = memCache[key];
    if ((nowSec() - entry.ts) >= ttl) {
        deleteMemCacheKey(key);
        return null;
    }
    entry.lastAccess = ++memCacheSeq;
    return entry;
}

function putMemCache(key, data, ttl) {
    if (!nonEmpty(key)) return;
    var maxBytes = cacheMaxBytes();
    if (ttl <= 0 || maxBytes <= 0) {
        return;
    }
    var bytes = estimateEntryBytes(key, data);
    if (bytes > maxBytes) {
        // 单条本身超出上限：不写入，若原有旧条目一并删掉
        deleteMemCacheKey(key);
        return;
    }
    deleteMemCacheKey(key);
    var entry = {
        kind: data.kind,
        ts: data.ts,
        source: data.source || "",
        bytes: bytes,
        lastAccess: ++memCacheSeq
    };
    if (data.kind === "movie") {
        entry.copies = data.copies || [];
    } else {
        entry.episodes = data.episodes || {};
    }
    memCache[key] = entry;
    memCacheBytes += bytes;
    memCacheCount++;
    if (memCacheBytes > maxBytes) {
        evictMemCache(nowSec(), ttl, maxBytes, key);
    }
}

function getSeriesIdCache(backend, tmdbID, ttl) {
    if (ttl <= 0 || cacheMaxBytes() <= 0) return "";
    var k = seriesIdCacheKey(backend, tmdbID);
    if (!Object.prototype.hasOwnProperty.call(seriesIdCache, k)) return "";
    var entry = seriesIdCache[k];
    if ((nowSec() - entry.ts) >= ttl) {
        delete seriesIdCache[k];
        seriesIdCount--;
        if (seriesIdCount < 0) seriesIdCount = 0;
        return "";
    }
    entry.lastAccess = ++seriesIdSeq;
    return entry.id;
}

function putSeriesIdCache(backend, tmdbID, id, ttl) {
    if (!nonEmpty(String(id || "")) || ttl <= 0 || cacheMaxBytes() <= 0) return;
    var k = seriesIdCacheKey(backend, tmdbID);
    if (!Object.prototype.hasOwnProperty.call(seriesIdCache, k)) {
        seriesIdCount++;
    }
    seriesIdCache[k] = {
        id: String(id),
        ts: nowSec(),
        lastAccess: ++seriesIdSeq
    };
    if (seriesIdCount > SERIES_ID_CACHE_MAX) {
        var keys = Object.keys(seriesIdCache);
        keys.sort(function (a, b) {
            return (seriesIdCache[a].lastAccess || 0) - (seriesIdCache[b].lastAccess || 0);
        });
        for (var i = 0; i < keys.length && seriesIdCount > SERIES_ID_CACHE_MAX; i++) {
            delete seriesIdCache[keys[i]];
            seriesIdCount--;
        }
    }
}

function deleteSeriesIdCache(backend, tmdbID) {
    var k = seriesIdCacheKey(backend, tmdbID);
    if (!Object.prototype.hasOwnProperty.call(seriesIdCache, k)) return;
    delete seriesIdCache[k];
    seriesIdCount--;
    if (seriesIdCount < 0) seriesIdCount = 0;
}

function clearAllCaches() {
    var stats = {
        cleared_entries: memCacheCount,
        cleared_bytes: memCacheBytes,
        cleared_series_ids: seriesIdCount
    };
    memCache = {};
    memCacheBytes = 0;
    memCacheCount = 0;
    seriesIdCache = {};
    seriesIdCount = 0;
    inFlight = {};
    cacheEpoch++;
    return stats;
}

// ====== 旧版本数据库缓存清理（升级自 <= 0.4.1 时释放 plugin_configs 配额） ======

var legacyCleanupQueue = [];
var legacyCleanupTotalRemoved = 0;
var legacyCleanupTimer = null;

function canDeleteConfig() {
    return typeof config === "object" && config !== null && typeof config["delete"] === "function";
}

function finishLegacyCleanup() {
    try { config.set(CACHE_GEN_KEY, CACHE_GEN); } catch (e) {
        log.warn("media-library-filter: failed to write cache_gen: " + e);
    }
    if (legacyCleanupTotalRemoved > 0) {
        log.info("media-library-filter: removed " + legacyCleanupTotalRemoved + " legacy cache keys from config store");
    }
}

function stepLegacyCleanup() {
    legacyCleanupTimer = null;
    if (legacyCleanupQueue.length === 0) {
        finishLegacyCleanup();
        return;
    }
    var k = legacyCleanupQueue.shift();
    try {
        if (config["delete"](k)) legacyCleanupTotalRemoved++;
    } catch (e) {
        log.warn("media-library-filter: legacy cache delete failed: " + e);
    }
    if (legacyCleanupQueue.length > 0) {
        legacyCleanupTimer = setTimeout(stepLegacyCleanup, LEGACY_CLEANUP_STEP_DELAY_MS);
    } else {
        finishLegacyCleanup();
    }
}

function initLegacyCacheCleanup() {
    if (!canDeleteConfig()) return;
    if (config.get(CACHE_GEN_KEY) === CACHE_GEN) return;
    var allKeys = [];
    try { allKeys = config.list() || []; } catch (e) { allKeys = []; }
    var legacyKeys = [];
    for (var i = 0; i < allKeys.length; i++) {
        var k = String(allKeys[i]);
        if (k.indexOf(CACHE_PREFIX) === 0) legacyKeys.push(k);
    }
    if (legacyKeys.length === 0) {
        finishLegacyCleanup();
        return;
    }
    // 启动时最多同步删少量键以立刻腾出配额，其余交后台分步删，避免慢库下撞上 10s 入口超时
    var syncLimit = typeof setTimeout === "function" ? LEGACY_CLEANUP_SYNC_LIMIT : legacyKeys.length;
    var syncCount = legacyKeys.length < syncLimit ? legacyKeys.length : syncLimit;
    for (var s = 0; s < syncCount; s++) {
        try {
            if (config["delete"](legacyKeys[s])) legacyCleanupTotalRemoved++;
        } catch (e) {
            log.warn("media-library-filter: legacy cache delete failed: " + e);
        }
    }
    if (syncCount >= legacyKeys.length) {
        finishLegacyCleanup();
        return;
    }
    legacyCleanupQueue = legacyKeys.slice(syncCount);
    legacyCleanupTimer = setTimeout(stepLegacyCleanup, LEGACY_CLEANUP_STEP_DELAY_MS);
}

// ====== Emby 查询 ======

async function embyGet(url) {
    try {
        var resp = await http.get(url, { "Accept": "application/json" });
        if (!resp || typeof resp.status !== "number") {
            return { ok: false, reason: "malformed_response" };
        }
        if (resp.status < 200 || resp.status >= 300) {
            rememberError("emby", "status=" + resp.status);
            return { ok: false, reason: "status_" + resp.status, status: resp.status };
        }
        return { ok: true, body: safeJsonParse(resp.body, null) };
    } catch (e) {
        rememberError("emby", e);
        return { ok: false, reason: "http_error", error: String(e) };
    }
}

function embyItemCopies(item) {
    var copies = [];
    var sources = (item && item.MediaSources) || [];
    var itemPath = (item && item.Path) || "";
    for (var i = 0; i < sources.length; i++) {
        var src = sources[i] || {};
        var streams = src.MediaStreams || [];
        var height = 0;
        var hdr = false;
        var dv = false;
        var videoCodec = null;
        var bitDepth = null;
        var audioCodec = null;
        for (var j = 0; j < streams.length; j++) {
            var st = streams[j] || {};
            if (st.Type === "Video") {
                var h = pixelHeight(st.Width, st.Height);
                var flags = rangeFlags(st.VideoRange || st.VideoRangeType);
                if (h > height) {
                    height = h;
                    videoCodec = st.Codec ? String(st.Codec) : videoCodec;
                    bitDepth = (typeof st.BitDepth === "number") ? st.BitDepth : safeNum(String(st.BitDepth || ""), -1);
                    if (bitDepth < 0) bitDepth = null;
                }
                if (flags.hdr) hdr = true;
                if (flags.dv) dv = true;
                if (videoCodec === null && st.Codec) videoCodec = String(st.Codec);
            } else if (st.Type === "Audio") {
                if (audioCodec === null && st.Codec) audioCodec = String(st.Codec);
            }
        }
        copies.push({
            height: height,
            hdr: hdr,
            dv: dv,
            video_codec: videoCodec,
            audio_codec: audioCodec,
            bit_depth: bitDepth,
            format: src.Container ? String(src.Container) : null,
            filename: pathBasename(src.Path || itemPath)
        });
    }
    return copies;
}

async function fetchEmbyMovie(tmdbID, deadlineMs) {
    var url = cfgGet("emby_url");
    var key = cfgGet("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, hit: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    var movieUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        IncludeItemTypes: "Movie",
        AnyProviderIdEquals: "tmdb." + tmdbID,
        Fields: "ProviderIds,MediaSources,Path",
        Limit: 5
    });
    var mr = await embyGet(movieUrl);
    if (!mr.ok) return { ok: false, hit: false, reason: mr.reason };
    var mItems = (mr.body && mr.body.Items) || [];
    for (var mi = 0; mi < mItems.length; mi++) {
        var mItem = mItems[mi] || {};
        var pid = mItem.ProviderIds || {};
        if (String(pid.Tmdb || pid.tmdb || "") === String(tmdbID)) {
            return { ok: true, hit: true, source: "emby", copies: embyItemCopies(mItem) };
        }
    }
    return { ok: true, hit: false, source: "emby", copies: [], reason: "movie_not_found" };
}

// 拉取 Emby 整部剧的所有季分集（使用已验证接口），并复用 tmdbID → seriesID 缓存；
// 若缓存的 seriesID 失效（404/400 或返回 200 空列表），自动清理并重查一次；仅在查到至少 1 集时写回 ID 缓存。
async function fetchEmbySeriesSeasons(tmdbID, deadlineMs, allowCache, skipReadIdCache, cacheEpochAtStart) {
    var url = cfgGet("emby_url");
    var key = cfgGet("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, found: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, found: false, reason: "deadline" };

    var ttl = cacheTtlSec();
    var seriesID = (allowCache && !skipReadIdCache) ? getSeriesIdCache("emby", tmdbID, ttl) : "";
    var usedCachedId = nonEmpty(seriesID);

    if (!usedCachedId) {
        var seriesUrl = joinUrl(url, "/emby/Items") + "?" + qs({
            api_key: key,
            Recursive: "true",
            IncludeItemTypes: "Series",
            AnyProviderIdEquals: "tmdb." + tmdbID,
            Fields: "ProviderIds",
            Limit: 5
        });
        var sr = await embyGet(seriesUrl);
        if (!sr.ok) return { ok: false, found: false, reason: sr.reason };
        var sItems = (sr.body && sr.body.Items) || [];
        for (var si = 0; si < sItems.length; si++) {
            var sItem = sItems[si] || {};
            var spid = sItem.ProviderIds || {};
            if (String(spid.Tmdb || spid.tmdb || "") === String(tmdbID)) {
                seriesID = String(sItem.Id || sItem.ID || "");
                break;
            }
        }
        if (!nonEmpty(seriesID)) {
            return { ok: true, found: false, source: "emby", seasons: {}, reason: "series_not_found" };
        }
        if (deadlineMs && nowMs() > deadlineMs) return { ok: false, found: false, reason: "deadline" };
    }

    var epUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        ParentId: seriesID,
        IncludeItemTypes: "Episode",
        Fields: "MediaSources,ParentIndexNumber,IndexNumber,Path",
        Limit: 2000
    });
    var er = await embyGet(epUrl);
    if (!er.ok) {
        if (usedCachedId && (er.status === 404 || er.status === 400)) {
            deleteSeriesIdCache("emby", tmdbID);
            if (!deadlineMs || nowMs() <= deadlineMs) {
                return await fetchEmbySeriesSeasons(tmdbID, deadlineMs, allowCache, true, cacheEpochAtStart);
            }
            return { ok: false, found: false, reason: "deadline" };
        }
        return { ok: false, found: false, reason: er.reason };
    }

    var eItems = (er.body && er.body.Items) || [];
    if (usedCachedId && eItems.length === 0) {
        deleteSeriesIdCache("emby", tmdbID);
        if (!deadlineMs || nowMs() <= deadlineMs) {
            return await fetchEmbySeriesSeasons(tmdbID, deadlineMs, allowCache, true, cacheEpochAtStart);
        }
        return { ok: false, found: false, reason: "deadline" };
    }
    if (!usedCachedId && allowCache && eItems.length > 0 && cacheEpochAtStart === cacheEpoch) {
        putSeriesIdCache("emby", tmdbID, seriesID, ttl);
    }

    var seasons = {};
    for (var ei = 0; ei < eItems.length; ei++) {
        var eItem = eItems[ei] || {};
        var pSeason = safeNum(String(eItem.ParentIndexNumber), -1);
        var pEpisode = safeNum(String(eItem.IndexNumber), -1);
        if (pSeason < 0 || pEpisode <= 0) continue;
        var sKey = String(pSeason);
        var eKey = String(pEpisode);
        if (!seasons[sKey]) seasons[sKey] = {};
        if (!seasons[sKey][eKey]) seasons[sKey][eKey] = [];
        var c = embyItemCopies(eItem);
        for (var ci = 0; ci < c.length; ci++) {
            seasons[sKey][eKey].push(c[ci]);
        }
    }
    return { ok: true, found: true, source: "emby", seasons: seasons };
}

// ====== Plex 查询 ======

async function plexGet(url) {
    try {
        var resp = await http.get(url, { "Accept": "application/json" });
        if (!resp || typeof resp.status !== "number") {
            return { ok: false, reason: "malformed_response" };
        }
        if (resp.status < 200 || resp.status >= 300) {
            rememberError("plex", "status=" + resp.status);
            return { ok: false, reason: "status_" + resp.status, status: resp.status };
        }
        return { ok: true, body: safeJsonParse(resp.body, null) };
    } catch (e) {
        rememberError("plex", e);
        return { ok: false, reason: "http_error", error: String(e) };
    }
}

function plexResHeight(videoResolution) {
    var v = String(videoResolution || "").toLowerCase();
    if (v === "4k" || v === "2160") return 2160;
    if (v === "1080") return 1080;
    if (v === "720") return 720;
    if (v === "sd" || v === "480") return 480;
    return safeNum(v, 0);
}

function plexItemCopies(meta) {
    var copies = [];
    var medias = (meta && meta.Media) || [];
    for (var i = 0; i < medias.length; i++) {
        var media = medias[i] || {};
        var height = plexResHeight(media.videoResolution);
        var flags = rangeFlags(String(media.videoProfile || "") + " " + String(media.colorTrc || ""));
        var videoCodec = media.videoCodec ? String(media.videoCodec) : null;
        var audioCodec = media.audioCodec ? String(media.audioCodec) : null;
        var bitDepth = null;
        var filename = "";
        var parts = media.Part || [];
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p] || {};
            if (!filename && part.file) filename = pathBasename(part.file);
            var streams = part.Stream || [];
            for (var s = 0; s < streams.length; s++) {
                var st = streams[s] || {};
                if (st.streamType === 1 || st.streamType === "1") {
                    if (st.DOVIPresent || st.DOVIProfile) flags.dv = true;
                    var trc = rangeFlags(String(st.colorTrc || ""));
                    if (trc.hdr) flags.hdr = true;
                    if (trc.dv) flags.dv = true;
                    if (bitDepth === null && st.bitDepth) {
                        var bd = safeNum(String(st.bitDepth), -1);
                        if (bd >= 0) bitDepth = bd;
                    }
                    if (videoCodec === null && st.codec) videoCodec = String(st.codec);
                } else if (st.streamType === 2 || st.streamType === "2") {
                    if (audioCodec === null && st.codec) audioCodec = String(st.codec);
                }
            }
        }
        if (flags.dv) flags.hdr = true;
        copies.push({
            height: height,
            hdr: flags.hdr,
            dv: flags.dv,
            video_codec: videoCodec,
            audio_codec: audioCodec,
            bit_depth: bitDepth,
            format: media.container ? String(media.container) : null,
            filename: filename
        });
    }
    return copies;
}

function plexMetaTmdb(meta) {
    var guids = (meta && meta.Guid) || [];
    for (var g = 0; g < guids.length; g++) {
        var gid = String((guids[g] || {}).id || "");
        if (gid.indexOf("tmdb://") === 0) return gid.substring(7);
    }
    var single = String((meta && meta.guid) || "");
    var idx = single.indexOf("tmdb://");
    if (idx >= 0) {
        var rest = single.substring(idx + 7);
        return rest.replace(/[^0-9].*$/, "");
    }
    return "";
}

async function fetchPlexMovie(tmdbID, deadlineMs) {
    var url = cfgGet("plex_url");
    var token = cfgGet("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, hit: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    var movieUrl = joinUrl(url, "/library/all") + "?" + qs({
        "X-Plex-Token": token,
        type: 1,
        includeGuids: 1
    });
    var mr = await plexGet(movieUrl);
    if (!mr.ok) return { ok: false, hit: false, reason: mr.reason };
    var mMetas = (mr.body && mr.body.MediaContainer && mr.body.MediaContainer.Metadata) || [];
    for (var mi = 0; mi < mMetas.length; mi++) {
        if (plexMetaTmdb(mMetas[mi]) === String(tmdbID)) {
            return { ok: true, hit: true, source: "plex", copies: plexItemCopies(mMetas[mi]) };
        }
    }
    return { ok: true, hit: false, source: "plex", copies: [], reason: "movie_not_found" };
}

async function fetchPlexSeriesSeasons(tmdbID, deadlineMs, allowCache, skipReadIdCache, cacheEpochAtStart) {
    var url = cfgGet("plex_url");
    var token = cfgGet("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, found: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, found: false, reason: "deadline" };

    var ttl = cacheTtlSec();
    var showKey = (allowCache && !skipReadIdCache) ? getSeriesIdCache("plex", tmdbID, ttl) : "";
    var usedCachedId = nonEmpty(showKey);

    if (!usedCachedId) {
        var showUrl = joinUrl(url, "/library/all") + "?" + qs({
            "X-Plex-Token": token,
            type: 2,
            includeGuids: 1
        });
        var shr = await plexGet(showUrl);
        if (!shr.ok) return { ok: false, found: false, reason: shr.reason };
        var shMetas = (shr.body && shr.body.MediaContainer && shr.body.MediaContainer.Metadata) || [];
        for (var shi = 0; shi < shMetas.length; shi++) {
            if (plexMetaTmdb(shMetas[shi]) === String(tmdbID)) {
                showKey = String((shMetas[shi] || {}).ratingKey || "");
                break;
            }
        }
        if (!nonEmpty(showKey)) {
            return { ok: true, found: false, source: "plex", seasons: {}, reason: "series_not_found" };
        }
        if (deadlineMs && nowMs() > deadlineMs) return { ok: false, found: false, reason: "deadline" };
    }

    var epUrl = joinUrl(url, "/library/metadata/" + showKey + "/allLeaves") + "?" + qs({
        "X-Plex-Token": token,
        includeGuids: 1
    });
    var er = await plexGet(epUrl);
    if (!er.ok) {
        if (usedCachedId && (er.status === 404 || er.status === 400)) {
            deleteSeriesIdCache("plex", tmdbID);
            if (!deadlineMs || nowMs() <= deadlineMs) {
                return await fetchPlexSeriesSeasons(tmdbID, deadlineMs, allowCache, true, cacheEpochAtStart);
            }
            return { ok: false, found: false, reason: "deadline" };
        }
        return { ok: false, found: false, reason: er.reason };
    }

    var eMetas = (er.body && er.body.MediaContainer && er.body.MediaContainer.Metadata) || [];
    if (usedCachedId && eMetas.length === 0) {
        deleteSeriesIdCache("plex", tmdbID);
        if (!deadlineMs || nowMs() <= deadlineMs) {
            return await fetchPlexSeriesSeasons(tmdbID, deadlineMs, allowCache, true, cacheEpochAtStart);
        }
        return { ok: false, found: false, reason: "deadline" };
    }
    if (!usedCachedId && allowCache && eMetas.length > 0 && cacheEpochAtStart === cacheEpoch) {
        putSeriesIdCache("plex", tmdbID, showKey, ttl);
    }

    var seasons = {};
    for (var ei = 0; ei < eMetas.length; ei++) {
        var em = eMetas[ei] || {};
        var pSeason = safeNum(String(em.parentIndex), -1);
        var pEpisode = safeNum(String(em.index), -1);
        if (pSeason < 0 || pEpisode <= 0) continue;
        var sKey = String(pSeason);
        var eKey = String(pEpisode);
        if (!seasons[sKey]) seasons[sKey] = {};
        if (!seasons[sKey][eKey]) seasons[sKey][eKey] = [];
        var c = plexItemCopies(em);
        for (var ci = 0; ci < c.length; ci++) {
            seasons[sKey][eKey].push(c[ci]);
        }
    }
    return { ok: true, found: true, source: "plex", seasons: seasons };
}

// ====== 按后端独立的媒体库查询、整剧多季缓存与并行竞速 ======

function enabledBackends() {
    var list = [];
    if (isEnabled("emby_enabled")) list.push("emby");
    if (isEnabled("plex_enabled")) list.push("plex");
    return list;
}

function mergeEpisodeMapInto(target, srcEpMap) {
    if (!srcEpMap) return;
    for (var eKey in srcEpMap) {
        if (!Object.prototype.hasOwnProperty.call(srcEpMap, eKey)) continue;
        if (!target[eKey]) target[eKey] = [];
        var arr = srcEpMap[eKey];
        for (var i = 0; i < arr.length; i++) {
            target[eKey].push(arr[i]);
        }
    }
}

async function performBackendMovieCheck(backend, tmdbID, deadlineMs, allowWriteCache) {
    var epoch = cacheEpoch;
    var r = backend === "emby"
        ? await fetchEmbyMovie(tmdbID, deadlineMs)
        : await fetchPlexMovie(tmdbID, deadlineMs);
    var ts = nowSec();
    var ttl = cacheTtlSec();
    if (allowWriteCache && r.ok && epoch === cacheEpoch && ttl > 0 && cacheMaxBytes() > 0) {
        putMemCache(movieCacheKey(backend, tmdbID), {
            kind: "movie",
            ts: ts,
            source: backend,
            copies: r.copies || []
        }, ttl);
    }
    return {
        backend: backend,
        ok: !!r.ok,
        hit: !!r.hit,
        copies: r.copies || [],
        source: r.hit ? backend : "",
        reason: r.reason || (r.hit ? "hit" : "no_match"),
        epoch: epoch,
        ts: ts
    };
}

async function performBackendTvCheck(backend, tmdbID, deadlineMs, allowWriteCache) {
    var epoch = cacheEpoch;
    var r = backend === "emby"
        ? await fetchEmbySeriesSeasons(tmdbID, deadlineMs, allowWriteCache, false, epoch)
        : await fetchPlexSeriesSeasons(tmdbID, deadlineMs, allowWriteCache, false, epoch);
    var ts = nowSec();
    var ttl = cacheTtlSec();
    // 该后端完整拉取成功即独立写回它自己的按季缓存，并对账该剧在该后端的旧季缓存；
    // 不因另一后端失败而连坐丢弃本端缓存。
    if (allowWriteCache && r.ok && epoch === cacheEpoch && ttl > 0 && cacheMaxBytes() > 0) {
        var seasons = r.seasons || {};
        reconcileBackendSeriesSeasons(backend, tmdbID, seasons, ts, ttl);
        for (var sKey in seasons) {
            if (!Object.prototype.hasOwnProperty.call(seasons, sKey)) continue;
            putMemCache(seasonCacheKey(backend, tmdbID, safeNum(sKey, 0)), {
                kind: "tv",
                ts: ts,
                source: backend,
                episodes: seasons[sKey]
            }, ttl);
        }
    }
    return {
        backend: backend,
        ok: !!r.ok,
        found: !!r.found,
        seasons: r.seasons || {},
        source: r.found ? backend : "",
        reason: r.reason || (r.ok ? "ok" : "lib_error"),
        epoch: epoch,
        ts: ts
    };
}

function ensureSeasonMissCached(backend, tmdbID, season, bRes) {
    if (!bRes || !bRes.ok || bRes.epoch !== cacheEpoch) return;
    var ttl = cacheTtlSec();
    if (ttl <= 0 || cacheMaxBytes() <= 0) return;
    var sKey = String(season);
    if (bRes.seasons && Object.prototype.hasOwnProperty.call(bRes.seasons, sKey)) return;
    putMemCache(seasonCacheKey(backend, tmdbID, season), {
        kind: "tv",
        ts: bRes.ts,
        source: backend,
        episodes: {}
    }, ttl);
}

// 按后端+同剧/同片在途请求去重（singleflight）：同毫秒并发到达的多个请求共用同一份异步 Promise
function runInFlight(flightKey, fn) {
    if (Object.prototype.hasOwnProperty.call(inFlight, flightKey)) {
        return inFlight[flightKey];
    }
    var p = fn();
    inFlight[flightKey] = p;
    var cleanup = function () {
        if (inFlight[flightKey] === p) delete inFlight[flightKey];
    };
    p.then(cleanup, cleanup);
    return p;
}

// 并行等待多个后端的在途 Promise：每完成一个后端就回调 onResult(backend, res)；
// 若 onResult 返回 true（已 100% 确定否决），立刻提前 resolve，慢端在后台跑完只更新它自己的缓存。
function raceBackends(tasks, onResult) {
    return new Promise(function (resolve, reject) {
        if (!tasks || tasks.length === 0) {
            resolve({ earlyVeto: false });
            return;
        }
        var remaining = tasks.length;
        var settled = false;
        for (var i = 0; i < tasks.length; i++) {
            (function (task) {
                Promise.resolve(task.promise).then(function (res) {
                    if (settled) return;
                    try {
                        if (onResult(task.backend, res)) {
                            settled = true;
                            resolve({ earlyVeto: true });
                            return;
                        }
                    } catch (cbErr) {
                        settled = true;
                        reject(cbErr);
                        return;
                    }
                    remaining--;
                    if (remaining === 0 && !settled) {
                        settled = true;
                        resolve({ earlyVeto: false });
                    }
                }, function (err) {
                    if (settled) return;
                    settled = true;
                    reject(err);
                });
            })(tasks[i]);
        }
    });
}

// ====== per-flow 配置校验 ======

function sanitizeDims(obj) {
    var out = {};
    if (!obj || typeof obj !== "object") return out;
    for (var i = 0; i < MATCH_DIMS.length; i++) {
        var dim = MATCH_DIMS[i];
        if (!obj.hasOwnProperty(dim)) continue;
        var entry = obj[dim];
        if (!entry || typeof entry !== "object") continue;
        var op = trim(String(entry.op || ""));
        var allowed = MATCH_OPS[dim] || ["=="];
        var valid = false;
        for (var a = 0; a < allowed.length; a++) {
            if (allowed[a] === op) { valid = true; break; }
        }
        if (!valid) op = "==";
        var cleaned = { op: op };
        if (op === "regex" && typeof entry.pattern === "string") {
            cleaned.pattern = entry.pattern;
        }
        out[dim] = cleaned;
    }
    return out;
}

// ====== should_download 主判定（单集 / 电影） ======

async function decideShouldDownload(p, callDeadline) {
    incCounter("should_download_seen");

    var media = (p && p.media) || {};
    var tags = (p && p.tags) || {};
    var flowID = (p && p.flow_id != null) ? p.flow_id : "";

    var tmdbID = media.tmdb_id == null ? "" : String(media.tmdb_id);
    var tmdbType = trim(media.tmdb_type) || "tv";
    var season = safeNum(String(media.season == null ? "" : media.season), 0);
    var episode = safeNum(String(media.episode == null ? "" : media.episode), 0);

    var fc = flowConfig(flowID);

    if (!fc.enabled) {
        return { allow: true, reason: "flow_disabled", fc: fc };
    }

    if (!fc.dims || dimCount(fc.dims) === 0) {
        incCounter("allowed_no_dims");
        return { allow: true, reason: "no_dims", fc: fc };
    }

    var backends = enabledBackends();
    if (backends.length === 0) {
        return { allow: true, reason: "no_backend", fc: fc };
    }

    if (!nonEmpty(tmdbID)) {
        incCounter("allowed_no_tmdb");
        return { allow: true, reason: "no_tmdb", fc: fc };
    }

    // tag 端空值短路：任一已配维度 tag 为空 → dimMatch 必 false → 无需查库
    for (var dim in fc.dims) {
        if (!fc.dims.hasOwnProperty(dim)) continue;
        if (!tagHasValue(tagDimValue(tags, dim))) {
            incCounter("allowed_tag_empty");
            return { allow: true, reason: "tag_empty", empty_dim: dim, fc: fc };
        }
    }

    var ttl = cacheTtlSec();
    var negTtl = effectiveNegativeTtlSec(ttl);
    var cachedAllCopies = [];
    var cachedSources = [];
    var backendsToFetch = [];

    // 1) 缓存快路径（两端对称）：任意已启用后端的缓存命中匹配即立刻否决（0 HTTP）；
    //    未命中匹配但尚在短负缓存（<=60s）内的后端记下结果、不再发 HTTP。
    for (var bi = 0; bi < backends.length; bi++) {
        var bName = backends[bi];
        var cKey = tmdbType === "movie" ? movieCacheKey(bName, tmdbID) : seasonCacheKey(bName, tmdbID, season);
        var cached = getMemCache(cKey, ttl);
        if (cached) {
            var bCopies = tmdbType === "movie"
                ? (cached.copies || [])
                : ((cached.episodes && cached.episodes[String(episode)]) || []);
            if (bCopies.length > 0 && anyCopyMatchesTags(bCopies, tags, fc.dims)) {
                incCounter("vetoed");
                return {
                    allow: false,
                    reason: "in_lib_match",
                    fc: fc,
                    lib: { hit: true, copies: bCopies, source: bName, from_cache: true }
                };
            }
            var age = nowSec() - cached.ts;
            if (age < negTtl) {
                if (bCopies.length > 0) {
                    cachedAllCopies = cachedAllCopies.concat(bCopies);
                    cachedSources.push(bName);
                }
                continue;
            }
        }
        backendsToFetch.push(bName);
    }

    if (backendsToFetch.length === 0) {
        var cachedLib = {
            hit: cachedAllCopies.length > 0,
            copies: cachedAllCopies,
            source: cachedSources.join("+"),
            from_cache: true
        };
        if (cachedAllCopies.length === 0) {
            incCounter("allowed_not_in_lib");
            return { allow: true, reason: "not_in_lib", fc: fc, lib: cachedLib };
        }
        incCounter("allowed_no_match");
        return { allow: true, reason: "no_match", fc: fc, lib: cachedLib };
    }

    // 2) 并行查询未命中缓存的后端：谁先命中同规格副本即立刻返回否决，不被另一慢端拖累
    var allCopies = cachedAllCopies.slice();
    var sourceNames = cachedSources.slice();
    var hadError = false;
    var hitDeadline = false;
    var matchedLib = null;

    try {
        var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
        var tasks = [];
        for (var fi = 0; fi < backendsToFetch.length; fi++) {
            (function (backendName) {
                var fKey = tmdbType === "movie"
                    ? movieFlightKey(backendName, tmdbID)
                    : seriesFlightKey(backendName, tmdbID);
                var prom = runInFlight(fKey, function () {
                    if (tmdbType === "movie") {
                        return performBackendMovieCheck(backendName, tmdbID, deadline, true);
                    }
                    return performBackendTvCheck(backendName, tmdbID, deadline, true);
                });
                tasks.push({ backend: backendName, promise: prom });
            })(backendsToFetch[fi]);
        }

        await raceBackends(tasks, function (backendName, bRes) {
            if (!bRes || !bRes.ok) {
                hadError = true;
                if (bRes && bRes.reason === "deadline") hitDeadline = true;
                return false;
            }
            var epCopies;
            if (tmdbType === "movie") {
                epCopies = bRes.copies || [];
            } else {
                ensureSeasonMissCached(backendName, tmdbID, season, bRes);
                var seasonEps = (bRes.seasons && bRes.seasons[String(season)]) || {};
                epCopies = seasonEps[String(episode)] || [];
            }
            if (epCopies.length > 0) {
                allCopies = allCopies.concat(epCopies);
                if (sourceNames.indexOf(backendName) < 0) sourceNames.push(backendName);
                if (anyCopyMatchesTags(epCopies, tags, fc.dims)) {
                    matchedLib = { hit: true, copies: epCopies, source: backendName, from_cache: false };
                    return true;
                }
            }
            return false;
        });
    } catch (e) {
        if (callDeadline && nowMs() > callDeadline) return { allow: true, reason: "late", late: true };
        log.error("media-library-filter: lib check exception: " + e);
        incCounter("allowed_error");
        return { allow: true, reason: "exception", fc: fc };
    }
    if (callDeadline && nowMs() > callDeadline) return { allow: true, reason: "late", late: true };

    if (matchedLib) {
        incCounter("vetoed");
        return { allow: false, reason: "in_lib_match", fc: fc, lib: matchedLib };
    }

    var finalLib = {
        hit: allCopies.length > 0,
        copies: allCopies,
        source: sourceNames.join("+"),
        from_cache: false
    };

    if (hadError) {
        // 至少一个后端请求失败或超软预算，且没有后端命中匹配副本：fail-open 计 allowed_error
        incCounter("allowed_error");
        return { allow: true, reason: hitDeadline ? "deadline" : "lib_error", fc: fc, lib: finalLib };
    }

    if (allCopies.length === 0) {
        incCounter("allowed_not_in_lib");
        return { allow: true, reason: "not_in_lib", fc: fc, lib: finalLib };
    }

    incCounter("allowed_no_match");
    return { allow: true, reason: "no_match", fc: fc, lib: finalLib };
}

function libSummary(d) {
    if (!d.lib) return "";
    var copies = isArray(d.lib.copies) ? d.lib.copies : [];
    var s = " lib=" + (d.lib.source || "") + " copies=" + copies.length;
    s += " dims=" + dimCount(d.fc ? d.fc.dims : null);
    if (d.lib.from_cache) s += " cache";
    return s;
}

// ====== 合集逐集否决（bitmap 协议） ======

// base64 编码（goja 无原生 btoa，手动实现）
function bytesToBase64(bytes) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var result = "";
    var i = 0;
    while (i < bytes.length) {
        var b0 = bytes[i++] & 0xFF;
        var b1 = i < bytes.length ? bytes[i++] & 0xFF : -1;
        var b2 = i < bytes.length ? bytes[i++] & 0xFF : -1;
        result += chars[b0 >> 2];
        result += chars[((b0 & 3) << 4) | (b1 >= 0 ? b1 >> 4 : 0)];
        result += b1 >= 0 ? chars[((b1 & 15) << 2) | (b2 >= 0 ? b2 >> 6 : 0)] : "=";
        result += b2 >= 0 ? chars[b2 & 63] : "=";
    }
    return result;
}

// 设置 bitmap 第 ep 集位（与核心 setEpisodeBit 同构）
function setBitmapBit(bytes, ep) {
    if (ep <= 0) return;
    var byteIdx = (ep - 1) >> 3;
    var bitIdx = (ep - 1) & 7;
    while (byteIdx >= bytes.length) {
        bytes.push(0);
    }
    bytes[byteIdx] |= (1 << bitIdx);
}

function evalBatchEpisodes(epMap, epStart, epEnd, tags, dims) {
    var haveBytes = [];
    var haveCount = 0;
    var totalEps = epEnd - epStart + 1;
    for (var ep = epStart; ep <= epEnd; ep++) {
        var copies = epMap && epMap[String(ep)];
        if (copies && copies.length > 0 && anyCopyMatchesTags(copies, tags, dims)) {
            setBitmapBit(haveBytes, ep);
            haveCount++;
        }
    }
    return { haveBytes: haveBytes, haveCount: haveCount, totalEps: totalEps };
}

// 合集主判定：返回 { allow, have_bitmap_bytes, reason }
async function decideShouldDownloadBatch(p, callDeadline) {
    incCounter("should_download_seen");

    var media = (p && p.media) || {};
    var tags = (p && p.tags) || {};
    var flowID = (p && p.flow_id != null) ? p.flow_id : "";

    var tmdbID = media.tmdb_id == null ? "" : String(media.tmdb_id);
    var season = safeNum(String(media.season == null ? "" : media.season), 0);
    var epStart = safeNum(String(media.episode == null ? "" : media.episode), 0);
    var epEnd = safeNum(String(media.episode_end == null ? "" : media.episode_end), 0);

    var fc = flowConfig(flowID);

    if (!fc.enabled) return { allow: true, reason: "flow_disabled" };
    if (!fc.dims || dimCount(fc.dims) === 0) { incCounter("allowed_no_dims"); return { allow: true, reason: "no_dims" }; }
    var backends = enabledBackends();
    if (backends.length === 0) return { allow: true, reason: "no_backend" };
    if (!nonEmpty(tmdbID)) { incCounter("allowed_no_tmdb"); return { allow: true, reason: "no_tmdb" }; }
    if (epStart <= 0 || epEnd <= 0 || epEnd < epStart) return { allow: true, reason: "invalid_range" };

    // tag 端空值短路
    for (var dim in fc.dims) {
        if (!fc.dims.hasOwnProperty(dim)) continue;
        if (!tagHasValue(tagDimValue(tags, dim))) {
            incCounter("allowed_tag_empty");
            return { allow: true, reason: "tag_empty", empty_dim: dim };
        }
    }

    var ttl = cacheTtlSec();
    var negTtl = effectiveNegativeTtlSec(ttl);
    var cachedByBackend = {};
    var allCachedEpMap = {};

    // 1) 缓存快路径（两端对称）：合并所有已启用后端的正缓存，若已覆盖全部集 → 立刻整包否决（0 HTTP）
    for (var bi = 0; bi < backends.length; bi++) {
        var bName = backends[bi];
        var cached = getMemCache(seasonCacheKey(bName, tmdbID, season), ttl);
        if (cached) {
            cachedByBackend[bName] = cached;
            mergeEpisodeMapInto(allCachedEpMap, cached.episodes || {});
        }
    }
    var combinedCachedEval = evalBatchEpisodes(allCachedEpMap, epStart, epEnd, tags, fc.dims);
    if (combinedCachedEval.haveCount === combinedCachedEval.totalEps) {
        incCounter("vetoed");
        return { allow: false, reason: "batch_all_in_lib" };
    }

    // 2) 未覆盖全部集：尚在短负缓存（<=60s）内的后端直接沿用缓存，其余并行查库
    var liveEpMap = {};
    var backendsToFetch = [];
    for (var bj = 0; bj < backends.length; bj++) {
        var bn = backends[bj];
        var entry = cachedByBackend[bn];
        if (entry && (nowSec() - entry.ts) < negTtl) {
            mergeEpisodeMapInto(liveEpMap, entry.episodes || {});
        } else {
            backendsToFetch.push(bn);
        }
    }

    var evalRes = null;
    var fallbackBackends = [];
    if (backendsToFetch.length === 0) {
        evalRes = evalBatchEpisodes(liveEpMap, epStart, epEnd, tags, fc.dims);
    } else {
        var hadError = false;
        var earlyEval = null;
        var fallbackNotes = [];
        try {
            var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
            var tasks = [];
            for (var fi = 0; fi < backendsToFetch.length; fi++) {
                (function (backendName) {
                    var prom = runInFlight(seriesFlightKey(backendName, tmdbID), function () {
                        return performBackendTvCheck(backendName, tmdbID, deadline, true);
                    });
                    tasks.push({ backend: backendName, promise: prom });
                })(backendsToFetch[fi]);
            }

            await raceBackends(tasks, function (backendName, bRes) {
                if (!bRes || !bRes.ok) {
                    hadError = true;
                    // 重查失败（如 5xx 或 60/min 限流）时，回退到该后端仍在 cache_ttl_sec 内的正缓存，
                    // 保证已缓存的集数不被丢弃而退化成整包重下（与单集正缓存语义一致）。
                    var stale = cachedByBackend[backendName];
                    if (stale) {
                        var staleEps = stale.episodes || {};
                        var staleOwnEval = evalBatchEpisodes(staleEps, epStart, epEnd, tags, fc.dims);
                        if (staleOwnEval.haveCount > 0) {
                            mergeEpisodeMapInto(liveEpMap, staleEps);
                            fallbackBackends.push(backendName);
                            fallbackNotes.push({
                                backend: backendName,
                                reason: (bRes && bRes.reason) || "lib_error",
                                age: nowSec() - stale.ts
                            });
                            var mergedEval = evalBatchEpisodes(liveEpMap, epStart, epEnd, tags, fc.dims);
                            if (mergedEval.haveCount === mergedEval.totalEps) {
                                earlyEval = mergedEval;
                                return true;
                            }
                        }
                    }
                    return false;
                }
                ensureSeasonMissCached(backendName, tmdbID, season, bRes);
                var seasonEps = (bRes.seasons && bRes.seasons[String(season)]) || {};
                mergeEpisodeMapInto(liveEpMap, seasonEps);
                var curEval = evalBatchEpisodes(liveEpMap, epStart, epEnd, tags, fc.dims);
                if (curEval.haveCount === curEval.totalEps) {
                    earlyEval = curEval;
                    return true;
                }
                return false;
            });
        } catch (e) {
            if (callDeadline && nowMs() > callDeadline) return { allow: true, reason: "late", late: true };
            log.error("media-library-filter: batch lib check exception: " + e);
            incCounter("allowed_error");
            return { allow: true, reason: "exception" };
        }
        if (callDeadline && nowMs() > callDeadline) return { allow: true, reason: "late", late: true };

        var freshEval = earlyEval || evalBatchEpisodes(liveEpMap, epStart, epEnd, tags, fc.dims);
        if (hadError && freshEval.haveCount === 0) {
            incCounter("allowed_error");
            return { allow: true, reason: "batch_check_failed" };
        }
        if (fallbackNotes.length > 0 && freshEval.haveCount > 0) {
            for (var fni = 0; fni < fallbackNotes.length; fni++) {
                var fn = fallbackNotes[fni];
                log.warn("media-library-filter: batch refresh failed (" + fn.backend + " reason=" + fn.reason +
                         "), falling back to valid memory cache (age=" + fn.age + "s) flow=" + flowID +
                         " tmdb=" + tmdbID + " s" + season + " e" + epStart + "-" + epEnd);
            }
        }
        evalRes = freshEval;
    }

    var fallbackTag = fallbackBackends.length > 0 ? fallbackBackends.join("+") : "";
    if (evalRes.haveCount === evalRes.totalEps) {
        incCounter("vetoed");
        return { allow: false, reason: "batch_all_in_lib", fallback: fallbackTag };
    }
    if (evalRes.haveCount === 0) {
        incCounter("allowed_not_in_lib");
        return { allow: true, reason: "batch_none_in_lib" };
    }

    incCounter("batch_partial_filtered");
    return {
        allow: true,
        reason: "batch_partial",
        have_bitmap_bytes: evalRes.haveBytes,
        have_count: evalRes.haveCount,
        total: evalRes.totalEps,
        fallback: fallbackTag
    };
}

// ====== Hook 注册 ======

// 宿主 3s 超时之后才回来：宿主早已 fail-open 放行，这里的结论没人看。只计 late + 打一条 warn，
// 不带裁决（免得被误读成「这次否决了」）
function noteLate(p, startMs, why) {
    var media = (p && p.media) || {};
    incCounter("late");
    log.warn("media-library-filter: should_download finished after the host's " + HOST_FILTER_TIMEOUT_MS +
             "ms timeout (" + (nowMs() - startMs) + "ms; host already allowed the download, result discarded) flow=" +
             (p && p.flow_id) + " tmdb=" + (media.tmdb_id || "") + " s" + (media.season || 0) + "e" + (media.episode || 0) +
             (media.episode_end ? "-" + media.episode_end : "") + (why ? " " + why : ""));
    return true;
}

plugin.on("should_download", async function (p) {
    var startMs = nowMs();
    var callDeadline = startMs + HOST_FILTER_TIMEOUT_MS;
    try {
        var media = (p && p.media) || {};
        var episodeEnd = safeNum(String(media.episode_end == null ? "" : media.episode_end), 0);
        var dryRun = isEnabled("dry_run");

        // ---- 合集路径：episode_end > 0 → bitmap 协议 ----
        if (episodeEnd > 0) {
            var db = await decideShouldDownloadBatch(p || {}, callDeadline);
            if (db.late) return noteLate(p, startMs);
            log.info("media-library-filter: should_download [batch] flow=" + (p && p.flow_id) +
                     " tmdb=" + (media.tmdb_id || "") + " s" + (media.season || 0) +
                     " e" + (media.episode || 0) + "-" + episodeEnd +
                     " reason=" + db.reason +
                     (db.have_count != null ? " have=" + db.have_count + "/" + db.total : "") +
                     (db.fallback ? " cache_fallback=" + db.fallback : "") +
                     " decision=" + (db.allow ? "allow" : "veto") +
                     (dryRun && !db.allow ? " [dry_run->allow]" : ""));

            if (dryRun) {
                if (!db.allow) incCounter("dry_run_would_veto");
                return true;
            }
            if (db.allow === false) return false;
            if (db.have_bitmap_bytes && db.have_bitmap_bytes.length > 0) {
                return { have_bitmap: bytesToBase64(db.have_bitmap_bytes) };
            }
            return true;
        }

        // ---- 单集/电影路径：保持原有 bool 逻辑 ----
        var d = await decideShouldDownload(p || {}, callDeadline);
        if (d.late) return noteLate(p, startMs);
        log.info("media-library-filter: should_download flow=" + (p && p.flow_id) +
                 " tmdb=" + (media.tmdb_id || "") + " s" + (media.season || 0) + "e" + (media.episode || 0) +
                 " reason=" + d.reason +
                 (d.empty_dim ? " empty_dim=" + d.empty_dim : "") +
                 " decision=" + (d.allow ? "allow" : "veto") + libSummary(d) +
                 (dryRun && !d.allow ? " [dry_run->allow]" : ""));

        if (dryRun) {
            if (!d.allow) incCounter("dry_run_would_veto");
            return true;
        }
        if (d.allow === false) return false;
        return true;
    } catch (e) {
        if (nowMs() > callDeadline) return noteLate(p, startMs, "error=" + e);
        log.error("media-library-filter: should_download handler error: " + e);
        incCounter("allowed_error");
        return true;
    }
});

// ====== 自定义 API ======

plugin.registerAPI("/flows", function (req) {
    // 设置页保存后会立刻调 /flows，在此重读配置即可做到网页改配置实时生效
    reloadConfigSafe();
    if (typeof ruleflow !== "object" || !ruleflow || typeof ruleflow.list !== "function") {
        return { ok: false, error: "ruleflow unavailable (need api.ruleflow.read permission)", flows: [] };
    }
    var flows = [];
    try {
        var raw = ruleflow.list() || [];
        for (var i = 0; i < raw.length; i++) {
            var f = raw[i] || {};
            flows.push({ id: f.id, name: f.name || "" });
        }
    } catch (e) {
        return { ok: false, error: String(e), flows: [] };
    }
    var out = [];
    for (var j = 0; j < flows.length; j++) {
        var fc = flowConfig(flows[j].id);
        out.push({
            id: flows[j].id,
            name: flows[j].name,
            enabled: fc.enabled,
            dims: fc.dims
        });
    }
    return { ok: true, flows: out };
});

plugin.registerAPI("/stats", function (req) {
    reloadConfigSafe();
    return {
        config: {
            emby_enabled: isEnabled("emby_enabled"),
            emby_configured: !!(cfgGet("emby_url") && cfgGet("emby_api_key")),
            plex_enabled: isEnabled("plex_enabled"),
            plex_configured: !!(cfgGet("plex_url") && cfgGet("plex_token")),
            cache_ttl_sec: cacheTtlSec(),
            cache_max_mb: cacheMaxMb(),
            dry_run: isEnabled("dry_run")
        },
        cache: {
            entries: memCacheCount,
            bytes: memCacheBytes,
            max_bytes: cacheMaxBytes(),
            series_id_entries: seriesIdCount
        },
        counters: {
            should_download_seen: memCounters.should_download_seen || 0,
            vetoed: memCounters.vetoed || 0,
            allowed_not_in_lib: memCounters.allowed_not_in_lib || 0,
            allowed_no_tmdb: memCounters.allowed_no_tmdb || 0,
            allowed_no_match: memCounters.allowed_no_match || 0,
            allowed_no_dims: memCounters.allowed_no_dims || 0,
            allowed_tag_empty: memCounters.allowed_tag_empty || 0,
            allowed_error: memCounters.allowed_error || 0,
            dry_run_would_veto: memCounters.dry_run_would_veto || 0,
            batch_partial_filtered: memCounters.batch_partial_filtered || 0,
            late: memCounters.late || 0,
            cache_write_fail: cache_write_fail
        },
        errors: {
            emby_last_error: memErrors.emby_last_error || "",
            emby_last_error_at: memErrors.emby_last_error_at || "",
            plex_last_error: memErrors.plex_last_error || "",
            plex_last_error_at: memErrors.plex_last_error_at || ""
        }
    };
});

plugin.registerAPI("/clear-cache", function (req) {
    var method = (req && req.method) ? String(req.method).toUpperCase() : "GET";
    if (method !== "POST") {
        return { ok: false, error: "method not allowed: use POST" };
    }
    reloadConfigSafe();
    var cleared = clearAllCaches();
    log.info("media-library-filter: memory cache cleared (entries=" + cleared.cleared_entries +
             " bytes=" + cleared.cleared_bytes + " series_ids=" + cleared.cleared_series_ids + ")");
    return {
        ok: true,
        cleared_entries: cleared.cleared_entries,
        cleared_bytes: cleared.cleared_bytes,
        cleared_series_ids: cleared.cleared_series_ids
    };
});

function buildCopyTrace(copies, tags, dims) {
    var out = [];
    var arr = isArray(copies) ? copies : [];
    for (var i = 0; i < arr.length; i++) {
        var copy = arr[i] || {};
        var dimTrace = {};
        var matchAll = true;
        if (dims && typeof dims === "object") {
            for (var dim in dims) {
                if (!dims.hasOwnProperty(dim)) continue;
                var cfg = dims[dim] || {};
                var op = cfg.op || "==";
                var tagValue = tagDimValue(tags, dim);
                var libValue = copyDimValue(copy, dim);
                var ok = dimMatch(dim, op, tagValue, libValue, cfg.pattern);
                if (!ok) matchAll = false;
                dimTrace[dim] = {
                    op: op,
                    pattern: cfg.pattern || null,
                    tag_value: tagValue === undefined ? null : tagValue,
                    lib_value: libValue === undefined ? null : libValue,
                    match: ok
                };
            }
        }
        out.push({
            height_raw: copy.height || 0,
            bucket: resolutionBucket(copy.height),
            hdr: !!copy.hdr,
            dv: !!copy.dv,
            video_codec: copy.video_codec === undefined ? null : copy.video_codec,
            audio_codec: copy.audio_codec === undefined ? null : copy.audio_codec,
            bit_depth: copy.bit_depth === undefined ? null : copy.bit_depth,
            format: copy.format === undefined ? null : copy.format,
            filename: copy.filename || "",
            dims: dimTrace,
            match_all: matchAll
        });
    }
    return out;
}

plugin.registerAPI("/check", async function (req) {
    reloadConfigSafe();
    var method = (req && req.method) || "GET";

    if (method === "POST") {
        var body = safeJsonParse((req && req.body) || "", null);
        if (!body || typeof body !== "object") {
            return { ok: false, error: "POST body must be JSON {mock_copies, tags, dims} or {flow_id, tags}" };
        }

        var dims;
        var mockTags = body.tags || {};
        if (body.flow_id != null) {
            var fc = flowConfig(body.flow_id);
            if (!fc.enabled) {
                return { ok: true, mode: "mock", flow_id: String(body.flow_id),
                         would_decision: "allow", would_reason: "flow_disabled", copies: [] };
            }
            if (!fc.dims || dimCount(fc.dims) === 0) {
                return { ok: true, mode: "mock", flow_id: String(body.flow_id),
                         would_decision: "allow", would_reason: "no_dims", copies: [] };
            }
            dims = fc.dims;
        } else {
            dims = sanitizeDims(body.dims || {});
            if (dimCount(dims) === 0) {
                return { ok: true, mode: "mock", would_decision: "allow", would_reason: "no_dims", copies: [] };
            }
        }

        var mockCopies = isArray(body.mock_copies) ? body.mock_copies : [];
        var allow, why;
        if (mockCopies.length === 0) { allow = true; why = "not_in_lib"; }
        else if (anyCopyMatchesTags(mockCopies, mockTags, dims)) {
            allow = false;
            why = "in_lib_match";
        } else { allow = true; why = "no_match"; }

        return {
            ok: true,
            mode: "mock",
            dims: dims,
            tags: mockTags,
            would_decision: allow ? "allow" : "veto",
            would_reason: why,
            copies: buildCopyTrace(mockCopies, mockTags, dims)
        };
    }

    var q = (req && req.query) || {};
    var tmdbID = trim(q.tmdb_id);
    var tmdbType = trim(q.tmdb_type) || "tv";
    var season = safeNum(String(q.season == null ? "" : q.season), 0);
    var episode = safeNum(String(q.episode == null ? "" : q.episode), 0);
    var flowID = q.flow_id == null ? "" : String(q.flow_id);

    if (!nonEmpty(tmdbID)) {
        return { ok: false, error: "missing ?tmdb_id= (with optional &season=&episode=&tmdb_type=&flow_id=); or POST {mock_copies, tags, dims}" };
    }

    var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
    var backends = enabledBackends();
    var checkPromises = [];
    for (var bi = 0; bi < backends.length; bi++) {
        (function (backendName) {
            if (tmdbType === "movie") {
                checkPromises.push(performBackendMovieCheck(backendName, tmdbID, deadline, false));
            } else {
                checkPromises.push(performBackendTvCheck(backendName, tmdbID, deadline, false));
            }
        })(backends[bi]);
    }
    var results = await Promise.all(checkPromises);
    var realCopies = [];
    var sourcesTried = [];
    var sourceNames = [];
    var hadErr = false;
    var lastErrReason = "";
    for (var ri = 0; ri < results.length; ri++) {
        var br = results[ri] || {};
        var bCopies;
        if (tmdbType === "movie") {
            bCopies = br.ok ? (br.copies || []) : [];
        } else {
            var sEps = (br.ok && br.seasons && br.seasons[String(season)]) || {};
            bCopies = sEps[String(episode)] || [];
        }
        sourcesTried.push({ name: br.backend || "", ok: !!br.ok, hit: bCopies.length > 0, reason: br.reason || "" });
        if (!br.ok) {
            hadErr = true;
            lastErrReason = br.reason || "lib_error";
        } else if (bCopies.length > 0) {
            realCopies = realCopies.concat(bCopies);
            if (br.backend && sourceNames.indexOf(br.backend) < 0) sourceNames.push(br.backend);
        }
    }
    var r = {
        hit: realCopies.length > 0,
        source: sourceNames.join("+"),
        reason: realCopies.length > 0 ? "hit" : (hadErr ? lastErrReason : "no_match"),
        sources: sourcesTried
    };

    var resp = {
        ok: true,
        mode: "real",
        tmdb_id: tmdbID,
        tmdb_type: tmdbType,
        season: season,
        episode: episode,
        hit: !!r.hit,
        source: r.source || "",
        reason: r.reason || "",
        sources_tried: r.sources || []
    };

    if (nonEmpty(flowID)) {
        var gfc = flowConfig(flowID);
        resp.flow_config = { enabled: gfc.enabled, dims: gfc.dims };
        var gAllow, gWhy;
        if (!gfc.enabled) { gAllow = true; gWhy = "flow_disabled"; }
        else if (!gfc.dims || dimCount(gfc.dims) === 0) { gAllow = true; gWhy = "no_dims"; }
        else if (realCopies.length === 0) { gAllow = true; gWhy = "not_in_lib"; }
        else if (anyCopyMatchesTags(realCopies, q, gfc.dims)) {
            gAllow = false;
            gWhy = "in_lib_match";
        } else { gAllow = true; gWhy = "no_match"; }
        resp.would_decision = gAllow ? "allow" : "veto";
        resp.would_reason = gWhy;
        resp.copies = buildCopyTrace(realCopies, q, gfc.dims || {});
    } else {
        resp.copies = buildCopyTrace(realCopies, {}, {});
    }
    return resp;
});

plugin.registerAPI("/test-emby", async function (req) {
    reloadConfigSafe();
    var url = cfgGet("emby_url");
    var key = cfgGet("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, error: "url/api_key missing" };
    try {
        var resp = await http.get(joinUrl(url, "/emby/System/Info/Public"), { "Accept": "application/json" });
        return {
            ok: !!(resp && resp.status >= 200 && resp.status < 300),
            status: resp && resp.status,
            body_preview: ((resp && resp.body) || "").substring(0, 200)
        };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

plugin.registerAPI("/test-plex", async function (req) {
    reloadConfigSafe();
    var url = cfgGet("plex_url");
    var token = cfgGet("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, error: "url/token missing" };
    try {
        var resp = await http.get(joinUrl(url, "/identity") + "?" + qs({ "X-Plex-Token": token }), { "Accept": "application/json" });
        return {
            ok: !!(resp && resp.status >= 200 && resp.status < 300),
            status: resp && resp.status,
            body_preview: ((resp && resp.body) || "").substring(0, 200)
        };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

plugin.registerAPI("/save-config", function (req) {
    // req.body 依宿主实现而异：可能是已解析对象、JSON string（文档约定的
    // "原始字节 string"），个别宿主还会再包一层 JSON（双重编码）。逐层解析到
    // 对象为止，把这些情况都兜住，避免误报 "body must be a JSON object"。
    var obj = req && req.body;
    for (var _p = 0; typeof obj === "string" && _p < 3; _p++) {
        obj = obj.length ? safeJsonParse(obj, null) : null;
    }
    if (!obj || typeof obj !== "object" || isArray(obj)) {
        return { ok: false, error: "body must be a JSON object" };
    }

    var globalAllowed = {
        emby_enabled: 1, emby_url: 1, emby_api_key: 1,
        plex_enabled: 1, plex_url: 1, plex_token: 1,
        cache_ttl_sec: 1, cache_max_mb: 1, dry_run: 1
    };
    var flowKeyRe = /^flow_.+_(enabled|dims)$/;
    var flowDimsRe = /^flow_.+_dims$/;

    var written = [];
    for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (!globalAllowed[k] && !flowKeyRe.test(k)) continue;
        var v = obj[k];
        if (v === null || v === undefined) v = "";
        if (typeof v !== "string") v = String(v);

        if (k === "cache_max_mb" && trim(v) !== "") {
            var parsedMb = parseFloat(trim(v));
            if (isNaN(parsedMb) || !isFinite(parsedMb) || parsedMb < 0 || parsedMb > MAX_CACHE_MAX_MB) {
                return { ok: false, error: "cache_max_mb must be between 0 and " + MAX_CACHE_MAX_MB, key: k, written: written };
            }
            v = trim(v);
        }

        if (flowDimsRe.test(k)) {
            var parsed;
            try { parsed = JSON.parse(v); }
            catch (e) { return { ok: false, error: "flow dims invalid json", key: k, written: written }; }
            if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
                return { ok: false, error: "flow dims must be a json object", key: k, written: written };
            }
            for (var pk in parsed) {
                if (!parsed.hasOwnProperty(pk)) continue;
                var known = false;
                for (var di = 0; di < MATCH_DIMS.length; di++) {
                    if (MATCH_DIMS[di] === pk) { known = true; break; }
                }
                if (!known) return { ok: false, error: "unknown dimension: " + pk, key: k, written: written };
                var entry = parsed[pk];
                if (!entry || typeof entry !== "object") {
                    return { ok: false, error: "dimension entry must be object with op: " + pk, key: k, written: written };
                }
                var entryOp = trim(String(entry.op || ""));
                var allowed = MATCH_OPS[pk] || ["=="];
                var opValid = false;
                for (var oi = 0; oi < allowed.length; oi++) {
                    if (allowed[oi] === entryOp) { opValid = true; break; }
                }
                if (!opValid) {
                    return { ok: false, error: "invalid op '" + entryOp + "' for " + pk + " (allowed: " + allowed.join(",") + ")", key: k, written: written };
                }
                if (entryOp === "regex") {
                    if (!entry.pattern || typeof entry.pattern !== "string") {
                        return { ok: false, error: "regex op requires pattern string for " + pk, key: k, written: written };
                    }
                    if (entry.pattern.length > 200) {
                        return { ok: false, error: "regex pattern too long for " + pk + " (max 200 chars)", key: k, written: written };
                    }
                    try { new RegExp(entry.pattern); }
                    catch (re) { return { ok: false, error: "invalid regex pattern for " + pk + ": " + re, key: k, written: written }; }
                }
            }
            v = JSON.stringify(sanitizeDims(parsed));
        }

        try { config.set(k, v); written.push(k); }
        catch (e2) { return { ok: false, error: "config.set failed for " + k + ": " + e2, written: written }; }
    }
    reloadConfigSafe();
    return { ok: true, written: written };
});

// ====== 启动初始化 ======

try { initLegacyCacheCleanup(); } catch (e) { log.warn("media-library-filter: legacy cache cleanup at startup failed: " + e); }
try { loadStatsFromStore(); } catch (e) { log.warn("media-library-filter: load stats at startup failed: " + e); }
reloadConfigSafe();
startConfigRefreshTimer();

log.info("media-library-filter loaded (like-for-like dedup; emby=" + isEnabled("emby_enabled") +
         " plex=" + isEnabled("plex_enabled") +
         " dry_run=" + isEnabled("dry_run") +
         " cache_max_mb=" + cacheMaxMb() + ")");
