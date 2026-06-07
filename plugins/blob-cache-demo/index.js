// blob-cache-demo
//
// 演示 FollowCat v3.4 的 data.* 加密 blob 存储 API：
//   - 监听 on_task_completed
//   - 用 anime.get 拿到番剧元数据
//   - 用 http.get 下载封面图
//   - 用 data.put 把封面存进加密 blob (默认 ≤ 4 MiB / 张)
//   - 用 config.set / data.list 维护索引
//
// 这不是生产插件 — 仅作 v3.4 API 教学示例。生产环境应有 LRU 淘汰、
// 多源 fallback、错误重试等。

var COVER_PREFIX = "cover_";   // blob name 前缀，便于过滤
var INDEX_KEY = "cover_index"; // config 里存 anime_id -> blob_name 索引

// 单张缩略图大小上限（200 KiB），远低于 data.* 默认 4 MiB / blob
var MAX_COVER_BYTES = 200 * 1024;

plugin.on("on_task_completed", function (event) {
  try {
    cacheCoverIfMissing(event.anime_id, event.anime_title);
  } catch (e) {
    log.error("cache cover for anime_id=" + event.anime_id + ": " + e);
  }
});

// 主流程：检查 → 拉取 → 存 blob → 更新 config 索引
function cacheCoverIfMissing(animeID, animeTitle) {
  if (!animeID) return;

  var index = readIndex();
  var blobName = index[String(animeID)];

  // 已经存过且 blob 还在 → 跳过
  if (blobName && data.list().indexOf(blobName) >= 0) {
    log.info("cover already cached: anime_id=" + animeID);
    return;
  }

  // 拿番剧详情
  var info = anime.get(parseInt(animeID, 10));
  if (!info) {
    log.warn("anime not found: id=" + animeID);
    return;
  }

  var coverURL = guessCoverURL(info);
  if (!coverURL) {
    log.info("no cover URL for: " + animeTitle);
    return;
  }

  // 拉封面
  var resp;
  try {
    resp = http.get(coverURL, { "User-Agent": "FollowCat-blob-demo/0.1" });
  } catch (e) {
    log.warn("http.get failed: " + e);
    return;
  }
  if (resp.status !== 200) {
    log.warn("cover fetch status " + resp.status + " for " + coverURL);
    return;
  }

  // 校验大小
  var bodyBytes = encodeUtf8(resp.body);
  if (bodyBytes.length > MAX_COVER_BYTES) {
    log.warn("cover too large: " + bodyBytes.length + " bytes, skipped");
    return;
  }

  // 存进 data.* — name 必须满足 ^[a-zA-Z0-9_.-]{1,128}$
  blobName = COVER_PREFIX + animeID + ".jpg";
  try {
    data.put(blobName, bodyBytes.buffer);
  } catch (e) {
    log.error("data.put failed: " + e);
    return;
  }

  // 更新索引
  index[String(animeID)] = blobName;
  writeIndex(index);

  log.info("cached cover: " + animeTitle + " (" + bodyBytes.length + " bytes)");
}

// ----- helpers -----

function readIndex() {
  var raw = config.get(INDEX_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeIndex(idx) {
  config.set(INDEX_KEY, JSON.stringify(idx));
}

function guessCoverURL(a) {
  // 真实场景应从 mediainfo 或 douban API 取，这里做最朴素的 demo
  if (a.douban_id) {
    return "https://img.douban.com/mpic/s" + a.douban_id + ".jpg";
  }
  return null;
}

// goja 没有原生 TextEncoder，用纯 JS 实现 UTF-8 → Uint8Array
function encodeUtf8(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      // surrogate pair
      i++;
      var c2 = str.charCodeAt(i);
      var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

// 自暴露 API：让 admin 看缓存状态
plugin.registerAPI("/stats", function (req) {
  var index = readIndex();
  return {
    cached_count: Object.keys(index).length,
    blob_names: data.list(),
    config_keys: config.list()
  };
});

// 自暴露 API：清空缓存
plugin.registerAPI("/clear", function (req) {
  var index = readIndex();
  var deleted = 0;
  for (var k in index) {
    if (data["delete"](index[k])) deleted++;
  }
  config.set(INDEX_KEY, "{}");
  return { deleted: deleted };
});
