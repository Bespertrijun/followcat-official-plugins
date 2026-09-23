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

## Hook 列表（MVP 9 个）

> JS 侧通过 `plugin.on("<hook_name>", function(data) { ... })` 订阅。同名 hook 多次注册以最后一次为准。所有 hook payload 字段命名见 `internal/domain/event.go`，并由 `internal/domain/event_payload_test.go` 锁定。

| Hook | 触发时机 | payload 关键字段 |
|------|---------|-----------------|
| `on_episode_found` | RSS 发现新集 | `anime_id`, `episode`, `torrent_url` |
| `on_download_done` | qBittorrent 下载完成 | `anime_id`, `anime_title`, `episode`, `hash`, `files: [{path,size}]?`, `size?`, `save_path?`, `category?` |
| `on_download_failed` | 下载失败（不可恢复） | `anime_id`, `anime_title`, `episode`, `hash`, `reason` |
| `on_link_done` | 链接整理完成 | `anime_id`, `anime_title`, `episode`, `dest?`, `tmdb_episode?` |
| `on_link_failed` | 链接执行失败 | `anime_id`, `anime_title`, `episode`, `reason`, `hash?` |
| `on_task_completed` | 番剧全集追完 | `task_id`, `anime_title`, `total_ep` |
| `on_task_reopened` | 已完成任务因总集数上调/新集出现被打回继续追更（done→tracking） | `source`（`"mikan"`/`"douban"`）, `task_id`, `media_id`, `media_title`, `old_total_ep`, `new_total_ep`, `acquired_units` |
| `on_notification_before_send` | 主仓 `internal/notify` 即将通过某通道发送通知前 | `event_type`, `channel` ("slack"/"telegram"), `text`, `anime_id?`, `anime_title?`, `episode?` |
| `on_notification_after_send` | 单条通知发送结束（成功或失败） | `event_type`, `channel`, `success`, `error_message?`, `anime_id?`, `anime_title?`, `episode?` |

> `?` 表示后端可能省略（omitempty）；插件代码须自行做空值兜底。
>
> **`on_notification_*` 语义**：主仓自 v3.5 起把 Slack / Telegram 发送、节流、重试等业务逻辑收回到 `internal/notify`，提供这两个 hook 给插件**观察**（fire-and-forget，无 veto / payload 改写）。常见用法：把通知 fan-out 到主仓未内置的通道（钉钉 / 飞书 / 企业微信），或上报到可观测系统（Sentry / Slack 旁路）。**不要**在 `before_send` 里做耗时太久的 `http.*`——hook 整次调用墙钟 10s（含 `await`），超时后结果被丢弃；hook 是 fire-and-forget 投递，本来就不会拖住主仓的 channel 发送。

---

## 同步否决 hook：`should_download`（需 `hook.download`）

> ⚠️ 与上面 9 个 **fire-and-forget 通知 hook 不同**，`should_download` 是**同步、可否决**的 hook——宿主在每次 ruleflow 推送种子到 qBittorrent **之前**同步调用它，并**读取返回值**决定是否真的下载。典型用途：查询外部媒体库（Emby / Jellyfin / Plex），若该集已存在则拦下、不重复下载。

### 注册与返回值契约

```js
plugin.on("should_download", function(p) {
  // 返回 false → 不下载；其余一切（true / undefined / 非布尔 / 抛错 / 超时）→ 照常下载
  if (libraryAlreadyHas(p)) return false;
  return true;
});
```

| 返回值 | 行为 |
|--------|------|
| 显式 `false` | **跳过**下载（种子记 `excluded`，不推进入库进度） |
| `true` / `undefined` / 非布尔 / 抛错 / 超时 | **照常下载**（fail-open） |
| `{ have_bitmap: "<base64>" }` | **合集逐集过滤**（v0.4+）：仅对 `episode_end > 0` 的合集种子生效。bitmap 标记媒体库已有的集，核心从缺失集中剔掉已有集，selective 模式只下剩余文件。单集路径忽略此返回值。 |

- **硬超时 3 秒**（墙钟，**含 `await` 期间**）：插件没在 3s 内返回 / Promise 没在 3s 内 settle → fail-open 放行（外部库不可达也不拖垮下载管线）；超时后 Promise 才到的结果被丢弃。
- **回调可以 `async`**：查外部库要 `await http.get(...)`（见下文「同步 / 异步 facade 一览」），宿主等返回的 Promise settle 后再读值；resolve `false` 与同步 `return false` 等价，reject 与抛错等价（fail-open）。
- **多插件 veto-wins**：任一插件返回 `false` 即跳过；多插件 bitmap 取**并集**（OR）。
- 失败策略（外部库挂了算"有"还是"没有"）由插件自行决定——宿主只认显式 `false`。

#### 合集 bitmap 协议（v0.4+）

当 `payload.media.episode_end > 0`（合集种子）时，插件可返回 `{ have_bitmap: "<base64>" }` 实现逐集过滤：

**Bitmap 布局**（与核心 `EpBitmap` 同构）：

```
第 N 集 → byte[(N-1) / 8] 的 bit ((N-1) % 8)（LSB 优先）

例：ep9 有、ep10 没有
  byte[0] = 00000000  (ep1-8)
  byte[1] = 00000001  (bit0=ep9 有, bit1=ep10 无)
  base64("AAE=") → { have_bitmap: "AAE=" }
```

**构建示例**：

```js
plugin.on("should_download", function(p) {
  var epStart = p.media.episode;
  var epEnd = p.media.episode_end;
  if (!epEnd) return !libraryHas(p);  // 单集：原有 bool

  // 合集：查 Emby，构建 bitmap
  var bytes = [];
  for (var ep = epStart; ep <= epEnd; ep++) {
    if (embyHasEpisode(p.media.tmdb_id, p.media.season, ep)) {
      var byteIdx = (ep - 1) >> 3;
      var bitIdx = (ep - 1) & 7;
      while (byteIdx >= bytes.length) bytes.push(0);
      bytes[byteIdx] |= (1 << bitIdx);
    }
  }

  var haveCount = countBits(bytes, epStart, epEnd);
  if (haveCount === epEnd - epStart + 1) return false;  // 全有 → 整包不下
  if (haveCount === 0) return true;                      // 全无 → 全下
  return { have_bitmap: bytesToBase64(bytes) };          // 部分有 → 逐集过滤
});
```

**核心侧行为**：收到 `have_bitmap` 后，从 `missingEps`（bitmap 未标记的集）中剔掉插件报告已有的集，selective 模式的 `SetFilePriority` 只下载真正缺失的文件。若剔完后 `missingEps` 为空，整包记 `excluded`。

**注意**：bitmap 长度无需与核心 `EpBitmap` 对齐——核心逐集点查，越界自动视为"没有"。只需覆盖到 `episode_end` 即可。

### payload（`PreDownloadCheck`）

字段命名见主仓 `internal/domain/plugin_hooks.go`（snake_case）。季 / 集号均为 **TMDB 原生每季编号**（与 Emby/Jellyfin 一致）。

```js
{
  flow_id,                 // 命中的 ruleflow id（== ruleflow.list() 的 id），用来挂 per-flow 配置
  media: {
    tmdb_id, tmdb_type,    // "tv" | "movie"；Mikan 来源常缺 tmdb_id
    imdb_id,
    season, episode, episode_end,   // TMDB 原生编号；电影 episode=0；合集 episode_end>0
    title, original_title, aka, year
  },
  tags: {                  // 标题提取的质量标签（ruleflow 已算，原样透传）
    resolution, video_encode, audio_encode, dv, hdr, code_bits, format,
    language, source, group, special_content, part_alias
  },
  ctx: {                   // 关联 / 日志 / 自定义，可全忽略
    raw_title, subtitle,
    description,           // RSS 种子描述原文；可规则化的片段已进 tags，这里是未结构化正文，供插件自行解析
    tag,                  // 站点标签（free / 官种 / 中字 / 促销 等），这条种子的属性标记
    anime_id, task_id, link_subdir, directory,
    source_site, category, size, torrent_url, is_movie, is_show
  }
}
```

### per-flow 满足判断（推荐模式）

"库里算不算有这集"应**按当前 ruleflow 的意图**判断、而非全局——否则你若用两条 ruleflow 各下 1080p / 4K 到同一库，第二份会被第一份误判成"已有"。做法：

1. 用 [`ruleflow.list()`](#ruleflow--规则流只读需-apiruleflow) 在插件配置 UI 列出所有 ruleflow；
2. 让用户给每个 `flow_id` 挂一套满足标准（如"库内有 1080p 才算有"）；
3. hook 触发时按 `p.flow_id` 取对应配置 + 用 `p.tags` / 查库做 like-for-like 比对。

> 局限：分辨率 / 编码 / HDR / DV / 位深等"实体属性"可从 Emby `MediaStreams` / Plex `Media` 直接可靠读取；字幕组（`group`）/ 来源类型（`source`）可经库内**文件名尽力解析**比对（按 `[组名]` 标签与 WEB-DL / BluRay 等关键字提取），**不保证准确**——解析不出时应按"不符合"处理（fail-open 方向，宁多推不误杀）；`format` / `language` / `special_content` / `part_alias` 等维度依赖文件名，库内文件常缺该信息，解析不出同样按"不符合"处理。
>
> [`media-library-filter`](https://github.com/followcat/plugin-registry/tree/main/plugins/media-library-filter) 是该模式的参考实现：挂 `should_download`，按 per-flow 规格（12 维可选）逐副本比对，可靠档维度直接读实体属性，尽力档（group / source）经文件名解析，解析不出即放行。

---

## 宿主 API 参考

> 未声明对应权限时，对应全局对象为 `undefined`，插件可用 `typeof xxx === "object"` 自检。

### 同步 / 异步 facade 一览

一句话规则：**碰网络 / 外部进程的返回 Promise，纯本地的保持同步。**

| 类别 | facade | 调用方式 |
|------|--------|---------|
| 同步（本地存储 / 纯计算，毫秒级） | `plugin.*`、`log.*`、`config.*`、`data.*`、`anime.get`、`task.get/list`、`ruleflow.list` | 直接取返回值：`var v = config.get("k")` |
| **异步（返回 Promise）** | `http.get/post/put/delete` | 必须 `await`（或 `.then`）：`var resp = await http.get(url)` |

> ⚠️ **破坏性变更：`http.*` 现在返回 Promise，没有同步别名。** 旧写法 `var resp = http.get(url); resp.status` 拿到的是 Promise 对象，`resp.status` 为 `undefined`。所在函数改成 `async function`，调用处加 `await`，并把 `async` 一路传到回调（hook / registerAPI / should_download 都支持 async，见下）。失败（网络错误、超时、限流、SSRF 拦截）以 **reject** 形式交付——`await` 处抛出的仍是原来那个错误对象（`e.message` 形如 `http GET <url>: ...`），`try { await http.get(...) } catch (e) {}` 照常能接住。

#### 回调可以是 `async`

`plugin.on` / `plugin.registerAPI` / `should_download` 的回调都可以返回 Promise（写成 `async function` 即可），宿主等它 settle：resolve 的值等同同步 `return`，reject 等同抛错。非 async 回调行为不变。

```js
// hook：await 期间同一插件的其它任务可以先跑
plugin.on("on_download_done", async function (p) {
  try {
    var resp = await http.post(webhookUrl, JSON.stringify({ ep: p.episode }), { "Content-Type": "application/json" });
    if (resp.status >= 400) log.warn("webhook " + resp.status);
  } catch (e) {
    log.error("webhook 失败: " + e);
  }
});

// registerAPI：返回值（resolve 的值）照常 JSON 序列化给前端
plugin.registerAPI("/ping-emby", async function (req) {
  var resp = await http.get(config.get("emby_url") + "/emby/System/Info/Public", { "Accept": "application/json" });
  return { ok: resp.status === 200 };
});

// should_download：resolve false → 跳过下载；reject / 超时 → fail-open 放行
plugin.on("should_download", async function (p) {
  try {
    var resp = await http.get(libraryQueryUrl(p), { "Accept": "application/json" });
    return !alreadyInLibrary(resp);
  } catch (e) {
    return true; // 外部库挂了：放行
  }
});
```

#### 超时语义

- 每次调用一个**墙钟**，**含 `await` 期间**：hook **10s** / `should_download` **3s** / registerAPI **10s**。超时即丢弃该次调用的结果（之后 Promise 才 settle 也被忽略），插件继续运行。
- `http.*` 每个请求固定 **10s** 超时（与所属调用的墙钟无关）。
- 纯 JS 死循环（同步段里、没 `await` 的 `while(true){}`）仍会被宿主打断；**`await` 之后的续体里写出的死循环宿主不看管**（插件作者负责），它会让整个插件卡住。停用 / 重装 / 自动停用会打断一切（含续体死循环）、取消在途 `http` 请求，插件完全退出。
- 沙箱**没有** `setTimeout` / `setInterval`，也没有 `require`；需要"稍后再做"请用标志位 + 下一次 hook 消费。

### `plugin` —— 注册中心（始终可用）

| 方法 | 签名 | 说明 |
|------|------|------|
| `plugin.on(name, fn)` | `(string, function(data))` | 注册 hook 处理函数；可为 `async function`（宿主等 Promise settle） |
| `plugin.registerAPI(path, fn)` | `(string, function(req) → any \| Promise<any>)` | 注册自定义 API；前端通过 `/api/plugins/<id>/api<path>` 调用，返回值（或 Promise resolve 的值）JSON 序列化 |

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

### `http` —— HTTP 客户端（需 `api.http`，**异步**）

> ⚠️ **破坏性变更**：全部方法返回 **Promise**，无同步别名，调用处必须 `await`（详见上文「同步 / 异步 facade 一览」）。

| 方法 | 签名 |
|------|------|
| `http.get(url, headers)` | `(string, map<string,string>) → Promise<{status, headers, body, truncated}>` |
| `http.post(url, body, headers)` | `(string, string, map<string,string>) → Promise<...>` |
| `http.put(url, body, headers)` | `(string, string, map<string,string>) → Promise<...>` |
| `http.delete(url, headers)` | `(string, map<string,string>) → Promise<...>` |

```js
var resp = await http.get(url, { "Accept": "application/json" }); // 所在函数须为 async function
```

约束：

- 单次响应体上限 **5 MiB**，超出截断并设 `truncated=true`
- 单插件令牌桶 **60 req/min**，超限 **reject**（`plugin http rate limit exceeded (60 req/min)`）
- 单次请求 **10 秒**超时；最多 3 次重定向
- 网络错误 / 超时 / 限流 / SSRF 拦截一律 reject（`e.message` 形如 `http GET <url>: ...`）；4xx/5xx **不** reject，看 `resp.status`
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

### `ruleflow` —— 规则流只读（需 `api.ruleflow`）

```js
var flows = ruleflow.list()
// → [{ id, name }, ...]
```

- `id` == `should_download` payload 的 `flow_id` == 后端 `SiteConfig.FlowID`；插件按 `id` 存 per-flow 配置，UI 上展示 `name`。
- 只读白名单投影，**仅 `{id, name}`**，不暴露节点结构 / 链接规则 / 任何凭据。
- 典型配合 `should_download` 用：在配置 UI 枚举所有 ruleflow，逐条挂"满足判断"标准。

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

宿主在 **`/plugin-sdk.js`**（站点根路径）提供 SDK，**不会自动注入**——你必须在 HTML 里自己 `<script src>` 引入。该 SDK 通过 `postMessage` 与宿主通信，**不用 `fetch`/`XHR`**（iframe 的 CSP 是 `connect-src 'none'`，任何直接网络请求都会被浏览器拦截）。

```html
<script src="/plugin-sdk.js"></script>
<script>
  FC.ready().then(function (ctx) {
    // ctx 仅含 { pluginId, slot }：
    //   pluginId —— 当前插件 id（驼峰，注意不是 plugin_id）
    //   slot     —— 当前槽位，目前恒为 "plugin.settings"
    console.log('init', ctx);
  });
</script>
```

> `/plugin-sdk.js` 是唯一可用**绝对路径**引用的资源（宿主在站点根提供）。你**自己打包**的 JS / CSS / 图片必须用**相对路径**（`./app.js`）——UI 实际从 `/api/plugins/<id>/ui/<token>/index.html` 加载，相对子资源会自动继承带鉴权的 `<token>` 路径段；写成 `/app.js` 会丢掉 token 直接 404。

| 方法 | 返回 | 说明 |
|------|------|------|
| `FC.ready()` | `Promise<ctx>` | 等待宿主初始化；`ctx = { pluginId, slot }`（当前**不提供** theme / permissions） |
| `FC.api(path, body)` | `Promise<any>` | 调用插件自身注册的 API（`plugin.registerAPI`），宿主用 pluginToken 代理鉴权 |
| `FC.config.get(key)` | `Promise<string\|null>` | 读取插件配置，透明解密 |
| `FC.config.put(key, value, isSecret)` | `Promise<void>` | 写入插件配置；`isSecret=true` 仅控制回读脱敏（加密一直开） |
| `FC.notify(level, msg)` | `Promise<void>` | 在宿主界面显示 Toast，`level` ∈ `"info"\|"success"\|"warning"\|"error"`（宿主把 `info`/`success` 当成功提示、其余按错误） |
| `FC.resize(height)` | `Promise<void>` | 请求宿主调整 iframe 高度（像素，宿主 clamp 到 200–1500） |

> **iframe 桥就这 6 类消息**（`fc.init` / `api.call` / `config.get` / `config.put` / `host.notify` / `host.resize`）。`data.*` 加密 blob、`config.list`、`http.*`、`anime`/`task`/`ruleflow` 等**都不在 iframe 桥里**——它们只活在 `index.js` 的 goja 运行时。
>
> 而且 iframe 的 CSP 是 `connect-src 'none'`，连 `fetch`/`XHR` 都被禁，UI **不能**直接打 sandbox REST（`/api/plugins/<id>/sandbox/*`）。要在 UI 里读写 blob 或调上述能力，正确做法是在 `index.js` 里用 `plugin.registerAPI` 包一个端点，内部用 `data.*` / `http.*` 完成，UI 再通过 `FC.api` 调它：
>
> ```js
> // index.js（goja 侧，data.* 可用）
> plugin.registerAPI("/save-cover", function (req) {
>   data.put("cover.jpg", encodeUtf8(req.body).buffer); // req.body 是原始字节 string
>   return { ok: true };
> });
> ```
> ```html
> <!-- ui/index.html（iframe 侧，只有 FC.* 可用） -->
> <script>
>   await FC.api("/save-cover", "...");
> </script>
> ```
>
> `FC.api` 的 body 会被 JSON 序列化进请求体，传二进制需自己先 base64。

### 安全模型

- iframe 以 `sandbox="allow-scripts"` 加载（**无** `allow-same-origin`、**无** `allow-forms`），并带 `referrerpolicy="no-referrer"`；无法访问宿主 DOM / Cookie / localStorage。
- 沙箱 iframe 的 origin 是不透明的 `'null'`，所以宿主**不靠 origin 鉴别**，而是按 **source window 引用**（`event.source === iframe.contentWindow`）确认消息确实来自该 iframe。插件侧无需关心，照常用 SDK 即可。
- iframe 资源带严格 CSP：`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'none'; font-src 'self' data:; frame-ancestors 'self'`。实操含义：**外部 CDN 的脚本 / 样式 / 字体都加载不了**（要么打包进 zip，要么内联）；图片可用 `data:` 与 `https:`；**所有网络请求（fetch / XHR / WebSocket / EventSource）被禁**，只能走 `FC.*`。
- UI 资源经短时效 `pluginToken` 鉴权（路径段形式 `/api/plugins/<id>/ui/<token>/...`，宿主自动签发 / 续期，token 在访问日志里已脱敏）。插件只能操作 `/api/plugins/<自己的 id>/*`，接触不到用户 JWT。
- 管理页为 admin-only；`ui.embed` 插件 UI 同样仅对 admin 可见。

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
- **仅一个可否决 hook**：`should_download` 是当前唯一的同步可否决 hook（读返回值、可拦下载）；其余 `on_*` 都是只读通知（fire-and-forget），无其它 `on_before_*`。
- **无热重载**：插件代码改动需重新上传/启用；配置改动是热生效。
- **单 hook 仅最后注册有效**：同一 plugin 内重复 `plugin.on("x", ...)` 后者覆盖前者。
- **manifest 大小** ≤ 64 KiB，单文件 ≤ 5 MiB，zip 总解压 ≤ 20 MiB / ≤ 200 条目。
- **执行模型**：每个插件一个 JS 引擎 + 一个事件循环（仍是单线程，插件间隔离）。任务按队列顺序逐个执行同步段，队列容量 64，满则 drop-oldest 并 WARN；async 回调 `await` 期间，同一插件的其它任务可以先跑（完成顺序不保证）。墙钟超时 hook 10s / registerAPI 10s / `should_download` 3s（含 `await`）；1 分钟内 5 次 panic 自动熔断（disable）。

---

## 权限白名单（MVP）

`internal/plugin/permission.go` 是单一事实源：

| 权限 | 注入对象 |
|------|---------|
| `hook.download` | 允许订阅 `on_episode_found` / `on_download_done` / `on_download_failed`，以及同步否决 hook `should_download` |
| `hook.link`     | 允许订阅 `on_link_done` / `on_link_failed` |
| `hook.task`     | 允许订阅 `on_task_completed` / `on_task_reopened` |
| `hook.notify`   | 允许订阅 `on_notification_before_send` / `on_notification_after_send` |
| `api.http`      | 注入全局 `http` |
| `api.anime.read` | 注入全局 `anime` |
| `api.task.read`  | 注入全局 `task` |
| `api.ruleflow`   | 注入全局 `ruleflow`（`ruleflow.list()`） |
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
