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
| `cache_ttl_sec` | 否 | 否 | 库查询结果缓存秒数，默认 `3600`。设 `0` 关闭缓存（不再写缓存，已有的缓存键在下次写缓存时删掉） |
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
【单集/电影路径】（按代码里的检查顺序）
flow_<p.flow_id>_enabled ≠ "1"（未启用 / 未配）     → return true   (flow_disabled，不计数)
  ▼
读取 flow_<p.flow_id>_dims
  │  键缺失 / JSON 损坏 / 空 {} / 无有效维度          → return true   (allowed_no_dims++)
  ▼
emby_enabled=0 且 plex_enabled=0                     → return true   (no_backend，不计数)
  │  !p.media.tmdb_id                               → return true   (allowed_no_tmdb++)
  ▼
tag 端短路：任一已配维度 p.tags[dim] 为空             → return true   (allowed_tag_empty++)
  ▼
（缓存命中且未过期 → 直接用缓存的副本列表，不发请求）
按 tmdb_id+季+集 查 Emby（命中即止）→ 否则查 Plex
  │  （2500ms 软预算只在两次请求之间检查：超了就不发下一枪）
  │  任一后端请求失败 / 超预算没查完（没轮到下一枪）      → return true   (allowed_error++，不写缓存；
  │                                                       emby_last_error / plex_last_error 记原因)
  │  各后端都正常查完、都没有这一集                      → return true   (allowed_not_in_lib++，写缓存)
  ▼
命中（copies 列表非空）：
  │  逐副本检查：任一副本在全部已配维度上按操作符匹配    → return false  (vetoed++)
  │  所有副本均不匹配                                  → return true   (allowed_no_match++)
  ▼
dry_run=1：以上 false 路径一律改成 return true（仅 log）
超过宿主 3s 才走到这里（在途请求拖的）：宿主早已放行 → return true、late++、一条 warn，
  不记决策日志、不动上面的计数（缓存照写）

【合集路径（episode_end > 0）】
前置守卫同单集（flow / dims / backend / tmdb_id，然后区间合法性，最后 tag 空值）
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

- **宿主硬超时 3 秒**（墙钟，含 `await`）：到点宿主就 fail-open 放行，不会被 Emby / Plex 拖垮。
- **2500ms 软预算只在两次请求之间检查**：发下一个请求前看一眼，超了就不再发、按放行处理；它**挡不住已经发出去的请求**——一个请求本身可以拖到宿主的每请求上限 10 秒。这时宿主已经在 3s 放行了，插件这边迟到的结果只写缓存（下次命中就快了）、`late` +1、打一条不带裁决的 warn，不记决策日志、不动其它计数。
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
| `allowed_not_in_lib` | 各后端都正常查完、库里确实没有这一集 → 放行（结果写缓存）。请求失败 / 没查完**不**算在这里，算 `allowed_error` |
| `allowed_no_tmdb` | tmdb_id 缺失 → 放行 |
| `allowed_no_match` | 命中但所有副本均不匹配种子 tags → 放行 |
| `allowed_no_dims` | dims 键缺失/损坏/空（无维度可比）→ 放行 |
| `allowed_tag_empty` | 已配维度在种子 tags 中为空 → 放行 |
| `allowed_error` | fail-open 放行：查库没做完——Emby / Plex 请求失败（网络错误、非 2xx、已启用但没填地址 / 密钥）、超了 2500ms 软预算没查完（没轮到下一枪 / 下一个后端）；合集批量拉取两端都失败 / 超预算；处理异常。这些情况都不写缓存 |
| `late` | 宿主 3s 超时之后插件才得出结果（在途请求拖的）：宿主早已放行，这次结果作废（只写缓存） |
| `dry_run_would_veto` | dry_run 模式下本应否决的次数 |
| `batch_partial_filtered` | 合集部分集在库中 → 返回 bitmap 逐集过滤的次数 |
| `cache_write_fail` | 缓存写入失败次数（config 配额超限等，可观测）。**只在内存里计**，插件重启归零 |

`/stats` 的 `errors` 里还有 `emby_last_error` / `emby_last_error_at`、`plex_last_error` / `plex_last_error_at`：**最近一次**请求失败的原因与时间（也是插件配置里的 4 个键）。之后请求成功了也**不会清空**，所以它说明「最近一次出错是什么」，不说明「现在还在出错」——看是否持续故障要对照 `allowed_error` 是否还在涨、`*_last_error_at` 是否还在更新。

## 注意事项

- **3s 硬超时**：Emby（series 定位 + episode 列表）+ Plex 串行；2500ms 软预算只在请求之间检查，挡不住在途请求（见上文「返回值契约」）。`late` 持续增长说明库响应太慢：库很大时建议只启用一个后端，或加大 `cache_ttl_sec` 让更多查询走缓存。
- **缓存存副本事实列表，不存结论**：缓存 key 为 `lib_cache_<type>_<tmdb_id>_s<季>_e<集>`，value 为该集所有副本的属性列表。命中后按**当前 flow 维度+操作符与种子 tags 现场比对**，同一集可被不同 flow 判出不同结果。外部故障路径**不写缓存**，避免把「暂时查不到」固化。**合集批量路径与单集路径共享同一份 per-episode 缓存**——单集查过的集在合集里直接命中，反过来也一样。
- **缓存会自己清理，不会撑满配置配额**（需要 FollowCat 提供 `config.delete`；更早的宿主上不清理，同 0.3.x）：每次写缓存前先删掉过期的缓存键（按 `cache_ttl_sec`），缓存键总数超过 **300** 就从最旧的删起——给计数器、per-flow 配置留足宿主每插件 500 个键的配额。插件启动时也清一遍；**从 0.3.x 升级后第一次启动会把旧版本留下的缓存键全部删掉**（旧版不清理，可能早已把配额写满，导致计数器和配置都写不进去），并写一个标记键 `cache_gen`（请勿删除，删了下次启动会再整批清一次缓存）。
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
| `cache_write_fail` 增长 | config 配额不足 | 缓存最多 300 个键，配额仍满说明别的键太多（per-flow 配置等），或宿主太旧没有 `config.delete`（不清理缓存）：升级 FollowCat，或在管理页删掉旧的 `lib_cache_*` 键 |
| 用了 `>=` 但仍不匹配 | `>=` 仅限 `resolution` 和 `code_bits` | 其他维度不支持 `>=`，用 `==` 或 `regex` |
| dry_run 模式下无否决日志 | 查库未命中或维度不匹配 | 用 `/check` API 逐步排查；dry_run 只改变最终返回值，不改变匹配逻辑 |

## 与主仓关系

- **`should_download` hook**：由主仓提供（v3.5+），本插件注册。宿主在推种前同步调用，读取返回值。
- **`ruleflow.list()` API**：需 `api.ruleflow.read` 权限，用于 UI 列出所有 flow 以便逐条配置。
- **通知功能**：自 v3.5 起请走主仓 `internal/notify`（钉钉 / 飞书等），本插件不再涉及通知。

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
