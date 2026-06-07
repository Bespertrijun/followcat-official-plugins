# FollowCat 插件 SDK 参考（MVP）

> 本文是 MVP 阶段插件作者的速查手册。完整设计与扩展规划见 [plugin_guide.md](../../plugin_guide.md)；本文档只列**已实现并可用**的能力。

---

## 快速开始

1. 准备一个目录，写好 `manifest.json` 与 `index.js`：

```
my-plugin/
├── manifest.json
└── index.js
```

2. 把目录打包成 zip（**zip 根直接是这两个文件**，不要再嵌一层 `my-plugin/`）。
3. 打开 FollowCat 管理页 → 插件 → 上传 zip → 启用。

### manifest.json 必填字段

| 字段 | 校验规则 |
|------|---------|
| `name` | `[a-z0-9-]{3,64}` |
| `version` | semver-ish：`MAJOR.MINOR.PATCH[-prerelease]` |
| `source_url` | 任意 URL；与 `name` 联合派生 plugin_id |
| `permissions` | 全部需在白名单内（见下） |
| `hooks` | 全部需在白名单内（见下） |

可选字段：`author`、`description`。

---

## Hook 列表（MVP 8 个）

> JS 侧通过 `plugin.on("<hook_name>", function(data) { ... })` 订阅。同名 hook 多次注册以最后一次为准。所有 hook payload 字段命名见 `internal/domain/event.go`，并由 `internal/domain/event_payload_test.go` 锁定。

| Hook | 触发时机 | payload 关键字段 |
|------|---------|-----------------|
| `on_episode_found` | RSS 发现新集 | `anime_id`, `episode`, `torrent_url` |
| `on_download_done` | qBittorrent 下载完成 | `anime_id`, `anime_title`, `episode`, `hash`, `files: [{path,size}]?`, `size?`, `save_path?`, `category?` |
| `on_download_failed` | 下载失败（不可恢复） | `anime_id`, `anime_title`, `episode`, `hash`, `reason` |
| `on_link_done` | 链接整理完成 | `anime_id`, `anime_title`, `episode`, `dest?`, `tmdb_episode?` |
| `on_link_failed` | 链接执行失败 | `anime_id`, `anime_title`, `episode`, `reason`, `hash?` |
| `on_task_completed` | 番剧全集追完 | `task_id`, `anime_title`, `total_ep` |
| `on_notification_before_send` | 主仓 `internal/notify` 即将通过某通道发送通知前 | `event_type`, `channel` ("slack"/"telegram"), `text`, `anime_id?`, `anime_title?`, `episode?` |
| `on_notification_after_send` | 单条通知发送结束（成功或失败） | `event_type`, `channel`, `success`, `error_message?`, `anime_id?`, `anime_title?`, `episode?` |

> `?` 表示后端可能省略（omitempty）；插件代码须自行做空值兜底。
>
> **`on_notification_*` 语义**：主仓自 v3.5 起把 Slack / Telegram 发送、节流、重试等业务逻辑收回到 `internal/notify`，提供这两个 hook 给插件**观察**（fire-and-forget，无 veto / payload 改写）。常见用法：把通知 fan-out 到主仓未内置的通道（钉钉 / 飞书 / 企业微信），或上报到可观测系统（Sentry / Slack 旁路）。**不要**在 `before_send` 里调 `http.*` 阻塞太久——10s hook 超时会被强制中断且影响主仓后续 channel 发送。

---

## 宿主 API 参考

> 未声明对应权限时，对应全局对象为 `undefined`，插件可用 `typeof xxx === "object"` 自检。

### `plugin` —— 注册中心（始终可用）

| 方法 | 签名 | 说明 |
|------|------|------|
| `plugin.on(name, fn)` | `(string, function(data))` | 注册 hook 处理函数 |
| `plugin.registerAPI(path, fn)` | `(string, function(req) → any)` | 注册自定义 API；前端通过 `/api/plugins/<id>/api<path>` 调用，返回值 JSON 序列化 |

### `log` —— 日志（始终可用）

```js
log.info(...args)
log.warn(...args)
log.error(...args)
```

参数被 `fmt.Sprint` 拼接，写入 ringbuffer 时带 `plugin/<id>` 来源前缀，可通过插件详情页拉取。

### `config` —— 插件配置（始终可用）

| 方法 | 说明 |
|------|------|
| `config.get(key) → string \| null` | 读，未设置返回 `null` |
| `config.set(key, value)` | 写；`value` 必须是 string |
| `config.list() → string[]` | **v3.4+** 列出当前插件全部 keys，按字典序排序，仅 keys 不含 values |

**所有 Value 在 store 层无条件 AES-256-GCM 加密落库。** `is_secret` 标记不是加密开关，仅控制 API 回读时是否返回明文（前端 `is_secret=true` 时回传空字符串，UI 显示「已设置」占位）。`config.set` 默认写入的项 `is_secret=false`；要标记 secret 需走管理页 UI 或 admin REST `PUT /api/plugins/:id/config` 显式传 `is_secret:true`。

**约束（v3.4）：**

- key 长度 1–128，仅限 `[a-zA-Z0-9._-]`
- value 上限 64 KiB
- 每插件最多 **500 个 key**（admin 可调，见下文）
- 跨 plugin 隔离：plugin A 看不到 B 的 keys

**配额错误**：超出抛错，message 含 `current=N limit=M`：

```js
try {
  config.set("key501", "v");
} catch (e) {
  // "plugin config: row quota exceeded: current=500 limit=500"
}
```

### `data` —— 加密 blob 存储（**v3.4+**，始终可用）

适合存放二进制 / 大对象 / 缓存 / 索引（>64 KiB 或非字符串）。所有 value 默认 AES-256-GCM 加密，与 `config.*` 同等保护级别。

| 方法 | 签名 |
|------|------|
| `data.get(name) → ArrayBuffer \| null` | 读取；未设置或读取失败返回 `null` |
| `data.put(name, value)` | 写入；`value` **必须** 是 `ArrayBuffer` 或 `Uint8Array`，传 string/object 抛 `TypeError` |
| `data.list() → string[]` | 列出当前插件全部 blob name |
| `data.delete(name) → boolean` | 删除；返回是否成功 |

**约束：**

- name 校验同 config key（`[a-zA-Z0-9._-]{1,128}`）
- 单 blob ≤ 4 MiB（admin 可调到 64 MiB）
- 单 plugin 总和 ≤ 16 MiB（admin 可调到 256 MiB）
- 跨 plugin 隔离

**严格类型契约：**

```js
// ✅ 正确
data.put("cache.bin", new Uint8Array([1,2,3]));
data.put("cache.bin", new Uint8Array([1,2,3]).buffer);
data.put("cache.bin", new ArrayBuffer(8));

// ❌ TypeError: data.put requires ArrayBuffer or Uint8Array
data.put("cache.bin", "string");
data.put("cache.bin", { foo: 1 });
```

**配额错误：**

| 错误 | message 含 |
|------|-----------|
| 单 blob 超限 | `"plugin blob: size exceeds per-blob limit: size=N limit=M"` |
| 总和超限 | `"plugin blob: total exceeds per-plugin limit: current=N new=M limit=K"` |

**何时用 config / data？**

| 场景 | 推荐 |
|------|------|
| OAuth token / API key / 密码 | `config.set` (`is_secret=true`)，UI 自动脱敏 |
| 用户偏好（数字、布尔、短字符串） | `config.set` |
| 小型 JSON（< 60 KiB） | `config.set("k", JSON.stringify(o))` |
| RSS 抓取的解析缓存 | `data.put` |
| 番剧封面 / 缩略图 | `data.put` |
| 大型 JSON 状态机快照 | `data.put` |

> goja 没有原生 `TextEncoder`/`TextDecoder`，要把 string 转 Uint8Array 需自己实现 UTF-8 编解码。可参考 [`blob-cache-demo/index.js`](../../blob-cache-demo/index.js) 的 `encodeUtf8`。

### 配额可调（管理员）

```http
PUT /api/admin/settings
{ "key": "plugin.blob.max_bytes_per_plugin", "value": "33554432" }   # 32 MiB
```

| Key | 默认 | 范围 |
|---|---|---|
| `plugin.config.max_keys_per_plugin` | 500 | [10, 5000] |
| `plugin.blob.max_bytes_per_blob` | 4 MiB | [4 KiB, 64 MiB] |
| `plugin.blob.max_bytes_per_plugin` | 16 MiB | [4 KiB, 256 MiB] |

越界返 `412 Precondition Failed`。改后调 `POST /api/admin/settings/refresh` 立即生效（默认 5 分钟 TTL 自动刷新）。

### `http` —— HTTP 客户端（需 `api.http`）

| 方法 | 签名 |
|------|------|
| `http.get(url, headers)` | `(string, map<string,string>) → {status, headers, body, truncated}` |
| `http.post(url, body, headers)` | `(string, string, map<string,string>) → ...` |
| `http.put(url, body, headers)` | `(string, string, map<string,string>) → ...` |
| `http.delete(url, headers)` | `(string, map<string,string>) → ...` |

约束：

- 单次响应体上限 **5 MiB**，超出截断并设 `truncated=true`
- 单插件令牌桶 **60 req/min**，超限抛错
- 单次请求 **10 秒**超时；最多 3 次重定向
- `body` 是 string；JSON 请求自行 `JSON.stringify` + 设 `Content-Type: application/json`

### `anime` —— 番剧只读（需 `api.anime.read`）

```js
var info = anime.get(animeId)
// → { id, title, mikan_id, douban_id, total_ep, ep_num, status }
//   status ∈ "done" | "tracking" | "idle"
//   不存在或出错时返回 null
```

### `task` —— 任务只读（需 `api.task.read`）

```js
var t = task.get(taskID)
// → PluginTaskView | null
// PluginTaskView = { task_id, anime_title, status, episodes_done, episodes_total, last_event_at }

var all = task.list() // PluginTaskView[]
```

> **安全说明**：`task` facade 严格返回 `PluginTaskView` 投影，不会泄漏 `Server.Password`、`Server.SSHKey`、`Download.Password` 等加密字段（受 `internal/plugin/host_facade_test.go` 静态保护）。

---

## 能干什么 / 不能干什么

| ✅ 可以 | ❌ 不可以 |
|--------|----------|
| 读 `anime.get(id)` | 写任何 anime/task 数据 |
| 读 `task.get/list` | 直接访问 `domain.Server` / `domain.Download` |
| `http.*` 调外部 HTTP | `require` / `import` / `eval` / `Function(...)` |
| `log.*` / `config.*` | 文件系统、子进程、数据库句柄 |
| `plugin.on` 订阅 hook | 抛错中断主流程（一律被隔离） |
| `plugin.registerAPI` 暴露端点 | 默认网络（须显式 `api.http`） |

---

## Plugin UI（iframe 嵌入）

声明 `ui.embed` 权限后，插件可以在管理页插件详情的「设置」slot 中嵌入自己的 HTML 页面。

### manifest.json 配置

```json
{
  "permissions": ["ui.embed"],
  "ui": {
    "entry": "ui/index.html",
    "slots": ["plugin.settings"],
    "icon": "🔔"
  }
}
```

| 字段 | 说明 |
|------|------|
| `entry` | zip 内的 HTML 入口路径，必须以 `.html` 结尾，不能含 `..` |
| `slots` | 目前只支持 `"plugin.settings"`（插件详情设置标签） |
| `icon` | 可选，emoji 或资源路径，显示在插件列表 |

### 前端 SDK（`/plugin-sdk.js`）

宿主在 iframe 的 `<head>` 自动注入 `/plugin-sdk.js`，也可自行引入。该 SDK 通过 `postMessage` 与宿主通信，不使用 `fetch`/`XHR`（CSP `connect-src 'none'` 阻止直接请求）。

```html
<script src="/plugin-sdk.js"></script>
<script>
  FC.ready().then(function(ctx) {
    // ctx: { theme, permissions, plugin_id }
    console.log('init', ctx);
  });
</script>
```

| 方法 | 返回 | 说明 |
|------|------|------|
| `FC.ready()` | `Promise<ctx>` | 等待宿主初始化，获取上下文 |
| `FC.api(path, body)` | `Promise<any>` | 调用插件自身注册的 API（`plugin.registerAPI`），宿主代理并附加鉴权 |
| `FC.config.get(key)` | `Promise<string\|null>` | 读取插件配置，透明解密 |
| `FC.config.put(key, value, isSecret)` | `Promise<void>` | 写入插件配置；`isSecret=true` 仅控制回读脱敏（加密一直开） |

> **v3.4 注意**：iframe SDK 当前仅桥接 `FC.config.get/put`，**未桥接 `data.*` 与 `config.list`**。如果 iframe 需要读写 blob，请用 sandbox REST：
>
> ```js
> const ctx = await FC.ready();
> // 写 blob
> await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data/cover.jpg`, {
>   method: 'PUT',
>   headers: { 'Content-Type': 'application/octet-stream' },
>   body: arrayBuffer,
> });
> // 读 blob
> const buf = await (await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data/cover.jpg`)).arrayBuffer();
> // 列表
> const list = await (await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data`)).json();
> // 删除
> await fetch(`/api/plugins/${ctx.plugin_id}/sandbox/data/cover.jpg`, { method: 'DELETE' });
> ```
| `FC.notify(level, msg)` | `Promise<void>` | 在宿主界面显示 Toast，`level` ∈ `"info"\|"success"\|"warning"\|"error"` |
| `FC.resize(height)` | `Promise<void>` | 请求宿主调整 iframe 高度（像素） |

### 安全模型

- iframe 以 `sandbox="allow-scripts allow-forms"` 加载，无 `allow-same-origin`，无法访问宿主 DOM / Cookie
- 所有宿主通信经由 `postMessage`；宿主校验 `origin` 并只处理来自该 iframe 的消息
- 插件通过插件专属 `pluginToken` 访问 API，只能操作 `/api/plugins/<自己的 id>/*`，接触不到用户 JWT
- 管理页为 admin-only；`ui.embed` 插件 UI 同样仅对 admin 可见

### 示例

完整参考实现：[`cookiecloud/ui/index.html` @ followcat/plugin-registry](https://github.com/followcat/plugin-registry/tree/main/cookiecloud/ui/index.html)

- 用 `FC.ready()` 初始化，读取现有配置填充表单
- 用 `FC.api('/save-config', {...})` 批量写入（含 `is_secret` 标记）
- 用 `FC.api('/sync', null)` 触发同步并显示结果
- 用 `FC.api('/status', null)` 拉取状态并渲染
- 用 `FC.resize(height)` 在内容变化后自动调整高度

---

## MVP 限制（请知悉）

- **iframe 为 admin-only**：`ui.embed` 插件 UI 只在管理员视图下可见，普通用户看不到设置标签。
- **无可变 hook**：所有 v1 hook 都是只读通知（`on_*_done` / `on_*_failed`），无 `on_before_*`。
- **无热重载**：插件代码改动需重新上传/启用；配置改动是热生效。
- **单 hook 仅最后注册有效**：同一 plugin 内重复 `plugin.on("x", ...)` 后者覆盖前者。
- **manifest 大小** ≤ 64 KiB，单文件 ≤ 5 MiB，zip 总解压 ≤ 20 MiB / ≤ 200 条目。
- **执行模型**：每个插件单 goroutine 串行执行 hook，队列容量 64，满则 drop-oldest 并 WARN；超时 10s 强制中断；1 分钟内 5 次 panic 自动熔断（disable）。

---

## 权限白名单（MVP）

`internal/plugin/permission.go` 是单一事实源：

| 权限 | 注入对象 |
|------|---------|
| `hook.download` | 允许订阅 `on_episode_found` / `on_download_done` / `on_download_failed` |
| `hook.link`     | 允许订阅 `on_link_done` / `on_link_failed` |
| `hook.task`     | 允许订阅 `on_task_completed` |
| `hook.notify`   | 允许订阅 `on_notification_before_send` / `on_notification_after_send` |
| `api.http`      | 注入全局 `http` |
| `api.anime.read` | 注入全局 `anime` |
| `api.task.read`  | 注入全局 `task` |
| `ui.embed`       | 允许声明 `manifest.ui.entry`（iframe 内嵌前端 UI） |

> `hook.rss` / `hook.route` / `api.*.write` / `api.douban.*` / `api.site.*` 在 plugin_guide.md 中规划但**未在 MVP 实现**，声明会导致 manifest 解析报错。

---

## 示例

- 通知过滤类（订阅 `on_notification_before_send` + Emby/Plex 查询 + 自家 fan-out）：[plugin-registry/media-library-filter](https://github.com/followcat/plugin-registry/tree/main/media-library-filter)
- 聚合 API 类（headless，仅 `registerAPI`）：[plugin-registry/dashboard-stats](https://github.com/followcat/plugin-registry/tree/main/dashboard-stats)
- 综合类（iframe UI + 内嵌 CryptoJS + 自定义 API + http 外网调用）：[plugin-registry/cookiecloud](https://github.com/followcat/plugin-registry/tree/main/cookiecloud)
- v3.4 `data.*` blob API 演示：[plugin-registry/blob-cache-demo](https://github.com/followcat/plugin-registry/tree/main/blob-cache-demo)

> Slack / Telegram 通知不再以插件形式提供，自 v3.5 起已并入主仓 `internal/notify`。**想扩通道**（钉钉 / 飞书 / 企微等）PR 到主仓 channel registry；**想过滤通知**（如示例 media-library-filter）走 `on_notification_before_send` hook。

---

插件已发布到市场？参考 [`marketplace.md`](./marketplace.md) 了解安装/升级流程，以及 [`registry-schema.md`](./registry-schema.md) 了解如何维护 index.json 与计算 zip_sha256。
