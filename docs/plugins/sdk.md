# FollowCat 插件 SDK 参考（MVP）

> 本文是 MVP 阶段插件作者的速查手册，只列**已实现并可用**的能力。实战教程见 [`dev-guide.md`](./dev-guide.md)；设计与扩展规划在 FollowCat 主仓 `docs/`（`plugin-runtime-eventloop-plan.md`、`plugin-permission-expansion-plan.md`）。
>
> **威胁模型：插件可信，只防意外。** 插件跑在 FollowCat 进程里（每个插件一个 JS 引擎，不是独立进程）。宿主防的是**意外**——远端返回的怪数据、手滑写出的死循环、写得不好的正则、启动时插件出错——保证它们不把 FollowCat 带崩：启动时插件出问题只让该插件启用失败，停用一定在有限时间内完成。宿主**不防故意构造的攻击代码**，所以只安装你信任的插件（自己写的或官方的）。

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

## Hook 列表（10 个：9 个通知 hook + 1 个同步否决 hook）

> JS 侧通过 `plugin.on("<hook_name>", function(data) { ... })` 订阅。同名 hook 多次注册以最后一次为准。所有 hook payload 字段命名见主仓 `internal/domain/event.go`（`on_task_completed` 的统一形态见 `internal/plugin/event_bridge.go`），并由 `internal/domain/event_payload_test.go` 锁定。hook 须同时在 `manifest.hooks` 声明、并持有对应权限（见下表与「权限」章）。
>
> 类型：`anime_id` / `task_id` / `episode*` / `total_*` 是**数字**，`media_id` 是**字符串**，`episodes` 是数字数组。

| Hook | 所需权限 | 触发时机 | payload 关键字段 |
|------|---------|---------|-----------------|
| `on_episode_found` | `hook.download.read` | RSS 发现新集 | `anime_id`, `episode`, `torrent_url` |
| `on_download_done` | `hook.download.read` | qBittorrent 下载完成 | `anime_id`, `anime_title`, `episode`, `hash`, `files: [{path,size}]?`, `size?`, `save_path?`, `category?` |
| `on_download_failed` | `hook.download.read` | 下载失败（不可恢复） | `anime_id`, `anime_title`, `episode`, `episode_end?`, `hash`, `reason` |
| `on_link_done` | `hook.link.read` | 链接整理完成（自动整理路径） | `anime_id`, `anime_title`, `episode`, `dest?`, `tmdb_episode?` |
| `on_link_failed` | `hook.link.read` | 链接执行失败 | `anime_id`, `anime_title`, `episode`, `episode_end?`, `reason`, `hash?` |
| `on_episode_acquired` | `hook.task.read` | **集数新入库**：只在集数新入库（位图由灭变亮）时触发，覆盖自动整理 / 手动链接（含部分完成）/ 合集确认；重复整理已入库的集不触发 | `source`, `task_id`, `media_id`, `media_title`, `episodes`, `unit_kind`, `completed_units`, `total_units` |
| `on_task_completed` | `hook.task.read` | 番剧或豆瓣任务完结（每次完结恰好一次） | `source`（`"mikan"`/`"douban"`）, `task_id`, `media_id`, `media_title`, `total_ep`；兼容旧字段 `anime_title`（同 `media_title`） |
| `on_task_reopened` | `hook.task.read` | 已完成任务因总集数上调/新集出现被打回继续追更（done→tracking） | `source`（`"mikan"`/`"douban"`）, `task_id`, `media_id`, `media_title`, `old_total_ep`, `new_total_ep`, `acquired_units` |
| `on_task_subscribed` | `hook.task.read` | 新建了一个追踪任务（自动或手动，见下方说明；每个任务最多一次） | `source`（`"mikan"`/`"douban"`）, `trigger`（`"auto"`/`"manual"`）, `task_id`, `media_id`, `media_title?`, `site_id` |
| `should_download` | `hook.download.write` ⚠️敏感 | ruleflow 推种到 qBittorrent 之前（同步否决，见下节） | 见下节 `PreDownloadCheck` |

> `?` 表示这个字段可能没有有效值：字段**恒在**，没有有效值时是**零值**（空串 `""` / `0` / 空数组 `[]`，个别为 `null`），不会变成 `undefined`。判断「有没有」看值本身（`if (p.size > 0)`、`if (p.files.length)`）；写成 `p.size || 0`、`p.files || []` 也无妨。`episode_end` 只在合集时有意义（`> 0`，与 `episode` 组成 `[episode, episode_end]` 区间），单集 / 电影时为 `0`。
>
> **payload 是你自己的一份普通 JS 对象**：宿主给每个订阅插件、每次投递各发一份独立拷贝（宿主数据 → JSON → 沙箱内置 `JSON.parse`），和你自己 `JSON.parse` 出来的对象没有区别——可以改、加字段、`delete` 字段，`"use strict"` 下也不报错；只影响你自己这一份，不影响宿主主流程与其它插件；`should_download` 超时放行之后插件续跑时再改，也改不到宿主那边的数据。时间类字段是 RFC3339 字符串。
>
> **`media_id`**（`on_episode_acquired` / `on_task_completed` / `on_task_reopened` / `on_task_subscribed` 四个 hook 同名同义）：`source` 为 `"mikan"` 时是番剧 ID，`"douban"` 时是豆瓣条目 ID，统一是字符串。
>
> **`source` 决定 `task_id` 的命名空间**：`"mikan"` 时是番剧任务 ID，`"douban"` 时是豆瓣任务 ID，两者不通用。只关心番剧的插件（如按 `anime.get` 取元数据）应先 `if (p.source !== "mikan") return;`。
>
> **`on_episode_acquired`** 只在集数新入库（位图由灭变亮）时触发，覆盖自动整理 / 手动链接（含部分完成）/ 合集确认；重复整理已入库的集不触发。具体地：
>
> - 在入库结算事务**提交后**发，失败回滚不发；手动校正进度、豆瓣位图回填、强制切换清位图**不**触发。
> - `episodes` 是**本次由灭变亮**的单位（升序）：`unit_kind` 为 `"episode"` 时是集号（Mikan 为番剧 cour 相对号，豆瓣为 TMDB 绝对号）；`"period"`（综艺按期）时是期号；`"acquired"`（电影）时为空数组——电影只在「已获取」由否变是那一次触发。一次结算没有新亮的单位就不发。
> - 手动链接「部分完成」（种子仍待人工）也会触发（只含这次链上的集）；之后补完剩余文件只发剩下那几集。
> - 与 `on_link_done` 并存：前者管「进度到哪」（全部入库路径），后者管「文件放哪」（仅自动整理路径；手动链接不发 `on_link_done` / `on_link_failed`）。
>
> **`on_task_subscribed`** 在追踪任务**落库之后**发，**每个任务最多一次**：极少数情况下（比如宿主恰好在这一刻崩溃、或数据库出错）会漏发，且不会补发。`trigger` 区分来源：
>
> - `"auto"`：Mikan 站开了自动订阅、新番入库时自动建的任务；豆瓣自动追踪任务**第一次有种子通过规则**时（只被规则排除过的不发）。
> - `"manual"`：在番剧页手动订阅（单个、或「一键订阅本季」里逐个建的每个任务）；在豆瓣条目页手动建任务。
> - **不发**：已存在的任务（重复订阅 / 409）、建任务失败、普通成员的订阅请求（转成心愿单待审批）、心愿单审批建的任务、Mikan 委托种子在豆瓣侧的导航锚任务、RSS 站级任务。升级前就存在的豆瓣任务、以及在委托导航锚基础上被复用来自动追踪的豆瓣任务，也不会补发。
> - `site_id` 是这个任务所属的追更配置（站点）ID。插件按任务收到事件；同一部作品在多个站被订阅会收到多次，按 `media_id` 自行去重。宿主自己的「已自动订阅」通知只发 `auto` 且按作品去重，与插件 hook 互不影响。
>
> **通知 hook 已删除**：旧的 `hook.notify` 与 `on_notification_before_send` / `on_notification_after_send`（把宿主发出的 Slack/Telegram 通知抄送给插件）已移除——manifest 声明它们会解析失败。「插件借宿主通知通道发通知」将另行设计。

---

## 同步否决 hook：`should_download`（需 `hook.download.write`，敏感）

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
- 返回值由宿主在插件的事件循环上按 JSON **导出成拷贝**后再读（插件之后再改那个对象不影响结论），裁决看的是**导出后的值**：带 `toJSON` 的对象按 `toJSON()` 的结果算（返回 `false` 即否决），`new Boolean(false)` 导出成 `false` 也是否决；`have_bitmap` 要是非空、能按标准 base64（带 `=` 补齐）解出至少 1 个字节的字符串才算数，否则当放行。导不出来的值（带环、`BigInt`、嵌套超过 1000 层、超过 100 万个值、`toJSON` / getter 抛错）按普通错误处理（等同抛错 → fail-open 放行），不会拖垮宿主。
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
    tmdb_id, tmdb_type,    // 字符串（裸数字 id）；"tv" | "movie"；Mikan 来源常缺 tmdb_id（""）
    imdb_id,
    season, episode, episode_end,   // 数字；TMDB 原生编号；电影 episode=0；合集 episode_end>0
    title, original_title,
    aka,                   // 字符串数组（别名 / 多语言名）
    year                   // 数字，未知为 0
  },
  tags: {                  // 标题提取的质量标签（ruleflow 已算，原样透传），全部是字符串，没提取到为 ""
    resolution, video_encode, audio_encode, dv, hdr, code_bits, format,
    language, source, group, special_content, part_alias
    // hdr / dv 不是布尔：是识别出的原文（如 "HDR"）或种子字典值（如 "HDR10"、"HDR10+"、"DolbyVision"），
    // 没识别到填 "无"。要当布尔用自己归一：空 / "无" / none / no / false / 0 当「否」，其余当「是」
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

1. 用 [`ruleflow.list()`](#ruleflow--规则流只读需-apiruleflowread旧名-apiruleflow-已弃用仍可用) 在插件配置 UI 列出所有 ruleflow；
2. 让用户给每个 `flow_id` 挂一套满足标准（如"库内有 1080p 才算有"）；
3. hook 触发时按 `p.flow_id` 取对应配置 + 用 `p.tags` / 查库做 like-for-like 比对。

> 局限：分辨率 / 编码 / HDR / DV / 位深等"实体属性"可从 Emby `MediaStreams` / Plex `Media` 直接可靠读取；字幕组（`group`）/ 来源类型（`source`）可经库内**文件名尽力解析**比对（按 `[组名]` 标签与 WEB-DL / BluRay 等关键字提取），**不保证准确**——解析不出时应按"不符合"处理（fail-open 方向，宁多推不误杀）；`format` / `language` / `special_content` / `part_alias` 等维度依赖文件名，库内文件常缺该信息，解析不出同样按"不符合"处理。
>
> [`media-library-filter`](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/media-library-filter) 是该模式的参考实现：挂 `should_download`，按 per-flow 选定的维度（7 维可选：分辨率 / 视频编码 / 音频编码 / 位深 / HDR / 杜比视界 / 容器）+ 操作符逐副本比对，维度值都从 Emby / Plex 的实体属性直接读取；任一端缺值即视为不匹配（放行）。

---

## 宿主 API 参考

> 未声明对应权限时，对应全局对象为 `undefined`，插件可用 `typeof xxx === "object"` 自检。

### 同步 / 异步 facade 一览

一句话规则：**碰网络 / 外部进程的返回 Promise，纯本地的保持同步。**

| 类别 | facade | 调用方式 |
|------|--------|---------|
| 同步（本地存储 / 纯计算，毫秒级） | `plugin.*`、`log.*`、`config.*`、`data.*`、`crypto.*`、`anime.get`、`task.get/list`、`ruleflow.list`、`ptsite.list/get/registry/getCookieMeta`、`douban.getCookie` | 直接取返回值：`var v = config.get("k")` |
| **异步（返回 Promise）** | `http.get/post/put/delete`、`ptsite.setCookie`、`douban.setCookie` | 必须 `await`（或 `.then`）：`var resp = await http.get(url)` |

定时器（`setTimeout` / `setInterval` / `setImmediate`）不属于上面两类：登记是同步的、回调稍后在同一个事件循环上跑，语义见下文[「定时器」](#定时器settimeout--setinterval--setimmediate始终可用)。

批次 1（凭据写入 / 加解密）新增方法逐个归属：

| 方法 | 所需权限 | 同步 / 异步 |
|------|---------|------------|
| `crypto.sha256` / `crypto.md5` / `crypto.base64Decode` / `crypto.evpBytesToKey` / `crypto.aesDecryptCBC` | 无（始终可用） | 同步 |
| `ptsite.list` / `ptsite.get` / `ptsite.registry` / `ptsite.getCookieMeta` | `api.ptsite.read` | 同步 |
| `ptsite.setCookie` | `api.ptsite.write` | **异步** `Promise<{ok}>` |
| `douban.getCookie` | `api.douban.cookie.read` | 同步 |
| `douban.setCookie` | `api.douban.cookie.write` | **异步** `Promise<{ok, validation}>` |

> 参数类型不对（如漏传 `value`）在调用处**同步**抛 `TypeError`，不会变成 reject；宿主侧的失败（站点不存在、凭据类型不匹配、加密失败、超时）才以 reject 交付。
>
> **跨边界的数据一律是拷贝**：你传给 facade 的引用类型参数（如 `http.*` 的 headers 对象）在调用那一刻就被宿主复制，之后你再改它不影响已经发出的请求；facade 返回给你的结构化结果（`task.list()`、`anime.get()`、`ruleflow.list()`、`ptsite.list/get/registry/getCookieMeta()`、`douban.getCookie()`、`http.*` 的响应对象连同 `headers` 等）**每次调用都是新的一份普通 JS 对象**，和 `JSON.parse` 出来的一样——随便改、加字段、`delete` 字段（`"use strict"` 下也不报错），不影响下次调用、也不影响宿主。字节类返回不变：`data.get` 仍是字节数组、`crypto.*` 仍是 `Uint8Array`（见各自一节）。以后新增的 facade 同样遵守这条。

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
- registerAPI 超时：HTTP 调用方（含插件 UI 的 `FC.api`）收到 **504**。错误信息有两种：通常是 `plugin runtime: execution timeout`（这次调用的 10s 墙钟到了）；插件事件循环被别的任务占住、这次调用根本没轮上时是宿主 11s 兜底的 `plugin api: execution timeout`。两种都按超时处理。
- **入口脚本 10s**：`index.js` 顶层代码（连同它执行期间就触发的定时器回调、微任务）必须在 **10 秒**内跑完。到点没跑完（同步死循环、一直 `setImmediate` 自己续命、顶层一个很慢的内置操作都算）= 该插件本次**启用失败**：错误 `run entry script: entry script exceeded 10s (interrupted)` 写进宿主日志与插件的 `last_error_msg`（插件列表 / 详情页可见），插件保持停用状态；数据库里的「已启用」标记不变（下次 FollowCat 启动还会再试）。入口脚本执行期间宿主自己出了 Go panic 同样只算该插件启用失败（`run entry script: host panic: <原因>`），进程不崩。宿主启动时照常加载其它插件，**FollowCat 正常起来，不会被一个坏插件卡住**。耗时的初始化别放在顶层同步跑，放进定时器 / 首次调用里。
- 入口脚本执行期间就触发的定时器 / `setImmediate` 回调（及其 `await` 之后的续体）里出了宿主 Go panic，按定时器的规则处理（记 `last_error_msg`、计入自动停用），**不影响这次启用**；只有顶层代码本身（含它跑的微任务）里、或脱离了事件循环的宿主 panic 才让启用失败。
- `http.*` 每个请求固定 **10s** 超时（与所属调用的墙钟无关）。
- **正则单次匹配 5 秒上限**：带反向引用、环视等的正则（goja 用回溯引擎跑它们）遇到不匹配的长输入可能指数级回溯；单次匹配超过 **5 秒** 就放弃，按**未匹配**处理（`test` 返回 `false`，`exec` / `match` 返回 `null`，不抛错）。普通正则（没有反向引用 / 环视）走线性时间引擎，不受影响。别依赖这个上限做业务判断——它只是兜底。
- **停用卡住 → 需重启 FollowCat 才能再启用**：停用 / 卸载 / 升级最多等 **5 秒**。插件正卡在宿主打断不了的操作里（例如一个一直不返回的内置长操作）时，宿主到点放弃它、停用照常完成；但它的旧引擎还没真正退出之前，**再次启用会被拒绝**：「该插件上次的运行还没退出（卡在无法打断的操作里），请重启 FollowCat 后再启用」。旧引擎自己退出后这个限制自动解除；被放弃的旧引擎回来后也写不了配置 / 数据（`config.set/delete`、`data.put/delete` 抛 `plugin worker stopped`）。
- 纯 JS 死循环（同步段里、没 `await` 的 `while(true){}`）仍会被宿主打断；**`await` 之后的续体里写出的死循环宿主不看管**（插件作者负责），它会让整个插件卡住。停用 / 重装 / 自动停用会打断一切（含续体死循环）、取消在途 `http` 请求、清掉全部定时器，插件完全退出。
- 定时器回调与续体同等对待：**不计墙钟**，宿主不看管（见下文「定时器」）。
- 沙箱没有 `require`。

### 定时器：`setTimeout` / `setInterval` / `setImmediate`（始终可用）

| 函数 | 说明 |
|------|------|
| `setTimeout(fn, delayMs, ...args)` | `delayMs` 后调用一次 `fn(...args)`，返回句柄 |
| `setInterval(fn, delayMs, ...args)` | 每 `delayMs` 调用一次，直到 `clearInterval` |
| `setImmediate(fn, ...args)` | 尽快（当前任务结束后）调用一次 |
| `clearTimeout(h)` / `clearInterval(h)` / `clearImmediate(h)` | 取消；已触发 / 不存在的句柄无操作 |

- **和 `await` 之后的续体同等对待**：回调在插件自己的事件循环上跑（与 hook / API 串行，不用加锁），**不计墙钟**、宿主不看管；不限个数、不设最小间隔。回调里写出的死循环同样会卡死整个插件——插件作者自负其责。
- `delayMs` 规则同 Node：非数字 / `NaN` / 小于 1 / 大于 `2147483647`（约 24.8 天）一律按 **1ms**。周期很长的任务自己先截到这个上限以内，否则会变成每毫秒跑一次。
- **回调抛错、或 async 回调 reject 未处理**：宿主记一条 WARN（插件详情页日志可见，形如 `setInterval callback error: Error: ...`，同时写进 `last_error_msg`），事件循环照常，同一个 `setInterval` 下个周期照跑，不影响插件其它回调，**不计入 panic 自动停用**。只盯定时器回调本身返回的那个 Promise；回调里另起、没人接的 Promise 被 reject 时宿主不记。
- **宿主侧 Go panic**（插件 JS 的 throw / reject、栈溢出之类的 JS 错误都不算，只有宿主代码自己崩了才算）发生在定时器回调里：记到 `plugin/<id>` 日志、写 `last_error_msg`，并且**计入** panic 自动停用（1 分钟 5 次；停用后 `last_error_msg` 显示 `因频繁崩溃被自动停用：<最后一次错误>`）——与 hook 里的宿主 panic 同一个计数。（registerAPI / `should_download` 里的宿主 panic 只让这一次调用失败：API 调用方收到错误、`should_download` 放行；不计入自动停用、不写 `last_error_msg`。）
- **停用 / 卸载 / 升级 / 自动停用**：事件循环终止时全部定时器一并清除，之后不会再触发任何回调；定时器状态不持久化，重新启用是全新状态（入口脚本重跑，想要的定时器自己再登记）。
- 句柄是不透明值（宿主是数字、devrt 是 Node 的 `Timeout` / `Immediate` 对象），只用来传回 `clear*`，且按类型配对（`setTimeout`↔`clearTimeout` 等）——宿主上三种句柄共用一个 id 空间、混用也能取消，但 devrt（Node）里 `clearImmediate` 取消不了 `setTimeout` 的句柄。
- 入口脚本顶层就可以登记（例如按配置排一个 `setInterval`），不会拖慢插件启用。

```js
// 每 N 分钟做一次；配置变了由 UI 调 /reschedule 立即按新间隔重排
var timer = null;
function reschedule() {
  if (timer !== null) { clearInterval(timer); timer = null; }
  var min = parseInt(config.get("interval_min") || "0", 10);
  if (min > 0) {
    timer = setInterval(function () {
      doWork().catch(function (e) { log.error("定时任务失败: " + e); }); // 自己接住错误，别只靠宿主的 WARN
    }, Math.min(min * 60000, 2147483647));
  }
}
plugin.registerAPI("/reschedule", function () { reschedule(); return { ok: true }; });
reschedule(); // 启动时排上（等满一个周期才第一次跑）
```

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

每个参数先按 goja 导出成 Go 值、再用 Go 的 `fmt.Sprint` 转成文本，参数之间用一个空格拼接；写入 ringbuffer 时带 `plugin/<id>` 来源前缀，可通过插件详情页拉取。所以非字符串参数的样子是 Go 的，不是 JS 的：

| 参数 | 日志里 |
|------|-------|
| `{b: 2, a: {c: [1, 2]}}` | `map[a:map[c:[1 2]] b:2]`（键排序） |
| `[1, "a", null, true]` | `[1 a <nil> true]` |
| `null` / `undefined` | `<nil>` |
| `new Error("boom")` | `map[]`（Error 没有可枚举属性）——要看错误写 `String(e)` 或 `"失败: " + e` |
| `0.1 + 0.2` / `123456789.5` / `1e-7` | `0.30000000000000004` / `1.234567895e+08` / `1e-07`（非整数按 Go 浮点写法） |
| `Infinity` / `NaN` | `+Inf` / `NaN` |

想要确定的文本就自己拼成字符串再传（`log.info("n=" + n + " obj=" + JSON.stringify(o))`）。

消息里的换行 / 回车被转义成可见的 `\n` / `\r` 两个字符（`log.info("a\nb")` 在日志里是一行 `a\nb`）：一次 `log.*` 永远只产生一行，插件打不出看起来像别的行（例如审计行）的第二行。要分行就多调几次 `log.*`。

### `config` —— 插件配置（始终可用）

| 方法 | 说明 |
|------|------|
| `config.get(key) → string \| null` | 读，未设置返回 `null` |
| `config.set(key, value)` | 写。`value` 按字符串存：`null` / `undefined` / 不传 → `""`，其它非字符串按 JS 的 `String(v)` 转（`5` → `"5"`、`true` → `"true"`、对象 → `"[object Object]"`——存结构化数据请自己 `JSON.stringify`）。key / value / 配额不合法时抛错 |
| `config.delete(key) → boolean` | **同步**删除本插件的这个 key 并释放它占的配额；返回是否真的删到（没设过 → `false`）。key 校验同 `config.set`（不合法抛错）。需要宿主开放 `config.delete` 之后的版本——兼容旧宿主就先判断 `typeof config.delete === "function"` |
| `config.list() → string[]` | **v3.4+** 列出当前插件全部 keys，按字典序排序，仅 keys 不含 values |

**所有 Value 在 store 层无条件 AES-256-GCM 加密落库。** `is_secret` 标记不是加密开关，仅控制 API 回读时是否返回明文（前端 `is_secret=true` 时回传空字符串，UI 显示「已设置」占位）。`config.set` 默认写入的项 `is_secret=false`（更新已有 key 时保留原标记）；要标记 secret 需走管理页 UI、admin REST `PUT /api/plugins/:id/config` 显式传 `is_secret:true`，或插件 UI 里 `FC.config.put(key, value, true)`。插件后端的 `config.get` 始终拿明文，脱敏只发生在 API / iframe 回读。

**约束（v3.4）：**

- key 长度 1–128，仅限 `[a-zA-Z0-9._-]`
- value 上限 64 KiB
- 每插件最多 **500 个 key**（admin 可调，见下文）
- 跨 plugin 隔离：plugin A 看不到 B 的 keys

**配额错误**：新 key 超出抛错（更新已有 key 不计），message 含 `current=N limit=M`。用来做缓存的 key 记得自己清理（过期就 `config.delete`、总数设上限），别让它把配额撑满——撑满之后计数器、用户配置都写不进去了：

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
| `data.get(name) → number[] \| null` | 读取：返回**字节数组**（每个元素 0–255 的数字，`Array.isArray` 为 `true`，**不是** `ArrayBuffer`）；未设置或读取失败返回 `null`。要当二进制用就 `new Uint8Array(data.get(name))` |
| `data.put(name, value)` | 写入；`value` **必须** 是 `ArrayBuffer`、`Uint8Array`，或 `data.get` 拿到的那个字节数组（原样写回可以）；传 string / 对象 / 普通数组字面量（如 `[1, 2, 3]`）/ 其它 TypedArray 抛 `TypeError`（`data.put requires ArrayBuffer or Uint8Array, got <Go 类型>`）。`name` 按 `String(name)` 转换（`42` → `"42"`）后再按 key 规则校验 |
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

> goja 没有原生 `TextEncoder`/`TextDecoder`，要把 string 转 Uint8Array 需自己实现 UTF-8 编解码。可直接抄 [dev-guide「UTF-8 编解码」](./dev-guide.md#utf-8-编解码goja-没有原生-textencoder) 的 `encodeUtf8` / `decodeUtf8` 参考实现（都交给内置函数完成，MB 级数据也只要几十毫秒）。

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
- `headers` 对象在调用那一刻被复制，之后改它不影响这次请求
- **SSRF 守卫**（按真正连接的 IP 判断，含每次重定向）：局域网 RFC1918（`10.x` / `172.16–31.x` / `192.168.x`）、IPv6 ULA、以及 **`100.64.0.0/10`（CGNAT，Tailscale 等组网用的地址段）放行**；本机回环（`127.0.0.1` / `localhost` / `::1`）、`0.0.0.0`、链路本地 `169.254.0.0/16`（含云厂商元数据 `169.254.169.254`）、组播**一律拦截**。`100.64.0.0/10` 里**单独拦截 `100.100.100.200`**（阿里云等的元数据地址），其余地址照常可达。这条放行只对插件的 `http.*` 生效；插件源（registry）拉取等宿主自己的出网仍不放行内网

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

### `ruleflow` —— 规则流只读（需 `api.ruleflow.read`；旧名 `api.ruleflow` 已弃用、仍可用）

```js
var flows = ruleflow.list()
// → [{ id, name }, ...]
```

- `id` == `should_download` payload 的 `flow_id` == 后端 `SiteConfig.FlowID`；插件按 `id` 存 per-flow 配置，UI 上展示 `name`。
- 只读白名单投影，**仅 `{id, name}`**，不暴露节点结构 / 链接规则 / 任何凭据。
- 典型配合 `should_download` 用：在配置 UI 枚举所有 ruleflow，逐条挂"满足判断"标准。
- 权限名：新插件一律声明 `api.ruleflow.read`。`api.ruleflow` 是历史命名（无 `.read` 后缀），作为弃用别名保留——两者解锁同一个 `ruleflow.list`，已安装的旧插件不受影响。注意：只认新名的宿主版本之前，声明 `api.ruleflow.read` 的插件会因未知权限装不上，发布时留意宿主最低版本。

### `crypto` —— 纯函数加解密（始终可用，**同步**）

无权限语义，覆盖 CookieCloud 解密全链路（base64 → `Salted__` 拆解 → EVP_BytesToKey → AES-CBC），插件不必再内嵌 CryptoJS。

| 方法 | 签名 |
|------|------|
| `crypto.sha256(x)` | `(string \| Uint8Array \| ArrayBuffer) → string`（小写 hex；string 按 UTF-8 编码） |
| `crypto.md5(x)` | 同上 |
| `crypto.base64Decode(str)` | `(string) → Uint8Array`（标准 `+/` 字母表，尾部 `=` 可省略；非法输入抛错） |
| `crypto.evpBytesToKey(password, salt, keyLen, ivLen)` | `(string \| bytes, bytes \| null, int, int) → {key: Uint8Array, iv: Uint8Array}`（OpenSSL EVP_BytesToKey，MD5，1 轮；keyLen/ivLen ∈ [0, 256]） |
| `crypto.aesDecryptCBC(key, iv, data)` | `(bytes, bytes, bytes) → Uint8Array`（key 16/24/32 字节、iv 16 字节、data 为 16 的正整数倍；自动去 PKCS7 填充，填充不合法 = 口令错 / 数据坏 → 抛错） |

- `bytes` = `Uint8Array`（含 `subarray` 视图）或 `ArrayBuffer`；返回值都是新分配的 `Uint8Array`，改它不影响入参。
- 沙箱没有 `TextDecoder`：解密出的 UTF-8 字节转字符串需自行解码——照抄 dev-guide「UTF-8 编解码」的 `decodeUtf8`（交给内置函数完成，1 MB 级数据也只要几十毫秒；别自己写逐字节循环 + `+=` 拼接，那在 goja 里是平方级的，1 MB 要几分钟）。

```js
// CookieCloud：encrypted = CryptoJS.AES.encrypt(json, md5(uuid + "-" + password).substring(0, 16))
var pass = crypto.md5(uuid + "-" + password).substring(0, 16);
var raw  = crypto.base64Decode(payload.encrypted);          // "Salted__" + 8B salt + 密文
var kv   = crypto.evpBytesToKey(pass, raw.subarray(8, 16), 32, 16);
var json = utf8Decode(crypto.aesDecryptCBC(kv.key, kv.iv, raw.subarray(16)));
```

### `ptsite` —— PT 站配置与凭据（需 `api.ptsite.read` / `api.ptsite.write`）

对象按域注入、方法按权限挂载：只声明 `api.ptsite.read` 时对象上**没有** `setCookie`（`typeof ptsite.setCookie === "undefined"`）；只声明 `api.ptsite.write` 时没有读方法。两个都没声明时 `ptsite` 本身为 `undefined`。

> 插件**只能同步 cookie**：2026-09-25 起 `ptsite.setAPIKey` 已删除（`typeof ptsite.setAPIKey === "undefined"`），API Key 只能在管理端改。

**读（`api.ptsite.read`，同步）**——凭据本体永不出宿主，只回「已配置」标记与指纹：

| 方法 | 返回 |
|------|------|
| `ptsite.list()` | `[{id, name, adapter, enabled, auth_kind, has_cookie, has_apikey, hosts}]`（仅已注册 adapter 的 PT 站行） |
| `ptsite.get(id)` | 同形单个；不存在 / 非 PT 站 / adapter 未注册 → `null` |
| `ptsite.registry()` | `[{site_id, name, auth_kind}]`，`auth_kind ∈ "cookie" \| "apikey" \| "none"`（none = RSS 链接自带 passkey） |
| `ptsite.getCookieMeta(id)` | `{configured, sha256}`；`sha256` 按下文「Cookie 归一化契约」对**归一化后**的明文计算，未配置时为 `""`；站点不存在 → `null`。不提供打码值：明文永不出宿主，插件只需判「是否相同」 |

**写（`api.ptsite.write`，异步）**：

| 方法 | 返回 |
|------|------|
| `ptsite.setCookie(id, value)` | `Promise<{ok: true}>` |

`hosts`（只读）：该站 RSS 链接的**主机名**列表——每个 URL 取 hostname、小写、去重、保持首次出现顺序，解析失败的条目跳过，没配 RSS 时为 `[]`。只有主机名，**不含**路径 / query / 端口 / 账号密码（passkey 在路径或 query 里，`rss_urls` 本身仍不开放，见下文写方法说明）。宿主 PT 适配器只把 Cookie 发给 RSS 链接本身与 RSS 里的同站详情页，所以 `hosts` 正是这个站 cookie 的使用方——按浏览器 cookie 规则把 cookie 的 `domain` 与 `hosts` 匹配，就能挑出该写进这个站的 cookie（cookiecloud 插件即如此）。

- `value` 为明文，`""` = 清空。宿主加密落库（AES-256-GCM），**只更新这一列**，不会用旧值冲掉管理端同时改的其它字段。
- 与管理端 `PATCH /api/pt-sites/:id` 同一份校验：apikey 站与 `auth_kind=none` 的站拒绝非空 cookie（清空一律放行）；不匹配 / 站点不存在 → reject（`e.message` 以 `pt credential: ...` 开头，不回显你传的参数值）。
- 每次调用在入口记一条审计日志（见下文「审计日志」）。
- `rss_urls` / `adapter` 不开放写入（将来的 `ptsite.update` 也不会开放）：宿主拉 RSS 时会把 Cookie 头发给 `rss_urls` 里的每个 URL，能改它就等于能把明文 cookie 送去任意服务器。

```js
// 只在 cookie 真的变了时才覆写（明文不出宿主，比对在插件侧）
var meta = ptsite.getCookieMeta(siteId);
if (!meta || crypto.sha256(normalizeCookie(newCk)) !== meta.sha256) {
  await ptsite.setCookie(siteId, newCk);
}
```

### `douban` —— 豆瓣 Cookie（需 `api.douban.cookie.read` / `api.douban.cookie.write`）

同样按方法挂载（`douban` 对象将来还会挂 `api.douban.read/write` 的 media/task 方法，权限之间互不蕴含）。

| 方法 | 权限 | 返回 |
|------|------|------|
| `douban.getCookie()` | `api.douban.cookie.read` | 同步 `{configured, sha256}`，`sha256` 同归一化契约；未配置 / 解密失败 → `{configured:false, sha256:""}` |
| `douban.setCookie(value, {validate})` | `api.douban.cookie.write` | **异步** `Promise<{ok: true, validation}>` |

`douban.setCookie`：宿主加密落库 + 热加载（立即生效），`validate: true` 时再真打豆瓣验活，`validation` 取值：

| `validation` | 含义 |
|---|---|
| `"ok"` | Cookie 登录态有效 |
| `"cookie_invalid"` | 匿名 / Cookie 失效 |
| `"rate_limited"` | 豆瓣风控 / 通道忙——**包括验活 8s 内没做完**（已写入，稍后可再验） |
| `"unreachable"` | 网络 / 代理打不通 |
| `"no_cookie"` | `value === ""`（清空；不验活） |
| `""` | `validate` 为假且非清空（没验活） |

- 顺序固定：**先写入**（本地、快）再验活；验活在插件路径上限 **8s**，到点未完回 `rate_limited`（不是 `unreachable`），给同一次 registerAPI 调用（10s 墙钟）留约 2s 做别的出网。
- 验活期间插件工人不被占，`await` 即可，UI 一次请求拿到结果，无需轮询。
- 失败（加密失败、落库失败、10s 请求墙钟到期、插件停用）→ reject。每次调用入口记审计。

```js
plugin.registerAPI("/sync", async function (req) {
  var ck = await http.get(cloudURL);                          // 出网：Promise
  var r  = await douban.setCookie(decrypt(ck), { validate: true });
  return { validation: r.validation };                        // UI 一次拿到
});
```

### Cookie 归一化契约

宿主算指纹（`getCookieMeta().sha256` / `douban.getCookie().sha256`）与插件算候选指纹必须走同一规则，否则同一 cookie 换个写法就会被误判成「变了」：

1. 按 `;` 拆分
2. 每段去掉首尾 **ASCII** 空白（空格 / `\t` / `\n` / `\r`；**不**用 `String.prototype.trim`——它还会去掉 U+00A0、U+FEFF 等，宿主不去）
3. 丢弃空段（尾分号、`;;` 不产生段）
4. 按 **Unicode 码点序**排序（== UTF-8 字节序）。**不能用默认 `sort()`**：它按 UTF-16 码元比较，对 emoji 等 BMP 之外的字符与 U+E000–U+FFFF 之间的顺序和宿主不同（V8 / Node 上可复现）
5. 用 `"; "` 拼接

重复键不去重（两段都保留）。指纹 = `crypto.sha256(normalizeCookie(ck))`。参考实现（主仓测试与 `devrt/cookie-normalize.js` 用的是同一段代码，直接抄进插件即可）：

```js
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
```

测试向量（单一来源：[`cookie-normalize-vectors.json`](./cookie-normalize-vectors.json)，与主仓 `pkg/crypto/testdata/cookie_normalize_vectors.json` 逐字节相同；主仓 Go `NormalizeCookie`、主仓对上面这段 JS 的 goja 对拍、`node --test devrt/cookie-normalize.test.js` 三处都跑这一组，改规则须三处同步）：

| 用例 | 输入（JSON 字符串） | 输出（JSON 字符串） |
|---|---|---|
| empty | `""` | `""` |
| only separators and blanks | `" ; ;; \t"` | `""` |
| sorted by key | `"b=2; a=1"` | `"a=1; b=2"` |
| leading and trailing blanks | `"  a=1 ;\tb=2\r\n"` | `"a=1; b=2"` |
| trailing semicolon | `"a=1; b=2;"` | `"a=1; b=2"` |
| no space after semicolon | `"b=2;a=1"` | `"a=1; b=2"` |
| duplicate keys kept | `"a=2; a=1; a=2"` | `"a=1; a=2; a=2"` |
| inner blanks kept | `"k=a b ; x = y"` | `"k=a b; x = y"` |
| uppercase before lowercase | `"b=1; B=1; a=1"` | `"B=1; a=1; b=1"` |
| segment without equals | `"flag; a=1"` | `"a=1; flag"` |
| non-ascii values | `"name=\u5f20\u4e09; city=\u5317\u4eac"` | `"city=\u5317\u4eac; name=\u5f20\u4e09"` |
| code point order not utf-16 order | `"k=\ud83d\ude00; k=\uff01"` | `"k=\uff01; k=\ud83d\ude00"` |
| nbsp is not trimmed | `"a=1\u00a0; b=2"` | `"a=1\u00a0; b=2"` |
| bom is not trimmed | `"\ufeffa=1; b=2"` | `"b=2; \ufeffa=1"` |

### 审计日志

所有写 facade（当前：`ptsite.setCookie`、`douban.setCookie`）在入口由宿主记一行：来源 `audit/plugin/<id>`，消息 `AUDIT action=<方法> target=<目标>`（`target` 为站点 id 或 `douban_cookie`，超长截断、非 `[A-Za-z0-9_.-]` 字符替换为 `_`），**不记值**。`ptsite.setCookie` 传进来的 id 只有**确认站点存在**时才写进审计行；不存在（比如把参数写反成 `setCookie(cookie, siteId)`）时记成 `target=<invalid len=N>`（只记长度）——防止写反时把 cookie 当成 id 落进审计日志。插件的 `log.*` 固定来源 `plugin/<id>`，打不出 `audit/` 前缀，消息里的换行也被转义（见上文 `log`），所以审计行无法伪造。插件详情页日志窗口两类行都显示，审计行带「[审计]」标签。

---

## 能干什么 / 不能干什么

| ✅ 可以 | ❌ 不可以 |
|--------|----------|
| 读 `anime.get(id)` | 写任何 anime/task 数据（批次 3 规划中） |
| 经 `ptsite` / `douban` facade 写 PT 站凭据 / 豆瓣 Cookie（需对应 `.write` 权限） | 读回任何凭据明文（只有「已配置」+ 指纹） |
| `crypto.*` 本地加解密 | 用 `api.http` 回跳 FollowCat 自己的 REST（见下文「内部访问走 facade」） |
| `setTimeout` / `setInterval` 做定时任务 | 指望定时器跨停用 / 重启保留（停用即全清，重新启用从头登记） |
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
| `FC.api(path, body)` | `Promise<any>` | 调用插件自身注册的 API（`plugin.registerAPI`），宿主用 pluginToken 代理鉴权；resolve 为回调的返回值。请求形态见下方「`FC.api` 请求规则」 |
| `FC.config.get(key)` | `Promise<string\|null>` | 读取插件配置：设置过的 key 返回字符串——**secret 项回读 `""`**（脱敏，拿不到明文），普通项原样返回（存的是空串就是 `""`）；**没设置过返回 `null`**。判断「是否已设置」请用 `!== null`，别用 `!== ''`。不传 key 返回整个列表 `[{key, value?, is_secret, updated_at}]`（secret 项和值为空串的项没有 `value` 字段） |
| `FC.config.put(key, value, isSecret)` | `Promise<{updated: 1}>` | 写入插件配置；每次写都按 `isSecret` 覆盖 secret 标记，`isSecret=true` 仅控制回读脱敏（加密一直开）。key 须匹配 `^[a-zA-Z0-9_.\-]{1,128}$`（且不能是 `__proto__` / `constructor` / `prototype`），value 须是字符串（不传 / `null` 按 `""` 存）、≤ 64 KiB，否则 reject |
| `FC.config.delete(key)` | `Promise<{deleted: boolean}>` | 删除插件配置的这个 key 并释放配额；`deleted` 表示是否真的删到（没设过 → `false`，不报错）。key 规则同 `FC.config.put`（不合法 → reject，文案透传）。非字符串 / 空串，以及 `.`、`..` 在桥上直接 reject、不发请求（这两个键作为 URL 路径段会被浏览器规范化掉，只能用后端 JS 的 `config.delete` 删） |
| `FC.notify(level, msg)` | `Promise<{ok: true}>` | 在宿主界面显示 Toast：`level === "error"` 显示错误样式，**其余任何值都按成功提示** |
| `FC.resize(height)` | `Promise<{ok: true, applied}>` | 请求宿主调整 iframe 高度（像素，宿主 clamp 到 200–1500，非数字按 400；`applied` 是实际生效的高度） |

**`FC.api` 请求规则**（宿主把调用转成一次 HTTP 请求，插件回调收到的 `req` 由它决定）：

- **不传 `body`**（`FC.api("/stats")`）→ `GET`，`req.body` 为 `""`。
- **传了 `body`** → `POST`：
  - `null` → `req.body` 为 `""`（`""`、`0`、`false` 同样不发请求体，也是 `""`）；
  - 字符串 → 原样作为 `req.body`，**不会**再 JSON 编码；
  - 对象 / 数组 → `JSON.stringify` 后作为 `req.body`（插件侧自己 `JSON.parse`）；
  - 其它原始值（非 0 数字、`true`）→ 转成字符串。
- `path` 可以带 query：`FC.api("/check?tmdb_id=1&season=2")` 的 `?` 前面部分是端点，query 进 `req.query`（`Record<string, string>`，同名 key 取第一个值）。
- **失败**时 Promise reject 的 `Error.message` 是宿主回的真实原因：回调 `throw` / reject 的内容（如 `Error: boom`；同步 throw 时 goja 会在后面附上出错位置）、`plugin <id> api "/x" not registered`、超时（HTTP 504，`plugin runtime: execution timeout`）、参数校验等，而不是笼统的 `Request failed with status code 500`。例外是**宿主自己的内部错误**（数据库 / 存储出错、宿主 Go panic 等）：插件页只收到一句「宿主内部错误」，详情只记在服务端日志里（`FC.api`、`FC.config.*` 都一样）。

> **iframe 桥就这 7 类消息**（`fc.init` / `api.call` / `config.get` / `config.put` / `config.delete` / `host.notify` / `host.resize`）。`data.*` 加密 blob、`config.list`、`http.*`、`crypto.*`、`anime`/`task`/`ruleflow`/`ptsite`/`douban` 等**都不在 iframe 桥里**——它们只活在 `index.js` 的 goja 运行时。
>
> 而且 iframe 的 CSP 是 `connect-src 'none'`，连 `fetch`/`XHR` 都被禁，UI **不能**直接打 sandbox REST（`/api/plugins/<id>/sandbox/*`）。要在 UI 里读写 blob 或调上述能力，正确做法是在 `index.js` 里用 `plugin.registerAPI` 包一个端点，内部用 `data.*` / `http.*` 完成，UI 再通过 `FC.api` 调它：
>
> ```js
> // index.js（goja 侧，data.* 可用）
> plugin.registerAPI("/save-cover", function (req) {
>   // req.body 是请求体按 UTF-8 解出来的字符串，不是原始字节：二进制请 UI 先 base64 成字符串再发
>   data.put("cover.jpg", crypto.base64Decode(req.body));
>   return { ok: true };
> });
> ```
> ```html
> <!-- ui/index.html（iframe 侧，只有 FC.* 可用） -->
> <script>
>   await FC.api("/save-cover", base64String);
> </script>
> ```
>
> `FC.api` 的 body：字符串原样进 `req.body`，对象 / 数组会被 JSON 序列化（规则见上方「`FC.api` 请求规则」）。`req.body` 是字符串：直接发二进制会在 UTF-8 解码时损坏（非法字节变成 U+FFFD），所以二进制一律先 base64，后端用 `crypto.base64Decode` 还原。

### 安全模型

- iframe 以 `sandbox="allow-scripts"` 加载（**无** `allow-same-origin`、**无** `allow-forms`），并带 `referrerpolicy="no-referrer"`；无法访问宿主 DOM / Cookie / localStorage。
- 沙箱 iframe 的 origin 是不透明的 `'null'`，所以宿主**不靠 origin 鉴别**，而是按 **source window 引用**（`event.source === iframe.contentWindow`）确认消息确实来自该 iframe。插件侧无需关心，照常用 SDK 即可。
- iframe 资源带严格 CSP：`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'none'; font-src 'self' data:; frame-ancestors 'self'`。实操含义：**外部 CDN 的脚本 / 样式 / 字体都加载不了**（要么打包进 zip，要么内联）；图片可用 `data:` 与 `https:`；**所有网络请求（fetch / XHR / WebSocket / EventSource）被禁**，只能走 `FC.*`。
- UI 资源经短时效 `pluginToken` 鉴权（路径段形式 `/api/plugins/<id>/ui/<token>/...`，宿主自动签发 / 续期，token 在访问日志里已脱敏）。插件只能操作 `/api/plugins/<自己的 id>/*`，接触不到用户 JWT。
- 管理页为 admin-only；`ui.embed` 插件 UI 同样仅对 admin 可见。

### 示例

完整参考实现：[`cookiecloud/ui/index.html` @ Bespertrijun/followcat-official-plugins](https://github.com/Bespertrijun/followcat-official-plugins/blob/main/plugins/cookiecloud/ui/index.html)

- 用 `FC.ready()` 初始化，用 `FC.config.get(key)` 读取现有配置填充表单（secret 项回读 `""`，只用来判断「已设置」）；**初始加载成功之前禁用「保存」**，失败时给「重试」——否则会拿空表单覆盖已有配置
- 用 `FC.config.put(key, value, isSecret)` 逐项写入（secret 字段留空 = 不修改）
- 用 `FC.api('/sync', {})` 触发同步（立即返回 `{started}`，不等同步结束），只要 `/status` 还是 `running` 就每 2 秒轮询；读状态失败按钮要恢复、继续轮询，连续失败或插件已停用（`plugin not running`）就停下并给「重试」
- 保存设置后 `FC.api('/reschedule', {})` 让插件按新间隔重排定时器
- 用 `FC.resize(height)` 在内容变化后自动调整高度

---

## MVP 限制（请知悉）

- **iframe 为 admin-only**：`ui.embed` 插件 UI 只在管理员视图下可见，普通用户看不到设置标签。
- **仅一个可否决 hook**：`should_download` 是当前唯一的同步可否决 hook（读返回值、可拦下载）；其余 `on_*` 都是只读通知（fire-and-forget），无其它 `on_before_*`。
- **无热重载**：插件代码改动需重新上传/启用；配置改动是热生效。
- **单 hook 仅最后注册有效**：同一 plugin 内重复 `plugin.on("x", ...)` 后者覆盖前者。
- **manifest 大小** ≤ 64 KiB，单文件 ≤ 5 MiB，zip 总解压 ≤ 20 MiB / ≤ 200 条目；zip 内条目路径归一化后**不得重名**（有重复整个 zip 被拒，预览与安装都一样）。
- **已安装、但启用失败**：安装 / 升级时文件已经替换成新版本、但新版本启用失败（如入口脚本超时），算安装成功——管理页提示「已安装，但启用失败：原因」，插件停用、原因进 `last_error_msg`，修好后重新启用即可。
- **执行模型**：每个插件一个 JS 引擎 + 一个事件循环（仍是单线程，插件间隔离）。任务按队列顺序逐个执行同步段，队列容量 64，满则 drop-oldest 并 WARN；async 回调 `await` 期间，同一插件的其它任务可以先跑（完成顺序不保证）。墙钟超时 hook 10s / registerAPI 10s（超时回 504）/ `should_download` 3s（含 `await`）/ 入口脚本 10s（超时启用失败）；定时器回调不排这个队列、不计墙钟。hook 与定时器回调里 1 分钟内 5 次宿主 Go panic 自动熔断（disable）；registerAPI / `should_download` 里的宿主 panic 只让那次调用失败，不计数。插件 JS 的错误（throw / reject / 栈溢出等）永远不算 panic。
- **全局对象**：没有 `console`、`require`、`TextEncoder` / `TextDecoder`；`eval`、`Function` 是 `undefined`。日志用 `log.*`。
- **内置 `JSON` 带保护**：插件看到的 `JSON.parse` / `JSON.stringify` 是宿主包过的版本（插件代码不用改）：`JSON.parse` 遇到嵌套超过 **1000 层**的输入、`JSON.stringify` 遇到嵌套超过 **1000 层**或要输出超过 **100 万个值**的数据，抛普通 `TypeError`（`JSON.parse: input nested deeper than 1000 levels`、`JSON.stringify: value nested deeper than 1000 levels (circular reference?)`、`JSON.stringify: more than 1000000 values`），`try/catch` 接得住，不会拖垮宿主进程。正常输入与原生逐字节一致，`reviver`、`replacer`（函数或属性名数组）、`space`、`toJSON` 语义不变。
- **宿主给你的数据也有同样的上限**：payload、registerAPI 请求信封、facade 的结构化返回、`http.*` 的响应对象都是宿主按 JSON 转成的普通对象，转换时同样限嵌套 1000 层 / 100 万个值。插件改写了全局原型（如 `Object.prototype.toJSON`）导致转换超限时，这一次调用报错（hook 记 WARN、同步 facade 抛普通错误、`http.*` 等 reject，文案形如 `convert host value for plugin: nested deeper than 1000 levels (circular reference?)`），不会拖垮宿主。`JSON.stringify` 的数组 replacer（属性名白名单）长度超过 100 万直接抛 `TypeError`。
- **宿主内部错误**：异步 facade（`http.*`、`ptsite.setCookie`、`douban.setCookie`）在宿主侧出了 Go panic 时，reject 的错误文案固定是「宿主内部错误」，详情只进服务端日志。
- **生命周期操作按插件依次执行**：同一个插件的安装 / 升级、启用、停用、卸载、自动停用不会交错（后来的等前面的做完），所以升级过程中点「启用」最终跑的一定是新版本；不同插件之间互不等待。
- **安装 / 升级中途 FollowCat 被杀**：升级停旧版本时不改「已启用」标记。重启时宿主先核对插件目录：换目录做到一半（旧目录已挪成备份、新目录还没到位）→ 恢复备份；残留的暂存目录删掉；插件目录里 `manifest.json` 的版本 / 权限与数据库记录对不上（新记录写了、文件还是旧的）→ 不启用该插件并提示「插件文件与记录不一致，请重新安装后再启用」，不会用新版本的权限跑旧代码。重新安装一次（装完是停用状态）再手动启用即恢复。这项核对只在 FollowCat 启动时做；手动启用不核对。
- **返回给宿主的值**（registerAPI 的返回值、`should_download` 的返回值）按 JSON 导出成拷贝：`undefined` / 函数 / `Symbol` 属性被丢掉（数组里的变 `null`），`NaN` / `Infinity` 变 `null`，`Date` 变 ISO 字符串，`Map` / `Set` / 正则 / `Error` 变 `{}`，`Uint8Array` 变 `{"0":1,"1":2}` 形式的对象，`toJSON` 生效；带环、`BigInt`、嵌套超过 1000 层、超过 100 万个值 → 导出失败（registerAPI 调用方收到 `plugin return value is not JSON-serializable: ...`，`should_download` 放行）。

---

## 权限

`internal/plugin/permission.go` 是单一事实源。manifest 声明白名单外的权限会 fail-closed（解析报错并列出有效权限集）。

### 规则

- **声明式**：`manifest.permissions` 声明即授予（安装 / 升级时管理员确认），运行时不能增减。
- **命名**：`<api|hook>.<域>[.<资源>].<read|write>`，发布后**不改名**（改名会让已装插件过不了白名单、重启即加载失败）。唯一例外是 2026-09-24 的一次性硬改名：`hook.download` → `hook.download.read` + `hook.download.write`、`hook.link` → `hook.link.read`、`hook.task` → `hook.task.read`（**不留别名**，旧名声明直接解析失败），`hook.notify` 删除。
- **互不蕴含**：`api.douban.write` 不含 `api.douban.cookie.write`，`api.ptsite.write` 不含 `api.ptsite.read`——用什么声明什么。
- **方法级注入**：缺权限时对应全局对象为 `undefined`；对象存在时，没授权的方法也是 `undefined`（如只有 `api.ptsite.read` 时 `ptsite.setCookie` 不存在），可用 `typeof` 探测。
- **敏感权限**：`.write` 结尾，或显式名单（`api.http`：配任意读权限即可把数据外发）。安装 / 升级时管理页红色标注，需二次确认；升级只对**新增**的敏感权限再确认。
- **写 facade 三铁律**：与管理端同一份写逻辑（同校验 / 同加密 / 同热加载）；凭据只写不读；每次写记审计。

### 全集

| 权限 | 能力 | 状态 |
|------|------|------|
| `hook.download.read` | 订阅 `on_episode_found` / `on_download_done` / `on_download_failed`（只看） | 已实现 |
| `hook.download.write` ⚠️敏感 | 注册同步否决 hook `should_download`（推送下载前可决定不下载） | 已实现 |
| `hook.link.read` | 订阅 `on_link_done` / `on_link_failed` | 已实现 |
| `hook.task.read` | 订阅 `on_episode_acquired` / `on_task_completed` / `on_task_reopened` / `on_task_subscribed` | 已实现 |
| `api.http` ⚠️敏感 | 注入全局 `http`（SSRF 守卫：放行局域网与 `100.64.0.0/10`（其中 `100.100.100.200` 仍拦），拦本机 / 链路本地） | 已实现 |
| `api.anime.read` | `anime.get` | 已实现 |
| `api.task.read` | `task.get/list` | 已实现 |
| `api.ruleflow.read` | `ruleflow.list` | 已实现（正式名） |
| `api.ruleflow` | 同 `api.ruleflow.read` | **已弃用别名**（仍可用，新插件别用） |
| `ui.embed` | 声明 `manifest.ui.entry`（iframe 内嵌 UI） | 已实现 |
| `api.ptsite.read` | `ptsite.list/get/registry/getCookieMeta` | 已实现 |
| `api.ptsite.write` ⚠️敏感 | `ptsite.setCookie`（只写 cookie；批次 3 补 `create/update/delete`） | 已实现（凭据写入） |
| `api.douban.cookie.read` | `douban.getCookie` | 已实现 |
| `api.douban.cookie.write` ⚠️敏感 | `douban.setCookie(v, {validate})` | 已实现 |
| `api.rsssite.read` | `rsssite.list/get` | 规划中 |
| `api.rsssite.write` ⚠️敏感 | `rsssite.create/update/delete` | 规划中 |
| `api.douban.read` | `douban.listMedias/getMedia/listTasks/getTask` | 规划中 |
| `api.douban.write` ⚠️敏感 | `douban.createMedia/updateMedia/rematch/createTask/updateProgress` | 规划中 |
| `api.anime.write` ⚠️敏感 | `anime.rematch/updateExternalIds/setSeries` | 规划中 |
| `api.task.write` ⚠️敏感 | `task.subscribe/start/stop/retry/updateProgress/markLinked` | 规划中 |
| `api.ruleflow.write` ⚠️敏感 | `ruleflow.create/update/saveFull` | 规划中 |
| `api.linkrule.read` | `linkrule.list/get/export` | 规划中 |
| `api.linkrule.write` ⚠️敏感 | `linkrule.create/update/import` | 规划中 |
| `api.series.read` | `series.list/get` | 规划中 |
| `api.series.write` ⚠️敏感 | `series.confirm/split/recompute` | 规划中 |
| `api.download.read` | `download.list` + qB 查询 `info/infoAll/files/trackers` | 规划中 |
| `api.download.write` ⚠️敏感 | qB 变更 `add/delete/pause/resume/setFilePriority`（`delete(deleteFiles=true)` 真删磁盘文件） | 规划中 |

`crypto.*` 是纯函数，无需权限。**「规划中」的权限现在声明会导致 manifest 解析报错**，等宿主对应批次发布后再用。

明确**不给**：`api.server.*`、`api.notify.write`（webhook URL 即凭据外发通道）、用户 / 邀请码、密钥备份恢复、系统升级、插件管理自身、裸 `app_settings` 写与 `plugin.*` 配额键、qB WebUI 会话。暂缓：`api.notify.read`、`api.logs.read`、`api.link.execute`。

## 内部访问走 facade，禁止 `api.http` 回跳宿主 REST

- 读写 FollowCat 自身数据**只能**经上面这些注入对象（进程内直调，无网络面）。**不要**用 `http.*` 去请求 FollowCat 自己的 `/api/...`（`localhost`、内网地址、宿主域名都算）——哪怕今天打得通。
- 理由：`api.http` 的 SSRF 守卫为了让插件能查局域网里的 Emby / qBittorrent，放行了内网地址，所以回跳在网络层是可达的；插件进程没有用户 JWT，今天只能打到免鉴权端点，但规范要堵的是「将来新增免鉴权端点时被插件顺手用上」这条路。
- registry 人工审核会检查这一条：发现插件拿 `http.*` 访问宿主 REST 的，不予上架。需要的能力请提 issue 走 facade。

---

## 示例

- 下载去重类（`should_download` 同步否决 + Emby/Plex 查询，per-flow 满足判断）：[followcat-official-plugins/media-library-filter](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/media-library-filter)
- 聚合 API 类（headless，仅 `registerAPI`）：[followcat-official-plugins/dashboard-stats](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/dashboard-stats)
- 综合类（iframe UI + `crypto.*` 解密 + `ptsite` / `douban` 凭据写入 + 定时器自动同步 + 立即返回 / 轮询状态的 API）：[followcat-official-plugins/cookiecloud](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/cookiecloud)

> Slack / Telegram 通知不再以插件形式提供，自 v3.5 起已并入主仓 `internal/notify`。**想扩通道**（钉钉 / 飞书 / 企微等）PR 到主仓 channel registry；（旧的 `on_notification_*` 抄送 hook 已删除。）

---

插件已发布到市场？参考 [`marketplace.md`](./marketplace.md) 了解安装/升级流程，以及 [`registry-schema.md`](./registry-schema.md) 了解如何维护 index.json 与计算 zip_sha256。
