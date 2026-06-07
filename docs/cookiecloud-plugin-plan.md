# cookiecloud 插件 — 设计方案

> 你（用户）在 `D:\workpath\followcat-official-plugins\cookiecloud\` 下落地。本文只产出方案，不动代码。
> 来源对照：`C:\Users\Chiyu\Desktop\文件夹合集\cipher\AutoFollow\plugin\cookiecloud\{cookiecloud,cipher}.go`

---

## 1. 目标与集成模型

**做什么**：从用户自托管的 [CookieCloud](https://github.com/easychen/CookieCloud) server 周期/手动拉取浏览器同步过来的 cookies → 解密 → 按用户配置的「域名 → site_id」映射 → 写入 FollowCat 的 `AppSetting` KV，覆写 PT 站的 `site_cookie_<site_id>`（这是 phase A pt.Provider 已经在读的 key）。

**集成点（不需要改主仓代码）**：
- 主仓 phase A 已经把 cookie 抽到 `AppSetting` key=`site_cookie_<site_id>`，详情页拉不到时降级 — 这就是「插件可覆写、未配也能跑」的解耦点。
- 插件唯一需要的 host API：`http.*`（拉 CookieCloud server）+ `config.*`（保存自身配置）。**问题**：插件目前没有写 `AppSetting` 的能力，下面 §6 给出三种取舍。

**为什么做插件不是主仓内嵌**：
- v3.4 的 plugin runtime（goja + iframe + sandbox REST + 加密 blob）天然适合此类「带凭据 + 周期性外部调用」的功能。
- CookieCloud server 不是 FollowCat 的一等依赖，避免污染主仓。
- 用户可以选不装；同时其他插件以后也能复用同样的「写 AppSetting」通道。

---

## 2. manifest.json

```json
{
  "name": "cookiecloud",
  "version": "1.0.0",
  "author": "FollowCat",
  "description": "从 CookieCloud server 同步浏览器 cookies 到 PT 站凭据 (site_cookie_<id>)",
  "source_url": "https://plugins.followcat.io/cookiecloud",
  "permissions": ["api.http", "ui.embed"],
  "hooks": []
}
```

- **不订阅任何 hook**：纯被动 + UI 触发，无 event-driven 业务。
- **`ui.embed`**：用户在插件详情页配置 host/uuid/password + 点 "Sync Now" 必须有 UI。
- **`api.http`**：拉 CookieCloud server。
- **不要 `api.task.read` / `api.anime.read`**：cookie 同步与番剧数据无关，最小权限。

---

## 3. 配置项（写入 `config.*`）

| key | is_secret | 说明 |
|---|---|---|
| `host` | false | CookieCloud server 根 URL，如 `https://cc.example.com` |
| `cloud_uuid` | true | CookieCloud 用户 UUID（Decrypt 的 key 派生原料） |
| `cloud_pwd` | true | CookieCloud 端到端密码（前端浏览器扩展里设的那个） |
| `site_map` | false | JSON 字符串：`{"hhan.example.com": "hhan", "u2.example.com": "ubits"}` — domain → FollowCat site_id |
| `last_synced_at` | false | RFC3339 时间，最近成功同步时间，UI 展示用 |
| `last_error` | false | 最近一次失败原因，UI 展示用 |
| `synced_count` | false | 历史成功同步次数 |

> `is_secret=true` 通过 admin REST `PUT /api/plugins/:id/config` 设（manifest 里没法声明）。或者用户首次保存时调一次。详见 sdk.md §config。

---

## 4. **🔴 核心难点：CryptoJS-AES 解密**

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

## 5. 写 AppSetting：插件无能力 → 三种解法

`config.set()` 只写**插件自己的** namespace（`plugin_configs.<plugin_id>.<key>`），不能写 host 级 `app_settings`。

但同步出来的 cookie 必须写到 `site_cookie_<site_id>` 这个 host 级 key 才能被 PT pull 流程读到。

### 方案 1（推荐 v1）：开"plugin → AppSetting"白名单 facade

主仓 `internal/plugin/host_*.go` 暴露：
```js
// 仅允许写以 site_cookie_ 开头的 key（白名单）
hostkv.setSiteCookie(siteID, value)
```
- 权限名：`api.kv.write.site_cookie`
- 实现：内部 `appSettingStore.Set("site_cookie_" + siteID, value)`，对 key 前缀做 strict regex 校验
- 这是非常窄的能力暴露，可审计性强

### 方案 2：插件每次同步后调 admin REST `POST /api/admin/settings`

- 但 plugin token 不是 admin token，REST 会被 RBAC 拦
- 可以引入一个「plugin 代写 AppSetting」的内部端点，鉴权走 plugin token
- 本质等于方案 1，只是走 HTTP 不走 native facade

### 方案 3：把同步好的 cookie 存在 `data.*`（plugin blob），由主仓 PT pull 流程**读**插件 blob

需要主仓 phase A 改 `pt.Provider.loadCookie()` 的 fallback 链：先 `AppSetting` → 找不到 → 查 `cookiecloud` 插件的 blob → 拿到。
- 优点：插件无写主仓能力，最小信任
- 缺点：耦合 — pt 框架知道有 cookiecloud 插件存在，违反插件解耦原则；多插件冲突时优先级模糊
- **不推荐**

→ **结论：v1 走方案 1**。这是这个插件能落地的最关键依赖项，建议先在主仓加 `hostkv.setSiteCookie` facade（小 PR），插件再开工。

---

## 6. JS 主流程

```js
// index.js（伪代码）

// === 顶部内嵌 CryptoJS 子集 ===
var CryptoJS = (function () { /* ~1000 行截取 */ return CryptoJS; })();

function syncOnce() {
    var host = config.get("host");
    var uuid = config.get("cloud_uuid");
    var pwd  = config.get("cloud_pwd");
    var siteMapRaw = config.get("site_map") || "{}";

    if (!host || !uuid || !pwd) {
        return { ok: false, error: "missing config" };
    }

    var siteMap;
    try { siteMap = JSON.parse(siteMapRaw); }
    catch (e) { return { ok: false, error: "site_map JSON 无效" }; }

    // 1. 拉 ciphertext
    var resp = http.get(host + "/get/" + uuid, {});
    if (resp.status !== 200) {
        return { ok: false, error: "server " + resp.status };
    }
    var payload = JSON.parse(resp.body); // { uuid, encrypted }

    // 2. 解密
    var keyPwd = CryptoJS.MD5(uuid + "-" + pwd).toString().substring(0, 16);
    var plaintext;
    try {
        plaintext = CryptoJS.AES.decrypt(payload.encrypted, keyPwd).toString(CryptoJS.enc.Utf8);
    } catch (e) {
        return { ok: false, error: "decrypt failed: " + e.message };
    }
    var data = JSON.parse(plaintext); // { cookie_data: { "domain.com": [{name,value,...}, ...] } }

    // 3. 按 site_map 把每个 domain 的 cookies 拼成 "k=v; k2=v2; ..." 写入 host KV
    var written = 0;
    for (var domain in siteMap) {
        if (!siteMap.hasOwnProperty(domain)) continue;
        var siteID = siteMap[domain];
        var cookies = data.cookie_data && data.cookie_data[domain];
        if (!cookies) {
            log.warn("domain " + domain + " 不在 CookieCloud 数据中，跳过");
            continue;
        }
        var parts = [];
        for (var i = 0; i < cookies.length; i++) {
            parts.push(cookies[i].name + "=" + cookies[i].value);
        }
        var cookieStr = parts.join("; ");
        // ⚠️ 依赖：方案 1 的 hostkv.setSiteCookie facade
        hostkv.setSiteCookie(siteID, cookieStr);
        written++;
    }

    config.set("last_synced_at", new Date().toISOString());
    config.set("last_error", "");
    var n = parseInt(config.get("synced_count") || "0", 10) + 1;
    config.set("synced_count", String(n));

    return { ok: true, written: written };
}

// 暴露给 UI 触发
plugin.registerAPI("/sync", function (req) {
    var result = syncOnce();
    if (!result.ok) {
        config.set("last_error", result.error);
        log.error("cookiecloud sync 失败：" + result.error);
    } else {
        log.info("cookiecloud 同步完成，写入 " + result.written + " 个 site");
    }
    return result;
});

plugin.registerAPI("/status", function (req) {
    return {
        configured: !!(config.get("host") && config.get("cloud_uuid") && config.get("cloud_pwd")),
        last_synced_at: config.get("last_synced_at") || "",
        last_error: config.get("last_error") || "",
        synced_count: parseInt(config.get("synced_count") || "0", 10)
    };
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

- [ ] CryptoJS-mini 单测（拿 cipher.go 的 BytesToKeyAES256CBCMD5 + 已知 ciphertext/plaintext 对）
- [ ] `syncOnce` 在 host=空 / uuid=空 / 网络失败 / 解密失败 / site_map 无效 5 种 path 都不 panic
- [ ] `hostkv.setSiteCookie` 写入后，主仓 PT pull 立刻读到新 cookie（端到端 happy path）
- [ ] `is_secret` 字段实际加密落库（admin REST 设过之后）
- [ ] UI 在配置缺失时显式提示，不让用户以为「没事」

---

## 10. 阻塞依赖（先解决再写插件）

1. **🔴 主仓 PR**：`internal/plugin/host_*.go` 加 `hostkv.setSiteCookie(siteID, value)` facade + 权限名 `api.kv.write.site_cookie` + sdk.md 更新（约 100-200 行；codex APPROVE 后合）。
2. **🔴 决定 §4 选 A 还是 B**。
   - 选 A：你这边自己处理 CryptoJS 截子集 + 验证（无主仓改动）
   - 选 B：再开个主仓 PR 加 `crypto` facade，会更通用但慢一周
3. **🟡 跑通 §9 的端到端 happy path 验证**

---

## 11. 与 demo (`AutoFollow/plugin/cookiecloud`) 的差异

| 项 | demo (Go) | 本方案 (JS plugin) |
|---|---|---|
| 解密 | Go std lib `crypto/aes` + `crypto/md5` | 内嵌 CryptoJS-mini（选项 A） |
| Cookie 落地 | demo 没明确，看起来是返回给 caller | 写主仓 `AppSetting.site_cookie_<id>` 经 facade |
| 触发 | demo 内嵌 .go 没看到调度 | UI 按钮 + 外部 cron curl |
| 配置 | 结构体字段 host/uuid/pwd | plugin config + per-domain map |
| 凭据加密 | 无 | 走 plugin config 的 AES-256-GCM |

---

**总结**：插件本身约 200-300 行业务 JS + 1000 行内嵌 CryptoJS + 150 行 UI HTML。  
**前置主仓改动**：`hostkv.setSiteCookie` facade（最小写权限）。
