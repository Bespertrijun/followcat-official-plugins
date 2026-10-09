# Plugin Dev Runtime

本地调试 followcat 插件的轻量宿主，无需启动完整 FollowCat 服务即可：

- 在 Node 沙箱里跑插件 `index.js`，注入与宿主一致的 `plugin / log / config / data / crypto / http / anime / task / ruleflow / ptsite / douban / notify` 全局与定时器（没有 `console`；`eval` / `Function` 为 `undefined`）
- 模拟触发任意 hook（自带每个 hook 的示例 payload），包括模拟 Telegram 里点动作按钮（`on_notify_action`）和发 bot 命令（`on_bot_command`），回显用户会看到的结果
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

# notify.send 模拟「一个通道都没配」（resolve channels: 0）；默认 1
DEVRT_NOTIFY_CHANNELS=0 python devrt/server.py cookiecloud
```

`--persist` 文件格式：`{"version": 2, "entries": {"<key>": {"value", "is_secret", "updated_at"}}}`
（明文存储，不加密）。旧版本写下的扁平 `{"<key>": "<value>"}` 仍能读，全部当普通项；下次保存时改写成新格式。

## 浏览器界面

打开 `http://127.0.0.1:9000`：

| 区域 | 说明 |
|------|------|
| Header | 插件名 / 版本 / http 模式 / 加载状态 |
| Hooks | 每个已注册 hook 一个按钮，点击直接用示例 payload 触发；也可以展开 "编辑 payload" 用自定义 JSON。示例 payload 按宿主真实形态（`anime_id` / `task_id` 是数字、`media_id` 是字符串、`aka` 是数组、`tags.hdr` / `tags.dv` 是字符串，没识别到是 `"无"`；sdk.md 里标 `?` 的字段也恒在，没值时是零值）。`should_download` 触发后回显宿主会得出的裁决（按**导出后的值**算，同生产）：`allow` / `veto` / `have_bitmap`，超时、抛错或返回值导不出来时标 `fail_open`。`on_notify_action` / `on_bot_command` 见下文「模拟点击与命令」 |
| Plugin APIs | 列出所有 `plugin.registerAPI` 的端点，点击立即调用 |
| Config | 当前 mock 配置（明文，secret 项标 `secret`）；「保存配置」只提交改过的键和新增项（没动的键不回写，不会把插件后端同时 `config.set` 的值冲回旧值）；`×` 走显式删除接口，立即生效；新增项可勾选标记为 secret |
| Stage | iframe 加载 manifest `ui.entry`（缺省 `ui/index.html`），`sandbox="allow-scripts"`、src 带 `?fcSlot=plugin.settings`；高度由 `FC.resize` 决定（初始 400，clamp 200–1500） |
| Logs | SSE 实时流，`log.info / warn / error` 均会在此显示 |

## 模拟点击与命令（`on_notify_action` / `on_bot_command`）

devrt 没有 Telegram：触发这两个 hook 就是「假装用户点了按钮 / 发了命令」，payload 由你给，devrt 按宿主的规则（`internal/notify/actions.go` / `commands.go`）算出用户会看到什么，显示在提示里，完整结果同时打进日志面板（`[devrt] on_notify_action → {...}`）。示例 payload 是一个绑定了 Telegram 的管理员，`action` / `command` 取 manifest 里声明的第一个。

- **点按钮**（payload `{action, data, user: {username, role, permissions}, channel}`）：`action` 不在 `manifest.actions` 里 → `✗ 失败：插件不可用`（插件不被调用）；`user` 不满足这个动作的 `requires`（为空时 `role` 要是 `"admin"`）→ 提示「没有权限」、没有结果行；否则调用插件（10 秒墙钟），返回字符串 / `{text}` → `✓ <文字>`（换行折成空格、最多 200 字），其余 → `✓ 已处理`；throw / reject → `✗ 失败：插件出错`；10 秒没结果 → `✗ 失败：插件没有响应`。回显字段：`answer`（点按钮时的提示）、`line`（各副本末尾追加的结果行，没处理时为 `null`）、`called`（插件代码是否被调用）、`result`（插件返回值）、`error`（devrt 给出的具体原因，生产只进宿主日志）。
- **发命令**（payload `{command（短名）, args, user, chat: {id, type}}`）：`chat.type` 不是 `"private"` → 不理（`ignored: true`）；短名不在 `manifest.commands` 里 →「不认识这个命令，发 /help 看看能用什么」；权限不够 →「没有权限」；否则调用插件：字符串 → 按纯文字回（`reply.text` 是原文，`reply.body` 是转义后的 FC-Markdown），`{body, buttons}` → 按 `notify.send` 的正文 / 按钮规则校验（动作按钮也要在 `manifest.actions` 里），不合规 →「插件出错」（`error` 里有具体原因）；空 →「已处理」。回复带 `🧩 [插件名]` 前缀（`reply.prefix`）。
- 不模拟：绑定（假定点的人已绑定）、按钮 token 与消息副本的核对、「一条通知只处理一次」与 7 天过期、插件正忙。

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
                         │  DELETE /api/config/<key> │
                         │  DELETE /api/sandbox/config/<key> ←桥 │
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
  调用的 `frontend/src/api/plugins.ts` 里的 `sandboxApiCall` / `sandboxGetConfig` / `sandboxPutConfig` /
  `sandboxDeleteConfig`，以及 `frontend/src/utils/pluginBridge.ts`）。主仓改宿主桥时要同步改这里：
  - 消息 `{id, type, payload}`，类型 `fc.init` / `api.call` / `config.get` / `config.put` / `config.delete` /
    `host.notify` / `host.resize`；回复 `{id, result}` 或 `{id, error: {message}}`；按 `event.source === iframe.contentWindow`
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
  - `config.delete`（`FC.config.delete(key)`）→ `DELETE /api/sandbox/config/<key>`，回 `{deleted: bool}`（是否真的删到；
    没设过 → `false`，不报错）。非字符串 / 空串、`.` / `..` 在桥上直接报错、不发请求（后两者作为 URL 路径段会被浏览器
    规范化掉）；其余键规则同 `config.put`（不合法 → 400，文案透传）。删掉后侧栏配置、插件后端都看不到这个键。
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
| `http.*` | 返回 Promise（同生产）；默认 mock；`--allow-http` 后用 Node fetch，每请求 10s、5 MiB 截断、60 req/min 令牌桶、失败 reject `GoError`（`http <METHOD> <url>: ...`）；headers 在调用时复制、响应是插件自己的普通对象（同生产）；**无 SSRF 守卫**（本机回环也能连，方便对着本地假服务调试）、重定向不限 3 次 | 返回 Promise；60 req/min 令牌桶 + 5 MiB 上限 + 每请求 10s + 最多 3 次重定向 + SSRF 守卫（放行局域网与 `100.64.0.0/10`，但单独拦 `100.100.100.200`；拦本机回环 / 链路本地） |
| 全局对象 | 同生产：没有 `console` / `require`；`eval`、`Function` 为 `undefined`，且 vm 层关掉了字符串造代码（`(function(){}).constructor("...")` 也会抛 `EvalError`） | 没有 `console` / `require`；`eval`、`Function` 为 `undefined` |
| `log.*` | 贴近生产：每个参数按宿主 `fmt.Sprint`（goja 导出后的 Go 值）的样子转文本再用空格拼——对象 `map[a:1 b:x]`（键排序）、数组 `[1 2]`、`null` / `undefined` → `<nil>`、`Error` → `map[]`、非整数按 Go 浮点写法（`1.234567895e+08`）、`Infinity` → `+Inf`；消息里的 `\r` / `\n` 转义成字面，一次调用一行。函数打成 `0x0`（生产是 Go 函数指针地址）、`Date` 的时区缩写可能与 Go 不同 | `fmt.Sprint`；换行转义同左 |
| 内置 `JSON` | 同生产（R1）：`JSON.parse` 输入嵌套超过 1000 层、`JSON.stringify` 嵌套超过 1000 层或超过 100 万个值 → 抛 `TypeError`（文案同生产）；正常输入与原生逐字节一致（`reviver` / `replacer` 函数或属性数组 / `space` / `toJSON` 不变）。**不做**生产第三轮 T3 的属性名数组长度上限：超长（如稀疏的 `length = 2^32-1`）数组 replacer 在 devrt 里按 JS 逐项读，由 10s 求值超时兜底 | 同左；另外属性名数组 replacer 的 `length` 超过 100 万直接抛 `TypeError: JSON.stringify: replacer array longer than 1000000` |
| 正则回溯 | Node（V8 irregexp）没有单次匹配超时：灾难性回溯的正则按所在求值的 **10s 超时**打断（该次调用以超时 / 打断结束），**不会**像生产那样 5 秒后当「未匹配」返回 | 单次匹配 5 秒上限（regexp2 `MatchTimeout`，只影响带反向引用 / 环视等走回溯引擎的正则），超时按**未匹配**处理（`test` → `false`、`exec` / `match` → `null`，不抛错） |
| 宿主 → 插件数据的上限 | devrt 在 Node 宿主 realm 里做 JSON 往返，插件改写自己 realm 的 `Object.prototype.toJSON` 影响不到它 | 转换套与出站相同的上限（1000 层 / 100 万个值）：插件改写全局原型导致超限时该次调用报错（`convert host value for plugin: ...`） |
| 停用卡住 / 放弃引擎 | 没有这层（停用 = 结束沙箱进程） | 停用最多等 5s，卡在打断不了的操作里就放弃旧引擎；旧引擎真正退出之前再次启用被拒（「该插件上次的运行还没退出（卡在无法打断的操作里），请重启 FollowCat 后再启用」），被放弃的引擎也写不了 `config` / `data` |
| 安装中途被杀后的核对 | 没有安装流程 | 启动时恢复换目录中途的孤儿备份、删残留暂存目录；插件目录 manifest 与数据库记录（版本 / 权限）不一致 → 不启用，提示「插件文件与记录不一致，请重新安装后再启用」（只在 FollowCat 启动时核对，手动启用不核对） |
| 交给插件的数据 | 同生产（R3）：hook / `should_download` payload、registerAPI 的 `req`、facade 的结构化返回（`ptsite.*` / `douban.getCookie` / `task.*` / `anime.get` / `ruleflow.list` / `http.*` 响应）都是插件 realm 里的普通对象，每次一份新的，可增删字段（`"use strict"` 下也行） | 同左 |
| `data.*` | 内存 blob（进程退出即丢，`--persist` 不管它）；`get` 回字节数组（`Array.isArray` 为真，不是 `ArrayBuffer`），`put` 收得回这个数组（同生产，它在宿主上仍是 Go `[]byte`），但不收自己写的数组字面量（同生产，报 `got []interface {}`；其它类型也报生产的 Go 类型名）；`put` 的名字按 `String(v)` 转（`undefined` → `"undefined"`，同生产）；名字校验、4 MiB / 16 MiB 配额与生产文案一致（可用 `DEVRT_BLOB_MAX_BYTES` / `DEVRT_BLOB_MAX_TOTAL` 调） | SQLite / Postgres + AES-256-GCM；配额 admin 可调 |
| 配置存储 | 内存 / `--persist` 明文 JSON（记录 `is_secret` 与 `updated_at`） | SQLite + AES-256-GCM 加密；`is_secret` 只控制回读脱敏 |
| `config.set` / `config.delete` | 同生产：`set` 的非字符串按 goja 规则转字符串（`null` / `undefined` → `""`、`5` → `"5"`）；键 / 值校验与每插件 500 条配额（新 key 才计）同生产文案（可用 `DEVRT_CONFIG_MAX_KEYS` 调）；配额只管插件后端的 `config.set`，侧栏与 iframe 桥写入不查。`delete` 同步、返回是否删到、键校验同 `set`，删掉的键侧栏同步消失 | 每插件条数有上限（可在设置里调），超出写入失败；`delete` 释放配额行 |
| manifest | 权限 / hooks 按生产白名单校验，未知项 → 加载失败（Header 显示 `load error`），入口脚本不跑；`actions` / `commands` 按生产 `manifest.go` 校验（命名、重复、长度、`requires` 是 FC 权限、需要 `api.notify.send` 与对应 hook、数量上限、字段类型），报错文案同生产（由主仓实跑生成的 62 条样例比对）。字段名按原样匹配（生产的 JSON 解码不分大小写，`"Actions"` 也认），类型检查只覆盖 `actions` / `commands` 两个字段 | 解析失败，装不上 / 启用失败 |
| iframe 桥传输层 | 走本地 `/api/sandbox/*`，无鉴权；UI 从 `/plugin-ui/<file>` 加载 | 走 `/api/plugins/<id>/sandbox/*`，pluginToken 鉴权（过期 401 → 宿主换 token）；UI 从 `/api/plugins/<id>/ui/<token>/<file>` 加载 |
| 插件报错文案 | 同步 throw 回 `Error: boom`（去掉 Node 栈，完整栈进日志面板）；超时是 `plugin runtime: execution timeout`（没有 `Error: ` 前缀），iframe 桥上回 **504**；返回值导不出来是 `plugin return value is not JSON-serializable: ...`（同生产）。devrt 没有「宿主内部错误」这一类（没有数据库 / 宿主 panic） | 同步 throw 是 goja 的 `Error: boom at <位置>`；async reject 两边都是 `Error: boom`；registerAPI 超时 504（`plugin runtime: execution timeout`，事件循环被占住没轮上时是 11s 兜底的 `plugin api: execution timeout`）；宿主自己的内部错误（数据库 / 存储、宿主 Go panic）在插件页只显示「宿主内部错误」 |
| `config.put` 参数类型错误的文案 | 仿 Go `encoding/json` 的 `json: cannot unmarshal ...`，措辞可能与生产不逐字相同 | gin `ShouldBindJSON` 的原始错误 |
| `FC.api` 传二进制（Blob / ArrayBuffer） | 原样发送，行为接近生产 axios，未逐项核对 | axios 默认序列化 |
| 插件 UI 可见性 | 有 `ui/` 目录就加载（不看 manifest 有没有 `ui` 声明） | 只有 manifest 声明了 `ui` 的插件才在插件详情页（admin）显示 |
| 侧栏 Config / Plugin APIs | 开发用：明文显示、直接调用（不经 iframe 桥） | 管理页配置表 secret 只显示「已设置」 |
| panic 计数 / 自动 disable | 不做 | hook 与定时器回调里 1 分钟 5 次宿主 Go panic 自动 disable（registerAPI / `should_download` 里的只让那次调用失败，不计数；插件 JS 错误永远不算 panic） |
| 定时器 | Node 原生 `setTimeout` / `setInterval` / `setImmediate`，句柄是 Node 的 `Timeout` / `Immediate` 对象；回调抛错 / 返回的 Promise reject 只在日志面板记一条 warn（`<kind> callback error: ...`）；任何没人接的 Promise reject 也只记 warn，不让沙箱进程退出；**回调同步段超过 10s 会被打断**（devrt 专有保护，见下行） | 宿主包装版，句柄是数字；回调报错记 WARN + `last_error_msg`，JS 报错不计 panic、宿主 Go panic 计入自动停用；没人接的 reject（不是定时器回调直接返回的那个）不记；回调不计墙钟、不打断；停用 / 卸载 / 升级时全部清除 |
| `await` 之后的续体 | vm 以 `microtaskMode: "afterEvaluate"` 运行：续体（与定时器回调）都在带超时的求值里跑，写出死循环时 **10s 后被打断**（日志面板记一条 `[devrt] ... interrupted`，可用 `DEVRT_CONTINUATION_GUARD_MS` 调），devrt 不会卡死；该次调用随后按墙钟超时结束 | **不看管**：续体 / 定时器回调里的死循环会让整个插件卡住，只能停用 |
| 入口脚本 | 同步段 10s 超时 → 加载失败（`load error`：`run entry script: entry script exceeded 10s (interrupted)`，文案同生产）；入口脚本排的 `setImmediate` 等在它之后才跑，不算进这 10s | 10s 看门狗（含入口脚本执行期间触发的定时器回调、微任务）→ 启用失败，`run entry script: entry script exceeded 10s (interrupted)` 进日志与 `last_error_msg`；入口期宿主 Go panic 也只算启用失败（`run entry script: host panic: ...`）；数据库「已启用」标记不变，FollowCat 与其它插件照常起来 |
| 返回值 / payload | 返回值按 JSON 导出成普通值（带环、`BigInt`、超过 1000 层 / 100 万个值 → 普通错误，文案同生产）；`should_download` 按导出后的值裁决；hook payload 每次触发由 server.py 重新发一份 | 同左（在循环线程上导出；每个插件拿自己的一份 payload） |
| `ptsite` mock | 内存里 5 个 PT 站行（含带 / 不带 RSS、cookie / apikey / none 鉴权），`hosts` 由各行 mock RSS 链接算出；站点不能增删；只有 `setCookie`（`setAPIKey` 已随生产删除）；站点不存在时审计 target 记 `<invalid len=N>`、reject 文案不回显参数 | 真实 `site_configs`；`hosts` 由 `RssURLs` 算出 |
| `notify.send` | 有 `api.notify.send` 才注入（同生产）。参数类型不对同步抛的 `TypeError`（文本字段只收原始字符串，按钮结构直接读、不经 JSON）、内容规则的 reject 原因与检查顺序（动作按钮未声明最先查；正文文字里的裸 `协议://用户名@` 地址；长度单位是字节）、每小时配额（默认 300，可用 `DEVRT_NOTIFY_MAX_PER_HOUR` 调；`channels: 0` 与被拒的不计）都同生产文案，由主仓实跑生成的样例比对（`tests/devrt/fixtures/notify/vectors.json` 594 条、`jscases.json` 58 条）；调用返回时 Promise 已 settle（同生产）。动作按钮 `{label, action, data?}` 的 `action` 要在 fixture 自己的 `manifest.actions` 里。**不真发**：接受的消息在日志面板打一行 `[notify.send] {...}`（带 `🧩 [插件名]` 前缀与排好的按钮行，动作按钮带 `action` / `data`），resolve `{queued: true, channels: N}`，N 由 `DEVRT_NOTIFY_CHANNELS` 决定（默认 1，`0` 模拟没配通道）。不模拟队列满、图片下载与 Telegram 尺寸检查、按钮文字截断与附域名、Telegram 4096 字截短、动作按钮在 Slack / bot 不在线时被去掉。链接地址校验移植自 Go `net/url`，国际化域名用 Node 的 `domainToASCII` 近似宿主的 IDNA 转换，罕见域名的结论可能与生产不同；按钮 `data` 的字节数按 Go `encoding/json` 的写法算（键排序、U+2028 / U+2029 转义），`-0` 之类的数字写法可能差一两个字节。没人接的 reject 会在日志面板记一条 warn（devrt 通用行为，生产不记） | 借宿主已配置的 Telegram / Slack 真发；入队即 resolve；配额 admin 可调；最终发送失败计入插件详情页统计 |
| `douban.setCookie` 的 opts | 同生产：任何 JS 对象（含函数）都收，只有原始值（数字 / 字符串 / 布尔）抛 `TypeError` | 同左 |
| `crypto.base64Decode` | 同生产：忽略 `\r` / `\n`（Go `StdEncoding` 行为） | 同左 |
| 队列 / 节流 / 超时 | 无队列；墙钟超时同生产（hook 10s / API 10s / `should_download` 3s fail-open，含 `await`），同步段死循环按超时打断，async 回调 reject 等同抛错 | 64 队列、墙钟超时（含 `await`）、每插件一个事件循环 |

DevRT 用来打通整体流程（hook → log → 调 API → UI 联动），上线前请在真实 FollowCat 做一次集成验证。

## 已知限制

- 当前 DevRT 不模拟生产的任务队列（64 容量 / drop-oldest）。async 回调 `await` 期间其它触发可以并发进来（与生产一致），但高并发触发时的排队 / 丢弃行为与生产不同。
- hook 抛错 / reject 在 DevRT 里直接作为错误返回给触发方（便于调试）；生产宿主只记 WARN + `last_error`。`should_download` 例外：抛错 / reject / 超时都按生产 fail-open 放行，触发结果里标 `fail_open: true` 与原因。
- `config.put(..., is_secret=true)` 在 DevRT 里**不做加密**，只把值和 secret 标记存 JSON。生产环境的加密由宿主完成；
  回读脱敏（iframe 桥上 secret 读回 `""`）两边一致。
