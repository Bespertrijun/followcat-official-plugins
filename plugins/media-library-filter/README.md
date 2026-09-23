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
2. 首次安装会弹出授权确认：`hook.download`、`api.http`、`api.ruleflow`、`ui.embed`。
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
| `cache_ttl_sec` | 否 | 否 | 库查询结果缓存秒数，默认 `3600`。设 `0` 关闭缓存 |
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

含义：种子标签说分辨率 1080p、视频编码匹配 `hevc|h265|x265`、音频编码 AAC、HDR true → 去库里找副本，任一副本在这 4 个维度上全部匹配 → 否决下载。

#### 比对维度（7 个，均可选）

| 维度 | 允许的操作符 | 数据来源（库端） | 说明 |
|------|-------------|----------------|------|
| `resolution` | `==`、`>=` | Emby `MediaStreams[].Height/Width` / Plex `Media.videoResolution` | 分辨率归一为档位 `720p`/`1080p`/`2160p`；`>=` 表示库内分辨率大于等于种子标签分辨率即算匹配 |
| `video_encode` | `==`、`regex` | Emby `MediaStreams[].Codec` / Plex `Media.videoCodec` | 视频编码，如 `hevc`/`h264` |
| `audio_encode` | `==`、`regex` | Emby `MediaStreams[].Codec`（Audio 类型）/ Plex `Media.audioCodec` | 音频编码，如 `eac3`/`aac` |
| `code_bits` | `==`、`>=` | Emby `MediaStreams[].BitDepth` / Plex `Stream.bitDepth` | 位深，如 `10bit`；`>=` 表示库内位深大于等于种子标签位深即算匹配 |
| `hdr` | `==` | Emby `VideoRange`/`VideoRangeType` / Plex `videoProfile`+`colorTrc` | 是否 HDR；布尔值 |
| `dv` | `==` | 同 HDR 来源 + Plex `DOVIPresent`/`DOVIProfile` | 是否 Dolby Vision；布尔值 |
| `format` | `==`、`regex` | Emby `MediaSources[].Container` / Plex `Media.container` | 容器格式，如 `mkv`/`mp4` |

#### 操作符说明

| 操作符 | 符号 | 行为 |
|--------|------|------|
| 等于 | `==` | tag 值与库端观测值（不区分大小写）严格相等。`hdr`/`dv` 按布尔比较；`resolution` 按档位相等；`code_bits` 按数值相等 |
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

1. hook 触发，拿到 `PreDownloadCheck` payload：`flow_id`、`media.{tmdb_id, tmdb_type, season, episode}`、`tags`（7 维质量标签）。
2. 按 `flow_id` 取该 ruleflow 的配置（`flow_<id>_enabled` / `flow_<id>_dims`）。flow 未启用 → 直接放行。
3. 读取 per-flow 维度配置（`dims`）。键缺失/JSON 损坏/空 `{}` → 放行（fail-open）。
4. tag 端短路：任一已配维度在 `p.tags` 中为空 → `dimMatch` 必定 false → 无需查库 → 放行。
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
【单集/电影路径】
flow_<p.flow_id>_enabled ≠ "1"（未启用 / 未配）     → return true   (flow_disabled)
  │  emby_enabled=0 且 plex_enabled=0               → return true   (no_backend)
  │  !p.media.tmdb_id                               → return true   (allowed_no_tmdb++)
  ▼
读取 flow_<p.flow_id>_dims
  │  键缺失 / JSON 损坏 / 空 {} / 无有效维度          → return true   (allowed_no_dims++)
  ▼
tag 端短路：任一已配维度 p.tags[dim] 为空             → return true   (allowed_tag_empty++)
  ▼
按 tmdb_id+季+集 查 Emby（命中即止）→ 否则查 Plex
  │  查询逼近 2500ms 预算 / http 故障且未命中          → return true   (allowed_error++)
  │  未命中（库里没有这一集）                           → return true   (allowed_not_in_lib++)
  ▼
命中（copies 列表非空）：
  │  逐副本检查：任一副本在全部已配维度上按操作符匹配    → return false  (vetoed++)
  │  所有副本均不匹配                                  → return true   (allowed_no_match++)
  ▼
dry_run=1：以上 false 路径一律改成 return true（仅 log）

【合集路径（episode_end > 0）】
前置守卫同单集（flow / dims / backend / tmdb_id / tag 空值）
  │  epStart ≤ 0 / epEnd ≤ 0 / epEnd < epStart     → return true   (invalid_range)
  ▼
缓存快路径：逐集读 lib_cache_*，全部命中且未过期      → 跳过 HTTP，直接用缓存 copies
  │  任一集缓存缺失/过期                              → 走 HTTP 批量拉取（一次拉全季）
  ▼
HTTP 批量拉取：Emby 优先 → Plex 兜底
  │  两端均失败 / 超时                                → return true   (allowed_error++)
  │  拉取成功 → 逐集写缓存（与单集路径共享 key 格式）
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

- **硬超时 3 秒**：库查询整体预算 ≤2500ms（留裕量）；逼近预算即放行。Emby / Plex 不可达不会拖垮下载管线。
- **tmdb_id 缺失**（Mikan 源常见）→ 无法精确查库 → 放行（不做标题近似兜底，避免误杀）。
- **多插件 veto-wins**：任一插件返回 `false` 即跳过；多插件 bitmap 取**并集**（OR）。
- **Bitmap 布局**：第 N 集 → `byte[(N-1)/8]` 的 bit `((N-1)%8)`（LSB 优先），与核心 `EpBitmap` 同构。

## 自定义 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins/<id>/api/flows` | `ruleflow.list()` 结果 + 每条 flow 当前配置（`enabled`、`dims`，供 UI 枚举） |
| GET  | `/api/plugins/<id>/api/stats` | 配置摘要 + 计数器 + last_error |
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
| `allowed_not_in_lib` | 库里没有这一集 → 放行 |
| `allowed_no_tmdb` | tmdb_id 缺失 → 放行 |
| `allowed_no_match` | 命中但所有副本均不匹配种子 tags → 放行 |
| `allowed_no_dims` | dims 键缺失/损坏/空（无维度可比）→ 放行 |
| `allowed_tag_empty` | 已配维度在种子 tags 中为空 → 放行 |
| `allowed_error` | 异常 / 超时 / 外部故障 → fail-open 放行 |
| `dry_run_would_veto` | dry_run 模式下本应否决的次数 |
| `batch_partial_filtered` | 合集部分集在库中 → 返回 bitmap 逐集过滤的次数 |
| `cache_write_fail` | 缓存写入失败次数（config 配额超限等，可观测） |

## 注意事项

- **3s 硬超时**：Emby（series 定位 + episode 列表）+ Plex 串行；逼近 2500ms 软预算即放行。库很大时建议优先只启用一个后端。
- **缓存存副本事实列表，不存结论**：缓存 key 为 `lib_cache_<type>_<tmdb_id>_s<季>_e<集>`，value 为该集所有副本的属性列表。命中后按**当前 flow 维度+操作符与种子 tags 现场比对**，同一集可被不同 flow 判出不同结果。外部故障路径**不写缓存**，避免把「暂时查不到」固化。**合集批量路径与单集路径共享同一份 per-episode 缓存**——单集查过的集在合集里直接命中，反过来也一样。
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
| `allowed_error` 计数增长 | Emby/Plex 不可达或超时 | 检查 `emby_last_error` / `plex_last_error`；确认网络连通性 |
| `cache_write_fail` 增长 | config 配额不足 | 减小 `cache_ttl_sec` 或清理旧缓存 |
| 用了 `>=` 但仍不匹配 | `>=` 仅限 `resolution` 和 `code_bits` | 其他维度不支持 `>=`，用 `==` 或 `regex` |
| dry_run 模式下无否决日志 | 查库未命中或维度不匹配 | 用 `/check` API 逐步排查；dry_run 只改变最终返回值，不改变匹配逻辑 |

## 与主仓关系

- **`should_download` hook**：由主仓提供（v3.5+），本插件注册。宿主在推种前同步调用，读取返回值。
- **`ruleflow.list()` API**：需 `api.ruleflow` 权限，用于 UI 列出所有 flow 以便逐条配置。
- **通知功能**：自 v3.5 起请走主仓 `internal/notify`（钉钉 / 飞书等），本插件不再涉及通知。

## 从 0.3.x 升级（0.4.0）

- **需要 FollowCat 事件循环插件运行时**：`http.*` 现返回 Promise，本插件的 Emby / Plex 查询与 `should_download` 回调已改为 `async` / `await`。旧宿主不认 Promise 返回值，否决会失效（一律放行）。
- 配置键、维度、操作符、缓存格式均不变，升级后无需重新配置。
- 宿主 3s 超时（已 fail-open 放行）之后才回来的查询结果只写缓存，不再记决策日志、不计入计数器。

## 从 0.2.0 升级（迁移注意）

0.3.0 是**破坏性变更**：

- **核心模型换了**：「下载否决器」（用户手填 spec 规格值）→「下载去重器」（like-for-like，比对值来自种子 `p.tags`，用户只配维度+操作符）。
- **per-flow 配置键变更**：`flow_<id>_spec`（JSON 规格值对象）→ `flow_<id>_dims`（JSON 维度+操作符对象）。旧 `spec` 键不再被读取，可在管理页删除。
- **维度缩减**：12 个 → 7 个。移除 `group`、`source`、`language`、`special_content`、`part_alias`（文件名解析不可靠）；`format` 改从 `MediaSources.Container` / `Media.container` 直接读取（可靠度大幅提升）。
- **操作符是新概念**：旧版只有等于比较；新版支持 `==`（等于）、`>=`（大于等于，限 resolution/code_bits）、`regex`（正则，限 video_encode/audio_encode/format）。
- **空 `{}` 语义变了**：旧版空 `{}` spec = 「库里有即否决」（any 语义）；新版空 `{}` dims = 「无维度可比 → 放行」。
- **不再有 spec 三态**：旧版区分 `explicit_any` / `unset` / `corrupt`；新版只看 dims 是否有有效维度（有 → 比对；无 → 放行）。
- **计数器变更**：`allowed_spec_unset` → `allowed_no_dims`；`allowed_spec_mismatch` → `allowed_no_match`；新增 `allowed_tag_empty`、`dry_run_would_veto`。
