# media-library-filter

**下载否决器**：在 ruleflow 把种子推给 qBittorrent **之前**，按 `tmdb_id + 季 + 集` 查询 Emby / Plex 媒体库；若该集已按**当前 ruleflow 配置的规格**存在于库内，则 `return false` 跳过下载（种子记 `excluded`），否则照常下载。

**标签**：should-download、download-veto、emby、plex、media-library、ruleflow、v3.5+

> ⚠️ **0.2.0 是破坏性升级**：本插件已从「通知过滤器」（`on_notification_before_send` + Telegram / webhook fan-out）彻底改写为「下载否决器」（`should_download`）。详见文末「从 0.1.0 升级」。

## 工作原理

FollowCat 主仓提供同步可否决 hook `should_download`：宿主在每次 ruleflow 推送种子到 qBittorrent **之前**同步调用它，并**读取返回值**决定是否真的下载。

1. hook 触发，拿到 `PreDownloadCheck` payload：`flow_id`、`media.{tmdb_id,tmdb_type,season,episode}`、`tags`（12 维质量标签）。
2. 按 `flow_id` 取该 ruleflow 的配置（`flow_<id>_enabled` / `flow_<id>_spec`）。flow 未启用 → 直接放行。
3. 读取 per-flow 规格（`spec`），解析为已配维度集合。spec 键缺失或 JSON 损坏 → 视为未配置 → 放行（fail-open）。
4. 按 `tmdb_id + 季 + 集` 在 Emby / Plex 里精确定位该集；取出**所有副本**的实体属性列表。
5. 逐副本与规格比对：副本在**所有已配维度**上均符合 → 算「有」→ `return false`（否决）；否则照常推。

> **电影与剧集同逻辑**：`tmdb_type=movie`（`episode=0`）走完全相同的逐副本规格比对流程。

### 返回值契约（fail-open）

| 返回 | 行为 |
|------|------|
| 显式 `false` | **跳过**下载（仅在「确认库内任意副本在所有已配维度上符合规格」时返回） |
| `true` / `undefined` / 抛错 / 超时 | **照常下载**（fail-open） |

- **硬超时 3 秒**：库查询整体预算 ≤2500ms（留裕量）；逼近预算即放行。Emby / Plex 不可达不会拖垮下载管线。
- **tmdb_id 缺失**（Mikan 源常见）→ 无法精确查库 → 放行（不做标题近似兜底，避免误杀）。
- **多插件 veto-wins**：任一插件返回 `false` 即跳过。

## 配置

配置在管理页 → 插件详情 → **设置**标签里完成（iframe UI，`ui.embed`，仅 admin 可见）。UI 调 `ruleflow.list()` 列出所有 ruleflow，逐条配置。

### 全局连接配置

| key | 必填 | 是否 secret | 说明 |
|-----|------|------------|------|
| `emby_enabled` | 任选一个 | 否 | `"1"` 启用 Emby 库检查 |
| `emby_url` | 启用 Emby 时必填 | 否 | Emby 根 URL，例：`http://192.168.1.10:8096` |
| `emby_api_key` | 启用 Emby 时必填 | ✅ | Emby API Key（管理后台 → 高级 → API Keys）；需有读取 `Path` 字段的权限 |
| `plex_enabled` | 任选一个 | 否 | `"1"` 启用 Plex 库检查 |
| `plex_url` | 启用 Plex 时必填 | 否 | Plex 根 URL，例：`http://192.168.1.10:32400` |
| `plex_token` | 启用 Plex 时必填 | ✅ | `X-Plex-Token` |
| `cache_ttl_sec` | 否 | 否 | 库查询结果缓存秒数，默认 `3600`。设 `0` 关闭缓存 |
| `dry_run` | 否 | 否 | `"1"` 仅日志记录决策、**永远 `return true`**（不真正否决，验证用） |

> Emby 与 Plex 至少配置并启用一个；都没启用时插件对所有 flow 一律放行。

### per-flow 配置（key 中的 `<id>` 来自 `ruleflow.list()` 的 `id`）

| key | 取值 | 说明 |
|-----|------|------|
| `flow_<id>_enabled` | `0` / `1` | 默认 `0`（不干预）；`"1"` 启用该 flow 的否决检查 |
| `flow_<id>_spec` | JSON 字符串 | 该 flow 的规格声明，只含**已勾选维度**的键值对；**显式 `{}`** 表示"库里有该集任意副本即否决"（即原 any 语义） |

#### 规格维度全集（12 个，均可选）

| 维度 | 可观测性 | 说明 |
|------|---------|------|
| `resolution` | **可靠** | 分辨率档位：`720p` / `1080p` / `2160p`；按档位**相等**比（库有 4K 不影响收 1080p 的 flow） |
| `hdr` | **可靠** | 是否 HDR；`true` / `false` |
| `dv` | **可靠** | 是否 Dolby Vision；`true` / `false` |
| `video_encode` | **可靠** | 视频编码，如 `"hevc"` / `"h264"` |
| `audio_encode` | **可靠** | 音频编码，如 `"eac3"` / `"aac"` |
| `code_bits` | **可靠** | 位深，如 `"10bit"` |
| `group` | **尽力** | 字幕组；按库内文件名中 `[组名]` 标签解析（如重命名入库可能识别不到） |
| `source` | **尽力** | 来源；按库内文件名关键字解析（`WEB-DL` / `BluRay` 等；重命名入库可能识别不到） |
| `format` | 几乎不可 | 格式；文件名时有时无，解析不出按不符合处理——配了基本等于该 flow 永远放行，UI 默认置灰 |
| `language` | 几乎不可 | 语言；同上 |
| `special_content` | 几乎不可 | 特殊内容标记；同上 |
| `part_alias` | 几乎不可 | 分集别名；同上 |

**说明**：
- **未配置的维度不参与判定**。
- **显式 `{}` = 库里有该集任意副本就否决**（零维度规格，退化为"有即否决"语义）。
- **spec 键缺失或 JSON 损坏 = 未配置 → 放行**（绝不因 spec 缺失/损坏走否决）。
- 可靠档维度从 Emby `MediaStreams` / Plex `Media` 直接读取实体属性。
- 尽力档维度（group / source）从库内**文件名**解析：解析不出则该副本该维度视为不符合 → 该副本不算有 → 放行（fail-open 方向）。
- 几乎不可档维度（format / language / special_content / part_alias）同样按文件名尽力解析，但大多数库文件命名中缺少这类信息，配了几乎恒为"解析不出 → 不符合 → 放行"——相当于该 flow 永远放行，**请谨慎勾选**（UI 默认置灰并要求二次确认）。

> per-flow 规格的意义：若同时用两条 ruleflow 分别收 1080p / 4K，按 `flow_id` 各配规格即可 like-for-like 比对，互不干扰。

## `should_download` 判定流程

```
should_download(p)
  │  （全程 try/catch，任何异常 → return true）
  ▼
flow_<p.flow_id>_enabled ≠ "1"（未启用 / 未配）     → return true   (flow_disabled)
  │  emby_enabled=0 且 plex_enabled=0               → return true   (no_backend)
  │  !p.media.tmdb_id                               → return true   (allowed_no_tmdb++)
  ▼
读取 flow_<p.flow_id>_spec（三态）
  │  spec 键缺失 / JSON 损坏                         → return true   (allowed_spec_unset++)
  │  spec = "{}"（显式 any）                         → 继续查库，命中任意副本即否决
  │  spec 含已配维度                                 → 继续查库，逐副本比对
  ▼
按 tmdb_id+季+集 查 Emby（命中即止）→ 否则查 Plex
  │  查询逼近 2500ms 预算 / http 故障且未命中          → return true   (allowed_error++)
  │  未命中（库里没有这一集）                           → return true   (allowed_not_in_lib++)
  ▼
命中（copies 列表非空）：
  │  逐副本检查：任意一份在所有已配维度上符合规格        → return false  (vetoed++)
  │  所有副本均不符合规格                               → return true   (allowed_spec_mismatch++)
  ▼
dry_run=1：以上 false 路径一律改成 return true（仅 log）
```

## 自定义 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins/<id>/api/flows` | `ruleflow.list()` 结果 + 每条 flow 当前配置（`enabled`、`spec`、`specState`，供 UI 枚举） |
| GET  | `/api/plugins/<id>/api/stats` | 配置摘要 + 计数器 + last_error |
| GET  | `/api/plugins/<id>/api/check?tmdb_id=1429&season=1&episode=8[&tmdb_type=tv&flow_id=...]` | 真实查库 trace（不写缓存）；带 `flow_id` 时输出 `would_decision` + 逐副本逐维比对明细（含 `height_raw`/`bucket`） |
| POST | `/api/plugins/<id>/api/check` | mock 注入验证：body `{"mock_copies":[...],"spec":{...}}`，完全绕过真实查库，直接计算 `would_decision`/`would_reason` + 逐副本 trace，用于回归验证 |
| POST | `/api/plugins/<id>/api/save-config` | 批量保存（全局键 + 动态 `flow_*` 键白名单） |
| POST | `/api/plugins/<id>/api/test-emby` | 探测 Emby 连通性（`/System/Info/Public`） |
| POST | `/api/plugins/<id>/api/test-plex` | 探测 Plex 连通性（`/identity`） |

## 计数器

| key | 含义 |
|-----|------|
| `should_download_seen` | 进入 `should_download` 的总次数 |
| `vetoed` | 否决（`return false`）次数 |
| `allowed_not_in_lib` | 库里没有这一集 → 放行 |
| `allowed_no_tmdb` | tmdb_id 缺失 → 放行 |
| `allowed_spec_mismatch` | 命中但所有副本均不符合规格 → 放行 |
| `allowed_spec_unset` | spec 键缺失或 JSON 损坏（未配置）→ 放行 |
| `allowed_error` | 异常 / 超时 / 外部故障 → fail-open 放行 |
| `cache_write_fail` | 缓存写入失败次数（config 配额超限等，可观测） |

## 注意事项

- **3s 硬超时**：Emby（series 定位 + episode 列表）+ Plex 串行；逼近 2500ms 软预算即放行。库很大时建议优先只启用一个后端。
- **缓存存副本事实列表，不存结论**：缓存 key 为 `lib_cache_<type>_<tmdb_id>_s<季>_e<集>`，value 为该集所有副本的属性列表（含各副本文件名解析出的 `group`/`source`）。命中后按**当前 flow 规格现场比对**，同一集可被不同 flow 判出不同结果。外部故障路径**不写缓存**，避免把「暂时查不到」固化。
- **HTTP rate limit 60/min**：缓存 + per-flow 默认未启用基本可控；高频入库可放大 `cache_ttl_sec`。
- **fail-open 哲学**：宁可多下一份，也不因 Emby 宕机永久漏下。查 `emby_last_error` / `plex_last_error` 跟踪连续故障。
- **Emby API Key 权限**：查询需读取 `MediaSources[].Path` 字段（用于 group/source 文件名解析），确保 API Key 具备相应读取权限。

## 从 0.1.0 升级（迁移注意）

0.2.0 是**破坏性变更**：

- **hook 换了**：`on_notification_before_send` / `on_notification_after_send` → `should_download`。本插件不再观察通知，不再做任何 fan-out。
- **权限换了**：`["hook.notify","api.http","api.anime.read"]` → `["hook.download","api.http","api.ruleflow","ui.embed"]`。升级会触发**重新授权**。
- **旧通知 / Telegram 配置全部作废**：`webhook_channel`、`telegram_bot_token`、`telegram_chat_id`、`generic_webhook_url`、`match_strict`、`suppress_event_types` 这些 key 不再被读取，可在管理页删除。
- **per-flow 配置键变更**：旧 `flow_<id>_mode` / `flow_<id>_min_resolution` / `flow_<id>_require_hdr` / `flow_<id>_require_dv` → 新 `flow_<id>_enabled` + `flow_<id>_spec`（JSON）。旧键不再被读取，可删除。
- **需要 tmdb_id**：Mikan 源等缺 tmdb_id 的种子一律放行（不再做标题近似匹配）。
- **想要通知 fan-out**：自 v3.5 起请走主仓 `internal/notify`（钉钉 / 飞书等长尾通道 PR 到主仓 channel registry），不再用本插件。
