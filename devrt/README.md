# Plugin Dev Runtime

本地调试 followcat 插件的轻量宿主，无需启动完整 FollowCat 服务即可：

- 在 Node 沙箱里跑插件 `index.js`，注入 goja-兼容的 `plugin / log / config / http / anime / task` 全局
- 模拟触发任意 hook（自带每个 hook 的示例 payload）
- 调用插件通过 `plugin.registerAPI` 注册的端点
- 在 iframe 里加载 `<plugin>/ui/`，提供完整的 `FC.*` postMessage SDK
- 编辑 mock 配置（含 secret 字段）
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

## 浏览器界面

打开 `http://127.0.0.1:9000`：

| 区域 | 说明 |
|------|------|
| Header | 插件名 / 版本 / http 模式 / 加载状态 |
| Hooks | 每个已注册 hook 一个按钮，点击直接用示例 payload 触发；也可以展开 "编辑 payload" 用自定义 JSON |
| Plugin APIs | 列出所有 `plugin.registerAPI` 的端点，点击立即调用 |
| Config | 当前 mock 配置；可增删改；可手动保存 |
| Stage | 居中的 iframe，加载 `<plugin>/ui/index.html`；`FC.*` SDK 经 postMessage 经由本地 server 与 sandbox 互通 |
| Logs | SSE 实时流，`log.info / warn / error` 均会在此显示 |

## 架构

```
                        +--------------------+
   浏览器               |  host.html (parent)|
   ┌────────────┐       |  - 控制台 + 日志    |
   │ FC.api()   │ ◀──▶  |  - postMessage 桥  |
   │ FC.config  │       +────────┬───────────+
   └────────────┘                │ fetch
        ▲                        ▼
        │ postMessage    +────────────────────+
        │                │ FastAPI server.py  │
   ┌────────────┐        │  /api/state        │
   │ ui/*.html  │        │  /api/trigger      │
   │ /plugin-sdk.js │    │  /api/call-api     │
   └────────────┘        │  /api/config       │
                         │  /api/logs/stream  │
                         +─────────┬──────────+
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

## 与生产宿主的差异

| 维度 | DevRT | FollowCat 主服务 |
|------|-------|------------------|
| JS 引擎 | Node `vm` 模块 | goja（Go） |
| `http.*` | 返回 Promise（同生产）；默认 mock；`--allow-http` 后用 Node fetch，每请求 10s、5 MiB 截断、60 req/min 令牌桶、失败 reject `GoError`（`http <METHOD> <url>: ...`）；无 SSRF 守卫、重定向不限 3 次 | 返回 Promise；60 req/min 令牌桶 + 5 MiB 上限 + 每请求 10s + 最多 3 次重定向 + SSRF 守卫 |
| `config.set` | 内存 / 持久化 JSON | SQLite + AES-256-GCM 加密（is_secret） |
| iframe 安全 | `sandbox="allow-scripts allow-forms"`（同生产） | 同 + CSP `connect-src 'none'` |
| panic 计数 / 自动 disable | 不做 | 1 分钟 5 次 panic 自动 disable |
| 队列 / 节流 / 超时 | 无队列；墙钟超时同生产（hook 10s / API 10s / `should_download` 3s fail-open，含 `await`），同步段死循环按超时打断，async 回调 reject 等同抛错 | 64 队列、墙钟超时（含 `await`）、每插件一个事件循环 |

DevRT 用来打通整体流程（hook → log → 调 API → UI 联动），上线前请在真实 FollowCat 做一次集成验证。

## 已知限制

- 当前 DevRT 不模拟生产的任务队列（64 容量 / drop-oldest）。async 回调 `await` 期间其它触发可以并发进来（与生产一致），但高并发触发时的排队 / 丢弃行为与生产不同。
- hook 抛错 / reject 在 DevRT 里直接作为错误返回给触发方（便于调试）；生产宿主只记 WARN + `last_error`。
- `config.put(..., is_secret=true)` 在 DevRT 里**不做加密**，只把值存 JSON。生产环境的加密由宿主完成。
