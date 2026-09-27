// cookiecloud —— 从自建 CookieCloud 同步浏览器 cookie 到 FollowCat 的 PT 站凭据与豆瓣 Cookie
//
// 一次同步：GET <host>/get/<uuid> 拿密文 → 本地解密（密码不出 FollowCat，不用服务端解密模式）→
// 把所有分组里的 cookie 展平，按每条 cookie 自己的 domain 用浏览器规则匹配目标主机（PT 站 = 该站
// RSS 链接的主机名，豆瓣 = m.douban.com）→ 指纹比对，只写变了的 → 所有写并发发出（Promise.all）→
// 按站汇总结果。
//
// 入口唯一：startSync(trigger)。「立即同步」（/sync）与定时器都调它；已有同步在跑就跳过（不排队、
// 不并发）。/sync 不等同步结束就返回，UI 轮询 /status 看进度与每站结果。

var DOUBAN_HOST = "m.douban.com"; // 宿主豆瓣网页通道请求的主机
var MAX_TIMER_MS = 2147483647;    // 定时器上限（2^31-1 ms，约 24.8 天）；超出会被当成 1ms，必须截住

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

// Cookie 归一化契约（与宿主 getCookieMeta / douban.getCookie 的 sha256 同一规则，照抄 sdk.md 参考实现）
function normalizeCookie(s) {
  var parts = String(s).split(";");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
    if (p !== "") out.push(p);
  }
  out.sort(compareCodePoints);
  return out.join("; ");
}

// 按 Unicode 码点比较（== UTF-8 字节序）。不能用默认 sort()：它按 UTF-16 码元比较，
// 对 BMP 之外的字符（emoji 等）与 U+E000–U+FFFF 之间的顺序和宿主不一致。
function compareCodePoints(a, b) {
  var i = 0, j = 0;
  while (i < a.length && j < b.length) {
    var ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

// UTF-8 解码（沙箱没有 TextDecoder；照抄 dev-guide「UTF-8 编解码」的参考实现）。
// 逐字节循环 + `+=` 拼接在 goja 里是平方级的（1.3 MB 要几分钟），这里全交给内置函数：
// 每 8192 字节一块 String.fromCharCode.apply 成「字节串」，join 后 escape → decodeURIComponent
// 完成真正的 UTF-8 解码。非法 UTF-8 序列 → decodeURIComponent 抛 URIError。
function decodeUtf8(u8) {
  var parts = [];
  for (var i = 0; i < u8.length; i += 8192) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + 8192)));
  }
  return decodeURIComponent(escape(parts.join("")));
}

// 字节开头是否为给定 ASCII 串（按字节比，不做 UTF-8 解码——密文是随机字节）
function bytesStartWith(u8, ascii) {
  if (u8.length < ascii.length) return false;
  for (var i = 0; i < ascii.length; i++) {
    if (u8[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// 纯 ASCII 字符串 → 字节（aes-128-cbc-fixed 的密钥是 16 个十六进制字符本身的字节）
function asciiBytes(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function errText(e) {
  if (e && e.message) return String(e.message);
  return String(e);
}

function trimStr(v) {
  return v === null || v === undefined ? "" : String(v).replace(/^\s+|\s+$/g, "");
}

// sync_interval_min：非负整数分钟；空 / 0 / 非法 = 不自动同步
function parseIntervalMin(v) {
  var s = trimStr(v);
  if (!/^\d+$/.test(s)) return 0;
  return parseInt(s, 10);
}

// sites：PT 站行 id 的 JSON 数组；空 = 没勾选。非法 → 抛错（让用户看到，而不是静默当成没勾）
function parseSelectedSites(raw) {
  var s = trimStr(raw);
  if (s === "") return [];
  var v;
  try { v = JSON.parse(s); } catch (e) { throw new Error("配置 sites 不是合法的 JSON 数组"); }
  if (!Array.isArray(v)) throw new Error("配置 sites 不是 JSON 数组");
  var out = [], seen = {};
  for (var i = 0; i < v.length; i++) {
    var id = typeof v[i] === "string" ? v[i] : "";
    if (id === "" || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// cookie_data 的分组 key 取决于扩展设置（关键词 / 原始域名），同一条 cookie 可能出现在多组——不看 key，
// 全部展平，交给 buildCookieHeader 按 cookie 自己的 domain 匹配 + 去重
function flattenCookies(cookieData) {
  var out = [];
  if (!cookieData || typeof cookieData !== "object") return out;
  var keys = Object.keys(cookieData);
  for (var i = 0; i < keys.length; i++) {
    var group = cookieData[keys[i]];
    if (!Array.isArray(group)) continue;
    for (var j = 0; j < group.length; j++) {
      var c = group[j];
      if (!c || typeof c !== "object" || typeof c.name !== "string" || typeof c.domain !== "string") continue;
      if (c.value === undefined || c.value === null) continue;
      out.push(c);
    }
  }
  return out;
}

// 浏览器规则：d = domain 去掉前导点；host === d 必中；否则 host 以 "." + d 结尾即中——
// 除非浏览器标了 hostOnly（没带 Domain 属性的 cookie 只发回设置它的那个主机，不跨子域）
function cookieMatchesHost(c, host) {
  var d = String(c.domain).toLowerCase();
  if (d.charAt(0) === ".") d = d.substring(1);
  if (d === "") return false;
  host = String(host).toLowerCase();
  if (host === d) return true;
  if (c.hostOnly === true) return false;
  return host.length > d.length + 1 && host.substring(host.length - d.length - 1) === "." + d;
}

function cookieExpired(c, nowSec) {
  return typeof c.expirationDate === "number" && c.expirationDate < nowSec;
}

// 把能发给 hosts 里任一主机的 cookie 拼成 "name=value; ..."：跳过已过期的，按 (name, domain, path) 去重，
// 保持首次出现顺序
function buildCookieHeader(cookies, hosts, nowSec) {
  var seen = Object.create(null);
  var parts = [];
  for (var i = 0; i < cookies.length; i++) {
    var c = cookies[i];
    if (cookieExpired(c, nowSec)) continue;
    var hit = false;
    for (var h = 0; h < hosts.length; h++) {
      if (cookieMatchesHost(c, hosts[h])) { hit = true; break; }
    }
    if (!hit) continue;
    var key = c.name + "\u0000" + String(c.domain).toLowerCase() + "\u0000" + (c.path || "");
    if (seen[key]) continue;
    seen[key] = true;
    var value = String(c.value);
    parts.push(c.name === "" ? value : c.name + "=" + value);
  }
  return { header: parts.join("; "), count: parts.length };
}

// 解密 /get/<uuid> 返回的 {encrypted, crypto_type}。两种都是 CookieCloud 浏览器扩展的官方算法：
//   legacy：base64 → "Salted__" + 8B salt + 密文 → EVP_BytesToKey(md5(uuid-pwd) 前 16 字符, salt) → AES-256-CBC
//   aes-128-cbc-fixed：密钥 = md5(uuid-pwd) 前 16 个字符的字节（AES-128），IV = 16 个 0，base64 解出来直接是密文
// 服务端没返回 crypto_type（老版本服务端）时按密文判断：以 "Salted__" 开头是 legacy，否则是 aes-128-cbc-fixed。
function decryptPayload(payload, uuid, pwd) {
  var raw;
  try {
    raw = crypto.base64Decode(String(payload.encrypted));
  } catch (e) {
    throw new Error("解密失败，密文不是合法的 base64（" + errText(e) + "）");
  }
  var type = payload.crypto_type ? String(payload.crypto_type) : (bytesStartWith(raw, "Salted__") ? "legacy" : "aes-128-cbc-fixed");
  if (type !== "legacy" && type !== "aes-128-cbc-fixed") {
    throw new Error("不支持的加密方式 " + type);
  }
  var pass = crypto.md5(uuid + "-" + pwd).substring(0, 16);
  var plain;
  try {
    if (type === "legacy") {
      if (raw.length < 32 || !bytesStartWith(raw, "Salted__")) {
        throw new Error("密文不是 CryptoJS 的 Salted__ 格式（扩展里选的加密方式和服务端记录的不一致？）");
      }
      var kv = crypto.evpBytesToKey(pass, raw.subarray(8, 16), 32, 16);
      plain = crypto.aesDecryptCBC(kv.key, kv.iv, raw.subarray(16));
    } else {
      plain = crypto.aesDecryptCBC(asciiBytes(pass), new Uint8Array(16), raw);
    }
  } catch (e) {
    throw new Error("解密失败，UUID 或密码不对（" + errText(e) + "）");
  }
  var text;
  try { text = decodeUtf8(plain); } catch (e) {
    throw new Error("解密失败，UUID 或密码不对（解密结果不是合法的 UTF-8）");
  }
  var data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error("解密结果不是 JSON，UUID 或密码不对");
  }
  if (!data || typeof data !== "object" || !data.cookie_data || typeof data.cookie_data !== "object") {
    throw new Error("解密后的数据里没有 cookie_data");
  }
  return data;
}

// ─── 每站结果 ────────────────────────────────────────────────────────────────

var STATUS_TEXT = {
  written: "已写入",
  unchanged: "cookie 没变，跳过写入",
  no_rss: "该站没配 RSS，无法匹配（先在 PT 站设置里填好 RSS 链接）",
  no_cookie: "CookieCloud 里没有该站的 cookie（检查浏览器扩展的同步设置）",
  site_missing: "站点已删除，已跳过（可在设置里取消勾选）",
  not_cookie_site: "该站不是 Cookie 鉴权，不同步（已跳过）",
  failed: "写入失败",
};

var VALIDATION_TEXT = {
  ok: "验活通过",
  cookie_invalid: "但豆瓣认为这份 Cookie 未登录或已失效",
  rate_limited: "豆瓣通道忙，没来得及验活（已写入，稍后可在豆瓣设置里再验）",
  unreachable: "连不上豆瓣，没能验活（网络 / 代理）",
};

function setStatus(r, status, detail) {
  r.status = status;
  var msg = STATUS_TEXT[status] || status;
  if (status === "written" && r.cookies) msg += "（" + r.cookies + " 条 cookie）";
  if (status === "written" && r.validation) msg += "，" + (VALIDATION_TEXT[r.validation] || ("验活结果 " + r.validation));
  if (detail) msg += "：" + detail;
  r.message = msg;
}

// ─── 同步 ────────────────────────────────────────────────────────────────────

var state = {
  running: false,
  started_at: null,
  finished_at: null,
  last_trigger: null, // "manual" | "timer"
  results: [],
};

// 去掉文本里 URL 的账号密码（http://user:pass@host → http://host）：地址里可以带 Basic 认证，
// 出错时宿主的错误文案会原样带上 URL，不能让它进 last_error / 日志。
// 账号密码的范围 =「://」之后、第一个「/」之前的**最后一个** @ 为止：密码里可能有 ? # 空格甚至 @（宁可多删，
// 不能漏删）；路径里的 @ 不动
function stripUrlUserinfo(s) {
  return String(s).replace(/([a-z][a-z0-9+.\-]*:\/\/)[^\/]*@/gi, "$1");
}

async function fetchPayload(host, uuid) {
  var url = host + "/get/" + encodeURIComponent(uuid);
  var redact = function (s) {
    return stripUrlUserinfo(String(s).split(encodeURIComponent(uuid)).join("<UUID>").split(uuid).join("<UUID>"));
  };
  var resp;
  try {
    resp = await http.get(url, { "Accept": "application/json" });
  } catch (e) {
    throw new Error("连不上 CookieCloud：" + redact(errText(e)));
  }
  if (resp.status === 404) {
    throw new Error("CookieCloud 返回 404：找不到这个 UUID 的数据（UUID 填错了，或浏览器扩展还没上传过）；" +
      "也可能是地址少了服务端的路径前缀——服务端设置了 API_ROOT 时，地址要带上这个前缀（例如 https://cc.example.com/cookie）");
  }
  if (resp.status === 429) throw new Error("CookieCloud 限流了（官方服务端同一 IP 15 分钟最多 100 次），稍后再试或调大同步间隔");
  if (resp.status !== 200) throw new Error("CookieCloud 返回 HTTP " + resp.status);
  if (resp.truncated) throw new Error("CookieCloud 返回的数据超过 5 MiB，被截断了");
  var payload;
  try { payload = JSON.parse(resp.body); } catch (e) {
    throw new Error("CookieCloud 返回的不是 JSON（地址填的是 CookieCloud 服务端的根地址吗？）");
  }
  if (!payload || typeof payload.encrypted !== "string" || payload.encrypted === "") {
    throw new Error("CookieCloud 返回里没有密文（encrypted）");
  }
  return payload;
}

// 发出一次写：成功 / 失败都记进 r，永不 reject（错误按站收集，不影响其它站）
function settleWrite(r, promiseFn, onOk) {
  var p;
  try { p = promiseFn(); } catch (e) { setStatus(r, "failed", errText(e)); return Promise.resolve(); }
  return p.then(function (res) {
    if (onOk) onOk(res);
    setStatus(r, "written");
  }, function (e) {
    setStatus(r, "failed", errText(e));
  });
}

async function runSync() {
  var host = trimStr(config.get("host")).replace(/\/+$/, "");
  var uuid = trimStr(config.get("cloud_uuid"));
  var pwd = config.get("cloud_pwd") || "";
  var missing = [];
  if (!host) missing.push("CookieCloud 地址");
  if (!uuid) missing.push("UUID");
  if (!pwd) missing.push("密码");
  if (missing.length) throw new Error("还没配置：" + missing.join("、"));
  if (!/^https?:\/\/[^\/]/i.test(host)) throw new Error("CookieCloud 地址要以 http:// 或 https:// 开头");
  var siteIds = parseSelectedSites(config.get("sites"));
  var syncDouban = config.get("sync_douban") === "true";

  // 1. 拉密文（数据依赖，必须在所有写之前）→ 2. 本地解密
  var payload = await fetchPayload(host, uuid);
  var data = decryptPayload(payload, uuid, pwd);
  var cookies = flattenCookies(data.cookie_data);
  var nowSec = Date.now() / 1000;

  // 3. 逐站判定；要写的并发发出
  var results = [];
  var jobs = [];
  siteIds.forEach(function (id) {
    var site = ptsite.get(id);
    var r = { target: id, kind: "ptsite", name: site ? site.name : id };
    results.push(r);
    if (!site) return setStatus(r, "site_missing");
    if (site.auth_kind !== "cookie") return setStatus(r, "not_cookie_site");
    var hosts = site.hosts || [];
    r.hosts = hosts;
    if (hosts.length === 0) return setStatus(r, "no_rss");
    var ck = buildCookieHeader(cookies, hosts, nowSec);
    if (ck.count === 0) return setStatus(r, "no_cookie");
    r.cookies = ck.count;
    var meta = ptsite.getCookieMeta(id);
    if (meta && meta.configured && meta.sha256 === crypto.sha256(normalizeCookie(ck.header))) {
      return setStatus(r, "unchanged");
    }
    jobs.push(settleWrite(r, function () { return ptsite.setCookie(id, ck.header); }));
  });

  if (syncDouban) {
    var dr = { target: "douban", kind: "douban", name: "豆瓣", hosts: [DOUBAN_HOST] };
    results.push(dr);
    var dck = buildCookieHeader(cookies, [DOUBAN_HOST], nowSec);
    if (dck.count === 0) {
      setStatus(dr, "no_cookie");
    } else {
      dr.cookies = dck.count;
      var dmeta = douban.getCookie();
      if (dmeta && dmeta.configured && dmeta.sha256 === crypto.sha256(normalizeCookie(dck.header))) {
        setStatus(dr, "unchanged");
      } else {
        jobs.push(settleWrite(dr, function () { return douban.setCookie(dck.header, { validate: true }); },
          function (res) { dr.validation = (res && res.validation) || ""; }));
      }
    }
  }

  await Promise.all(jobs); // 总耗时 ≈ 最慢一枪（豆瓣验活 ≤ 8s）
  return results;
}

function nowISO() {
  return new Date().toISOString();
}

function safeSet(key, value) {
  try { config.set(key, value); } catch (e) { log.warn("写配置 " + key + " 失败：" + errText(e)); }
}

async function syncTask(trigger) {
  try {
    var results = await runSync();
    state.results = results;
    var failed = results.filter(function (r) { return r.status === "failed"; });
    var written = results.filter(function (r) { return r.status === "written"; });
    safeSet("last_synced_at", nowISO());
    safeSet("last_error", failed.map(function (r) { return r.name + "：" + r.message; }).join("；"));
    safeSet("synced_count", String((parseInt(config.get("synced_count") || "0", 10) || 0) + 1));
    var summary = "同步完成：写入 " + written.length + " 个，失败 " + failed.length + " 个，共 " + results.length + " 个目标";
    if (failed.length) log.warn(summary + "；" + config.get("last_error"));
    else log.info(summary);
  } catch (e) {
    state.results = [];
    var msg = errText(e);
    safeSet("last_error", msg);
    log.error("同步失败：" + msg);
  } finally {
    state.running = false;
    state.finished_at = nowISO();
  }
}

// 唯一入口：已在跑就跳过；否则起一次同步并立即返回（不等结果）
function startSync(trigger) {
  if (state.running) {
    log.info("已有同步在进行，跳过这次" + (trigger === "timer" ? "定时" : "手动") + "触发");
    return { started: false, reason: "already_running" };
  }
  state.running = true;
  state.started_at = nowISO();
  state.finished_at = null;
  state.last_trigger = trigger;
  log.info("开始同步（" + (trigger === "timer" ? "定时" : "手动") + "）");
  syncTask(trigger);
  return { started: true };
}

// ─── 定时 ────────────────────────────────────────────────────────────────────

var schedule = { timer: null, intervalMin: 0, nextRunAt: null };

// 按配置 sync_interval_min 重排：间隔没变就不动（别把下一次往后推）；0 / 空 = 关。
// 启动时也走这里：不立刻同步，等满一个周期。
function reschedule() {
  var min = parseIntervalMin(config.get("sync_interval_min"));
  if (schedule.timer !== null && min === schedule.intervalMin) return;
  if (schedule.timer !== null) {
    clearInterval(schedule.timer);
    schedule.timer = null;
  }
  schedule.intervalMin = min;
  schedule.nextRunAt = null;
  if (min <= 0) return;
  var ms = Math.min(min * 60000, MAX_TIMER_MS);
  schedule.nextRunAt = new Date(Date.now() + ms).toISOString();
  schedule.timer = setInterval(function () {
    schedule.nextRunAt = new Date(Date.now() + ms).toISOString();
    startSync("timer");
  }, ms);
  log.info("自动同步：每 " + min + " 分钟一次，下次 " + schedule.nextRunAt);
}

function statusView() {
  return {
    running: state.running,
    started_at: state.started_at,
    finished_at: state.finished_at,
    last_synced_at: config.get("last_synced_at"),
    last_trigger: state.last_trigger,
    results: state.results,
    last_error: config.get("last_error") || "",
    synced_count: parseInt(config.get("synced_count") || "0", 10) || 0,
    interval_min: schedule.intervalMin,
    next_run_at: schedule.nextRunAt,
  };
}

// ─── API（给 ui/index.html 用）────────────────────────────────────────────────

plugin.registerAPI("/status", function () {
  return statusView();
});

plugin.registerAPI("/sync", function () {
  return startSync("manual");
});

// 保存设置后调用：按新间隔立即重排
plugin.registerAPI("/reschedule", function () {
  reschedule();
  return statusView();
});

// 可勾选的站 = auth_kind 为 cookie 的 PT 站（apikey / passkey 站不列）；已勾选但找不到的单列出来
plugin.registerAPI("/sites", function () {
  var sites = ptsite.list()
    .filter(function (s) { return s.auth_kind === "cookie"; })
    .map(function (s) {
      return { id: s.id, name: s.name, adapter: s.adapter, enabled: s.enabled, has_cookie: s.has_cookie, hosts: s.hosts || [] };
    });
  var selected = [];
  var sitesError = "";
  try { selected = parseSelectedSites(config.get("sites")); } catch (e) { sitesError = errText(e); }
  var known = {};
  sites.forEach(function (s) { known[s.id] = true; });
  var missing = selected.filter(function (id) { return !known[id]; }).map(function (id) {
    var s = ptsite.get(id);
    return { id: id, name: s ? s.name : "", reason: s ? "not_cookie_site" : "site_missing" };
  });
  return { sites: sites, selected: selected, missing: missing, sites_error: sitesError };
});

reschedule();
