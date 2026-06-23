// media-library-filter —— 下载否决器（should_download）
//
// 自 FollowCat 主仓新增同步否决 hook `should_download` 起，本插件在 ruleflow 把种子
// 推给 qBittorrent **之前**同步查询 Emby / Plex 媒体库：若该集已按**用户为该 ruleflow
// 配置的规格**存在（库内任意一份副本在所有已配维度上都符合规格），则 `return false`
// 跳过下载（种子记 excluded），否则放行。
//
// 关键语义（「等于配置规格才算有」，非「门槛 ≥」）：
//   * 规格维度跟随 hook `p.tags` 全集（12 维，见下），每维可配可不配；未配维度不参与判定。
//   * like-for-like 等值比对：副本在该维度的观测值 == 规格声明值；分辨率按**档位相等**比
//     （1080p 档 = 1080p 档），不是 ≥。库里 4K 不挡收 1080p 的 flow（两条 flow 互不干扰）。
//   * 逐副本评估：同一集库内可有多份副本，**任意一份全维度符合**即算「有」→ return false。
//   * 已配维度在副本上观测/解析不出 → 该副本该维度判不符合 → 不算有 → 照常推（宁多推不误杀）。
//   * 只有"确认库里已按该 flow 规格存在该集"才 return false；
//     true / undefined / 非布尔 / 抛错 / 超时 一律 fail-open（照常下载）。
//   * 硬超时 3s：库查询整体预算 ≤2500ms，逼近预算即放行；外部库宕机不拖垮下载管线。
//   * tmdb_id 缺失（Mikan 源常见）→ 无法精确查库 → 放行（不做标题近似兜底，避免误杀）。
//
// === spec 三态（fail-open 不可侵犯）===
//   * 显式 any（flow_<id>_spec === "{}"）：用户故意不勾任何维度 → 库里有任意副本即否决。
//   * 未配置（flow_<id>_spec 键缺失）/ 损坏（JSON 解析失败）→ 视为未配置 → 一律放行，绝不 veto。
//   * 正常（含 ≥1 白名单维度的合法 JSON）→ 走逐副本逐维比对。
//
// === 维度观测方式分三档（解析不出一律按「不符合」处理）===
//   * 可靠（实体属性，Emby MediaStreams / Plex Media）：resolution / hdr / dv /
//     video_encode(Codec) / audio_encode / code_bits(BitDepth)。
//   * 尽力（库内文件名 / Path 解析）：group（[组名] 标签）、source（WEB-DL/BluRay 等关键字）。
//   * 几乎不可（文件名时有时无）：format / language / special_content / part_alias。
//
// === 全局配置 key（管理页 → 插件 → 设置） ===
//
//   emby_enabled   "1" 启用 Emby 检查
//   emby_url       Emby 根 URL（不带尾斜杠），例：http://192.168.1.10:8096
//   emby_api_key   Emby API Key（建议 is_secret=true，需可读 Path 字段）
//
//   plex_enabled   "1" 启用 Plex 检查
//   plex_url       Plex 根 URL，例：http://192.168.1.10:32400
//   plex_token     X-Plex-Token（建议 is_secret=true）
//
//   cache_ttl_sec  库查询结果缓存 TTL，默认 3600 秒（1 小时）
//   dry_run        "1" 仅日志记录决策、永远 return true（不真正否决）
//
// === per-flow 配置 key（flow_id 来自 ruleflow.list()） ===
//
//   flow_<id>_enabled   "1" 启用本 flow 否决（缺失/非 "1" → 永远推，不干预）
//   flow_<id>_spec      规格 JSON，仅含已勾选的白名单维度键，例：
//                       {"resolution":"1080p","group":"桜都"}
//                       "{}" = 显式 any（库里有任意副本即否决）；键缺失/损坏 = 放行
//
// === 自定义 API ===
//
//   GET  /api/plugins/<id>/api/flows        ruleflow.list() + 每条 {enabled, spec, specState}
//   GET  /api/plugins/<id>/api/stats        配置摘要 + 计数器 + last_error
//   GET  /api/plugins/<id>/api/check        真实查库 trace（?tmdb_id=&season=&episode=[&tmdb_type=&flow_id=]）
//   POST /api/plugins/<id>/api/check        mock 注入：body {mock_copies, spec} 或 {flow_id} → would_decision + 逐维 trace（绕过真实查库）
//   POST /api/plugins/<id>/api/save-config  批量保存配置（全局键 + 动态 flow_* 键白名单 + spec 写入边界校验）
//   POST /api/plugins/<id>/api/test-emby    探测 Emby 连通性
//   POST /api/plugins/<id>/api/test-plex    探测 Plex 连通性
//
// === 设计要点 ===
//
//   1. should_download 全程 try/catch；任何异常/超时/不确定/spec 损坏或未配 → 不返回 false（fail-open）
//   2. 每个 http.* 都 try/catch + 软预算检查；外部库不可达即放行
//   3. 缓存 key 带集号（tmdb_id+季+集），缓存值只存「副本事实列表」不存结论，命中后现场比对
//   4. 维度按三档观测：实体属性可靠比对，group/source 经文件名「尽力」解析，几乎不可档解析不出按不符合

// ====== 常量与工具 ======

var CACHE_PREFIX = "lib_cache_";
var DEFAULT_CACHE_TTL_SEC = 3600;

// should_download 硬超时 3s；库查询整体预算 ≤2500ms，留 ~500ms 裕量
var LIB_CHECK_SOFT_BUDGET_MS = 2500;

// 规格维度全集（对齐 hook p.tags / sdk.md:91-94），用于 sanitizeSpec 白名单与写入边界校验
var SPEC_DIMS = [
    "resolution", "video_encode", "audio_encode", "code_bits", "hdr", "dv",
    "format", "language", "source", "group", "special_content", "part_alias"
];

// spec JSON 解析哨兵：用于区分「显式 {} = 故意 any」与「解析失败 = 损坏降级」。
// 必须是唯一对象引用，绝不是 {}（否则两种语义又撞同一状态）。
var SPEC_PARSE_SENTINEL = {};

// 缓存写失败计数（config 单值配额超限等）——并入 /stats，便于观测缓存静默失效。
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

// percent-encode：goja 没有 URLSearchParams；用 encodeURIComponent 即可
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

// ====== 规格数据模型与比对工具（纯函数，无副作用） ======

// 由 Width/Height 推断分辨率高度（取较保守的"高度"语义：用 Height，缺则按 Width/16*9 近似）
function pixelHeight(width, height) {
    var h = safeNum(String(height || ""), 0);
    if (h > 0) return h;
    var w = safeNum(String(width || ""), 0);
    if (w > 0) return Math.round(w * 9 / 16);
    return 0;
}

// 分辨率单向（只向下）归档：把像素高归到最近的不高于它的标准档，绝不向上归档。
// >=1800 → "2160p"；>=900(且<1800) → "1080p"；>=600(且<900) → "720p"；否则 null（不属任何档）。
// 关键性质：3840×1600 这类 4K 裁切片落 "1080p" 档——单向归档不可消除的边界代价，由 /check
// trace 暴露 height_raw 让用户人工识别。null 与任何规格档位字符串都不相等 → resolution 维度判不符合。
function resolutionBucket(height) {
    var h = safeNum(String(height == null ? "" : height), 0);
    if (h >= 1800) return "2160p";
    if (h >= 900) return "1080p";
    if (h >= 600) return "720p";
    return null;
}

// VideoRange 归一：Emby 用 "SDR" / "HDR10" / "HDR" / "Dolby Vision" / "DOVI" 等
function rangeFlags(videoRange) {
    var v = String(videoRange || "").toLowerCase();
    var isDV = v.indexOf("dolby") >= 0 || v.indexOf("dovi") >= 0 || v.indexOf("dv") >= 0;
    var isHDR = isDV || v.indexOf("hdr") >= 0;
    return { hdr: isHDR, dv: isDV };
}

// 从文件名 basename 尽力解析 group（首个 [...] 标签）与 source（来源关键字归一）。
// 解析不出对应字段返回 null（不是 undefined，便于纯标量缓存）。
function parseFilenameTags(basename) {
    var name = String(basename == null ? "" : basename);
    var group = null;
    var m = name.match(/\[([^\]]+)\]/);
    if (m && m[1]) group = m[1];

    var source = null;
    var lower = name.toLowerCase();
    // 顺序敏感：先判更具体的关键字（remux/web-dl/bdrip）再退到泛化的（web/bluray）。
    if (lower.indexOf("remux") >= 0) source = "Remux";
    else if (lower.indexOf("web-dl") >= 0 || lower.indexOf("webdl") >= 0) source = "WEB-DL";
    else if (lower.indexOf("bdrip") >= 0) source = "BDRip";
    else if (lower.indexOf("blu-ray") >= 0 || lower.indexOf("bluray") >= 0) source = "BluRay";
    else if (lower.indexOf("hdtv") >= 0) source = "HDTV";
    else if (lower.indexOf("web") >= 0) source = "WEB";

    return { group: group, source: source };
}

// 取路径 basename（ES5）：去掉最后一个 / 或 \ 之前的部分。
function pathBasename(p) {
    return String(p == null ? "" : p).replace(/^.*[\/\\]/, "") || "";
}

// 字符串维度归一比较（大小写/空白无关），用于编码等可靠档与尽力档的字符串值。
function strEq(observed, want) {
    if (observed === null || observed === undefined) return false;
    return trim(String(observed)).toLowerCase() === trim(String(want)).toLowerCase();
}

// 把规格里的布尔取值统一成 true/false（接受 "1"/"0"/true/false/"true"/"false"）。
function specBool(v) {
    if (v === true) return true;
    if (v === false) return false;
    var s = trim(String(v == null ? "" : v)).toLowerCase();
    return s === "1" || s === "true" || s === "yes";
}

// 单副本逐已配维度比对规格。任一已配维度观测/解析不出或不等 → false（AC4 fail-open 方向）。
// copy 是纯标量副本对象（embyItemCopies/plexItemCopies 产出）。
function copyMatchesSpec(copy, spec) {
    if (!copy || typeof copy !== "object") return false;
    if (!spec || typeof spec !== "object") return false;
    for (var dim in spec) {
        if (!spec.hasOwnProperty(dim)) continue;
        var want = spec[dim];
        if (want === null || want === undefined || want === "") continue; // 空值视为未配该维度
        if (dim === "resolution") {
            if (resolutionBucket(copy.height) !== String(want)) return false;
        } else if (dim === "hdr") {
            if (!!copy.hdr !== specBool(want)) return false;
        } else if (dim === "dv") {
            if (!!copy.dv !== specBool(want)) return false;
        } else if (dim === "video_encode") {
            if (!strEq(copy.video_codec, want)) return false;
        } else if (dim === "audio_encode") {
            if (!strEq(copy.audio_codec, want)) return false;
        } else if (dim === "code_bits") {
            // bit_depth 是数字（8/10/12）；规格可写 "10" 或 "10bit" → 归一成数字比
            var wantBits = safeNum(String(want).replace(/[^0-9]/g, ""), -1);
            var obsBits = safeNum(String(copy.bit_depth == null ? "" : copy.bit_depth), -1);
            if (wantBits < 0 || obsBits < 0 || obsBits !== wantBits) return false;
        } else if (dim === "group") {
            if (!strEq(copy.group, want)) return false;
        } else if (dim === "source") {
            if (!strEq(copy.source, want)) return false;
        } else {
            // format / language / special_content / part_alias：几乎不可档，副本无对应观测字段
            // → 解析不出 → 不符合。
            if (!strEq(copy[dim], want)) return false;
        }
    }
    return true;
}

// 多副本判定。spec 为显式空对象 {} → "copies.length>0 即 true"（AC5 显式 any）；
// 否则任一副本全维度符合即 true（AC8）。
// 注意：本函数只看「传入的 spec 是不是 {}」，不负责区分「显式 any」与「损坏降级」——
// 该区分由 decide 层在调用前完成（损坏/未配根本不会喂 {} 进来），故收到 {} 一定是显式 any。
function specDimCount(spec) {
    var n = 0;
    if (spec && typeof spec === "object") {
        for (var k in spec) {
            if (spec.hasOwnProperty(k) && spec[k] !== null && spec[k] !== undefined && spec[k] !== "") n++;
        }
    }
    return n;
}

function anyCopyMatches(copies, spec) {
    if (!isArray(copies) || copies.length === 0) return false;
    if (specDimCount(spec) === 0) return true; // 显式 any：有任意副本即算「有」
    for (var i = 0; i < copies.length; i++) {
        if (copyMatchesSpec(copies[i], spec)) return true;
    }
    return false;
}

// ====== 缓存（config.*；key 含 tmdb_id+季+集 → {copies, source, ts}，只存事实不存结论） ======

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
//
// TV：先按 series 的 ProviderIds.Tmdb 定位剧集，再按 ParentIndexNumber(季)/IndexNumber(集) 过滤。
// movie：直接按 tmdb_id 查 Movie。
// 取副本：Fields=ProviderIds,MediaSources,Path → 每个 MediaSources[] 一条副本，从其 MediaStreams[]
// 取 Video 流 Width/Height/VideoRange/Codec/BitDepth、Audio 流 Codec；filename 取 MediaSources[].Path
// 或 item.Path 的 basename，提取期即用 parseFilenameTags 解析 group/source。
//
// 命中返回 { ok:true, hit:true, source:"emby", copies:[...] }，未命中 { ok:true, hit:false }，
// 故障 { ok:false, hit:false, reason }。

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

// 从一个 Emby item 提取逐副本事实列表。
// 【硬约束】每个副本对象只含 string/number/boolean/null 纯标量，绝不引用 MediaStreams/MediaSources
// 原对象（防 JSON.stringify 循环引用抛 TypeError）。group/source 在提取期解析好存入。
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
        var basename = pathBasename(src.Path || itemPath);
        var tagged = parseFilenameTags(basename);
        copies.push({
            height: height,
            hdr: hdr,
            dv: dv,
            video_codec: videoCodec,
            audio_codec: audioCodec,
            bit_depth: bitDepth,
            filename: basename,
            group: tagged.group,
            source: tagged.source
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

    // TV：先按 series tmdb 定位 Series
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

    // 再查该剧集的 Episodes，按季/集过滤
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
//
// 用 /library/all 按 tmdb guid 过滤；TV 命中 show 后再取该季该集。
// 取副本：每个 Media[] 一条副本，分辨率 videoResolution、HDR/DV 看 videoProfile/colorTrc 与
// Part[].Stream[]，filename 取 Media[].Part[].file 的 basename，提取期即 parseFilenameTags。

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

// 从一个 Plex meta 提取逐副本事实列表。
// 【硬约束】每个副本对象只含纯标量，绝不引用 Media/Part 原对象。
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
        var tagged = parseFilenameTags(filename);
        copies.push({
            height: height,
            hdr: flags.hdr,
            dv: flags.dv,
            video_codec: videoCodec,
            audio_codec: audioCodec,
            bit_depth: bitDepth,
            filename: filename,
            group: tagged.group,
            source: tagged.source
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

    // TV：type=2 找 show
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

    // 取该 show 全部 episodes（allLeaves）
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

// ====== 主库检查：Emby 优先，Plex 兜底 ======

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

// 综合：先查缓存（只存副本事实），未命中再调外部库；命中或未命中都写回缓存（外部故障除外）
function resolveLibraryStatus(tmdbType, tmdbID, season, episode) {
    var key = cacheKey(tmdbType, tmdbID, season, episode);
    var cached = readCache(key);
    if (cached && cacheFresh(cached)) {
        var copies = cached.copies;
        // C2 守卫：旧结构（{has,height,hdr,dv,ts}）无 copies / copies 非数组 → 视为 miss 重查，
        // 绝不碰 undefined.length（CLAUDE.md：touching undefined.length will panic）。
        if (isArray(copies)) {
            return {
                hit: copies.length > 0,
                copies: copies,
                source: cached.source || "",
                from_cache: true
            };
        }
        // 非数组（旧结构残留 / 损坏）→ 落空，走真实查库重写新结构缓存
    }
    var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
    var r = performLibraryCheck(tmdbType, tmdbID, season, episode, deadline);

    // 仅当查询过程没有遇到外部故障（deadline / http 错误）时才写缓存，避免把"暂时查不到"固化
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

// ====== per-flow 规格配置（决策 A1：flow_<id>_enabled + flow_<id>_spec 单键 JSON） ======

// 只保留键 ∈ SPEC_DIMS 且值非空的项（白名单维度，防脏数据）。也用于写入边界校验。
function sanitizeSpec(obj) {
    var out = {};
    if (!obj || typeof obj !== "object") return out;
    for (var i = 0; i < SPEC_DIMS.length; i++) {
        var dim = SPEC_DIMS[i];
        if (!obj.hasOwnProperty(dim)) continue;
        var v = obj[dim];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && trim(v) === "") continue;
        out[dim] = v;
    }
    return out;
}

// 三态读取（C1）：返回 {enabled, spec, specState}。
//   specState: "unset"（spec 键缺失）/ "explicit_any"（"{}" 显式 any）/
//              "corrupt"（JSON 解析失败）/ "normal"（合法含维度）。
// 关键：corrupt 与 unset 都不喂 {} 给比对层 → decide 层据 specState 走 allow 短路，杜绝误 veto。
function flowConfig(flowID) {
    var id = String(flowID == null ? "" : flowID);
    var prefix = "flow_" + id + "_";
    var enabled = config.get(prefix + "enabled") === "1";
    var raw = config.get(prefix + "spec");

    if (raw === null || raw === undefined) {
        return { enabled: enabled, spec: null, specState: "unset" };
    }
    if (trim(raw) === "{}") {
        return { enabled: enabled, spec: {}, specState: "explicit_any" };
    }
    var parsed = safeJsonParse(raw, SPEC_PARSE_SENTINEL);
    if (parsed === SPEC_PARSE_SENTINEL || !parsed || typeof parsed !== "object") {
        return { enabled: enabled, spec: null, specState: "corrupt" };
    }
    var clean = sanitizeSpec(parsed);
    if (specDimCount(clean) === 0) {
        // 解析成功但清洗后无任何有效维度 → 等价显式 any（避免 normal 但 spec={} 的二义）
        return { enabled: enabled, spec: {}, specState: "explicit_any" };
    }
    return { enabled: enabled, spec: clean, specState: "normal" };
}

// ====== should_download 主判定 ======
//
// 返回 {allow, reason, ...}。allow=true 放行 / allow=false 否决。任何不确定都 allow。

function decideShouldDownload(p) {
    incCounter("should_download_seen");

    var media = (p && p.media) || {};
    var flowID = (p && p.flow_id != null) ? p.flow_id : "";

    var tmdbID = media.tmdb_id == null ? "" : String(media.tmdb_id);
    var tmdbType = trim(media.tmdb_type) || "tv";
    var season = safeNum(String(media.season == null ? "" : media.season), 0);
    var episode = safeNum(String(media.episode == null ? "" : media.episode), 0);

    var fc = flowConfig(flowID);

    // 本 flow 未启用否决 → 永远推（AC5）
    if (!fc.enabled) {
        return { allow: true, reason: "flow_disabled", fc: fc };
    }

    // spec 三态短路（C1，在查库/比对之前）：未配置 / 损坏 → 一律放行，绝不 veto（fail-open 不可侵犯）
    if (fc.specState === "unset" || fc.specState === "corrupt") {
        incCounter("allowed_spec_unset");
        return { allow: true, reason: "spec_unset", fc: fc };
    }

    // 无后端启用 → 放行
    if (!isEnabled("emby_enabled") && !isEnabled("plex_enabled")) {
        return { allow: true, reason: "no_backend", fc: fc };
    }

    // tmdb_id 缺失 → 无法精确查库 → 放行
    if (!nonEmpty(tmdbID)) {
        incCounter("allowed_no_tmdb");
        return { allow: true, reason: "no_tmdb", fc: fc };
    }

    var libStatus;
    try {
        libStatus = resolveLibraryStatus(tmdbType, tmdbID, season, episode);
    } catch (e) {
        log.error("media-library-filter: lib check exception: " + e);
        incCounter("allowed_error");
        return { allow: true, reason: "exception", fc: fc };
    }

    // 查询遇到外部故障且未命中 → fail-open
    if (!libStatus.hit && libStatus.reason === "deadline") {
        incCounter("allowed_error");
        return { allow: true, reason: "deadline", fc: fc };
    }

    var copies = isArray(libStatus.copies) ? libStatus.copies : [];

    // 库里没有这一集任何副本 → 放行
    if (copies.length === 0) {
        incCounter("allowed_not_in_lib");
        return { allow: true, reason: "not_in_lib", fc: fc, lib: libStatus };
    }

    // 命中：按当前 flow 规格逐副本现场比对
    if (anyCopyMatches(copies, fc.spec)) {
        incCounter("vetoed");
        return {
            allow: false,
            reason: fc.specState === "explicit_any" ? "in_lib_any" : "in_lib_spec",
            fc: fc,
            lib: libStatus
        };
    }
    // 库内副本无一全维度符合规格 → 放行（去下符合规格的）
    incCounter("allowed_spec_mismatch");
    return { allow: true, reason: "spec_mismatch", fc: fc, lib: libStatus };
}

// 概要库内命中信息（hook 日志用）：copies 数量 + 命中维度概要。
function libSummary(d) {
    if (!d.lib) return "";
    var copies = isArray(d.lib.copies) ? d.lib.copies : [];
    var s = " lib=" + (d.lib.source || "") + " copies=" + copies.length;
    var dims = (d.fc && d.fc.spec) ? specDimCount(d.fc.spec) : 0;
    s += " spec_dims=" + dims;
    if (d.lib.from_cache) s += " cache";
    return s;
}

// ====== Hook 注册 ======

plugin.on("should_download", function (p) {
    try {
        var d = decideShouldDownload(p || {});
        var media = (p && p.media) || {};
        var dryRun = isEnabled("dry_run");
        log.info("media-library-filter: should_download flow=" + (p && p.flow_id) +
                 " tmdb=" + (media.tmdb_id || "") + " s" + (media.season || 0) + "e" + (media.episode || 0) +
                 " specState=" + (d.fc ? d.fc.specState : "") + " reason=" + d.reason +
                 " decision=" + (d.allow ? "allow" : "veto") + libSummary(d) +
                 (dryRun && !d.allow ? " [dry_run→allow]" : ""));

        // dry_run：只 log 决策、永远放行
        if (dryRun) return true;
        if (d.allow === false) return false;
        return true;
    } catch (e) {
        // 任何异常 → fail-open
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
    // 附带每条 flow 当前配置，UI 一次拿全
    var out = [];
    for (var j = 0; j < flows.length; j++) {
        var fc = flowConfig(flows[j].id);
        out.push({
            id: flows[j].id,
            name: flows[j].name,
            enabled: fc.enabled,
            spec: fc.spec,
            specState: fc.specState
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
            allowed_spec_mismatch: safeNum(config.get("allowed_spec_mismatch"), 0),
            allowed_spec_unset: safeNum(config.get("allowed_spec_unset"), 0),
            allowed_error: safeNum(config.get("allowed_error"), 0),
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

// 逐副本逐维 trace 生成（GET 真实查库 / POST mock 共用）。
function buildCopyTrace(copies, spec) {
    var out = [];
    var arr = isArray(copies) ? copies : [];
    for (var i = 0; i < arr.length; i++) {
        var copy = arr[i] || {};
        var dimTrace = {};
        var matchAll = true;
        if (spec && typeof spec === "object") {
            for (var dim in spec) {
                if (!spec.hasOwnProperty(dim)) continue;
                var want = spec[dim];
                if (want === null || want === undefined || want === "") continue;
                var observed;
                if (dim === "resolution") observed = resolutionBucket(copy.height);
                else if (dim === "hdr") observed = !!copy.hdr;
                else if (dim === "dv") observed = !!copy.dv;
                else if (dim === "video_encode") observed = copy.video_codec;
                else if (dim === "audio_encode") observed = copy.audio_codec;
                else if (dim === "code_bits") observed = copy.bit_depth;
                else if (dim === "group") observed = copy.group;
                else if (dim === "source") observed = copy.source;
                else observed = (copy[dim] === undefined ? null : copy[dim]);
                var ok = copyMatchesSpec(copy, makeSingleDimSpec(dim, want));
                if (!ok) matchAll = false;
                dimTrace[dim] = { want: want, observed: (observed === undefined ? null : observed), match: ok };
            }
        }
        out.push({
            height_raw: copy.height || 0,
            bucket: resolutionBucket(copy.height),
            hdr: !!copy.hdr,
            dv: !!copy.dv,
            video_codec: (copy.video_codec === undefined ? null : copy.video_codec),
            audio_codec: (copy.audio_codec === undefined ? null : copy.audio_codec),
            bit_depth: (copy.bit_depth === undefined ? null : copy.bit_depth),
            filename: copy.filename || "",
            parsed_group: (copy.group === undefined ? null : copy.group),
            parsed_source: (copy.source === undefined ? null : copy.source),
            dims: dimTrace,
            match_all: matchAll
        });
    }
    return out;
}

function makeSingleDimSpec(dim, want) {
    var o = {};
    o[dim] = want;
    return o;
}

plugin.registerAPI("/check", function (req) {
    var method = (req && req.method) || "GET";

    // ---- POST /check：mock 注入（绕过真实查库，AC1-AC8/AC10 自动断言载体） ----
    if (method === "POST") {
        var body = safeJsonParse((req && req.body) || "", null);
        if (!body || typeof body !== "object") {
            return { ok: false, error: "POST body must be JSON {mock_copies, spec} or {flow_id}" };
        }

        var spec;
        var specState;
        if (body.flow_id != null) {
            var fc = flowConfig(body.flow_id);
            // flow 未启用 / spec 未配 / 损坏 → 直接 allow（对齐 decide 层三态短路）
            if (!fc.enabled) {
                return { ok: true, mode: "mock", flow_id: String(body.flow_id), specState: fc.specState,
                         would_decision: "allow", would_reason: "flow_disabled", copies: [] };
            }
            if (fc.specState === "unset" || fc.specState === "corrupt") {
                return { ok: true, mode: "mock", flow_id: String(body.flow_id), specState: fc.specState,
                         would_decision: "allow", would_reason: "spec_unset", copies: [] };
            }
            spec = fc.spec;
            specState = fc.specState;
        } else {
            // 直接喂 spec（可为 {} 表显式 any；缺失视为显式 any）
            spec = sanitizeSpec(body.spec || {});
            specState = specDimCount(spec) === 0 ? "explicit_any" : "normal";
        }

        var mockCopies = isArray(body.mock_copies) ? body.mock_copies : [];
        var allow, why;
        if (mockCopies.length === 0) { allow = true; why = "not_in_lib"; }
        else if (anyCopyMatches(mockCopies, spec)) {
            allow = false;
            why = specState === "explicit_any" ? "in_lib_any" : "in_lib_spec";
        } else { allow = true; why = "spec_mismatch"; }

        return {
            ok: true,
            mode: "mock",
            specState: specState,
            spec: spec,
            would_decision: allow ? "allow" : "veto",
            would_reason: why,
            copies: buildCopyTrace(mockCopies, spec)
        };
    }

    // ---- GET /check：真实查库 smoke（需真 Emby/Plex，人工冒烟） ----
    var q = (req && req.query) || {};
    var tmdbID = trim(q.tmdb_id);
    var tmdbType = trim(q.tmdb_type) || "tv";
    var season = safeNum(String(q.season == null ? "" : q.season), 0);
    var episode = safeNum(String(q.episode == null ? "" : q.episode), 0);
    var flowID = q.flow_id == null ? "" : String(q.flow_id);

    if (!nonEmpty(tmdbID)) {
        return { ok: false, error: "missing ?tmdb_id= (with optional &season=&episode=&tmdb_type=&flow_id=); or POST {mock_copies, spec}" };
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
        resp.flow_config = { enabled: gfc.enabled, spec: gfc.spec, specState: gfc.specState };
        var gAllow, gWhy;
        if (!gfc.enabled) { gAllow = true; gWhy = "flow_disabled"; }
        else if (gfc.specState === "unset" || gfc.specState === "corrupt") { gAllow = true; gWhy = "spec_unset"; }
        else if (realCopies.length === 0) { gAllow = true; gWhy = "not_in_lib"; }
        else if (anyCopyMatches(realCopies, gfc.spec)) {
            gAllow = false;
            gWhy = gfc.specState === "explicit_any" ? "in_lib_any" : "in_lib_spec";
        } else { gAllow = true; gWhy = "spec_mismatch"; }
        resp.would_decision = gAllow ? "allow" : "veto";
        resp.would_reason = gWhy;
        resp.copies = buildCopyTrace(realCopies, gfc.spec || {});
    } else {
        resp.copies = buildCopyTrace(realCopies, {});
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
    // UI 批量保存：req.body 是 JSON string 或 object
    var body = req && req.body;
    var obj = null;
    if (body && typeof body === "object") obj = body;
    else if (typeof body === "string" && body.length > 0) obj = safeJsonParse(body, null);
    if (!obj || typeof obj !== "object") {
        return { ok: false, error: "body must be a JSON object" };
    }

    // 全局键白名单
    var globalAllowed = {
        emby_enabled: 1, emby_url: 1, emby_api_key: 1,
        plex_enabled: 1, plex_url: 1, plex_token: 1,
        cache_ttl_sec: 1, dry_run: 1
    };
    // 动态 flow_* 键白名单：flow_<id>_(enabled|spec)
    var flowKeyRe = /^flow_.+_(enabled|spec)$/;
    var flowSpecRe = /^flow_.+_spec$/;

    var written = [];
    for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (!globalAllowed[k] && !flowKeyRe.test(k)) continue; // 非白名单忽略
        var v = obj[k];
        if (v === null || v === undefined) v = "";
        if (typeof v !== "string") v = String(v);

        // spec 写入边界校验（C1 第一道闸）：非法 JSON / 含非白名单维度键 → 拒写整体返回 error
        if (flowSpecRe.test(k)) {
            var parsed;
            try { parsed = JSON.parse(v); }
            catch (e) { return { ok: false, error: "flow spec invalid json", key: k, written: written }; }
            if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
                return { ok: false, error: "flow spec must be a json object", key: k, written: written };
            }
            // 含任何非白名单维度键 → 拒写
            for (var pk in parsed) {
                if (!parsed.hasOwnProperty(pk)) continue;
                var known = false;
                for (var di = 0; di < SPEC_DIMS.length; di++) {
                    if (SPEC_DIMS[di] === pk) { known = true; break; }
                }
                if (!known) return { ok: false, error: "flow spec has unknown dimension: " + pk, key: k, written: written };
            }
            // 规范化（剔空值）后写入；"{}" 合法保留为显式 any
            v = JSON.stringify(sanitizeSpec(parsed));
        }

        try { config.set(k, v); written.push(k); }
        catch (e2) { return { ok: false, error: "config.set failed for " + k + ": " + e2, written: written }; }
    }
    return { ok: true, written: written };
});

log.info("media-library-filter loaded (should_download veto; emby=" + isEnabled("emby_enabled") +
         " plex=" + isEnabled("plex_enabled") +
         " dry_run=" + isEnabled("dry_run") + ")");
