# FollowCat 插件开发指南

> 面向插件作者的实战教程。读完这篇你能写出一个生产可用的通知/聚合/监控插件。
>
> SDK 速查（API 签名、字段表、限制清单）请配合 [`sdk.md`](./sdk.md) 食用，本文不重复。

---

## 0. 五分钟跑通

打开 FollowCat → 管理页 → 插件 → 上传 zip → 启用 → 触发一次下载 → 看日志。
就这么五步。下面是最小可运行 zip 的全部内容：

**`hello-world.zip`**（zip 根直接是这两个文件，不要再嵌一层目录）：

```
hello-world.zip
├── manifest.json
└── index.js
```

**`manifest.json`**：

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "source_url": "https://example.com/hello",
  "permissions": ["hook.task.read"],
  "hooks": ["on_task_completed"]
}
```

**`index.js`**：

```js
plugin.on("on_task_completed", function (data) {
  log.info("追完了：" + data.anime_title);
});
```

启用后等到某个番剧追完，插件详情页的「最近日志」会出现 `追完了：xxx`。

---

## 1. 心智模型

```
                  +------------------+        plugin.on("hook", fn)
RSS / 调度器 ---> |                  | ---> 你写的 JS（goja 沙箱）
qBit / linker --->|  EventBus 同步分 |       |
                  |  发到每个插件     |       +--> await http.post("...")
                  |                  |       +--> log.info(...)
                  +------------------+       +--> config.set(...)
```

- **Hook 是只读通知**：你看到的 `data` 是宿主推过来的副本，改它不会影响主流程。
- **每个插件一个事件循环**：你的代码仍是单线程执行（不用加锁），同步代码段之间不会并发；但 `async` 回调在 `await`（比如 `await http.get(...)`）期间，同一插件的其它 hook / API 可以先跑。每次调用有墙钟上限（hook 10s / API 10s / `should_download` 3s，**含 `await`**），超时结果被丢弃。
- **出网是异步的**：`http.*`、`ptsite.setCookie/setAPIKey`、`douban.setCookie` 返回 Promise，所在函数写成 `async function` 并 `await`（见 §5）；其余 facade（`config` / `data` / `crypto` / `anime` / `task` / `ruleflow` / `ptsite` 读方法 / `douban.getCookie` / `log`）是同步的。
- **凭证不会泄漏**：`anime.get` 返回的是脱敏 view，拿不到 `Server.Password` 之类；PT 站 / 豆瓣凭据只写不读，读侧只有「已配置」+ 指纹。
- **没有文件系统、没有 require**：始终可用的是 `plugin` / `log` / `config` / `data` / `crypto`；`http` / `anime` / `task` / `ruleflow` / `ptsite` / `douban` 按 manifest 权限注入（见 §2 权限表）。

---

## 2. manifest.json 字段全解

```json
{
  "name": "notify",                                // 必填，[a-z0-9-]{3,64}，全局可重复
  "version": "1.0.0",                              // 必填，semver-ish
  "source_url": "https://github.com/you/notify",   // 必填，与 name 联合派生 plugin_id
  "author": "you@example.com",                     // 可选，仅显示
  "description": "Slack/Telegram 多渠道通知",        // 可选，仅显示
  "permissions": [                                 // 必填，每条都要在白名单
    "hook.download.read", "hook.link.read", "hook.task.read", "api.http"
  ],
  "hooks": [                                       // 必填，每条都要在白名单
    "on_download_done", "on_link_done", "on_task_completed"
  ]
}
```

### `name` + `source_url` 决定 `plugin_id`

`plugin_id = sha1(source_url + "\x00" + name)[:16]`，全局唯一。

- 升级同一插件 → **保持 `name` 和 `source_url` 不变**，`plugin_id` 不变，配置不丢，自动重启 worker
- 同一份代码两路发布 → 改 `source_url` 即可作为两个独立插件并存（不同配置不同状态）

### `permissions` 与 `hooks` 必须**双校验**

权限白名单见 sdk.md，完整 hook 白名单见 sdk.md「Hook 列表」。其中 `should_download` 是**同步否决 hook**（读返回值可拦下载，需 `hook.download.write`——敏感权限，详见 sdk.md「同步否决 hook」），其余 `on_*` 都是只读通知 hook：
`on_episode_found`, `on_download_done`, `on_download_failed`, `on_link_done`, `on_link_failed`, `on_episode_acquired`, `on_task_completed`, `on_task_reopened`。

**关键点**：`plugin.on("on_link_done", fn)` 只有当 manifest 同时声明
`"hooks": [..., "on_link_done", ...]` **且** `"permissions": [..., "hook.link.read", ...]`
才能注册成功，否则运行期 throw。

| Hook | 需要的 permission |
|------|------------------|
| `on_episode_found`, `on_download_done`, `on_download_failed` | `hook.download.read` |
| `should_download` | `hook.download.write` ⚠️ |
| `on_link_done`, `on_link_failed` | `hook.link.read` |
| `on_episode_acquired`, `on_task_completed`, `on_task_reopened` | `hook.task.read` |

> 2026-09-24 起 hook 权限一次性硬改名，**不留别名**：旧的 `hook.download` / `hook.link` / `hook.task` 声明直接解析失败；`hook.notify` 与 `on_notification_before_send` / `on_notification_after_send` 已删除。
>
> `on_task_completed` / `on_episode_acquired` / `on_task_reopened` 同时覆盖 Mikan 与豆瓣任务，按 `p.source`（`"mikan"` / `"douban"`）区分；`task_id` 只在各自命名空间内有意义。
>
> `on_episode_acquired` 只在集数新入库（位图由灭变亮）时触发，覆盖自动整理 / 手动链接（含部分完成）/ 合集确认；重复整理已入库的集不触发。`p.episodes` 只含本次新亮的集（综艺按期为期号、电影为空数组且只在首次获取时发一次）。

### facade 权限表

没声明权限时对应全局对象是 `undefined`；对象存在但没授权的方法也是 `undefined`（方法级注入，`typeof ptsite.setCookie` 可探测）。权限之间**不蕴含**：要读又要写就两个都声明。⚠️ = 敏感权限（安装 / 升级时管理员需二次确认）。完整规则与「规划中」权限见 sdk.md「权限」章。

| permission | 注入 / 解锁 | 同步 / 异步 |
|------------|------------|------------|
| （无需权限） | `plugin` / `log` / `config` / `data` / `crypto`（sha256 / md5 / base64Decode / evpBytesToKey / aesDecryptCBC） | 同步 |
| `api.http` ⚠️ | `http.get/post/put/delete` | 异步 |
| `api.anime.read` | `anime.get` | 同步 |
| `api.task.read` | `task.get/list` | 同步 |
| `api.ruleflow.read`（旧名 `api.ruleflow` 已弃用，仍可用） | `ruleflow.list` | 同步 |
| `api.ptsite.read` | `ptsite.list/get/registry/getCookieMeta` | 同步 |
| `api.ptsite.write` ⚠️ | `ptsite.setCookie/setAPIKey` | 异步 |
| `api.douban.cookie.read` | `douban.getCookie` | 同步 |
| `api.douban.cookie.write` ⚠️ | `douban.setCookie(v, {validate})`（验活上限 8s，到点回 `rate_limited`） | 异步 |
| `ui.embed` | 允许声明 `manifest.ui.entry` | — |

hook 类权限（`hook.download.read` / `hook.download.write` ⚠️ / `hook.link.read` / `hook.task.read`）不注入对象，只决定能 `plugin.on` 哪些 hook，见上表。

**不要用 `http.*` 回跳 FollowCat 自己的 REST**（`localhost` / 内网 / 宿主域名的 `/api/...`）：宿主数据一律走上表的 facade，registry 审核会拦（见 sdk.md「内部访问走 facade」）。

---

## 3. Hook payload 实战

每个 hook 的字段表见 sdk.md。这里讲**怎么写**才不会被字段缺失坑到。

### 黄金规则：所有 `omitempty` 字段都要兜底

`on_download_done` 的 `data.files`、`data.size`、`data.save_path`、`data.category` 都是 `omitempty`：

```js
plugin.on("on_download_done", function (data) {
  // ✅ 正确
  var size = data.size || 0;
  var files = data.files || [];
  var path = data.save_path || "未知";

  // ❌ 错误：files 可能 undefined → undefined.length 抛错 → 本次 hook 作废、记 last_error
  for (var i = 0; i < data.files.length; i++) { ... }
});
```

### 黄金规则：异常被隔离，但**别浪费**

插件抛错（含 async 回调 reject）不会影响主流程，宿主记 WARN 并写到 `last_error_msg`，**不计 panic**；`panic_count` 只统计宿主侧 Go panic，1 分钟内 5 次会**自动 disable**插件。但抛错会让这次 hook 的后续逻辑全部作废，所以：

```js
plugin.on("on_download_done", function (data) {
  try {
    // 你的逻辑
  } catch (e) {
    log.error("处理 on_download_done 出错: " + e);
    // 不要 throw — 让 worker 继续干活
  }
});
```

### 黄金规则：HTTP 失败也要 try/catch

`http.post` 返回 Promise，在超时 / 网络错误 / 限流时 **reject**——`await` 处会抛出；4xx/5xx 不 reject，要看 `resp.status`。永远包（try/catch 必须包住 `await` 那一行才接得住）：

```js
plugin.on("on_download_done", async function (data) {
  try {
    var resp = await http.post(url, body, headers);
    if (resp.status >= 400) {
      log.warn("upstream " + resp.status + ": " + resp.body);
    }
  } catch (e) {
    log.error("http.post 失败: " + e);
  }
});
```

---

## 4. 配置读写：`config`

`config.get(key)` 永远返回 `string` 或 `null`。`config.set(key, value)` 写入永久存储。

### 数字怎么存？

```js
var n = parseInt(config.get("count") || "0", 10);
config.set("count", String(n + 1));
```

### 数组/对象怎么存？

```js
config.set("recipients", JSON.stringify(["@alice", "@bob"]));
var list = JSON.parse(config.get("recipients") || "[]");
```

### 敏感字段（token/密码/webhook URL）

**所有 `config.*` value 在 store 层无条件 AES-256-GCM 加密落库。** `is_secret` 标记**不是加密开关**，仅决定 API/UI 回读时是否返回明文（`is_secret=true` 时回传空字符串，UI 显示「已设置」占位）。

- `config.set("token", v)` 来自 JS：默认 `is_secret=false`，UI 能看到值
- `PUT /api/plugins/:id/config {"key":"token","value":"v","is_secret":true}` 来自管理页/REST：标记为 secret，回读脱敏

实际操作：插件 README 列出哪些 key 应当标 secret（如 `slack_webhook_url`、`telegram_bot_token`），管理员在 UI 勾选；**加密始终生效，无需担心明文落地**。

### 列举已有 keys（v3.4+）

```js
var keys = config.list();         // ["api_endpoint", "user_token"]
keys.forEach(function (k) {
  log.info(k + " = " + config.get(k));
});
```

跨 plugin 隔离，仅返回当前插件的 keys，按字典序排序。

### 配额（v3.4）

- 每插件最多 **500 个 config keys**（admin 可调到 5000）
- 单 value 上限 **64 KiB**（写死）
- 超限抛错，`message` 含 `current=N limit=M`：`config.set("key501", ...)` → `"plugin config: row quota exceeded: current=500 limit=500"`

如果你的插件需要存 >64 KiB 单值或二进制，看下一节 `data.*`。

---

## 4.5 大对象 / 二进制存储：`data.*`（v3.4+）

`data.*` 是 v3.4 新引入的加密 blob 存储，适合放：

- 解析后的大型 JSON 状态机快照（>64 KiB）
- 番剧封面 / 缩略图等二进制
- RSS 解析缓存、douban 元数据 snapshot
- 索引文件（自建二级索引）

### API

```js
// 写入：value 必须是 ArrayBuffer 或 Uint8Array，传 string 抛 TypeError
data.put("cover_42.jpg", uint8Array.buffer);
data.put("snapshot.bin", new Uint8Array([0x00, 0x01]));

// 读取：返回 ArrayBuffer 或 null
var buf = data.get("cover_42.jpg");
if (buf) { /* 处理 */ }

// 列出全部 blob name（仅 names，不取 values 避免一次性解密大量数据）
var names = data.list();          // ["cover_42.jpg", "snapshot.bin"]

// 删除（返回 boolean，不存在也返 true）
data["delete"]("cover_42.jpg");   // 注意 delete 是 reserved word，用 bracket 形式
```

### 配额（v3.4 默认）

- 单个 blob ≤ **4 MiB**（admin 可调到 64 MiB）
- 单个插件总和 ≤ **16 MiB**（admin 可调到 256 MiB）
- 跨 plugin 隔离

### 严格类型契约

```js
// ❌ 全部抛 TypeError
data.put("x", "string");
data.put("x", { foo: 1 });
data.put("x", [1, 2, 3]);

// ✅ 只接 ArrayBuffer 或 Uint8Array
data.put("x", new Uint8Array([1,2,3]));
data.put("x", new Uint8Array([1,2,3]).buffer);
data.put("x", new ArrayBuffer(8));
```

### UTF-8 编解码（goja 没有原生 TextEncoder）

goja 的 ECMAScript 实现不带 `TextEncoder`/`TextDecoder`，自己写：

```js
function encodeUtf8(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) { bytes.push(c); }
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0xd800 || c >= 0xe000) { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else { // surrogate pair → 4 字节
      var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(u8) {
  var out = "", i = 0;
  while (i < u8.length) {
    var b = u8[i++], cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (u8[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
    if (cp >= 0x10000) { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
    else out += String.fromCharCode(cp);
  }
  return out;
}

// 用法
data.put("state.json", encodeUtf8(JSON.stringify(big)).buffer);
var got = data.get("state.json");
var parsed = JSON.parse(decodeUtf8(new Uint8Array(got)));
```

上面两段即完整参考实现（含 surrogate pair / 4 字节 UTF-8 处理，已对 Node `Buffer` 的 UTF-8 结果逐字节对拍），直接抄进插件即可。

### 何时用 config / 何时用 data？

| 场景 | 用 |
|------|---|
| 凭据（OAuth token、API key、webhook URL） | `config.set` + `is_secret=true`（UI 自动脱敏） |
| 用户偏好（数字、布尔、短字符串） | `config.set` |
| 小型 JSON（< 60 KiB） | `config.set("k", JSON.stringify(o))` |
| 大对象 / 二进制 / 缓存 / 索引 | `data.put` |

**两者都默认 AES-256-GCM 加密**，区别只在大小、类型契约、UI 脱敏行为。

### 错误处理

```js
try {
  data.put("big", new Uint8Array(5 * 1024 * 1024)); // 5 MiB > 4 MiB 默认
} catch (e) {
  // "plugin blob: size exceeds per-blob limit: size=5242880 limit=4194304"
  log.warn("blob too large: " + e.message);
}

try {
  // 累计超过 16 MiB
  for (var i = 0; i < 5; i++) data.put("blob_" + i, big4MiB);
} catch (e) {
  // "plugin blob: total exceeds per-plugin limit: current=N new=M limit=16777216"
  log.warn("plugin total quota exceeded: " + e.message);
}
```

### iframe UI 怎么碰 data.* blob

**iframe 桥不暴露 `data.*`**，且 iframe 的 CSP 是 `connect-src 'none'`——`fetch`/`XHR` 全被浏览器拦掉，UI **不能**直接打 sandbox REST。正确姿势：`index.js` 里用 `plugin.registerAPI` 包一层，blob 操作在 goja 侧做，UI 只通过 `FC.api` 调用。

```js
// index.js（goja 侧——data.* 在这里可用）
plugin.registerAPI("/save-cover", function (req) {
  // req.body 是原始字节 string，按需自行解析
  data.put("cover.jpg", encodeUtf8(req.body).buffer);
  return { ok: true };
});

plugin.registerAPI("/list-blobs", function () {
  return { names: data.list() };
});
```

```html
<!-- ui/index.html（iframe 侧——只有 FC.* 可用） -->
<script src="/plugin-sdk.js"></script>
<script>
FC.ready().then(async function () {
  await FC.api("/save-cover", "...");            // 触发上面的 /save-cover
  const { names } = await FC.api("/list-blobs"); // 列出 blob name
});
</script>
```

> `FC.api` 的 body：字符串原样进 `req.body`，对象 / 数组会被 JSON 序列化；不传 body 则是 `GET`、`req.body` 为 `""`（完整规则见 sdk.md「`FC.api` 请求规则」）。传二进制要先 base64 成字符串，别把 `Uint8Array`/`ArrayBuffer` 直接塞进去。

---

## 5. HTTP 调用：`http`

> ⚠️ **破坏性变更**：`http.*` 全部返回 **Promise**，没有同步别名。调用处必须 `await`，所在函数写成 `async function`，并一路 `async` 到回调（hook / registerAPI / `should_download` 都支持 async 回调）。忘了 `await` 拿到的是 Promise 对象，`resp.status` 为 `undefined`。

```js
// 以下代码都在某个 async function 里（例如 plugin.on("...", async function (data) { ... })）

// GET
var resp = await http.get("https://api.example.com/users", {
  "Authorization": "Bearer xxx"
});
// resp = { status: 200, headers: {...}, body: "...", truncated: false }

// POST JSON（必须自己 stringify + 设 Content-Type）
var resp = await http.post(
  "https://hooks.slack.com/services/T00/B00/xyz",
  JSON.stringify({ text: "hello" }),
  { "Content-Type": "application/json" }
);

// POST form
var resp = await http.post(
  "https://api.example.com/form",
  "field1=value1&field2=value2",
  { "Content-Type": "application/x-www-form-urlencoded" }
);
```

多个请求**按顺序** `await` 即串行执行；`await` 期间插件的其它任务可以先跑，但同一次调用的墙钟（hook 10s / API 10s / `should_download` 3s）照算 `await` 时间。

### 限制（来自宿主）

- 单次 **10 秒** 超时（每个请求固定，与所属调用的墙钟无关）
- 响应体 **5 MiB** 上限，超出截断（`truncated=true`）
- 单插件 **60 req/min** 令牌桶，超限 **reject** `"plugin http rate limit exceeded (60 req/min)"`
- 最多 **3 次重定向**
- 网络错误 / 超时 / 限流 / SSRF 拦截一律 reject，错误对象与旧同步版抛出的相同（`e.message` 形如 `http GET <url>: ...`）

### 防 rate-limit 的两种姿势

**姿势 A：本地节流**（推荐）：

```js
function debounceSecond(fn) {
  var lastCall = 0;
  return function () {
    var now = Date.now();
    if (now - lastCall < 1000) return; // 1 秒内只调一次
    lastCall = now;
    fn.apply(null, arguments);
  };
}
var notifyDownload = debounceSecond(function (data) { /* ... */ });
plugin.on("on_download_done", notifyDownload);
```

**姿势 B：合并通知**：把 5 秒内的多个事件聚合成一条，可显著降 QPS。

---

## 6. 自定义 API：`plugin.registerAPI`

```js
plugin.registerAPI("/stats", function (req) {
  return {
    sent_count: parseInt(config.get("sent_count") || "0", 10),
    configured: !!config.get("webhook_url")
  };
});
```

调用方式：

```
GET /api/plugins/<your-plugin-id>/api/stats
```

**返回值会被 JSON 序列化**——返回 string/number/object/array 都行，但要能 marshal。

回调可以是 `async function`：返回的 Promise resolve 的值照常序列化，reject 等同抛错（前端收到错误）；整次调用 **10 秒**墙钟（含 `await`）：

```js
plugin.registerAPI("/test-webhook", async function (req) {
  try {
    var resp = await http.get(config.get("webhook_url"), {});
    return { ok: resp.status < 400, status: resp.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
```

**`req` 对象**目前提供：
- `req.method` —— `"GET"` / `"POST"` / 等
- `req.body` —— 原始字节 string（不自动 JSON parse）
- `req.query` —— `Record<string, string>`，URL query 参数（同名 key 取第一个值）

从 iframe UI 经 `FC.api(path, body)` 调用时：不传 `body` → `GET`、`req.body` 为 `""`；传 `null` → `POST`、`req.body` 为 `""`；传字符串 → `POST`、原样；传对象 / 数组 → `POST`、JSON 字符串；`path` 里的 `?a=1` 进 `req.query`。回调 throw / reject 的内容会作为 `FC.api` reject 的 `Error.message` 透到 UI。详见 sdk.md「`FC.api` 请求规则」。

**用途**：
- 暴露插件自己的统计/调试端点（前端 UI 需要数据时）
- 给外部系统做 webhook 接收（譬如 GitHub release → 触发某个动作）

**配合 iframe UI**：
- `registerAPI` 端点正是 iframe UI 的数据入口——声明 `ui.embed` 权限嵌入 UI 后，前端用 `FC.api("/path", body)` 调它（详见 sdk.md「Plugin UI（iframe 嵌入）」）。
- 这些端点**不能**在浏览器里被直接 fetch（iframe CSP `connect-src 'none'` + 需走宿主 pluginToken 鉴权），一律经 `FC.api` 代理。

---

## 7. 调试 / 排查

### 看日志

插件详情页 → 最近日志。或者直接 `GET /api/plugins/<id>/logs?tail=200`。
`log.info/warn/error` 写的内容都带 `plugin/<id>` 前缀。

### 看运行状态

详情页或 `GET /api/plugins/<id>` 会返回：

| 字段 | 含义 |
|------|------|
| `dropped_count` | 队列饱和被丢的事件数。**>0 表示插件处理不过来**，要么优化逻辑要么用合并策略 |
| `panic_count` | 累计 panic 次数。1 分钟 5 次会自动 disable |
| `last_error_msg` | 最近一次 hook 抛错的信息 |
| `last_error_at` | 最近 panic 时间 |

### 常见症状对照

| 症状 | 原因 | 修法 |
|------|------|------|
| `plugin.on: hook "x" not in manifest.hooks` | manifest hooks 数组缺 `"x"` | 加进去 |
| `plugin.on: hook "x" requires permission "hook.y"` | manifest permissions 缺 `"hook.y"` | 加进去 |
| `http rate limit exceeded` | 60 req/min 超限 | 节流或合并 |
| `dropped_count` 持续增长 | hook 的同步段太慢（队列按同步段逐个消费，满 64 丢最旧） | 出网一律 `await`（等待期间不占队列）、减少同步计算、合并事件 / 降级到 batch（沙箱没有 `setTimeout`） |
| `panic_count = 5` 然后插件被禁用 | 宿主侧 Go panic（插件 JS 的 throw / reject 不计入 panic，只写 `last_error_msg`） | 看日志里的 panic 堆栈，多为宿主问题，附日志反馈 |
| 日志看不到任何输出 | hook 名拼错 / manifest 没声明该 hook | 对照 sdk.md hook 列表 |

### 本地迭代流程

修了代码 → 重新 zip → 在管理页**先 disable 再上传同 plugin_id 的新 zip** → 上传成功后会自动 re-enable（保持启用意图）。所以正常流程：

1. 改 `index.js`
2. `zip -j my-plugin.zip my-plugin/manifest.json my-plugin/index.js`
3. 上传新 zip → 系统自动 stop 旧 worker → 装新代码 → start 新 worker
4. 配置不丢

---

## 8. 完整示例：媒体库感知的下载去重（`should_download`）

> 旧版本这里介绍的是「订阅 `on_notification_before_send` 做通知过滤」——那两个通知 hook 已于 2026-09-24 删除（`hook.notify` 一并移除）。`media-library-filter` 现在是 `should_download` 同步否决插件：推种前查 Emby / Plex，库里已有同规格副本就拦下。

参考实现：[`plugins/media-library-filter` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/media-library-filter)

特性清单（用作你的设计参考）：

- **`should_download` 注册**（需 `hook.download.write`，敏感权限）：返回 `false` 拦下载，其余一律放行（fail-open）
- **per-flow 满足判断**：`ruleflow.list()`（`api.ruleflow.read`）在配置 UI 列出所有规则流，按 `p.flow_id` 取各自标准
- **Emby + Plex 双后端**：任一命中即视为「库里有」；合集种子可回 `{ have_bitmap }` 逐集过滤
- **结果缓存**：库查询结果按 TTL 缓存到 `config.*`，避免刷爆 Emby/Plex
- **fail-open**：Emby / Plex 不可达时按「库里没有」处理，宁可多推不漏推
- **soft budget**：库查询软超时，给 host `should_download` 3 s 硬超时（墙钟，含 `await`）留出余量
- **统计 / trace API**：`GET /api/plugins/<id>/api/stats`、`/check` 透传单次库查询

详见示例代码注释。

---

## 9. 常见反模式（请勿照搬）

```js
// ❌ 1. 在 hook 里跑死循环
plugin.on("on_download_done", function (data) {
  while (true) { /* 10 秒后宿主打断，本次 hook 以超时错误结束（记 last_error，不计 panic）；这 10 秒里本插件其它任务全部排队 */ }
});

// ❌ 2. 同步等数秒
plugin.on("on_download_done", function (data) {
  for (var i = 0; i < 1000000000; i++) {} // 烧 CPU 几秒：同步段占住事件循环，本插件其它任务（含 await 回来的续体）全得等；超过 10 秒墙钟才被打断
});

// ❌ 3. 信任 data 字段全有
plugin.on("on_link_done", function (data) {
  send("文件位置: " + data.dest.toLowerCase()); // dest 可能 undefined
});

// ❌ 4. 把 token 硬编码进 index.js
var TOKEN = "xoxb-1234-actual-secret"; // 上传 zip 后明文落地，请用 config + is_secret

// ❌ 5. 一个事件发 N 个 http
plugin.on("on_download_done", async function (data) {
  for (var i = 0; i < data.files.length; i++) {
    await http.post(...); // files 多了直接打爆 60/min 限速
  }
});

// ❌ 6. registerAPI 里逐个发邮件然后返回
plugin.registerAPI("/notify-all", async function (req) {
  for (var i = 0; i < users.length; i++) await http.post(...); // 累计 >10s（含 await）会超时
  return { sent: users.length };
});

// ❌ 7. 忘了 await
plugin.on("on_download_done", async function (data) {
  var resp = http.get(url, {}); // resp 是 Promise，不是响应
  if (resp.status !== 200) { ... } // 永远成立：resp.status === undefined
});

// ❌ 8. await 之后写死循环
plugin.on("on_download_done", async function (data) {
  await http.get(url, {});
  while (true) {} // 续体里的死循环宿主不打断：整个插件卡住，只能停用
});

// ✅ 反模式 6 的修法：异步触发，立即返回
plugin.registerAPI("/notify-all", function (req) {
  config.set("notify_all_pending", "1"); // 标志位
  return { queued: true };
});
// 在某个常被触发的 hook 里检查并消费这个标志位（最简单的 "deferred" 模式）
```

---

## 10. 升级与卸载

- **升级**：上传同 `plugin_id` 的新 zip → 系统自动 disable 旧 → atomic 替换文件 → 重新 enable（如果之前是 enabled）。配置保留。
- **卸载**：管理页点卸载 → 停 worker → 删插件目录 → 删 DB 行（连带配置）。**配置不可恢复**，操作前确认。
- **降级**：上传旧 version 的 zip 同样走升级流程，FollowCat 不阻止 version 倒退。

---

## 11. 接下来

- [`sdk.md`](./sdk.md) —— API 签名、字段表、限制清单速查
- [`plugin_guide.md`](../../plugin_guide.md) —— 完整设计文档（含 Phase B/C 路线图）
- [`media-library-filter` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/media-library-filter) —— `should_download` 下载去重（否决式 hook）的完整参考实现
- [`dashboard-stats` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/dashboard-stats) —— headless API 插件示例
- [`cookiecloud` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/cookiecloud) —— 带 iframe UI、内嵌 CryptoJS 解密、自定义 API 端点的综合示例

---

## 13. 发布到插件市场（v1）

1. **打包 zip**（zip 根直接是 `manifest.json` 和 `index.js`，不嵌套目录）：
   ```bash
   zip -j my-plugin-1.0.0.zip my-plugin/manifest.json my-plugin/index.js
   ```

2. **上传到 GitHub Release**（或任意 HTTPS 静态托管），获取直链。

3. **计算 sha256**：
   ```bash
   sha256sum my-plugin-1.0.0.zip | awk '{print $1}'
   ```

4. **PR 到 followcat/plugin-registry 的 index.json**，新增或更新 entry，填入 `zip_url` 和 `zip_sha256`。

5. v1 不需要签名；M2 后可用 `minisign` 对 zip 签名，详见届时发布的文档。

完整字段说明见 [`registry-schema.md`](./registry-schema.md)。
