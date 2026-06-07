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
  "permissions": ["hook.task"],
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
                  |  发到每个插件     |       +--> http.post("...")
                  |                  |       +--> log.info(...)
                  +------------------+       +--> config.set(...)
```

- **Hook 是只读通知**：你看到的 `data` 是宿主推过来的副本，改它不会影响主流程。
- **每个插件一个 goroutine**：你的代码是单线程串行执行，hook 之间不会并发；但**别在 hook 里阻塞超过 10 秒**，会被强制中断。
- **凭证不会泄漏**：`anime.get` 返回的是脱敏 view，拿不到 `Server.Password` 之类。
- **没有文件系统、没有 require**：能用的就是 `log` / `config` / `http` / `anime` / `task` / `plugin` 这 6 个全局对象。

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
    "hook.download", "hook.link", "hook.task", "api.http"
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

权限白名单见 sdk.md，hook 白名单是这 6 个：
`on_episode_found`, `on_download_done`, `on_download_failed`, `on_link_done`, `on_link_failed`, `on_task_completed`。

**关键点**：`plugin.on("on_link_done", fn)` 只有当 manifest 同时声明
`"hooks": [..., "on_link_done", ...]` **且** `"permissions": [..., "hook.link", ...]`
才能注册成功，否则运行期 throw。

| Hook | 需要的 permission |
|------|------------------|
| `on_episode_found`, `on_download_done`, `on_download_failed` | `hook.download` |
| `on_link_done`, `on_link_failed` | `hook.link` |
| `on_task_completed` | `hook.task` |

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

  // ❌ 错误：files 可能 undefined → undefined.length 抛错 → 触发 panic 计数
  for (var i = 0; i < data.files.length; i++) { ... }
});
```

### 黄金规则：异常被隔离，但**别浪费**

插件抛错不会影响主流程，会被 worker recover 后写到 `last_error_msg`。但 1 分钟内 5 次 panic 会**自动 disable**插件。所以：

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

`http.post` 在 4xx/5xx/超时/网络错误时 **throw**。永远包：

```js
try {
  var resp = http.post(url, body, headers);
  if (resp.status >= 400) {
    log.warn("upstream " + resp.status + ": " + resp.body);
  }
} catch (e) {
  log.error("http.post 失败: " + e);
}
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
    if (c < 0x80)        { bytes.push(c); }
    else if (c < 0x800)  { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else                 { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(u8) {
  var out = "", i = 0;
  while (i < u8.length) {
    var b = u8[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (u8[i++] & 0x3f));
    else out += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f));
  }
  return out;
}

// 用法
data.put("state.json", encodeUtf8(JSON.stringify(big)).buffer);
var got = data.get("state.json");
var parsed = JSON.parse(decodeUtf8(new Uint8Array(got)));
```

完整可运行示例见 [`blob-cache-demo/index.js`](../../blob-cache-demo/index.js)（含 surrogate pair 处理）。

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

### iframe UI 用 data.*

**iframe SDK 当前未桥接 `FC.data.*`**。如果 UI iframe 需要读写 blob，用 sandbox REST：

```html
<script src="/plugin-sdk.js"></script>
<script>
FC.ready().then(async function (ctx) {
  // 上传文件
  const file = document.querySelector('#file').files[0];
  const buf = await file.arrayBuffer();
  await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data/${file.name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });

  // 列出 blob
  const list = await (await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data`)).json();
  // → {"data": [{"name":"x.jpg","size":12345,"updated_at":"..."}]}
});
</script>
```

---

## 5. HTTP 调用：`http`

```js
// GET
var resp = http.get("https://api.example.com/users", {
  "Authorization": "Bearer xxx"
});
// resp = { status: 200, headers: {...}, body: "...", truncated: false }

// POST JSON（必须自己 stringify + 设 Content-Type）
var resp = http.post(
  "https://hooks.slack.com/services/T00/B00/xyz",
  JSON.stringify({ text: "hello" }),
  { "Content-Type": "application/json" }
);

// POST form
var resp = http.post(
  "https://api.example.com/form",
  "field1=value1&field2=value2",
  { "Content-Type": "application/x-www-form-urlencoded" }
);
```

### 限制（来自宿主）

- 单次 **10 秒** 超时
- 响应体 **5 MiB** 上限，超出截断（`truncated=true`）
- 单插件 **60 req/min** 令牌桶，超限 throw `"http rate limit exceeded"`
- 最多 **3 次重定向**

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

**`req` 对象**目前提供：
- `req.method` —— `"GET"` / `"POST"` / 等
- `req.body` —— 原始字节 string（不自动 JSON parse）
- `req.query` —— `Record<string, string>`，URL query 参数

**用途**：
- 暴露插件自己的统计/调试端点（前端 UI 需要数据时）
- 给外部系统做 webhook 接收（譬如 GitHub release → 触发某个动作）

**MVP 不能干**：
- 渲染自己的 iframe UI（Phase B 才有 `ui.embed` 权限）
- 在 web 端用浏览器直接 fetch（要走宿主鉴权）

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
| `dropped_count` 持续增长 | hook 处理太慢 | 优化逻辑、用 setTimeout 异步、降级到 batch |
| `panic_count = 5` 然后插件被禁用 | 你抛了未捕获的异常 | try/catch 包好，**特别是 http 调用** |
| 日志看不到任何输出 | hook 名拼错 / manifest 没声明该 hook | 对照 sdk.md hook 列表 |

### 本地迭代流程

修了代码 → 重新 zip → 在管理页**先 disable 再上传同 plugin_id 的新 zip** → 上传成功后会自动 re-enable（保持启用意图）。所以正常流程：

1. 改 `index.js`
2. `zip -j my-plugin.zip my-plugin/manifest.json my-plugin/index.js`
3. 上传新 zip → 系统自动 stop 旧 worker → 装新代码 → start 新 worker
4. 配置不丢

---

## 8. 完整示例：媒体库感知的通知过滤

> 主仓 v3.5+ 已把 Slack / Telegram 通知业务收回 `internal/notify`，所以"在插件里实现通知通道"不再是推荐姿势。如果想加新通道（钉钉 / 飞书等长尾），PR 到主仓 channel registry 即可。
>
> 留给插件的两个新接口是 `on_notification_before_send` / `on_notification_after_send`，最典型用法是**过滤**（决定要不要 fan-out）和**监控**（拿失败上报到 Sentry / Grafana），下面的示例插件展示前者。

参考实现：[`plugins/media-library-filter` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/media-library-filter)

特性清单（用作你的设计参考）：

- **`on_notification_before_send` 订阅**：拿到主仓即将发送的 `{event_type, channel, text, anime_id, anime_title, episode}`
- **Emby + Plex 双后端**：`/emby/Items?SearchTerm=` 与 `/hubs/search?query=`，任一命中即视为「库里有」
- **结果缓存**：把 `anime_id → hit?` 存到 `config.lib_cache_<id>` JSON，TTL 默认 1 小时，避免刷爆 Emby/Plex
- **跨通道去重**：主仓启用多 channel 时同事件会触发 N 次 hook，用内存 map 在 5 s 窗口内只放行第一次
- **自家 fan-out**：库里没有时 POST 一份到 Telegram bot 或通用 webhook（用户可选）
- **fail-open**：Emby / Plex 不可达时按"库里没有"处理，宁可多推不漏推
- **soft budget**：库查询 4 s 软超时，给后续 fan-out 留出 host 10 s 硬预算的余量
- **dry-run + suppress_event_types**：调试 / 强制静默某些事件的开关
- **统计 API**：`GET /api/plugins/<id>/api/stats` 返回过滤命中、fan-out 成功失败、各通道 last_error
- **trace API**：`GET /api/plugins/<id>/api/check?anime_id=N` 单次库查询透传（不写缓存）

详见示例代码注释。

---

## 9. 常见反模式（请勿照搬）

```js
// ❌ 1. 在 hook 里跑死循环
plugin.on("on_download_done", function (data) {
  while (true) { /* 10 秒后 runtime.Interrupt 杀掉，panic_count++ */ }
});

// ❌ 2. 同步等数秒
plugin.on("on_download_done", function (data) {
  for (var i = 0; i < 1000000000; i++) {} // 烧 CPU 几秒，会被中断
});

// ❌ 3. 信任 data 字段全有
plugin.on("on_link_done", function (data) {
  send("文件位置: " + data.dest.toLowerCase()); // dest 可能 undefined
});

// ❌ 4. 把 token 硬编码进 index.js
var TOKEN = "xoxb-1234-actual-secret"; // 上传 zip 后明文落地，请用 config + is_secret

// ❌ 5. 一个事件发 N 个 http
plugin.on("on_download_done", function (data) {
  for (var i = 0; i < data.files.length; i++) {
    http.post(...); // files 多了直接打爆 60/min 限速
  }
});

// ❌ 6. registerAPI 里同步发邮件然后返回
plugin.registerAPI("/notify-all", function (req) {
  for (var i = 0; i < users.length; i++) http.post(...); // 累计 >10s 会超时
  return { sent: users.length };
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
- [`media-library-filter` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/media-library-filter) —— `on_notification_before_send` 过滤式用法的完整参考实现
- [`dashboard-stats` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/dashboard-stats) —— headless API 插件示例
- [`cookiecloud` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/cookiecloud) —— 带 iframe UI、内嵌 CryptoJS 解密、自定义 API 端点的综合示例
- [`blob-cache-demo` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/blob-cache-demo) —— v3.4 `data.*` 加密 blob 存储 API 示例

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
