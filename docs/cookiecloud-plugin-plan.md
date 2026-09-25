# cookiecloud 插件 — 设计方案

> 你（用户）在 `D:\workpath\followcat-official-plugins\cookiecloud\` 下落地。本文只产出方案，不动代码。
> 来源对照：`C:\Users\Chiyu\Desktop\文件夹合集\cipher\AutoFollow\plugin\cookiecloud\{cookiecloud,cipher}.go`
>
> **2026-09-23 修订**：主仓权限扩展批次 1（`plugin-permission-expansion-plan.md` §5.1）已落地——`crypto.*` 纯函数、`ptsite.*`（`api.ptsite.read/write`）、`douban.getCookie/setCookie`（`api.douban.cookie.read/write`）、方法级注入、写审计。旧方案写 `AppSetting.site_cookie_<id>` 的落点**已失效**（主仓已删 KV 读取，PT 凭据在 `site_configs.Cookie/APIKey` 加密列）。本文 §1/§2/§4/§5/§6/§9/§10/§11 随之修订；插件代码本身下一轮改。

---

## 1. 目标与集成模型

**做什么**：从用户自托管的 [CookieCloud](https://github.com/easychen/CookieCloud) server 手动拉取浏览器同步过来的 cookies → 解密 → 按用户配置的「域名 → PT 站 id」映射 → 经宿主 facade 写入 FollowCat 的 PT 站凭据（`ptsite.setCookie/setAPIKey`）与豆瓣 Cookie（`douban.setCookie`）。

**集成点（主仓批次 1 已提供）**：
- PT 站凭据存于 `site_configs.Cookie/APIKey`（AES-256-GCM 加密列）；豆瓣 Cookie 存于 `app_settings.douban_cookie`（同算法）。插件只能经 facade 写，宿主负责校验 / 加密 / 热加载 / 审计，明文不出宿主（读侧只有「已配置」+ 打码 + 指纹）。
- 插件用到的 host API：`http.*`（拉 CookieCloud server）、`config.*`（自身配置）、`crypto.*`（解密）、`ptsite.*`、`douban.*`。

**为什么做插件不是主仓内嵌**：
- v3.4 的 plugin runtime（goja + iframe + sandbox REST + 加密 blob）天然适合此类「带凭据 + 周期性外部调用」的功能。
- CookieCloud server 不是 FollowCat 的一等依赖，避免污染主仓。
- 用户可以选不装；同时其他插件以后也能复用同样的凭据写 facade（`ptsite` / `douban`）。

---

## 2. manifest.json

```json
{
  "name": "cookiecloud",
  "version": "1.0.0",
  "author": "FollowCat",
  "description": "从 CookieCloud server 同步浏览器 cookies 到 PT 站凭据与豆瓣 Cookie",
  "source_url": "https://plugins.followcat.io/cookiecloud",
  "permissions": ["api.http", "ui.embed",
                  "api.ptsite.read", "api.ptsite.write",
                  "api.douban.cookie.read", "api.douban.cookie.write"],
  "hooks": []
}
```

- **不订阅任何 hook**：纯被动 + UI 触发，无 event-driven 业务。
- **`ui.embed`**：用户在插件详情页配置 host/uuid/password + 点 "Sync Now" 必须有 UI。
- **`api.http`**：拉 CookieCloud server（⚠️ 敏感权限）。
- **`api.ptsite.read`**：UI 里列出 PT 站供用户挑映射（`ptsite.list/registry`），同步时用 `getCookieMeta` 指纹比对跳过没变的站。
- **`api.ptsite.write`** / **`api.douban.cookie.write`**（⚠️ 敏感）：写凭据。**`api.douban.cookie.read`**：比对豆瓣 Cookie 指纹。权限之间不蕴含，四个都要声明。
- 升级到这一版时，管理页会把这 4 项列在「本次升级新增权限」里，含 2 项敏感权限需二次确认。
- **不要 `api.task.read` / `api.anime.read`**：cookie 同步与番剧数据无关，最小权限。

---

## 3. 配置项（写入 `config.*`）

| key | is_secret | 说明 |
|---|---|---|
| `host` | false | CookieCloud server 根 URL，如 `https://cc.example.com` |
| `cloud_uuid` | true | CookieCloud 用户 UUID（Decrypt 的 key 派生原料） |
| `cloud_pwd` | true | CookieCloud 端到端密码（前端浏览器扩展里设的那个） |
| `site_map` | false | JSON 字符串：`{"hhan.example.com": "<ptsite id>", ...}` — domain → PT 站行 id（`ptsite.list()` 的 `id`，UUID；不是 adapter 名） |
| `sync_douban` | false | `"true"` 时同步 `.douban.com` 的 cookie 到豆瓣 Cookie（`douban.setCookie`，带验活） |
| `last_synced_at` | false | RFC3339 时间，最近成功同步时间，UI 展示用 |
| `last_error` | false | 最近一次失败原因，UI 展示用 |
| `synced_count` | false | 历史成功同步次数 |

> `is_secret=true` 通过 admin REST `PUT /api/plugins/:id/config` 设（manifest 里没法声明）。或者用户首次保存时调一次。详见 sdk.md §config。

---

## 4. CryptoJS-AES 解密

> **已定（2026-09-23）：选项 B，已随主仓批次 1 落地。** 宿主注入 `crypto.sha256/md5/base64Decode/evpBytesToKey/aesDecryptCBC`（无需权限、同步），插件删掉内嵌 CryptoJS。下文 A/C 保留作决策记录。devrt 的 `crypto.*` 用 `node:crypto` 真算，可本地拿真实 CookieCloud 数据验证。
>
> **UTF-8 解码不进宿主（2026-09-24 拍板）**：沙箱没有 `TextDecoder`，宿主也**不**提供 `crypto.utf8Decode`。`aesDecryptCBC` 返回的是 `Uint8Array`，插件自带一个 UTF-8 解码函数（几十行，按 1–4 字节序列解码为码点再拼字符串；直接抄 `docs/plugins/dev-guide.md`「UTF-8 编解码」的 `decodeUtf8` 参考实现）把它还原成 JSON 文本。下文伪代码里的 `utf8Decode` 即指这个插件内联函数。

CookieCloud server 返回的 payload 是 `CryptoJS.AES.encrypt(json, "<md5(uuid+'-'+pwd)[:16]>")`：
- base64 → `Salted__` + 8B salt + N×16B ciphertext
- key/iv 用 **OpenSSL EVP_BytesToKey + MD5**（32B key + 16B iv）
- 内部 PKCS7 padding

**插件 runtime 限制**（per `sdk.md`）：
- ES5+ 纯 JS，**无 `require`/`import`/`Function`/`eval`**
- **host 不暴露任何 crypto API**（无 md5 / aes / base64 hex 转换）
- 只能用 JS 原生：字符串、ArrayBuffer/Uint8Array（来自 `data.*`）、`atob`/`btoa`（如果 goja 暴露了 — 待确认）

**三种选择，按推荐度排序：**

### 选项 A（推荐）：纯 JS 内嵌 CryptoJS-mini

把 CryptoJS 的 MD5 + AES-CBC + EVP_BytesToKey + base64 解码 内联到 `index.js`，约 800-1200 行（minified 后约 30-50 KiB）。

**实现路径**：
1. 直接抄 [CryptoJS](https://github.com/brix/crypto-js) 源码，**只保留**：`core.js` + `enc-base64.js` + `md5.js` + `cipher-core.js` + `aes.js` + `mode-cbc.js` + `pad-pkcs7.js` + `kdf-openssl.js`（OpenSSL EVP_BytesToKey 算法）
2. 把 module 包装去掉，整体 IIFE 包到顶部：`var CryptoJS = (function() { ... return CryptoJS; })()`
3. 解密一行：`CryptoJS.AES.decrypt(b64, password).toString(CryptoJS.enc.Utf8)`
4. 验证：拿 demo `cipher.go` 的 `BytesToKeyAES256CBCMD5` 算法对照一组测试向量

**优点**：自洽、无 host 依赖。  
**缺点**：包大（30-50 KiB）；需要审计 — 把 CryptoJS 源码塞进自己的 plugin 等于把第三方代码纳入自己的安全责任。  
**建议**：从 [crypto-js@4.2.0](https://www.npmjs.com/package/crypto-js) 截子集（不要早期版本，prototype pollution 修过）。

### 选项 B：插件 runtime 暴露 `crypto` 全局对象（需要改主仓）

向 `internal/plugin/host_*.go` 加一个 `crypto` facade：
```js
crypto.md5(str) → hex string
crypto.aesDecryptCBC(keyBytes, ivBytes, ciphertext) → plain bytes
crypto.base64Decode(str) → Uint8Array
```
（参考已有的 `data` facade 实现，也是 binary IO）

**优点**：插件代码 100 行；其他插件未来也能复用。  
**缺点**：动主仓 + 加权限白名单（`api.crypto`？）+ 写 SDK 文档 + 升级 sdk.md major version。脱离了「方案，去插件那边写」的范围。

### 选项 C：混合方案 — 解密放 server side

新增一个内部 endpoint（plugin 专用，鉴权走 plugin token）：`POST /api/plugins/cookiecloud/decrypt {ciphertext, key} → {plaintext}`，由主仓帮做 AES 解密。

**优点**：plugin 没 crypto 代码。  
**缺点**：plugin token 暴露解密能力——其他恶意插件也能调；要做严格的 caller 校验；增加主仓依赖；和「插件自洽」的设计哲学冲突。**不推荐**。

---

## 5. 写凭据：经 `ptsite` / `douban` facade（旧 KV 方案作废）

旧方案假设写 `AppSetting.site_cookie_<id>`，但主仓 `pt/base.go loadCredential` 早已删除 KV fallback——凭据只从 `site_configs.Cookie/APIKey` 读，写 KV 等于写进黑洞（主仓批次 1 同时关掉了管理端写这些 key 的白名单死路径）。旧 §5 的三种解法（`hostkv.setSiteCookie` / 插件代打 admin REST / 主仓读插件 blob）全部作废。

现在的写入口（主仓批次 1）：

| 目标 | 方法 | 权限 | 说明 |
|---|---|---|---|
| PT 站 Cookie | `await ptsite.setCookie(siteId, ck)` | `api.ptsite.write` | 单列更新、加密落库；cookie 站才收，apikey / none 站拒绝（reject） |
| PT 站 API Key | `await ptsite.setAPIKey(siteId, key)` | `api.ptsite.write` | 目前只有 mteam 是 apikey 站；CookieCloud 同步的是 cookie，通常用不到 |
| 豆瓣 Cookie | `await douban.setCookie(ck, {validate: true})` | `api.douban.cookie.write` | 加密落库 + 立即热加载；验活上限 8s，回 `validation` 五态（到点未完 = `rate_limited`，已写入） |
| 比对用指纹 | `ptsite.getCookieMeta(siteId)` / `douban.getCookie()` | `api.ptsite.read` / `api.douban.cookie.read` | `{configured, sha256}`（2026-09-24 去掉 masked：明文不出宿主，只需判「是否相同」），`sha256` 按 sdk.md「Cookie 归一化契约」计算 |

要点：

- **`site_map` 的值是 PT 站行 id**（`ptsite.list()` 返回的 `id`，UUID），不是 adapter 名；同一 adapter 可有多行（多账号）。UI 用 `ptsite.list()` 让用户下拉选，别让用户手填。另加一个开关「同步豆瓣 Cookie」+ 豆瓣域名（默认 `.douban.com`）。
- **只写变了的**：插件侧 `crypto.sha256(normalizeCookie(新ck)) === meta.sha256` 就跳过，省一次写和一条审计；`normalizeCookie` 照抄 sdk.md 参考实现（不能用默认 `sort()`）。
- **不写 `rss_urls`**：facade 不开放，也不需要。
- **审计**：每次 set* 宿主都会在插件详情页日志里留一条 `[审计] AUDIT action=... target=...`（不含值），UI 文案可以提示用户去那里看。
- 错误按站点收集：某站 reject（站点被删 / 类型不匹配）不影响其它站，汇总进返回值与 `last_error`。

---

## 6. JS 主流程

**同步流程写死（2026-09-23 拍板）**：先拉 CookieCloud（数据依赖，必须在前）→ 解密 → 所有 `ptsite.setCookie/setAPIKey` 与 `douban.setCookie` **并发发出**（`Promise.all`，不逐个 `await`）→ 汇总。总耗时 ≈ 拉取 + 最慢一枪（豆瓣验活 ≤ 8s）；registerAPI 墙钟 10s，所以拉 CookieCloud 要尽量快（它本身有 `http` 的 10s 上限，但超过约 2s 就可能让整次 `/sync` 超时——超时后已发出的写照常完成，只是 UI 拿不到汇总）。

```js
// index.js（伪代码，async 版；normalizeCookie 照抄 sdk.md 参考实现，utf8Decode 为插件内联的 UTF-8 解码函数，宿主不提供）

async function syncOnce() {
    var host = config.get("host");
    var uuid = config.get("cloud_uuid");
    var pwd  = config.get("cloud_pwd");
    var siteMap;                       // { "pt.example.com": "<ptsite id>", ... }
    try { siteMap = JSON.parse(config.get("site_map") || "{}"); }
    catch (e) { return { ok: false, error: "site_map JSON 无效" }; }
    if (!host || !uuid || !pwd) return { ok: false, error: "missing config" };

    // 1. 拉 ciphertext（必须先于任何写：数据依赖）
    var resp = await http.get(host + "/get/" + uuid, {});
    if (resp.status !== 200) return { ok: false, error: "server " + resp.status };
    var payload = JSON.parse(resp.body);               // { encrypted }

    // 2. 解密（宿主 crypto.*，同步）
    var data;
    try {
        var raw = crypto.base64Decode(payload.encrypted);   // "Salted__" + salt + 密文
        var kv  = crypto.evpBytesToKey(crypto.md5(uuid + "-" + pwd).substring(0, 16), raw.subarray(8, 16), 32, 16);
        data = JSON.parse(utf8Decode(crypto.aesDecryptCBC(kv.key, kv.iv, raw.subarray(16))));
    } catch (e) {
        return { ok: false, error: "decrypt failed: " + e.message };
    }
    var jar = data.cookie_data || {};
    var toHeader = function (cookies) {
        return cookies.map(function (c) { return c.name + "=" + c.value; }).join("; ");
    };

    // 3. 组装所有写，并发发出（Promise.all，不逐个 await）
    var jobs = [];
    Object.keys(siteMap).forEach(function (domain) {
        var siteId = siteMap[domain];
        if (!jar[domain]) { log.warn("domain " + domain + " 不在 CookieCloud 数据中，跳过"); return; }
        var ck = toHeader(jar[domain]);
        var meta = ptsite.getCookieMeta(siteId);              // 同步；null = 站点已删
        if (meta && meta.sha256 === crypto.sha256(normalizeCookie(ck))) return;   // 没变，跳过
        jobs.push(ptsite.setCookie(siteId, ck).then(
            function () { return { target: siteId, ok: true }; },
            function (e) { return { target: siteId, ok: false, error: e.message }; }));
    });
    if (config.get("sync_douban") === "true" && jar[".douban.com"]) {
        var dck = toHeader(jar[".douban.com"]);
        if (douban.getCookie().sha256 !== crypto.sha256(normalizeCookie(dck))) {
            jobs.push(douban.setCookie(dck, { validate: true }).then(
                function (r) { return { target: "douban", ok: true, validation: r.validation }; },
                function (e) { return { target: "douban", ok: false, error: e.message }; }));
        }
    }
    var results = await Promise.all(jobs);                 // 总耗时 ≈ 最慢一枪（豆瓣验活 ≤ 8s）

    config.set("last_synced_at", new Date().toISOString());
    var failed = results.filter(function (r) { return !r.ok; });
    config.set("last_error", failed.map(function (r) { return r.target + ": " + r.error; }).join("; "));
    config.set("synced_count", String(parseInt(config.get("synced_count") || "0", 10) + 1));
    return { ok: failed.length === 0, results: results };
}

plugin.registerAPI("/sync", async function (req) {
    var result = await syncOnce();
    if (!result.ok) log.error("cookiecloud sync 失败：" + (result.error || config.get("last_error")));
    return result;                                         // UI 一次拿到每站结果 + 豆瓣 validation
});
```

---

## 7. UI（`ui/index.html`）

最小可用：
- 4 个表单字段：host / cloud_uuid / cloud_pwd / site_map (textarea, JSON)
- 「保存」按钮 → 调 plugin SDK 写 config（`is_secret` 标记需 admin REST 单独设一次）
- 「立即同步」按钮 → POST `/api/plugins/<id>/api/sync`
- 状态条：上次同步时间、是否成功、累计次数
- 错误展示

UI 框架可选，原生 HTML+JS 即可（参考 dashboard-stats 插件的 UI 写法）。

---

## 8. 周期同步问题

**当前 plugin runtime 没有 cron hook**。三种应对：
- **v1**：只支持手动同步（UI 按钮）。用户用系统 cron `curl -X POST` 打 plugin API 端点实现自动化。文档里写清楚。
- **v1.5**：等主仓加 `on_cron_tick` 或 `on_minute_tick` hook（独立任务，不在本插件 scope）。
- **替代**：复用现有 hook，比如 `on_episode_found` 触发 syncOnce(throttled by last_synced_at)。**hack，不推荐**。

→ v1 出 manual + curl 文档 即可。

---

## 9. 测试 / 验收清单

- [ ] 解密链路用 devrt（`crypto.*` 是 node:crypto 真实现）拿一组已知 ciphertext/plaintext 对跑通；主仓 `host_api_crypto_test.go` 已有 OpenSSL 生成的 CookieCloud 形态向量
- [ ] `syncOnce` 在 host=空 / uuid=空 / 网络失败 / 解密失败 / site_map 无效 5 种 path 都不 panic
- [ ] `ptsite.setCookie` 写入后，主仓 PT pull 立刻读到新 cookie；`douban.setCookie` 后豆瓣请求立即带新 Cookie（端到端 happy path）
- [ ] 同一份 cookie 再同步一次：指纹比对命中，不发写、不产生审计行
- [ ] 某站被删 / 类型不匹配：该站 reject 被收集，其它站照常写入
- [ ] 所有写并发发出（`Promise.all`），豆瓣验活慢（≤8s）时 PT 站写入不被拖住
- [ ] `is_secret` 字段实际加密落库（admin REST 设过之后）
- [ ] UI 在配置缺失时显式提示，不让用户以为「没事」

---

## 10. 依赖（主仓批次 1 清单，已落地）

主仓 `plugin-permission-expansion-plan.md` §5.1：

- [x] 权限常量 `api.ptsite.read/write`、`api.douban.cookie.read/write`（+ `api.ruleflow.read` 正式名），敏感权限规则（`.write` 后缀 / `api.http`）
- [x] `crypto.*` 纯函数 facade（始终注入）——取代 §4 选项 A 的内嵌 CryptoJS
- [x] `ptsite.*` facade：`pt/credential.go SetCredential` 与管理端 `PATCH /api/pt-sites/:id` 共用（authKind 校验 + 单列 UPDATE）
- [x] `douban.*` facade：`metadata/douban_credential.go ApplyDoubanCookie` 与管理端共用；插件路径验活 8s 上限，到点回 `rate_limited`
- [x] 方法级注入、写审计（`audit/plugin/<id>`）、插件详情页日志显示审计行
- [x] 安装 / 升级 UI：敏感权限标红 + 二次确认，升级展示「本次升级新增权限」
- [x] sdk.md / dev-guide.md 权限表与同步/异步一览、Cookie 归一化契约 + 测试向量；devrt `crypto`/`ptsite`/`douban` mock
- [ ] **下一轮（插件侧）**：按 §2/§5/§6 改 `plugins/cookiecloud`——删内嵌 CryptoJS、写入改 facade、`/sync` 并发写、UI 用 `ptsite.list()` 选站；宿主部署须与此版插件一起上（旧插件写的 KV 早已没人读）

---

## 11. 与 demo (`AutoFollow/plugin/cookiecloud`) 的差异

| 项 | demo (Go) | 本方案 (JS plugin) |
|---|---|---|
| 解密 | Go std lib `crypto/aes` + `crypto/md5` | 宿主 `crypto.*` facade（选项 B，同样是 Go std lib） |
| Cookie 落地 | demo 没明确，看起来是返回给 caller | 经 `ptsite.setCookie` / `douban.setCookie` 写入 `site_configs` 加密列 / `app_settings.douban_cookie` |
| 触发 | demo 内嵌 .go 没看到调度 | UI 按钮 + 外部 cron curl |
| 配置 | 结构体字段 host/uuid/pwd | plugin config + per-domain map |
| 凭据加密 | 无 | 走 plugin config 的 AES-256-GCM |

---

**总结**：插件本身约 200-300 行业务 JS + 150 行 UI HTML（不再内嵌 CryptoJS）。  
**前置主仓改动**：批次 1（见 §10），已落地。
