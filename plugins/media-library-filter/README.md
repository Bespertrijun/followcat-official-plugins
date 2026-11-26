# media-library-filter

**下载去重器**：在 ruleflow 把种子推给 qBittorrent **之前**，拿种子自身的 `p.tags`（标题解析出的分辨率/编码等）与 Emby / Plex 媒体库内副本按**用户选定的维度+操作符**逐副本比对；若库内任意一份副本在全部已配维度上都匹配，则 `return false` 跳过下载（去重），否则照常下载。

**标签**：should-download、download-dedup、emby、plex、media-library、ruleflow、v3.5+

> ⚠️ **0.4.0 需要 FollowCat 事件循环插件运行时**（`http.*` 现返回 Promise）：旧宿主上本插件的否决不生效，请先升级 FollowCat。详见文末「从 0.3.x 升级」。
>
> ⚠️ **0.3.0 是破坏性升级**：本插件已从「下载否决器」（用户手填 spec 规格）改写为「下载去重器」（like-for-like，比对值来自种子自身 `p.tags`，用户只配维度和操作符）。详见文末「从 0.2.0 升级」。

## 适用场景

- 同时用多条 ruleflow 分别收 1080p / 4K，希望**同规格**已入库的集不再重复下载。
- 想要 like-for-like 去重：种子说自己是 HEVC 1080p，库里也有一份 HEVC 1080p → 跳过；库里只有 H264 720p → 照收。
- 不想手动维护每条 flow 的「目标规格」，而是让种子标签自己说话。

## 安装

1. 管理页 → 插件市场 → 搜索 `media-library-filter` → 安装。
2. 首次安装会弹出授权确认：`hook.download.write`（拦截下载）、`api.http`、`api.ruleflow.read`、`ui.embed`。
3. 进入插件详情 → **设置**标签配置 Emby / Plex 连接及 per-flow 维度。

## 配置

配置在管理页 → 插件详情 → **设置**标签里完成（iframe UI，`ui.embed`，仅 admin 可见）。UI 调 `ruleflow.list()` 列出所有 ruleflow，逐条配置。

### 全局连接配置

| key | 必填 | 是否 secret | 说明 |
|-----|------|------------|------|
| `emby_enabled` | 任选一个 | 否 | `"1"` 启用 Emby 库检查 |
| `emby_url` | 启用 Emby 时必填 | 否 | Emby 根 URL，例：`http://192.168.1.10:8096` |
| `emby_api_key` | 启用 Emby 时必填 | ✅ | Emby API Key（管理后台 → 高级 → API Keys） |
| `plex_enabled` | 任选一个 | 否 | `"1"` 启用 Plex 库检查 |
| `plex_url` | 启用 Plex 时必填 | 否 | Plex 根 URL，例：`http://192.168.1.10:32400` |
| `plex_token` | 启用 Plex 时必填 | ✅ | `X-Plex-Token` |
| `cache_ttl_sec` | 否 | 否 | 命中缓存的有效期（秒），默认 `3600`；缺集/规格不匹配走 `min(cache_ttl_sec, 60)` 秒短缓存。设 `0` 关闭缓存 |
| `cache_max_mb` | 否 | 否 | 纯内存按季缓存的估算容量上限（MB），默认 `10`、上限 `256`（超限按 LRU 淘汰）。设 `0` 关闭缓存 |
| `dry_run` | 否 | 否 | `"1"` 仅日志记录决策、**永远 `return true`**（不真正否决，验证用） |

> Emby 与 Plex 至少配置并启用一个；都没启用时插件对所有 flow 一律放行。

### per-flow 配置（key 中的 `<id>` 来自 `ruleflow.list()` 的 `id`）

| key | 取值 | 说明 |
|-----|------|------|
| `flow_<id>_enabled` | `0` / `1` | 默认 `0`（不干预）；`"1"` 启用该 flow 的去重检查 |
| `flow_<id>_dims` | JSON 字符串 | 该 flow 要比对的维度+操作符；键缺失/JSON 损坏/空 `{}` → 放行（无维度可比） |

#### `flow_<id>_dims` 格式

JSON 对象，每个键是维度名，值是 `{ "op": "<操作符>" }` 或 `{ "op": "regex", "pattern": "<正则>" }`。

示例：

```json
{
  "resolution": { "op": ">=" },
  "video_encode": { "op": "regex", "pattern": "hevc|h265|x265" },
  "audio_encode": { "op": "==" },
  "hdr": { "op": "==" }
}
```

含义：种子标签说分辨率 1080p、视频编码匹配 `hevc|h265|x265`、音频编码 AAC、HDR 是 → 去库里找副本，任一副本在这 4 个维度上全部匹配 → 否决下载。

#### 比对维度（7 个，均可选）

| 维度 | 允许的操作符 | 数据来源（库端） | 说明 |
|------|-------------|----------------|------|
| `resolution` | `==`、`>=` | Emby `MediaStreams[].Height/Width` / Plex `Media.videoResolution` | 分辨率归一为档位 `720p`/`1080p`/`2160p`；`>=` 表示库内分辨率大于等于种子标签分辨率即算匹配 |
| `video_encode` | `==`、`regex` | Emby `MediaStreams[].Codec` / Plex `Media.videoCodec` | 视频编码，如 `hevc`/`h264` |
| `audio_encode` | `==`、`regex` | Emby `MediaStreams[].Codec`（Audio 类型）/ Plex `Media.audioCodec` | 音频编码，如 `eac3`/`aac` |
| `code_bits` | `==`、`>=` | Emby `MediaStreams[].BitDepth` / Plex `Stream.bitDepth` | 位深，如 `10bit`；`>=` 表示库内位深大于等于种子标签位深即算匹配 |
| `hdr` | `==` | Emby `VideoRange`/`VideoRangeType` / Plex `videoProfile`+`colorTrc` | 是否 HDR，按「是 / 否」比较（种子端归一见下） |
| `dv` | `==` | 同 HDR 来源 + Plex `DOVIPresent`/`DOVIProfile` | 是否 Dolby Vision，按「是 / 否」比较（种子端归一见下） |
| `format` | `==`、`regex` | Emby `MediaSources[].Container` / Plex `Media.container` | 容器格式，如 `mkv`/`mp4` |

**种子端 `hdr` / `dv` 怎么归一**：宿主给的 `p.tags.hdr` / `p.tags.dv` 是字符串——识别出的原文（如 `"HDR"`）或种子字典值（如 `"HDR10"`、`"HDR10+"`、`"HLG"`、`"HDR Vivid"`、`"SDR"`、`"DolbyVision"`），没识别到时是 `"无"`。插件把 `"无"`、`none`、`no`、`false`、`0`、`sdr`（大小写不敏感）当「否」，其余非空值当「是」（`HLG`、`HDR Vivid` 都是「是」；也兼容布尔 `true` / `false`）。所以 `"无"` / `"SDR"` 是有效值「否」：SDR 库遇到非 HDR 种子会按「同规格」否决，HDR 库遇到非 HDR 种子会放行。只有宿主完全没给这个标签（空串）时才按下文的 tag 端空值短路放行。

**杜比视界也算 HDR**（与库端一致）：种子的 `dv` 为「是」时，`hdr` 维度也按「是」比较（哪怕 `p.tags.hdr` 是 `"无"`）——库端本来就把杜比视界副本记成 `hdr=是`。例：种子标题只写了 `DV`（`hdr="无"`、`dv="DV"`），配了 `hdr` 维度，库里是 HDR10 / 杜比视界副本 → 按同规格否决；库里是 SDR 副本 → 放行。

#### 操作符说明

| 操作符 | 符号 | 行为 |
|--------|------|------|
| 等于 | `==` | tag 值与库端观测值（不区分大小写）严格相等。`hdr`/`dv` 按「是 / 否」比较（种子端先归一，见上）；`resolution` 按档位相等；`code_bits` 按数值相等 |
| 大于等于 | `>=` | 仅 `resolution` 和 `code_bits` 可用。库端值 >= tag 端值即匹配（例：库有 4K 可匹配种子的 1080p） |
| 正则 | `regex` | 仅 `video_encode`、`audio_encode`、`format` 可用。需额外提供 `pattern` 字段。**双端匹配**：tag 值和库端值都必须匹配该正则才算匹配（不区分大小写）。用于将多种编码名归为同一类（如 `hevc\|h265\|x265`） |

**说明**：
- **未配置的维度不参与判定**。空 `{}` 或无有效维度 = 无维度可比 → 放行。
- **dims 键缺失或 JSON 损坏 = 未配置 → 放行**（绝不因配置缺失走否决）。
- 比对的值**来自种子 `p.tags`**，不是用户手填的规格值。用户只选「比哪些维度」和「怎么比」。
- **双端 fail-open**：tag 端为空（种子标题未解析出该维度）或库端为空（库内副本缺该属性）→ 该维度不匹配 → 该副本不算「有」→ 放行方向。

> per-flow 维度的意义：若同时用两条 ruleflow 分别收 1080p / 4K，按 `flow_id` 各配维度即可 like-for-like 比对，互不干扰。

## 工作流程

FollowCat 主仓提供同步可否决 hook `should_download`：宿主在每次 ruleflow 推送种子到 qBittorrent **之前**同步调用它，并**读取返回值**决定是否真的下载。

1. hook 触发，拿到 `PreDownloadCheck` payload：`flow_id`、`media.{tmdb_id, tmdb_type, season, episode}`、`tags`（质量标签，全部是字符串；本插件用其中 7 个维度）。
2. 按 `flow_id` 取该 ruleflow 的配置（`flow_<id>_enabled` / `flow_<id>_dims`）。flow 未启用 → 直接放行。
3. 读取 per-flow 维度配置（`dims`）。键缺失/JSON 损坏/空 `{}` → 放行（fail-open）。
4. tag 端短路：任一已配维度在 `p.tags` 中为空（`""` / 缺失）→ `dimMatch` 必定 false → 无需查库 → 放行。`hdr` / `dv` 的 `"无"` 不算空（它是有效值「否」）；`dv` 为「是」时 `hdr` 按「是」算，也不算空。
5. 按 `tmdb_id + 季 + 集` 在 Emby / Plex 里精确定位该集；取出**所有副本**的实体属性列表。
6. 逐副本与种子 tags 按已配维度+操作符比对：任一副本在**全部已配维度**上均匹配 → `return false`（否决）；否则照常推。

> **电影与剧集同逻辑**：`tmdb_type=movie`（`episode=0`）走完全相同的逐副本比对流程。

## 匹配策略

### `should_download` 判定流程

```
should_download(p)
  │  （全程 try/catch，任何异常 → return true）
  ▼
media.episode_end > 0 ?
  ├── 是 → 合集路径（见下方）
  └── 否 → 单集/电影路径
  ▼
【单集/电影路径】（按代码里的检查顺序，热路径全程 0 次 DB 读写）
flow_<p.flow_id>_enabled ≠ "1"（未启用 / 未配）     → return true   (flow_disabled，不计数)
  ▼
读取内存快照中的 flow_<p.flow_id>_dims
  │  键缺失 / JSON 损坏 / 空 {} / 无有效维度          → return true   (allowed_no_dims++)
  ▼
emby_enabled=0 且 plex_enabled=0                     → return true   (no_backend，不计数)
  │  !p.media.tmdb_id                               → return true   (allowed_no_tmdb++)
  ▼
tag 端短路：任一已配维度 p.tags[dim] 为空             → return true   (allowed_tag_empty++)
  ▼
纯内存按后端独立的按季/电影 LRU 缓存快路径（两端对称）：
  │  任意后端命中且副本匹配（在 cache_ttl_sec 内）     → return false  (vetoed++，0 HTTP)
  │  全部已启用后端均命中短负缓存（在 min(ttl, 60s) 内）→ return true   (allowed_not_in_lib / allowed_no_match)
  │  存在未命中缓存或短 TTL 已过的后端                 → 并行查未命中后端（按后端+同剧/同片复用 in-flight Promise）
  ▼
并行查 Emby / Plex（剧集一次拉整剧并独立写回该后端所有季缓存、清理已消失旧季；复用 tmdbID → seriesID/showKey 缓存）
  │  （2500ms 软预算在单后端多步请求之间检查：超了就不发下一枪）
  │  任意一端先命中匹配副本                            → 立刻 return false (vetoed++，不等慢端；慢端后台写各自缓存)
  │  全部返回仍无匹配，且任一后端失败 / 超预算          → return true   (allowed_error++，失败端不写缓存、成功端照写；
  │                                                       emby_last_error / plex_last_error 记原因)
  │  全部后端都正常查完、都没有这一集                   → return true   (allowed_not_in_lib++，写各自内存缓存)
  │  全部后端都正常查完、有副本但规格均不匹配            → return true   (allowed_no_match++，写各自内存缓存)
  ▼
dry_run=1：以上 false 路径一律改成 return true（仅 log）
超过宿主 3s 才走到这里（在途请求拖的）：宿主早已放行 → return true、late++、一条 warn，
  不记决策日志、不动上面的计数（缓存照写）

【合集路径（episode_end > 0）】
前置守卫同单集（flow / dims / backend / tmdb_id，然后区间合法性，最后 tag 空值）
  │  epStart ≤ 0 / epEnd ≤ 0 / epEnd < epStart     → return true   (invalid_range)
  ▼
纯内存按后端独立的按季 LRU 缓存快路径（与单集共用缓存，两端对称）：
  │  单端或两端缓存合并已覆盖整包全部集（在 ttl 内）   → 跳过 HTTP，直接 return false
  │  未覆盖全：短负缓存（<=60s）内的后端沿用缓存，其余并行拉整剧（复用 in-flight + seriesID/showKey 缓存）
  ▼
HTTP 并行拉整剧（各后端独立写各自按季缓存，任意一端合并后覆盖整包即立刻 return false）：
  │  失败端不写缓存；若无任何命中且存在后端失败/超时    → return true   (allowed_error++)
  ▼
逐集构建 bitmap（任一副本全维度匹配 → 标记 have）：
  │  全部集都在库中                                    → return false  (vetoed++)
  │  无集在库中                                        → return true   (allowed_not_in_lib++)
  │  部分集在库中                                      → return { have_bitmap }  (batch_partial_filtered++)
  ▼
dry_run=1：以上 false / bitmap 路径一律改成 return true（仅 log）
```

### 返回值契约（fail-open）

| 返回 | 行为 |
|------|------|
| 显式 `false` | **跳过**下载（仅在「确认库内任意副本在全部已配维度上按操作符匹配种子 tags」时返回） |
| `true` / `undefined` / 抛错 / 超时 | **照常下载**（fail-open） |
| `{ have_bitmap: "<base64>" }` | **合集逐集过滤**（`episode_end > 0` 时）：bitmap 标记库内已有的集，核心从缺失集中剔掉已有集，selective 模式只下剩余文件。单集路径忽略此返回值。 |

- **宿主硬超时 3 秒**（墙钟，含 `await`）：到点宿主就 fail-open 放行，不会被 Emby / Plex 拖垮。
- **2500ms 软预算只在两次请求之间检查**：发下一个请求前看一眼，超了就不再发、按放行处理；它**挡不住已经发出去的请求**——一个请求本身可以拖到宿主的每请求上限 10 秒。这时宿主已经在 3s 放行了，插件这边迟到的结果只写缓存（下次命中就快了）、`late` +1、打一条不带裁决的 warn，不记决策日志、不动其它计数。
- **tmdb_id 缺失**（Mikan 源常见）→ 无法精确查库 → 放行（不做标题近似兜底，避免误杀）。
- **多插件 veto-wins**：任一插件返回 `false` 即跳过；多插件 bitmap 取**并集**（OR）。
- **Bitmap 布局**：第 N 集 → `byte[(N-1)/8]` 的 bit `((N-1)%8)`（LSB 优先），与核心 `EpBitmap` 同构。

## 自定义 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins/<id>/api/flows` | `ruleflow.list()` 结果 + 每条 flow 当前配置（`enabled`、`dims`，供 UI 枚举） |
| GET  | `/api/plugins/<id>/api/stats` | 配置摘要 + 内存缓存用量 + 计数器 + last_error |
| POST | `/api/plugins/<id>/api/clear-cache` | 清空纯内存查库缓存与 `tmdbID → seriesID/showKey` 映射 |
| GET  | `/api/plugins/<id>/api/check?tmdb_id=1429&season=1&episode=8[&tmdb_type=tv&flow_id=...]` | 真实查库 trace（不写缓存）；带 `flow_id` 时输出 `would_decision` + 逐副本逐维比对明细（含 `height_raw`/`bucket`/`format`） |
| POST | `/api/plugins/<id>/api/check` | mock 注入验证：body `{"mock_copies":[...],"tags":{...},"dims":{...}}`（或 `{"flow_id":"...","tags":{...}}`），完全绕过真实查库，直接计算 `would_decision`/`would_reason` + 逐副本 trace，用于回归验证 |
| POST | `/api/plugins/<id>/api/save-config` | 批量保存（全局键 + 动态 `flow_*` 键白名单；dims 写入时做维度名+操作符校验+正则合法性校验） |
| POST | `/api/plugins/<id>/api/test-emby` | 探测 Emby 连通性（`/System/Info/Public`） |
| POST | `/api/plugins/<id>/api/test-plex` | 探测 Plex 连通性（`/identity`） |

### `/check` POST mock 示例

```json
{
  "mock_copies": [
    { "height": 1080, "hdr": false, "dv": false, "video_codec": "hevc", "audio_codec": "aac", "bit_depth": 10, "format": "mkv" }
  ],
  "tags": {
    "resolution": "1080p",
    "video_encode": "hevc",
    "audio_encode": "aac",
    "code_bits": "10bit",
    "hdr": false,
    "dv": false,
    "format": "mkv"
  },
  "dims": {
    "resolution": { "op": "==" },
    "video_encode": { "op": "==" }
  }
}
```

返回 `would_decision: "veto"` + 每副本每维度的 `tag_value`/`lib_value`/`match` 明细。

## 计数器

| key | 含义 |
|-----|------|
| `should_download_seen` | 进入 `should_download` 的总次数 |
| `vetoed` | 否决（`return false`）次数 |
| `allowed_not_in_lib` | 各后端都正常查完、库里确实没有这一集 → 放行（结果写缓存）。请求失败 / 没查完**不**算在这里，算 `allowed_error` |
| `allowed_no_tmdb` | tmdb_id 缺失 → 放行 |
| `allowed_no_match` | 命中但所有副本均不匹配种子 tags → 放行 |
| `allowed_no_dims` | dims 键缺失/损坏/空（无维度可比）→ 放行 |
| `allowed_tag_empty` | 已配维度在种子 tags 中为空 → 放行 |
| `allowed_error` | fail-open 放行：查库没做完——Emby / Plex 请求失败（网络错误、非 2xx、已启用但没填地址 / 密钥）、超了 2500ms 软预算没查完（没轮到下一枪 / 下一个后端）；合集批量拉取两端都失败 / 超预算；处理异常。这些情况都不写缓存 |
| `late` | 宿主 3s 超时之后插件才得出结果（在途请求拖的）：宿主早已放行，这次结果作废（只写缓存） |
| `dry_run_would_veto` | dry_run 模式下本应否决的次数 |
| `batch_partial_filtered` | 合集部分集在库中 → 返回 bitmap 逐集过滤的次数 |
| `cache_write_fail` | 兼容保留字段（0.4.2 改为纯内存缓存后恒为 `0`） |

`/stats` 的 `errors` 里还有 `emby_last_error` / `emby_last_error_at`、`plex_last_error` / `plex_last_error_at`：**最近一次**请求失败的原因与时间（也是插件配置里的 4 个键）。之后请求成功了也**不会清空**，所以它说明「最近一次出错是什么」，不说明「现在还在出错」——看是否持续故障要对照 `allowed_error` 是否还在涨、`*_last_error_at` 是否还在更新。

## 注意事项

- **3s 硬超时**：同时启用 Emby + Plex 时并行查询未命中缓存的后端，任意一端先 100% 确认否决即立刻返回，不被慢/故障的另一端拖累；单后端内的多步请求之间检查 2500ms 软预算，挡不住已发出的在途请求（见上文「返回值契约」）。`late` 持续增长需结合媒体库请求与宿主存储耗时排查；不能仅凭它认定媒体库响应慢。
- **缓存存副本事实明细，不存结论（纯内存按后端按季 LRU）**：剧集按 `<backend>:tv:<tmdb_id>:s<季>` 存整季逐集副本明细、电影按 `<backend>:movie:<tmdb_id>` 存副本列表，完全在内存维护，不再读写 `plugin_configs`。正命中走 `cache_ttl_sec`（默认 3600s），缺集或规格不匹配走 60 秒短 TTL（防止同波 RSS 重复查库，同时 1 分钟内感知新入库）；超 `cache_max_mb`（默认 10MB、硬上限 256MB）时先清过期项再按 LRU 淘汰。单集与合集共用同一份整剧查询和按季缓存，一次查剧会覆盖写入该后端返回的所有季并清理已消失的旧季；同时内存缓存 `tmdbID → Emby seriesID / Plex showKey`（仅对有集的剧写入，拉分集返回 404/400 或 200 空列表时自动清掉重查）并对同后端同剧/同片并发请求做 in-flight 复用（关闭缓存时不打断并发复用）。单个后端故障只影响该后端写缓存，不影响另一健康后端写入与复用。
- **配置内存化与计数器延迟落盘**：全局与 per-flow 配置启动时加载到内存，设置页保存后经 `/flows` 等接口即时刷新，并由 30 秒后台分步定时刷新兜底；计数器与 `*_last_error` 在内存累加、延迟约 15 秒后分步落盘，`should_download` 热路径做到 **0 次同步 DB 读写**。注意：停用、升级或容器重启时，最后约 15 秒内尚未落盘的统计增量与最近错误可能丢失（不影响已生效的下载判定）；在「高级配置」里手工修改计数器键的值，下次计数更新时也会被内存值覆盖（需重启插件才按 DB 生效）。升级自 `<= 0.4.1` 时会自动分步清理数据库里残留的旧 `lib_cache_*` 键并写 `cache_gen="3"`。
- **HTTP rate limit 60/min**：缓存 + per-flow 默认未启用基本可控；高频入库可放大 `cache_ttl_sec`。
- **fail-open 哲学**：宁可多下一份，也不因 Emby 宕机永久漏下。查 `emby_last_error` / `plex_last_error` 跟踪连续故障。
- **双端 fail-open**：tag 端（种子标题未解析出某维度）或库端（副本缺某属性）任一端为空 → 该维度不匹配 → 放行方向。绝不会因为某一端缺数据而误否决。
- **正则双端匹配**：`regex` 操作符要求 tag 值和库端值都匹配用户配置的正则 pattern，用于将不同名称归为同类（如 `hevc|h265|x265` 视为同一编码族）。pattern 最长 200 字符。

## 排错对照

| 现象 | 原因 | 处理 |
|------|------|------|
| 始终放行，从不否决 | flow 未启用 / dims 未配 / Emby+Plex 都没启用 | 检查 `flow_<id>_enabled="1"` 且 `flow_<id>_dims` 含有效维度 |
| 某维度始终不匹配 | 种子 tag 该维度为空（标题未解析出） | 查 `/check` API 的 `tag_value`；该种子源可能不提供此维度 |
| 库里明明有，却没否决 | 库端该维度属性为空（容器/编码信息缺失） | 查 `/check` API 的 `lib_value`；确认 Emby/Plex 媒体信息完整 |
| regex 维度不匹配 | pattern 只匹配了一端 | `regex` 要求 tag 值和库端值**都**匹配 pattern；确认 pattern 覆盖双端可能的名称变体 |
| `allowed_no_dims` 计数持续增长 | `flow_<id>_dims` 键缺失或 JSON 格式错误 | 用 `/save-config` API 写入合法 JSON；检查 UI 保存是否成功 |
| `allowed_tag_empty` 计数增长 | 已配维度在种子 tags 中无值 | 该种子源标题不含此维度信息 → 正常行为（fail-open 方向） |
| `allowed_error` 计数增长 | Emby/Plex 不可达、返回非 2xx、已启用但没填地址 / 密钥，或查询超了 2500ms 软预算 | 看 `/stats` 的 `emby_last_error` / `plex_last_error`（最近一次失败原因）及 `*_at` 时间；确认网络连通性与配置 |
| 内存缓存命中偏低或频繁重查 | `cache_max_mb` 过小触发 LRU 淘汰，或刚入库未满 60 秒短缓存 | 查看 `/stats` 的 `cache.bytes` / `cache.max_bytes`；可适当调大 `cache_max_mb`，或点「清空内存缓存」立即重查 |
| 用了 `>=` 但仍不匹配 | `>=` 仅限 `resolution` 和 `code_bits` | 其他维度不支持 `>=`，用 `==` 或 `regex` |
| dry_run 模式下无否决日志 | 查库未命中或维度不匹配 | 用 `/check` API 逐步排查；dry_run 只改变最终返回值，不改变匹配逻辑 |

## 与主仓关系

- **`should_download` hook**：由主仓提供（v3.5+），本插件注册。宿主在推种前同步调用，读取返回值。
- **`ruleflow.list()` API**：需 `api.ruleflow.read` 权限，用于 UI 列出所有 flow 以便逐条配置。
- **通知功能**：自 v3.5 起请走主仓 `internal/notify`（钉钉 / 飞书等），本插件不再涉及通知。

## 0.4.2：纯内存按季 LRU 缓存、零 DB 热路径与并行查询复用

- **纯内存按后端按季缓存 + `cache_max_mb` 容量上限**：查库缓存改为纯内存、Emby/Plex 各自独立按季存储逐集明细（电影按条存），新增配置项 `cache_max_mb`（默认 `10` MB，上限 `256` MB，支持设置页配置与「清空内存缓存」按钮 `POST /clear-cache`），超限时先清过期再按 LRU 淘汰；彻底移除逐集同步读库和 `flushCache` / `activeChecks`（修复高集数合集被宿主 3s 看门狗打断导致 `activeChecks` 永久泄漏的问题）。
- **正/负缓存分级 TTL**：命中匹配沿用 `cache_ttl_sec`（默认 3600s）；缺集或规格不匹配采用 60 秒短 TTL（`min(cache_ttl_sec, 60)`），兼顾防同波并发击穿与新入库/洗版及时感知。
- **热路径 0 DB 读写**：配置常驻内存（UI 保存经 `/flows` 立即同步，叠加 30 秒后台分步兜底刷新，后端连接参数变更时自动清缓存）；统计计数器与 `*_last_error` 在内存累加并延迟约 15 秒后分步落盘（插件停用/升级/重启可能丢失最近约 15 秒统计增量，外部手改计数器键也会被运行期内存值覆盖）。
- **并行双端与查询复用**：同时启用 Emby + Plex 时缓存查验两端对称、冷查并行发出，任意一端先 100% 确认否决即立刻返回（不被慢/故障的另一端拖累，健康端缓存独立写回）；单集与合集共享整剧拉取并整体替换该后端该剧所有季缓存（清除已消失旧季）；内存缓存 `tmdbID → Emby seriesID / Plex showKey`（仅对有集的剧缓存，404/400 或 200 空列表均自动失效重查）；同后端同剧/同片并发请求复用在途 Promise（singleflight，关闭缓存时不打断复用）。
- **升级清理**：从 `<= 0.4.1` 升级后自动清理 `plugin_configs` 中遗留的 `lib_cache_*` 键（启动同步删前 10 个立释配额，其余后台分步删，避开 10s 入口超时）并写入 `cache_gen="3"`。

## 0.4.1：查重与缓存保存分离

- 单集与合集查询完成后，先把副本事实保存在内存并返回查重结论；不用等待逐集数据库写入。后续查询立即可复用内存结果，仍按当前规则比较规格。
- 缓存保存由宿主定时器在返回后执行，间隔 25ms，每次至多写入或删除一个缓存键；查重进行中（含等待 HTTP）暂停后台保存。每轮保存只对账一次缓存键列表，新出现的缓存键也逐项读取。
- 内存缓存和待保存队列最多各 300 个键；同一键更新会合并。保留原查询时间作为 TTL 起点，过期或关闭缓存后不再保存排队结果。
- 保存失败只记 `cache_write_fail` 和警告，不改变已经返回的查重结论。停用、升级或重启可能丢失尚未保存的缓存，下次重新查库即可。通过外部工具直接修改缓存键后，内存缓存可能保留到后续对账或 TTL 到期；需要立即清空内存时可重启插件。
- 需要宿主支持 `setTimeout` 才能后台保存；更早的宿主仅保留内存缓存，不退回阻塞查重的同步保存。单次同步存储调用仍可能阻塞运行时，HTTP 本身超过 3 秒的既有放行语义也未改变。

## 从 0.3.x 升级（0.4.0）

- **需要 FollowCat 事件循环插件运行时**：`http.*` 现返回 Promise，本插件的 Emby / Plex 查询与 `should_download` 回调已改为 `async` / `await`。旧宿主不认 Promise 返回值，否决会失效（一律放行）。
- 配置键、维度、操作符、缓存格式均不变，升级后无需重新配置。
- 宿主 3s 超时（已 fail-open 放行）之后才回来的查询结果只写缓存，不记决策日志、不计入其它计数器；新增 `late` 计数（`/stats` 可见）并打一条不带裁决的 warn。
- `hdr` / `dv` 按宿主真实形态（字符串，没识别到是 `"无"`）归一成「是 / 否」再比：修复了旧版把 `"HDR"` 当成「否」、导致 HDR 种子被 SDR 副本误否决的问题。`"SDR"` 算「否」，`"HLG"` / `"HDR Vivid"` 算「是」；种子 `dv` 为「是」时 `hdr` 也算「是」（与库端一致）。
- **计数口径变了**：Emby / Plex 请求失败、超了软预算没查完，现在计 `allowed_error`（旧版单集路径上记成 `allowed_not_in_lib`）。`allowed_not_in_lib` 只表示「正常查完、库里确实没有」。
- **缓存会自己清理**（需要宿主的 `config.delete`）：写缓存时删过期项、缓存键总数上限 300；升级后第一次启动删掉 0.3.x 留下的全部缓存键（见「注意事项」）。

## 从 0.2.0 升级（迁移注意）

0.3.0 是**破坏性变更**：

- **核心模型换了**：「下载否决器」（用户手填 spec 规格值）→「下载去重器」（like-for-like，比对值来自种子 `p.tags`，用户只配维度+操作符）。
- **per-flow 配置键变更**：`flow_<id>_spec`（JSON 规格值对象）→ `flow_<id>_dims`（JSON 维度+操作符对象）。旧 `spec` 键不再被读取，可在管理页删除。
- **维度缩减**：12 个 → 7 个。移除 `group`、`source`、`language`、`special_content`、`part_alias`（文件名解析不可靠）；`format` 改从 `MediaSources.Container` / `Media.container` 直接读取（可靠度大幅提升）。
- **操作符是新概念**：旧版只有等于比较；新版支持 `==`（等于）、`>=`（大于等于，限 resolution/code_bits）、`regex`（正则，限 video_encode/audio_encode/format）。
- **空 `{}` 语义变了**：旧版空 `{}` spec = 「库里有即否决」（any 语义）；新版空 `{}` dims = 「无维度可比 → 放行」。
- **不再有 spec 三态**：旧版区分 `explicit_any` / `unset` / `corrupt`；新版只看 dims 是否有有效维度（有 → 比对；无 → 放行）。
- **计数器变更**：`allowed_spec_unset` → `allowed_no_dims`；`allowed_spec_mismatch` → `allowed_no_match`；新增 `allowed_tag_empty`、`dry_run_would_veto`。
