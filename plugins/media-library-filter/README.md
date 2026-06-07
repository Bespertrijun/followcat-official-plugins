# media-library-filter

在主仓发出通知**前**查询 Emby / Plex 媒体库；命中即静默自定义 fan-out 通道（Telegram / 通用 webhook），库里没有再推送 —— 这样你只会被「新货」打扰，老片不重复弹通知。

**标签**：notification、filter、emby、plex、media-library、v3.5

## 适用场景

自 FollowCat v3.5 起 Slack / Telegram 业务逻辑收回主仓 `internal/notify`。主仓在每次 `channel.Send` 前后会 Publish `on_notification_before_send` / `on_notification_after_send` 两个事件（fire-and-forget）。

**本插件做什么**：

1. 监听 `on_notification_before_send`，拿到主仓即将下发的事件
2. 用 `anime.anime_title` 在 Emby / Plex 里搜索；如果库里**已经有**这部番 / 这部电影，**静默**自己的 fan-out 通道
3. 库里**没有**才通过 Telegram bot 或通用 webhook 推送 —— 你看到的是「干净的新货通知」

**本插件做不到的**：

- ❌ **取消主仓 Slack / Telegram 推送**：`on_notification_*` hook 是 fire-and-forget，插件返回值会被忽略，主仓照样会按自己的 channel 配置推送。如果你想要「全局静默已入库内容」，需要在主仓里禁用 Slack / Telegram，把本插件作为主通知通道。
- ❌ **改写主仓文本**：你只能转发或丢弃，不能编辑主仓发出去的消息。

## 安装

1. 把 `media-library-filter/manifest.json` + `index.js` 打包成 zip（zip 根直接是这两个文件，不嵌套目录）
2. 管理页 → 插件 → 上传 zip → 启用
3. 在「配置」区填写下面的 key

或本地用 DevRT 调：

```bash
pip install -r requirements.txt
python devrt/server.py media-library-filter --allow-http --persist
```

## 配置

| key | 必填 | 是否 secret | 说明 |
|-----|------|------------|------|
| `emby_enabled` | 任选一个 | 否 | `"1"` 启用 Emby 库检查 |
| `emby_url` | 启用 Emby 时必填 | 否 | Emby 根 URL，例：`http://192.168.1.10:8096` |
| `emby_api_key` | 启用 Emby 时必填 | ✅ | Emby API Key（管理后台 → 高级 → API Keys 申请） |
| `plex_enabled` | 任选一个 | 否 | `"1"` 启用 Plex 库检查 |
| `plex_url` | 启用 Plex 时必填 | 否 | Plex 根 URL，例：`http://192.168.1.10:32400` |
| `plex_token` | 启用 Plex 时必填 | ✅ | `X-Plex-Token`（Plex Web → 任一项目 → ⋯ → Get Info → View XML 链接里的 token 参数） |
| `webhook_channel` | 是 | 否 | fan-out 通道：`telegram`（默认）或 `generic` |
| `telegram_bot_token` | 选 telegram 时必填 | ✅ | Telegram Bot token |
| `telegram_chat_id` | 选 telegram 时必填 | 否 | 目标 chat id（私聊 / 群组 / 频道） |
| `generic_webhook_url` | 选 generic 时必填 | ✅ | 接收端 webhook；本插件会 POST JSON `{event_type, channel, text, anime_id, anime_title, episode}` |
| `cache_ttl_sec` | 否 | 否 | 库查询结果缓存秒数，默认 `3600`。设为 `0` 关闭缓存（不推荐） |
| `dry_run` | 否 | 否 | `"1"` 仅日志记录决策，不真正调外部 webhook（验证用） |
| `match_strict` | 否 | 否 | `"1"` 严格匹配（trim+lower 后等值）；默认 `0` 大小写不敏感子串匹配 |
| `suppress_event_types` | 否 | 否 | 逗号分隔的 event_type 白名单，列出的 event 一律静默，例：`on_episode_found` |

> Emby 与 Plex 至少配置一个；两者都没配时本插件退化为「无库过滤的 fan-out」（不推荐，等价于额外多一个 Telegram channel）。

## 工作流程

```
on_notification_before_send  (主仓即将发某条通知)
       │
       ▼
   dedupe 5 s 内 event_type|anime_id|episode  ── 二次/N次入口直接 return
       │
       ▼
   forced suppress？(suppress_event_types) ── 命中 → return
       │
       ▼
   Emby / Plex 缓存 hit？(cache_ttl_sec)
       │ yes → 用缓存结果
       │ no  → 调 Emby /emby/Items；fallback Plex /hubs/search
       │       结果（命中或未命中）写回缓存
       ▼
   库里有？
       │ yes → suppressed_in_library++；log "suppress (lib=emby tmdb=12345)"；return
       │ no  → fanout(text, data)   （Telegram sendMessage 或 generic POST）
```

## 匹配策略

1. 用 `data.anime_title` 在 Emby（`/emby/Items?SearchTerm=...&IncludeItemTypes=Movie,Series,Episode&Fields=ProviderIds,ProductionYear`）搜
2. 拿到 `Items` 数组，按 `match_strict` 模式比对 `Name`
3. 命中后从 `ProviderIds.{Tmdb,Imdb}` 提取外部 ID 一起记录到缓存（便于 trace）
4. Emby 未命中或未启用 → 走 Plex `/hubs/search`，从 `Hub[].Metadata[].Guid` 里提 tmdb/imdb 协议头

> SDK 在 hook payload 里**不暴露** tmdb_id / imdb_id，所以我们只能用 title 当 query 输入；Emby/Plex 返回的 ProviderIds 是「事后 trace」用的标识，不参与 query 本身。

## 自定义 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins/<id>/api/stats` | 配置摘要 + 计数器 + 各通道 last_error |
| GET  | `/api/plugins/<id>/api/check?anime_id=42`（或 `?title=xxx`） | 单次库检查 trace，不写缓存 |
| POST | `/api/plugins/<id>/api/clear-cache` | 清空 `lib_cache_*` 全部条目 |
| POST | `/api/plugins/<id>/api/test-emby?title=进击的巨人` | 用当前配置探测 Emby（无 title 则探活 `/System/Info/Public`） |
| POST | `/api/plugins/<id>/api/test-plex?title=进击的巨人` | 同上 Plex（无 title 则探活 `/identity`） |
| POST | `/api/plugins/<id>/api/test-fanout?text=...` | 按当前配置发一条测试 fan-out（绕过库检查） |
| POST | `/api/plugins/<id>/api/save-config` | 批量保存配置；body 是 JSON object，仅接受白名单 key |

## 计数器解释

| key | 含义 |
|-----|------|
| `before_send_seen` | 进入 `on_notification_before_send` 的总次数（含 dedupe 跳过的） |
| `deduped` | 因 5 s 窗口去重被跳过的次数（主仓启用了多 channel 时几乎一半都会落这里） |
| `suppressed_in_library` | 库检查命中、自家 fan-out 被静默的次数 |
| `suppressed_by_event_filter` | `suppress_event_types` 命中静默次数 |
| `fanout_sent` | 实际发往 Telegram / generic webhook 成功的次数 |
| `fanout_failed` | fan-out 失败次数（含 4xx / 5xx / 网络异常） |
| `fanout_skipped_misconfig` | 通道选了但缺凭据被跳过的次数 |
| `dry_run_would_send` | `dry_run=1` 下被记录的「本来会发」的次数 |
| `upstream_<channel>_ok` / `upstream_<channel>_fail` | `on_notification_after_send` 中统计的主仓各通道成败 |

## 注意事项

- **hook 预算 10 s**：Emby + Plex 串行调用 + fan-out 网络可能逼近上限；插件自带 4 s 软预算来 fail-fast，超时 fail-open（按未命中处理，宁可多推一条）
- **HTTP rate limit 60/min**：主仓主动 dedupe + 本插件 5 s 去重 + 1 小时缓存基本可以避免；如果你触发频率极高（百集番组同时入库），考虑放大 `cache_ttl_sec` 或开 `match_strict` 减少跨集误命中
- **匹配错杀**：title 子串模式下「凉宫春日的忧郁」与「凉宫春日」会算同一作品（这是想要的行为）；如果你的库里有「鬼灭之刃」和「鬼灭之刃 游郭篇」两个独立条目，子串模式可能误命中老条目 → 用 `match_strict=1` 收紧
- **fail-open 哲学**：Emby / Plex 不可达时一律按「库里没有」处理，宁可多推一条也不漏推；查 `emby_last_error` / `plex_last_error` 跟踪连续故障
- **缓存写回限额**：`config.*` 上限 500 keys；本插件以 `lib_cache_<anime_id>` 占用每个被检查过的番剧一个 key。需要扫的番剧 > 500 时 ⇒ /clear-cache 或加 admin 配额

## 排错对照

| 现象 | 可能原因 | 修法 |
|------|---------|------|
| 一条事件都没看到（计数全 0） | 主仓 internal/notify 没启用 / channel 全关 | 在管理页主通知设置里至少配置一个 channel，注意主仓事件才会经过这两条 hook |
| `suppressed_in_library` 总是 0 | 标题模糊匹配未命中 / Emby/Plex 没收录这部 | 用 `/check?title=...` 看搜索结果；考虑去掉 `match_strict` |
| `fanout_failed` 持续递增 | telegram_bot_token 错 / chat 不存在 / 内网 webhook 不通 | 看 `telegram_last_error` 或 `webhook_last_error`；用 `/test-fanout` 复现 |
| Emby 库经常错过 | Emby 默认搜索按拼音 / 别名匹配较松 | 试试 `match_strict=1`；或确认 Emby 里条目名是中文/原名一致 |
| Plex 探活 200 但 `/hubs/search` 返回 401 | 部分 Plex 版本 token 必须放 URL 参数（我们就是这么做的）；某些代理会丢 | 直接 curl 复现，看是不是反代过滤了 `X-Plex-Token` |

## 与主仓 `internal/notify` 的关系

| 维度 | 主仓 internal/notify | 本插件 |
|------|---------------------|--------|
| 触发源 | RSS / qBit / linker → 主仓 channel.Send | 主仓 channel.Send 前的 hook |
| 是否可 veto | 不适用 | ❌ 不能 veto 主仓自身 channel |
| 过滤策略 | 无库过滤；通道路由 + 节流 | Emby / Plex 库存在性过滤 |
| 通道扩展 | 编译期注册 | 改 `index.js`（钉钉/飞书/企微/Bark 都可以加） |

主仓负责把消息「能发出去」，本插件负责把消息「该不该发到我手机上」—— 各司其职。
