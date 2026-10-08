# FollowCat 插件开发指南

> 面向插件作者的实战教程。读完这篇你能写出一个生产可用的通知/聚合/监控插件。
>
> SDK 速查（API 签名、字段表、限制清单）请配合 [`sdk.md`](./sdk.md) 食用，本文不重复。

---

## 0. 五分钟跑通

打开 FollowCat → 管理页 → 插件 → 上传 zip → 启用 → 触发一次下载 → 看日志。
就这么五步。下面是最小可运行 zip 的全部内容：

**`hello-world.zip`**（zip 根直接是这两个文件，不要再嵌一层目录）：

```
hello-world.zip
├── manifest.json
└── index.js
```

**`manifest.json`**：

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "source_url": "https://example.com/hello",
  "permissions": ["hook.task.read"],
  "hooks": ["on_task_completed"]
}
```

**`index.js`**：

```js
plugin.on("on_task_completed", function (data) {
  log.info("追完了：" + data.anime_title);
});
```

启用后等到某个番剧追完，插件详情页的「最近日志」会出现 `追完了：xxx`。

---

## 1. 心智模型

> **威胁模型：插件可信，只防意外。** 插件跑在 FollowCat 进程里，宿主保证的是：远端怪数据、手滑的死循环、写得不好的正则、启动时插件出错这类**意外**不会把 FollowCat 带崩（该插件启用失败、停用在有限时间内完成）；宿主**不防故意构造的攻击代码**。只安装你信任的插件。

```
                  +------------------+        plugin.on("hook", fn)
RSS / 调度器 ---> |                  | ---> 你写的 JS（goja 沙箱）
qBit / linker --->|  EventBus 同步分 |       |
                  |  发到每个插件     |       +--> await http.post("...")
                  |                  |       +--> log.info(...)
                  +------------------+       +--> config.set(...)
```

- **Hook 是只读通知**：你看到的 `data` 是宿主给**你这个插件单独复制**的一份普通 JS 对象（和 `JSON.parse` 出来的一样），改它、加字段、`delete` 字段都行（`"use strict"` 下也不报错），不影响主流程，也不影响其它插件。facade 返回的结构化结果（`task.list()`、`ptsite.list()`、`http.*` 的响应等）同样每次都是新的一份普通对象。反过来也一样：你交给宿主的返回值、传给 facade 的参数，宿主都会先复制一份——跨边界的数据一律是拷贝，没有两边同时读写同一个对象的情况。
- **每个插件一个事件循环**：你的代码仍是单线程执行（不用加锁），同步代码段之间不会并发；但 `async` 回调在 `await`（比如 `await http.get(...)`）期间，同一插件的其它 hook / API 可以先跑。每次调用有墙钟上限（hook 10s / API 10s / `should_download` 3s，**含 `await`**），超时结果被丢弃。`index.js` 顶层（入口脚本）也只有 **10 秒**：没跑完 = 这次启用失败（原因进 `last_error_msg`），不会卡住 FollowCat 启动与其它插件。
- **出网是异步的**：`http.*`、`ptsite.setCookie`、`douban.setCookie` 返回 Promise，所在函数写成 `async function` 并 `await`（见 §5）；其余 facade（`config` / `data` / `crypto` / `anime` / `task` / `ruleflow` / `ptsite` 读方法 / `douban.getCookie` / `log`）是同步的。
- **凭证不会泄漏**：`anime.get` 返回的是脱敏 view，拿不到 `Server.Password` 之类；PT 站 / 豆瓣凭据只写不读，读侧只有「已配置」+ 指纹。
- **内置 `JSON` 带保护**：`JSON.parse` / `JSON.stringify` 用起来和平常一样（输出逐字节相同，`reviver` / `replacer` / `space` / `toJSON` 照旧），只是嵌套超过 1000 层、或 stringify 超过 100 万个值时抛普通 `TypeError`，而不是拖垮宿主进程。宿主把数据转成普通对象交给你时也有同样的上限：别改写全局原型（如 `Object.prototype.toJSON`），否则宿主给你的 payload / facade 结果会转换失败（该次调用报错）。
- **正则单次匹配 5 秒上限**：带反向引用 / 环视的正则遇上长输入可能指数级回溯；超过 5 秒按**未匹配**处理（`test` → `false`、`exec` / `match` → `null`）。写正则时避免 `(a|aa)+`、`(.*)*` 这类嵌套量词，长文本先截短再匹配。
- **没有文件系统、没有 require、没有 console**（`eval` / `Function` 也是 `undefined`）：始终可用的是 `plugin` / `log` / `config` / `data` / `crypto` 与定时器（`setTimeout` / `setInterval` / `setImmediate`，见 §6.5）；`http` / `anime` / `task` / `ruleflow` / `ptsite` / `douban` / `notify` 按 manifest 权限注入（见 §2 权限表）。

---

## 2. manifest.json 字段全解

```json
{
  "name": "notify",                                // 必填，[a-z0-9-]{3,64}，全局可重复
  "version": "1.0.0",                              // 必填，semver-ish
  "source_url": "https://github.com/you/notify",   // 必填，与 name 联合派生 plugin_id
  "author": "you@example.com",                     // 可选，仅显示
  "description": "Slack/Telegram 多渠道通知",        // 可选，仅显示
  "permissions": [                                 // 必填，每条都要在白名单
    "hook.download.read", "hook.link.read", "hook.task.read", "api.http"
  ],
  "hooks": [                                       // 必填，每条都要在白名单
    "on_download_done", "on_link_done", "on_task_completed"
  ]
}
```

### `name` + `source_url` 决定 `plugin_id`

`plugin_id = sha1(source_url + "\x00" + name)[:16]`，全局唯一。

- 升级同一插件 → **保持 `name` 和 `source_url` 不变**，`plugin_id` 不变，配置不丢，自动重启 worker
- 同一份代码两路发布 → 改 `source_url` 即可作为两个独立插件并存（不同配置不同状态）

### `permissions` 与 `hooks` 必须**双校验**

权限白名单见 sdk.md，完整 hook 白名单见 sdk.md「Hook 列表」。其中 `should_download` 是**同步否决 hook**（读返回值可拦下载，需 `hook.download.write`——敏感权限，详见 sdk.md「同步否决 hook」），其余 `on_*` 都是只读通知 hook：
`on_episode_found`, `on_download_done`, `on_download_failed`, `on_link_done`, `on_link_failed`, `on_episode_acquired`, `on_task_completed`, `on_task_reopened`, `on_task_subscribed`。

**关键点**：`plugin.on("on_link_done", fn)` 只有当 manifest 同时声明
`"hooks": [..., "on_link_done", ...]` **且** `"permissions": [..., "hook.link.read", ...]`
才能注册成功，否则运行期 throw。

| Hook | 需要的 permission |
|------|------------------|
| `on_episode_found`, `on_download_done`, `on_download_failed` | `hook.download.read` |
| `should_download` | `hook.download.write` ⚠️ |
| `on_link_done`, `on_link_failed` | `hook.link.read` |
| `on_episode_acquired`, `on_task_completed`, `on_task_reopened`, `on_task_subscribed` | `hook.task.read` |

> 2026-09-24 起 hook 权限一次性硬改名，**不留别名**：旧的 `hook.download` / `hook.link` / `hook.task` 声明直接解析失败；`hook.notify` 与 `on_notification_before_send` / `on_notification_after_send` 已删除。
>
> `on_task_completed` / `on_episode_acquired` / `on_task_reopened` / `on_task_subscribed` 同时覆盖 Mikan 与豆瓣任务，按 `p.source`（`"mikan"` / `"douban"`）区分；`task_id` 只在各自命名空间内有意义。
>
> `on_task_subscribed` 在新建追踪任务后发，`p.trigger` 为 `"auto"`（Mikan 自动订阅、豆瓣自动任务第一次有种子通过规则——只被规则排除过的不发）或 `"manual"`（手动订阅，含「一键订阅本季」逐个建的任务、豆瓣手动建任务）；委托导航锚、心愿单、站级任务不发。详见 sdk.md。
>
> `on_episode_acquired` 只在集数新入库（位图由灭变亮）时触发，覆盖自动整理 / 手动链接（含部分完成）/ 合集确认；重复整理已入库的集不触发。`p.episodes` 只含本次新亮的集（综艺按期为期号、电影为空数组且只在首次获取时发一次）。

### facade 权限表

没声明权限时对应全局对象是 `undefined`；对象存在但没授权的方法也是 `undefined`（方法级注入，`typeof ptsite.setCookie` 可探测）。权限之间**不蕴含**：要读又要写就两个都声明。⚠️ = 敏感权限（安装 / 升级时管理员需二次确认）。完整规则与「规划中」权限见 sdk.md「权限」章。

| permission | 注入 / 解锁 | 同步 / 异步 |
|------------|------------|------------|
| （无需权限） | `plugin` / `log` / `config` / `data` / `crypto`（sha256 / md5 / base64Decode / evpBytesToKey / aesDecryptCBC） | 同步 |
| （无需权限） | `setTimeout` / `setInterval` / `setImmediate` / `clear*`（§6.5） | 回调稍后在事件循环上跑，不计墙钟 |
| `api.http` ⚠️ | `http.get/post/put/delete`（SSRF 守卫：局域网与 Tailscale 的 `100.64.0.0/10` 放行（其中阿里云元数据地址 `100.100.100.200` 仍拦），本机回环 / 链路本地拦截） | 异步 |
| `api.anime.read` | `anime.get` | 同步 |
| `api.task.read` | `task.get/list` | 同步 |
| `api.ruleflow.read`（旧名 `api.ruleflow` 已弃用，仍可用） | `ruleflow.list` | 同步 |
| `api.ptsite.read` | `ptsite.list/get/registry/getCookieMeta`（`list/get` 带只读 `hosts` = RSS 主机名） | 同步 |
| `api.ptsite.write` ⚠️ | `ptsite.setCookie`（插件只能写 cookie；`setAPIKey` 已于 2026-09-25 删除） | 异步 |
| `api.douban.cookie.read` | `douban.getCookie` | 同步 |
| `api.douban.cookie.write` ⚠️ | `douban.setCookie(v, {validate})`（验活上限 8s，到点回 `rate_limited`） | 异步 |
| `api.notify.send` | `notify.send(msg)`（借宿主已配置的 Telegram / Slack 发消息，开头固定标插件名；**必须 `await` 或 `.catch`**，见 §6.6） | 异步（只在本地入队，但返回 Promise） |
| `ui.embed` | 允许声明 `manifest.ui.entry` | — |

hook 类权限（`hook.download.read` / `hook.download.write` ⚠️ / `hook.link.read` / `hook.task.read`）不注入对象，只决定能 `plugin.on` 哪些 hook，见上表。

**不要用 `http.*` 回跳 FollowCat 自己的 REST**（`localhost` / 内网 / 宿主域名的 `/api/...`）：宿主数据一律走上表的 facade，registry 审核会拦（见 sdk.md「内部访问走 facade」）。

---

## 3. Hook payload 实战

每个 hook 的字段表见 sdk.md。这里讲**怎么写**才不会被字段缺失坑到。

### 黄金规则：可选字段恒在，没值时是零值

sdk.md 字段表里带 `?` 的字段（如 `on_download_done` 的 `data.files`、`data.size`、`data.save_path`、`data.category`）**字段本身一直在**，没有有效值时是零值（`""` / `0` / `[]`），不会是 `undefined`。所以判断「有没有」要看值，不是看字段在不在：

```js
plugin.on("on_download_done", function (data) {
  // ✅ 正确：按值判断
  var path = data.save_path || "未知";          // "" 也当没有
  if (data.size > 0) log.info("size=" + data.size);
  for (var i = 0; i < (data.files || []).length; i++) { ... } // || [] 多一层保险也无妨

  // ❌ 错误：字段恒在，"save_path" in data 永远是 true，判断不出「没有」
  if ("save_path" in data) { ... }
});
```

### 黄金规则：异常被隔离，但**别浪费**

插件抛错（含 async 回调 reject、超时）不会影响主流程：hook 与定时器回调里的记 WARN 并写到 `last_error_msg`；registerAPI 里的作为错误回给调用方（不写 `last_error_msg`）；`should_download` 里的按放行处理。插件 JS 的错误（含栈溢出之类）**永远不计 panic**。`panic_count` 只统计 hook 与定时器回调里的**宿主侧 Go panic**，1 分钟内 5 次会**自动 disable**插件（registerAPI / `should_download` 里的宿主 panic 只让那一次调用失败，不计数）。但抛错会让这次 hook 的后续逻辑全部作废，所以：

```js
plugin.on("on_download_done", function (data) {
  try {
    // 你的逻辑
  } catch (e) {
    log.error("处理 on_download_done 出错: " + e);
    // 不要 throw — 让 worker 继续干活
  }
});
```

### 黄金规则：HTTP 失败也要 try/catch

`http.post` 返回 Promise，在超时 / 网络错误 / 限流时 **reject**——`await` 处会抛出；4xx/5xx 不 reject，要看 `resp.status`。永远包（try/catch 必须包住 `await` 那一行才接得住）：

```js
plugin.on("on_download_done", async function (data) {
  try {
    var resp = await http.post(url, body, headers);
    if (resp.status >= 400) {
      log.warn("upstream " + resp.status + ": " + resp.body);
    }
  } catch (e) {
    log.error("http.post 失败: " + e);
  }
});
```

---

## 4. 配置读写：`config`

`config.get(key)` 永远返回 `string` 或 `null`。`config.set(key, value)` 写入永久存储：`value` 按字符串存——`null` / `undefined` 存成 `""`，数字、布尔等按 `String(v)` 转（`5` → `"5"`），对象会变成 `"[object Object]"`，所以结构化数据自己 `JSON.stringify`。`config.delete(key)` **同步**删除一个 key 并释放它占的配额，返回是否真的删到（`true` / `false`）。

### 数字怎么存？

```js
var n = parseInt(config.get("count") || "0", 10);
config.set("count", String(n + 1));
```

### 数组/对象怎么存？

```js
config.set("recipients", JSON.stringify(["@alice", "@bob"]));
var list = JSON.parse(config.get("recipients") || "[]");
```

### 敏感字段（token/密码/webhook URL）

**所有 `config.*` value 在 store 层无条件 AES-256-GCM 加密落库。** `is_secret` 标记**不是加密开关**，仅决定 API/UI 回读时是否返回明文（`is_secret=true` 时回传空字符串，UI 显示「已设置」占位）。

- `config.set("token", v)` 来自 JS：默认 `is_secret=false`，UI 能看到值
- `PUT /api/plugins/:id/config {"key":"token","value":"v","is_secret":true}` 来自管理页/REST：标记为 secret，回读脱敏

实际操作：插件 README 列出哪些 key 应当标 secret（如 `slack_webhook_url`、`telegram_bot_token`），管理员在 UI 勾选；**加密始终生效，无需担心明文落地**。

### 列举已有 keys（v3.4+）

```js
var keys = config.list();         // ["api_endpoint", "user_token"]
keys.forEach(function (k) {
  log.info(k + " = " + config.get(k));
});
```

跨 plugin 隔离，仅返回当前插件的 keys，按字典序排序。

### 删除 key：`config.delete`

```js
if (typeof config.delete === "function") {   // 兼容还没有 config.delete 的旧宿主
  var removed = config["delete"]("old_key");  // true = 删到了；没设过 → false
}
```

同步执行，key 规则同 `config.set`（不合法抛错）。iframe UI 里对应 `FC.config.delete(key)`（返回 `Promise<{deleted}>`，见 sdk.md）。

**拿 config 当缓存时一定要清理**：缓存 key（比如按「剧 + 季 + 集」一个 key）会一直涨，涨到每插件 500 个 key 的配额，之后计数器、用户配置全都写不进去。做法（`media-library-filter` 即如此）：写缓存前先 `config.delete` 掉过期的，再给缓存 key 总数设个上限（比如 300，给其它配置留余量），超了从最旧的删起。

### 配额（v3.4）

- 每插件最多 **500 个 config keys**（admin 可调到 5000）
- 单 value 上限 **64 KiB**（写死）
- 超限抛错，`message` 含 `current=N limit=M`：`config.set("key501", ...)` → `"plugin config: row quota exceeded: current=500 limit=500"`

如果你的插件需要存 >64 KiB 单值或二进制，看下一节 `data.*`。

---

## 4.5 大对象 / 二进制存储：`data.*`（v3.4+）

`data.*` 是 v3.4 新引入的加密 blob 存储，适合放：

- 解析后的大型 JSON 状态机快照（>64 KiB）
- 番剧封面 / 缩略图等二进制
- RSS 解析缓存、douban 元数据 snapshot
- 索引文件（自建二级索引）

### API

```js
// 写入：value 必须是 ArrayBuffer、Uint8Array，或 data.get 拿到的字节数组；传 string 抛 TypeError
data.put("cover_42.jpg", uint8Array.buffer);
data.put("snapshot.bin", new Uint8Array([0x00, 0x01]));

// 读取：返回字节数组（元素是 0–255 的数字；Array.isArray 为 true，不是 ArrayBuffer）或 null
var raw = data.get("cover_42.jpg");
if (raw) { var bytes = new Uint8Array(raw); /* 处理 */ }

// 列出全部 blob name（仅 names，不取 values 避免一次性解密大量数据）
var names = data.list();          // ["cover_42.jpg", "snapshot.bin"]

// 删除（返回 boolean，不存在也返 true）
data["delete"]("cover_42.jpg");   // 注意 delete 是 reserved word，用 bracket 形式
```

### 配额（v3.4 默认）

- 单个 blob ≤ **4 MiB**（admin 可调到 64 MiB）
- 单个插件总和 ≤ **16 MiB**（admin 可调到 256 MiB）
- 跨 plugin 隔离

### 严格类型契约

```js
// ❌ 全部抛 TypeError（"data.put requires ArrayBuffer or Uint8Array, got <Go 类型>"）
data.put("x", "string");                  // got string
data.put("x", { foo: 1 });                // got map[string]interface {}
data.put("x", [1, 2, 3]);                 // got []interface {}（自己写的数组字面量不行）
data.put("x", new Int16Array([1]));       // got []int16

// ✅ ArrayBuffer、Uint8Array，以及 data.get 拿回来的那个字节数组（原样写回可以）
data.put("x", new Uint8Array([1,2,3]));
data.put("x", new Uint8Array([1,2,3]).buffer);
data.put("x", new ArrayBuffer(8));
data.put("copy", data.get("x"));
```

`name` 按 `String(name)` 转换后再按 key 规则校验（`data.put(42, ...)` 存成 `"42"`）。

### UTF-8 编解码（goja 没有原生 TextEncoder）

goja 的 ECMAScript 实现不带 `TextEncoder`/`TextDecoder`，自己写：

```js
// 编码也先交给内置函数：encodeURIComponent 做真正的 UTF-8 编码（含 surrogate pair / 4 字节），
// unescape 把 %XX 还原成「字节串」（每个字符 0–255），最后逐字节写进预先分配好的 Uint8Array。
// 字符串里有落单的代理项（不成对的 \uD800–\uDFFF，本身就不是合法文本）→ 抛 URIError。
function encodeUtf8(str) {
  var bin = unescape(encodeURIComponent(str));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 解码交给内置函数：每 8192 字节一块 String.fromCharCode.apply 成「字节串」，
// 拼起来后 escape → decodeURIComponent 完成真正的 UTF-8 解码。非法 UTF-8 → 抛 URIError。
function decodeUtf8(u8) {
  var parts = [];
  for (var i = 0; i < u8.length; i += 8192) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + 8192)));
  }
  return decodeURIComponent(escape(parts.join("")));
}

// 用法
data.put("state.json", encodeUtf8(JSON.stringify(big)).buffer);
var got = data.get("state.json");                       // 字节数组
var parsed = JSON.parse(decodeUtf8(new Uint8Array(got)));
```

上面两段即完整参考实现（含 surrogate pair / 4 字节 UTF-8 处理），直接抄进插件即可。`decodeUtf8` 的参数要是 `Uint8Array`（`data.get` 的返回值先 `new Uint8Array(...)`）。

代价（goja 实测，1.3 MB 含中文 / emoji 的 JSON）：`decodeUtf8` 约 **85 ms**，与 Go 的解码结果逐字节一致，非法序列（截断、过长编码、代理区、超出 U+10FFFF）都会抛错；`encodeUtf8` 约 **1.3 s**（剩下那个逐字节写 `Uint8Array` 的循环在 goja 里仍是大头，约 1 秒 / MB；旧版「逐字符判断 + `push`」写法要 3.8 s）。所以编码几十 KB 无所谓，**MB 级数据的编码要算进这次调用的 10 秒墙钟**；能不编码就不编码——纯文本 / JSON 小于 60 KiB 直接 `config.set`，二进制从来源处就拿字节（`crypto.base64Decode` 的结果本身就是 `Uint8Array`）。

> ⚠️ **通用提醒：goja 里别用循环逐字节处理、别用 `+=` 拼长字符串。** goja 是纯 Go 解释器，没有 V8 那样的字符串拼接优化：`for` 循环里一个字节一个字节地 `out += ...`，数据一大就是平方级——旧版 `decodeUtf8` 就这么写，1.3 MB 要 6.5 分钟，远超每次调用的墙钟。能交给内置函数的尽量交给内置函数（`String.fromCharCode.apply` 分块、`Array.prototype.join`、`JSON.parse`、`decodeURIComponent`、正则 `replace` 等），非要自己循环就把片段先 `push` 进数组，最后一次 `join("")`。Node / 浏览器里跑得飞快的写法，在 goja 里可能慢几个数量级，上线前用接近真实大小的数据在 FollowCat 里试一次。

### 何时用 config / 何时用 data？

| 场景 | 用 |
|------|---|
| 凭据（OAuth token、API key、webhook URL） | `config.set` + `is_secret=true`（UI 自动脱敏） |
| 用户偏好（数字、布尔、短字符串） | `config.set` |
| 小型 JSON（< 60 KiB） | `config.set("k", JSON.stringify(o))` |
| 大对象 / 二进制 / 缓存 / 索引 | `data.put` |

**两者都默认 AES-256-GCM 加密**，区别只在大小、类型契约、UI 脱敏行为。

### 错误处理

```js
try {
  data.put("big", new Uint8Array(5 * 1024 * 1024)); // 5 MiB > 4 MiB 默认
} catch (e) {
  // "plugin blob: size exceeds per-blob limit: size=5242880 limit=4194304"
  log.warn("blob too large: " + e.message);
}

try {
  // 累计超过 16 MiB
  for (var i = 0; i < 5; i++) data.put("blob_" + i, big4MiB);
} catch (e) {
  // "plugin blob: total exceeds per-plugin limit: current=N new=M limit=16777216"
  log.warn("plugin total quota exceeded: " + e.message);
}
```

### iframe UI 怎么碰 data.* blob

**iframe 桥不暴露 `data.*`**，且 iframe 的 CSP 是 `connect-src 'none'`——`fetch`/`XHR` 全被浏览器拦掉，UI **不能**直接打 sandbox REST。正确姿势：`index.js` 里用 `plugin.registerAPI` 包一层，blob 操作在 goja 侧做，UI 只通过 `FC.api` 调用。

```js
// index.js（goja 侧——data.* 在这里可用）
plugin.registerAPI("/save-cover", function (req) {
  // req.body 是请求体按 UTF-8 解出的字符串，不是原始字节——二进制在 UI 侧先 base64 成字符串再发，
  // 这里用 crypto.base64Decode 还原（直接发二进制会在解码时损坏：非法字节变成 U+FFFD）
  data.put("cover.jpg", crypto.base64Decode(req.body));
  return { ok: true };
});

plugin.registerAPI("/list-blobs", function () {
  return { names: data.list() };
});
```

```html
<!-- ui/index.html（iframe 侧——只有 FC.* 可用） -->
<script src="/plugin-sdk.js"></script>
<script>
FC.ready().then(async function () {
  await FC.api("/save-cover", coverBase64);      // 触发上面的 /save-cover（body 是 base64 字符串）
  const { names } = await FC.api("/list-blobs"); // 列出 blob name
});
</script>
```

> `FC.api` 的 body：字符串原样进 `req.body`，对象 / 数组会被 JSON 序列化；不传 body 则是 `GET`、`req.body` 为 `""`（完整规则见 sdk.md「`FC.api` 请求规则」）。传二进制要先 base64 成字符串，别把 `Uint8Array`/`ArrayBuffer` 直接塞进去。

---

## 5. HTTP 调用：`http`

> ⚠️ **破坏性变更**：`http.*` 全部返回 **Promise**，没有同步别名。调用处必须 `await`，所在函数写成 `async function`，并一路 `async` 到回调（hook / registerAPI / `should_download` 都支持 async 回调）。忘了 `await` 拿到的是 Promise 对象，`resp.status` 为 `undefined`。

```js
// 以下代码都在某个 async function 里（例如 plugin.on("...", async function (data) { ... })）

// GET
var resp = await http.get("https://api.example.com/users", {
  "Authorization": "Bearer xxx"
});
// resp = { status: 200, headers: {...}, body: "...", truncated: false }

// POST JSON（必须自己 stringify + 设 Content-Type）
var resp = await http.post(
  "https://hooks.slack.com/services/T00/B00/xyz",
  JSON.stringify({ text: "hello" }),
  { "Content-Type": "application/json" }
);

// POST form
var resp = await http.post(
  "https://api.example.com/form",
  "field1=value1&field2=value2",
  { "Content-Type": "application/x-www-form-urlencoded" }
);
```

多个请求**按顺序** `await` 即串行执行；`await` 期间插件的其它任务可以先跑，但同一次调用的墙钟（hook 10s / API 10s / `should_download` 3s）照算 `await` 时间。

### 限制（来自宿主）

- 单次 **10 秒** 超时（每个请求固定，与所属调用的墙钟无关）
- 响应体 **5 MiB** 上限，超出截断（`truncated=true`）
- 单插件 **60 req/min** 令牌桶，超限 **reject** `"plugin http rate limit exceeded (60 req/min)"`
- 最多 **3 次重定向**
- 网络错误 / 超时 / 限流 / SSRF 拦截一律 reject，错误对象与旧同步版抛出的相同（`e.message` 形如 `http GET <url>: ...`）
- SSRF 守卫：局域网（`10.x` / `172.16–31.x` / `192.168.x`）与 Tailscale 等用的 `100.64.0.0/10` 可达（其中 `100.100.100.200` 这个云元数据地址仍拦），本机回环、链路本地（含 `169.254.169.254`）拦截
- 响应对象（连同 `headers`）是你自己的一份普通对象，每次调用都是新的

### 防 rate-limit 的两种姿势

**姿势 A：本地节流**（推荐）：

```js
function debounceSecond(fn) {
  var lastCall = 0;
  return function () {
    var now = Date.now();
    if (now - lastCall < 1000) return; // 1 秒内只调一次
    lastCall = now;
    fn.apply(null, arguments);
  };
}
var notifyDownload = debounceSecond(function (data) { /* ... */ });
plugin.on("on_download_done", notifyDownload);
```

**姿势 B：合并通知**：把 5 秒内的多个事件聚合成一条，可显著降 QPS。

---

## 6. 自定义 API：`plugin.registerAPI`

```js
plugin.registerAPI("/stats", function (req) {
  return {
    sent_count: parseInt(config.get("sent_count") || "0", 10),
    configured: !!config.get("webhook_url")
  };
});
```

调用方式：

```
GET /api/plugins/<your-plugin-id>/api/stats
```

**返回值会被 JSON 序列化**——返回 string/number/object/array 都行，但要能 marshal。宿主在插件的事件循环上先把返回值按 JSON 导出成拷贝再交出去（`undefined` / 函数被丢掉、`Date` 变 ISO 字符串、`Map` / `Set` / `Error` 变 `{}`、`toJSON` 生效）；带环的对象（`a.self = a`）、`BigInt`、嵌套超过 1000 层、超过 100 万个值按普通错误返回给调用方（`plugin return value is not JSON-serializable: ...`），不会让 FollowCat 崩溃。

回调可以是 `async function`：返回的 Promise resolve 的值照常序列化，reject 等同抛错（前端收到错误）；整次调用 **10 秒**墙钟（含 `await`），超时调用方收到 HTTP **504**（通常是 `plugin runtime: execution timeout`；插件事件循环被别的任务占住、这次调用没轮上时是宿主 11 秒兜底的 `plugin api: execution timeout`）：

```js
plugin.registerAPI("/test-webhook", async function (req) {
  try {
    var resp = await http.get(config.get("webhook_url"), {});
    return { ok: resp.status < 400, status: resp.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
```

**`req` 对象**目前提供：
- `req.method` —— `"GET"` / `"POST"` / 等
- `req.body` —— 请求体字符串（按 UTF-8 解码，不自动 JSON parse；二进制请 base64）
- `req.query` —— `Record<string, string>`，URL query 参数（同名 key 取第一个值）

`req` 本身也是你自己的一份普通对象，随便改。

从 iframe UI 经 `FC.api(path, body)` 调用时：不传 `body` → `GET`、`req.body` 为 `""`；传 `null` → `POST`、`req.body` 为 `""`；传字符串 → `POST`、原样；传对象 / 数组 → `POST`、JSON 字符串；`path` 里的 `?a=1` 进 `req.query`。回调 throw / reject 的内容会作为 `FC.api` reject 的 `Error.message` 透到 UI；宿主自己的内部错误（数据库 / 存储出错、宿主 Go panic）在插件页只显示「宿主内部错误」，详情在服务端日志里。详见 sdk.md「`FC.api` 请求规则」。

**用途**：
- 暴露插件自己的统计/调试端点（前端 UI 需要数据时）
- 给外部系统做 webhook 接收（譬如 GitHub release → 触发某个动作）

**配合 iframe UI**：
- `registerAPI` 端点正是 iframe UI 的数据入口——声明 `ui.embed` 权限嵌入 UI 后，前端用 `FC.api("/path", body)` 调它（详见 sdk.md「Plugin UI（iframe 嵌入）」）。
- 这些端点**不能**在浏览器里被直接 fetch（iframe CSP `connect-src 'none'` + 需走宿主 pluginToken 鉴权），一律经 `FC.api` 代理。

---

## 6.5 定时任务：`setTimeout` / `setInterval`

定时器始终可用（无需权限），语义见 sdk.md「定时器」。要点：

- 回调和 `await` 之后的续体一样：在插件自己的事件循环上跑（与 hook / API 串行，不用加锁），**不计墙钟**，宿主不看管——回调里的死循环会卡死整个插件。
- 回调抛错 / async 回调 reject 未处理：宿主只记 WARN + `last_error_msg`，定时器照跑，**不计 panic**。但别依赖它：自己 `try/catch` 或 `.catch()`，把人看得懂的原因写日志 / 状态。
- 例外是**宿主侧 Go panic**（宿主代码自己崩了，不是你的 JS 抛错）：定时器回调里发生时记到 `plugin/<id>` 日志、写 `last_error_msg`，并**计入** panic 自动停用（1 分钟 5 次），和 hook 里的一样。
- 停用 / 卸载 / 升级时全部清掉；重新启用 = 入口脚本重跑，定时器从头登记。`delayMs` 超过 `2147483647`（约 24.8 天）会被当成 1ms，长周期自己截住。
- 耗时的活别让调用方干等：registerAPI 有 10s 墙钟。「立即返回 + 后台跑 + 轮询状态」是推荐形状：

```js
var state = { running: false, result: null };

function startJob(trigger) {
  if (state.running) return { started: false, reason: "already_running" }; // 已在跑就跳过，不排队
  state.running = true;
  doWork().then(function (r) { state.result = r; }, function (e) { log.error("任务失败: " + e); })
    .then(function () { state.running = false; });
  return { started: true };
}

plugin.registerAPI("/run", function () { return startJob("manual"); });  // UI：调它，然后轮询 /status
plugin.registerAPI("/status", function () { return state; });
setInterval(function () { startJob("timer"); }, 30 * 60000);             // 定时走同一个入口
```

完整示例见 `cookiecloud`（按配置间隔自动同步、保存设置后 `/reschedule` 即时重排、`/sync` 立即返回、UI 每 2 秒轮询 `/status`）。

---

## 6.6 发通知：`notify.send`

声明 `api.notify.send` 后，插件可以借 FollowCat 已配置的通知通道（Telegram / Slack）发消息，完整规则见 sdk.md「[`notify`](./sdk.md#notify--借宿主的通知通道发消息需-apinotifysend异步)」。要点：

- 返回 Promise：**必须 `await` 或 `.catch`**。宿主不跟踪没人处理的 rejection，被拒（超配额、链接不合规、队列满）时不接就什么提示都没有。
- 参数类型不对（如 `title` 是数字）在调用处**同步抛 `TypeError`**，内容不合规才是 reject，`e.message` 是中文原因。
- resolve `{queued: true, channels: N}` 只表示进了发送队列；`channels: 0` = 没有通道收这类消息（没配通道、或都没勾「插件消息」），不算错。
- 消息开头固定带 `🧩 [插件名]`；每小时默认最多 300 条（只算真正排上队的）。批量任务结束后汇总发一条，别每处理一项发一条。
- 别在 `on_download_done` / `on_link_done` / `on_task_completed` 这类 hook 里转发宿主已经发过的内容，用户会收到两条。
- 正文是 FC-Markdown：站点名、文件名这类动态文字放进 `body` 前先转义，免得 `*`、`[` 之类被当成格式。

cookiecloud 式的例子：同步跑完后发一条汇总（失败时多带一个跳到 CookieCloud 面板的按钮）：

```js
// 动态文字转义成 FC-Markdown 的字面文字（同主仓 EscapeFCMarkdown 的规则）
function fcEscape(s) {
  return String(s).replace(/[\\*~+|`\[\]]/g, "\\$&").replace(/^[>-]/gm, "\\$&");
}

async function notifySyncResult(results) {
  if (typeof notify === "undefined") return; // 没声明 api.notify.send
  var failed = results.filter(function (r) { return r.status === "failed"; });
  var written = results.filter(function (r) { return r.status === "written"; });
  if (!failed.length && !written.length) return; // 没变化就不打扰
  var lines = ["写入 **" + written.length + "** 个，失败 **" + failed.length + "** 个"];
  failed.forEach(function (r) { lines.push("- " + fcEscape(r.name) + "：" + fcEscape(r.message)); });
  try {
    var r = await notify.send({
      title: failed.length ? "Cookie 同步有失败" : "Cookie 同步完成",
      body: lines.join("\n"),
      buttons: failed.length ? [{ label: "打开 CookieCloud", url: config.get("server_url") || "https://example.com/" }] : [],
    });
    if (r.channels === 0) log.info("没有通道接收插件消息（未配置或未勾选「插件消息」）");
  } catch (e) {
    log.warn("同步通知没发出去：" + e.message); // 超配额 / 队列满 / 内容不合规
  }
}

async function syncTask(trigger) {
  try {
    var results = await runSync();
    // ……记录状态……
    await notifySyncResult(results); // 自己接住了错误：通知发不出去不影响同步结果
  } catch (e) {
    log.error("同步失败：" + e);
  }
}
```

---

## 7. 调试 / 排查

### 看日志

插件详情页 → 最近日志。或者直接 `GET /api/plugins/<id>/logs?tail=200`。
`log.info/warn/error` 写的内容都带 `plugin/<id>` 前缀；消息里的 `\r` / `\n` 被转义成字面的 `\r` / `\n`，一次调用只产生一行。

### 看运行状态

详情页或 `GET /api/plugins/<id>` 会返回：

| 字段 | 含义 |
|------|------|
| `dropped_count` | 队列饱和被丢的事件数。**>0 表示插件处理不过来**，要么优化逻辑要么用合并策略 |
| `panic_count` | 累计宿主侧 Go panic 次数（hook 与定时器回调里的；插件 JS 错误不算）。1 分钟 5 次会自动 disable，之后 `last_error_msg` 显示 `因频繁崩溃被自动停用：<最后一次错误>` |
| `last_error_msg` | 最近一次：hook / 定时器回调抛错、reject 或超时，hook / 定时器回调里的宿主 panic，或启用失败（入口脚本超时 / 出错、启动时文件与记录不一致）、自动停用的原因。插件停用后仍保留，下次启用成功时清空；只存在内存里，FollowCat 重启后不再显示。registerAPI / `should_download` 的失败不写这里（API 的错误直接回给调用方） |
| `last_error_at` | 最近一次 **panic 或队列丢事件** 的时间（不是 `last_error_msg` 的时间：普通抛错不更新它） |

### 常见症状对照

| 症状 | 原因 | 修法 |
|------|------|------|
| `plugin.on: hook "x" not in manifest.hooks` | manifest hooks 数组缺 `"x"` | 加进去 |
| `plugin.on: hook "x" requires permission "hook.y"` | manifest permissions 缺 `"hook.y"` | 加进去 |
| `http rate limit exceeded` | 60 req/min 超限 | 节流或合并 |
| `dropped_count` 持续增长 | hook 的同步段太慢（队列按同步段逐个消费，满 64 丢最旧） | 出网一律 `await`（等待期间不占队列）、减少同步计算、合并事件 / 用 `setTimeout` 攒一批再处理 |
| `panic_count = 5` 然后插件被禁用 | hook / 定时器回调里的宿主侧 Go panic（插件 JS 的 throw / reject 不计入 panic，只写 `last_error_msg`） | 看日志里的 panic 堆栈，多为宿主问题，附日志反馈 |
| 启用失败：`run entry script: entry script exceeded 10s (interrupted)` | `index.js` 顶层代码（含它执行期间触发的定时器回调 / 微任务）10 秒没跑完。插件保持停用，原因在 `last_error_msg`，FollowCat 其它插件照常加载 | 顶层只做注册与排定时器，重活放到定时器 / 首次调用里 |
| 启用失败：`run entry script: host panic: ...` | 入口脚本执行期间宿主自己出错（进程不崩，只是这个插件没启用成功） | 附日志反馈 |
| 安装 / 升级提示「已安装，但启用失败：原因」 | 文件已换成新版本，但新版本启用失败（多为上面两条） | 修好后在插件列表里重新启用即可，不用重装 |
| 安装被拒：`duplicate entry "..."` | zip 里有两个条目归一化后是同一路径（如 `manifest.json` 与 `./manifest.json`） | 重新打包，别重复加文件 |
| `FC.api` 报 504 / `plugin runtime: execution timeout`（或 `plugin api: execution timeout`） | registerAPI 回调（含 `await`）超过 10 秒；后者是事件循环被别的任务占住、这次调用没轮上 | 改成「立即返回 + 后台跑 + 轮询状态」（§6.5） |
| 插件页报「宿主内部错误」 | 宿主自己出错（数据库 / 存储、宿主 panic），详情只在服务端日志里 | 看 FollowCat 日志，多为宿主问题 |
| `TypeError: JSON.parse: input nested deeper than 1000 levels` / `JSON.stringify: ...` | 宿主给内置 `JSON` 加了保护：嵌套超过 1000 层或 stringify 超过 100 万个值 | 检查数据是否异常（环、失控的嵌套）；正常数据不会碰到 |
| 日志里出现字面的 `\n` | 消息里的换行被宿主转义（防伪造日志行） | 要分行就多调几次 `log.*` |
| 日志里 `setInterval callback error: ...` / `setTimeout callback error: ...` | 定时器回调抛错或 reject 没接住（不计 panic，定时器照跑） | 在回调里 `try/catch` / `.catch()` |
| 日志看不到任何输出 | hook 名拼错 / manifest 没声明该 hook | 对照 sdk.md hook 列表 |
| 启用失败：`该插件上次的运行还没退出（卡在无法打断的操作里），请重启 FollowCat 后再启用` | 上次停用时插件卡在宿主打断不了的操作里，宿主放弃了它（停用照常完成），旧引擎还没真正退出 | 重启 FollowCat；或等旧引擎自己退出后再启用（自动解除） |
| FollowCat 启动后插件没起来，最近错误：`插件文件与记录不一致，请重新安装后再启用（…）` | 安装 / 升级中途 FollowCat 被杀，插件目录里的 manifest（版本 / 权限）与数据库记录对不上；宿主启动时不会用新权限跑旧代码（只在 FollowCat 启动时核对，手动启用不核对） | 重新上传 / 安装一次该插件，再手动启用 |
| `convert host value for plugin: nested deeper than 1000 levels ...` | 宿主把数据转给插件时超限，多半是插件改写了 `Object.prototype.toJSON` 之类的全局原型 | 别改写内置原型 |
| 正则明明该匹配却返回 `false` / `null`，耗时约 5 秒 | 正则回溯超过 5 秒上限，按未匹配处理 | 改写正则（去掉嵌套量词 / 反向引用），或先截短输入 |

### 本地迭代流程

修了代码 → 重新 zip → 在管理页**先 disable 再上传同 plugin_id 的新 zip** → 上传成功后会自动 re-enable（保持启用意图）。所以正常流程：

1. 改 `index.js`
2. `zip -j my-plugin.zip my-plugin/manifest.json my-plugin/index.js`
3. 上传新 zip → 系统自动 stop 旧 worker → 装新代码 → start 新 worker
4. 配置不丢

---

## 8. 完整示例：媒体库感知的下载去重（`should_download`）

> 旧版本这里介绍的是「订阅 `on_notification_before_send` 做通知过滤」——那两个通知 hook 已于 2026-09-24 删除（`hook.notify` 一并移除）。`media-library-filter` 现在是 `should_download` 同步否决插件：推种前查 Emby / Plex，库里已有同规格副本就拦下。

参考实现：[`plugins/media-library-filter` @ Bespertrijun/followcat-official-plugins](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/media-library-filter)

特性清单（用作你的设计参考）：

- **`should_download` 注册**（需 `hook.download.write`，敏感权限）：返回 `false` 拦下载，其余一律放行（fail-open）
- **per-flow 满足判断**：`ruleflow.list()`（`api.ruleflow.read`）在配置 UI 列出所有规则流，按 `p.flow_id` 取各自标准
- **Emby + Plex 双后端**：任一命中即视为「库里有」；合集种子可回 `{ have_bitmap }` 逐集过滤
- **结果缓存**：库查询结果按 TTL 缓存到 `config.*`，避免刷爆 Emby/Plex
- **fail-open**：Emby / Plex 不可达时按「库里没有」处理，宁可多推不漏推
- **soft budget**：库查询软超时，给 host `should_download` 3 s 硬超时（墙钟，含 `await`）留出余量
- **统计 / trace API**：`GET /api/plugins/<id>/api/stats`、`/check` 透传单次库查询

详见示例代码注释。

---

## 9. 常见反模式（请勿照搬）

```js
// ❌ 1. 在 hook 里跑死循环
plugin.on("on_download_done", function (data) {
  while (true) { /* 10 秒后宿主打断，本次 hook 以超时错误结束（记 last_error，不计 panic）；这 10 秒里本插件其它任务全部排队 */ }
});

// ❌ 2. 同步等数秒
plugin.on("on_download_done", function (data) {
  for (var i = 0; i < 1000000000; i++) {} // 烧 CPU 几秒：同步段占住事件循环，本插件其它任务（含 await 回来的续体）全得等；超过 10 秒墙钟才被打断
});

// ❌ 3. 信任 data 字段全有
plugin.on("on_link_done", function (data) {
  send("文件位置: " + data.dest.toLowerCase()); // dest 可能 undefined
});

// ❌ 4. 把 token 硬编码进 index.js
var TOKEN = "xoxb-1234-actual-secret"; // 上传 zip 后明文落地，请用 config + is_secret

// ❌ 5. 一个事件发 N 个 http
plugin.on("on_download_done", async function (data) {
  for (var i = 0; i < data.files.length; i++) {
    await http.post(...); // files 多了直接打爆 60/min 限速
  }
});

// ❌ 6. registerAPI 里逐个发邮件然后返回
plugin.registerAPI("/notify-all", async function (req) {
  for (var i = 0; i < users.length; i++) await http.post(...); // 累计 >10s（含 await）会超时
  return { sent: users.length };
});

// ❌ 7. 忘了 await
plugin.on("on_download_done", async function (data) {
  var resp = http.get(url, {}); // resp 是 Promise，不是响应
  if (resp.status !== 200) { ... } // 永远成立：resp.status === undefined
});

// ❌ 8. await 之后写死循环
plugin.on("on_download_done", async function (data) {
  await http.get(url, {});
  while (true) {} // 续体里的死循环宿主不打断：整个插件卡住，只能停用
});

// ✅ 反模式 6 的修法：异步触发，立即返回（后台跑，不占这次调用的 10s 墙钟）
plugin.registerAPI("/notify-all", function (req) {
  setTimeout(function () {
    notifyAll().catch(function (e) { log.error("notify-all 失败: " + e); });
  }, 0);
  return { queued: true };
});
// 需要让 UI 看进度就再注册一个 /status 轮询（见 §6.5）
```

---

## 10. 升级与卸载

- **升级**：上传同 `plugin_id` 的新 zip → 系统自动停旧版本（只停运行，不改「已启用」标记）→ atomic 替换文件 → 重新 enable（如果之前在运行）。配置保留。同一插件的安装 / 启用 / 停用 / 卸载依次执行，升级途中点「启用」会等升级做完，最终跑的是新版本。
- **升级中途 FollowCat 被杀**：重启时宿主先核对插件目录——换目录做到一半就恢复旧目录的备份、删掉残留的暂存目录；插件目录的 manifest 与数据库记录（版本 / 权限）对不上的，不启用并提示「插件文件与记录不一致，请重新安装后再启用」。重新安装一次（装完是停用状态）再手动启用即可。这项核对只在 FollowCat 启动时做；手动启用不核对。
- **卸载**：管理页点卸载 → 停 worker → 删 `data.*` 存的数据 → 删升级留下的旧版本备份 → 删插件目录 → 删 DB 行（连带配置）。**配置不可恢复**，操作前确认。
- **降级**：上传旧 version 的 zip 同样走升级流程，FollowCat 不阻止 version 倒退。

---

## 11. 接下来

- [`sdk.md`](./sdk.md) —— API 签名、字段表、限制清单速查
- FollowCat 主仓 `docs/plugin-runtime-eventloop-plan.md`、`docs/plugin-permission-expansion-plan.md` —— 运行时与权限的设计文档（含后续批次规划）
- [`devrt/README.md`](../../devrt/README.md) —— 本地调试宿主（DevRT）的用法与它和真实宿主的差异
- [`media-library-filter` @ Bespertrijun/followcat-official-plugins](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/media-library-filter) —— `should_download` 下载去重（否决式 hook）的完整参考实现
- [`dashboard-stats` @ Bespertrijun/followcat-official-plugins](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/dashboard-stats) —— headless API 插件示例
- [`cookiecloud` @ Bespertrijun/followcat-official-plugins](https://github.com/Bespertrijun/followcat-official-plugins/tree/main/plugins/cookiecloud) —— 带 iframe UI、`crypto.*` 解密、`ptsite` / `douban` 凭据写入、定时器自动同步、立即返回 + 轮询状态的综合示例

---

## 13. 发布到插件市场（v1）

1. **打包 zip**（zip 根直接是 `manifest.json` 和 `index.js`，不嵌套目录）：
   ```bash
   zip -j my-plugin-1.0.0.zip my-plugin/manifest.json my-plugin/index.js
   ```

2. **上传到 GitHub Release**（或任意 HTTPS 静态托管），获取直链。

3. **计算 sha256**：
   ```bash
   sha256sum my-plugin-1.0.0.zip | awk '{print $1}'
   ```

4. **更新你的 registry 的 index.json**，新增或更新该插件的**那一条** entry（一个插件只能有一条，重复会让整个源解析失败），填入 `zip_url` 和 `zip_sha256`。想进官方源的，向 [`Bespertrijun/followcat-official-plugins`](https://github.com/Bespertrijun/followcat-official-plugins) 提 PR 把插件目录加进 `plugins/`——官方源由 CI 按 tag 自动打包与生成 index（见该仓 README「发布新版本」），不用手填 zip 与 sha256。

5. v1 不需要签名；M2 后可用 `minisign` 对 zip 签名，详见届时发布的文档。

完整字段说明见 [`registry-schema.md`](./registry-schema.md)。
