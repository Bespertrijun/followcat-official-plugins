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
//   * 硬超时 3s；库查询整体预算 ≤2500ms；外部库宕机不拖垮下载管线。
//   * tmdb_id 缺失 → 无法精确查库 → 放行。
//
// === 7 个比对维度 ===
//   resolution(==/>=)  video_encode(==/regex)  audio_encode(==/regex)
//   code_bits(==/>=)   hdr(==)  dv(==)  format(==/regex)
//
// === 全局配置 key ===
//   emby_enabled / emby_url / emby_api_key
//   plex_enabled / plex_url / plex_token
//   cache_ttl_sec / dry_run
//
// === per-flow 配置 key ===
//   flow_<id>_enabled   "1" 启用本 flow 否决
//   flow_<id>_dims      维度+操作符 JSON，例：
//                       {"resolution":{"op":">="},"video_encode":{"op":"regex","pattern":"hevc|h265|x265"}}
//                       键缺失/损坏 → 放行；空 {} → 放行（无维度可比）

// ====== 常量与工具 ======

var CACHE_PREFIX = "lib_cache_";
var DEFAULT_CACHE_TTL_SEC = 3600;
var LIB_CHECK_SOFT_BUDGET_MS = 2500;

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

var cache_write_fail = 0;

function nowMs() { return new Date().getTime(); }
function nowSec() { return Math.floor(nowMs() / 1000); }

function safeNum(s, def) {
    if (s === null || s === undefined || s === "") return def;
    var n = parseInt(s, 10);
    return isNaN(n) ? def : n;
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

function isEnabled(key) { return config.get(key) === "1"; }

function incCounter(key) {
    var n = safeNum(config.get(key), 0) + 1;
    try { config.set(key, String(n)); } catch (e) { /* quota; ignore */ }
}

function rememberError(scope, err) {
    try {
        config.set(scope + "_last_error", String(err == null ? "" : err));
        config.set(scope + "_last_error_at", new Date().toISOString());
    } catch (e) { /* ignore */ }
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

function specBool(v) {
    if (v === true) return true;
    if (v === false) return false;
    var s = trim(String(v == null ? "" : v)).toLowerCase();
    return s === "1" || s === "true" || s === "yes";
}

// tag 值是否「有值」（null/undefined/"" 算空；boolean false 是有效值）
function tagHasValue(v) {
    return v !== null && v !== undefined && v !== "";
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
        return !!libValue === specBool(tagValue);
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
        var tagValue = tags[dim];
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

// ====== 缓存 ======

function cacheKey(tmdbType, tmdbID, season, episode) {
    return CACHE_PREFIX + String(tmdbType || "tv") + "_" + String(tmdbID) +
           "_s" + String(season || 0) + "_e" + String(episode || 0);
}

function readCache(key) {
    if (!nonEmpty(key)) return null;
    var raw = config.get(key);
    if (!raw) return null;
    var obj = safeJsonParse(raw, null);
    if (!obj || typeof obj !== "object") return null;
    return obj;
}

function writeCache(key, entry) {
    if (!nonEmpty(key)) return;
    try {
        config.set(key, JSON.stringify(entry));
    } catch (e) {
        cache_write_fail++;
        log.warn("media-library-filter: cache write failed: " + e);
    }
}

function cacheTtlSec() {
    return safeNum(config.get("cache_ttl_sec"), DEFAULT_CACHE_TTL_SEC);
}

function cacheFresh(entry) {
    if (!entry || typeof entry.ts !== "number") return false;
    var ttl = cacheTtlSec();
    if (ttl <= 0) return false;
    return (nowSec() - entry.ts) < ttl;
}

// ====== Emby 查询 ======

function embyGet(url) {
    try {
        var resp = http.get(url, { "Accept": "application/json" });
        if (!resp || typeof resp.status !== "number") {
            return { ok: false, reason: "malformed_response" };
        }
        if (resp.status < 200 || resp.status >= 300) {
            rememberError("emby", "status=" + resp.status);
            return { ok: false, reason: "status_" + resp.status };
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

function checkEmbyEpisode(tmdbType, tmdbID, season, episode, deadlineMs) {
    var url = config.get("emby_url");
    var key = config.get("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, hit: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    if (tmdbType === "movie") {
        var movieUrl = joinUrl(url, "/emby/Items") + "?" + qs({
            api_key: key,
            Recursive: "true",
            IncludeItemTypes: "Movie",
            AnyProviderIdEquals: "tmdb." + tmdbID,
            Fields: "ProviderIds,MediaSources,Path",
            Limit: 5
        });
        var mr = embyGet(movieUrl);
        if (!mr.ok) return { ok: false, hit: false, reason: mr.reason };
        var mItems = (mr.body && mr.body.Items) || [];
        for (var mi = 0; mi < mItems.length; mi++) {
            var mItem = mItems[mi] || {};
            var pid = mItem.ProviderIds || {};
            if (String(pid.Tmdb || pid.tmdb || "") === String(tmdbID)) {
                return { ok: true, hit: true, source: "emby", copies: embyItemCopies(mItem) };
            }
        }
        return { ok: true, hit: false, reason: "movie_not_found" };
    }

    var seriesUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        IncludeItemTypes: "Series",
        AnyProviderIdEquals: "tmdb." + tmdbID,
        Fields: "ProviderIds",
        Limit: 5
    });
    var sr = embyGet(seriesUrl);
    if (!sr.ok) return { ok: false, hit: false, reason: sr.reason };
    var sItems = (sr.body && sr.body.Items) || [];
    var seriesID = "";
    for (var si = 0; si < sItems.length; si++) {
        var sItem = sItems[si] || {};
        var spid = sItem.ProviderIds || {};
        if (String(spid.Tmdb || spid.tmdb || "") === String(tmdbID)) {
            seriesID = sItem.Id || sItem.ID || "";
            break;
        }
    }
    if (!nonEmpty(String(seriesID))) return { ok: true, hit: false, reason: "series_not_found" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    var epUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        ParentId: seriesID,
        IncludeItemTypes: "Episode",
        Fields: "MediaSources,ParentIndexNumber,IndexNumber,Path",
        Limit: 2000
    });
    var er = embyGet(epUrl);
    if (!er.ok) return { ok: false, hit: false, reason: er.reason };
    var eItems = (er.body && er.body.Items) || [];
    var matched = [];
    for (var ei = 0; ei < eItems.length; ei++) {
        var eItem = eItems[ei] || {};
        var pSeason = safeNum(String(eItem.ParentIndexNumber), -1);
        var pEpisode = safeNum(String(eItem.IndexNumber), -1);
        if (pSeason === season && pEpisode === episode) {
            var c = embyItemCopies(eItem);
            for (var ci = 0; ci < c.length; ci++) matched.push(c[ci]);
        }
    }
    if (matched.length > 0) {
        return { ok: true, hit: true, source: "emby", copies: matched };
    }
    return { ok: true, hit: false, reason: "episode_not_found" };
}

// ====== Plex 查询 ======

function plexGet(url) {
    try {
        var resp = http.get(url, { "Accept": "application/json" });
        if (!resp || typeof resp.status !== "number") {
            return { ok: false, reason: "malformed_response" };
        }
        if (resp.status < 200 || resp.status >= 300) {
            rememberError("plex", "status=" + resp.status);
            return { ok: false, reason: "status_" + resp.status };
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

function checkPlexEpisode(tmdbType, tmdbID, season, episode, deadlineMs) {
    var url = config.get("plex_url");
    var token = config.get("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, hit: false, reason: "not_configured" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    if (tmdbType === "movie") {
        var movieUrl = joinUrl(url, "/library/all") + "?" + qs({
            "X-Plex-Token": token,
            type: 1,
            includeGuids: 1
        });
        var mr = plexGet(movieUrl);
        if (!mr.ok) return { ok: false, hit: false, reason: mr.reason };
        var mMetas = (mr.body && mr.body.MediaContainer && mr.body.MediaContainer.Metadata) || [];
        for (var mi = 0; mi < mMetas.length; mi++) {
            if (plexMetaTmdb(mMetas[mi]) === String(tmdbID)) {
                return { ok: true, hit: true, source: "plex", copies: plexItemCopies(mMetas[mi]) };
            }
        }
        return { ok: true, hit: false, reason: "movie_not_found" };
    }

    var showUrl = joinUrl(url, "/library/all") + "?" + qs({
        "X-Plex-Token": token,
        type: 2,
        includeGuids: 1
    });
    var shr = plexGet(showUrl);
    if (!shr.ok) return { ok: false, hit: false, reason: shr.reason };
    var shMetas = (shr.body && shr.body.MediaContainer && shr.body.MediaContainer.Metadata) || [];
    var showKey = "";
    for (var shi = 0; shi < shMetas.length; shi++) {
        if (plexMetaTmdb(shMetas[shi]) === String(tmdbID)) {
            showKey = String((shMetas[shi] || {}).ratingKey || "");
            break;
        }
    }
    if (!nonEmpty(showKey)) return { ok: true, hit: false, reason: "series_not_found" };
    if (deadlineMs && nowMs() > deadlineMs) return { ok: false, hit: false, reason: "deadline" };

    var epUrl = joinUrl(url, "/library/metadata/" + showKey + "/allLeaves") + "?" + qs({
        "X-Plex-Token": token
    });
    var er = plexGet(epUrl);
    if (!er.ok) return { ok: false, hit: false, reason: er.reason };
    var eMetas = (er.body && er.body.MediaContainer && er.body.MediaContainer.Metadata) || [];
    var matched = [];
    for (var ei = 0; ei < eMetas.length; ei++) {
        var em = eMetas[ei] || {};
        var pSeason = safeNum(String(em.parentIndex), -1);
        var pEpisode = safeNum(String(em.index), -1);
        if (pSeason === season && pEpisode === episode) {
            var c = plexItemCopies(em);
            for (var ci = 0; ci < c.length; ci++) matched.push(c[ci]);
        }
    }
    if (matched.length > 0) {
        return { ok: true, hit: true, source: "plex", copies: matched };
    }
    return { ok: true, hit: false, reason: "episode_not_found" };
}

// ====== 主库检查 ======

function performLibraryCheck(tmdbType, tmdbID, season, episode, deadlineMs) {
    var sources = [];
    if (isEnabled("emby_enabled")) {
        var er = checkEmbyEpisode(tmdbType, tmdbID, season, episode, deadlineMs);
        sources.push({ name: "emby", ok: er.ok, hit: er.hit, reason: er.reason || "" });
        if (er.ok && er.hit) {
            return { hit: true, source: "emby", copies: er.copies || [], sources: sources };
        }
    }
    if (isEnabled("plex_enabled")) {
        if (deadlineMs && nowMs() > deadlineMs) {
            return { hit: false, reason: "deadline", copies: [], sources: sources };
        }
        var pr = checkPlexEpisode(tmdbType, tmdbID, season, episode, deadlineMs);
        sources.push({ name: "plex", ok: pr.ok, hit: pr.hit, reason: pr.reason || "" });
        if (pr.ok && pr.hit) {
            return { hit: true, source: "plex", copies: pr.copies || [], sources: sources };
        }
    }
    return { hit: false, reason: "no_match", copies: [], sources: sources };
}

function resolveLibraryStatus(tmdbType, tmdbID, season, episode) {
    var key = cacheKey(tmdbType, tmdbID, season, episode);
    var cached = readCache(key);
    if (cached && cacheFresh(cached)) {
        var copies = cached.copies;
        if (isArray(copies)) {
            return {
                hit: copies.length > 0,
                copies: copies,
                source: cached.source || "",
                from_cache: true
            };
        }
    }
    var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
    var r = performLibraryCheck(tmdbType, tmdbID, season, episode, deadline);

    var hadError = false;
    for (var i = 0; i < (r.sources || []).length; i++) {
        if (r.sources[i].ok === false) hadError = true;
    }
    if (!hadError) {
        writeCache(key, {
            copies: r.copies || [],
            source: r.source || "",
            ts: nowSec()
        });
    }
    r.from_cache = false;
    return r;
}

// ====== per-flow 配置 ======

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

function flowConfig(flowID) {
    var id = String(flowID == null ? "" : flowID);
    var prefix = "flow_" + id + "_";
    var enabled = config.get(prefix + "enabled") === "1";
    var raw = config.get(prefix + "dims");

    if (raw === null || raw === undefined || raw === "") {
        return { enabled: enabled, dims: null };
    }
    var parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
        return { enabled: enabled, dims: null };
    }
    var clean = sanitizeDims(parsed);
    if (dimCount(clean) === 0) {
        return { enabled: enabled, dims: null };
    }
    return { enabled: enabled, dims: clean };
}

// ====== should_download 主判定 ======

function decideShouldDownload(p) {
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

    if (!isEnabled("emby_enabled") && !isEnabled("plex_enabled")) {
        return { allow: true, reason: "no_backend", fc: fc };
    }

    if (!nonEmpty(tmdbID)) {
        incCounter("allowed_no_tmdb");
        return { allow: true, reason: "no_tmdb", fc: fc };
    }

    // tag 端空值短路：任一已配维度 tag 为空 → dimMatch 必 false → 无需查库
    for (var dim in fc.dims) {
        if (!fc.dims.hasOwnProperty(dim)) continue;
        if (!tagHasValue(tags[dim])) {
            incCounter("allowed_tag_empty");
            return { allow: true, reason: "tag_empty", empty_dim: dim, fc: fc };
        }
    }

    var libStatus;
    try {
        libStatus = resolveLibraryStatus(tmdbType, tmdbID, season, episode);
    } catch (e) {
        log.error("media-library-filter: lib check exception: " + e);
        incCounter("allowed_error");
        return { allow: true, reason: "exception", fc: fc };
    }

    if (!libStatus.hit && libStatus.reason === "deadline") {
        incCounter("allowed_error");
        return { allow: true, reason: "deadline", fc: fc };
    }

    var copies = isArray(libStatus.copies) ? libStatus.copies : [];

    if (copies.length === 0) {
        incCounter("allowed_not_in_lib");
        return { allow: true, reason: "not_in_lib", fc: fc, lib: libStatus };
    }

    if (anyCopyMatchesTags(copies, tags, fc.dims)) {
        incCounter("vetoed");
        return { allow: false, reason: "in_lib_match", fc: fc, lib: libStatus };
    }

    incCounter("allowed_no_match");
    return { allow: true, reason: "no_match", fc: fc, lib: libStatus };
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

// 检查 bitmap 第 ep 集是否已标记
function getBitmapBit(bytes, ep) {
    if (ep <= 0) return false;
    var byteIdx = (ep - 1) >> 3;
    var bitIdx = (ep - 1) & 7;
    if (byteIdx >= bytes.length) return false;
    return (bytes[byteIdx] & (1 << bitIdx)) !== 0;
}

// Emby 批量拉取：一次拉全季 episodes，返回 { epMap, source } 或 null
function embyBatchFetch(tmdbID, season, epStart, epEnd, deadlineMs) {
    var url = config.get("emby_url");
    var key = config.get("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return null;

    // 找 series
    var seriesUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        IncludeItemTypes: "Series",
        AnyProviderIdEquals: "tmdb." + tmdbID,
        Fields: "ProviderIds",
        Limit: 5
    });
    var sr = embyGet(seriesUrl);
    if (!sr.ok) return null;
    var sItems = (sr.body && sr.body.Items) || [];
    var seriesID = "";
    for (var si = 0; si < sItems.length; si++) {
        var sItem = sItems[si] || {};
        var spid = sItem.ProviderIds || {};
        if (String(spid.Tmdb || spid.tmdb || "") === String(tmdbID)) {
            seriesID = sItem.Id || sItem.ID || "";
            break;
        }
    }
    if (!nonEmpty(String(seriesID))) return null;
    if (deadlineMs && nowMs() > deadlineMs) return null;

    // 一次拉全季
    var epUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        ParentId: seriesID,
        IncludeItemTypes: "Episode",
        Fields: "MediaSources,ParentIndexNumber,IndexNumber,Path",
        Limit: 2000
    });
    var er = embyGet(epUrl);
    if (!er.ok) return null;
    var eItems = (er.body && er.body.Items) || [];

    // 按集号索引
    var epMap = {};
    for (var ei = 0; ei < eItems.length; ei++) {
        var eItem = eItems[ei] || {};
        var pSeason = safeNum(String(eItem.ParentIndexNumber), -1);
        var pEpisode = safeNum(String(eItem.IndexNumber), -1);
        if (pSeason === season && pEpisode >= epStart && pEpisode <= epEnd) {
            if (!epMap[pEpisode]) epMap[pEpisode] = [];
            var copies = embyItemCopies(eItem);
            for (var ci = 0; ci < copies.length; ci++) {
                epMap[pEpisode].push(copies[ci]);
            }
        }
    }
    return { epMap: epMap, source: "emby" };
}

// Plex 批量拉取：返回 { epMap, source } 或 null
function plexBatchFetch(tmdbID, season, epStart, epEnd, deadlineMs) {
    var url = config.get("plex_url");
    var token = config.get("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return null;

    // 找 series（按 tmdb guid）
    var searchUrl = joinUrl(url, "/library/all") + "?" + qs({
        "X-Plex-Token": token,
        type: 2,
        includeGuids: 1
    });
    var sr = plexGet(searchUrl);
    if (!sr.ok) return null;
    var shows = (sr.body && sr.body.MediaContainer && sr.body.MediaContainer.Metadata) || [];
    var showKey = "";
    for (var si = 0; si < shows.length; si++) {
        if (plexMetaTmdb(shows[si]) === String(tmdbID)) {
            showKey = String((shows[si] || {}).ratingKey || "");
            break;
        }
    }
    if (!nonEmpty(String(showKey))) return null;
    if (deadlineMs && nowMs() > deadlineMs) return null;

    // 拉全季 episodes（与单集路径 checkPlexEpisode 同构）
    var epUrl = joinUrl(url, "/library/metadata/" + showKey + "/allLeaves") + "?" + qs({
        "X-Plex-Token": token,
        includeGuids: 1
    });
    var er = plexGet(epUrl);
    if (!er.ok) return null;
    var eItems = (er.body && er.body.MediaContainer && er.body.MediaContainer.Metadata) || [];

    var epMap = {};
    for (var ei = 0; ei < eItems.length; ei++) {
        var eItem = eItems[ei] || {};
        var pSeason = safeNum(String(eItem.parentIndex), -1);
        var pEpisode = safeNum(String(eItem.index), -1);
        if (pSeason === season && pEpisode >= epStart && pEpisode <= epEnd) {
            if (!epMap[pEpisode]) epMap[pEpisode] = [];
            var copies = plexItemCopies(eItem);
            for (var ci = 0; ci < copies.length; ci++) {
                epMap[pEpisode].push(copies[ci]);
            }
        }
    }
    return { epMap: epMap, source: "plex" };
}

// 合集主判定：返回 { allow, have_bitmap_bytes, reason }
function decideShouldDownloadBatch(p) {
    incCounter("should_download_seen");

    var media = (p && p.media) || {};
    var tags = (p && p.tags) || {};
    var flowID = (p && p.flow_id != null) ? p.flow_id : "";

    var tmdbID = media.tmdb_id == null ? "" : String(media.tmdb_id);
    var tmdbType = trim(media.tmdb_type) || "tv";
    var season = safeNum(String(media.season == null ? "" : media.season), 0);
    var epStart = safeNum(String(media.episode == null ? "" : media.episode), 0);
    var epEnd = safeNum(String(media.episode_end == null ? "" : media.episode_end), 0);

    var fc = flowConfig(flowID);

    if (!fc.enabled) return { allow: true, reason: "flow_disabled" };
    if (!fc.dims || dimCount(fc.dims) === 0) { incCounter("allowed_no_dims"); return { allow: true, reason: "no_dims" }; }
    if (!isEnabled("emby_enabled") && !isEnabled("plex_enabled")) return { allow: true, reason: "no_backend" };
    if (!nonEmpty(tmdbID)) { incCounter("allowed_no_tmdb"); return { allow: true, reason: "no_tmdb" }; }
    if (epStart <= 0 || epEnd <= 0 || epEnd < epStart) return { allow: true, reason: "invalid_range" };

    // tag 端空值短路
    for (var dim in fc.dims) {
        if (!fc.dims.hasOwnProperty(dim)) continue;
        if (!tagHasValue(tags[dim])) {
            incCounter("allowed_tag_empty");
            return { allow: true, reason: "tag_empty", empty_dim: dim };
        }
    }

    // ---- 缓存快路径：全部集命中缓存 → 跳过 HTTP ----
    var allCached = true;
    var epMap = {};
    for (var cep = epStart; cep <= epEnd; cep++) {
        var cKey = cacheKey(tmdbType, tmdbID, season, cep);
        var cached = readCache(cKey);
        if (cached && cacheFresh(cached) && isArray(cached.copies)) {
            epMap[cep] = cached.copies;
        } else {
            allCached = false;
            break;
        }
    }

    var source = "cache";

    if (!allCached) {
        // ---- HTTP 批量拉取 ----
        var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
        var fetchResult = null;

        if (isEnabled("emby_enabled")) {
            fetchResult = embyBatchFetch(tmdbID, season, epStart, epEnd, deadline);
        }
        if (fetchResult === null && isEnabled("plex_enabled")) {
            fetchResult = plexBatchFetch(tmdbID, season, epStart, epEnd, deadline);
        }

        if (fetchResult === null) {
            incCounter("allowed_error");
            return { allow: true, reason: "batch_check_failed" };
        }

        epMap = fetchResult.epMap;
        source = fetchResult.source;

        // 逐集写缓存（与单集路径 resolveLibraryStatus 格式一致）
        for (var wep = epStart; wep <= epEnd; wep++) {
            var wKey = cacheKey(tmdbType, tmdbID, season, wep);
            writeCache(wKey, {
                copies: epMap[wep] || [],
                source: source,
                ts: nowSec()
            });
        }
    }

    // ---- 构建 bitmap ----
    var haveBytes = [];
    for (var bep = epStart; bep <= epEnd; bep++) {
        var copies = epMap[bep];
        if (copies && copies.length > 0 && anyCopyMatchesTags(copies, tags, fc.dims)) {
            setBitmapBit(haveBytes, bep);
        }
    }

    // 统计 have 数量
    var haveCount = 0;
    var totalEps = epEnd - epStart + 1;
    for (var sep = epStart; sep <= epEnd; sep++) {
        if (getBitmapBit(haveBytes, sep)) haveCount++;
    }

    if (haveCount === totalEps) {
        incCounter("vetoed");
        return { allow: false, reason: "batch_all_in_lib" };
    }
    if (haveCount === 0) {
        incCounter("allowed_not_in_lib");
        return { allow: true, reason: "batch_none_in_lib" };
    }

    incCounter("batch_partial_filtered");
    return { allow: true, reason: "batch_partial", have_bitmap_bytes: haveBytes, have_count: haveCount, total: totalEps };
}


// ====== Hook 注册 ======

plugin.on("should_download", function (p) {
    try {
        var media = (p && p.media) || {};
        var episodeEnd = safeNum(String(media.episode_end == null ? "" : media.episode_end), 0);
        var dryRun = isEnabled("dry_run");

        // ---- 合集路径：episode_end > 0 → bitmap 协议 ----
        if (episodeEnd > 0) {
            var db = decideShouldDownloadBatch(p || {});
            log.info("media-library-filter: should_download [batch] flow=" + (p && p.flow_id) +
                     " tmdb=" + (media.tmdb_id || "") + " s" + (media.season || 0) +
                     " e" + (media.episode || 0) + "-" + episodeEnd +
                     " reason=" + db.reason +
                     (db.have_count != null ? " have=" + db.have_count + "/" + db.total : "") +
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
        var d = decideShouldDownload(p || {});
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
        log.error("media-library-filter: should_download handler error: " + e);
        incCounter("allowed_error");
        return true;
    }
});

// ====== 自定义 API ======

plugin.registerAPI("/flows", function (req) {
    if (typeof ruleflow !== "object" || !ruleflow || typeof ruleflow.list !== "function") {
        return { ok: false, error: "ruleflow unavailable (need api.ruleflow permission)", flows: [] };
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
    return {
        config: {
            emby_enabled: isEnabled("emby_enabled"),
            emby_configured: !!(config.get("emby_url") && config.get("emby_api_key")),
            plex_enabled: isEnabled("plex_enabled"),
            plex_configured: !!(config.get("plex_url") && config.get("plex_token")),
            cache_ttl_sec: cacheTtlSec(),
            dry_run: isEnabled("dry_run")
        },
        counters: {
            should_download_seen: safeNum(config.get("should_download_seen"), 0),
            vetoed: safeNum(config.get("vetoed"), 0),
            allowed_not_in_lib: safeNum(config.get("allowed_not_in_lib"), 0),
            allowed_no_tmdb: safeNum(config.get("allowed_no_tmdb"), 0),
            allowed_no_match: safeNum(config.get("allowed_no_match"), 0),
            allowed_no_dims: safeNum(config.get("allowed_no_dims"), 0),
            allowed_tag_empty: safeNum(config.get("allowed_tag_empty"), 0),
            allowed_error: safeNum(config.get("allowed_error"), 0),
            dry_run_would_veto: safeNum(config.get("dry_run_would_veto"), 0),
            batch_partial_filtered: safeNum(config.get("batch_partial_filtered"), 0),
            cache_write_fail: cache_write_fail
        },
        errors: {
            emby_last_error: config.get("emby_last_error") || "",
            emby_last_error_at: config.get("emby_last_error_at") || "",
            plex_last_error: config.get("plex_last_error") || "",
            plex_last_error_at: config.get("plex_last_error_at") || ""
        }
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
                var tagValue = tags ? tags[dim] : undefined;
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

plugin.registerAPI("/check", function (req) {
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
    var r = performLibraryCheck(tmdbType, tmdbID, season, episode, deadline);
    var realCopies = isArray(r.copies) ? r.copies : [];

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

plugin.registerAPI("/test-emby", function (req) {
    var url = config.get("emby_url");
    var key = config.get("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, error: "url/api_key missing" };
    try {
        var resp = http.get(joinUrl(url, "/emby/System/Info/Public"), { "Accept": "application/json" });
        return {
            ok: !!(resp && resp.status >= 200 && resp.status < 300),
            status: resp && resp.status,
            body_preview: ((resp && resp.body) || "").substring(0, 200)
        };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

plugin.registerAPI("/test-plex", function (req) {
    var url = config.get("plex_url");
    var token = config.get("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, error: "url/token missing" };
    try {
        var resp = http.get(joinUrl(url, "/identity") + "?" + qs({ "X-Plex-Token": token }), { "Accept": "application/json" });
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
        cache_ttl_sec: 1, dry_run: 1
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
    return { ok: true, written: written };
});

log.info("media-library-filter loaded (like-for-like dedup; emby=" + isEnabled("emby_enabled") +
         " plex=" + isEnabled("plex_enabled") +
         " dry_run=" + isEnabled("dry_run") + ")");
