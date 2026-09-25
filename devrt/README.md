# Plugin Dev Runtime

本地调试 followcat 插件的轻量宿主，无需启动完整 FollowCat 服务即可：

- 在 Node 沙箱里跑插件 `index.js`，注入 goja-兼容的 `plugin / log / config / http / anime / task` 全局
- 模拟触发任意 hook（自带每个 hook 的示例 payload）
- 调用插件通过 `plugin.registerAPI` 注册的端点
- 在 iframe 里加载 `<plugin>/ui/`，`FC.*` SDK 与宿主桥和生产行为一致（见下文「iframe 桥」）
- 编辑 mock 配置（含 secret 标记）
- 实时观察 `log.*` 输出

参考实现：[drivecat-official-plugins/devrt](https://github.com/Bespertrijun/drivecat-official-plugins/tree/main/devrt)，
本仓库做了 JS 沙箱（goja 兼容）与 followcat 宿主 API 的适配。

## 依赖

- Python 3.10+ — `pip install -r ../requirements.txt`
- Node 18+ — 用于跑插件 JS（自动调用 `node`）

## 运行

```bash
# 在仓库根目录
python devrt/server.py media-library-filter
# → http://127.0.0.1:9000

python devrt/server.py cookiecloud --port 9100
python devrt/server.py dashboard-stats        # headless 插件也能跑（无 UI）

# 真实出网调用 Emby / Plex / Telegram（默认 mock）
python devrt/server.py media-library-filter --allow-http

# 把 mock config 持久化到 devrt/data/<plugin>/config.json
python devrt/server.py cookiecloud --persist
```

`--persist` 文件格式：`{"version": 2, "entries": {"<key>": {"value", "is_secret", "updated_at"}}}`
（明文存储，不加密）。旧版本写下的扁平 `{"<key>": "<value>"}` 仍能读，全部当普通项；下次保存时改写成新格式。

## 浏览器界面

打开 `http://127.0.0.1:9000`：

| 区域 | 说明 |
|------|------|
| Header | 插件名 / 版本 / http 模式 / 加载状态 |
| Hooks | 每个已注册 hook 一个按钮，点击直接用示例 payload 触发；也可以展开 "编辑 payload" 用自定义 JSON |
| Plugin APIs | 列出所有 `plugin.registerAPI` 的端点，点击立即调用 |
| Config | 当前 mock 配置（明文，secret 项标 `secret`）；可增删改；可手动保存；新增项可勾选标记为 secret |
| Stage | iframe 加载 manifest `ui.entry`（缺省 `ui/index.html`），`sandbox="allow-scripts"`、src 带 `?fcSlot=plugin.settings`；高度由 `FC.resize` 决定（初始 400，clamp 200–1500） |
| Logs | SSE 实时流，`log.info / warn / error` 均会在此显示 |

## 架构

```
                        +--------------------+
   浏览器               |  host.html (parent)|
   ┌────────────┐       |  - 控制台 + 日志    |
   │ FC.api()   │ ◀──▶  |  - postMessage 桥  |
   │ FC.config  │       |   (复刻生产宿主)    |
   └────────────┘       +────────┬───────────+
        ▲                        │ fetch
        │ postMessage            ▼
        │                +──────────────────────+
   ┌────────────┐        │ FastAPI server.py    │
   │ ui/*.html  │        │  /plugin-ui/* (+CSP) │
   │ /plugin-sdk.js │    │  /api/sandbox/*  ←桥 │
   └────────────┘        │  /api/state          │
                         │  /api/trigger        │
                         │  /api/call-api ←侧栏 │
                         │  /api/config   ←侧栏 │
                         │  /api/logs/stream    │
                         +─────────┬────────────+
                                   │ stdin/stdout JSON-RPC
                                   ▼
                         +────────────────────+
                         │ Node sandbox.js    │
                         │  vm.runInContext   │
                         │  plugin.on(...)    │
                         │  plugin.registerAPI│
                         │  log/config/http   │
                         │  anime/task mocks  │
                         +────────────────────+
```

## iframe 桥（与生产一致）

插件 UI 这一侧以 FollowCat 主仓为准，逐项复刻：

- **`/plugin-sdk.js` 是主仓 `internal/api/sdk/plugin-sdk.js` 的逐字节拷贝**（不加任何头注释，可直接
  `cmp`）。主仓改了 SDK，这里要同步重新拷贝：

  ```bash
  cp ../FollowCat/internal/api/sdk/plugin-sdk.js devrt/plugin-sdk.js
  cmp ../FollowCat/internal/api/sdk/plugin-sdk.js devrt/plugin-sdk.js   # 无输出 = 一致
  ```

- **`host.html` 的 postMessage 桥照主仓 `frontend/src/components/PluginIframeHost.vue` 复刻**（连同它
  调用的 `frontend/src/api/plugins.ts` 里的 `sandboxApiCall` / `sandboxGetConfig` / `sandboxPutConfig`，
  以及 `frontend/src/utils/pluginBridge.ts`）。主仓改宿主桥时要同步改这里：
  - 消息 `{id, type, payload}`，类型 `fc.init` / `api.call` / `config.get` / `config.put` / `host.notify` /
    `host.resize`；回复 `{id, result}` 或 `{id, error: {message}}`；按 `event.source === iframe.contentWindow`
    校验身份；未知类型回 `unknown message type: <type>`。
  - `fc.init` → `{pluginId, slot}`，slot 恒为 `"plugin.settings"`；没有宿主主动推送的消息。
  - `api.call`：`body` 为 `undefined` → GET、`req.body` 为 `""`；否则 POST：对象/数组 JSON 序列化，字符串原样，
    `null` / `""` / `0` / `false` 不发请求体（`req.body` 为 `""`），其它原始值转字符串。path 里的 `?a=1`
    进 `req.query`（每个 key 取第一个值），`?` 前面的部分是 action。失败时回后端信封里的 message
    （插件 throw / reject 的内容，如 `Error: boom`），没有才退回通用文案。
  - `config.get(key)`：设过 → 字符串（**secret 在桥上脱敏成 `""`**，普通项原样、空串也是 `""`），没设过 → `null`；
    插件后端（sandbox 里的 `config.get`）仍拿明文。不带 key → 整个列表，形如 `[{key, value?, is_secret, updated_at}]`
    （按 key 升序；secret 项与值为空串的项不带 `value`，同生产 omitempty）。
  - `config.put` → `{updated: 1}`；每次写都按传入的 `isSecret` 覆盖 secret 标记；键/值校验同生产
    （key 须匹配 `^[a-zA-Z0-9_.\-]{1,128}$` 且不是 `__proto__` / `constructor` / `prototype`，value ≤ 64 KiB）。
  - `host.notify` → level 为 `"error"` 显示错误样式，其余一律按成功；回 `{ok: true}`。
  - `host.resize` → 高度 clamp 到 200–1500（非数字按 400）并真正应用到 iframe；回 `{ok: true, applied}`。
- **iframe 只开 `sandbox="allow-scripts"`**（无 `allow-same-origin` / `allow-forms`），带 `referrerpolicy="no-referrer"`。
- **CSP 已模拟**：`/plugin-ui/*` 的响应带与主仓 `internal/api/plugin_ui_handler.go` 完全相同的
  `Content-Security-Policy`（`connect-src 'none'` 等）以及 `X-Content-Type-Options: nosniff`、
  `Cache-Control: no-store`。插件 UI 里直接 `fetch` / XHR 会像生产一样被浏览器拦下。

## 与生产宿主的差异

| 维度 | DevRT | FollowCat 主服务 |
|------|-------|------------------|
| JS 引擎 | Node `vm` 模块 | goja（Go） |
| `http.*` | 返回 Promise（同生产）；默认 mock；`--allow-http` 后用 Node fetch，每请求 10s、5 MiB 截断、60 req/min 令牌桶、失败 reject `GoError`（`http <METHOD> <url>: ...`）；无 SSRF 守卫、重定向不限 3 次 | 返回 Promise；60 req/min 令牌桶 + 5 MiB 上限 + 每请求 10s + 最多 3 次重定向 + SSRF 守卫 |
| 配置存储 | 内存 / `--persist` 明文 JSON（记录 `is_secret` 与 `updated_at`） | SQLite + AES-256-GCM 加密；`is_secret` 只控制回读脱敏 |
| 配置配额 | 不限条数 | 每插件条数有上限（可在设置里调），超出写入失败 |
| iframe 桥传输层 | 走本地 `/api/sandbox/*`，无鉴权；UI 从 `/plugin-ui/<file>` 加载 | 走 `/api/plugins/<id>/sandbox/*`，pluginToken 鉴权（过期 401 → 宿主换 token）；UI 从 `/api/plugins/<id>/ui/<token>/<file>` 加载 |
| 插件报错文案 | 同步 throw 回 `Error: boom`（去掉 Node 栈，完整栈进日志面板） | 同步 throw 是 goja 的 `Error: boom at <位置>`；async reject 两边都是 `Error: boom` |
| `config.put` 参数类型错误的文案 | 仿 Go `encoding/json` 的 `json: cannot unmarshal ...`，措辞可能与生产不逐字相同 | gin `ShouldBindJSON` 的原始错误 |
| `FC.api` 传二进制（Blob / ArrayBuffer） | 原样发送，行为接近生产 axios，未逐项核对 | axios 默认序列化 |
| 插件 UI 可见性 | 有 `ui/` 目录就加载（不看 manifest 有没有 `ui` 声明） | 只有 manifest 声明了 `ui` 的插件才在插件详情页（admin）显示 |
| 侧栏 Config / Plugin APIs | 开发用：明文显示、直接调用（不经 iframe 桥） | 管理页配置表 secret 只显示「已设置」 |
| panic 计数 / 自动 disable | 不做 | 1 分钟 5 次 panic 自动 disable |
| 队列 / 节流 / 超时 | 无队列；墙钟超时同生产（hook 10s / API 10s / `should_download` 3s fail-open，含 `await`），同步段死循环按超时打断，async 回调 reject 等同抛错 | 64 队列、墙钟超时（含 `await`）、每插件一个事件循环 |

DevRT 用来打通整体流程（hook → log → 调 API → UI 联动），上线前请在真实 FollowCat 做一次集成验证。

## 已知限制

- 当前 DevRT 不模拟生产的任务队列（64 容量 / drop-oldest）。async 回调 `await` 期间其它触发可以并发进来（与生产一致），但高并发触发时的排队 / 丢弃行为与生产不同。
- hook 抛错 / reject 在 DevRT 里直接作为错误返回给触发方（便于调试）；生产宿主只记 WARN + `last_error`。
- `config.put(..., is_secret=true)` 在 DevRT 里**不做加密**，只把值和 secret 标记存 JSON。生产环境的加密由宿主完成；
  回读脱敏（iframe 桥上 secret 读回 `""`）两边一致。
