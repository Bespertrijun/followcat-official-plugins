# 升级到 FollowCat v3.4 — 插件作者迁移指南

> 适用：FollowCat 主仓合并 `phase1-plugin-config-quota` + `phase2-plugin-blob-store` 后的所有插件作者。
> v3.4 主要带来：插件可以**存大数据 / 二进制**了，所有数据**默认 AES-256-GCM 加密**。
> 现有插件**无需改动**（向前兼容），但建议利用新能力。

---

## 一句话总结

| | v3.3 及以前 | v3.4 |
|---|---|---|
| 配置存储 | `config.get/set` (string KV, ≤ 64 KiB/key) | 不变 |
| 大对象 / 二进制 | ❌ 无 | ✅ `data.get/put/list/delete` (≤ 4 MiB/blob, ≤ 16 MiB/plugin) |
| 列举配置 keys | ❌ 无 | ✅ `config.list() → string[]` |
| 配置加密 | 已是 AES-256-GCM | 不变（现在 `data.*` 也加密） |
| 卸载状态 | 不可见 | `Plugin.UninstallStatus` 暴露在 `GET /api/plugins/:id` |
| 配额可调 | 写死 | admin 可改 `AppSetting`，三个键 |

---

## 新 API 速查

### `config.list()` — 列出当前插件全部 keys

```js
const keys = config.list();
// → ["api_endpoint", "user_token", "settings"]
```

返回按字典序排序的 `string[]`，仅 keys 不含 values。跨 plugin 隔离。

**典型用法**：迁移已有数据 / 验证配置完整性：

```js
function ensureRequiredConfig() {
  var keys = config.list();
  var required = ["webhook_url", "channel"];
  var missing = required.filter(function(k) { return keys.indexOf(k) < 0; });
  if (missing.length) throw new Error("缺少配置: " + missing.join(", "));
}
```

### `data.*` — 加密 BLOB 存储（新）

```js
// 写入 ArrayBuffer 或 Uint8Array（不能是 string，会抛 TypeError）
var buf = encodeUtf8(JSON.stringify(largeObject)).buffer;
data.put("cache.json", buf);

// 读取（返回 ArrayBuffer 或 null）
var back = data.get("cache.json");
if (back) {
  var decoded = decodeUtf8(new Uint8Array(back));
  var obj = JSON.parse(decoded);
}

// 列出全部 blob name
var names = data.list();  // ["cache.json", "feed.bin"]

// 删除（返回 boolean）
data["delete"]("cache.json");
```

> goja 没有原生 `TextEncoder`/`TextDecoder`，需自己实现 UTF-8 编解码。
> 可参考 [`blob-cache-demo/index.js`](../../blob-cache-demo/index.js) 的 `encodeUtf8`。

**配额**：单 blob ≤ 4 MiB（admin 可调到 64 MiB），单 plugin 总和 ≤ 16 MiB（admin 可调到 256 MiB）。

**类型严格**：

```js
data.put("x", "string");                       // ❌ TypeError: data.put requires ArrayBuffer or Uint8Array
data.put("x", { foo: 1 });                     // ❌ TypeError
data.put("x", new Uint8Array([1,2,3]));        // ✅
data.put("x", new ArrayBuffer(8));             // ✅
data.put("x", new Uint8Array([1,2,3]).buffer); // ✅
```

---

## 何时用 config / 何时用 data？

| 场景 | 推荐 | 原因 |
|---|---|---|
| OAuth token / API key / 密码 | `config.set` (`is_secret=true`) | UI 自动脱敏；64 KiB 够用 |
| 用户偏好（数字、布尔、短字符串） | `config.set` | 小、结构清晰 |
| 小型 JSON 配置（< 60 KiB） | `config.set("k", JSON.stringify(o))` | 单值原子 |
| RSS 抓取的解析缓存 | `data.put` | 可能 > 64 KiB |
| 番剧封面缩略图 | `data.put` | 二进制 |
| 大型 JSON 状态机快照 | `data.put` | > 64 KiB |
| 跨 hook 传递的临时大数据 | 内存变量优先；持久化才用 `data.put` | – |

**两者都加密**——不会因为选了 `data.*` 而牺牲安全。区别仅在大小、类型、UI 脱敏行为。

---

## 错误处理

新增三个错误，JS 侧通过字符串匹配识别：

| 错误来源 | 触发时机 | 错误 message 含 |
|---|---|---|
| `ErrPluginConfigQuotaExceeded` | 第 501 个 config key | `"plugin config: row quota exceeded: current=500 limit=500"` |
| `ErrPluginBlobTooLarge` | 单 blob > 4 MiB | `"plugin blob: size exceeds per-blob limit: size=N limit=M"` |
| `ErrPluginBlobQuotaExceeded` | plugin blob 总和超额 | `"plugin blob: total exceeds per-plugin limit: current=N new=M limit=K"` |

```js
try {
  data.put("big", new Uint8Array(5 * 1024 * 1024)); // 5 MiB > 4 MiB 默认
} catch (e) {
  log.warn("blob 太大: " + e.message);
}
```

---

## iframe UI 用 data.*（重要）

**当前 iframe SDK（`/plugin-sdk.js`）暂未桥接 `data.*` postMessage RPC。** 如果你的插件有 iframe UI 需要读写 blob，**用 sandbox REST**：

```js
// iframe 内（plugin token 自动注入）
const pluginId = (await FC.ready()).plugin_id;

// 写
await fetch(`/api/plugins/${pluginId}/sandbox/data/cover.jpg`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: arrayBuffer,
});

// 读（二进制）
const getRes = await fetch(`/api/plugins/${pluginId}/sandbox/data/cover.jpg`);
const buf = await getRes.arrayBuffer();

// 列表（JSON）
const list = await (await fetch(`/api/plugins/${pluginId}/sandbox/data`)).json();
// → {"data": [{"name":"cover.jpg","size":12345,"updated_at":"..."}]}

// 删除
await fetch(`/api/plugins/${pluginId}/sandbox/data/cover.jpg`, { method: 'DELETE' });
```

主仓后续迭代会把 `FC.data.*` 接到 plugin-sdk.js，届时 iframe 可像调 `FC.config.*` 一样调 `FC.data.*`。

---

## 卸载半状态（管理员视角）

`Plugin.UninstallStatus` 字段暴露在 `GET /api/plugins/:id`，值域：

| 值 | 含义 | 管理员动作 |
|---|---|---|
| `""` (默认) | 正常 | – |
| `"running"` | Uninstall 进行中 | 等 |
| `"failed:bump_epoch"` | Token epoch 未递增（不常见） | 重试 Uninstall |
| `"failed:disable_worker"` | Worker 未停成功 | 重试（worker 卡死后） |
| `"failed:partial_cleanup"` | Worker 已停，但 blob/dir 删失败 | 重试（通常 Win32 文件锁导致） |

UI 应在 plugin 列表显示这些状态，给「重试卸载」按钮。

---

## 配额可调（管理员）

```http
PUT /api/admin/settings
{ "key": "plugin.blob.max_bytes_per_plugin", "value": "33554432" }   # 32 MiB
```

允许的键和范围：

| Key | 默认 | 范围 |
|---|---|---|
| `plugin.config.max_keys_per_plugin` | 500 | [10, 5000] |
| `plugin.blob.max_bytes_per_blob` | 4 MiB | [4 KiB, 64 MiB] |
| `plugin.blob.max_bytes_per_plugin` | 16 MiB | [4 KiB, 256 MiB] |

越界返 `412 Precondition Failed`。改后调 `POST /api/admin/settings/refresh` 立即生效（默认 5 分钟 TTL 自动刷新）。

---

## 现有插件向前兼容

**所有 v3.3 及以前的插件无需改动**：

- `config.get/set` 行为不变
- 新增的 quota（500 keys/plugin）默认远高于现实需求，不会触发
- 加密一直是默认开启的（v3.4 仅是把虚构注释改成准确表述）

如果你的插件曾经因为 64 KiB 上限做过 JSON-blob 拆 key 的 workaround，可以在 v3.4 改成 `data.put` 一次性存。

---

## Breaking changes

**无 breaking changes**。所有变化都是新增 API 或扩展契约。

---

## 参考实现

- [`blob-cache-demo/`](../../blob-cache-demo/) — 最小演示 `data.*` 的插件
- [`cookiecloud/`](../../cookiecloud/) — iframe UI + 内嵌 CryptoJS + 自定义 API 的综合示例（v3.4 不需要改，原文档里的 `notify/` 已在 v3.5 移入主仓 `internal/notify`）
- [`dashboard-stats/`](../../dashboard-stats/) — 现有 headless 插件（v3.4 不需要改）
