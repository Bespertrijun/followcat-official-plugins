// media-library-filter —— 过滤后的通知 fan-out 通道
//
// 自 FollowCat v3.5 起 Slack / Telegram 业务逻辑收回主仓 internal/notify。
// 主仓在每次 channel.Send 前后会 Publish 两个 domain 事件：
//   on_notification_before_send / on_notification_after_send（fire-and-forget）。
//
// 本插件在 before_send 里做两件事：
//   1. 查 Emby / Plex 媒体库判断该番剧 / 文件是否已存在
//   2. 不在库里 → fan-out 到自己的 Telegram bot 或通用 webhook；在库里 → 静默
// 由于 hook 是 fire-and-forget，本插件**无法**让主仓 Slack/Telegram 跟着静默；
// 推荐用法：主仓 Slack/Telegram 作为「全量 log」或干脆关掉，本插件作为「干净的主通知」。
//
// === 配置 key（管理页 → 插件 → 详情 → 配置） ===
//
//   emby_enabled         "1" 启用 Emby 检查
//   emby_url             Emby 根 URL（不带尾斜杠），例：http://192.168.1.10:8096
//   emby_api_key         Emby API Key（建议 is_secret=true）
//
//   plex_enabled         "1" 启用 Plex 检查
//   plex_url             Plex 根 URL，例：http://192.168.1.10:32400
//   plex_token           X-Plex-Token（建议 is_secret=true）
//
//   webhook_channel      fan-out 通道类型："telegram" | "generic"（默认 telegram）
//   telegram_bot_token   Telegram Bot token（建议 is_secret=true，仅 telegram 通道用）
//   telegram_chat_id     目标 chat id（仅 telegram 通道用）
//   generic_webhook_url  通用 webhook URL；POST JSON { event_type, channel, text, anime_id?, anime_title?, episode? }
//
//   cache_ttl_sec        库查询结果缓存 TTL，默认 3600 秒（1 小时）
//   dry_run              "1" 仅日志记录决策、不真正 fan-out
//   match_strict         "1" 仅当 Emby/Plex 返回精确同名条目时算命中；默认 0（大小写不敏感子串）
//   suppress_event_types 可选；逗号分隔，将这些 event 强制静默（即便不在库里也不推），例：on_episode_found
//
// === 自定义 API ===
//
//   GET  /api/plugins/<id>/api/stats           累计计数
//   GET  /api/plugins/<id>/api/check?anime_id=N 单 anime 的库检查 trace（不写缓存）
//   POST /api/plugins/<id>/api/clear-cache     清空 config.* 里所有 lib_cache_* 键
//   POST /api/plugins/<id>/api/test-emby       用当前配置探测 Emby 连通性
//   POST /api/plugins/<id>/api/test-plex       同上 Plex
//   POST /api/plugins/<id>/api/test-fanout     按当前配置发送一条测试 fan-out（绕过库检查）
//
// === 设计要点 ===
//
//   1. before_send 每事件每通道触发一次 → 内存 dedupe（5 秒窗）防止 N 通道导致 N 次 fan-out
//   2. 库查询结果缓存到 config.set("lib_cache_" + anime_id, JSON)，TTL 标记在 value 里
//   3. 库查询失败时 fail-open（fan-out 照旧），日志记录；不让 Emby 宕机导致漏推
//   4. Emby 与 Plex 任一命中即视为「库里有」；都未配置则插件退化为无过滤 fan-out
//   5. 所有 http.* 都 try/catch；每次 http.* 设软超时（业务层；实际 10 s 由 host 控制）

// ====== 常量与工具 ======

var CACHE_PREFIX = "lib_cache_";
var DEDUPE_WINDOW_MS = 5000;
var DEFAULT_CACHE_TTL_SEC = 3600;

// 单次 hook 完成时间预算（host 10 s 强制中断；这里我们自己留点裕量给 fan-out）
var LIB_CHECK_SOFT_BUDGET_MS = 4000;

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

// 比较标题：strict 模式精确（trim+lower 后等值），否则子串
function titleMatches(libraryTitle, queryTitle, strict) {
    var a = trim(libraryTitle).toLowerCase();
    var b = trim(queryTitle).toLowerCase();
    if (!a || !b) return false;
    if (strict) return a === b;
    return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

// ====== 缓存（config.*；anime_id → {has, source, ts, title}） ======

function readCache(animeID) {
    if (animeID === null || animeID === undefined || animeID === "") return null;
    var raw = config.get(CACHE_PREFIX + animeID);
    if (!raw) return null;
    var obj = safeJsonParse(raw, null);
    if (!obj || typeof obj !== "object") return null;
    return obj;
}

function writeCache(animeID, entry) {
    if (animeID === null || animeID === undefined || animeID === "") return;
    try {
        config.set(CACHE_PREFIX + animeID, JSON.stringify(entry));
    } catch (e) {
        // 配额满或别的错；不再硬抛，避免污染 hook
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
// Emby API: GET <root>/emby/Items?api_key=...&Recursive=true
//   &IncludeItemTypes=Movie,Series,Episode
//   &SearchTerm=<title>&Fields=ProviderIds,ProductionYear&Limit=10
// 返回 { Items: [{ Name, ProductionYear, ProviderIds: { Tmdb, Imdb } }], TotalRecordCount }
function checkEmby(title) {
    var url = config.get("emby_url");
    var key = config.get("emby_api_key");
    if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, hit: false, reason: "not_configured" };

    var fullUrl = joinUrl(url, "/emby/Items") + "?" + qs({
        api_key: key,
        Recursive: "true",
        IncludeItemTypes: "Movie,Series,Episode",
        SearchTerm: title,
        Fields: "ProviderIds,ProductionYear",
        Limit: 10
    });

    var resp;
    try {
        resp = http.get(fullUrl, { "Accept": "application/json" });
    } catch (e) {
        rememberError("emby", e);
        return { ok: false, hit: false, reason: "http_error", error: String(e) };
    }
    if (!resp || typeof resp.status !== "number") {
        return { ok: false, hit: false, reason: "malformed_response" };
    }
    if (resp.status < 200 || resp.status >= 300) {
        rememberError("emby", "status=" + resp.status);
        return { ok: false, hit: false, reason: "status_" + resp.status };
    }

    var body = safeJsonParse(resp.body, null);
    if (!body || !body.Items || body.Items.length === 0) {
        return { ok: true, hit: false, reason: "no_items" };
    }

    var strict = isEnabled("match_strict");
    for (var i = 0; i < body.Items.length; i++) {
        var item = body.Items[i] || {};
        if (titleMatches(item.Name, title, strict)) {
            var pid = item.ProviderIds || {};
            return {
                ok: true,
                hit: true,
                source: "emby",
                matched_title: item.Name,
                tmdb_id: pid.Tmdb || "",
                imdb_id: pid.Imdb || "",
                year: item.ProductionYear || 0
            };
        }
    }
    return { ok: true, hit: false, reason: "no_match", candidates: body.Items.length };
}

// ====== Plex 查询 ======
//
// Plex API: GET <root>/hubs/search?query=<title>&X-Plex-Token=...
//   Header: Accept: application/json
// 返回 { MediaContainer: { Hub: [ { type, Metadata: [ { title, year, Guid?: [...] } ] } ] } }
// type 我们关注 "movie" / "show" / "episode"
function checkPlex(title) {
    var url = config.get("plex_url");
    var token = config.get("plex_token");
    if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, hit: false, reason: "not_configured" };

    var fullUrl = joinUrl(url, "/hubs/search") + "?" + qs({
        query: title,
        "X-Plex-Token": token,
        limit: 10
    });

    var resp;
    try {
        resp = http.get(fullUrl, { "Accept": "application/json" });
    } catch (e) {
        rememberError("plex", e);
        return { ok: false, hit: false, reason: "http_error", error: String(e) };
    }
    if (!resp || typeof resp.status !== "number") {
        return { ok: false, hit: false, reason: "malformed_response" };
    }
    if (resp.status < 200 || resp.status >= 300) {
        rememberError("plex", "status=" + resp.status);
        return { ok: false, hit: false, reason: "status_" + resp.status };
    }

    var body = safeJsonParse(resp.body, null);
    if (!body || !body.MediaContainer) return { ok: true, hit: false, reason: "empty" };

    var hubs = body.MediaContainer.Hub || [];
    var strict = isEnabled("match_strict");
    var candidates = 0;
    for (var i = 0; i < hubs.length; i++) {
        var hub = hubs[i] || {};
        if (hub.type !== "movie" && hub.type !== "show" && hub.type !== "episode") continue;
        var metas = hub.Metadata || [];
        candidates += metas.length;
        for (var j = 0; j < metas.length; j++) {
            var m = metas[j] || {};
            if (titleMatches(m.title, title, strict)) {
                // 提取 tmdb/imdb guid（如有）
                var tmdb = "", imdb = "";
                var guids = m.Guid || [];
                for (var g = 0; g < guids.length; g++) {
                    var gid = String((guids[g] || {}).id || "");
                    if (gid.indexOf("tmdb://") === 0) tmdb = gid.substring(7);
                    if (gid.indexOf("imdb://") === 0) imdb = gid.substring(7);
                }
                return {
                    ok: true,
                    hit: true,
                    source: "plex",
                    matched_title: m.title,
                    tmdb_id: tmdb,
                    imdb_id: imdb,
                    year: m.year || 0
                };
            }
        }
    }
    return { ok: true, hit: false, reason: "no_match", candidates: candidates };
}

// ====== 主库检查：Emby 优先，Plex 兜底 ======

function performLibraryCheck(title, deadlineMs) {
    if (!nonEmpty(title)) return { hit: false, reason: "no_title", sources: [] };

    var sources = [];
    if (isEnabled("emby_enabled")) {
        if (deadlineMs && nowMs() > deadlineMs) {
            return { hit: false, reason: "deadline", sources: sources };
        }
        var er = checkEmby(title);
        sources.push({ name: "emby", ok: er.ok, hit: er.hit, reason: er.reason || "" });
        if (er.ok && er.hit) {
            return {
                hit: true,
                source: "emby",
                matched_title: er.matched_title,
                tmdb_id: er.tmdb_id || "",
                imdb_id: er.imdb_id || "",
                year: er.year || 0,
                sources: sources
            };
        }
    }
    if (isEnabled("plex_enabled")) {
        if (deadlineMs && nowMs() > deadlineMs) {
            return { hit: false, reason: "deadline", sources: sources };
        }
        var pr = checkPlex(title);
        sources.push({ name: "plex", ok: pr.ok, hit: pr.hit, reason: pr.reason || "" });
        if (pr.ok && pr.hit) {
            return {
                hit: true,
                source: "plex",
                matched_title: pr.matched_title,
                tmdb_id: pr.tmdb_id || "",
                imdb_id: pr.imdb_id || "",
                year: pr.year || 0,
                sources: sources
            };
        }
    }
    return { hit: false, reason: "no_match", sources: sources };
}

// 综合：先查缓存，未命中再调外部库；写回缓存（命中或未命中都写）
function resolveLibraryStatus(animeID, title) {
    if (animeID !== null && animeID !== undefined && animeID !== "") {
        var cached = readCache(animeID);
        if (cached && cacheFresh(cached)) {
            return {
                hit: !!cached.has,
                source: cached.source || "",
                matched_title: cached.matched_title || "",
                tmdb_id: cached.tmdb_id || "",
                imdb_id: cached.imdb_id || "",
                year: cached.year || 0,
                from_cache: true
            };
        }
    }
    var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
    var r = performLibraryCheck(title, deadline);

    if (animeID !== null && animeID !== undefined && animeID !== "") {
        writeCache(animeID, {
            has: !!r.hit,
            source: r.source || "",
            matched_title: r.matched_title || "",
            tmdb_id: r.tmdb_id || "",
            imdb_id: r.imdb_id || "",
            year: r.year || 0,
            ts: nowSec()
        });
    }
    r.from_cache = false;
    return r;
}

// ====== 跨通道去重（before_send 每事件每通道一次） ======
//
// 主仓启用 Slack + Telegram 时，一次 on_download_done 会触发 2 次 before_send。
// 我们要让这两次只 fan-out 一次。用 in-memory map：键 = event_type|anime_id|episode，
// 5 s 内只放行第一次。

var dedupeMap = {}; // key → expireMs

function dedupeShouldSkip(eventType, animeID, episode) {
    var key = String(eventType || "") + "|" +
              String(animeID === undefined ? "" : animeID) + "|" +
              String(episode === undefined ? "" : episode);
    var now = nowMs();

    // 顺手清理过期项；不每次扫全表，简单做：>50 项时整体扫一次
    var keys = Object.keys(dedupeMap);
    if (keys.length > 50) {
        for (var i = 0; i < keys.length; i++) {
            if (dedupeMap[keys[i]] < now) delete dedupeMap[keys[i]];
        }
    }

    var exp = dedupeMap[key];
    if (exp && exp > now) return true;
    dedupeMap[key] = now + DEDUPE_WINDOW_MS;
    return false;
}

// ====== fan-out ======

function buildFanoutText(data, libStatus) {
    // 主仓的 text 字段已经是渲染好的可用消息；直接转发即可
    var base = data.text || "";
    if (libStatus && libStatus.from_cache) return base + " (lib:cache)";
    return base;
}

function sendTelegram(text) {
    var token = config.get("telegram_bot_token");
    var chatID = config.get("telegram_chat_id");
    if (!nonEmpty(token) || !nonEmpty(chatID)) {
        log.warn("media-library-filter: telegram channel selected but token/chat_id missing");
        incCounter("fanout_skipped_misconfig");
        return { ok: false, reason: "misconfig" };
    }
    try {
        var url = "https://api.telegram.org/bot" + token + "/sendMessage";
        var body = JSON.stringify({
            chat_id: chatID,
            text: text,
            parse_mode: "HTML",
            disable_web_page_preview: true
        });
        var resp = http.post(url, body, { "Content-Type": "application/json" });
        if (resp && resp.status >= 200 && resp.status < 300) {
            incCounter("fanout_sent");
            return { ok: true };
        }
        incCounter("fanout_failed");
        rememberError("telegram", "status=" + (resp ? resp.status : "?"));
        return { ok: false, reason: "status_" + (resp ? resp.status : "no_resp") };
    } catch (e) {
        incCounter("fanout_failed");
        rememberError("telegram", e);
        return { ok: false, reason: "exception", error: String(e) };
    }
}

function sendGenericWebhook(text, data) {
    var url = config.get("generic_webhook_url");
    if (!nonEmpty(url)) {
        log.warn("media-library-filter: generic channel selected but generic_webhook_url missing");
        incCounter("fanout_skipped_misconfig");
        return { ok: false, reason: "misconfig" };
    }
    try {
        var payload = JSON.stringify({
            event_type: data.event_type || "",
            channel: "media-library-filter",
            text: text,
            anime_id: data.anime_id == null ? "" : String(data.anime_id),
            anime_title: data.anime_title || "",
            episode: data.episode == null ? 0 : data.episode
        });
        var resp = http.post(url, payload, { "Content-Type": "application/json" });
        if (resp && resp.status >= 200 && resp.status < 300) {
            incCounter("fanout_sent");
            return { ok: true };
        }
        incCounter("fanout_failed");
        rememberError("webhook", "status=" + (resp ? resp.status : "?"));
        return { ok: false, reason: "status_" + (resp ? resp.status : "no_resp") };
    } catch (e) {
        incCounter("fanout_failed");
        rememberError("webhook", e);
        return { ok: false, reason: "exception", error: String(e) };
    }
}

function fanout(text, data) {
    var channel = config.get("webhook_channel") || "telegram";
    if (channel === "generic") return sendGenericWebhook(text, data);
    return sendTelegram(text);
}

// ====== 主流程 ======

function eventTypeForcedSuppress(eventType) {
    var raw = config.get("suppress_event_types") || "";
    if (!raw) return false;
    var arr = raw.split(",");
    for (var i = 0; i < arr.length; i++) {
        if (trim(arr[i]) === eventType) return true;
    }
    return false;
}

function handleBeforeSend(data) {
    incCounter("before_send_seen");

    var dryRun = isEnabled("dry_run");

    // 去重：每事件只 fan-out 一次
    if (dedupeShouldSkip(data.event_type, data.anime_id, data.episode)) {
        incCounter("deduped");
        return;
    }

    // 配置上强制静默某些 event_type
    if (eventTypeForcedSuppress(data.event_type)) {
        incCounter("suppressed_by_event_filter");
        log.info("media-library-filter: forced-suppress " + data.event_type);
        return;
    }

    // 没有任何后端配置 → 此插件等同于无过滤 fan-out（明确选择）
    var anyBackend = isEnabled("emby_enabled") || isEnabled("plex_enabled");

    var title = data.anime_title || "";
    if (anyBackend && nonEmpty(title)) {
        var libStatus;
        try {
            libStatus = resolveLibraryStatus(data.anime_id, title);
        } catch (e) {
            log.error("media-library-filter: lib check exception: " + e);
            libStatus = { hit: false, reason: "exception" };
        }

        if (libStatus && libStatus.hit) {
            incCounter("suppressed_in_library");
            log.info("media-library-filter: suppress (lib=" + libStatus.source +
                     " title=" + libStatus.matched_title +
                     (libStatus.tmdb_id ? " tmdb=" + libStatus.tmdb_id : "") +
                     (libStatus.from_cache ? " cache=hit" : "") + ")");
            return;
        }
    }

    // 库里没有（或没配后端） → fan-out
    if (dryRun) {
        incCounter("dry_run_would_send");
        log.info("media-library-filter: [dry_run] would fan-out: " + (data.text || "").substring(0, 80));
        return;
    }

    var text = buildFanoutText(data, null);
    fanout(text, data);
}

function handleAfterSend(data) {
    try {
        var ch = data.channel || "unknown";
        if (data.success) {
            incCounter("upstream_" + ch + "_ok");
        } else {
            incCounter("upstream_" + ch + "_fail");
            log.warn("media-library-filter: upstream " + ch + " failed: " + (data.error_message || ""));
        }
    } catch (e) {
        log.error("media-library-filter: after_send handler error: " + e);
    }
}

// ====== Hook 注册 ======

plugin.on("on_notification_before_send", function (data) {
    try {
        handleBeforeSend(data || {});
    } catch (e) {
        log.error("media-library-filter: before_send handler error: " + e);
    }
});

plugin.on("on_notification_after_send", function (data) {
    try {
        handleAfterSend(data || {});
    } catch (e) {
        log.error("media-library-filter: after_send handler error: " + e);
    }
});

// ====== 自定义 API ======

plugin.registerAPI("/stats", function (req) {
    return {
        config: {
            emby_enabled: isEnabled("emby_enabled"),
            emby_configured: !!(config.get("emby_url") && config.get("emby_api_key")),
            plex_enabled: isEnabled("plex_enabled"),
            plex_configured: !!(config.get("plex_url") && config.get("plex_token")),
            webhook_channel: config.get("webhook_channel") || "telegram",
            telegram_configured: !!(config.get("telegram_bot_token") && config.get("telegram_chat_id")),
            generic_webhook_configured: !!config.get("generic_webhook_url"),
            cache_ttl_sec: cacheTtlSec(),
            dry_run: isEnabled("dry_run"),
            match_strict: isEnabled("match_strict"),
            suppress_event_types: config.get("suppress_event_types") || ""
        },
        counters: {
            before_send_seen: safeNum(config.get("before_send_seen"), 0),
            deduped: safeNum(config.get("deduped"), 0),
            suppressed_in_library: safeNum(config.get("suppressed_in_library"), 0),
            suppressed_by_event_filter: safeNum(config.get("suppressed_by_event_filter"), 0),
            fanout_sent: safeNum(config.get("fanout_sent"), 0),
            fanout_failed: safeNum(config.get("fanout_failed"), 0),
            fanout_skipped_misconfig: safeNum(config.get("fanout_skipped_misconfig"), 0),
            dry_run_would_send: safeNum(config.get("dry_run_would_send"), 0)
        },
        errors: {
            emby_last_error: config.get("emby_last_error") || "",
            emby_last_error_at: config.get("emby_last_error_at") || "",
            plex_last_error: config.get("plex_last_error") || "",
            plex_last_error_at: config.get("plex_last_error_at") || "",
            telegram_last_error: config.get("telegram_last_error") || "",
            telegram_last_error_at: config.get("telegram_last_error_at") || "",
            webhook_last_error: config.get("webhook_last_error") || "",
            webhook_last_error_at: config.get("webhook_last_error_at") || ""
        }
    };
});

plugin.registerAPI("/check", function (req) {
    var animeIdRaw = (req && req.query && req.query.anime_id) || "";
    var titleOverride = (req && req.query && req.query.title) || "";

    var title = titleOverride;
    var animeIDNum = parseInt(animeIdRaw, 10);
    if (!isNaN(animeIDNum) && typeof anime === "object" && anime && typeof anime.get === "function") {
        var info = anime.get(animeIDNum);
        if (info && !title) title = info.title || "";
    }
    if (!nonEmpty(title)) {
        return { ok: false, error: "missing anime_id (with anime.get hit) or ?title=" };
    }
    var deadline = nowMs() + LIB_CHECK_SOFT_BUDGET_MS;
    var r = performLibraryCheck(title, deadline);
    return {
        ok: true,
        anime_id: animeIdRaw || null,
        title: title,
        hit: !!r.hit,
        source: r.source || "",
        matched_title: r.matched_title || "",
        tmdb_id: r.tmdb_id || "",
        imdb_id: r.imdb_id || "",
        year: r.year || 0,
        sources_tried: r.sources || []
    };
});

plugin.registerAPI("/clear-cache", function (req) {
    var deleted = 0;
    if (typeof config.list === "function") {
        var keys = config.list();
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf(CACHE_PREFIX) === 0) {
                try { config.set(k, ""); deleted++; } catch (e) { /* ignore */ }
            }
        }
    }
    return { ok: true, deleted: deleted };
});

plugin.registerAPI("/test-emby", function (req) {
    if (!isEnabled("emby_enabled")) return { ok: false, error: "emby_enabled != 1" };
    var probeTitle = (req && req.query && req.query.title) || "";
    if (!nonEmpty(probeTitle)) {
        var url = config.get("emby_url");
        var key = config.get("emby_api_key");
        if (!nonEmpty(url) || !nonEmpty(key)) return { ok: false, error: "url/api_key missing" };
        try {
            var resp = http.get(joinUrl(url, "/emby/System/Info/Public"), { "Accept": "application/json" });
            return { ok: resp && resp.status >= 200 && resp.status < 300, status: resp && resp.status, body_preview: (resp && resp.body || "").substring(0, 200) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    return checkEmby(probeTitle);
});

plugin.registerAPI("/test-plex", function (req) {
    if (!isEnabled("plex_enabled")) return { ok: false, error: "plex_enabled != 1" };
    var probeTitle = (req && req.query && req.query.title) || "";
    if (!nonEmpty(probeTitle)) {
        var url = config.get("plex_url");
        var token = config.get("plex_token");
        if (!nonEmpty(url) || !nonEmpty(token)) return { ok: false, error: "url/token missing" };
        try {
            var resp = http.get(joinUrl(url, "/identity") + "?" + qs({ "X-Plex-Token": token }), { "Accept": "application/json" });
            return { ok: resp && resp.status >= 200 && resp.status < 300, status: resp && resp.status, body_preview: (resp && resp.body || "").substring(0, 200) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    return checkPlex(probeTitle);
});

plugin.registerAPI("/test-fanout", function (req) {
    var text = (req && req.query && req.query.text) || "📣 media-library-filter 测试 fan-out " + new Date().toISOString();
    var result = fanout(text, {
        event_type: "test_fanout",
        anime_title: "test",
        anime_id: "",
        episode: 0
    });
    return result;
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
    var allowed = [
        "emby_enabled", "emby_url", "emby_api_key",
        "plex_enabled", "plex_url", "plex_token",
        "webhook_channel", "telegram_bot_token", "telegram_chat_id", "generic_webhook_url",
        "cache_ttl_sec", "dry_run", "match_strict", "suppress_event_types"
    ];
    var written = [];
    for (var i = 0; i < allowed.length; i++) {
        var k = allowed[i];
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            var v = obj[k];
            if (v === null || v === undefined) v = "";
            if (typeof v !== "string") v = String(v);
            try { config.set(k, v); written.push(k); }
            catch (e) { return { ok: false, error: "config.set failed for " + k + ": " + e, written: written }; }
        }
    }
    return { ok: true, written: written };
});

log.info("media-library-filter loaded (emby=" + isEnabled("emby_enabled") +
         " plex=" + isEnabled("plex_enabled") +
         " channel=" + (config.get("webhook_channel") || "telegram") +
         " dry_run=" + isEnabled("dry_run") + ")");
