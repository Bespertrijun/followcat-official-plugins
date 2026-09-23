# blob-cache-demo —— FollowCat v3.4 data.* API 演示

把番剧封面缓存到加密 blob 存储，演示 v3.4 新增的 `data.*` API。

**标签**：demo、v3.4、blob、data-api

> ⚠️ 这是教学示例，**不是生产插件**。仅展示 v3.4 `data.*` 的最小可用闭环：
> 监听 hook → 抓远程数据 → 存进加密 blob → 用 config 维护索引 → 暴露查询/清理 API。
> 真实生产应有：LRU 淘汰、多源 fallback、错误重试、增量更新。

## 能力

- ✅ `on_task_completed` 时自动拉取并缓存番剧封面
- ✅ 演示 `data.put / data.get / data.list / data.delete` 全套
- ✅ 演示 `config.list()`（v3.4 新）+ `config.get/set` 维护索引
- ✅ `/stats` 端点显示当前缓存数量、blob 列表、config keys
- ✅ `/clear` 端点一键清空所有缓存

## 配置

无需任何配置。安装启用即跑。

## API 端点

```bash
# 看缓存统计
curl -H "Authorization: Bearer <jwt>" \
  http://localhost:1009/api/plugins/<plugin-id>/api/stats
# → { cached_count: 3, blob_names: ["cover_42.jpg", ...], config_keys: ["cover_index"] }

# 清空缓存
curl -X POST -H "Authorization: Bearer <jwt>" \
  http://localhost:1009/api/plugins/<plugin-id>/api/clear
# → { deleted: 3 }
```

`<plugin-id>` 由 `sha1("https://plugins.followcat.io/blob-cache-demo\x00blob-cache-demo")[:16]` 派生，安装后管理页可见。

## 关键代码片段

### data.put — 严格类型，只接 ArrayBuffer / Uint8Array

```js
// ✅ 正确：bodyBytes 是 Uint8Array，.buffer 取 ArrayBuffer
data.put("cover_42.jpg", bodyBytes.buffer);

// ❌ 错误：会抛 TypeError
data.put("cover_42.jpg", "raw response body string");

// ❌ 错误：会抛 TypeError
data.put("cover_42.jpg", { foo: 1 });
```

### data.get — 返回 ArrayBuffer 或 null

```js
var buf = data.get("cover_42.jpg");
if (buf) {
  // 转回 string / 解 UTF-8 / base64 编码上传……
}
```

### config.list — 列举 keys（v3.4 新）

```js
var keys = config.list();  // ["cover_index"]
```

跨 plugin 隔离，只看到自己的 keys。

## v3.4 新 API 最低要求

需要 **FollowCat ≥ v3.4**（包含 phase1 + phase2 合并后的 release）。

**0.2.0 起**另需 **FollowCat 事件循环插件运行时**：`http.*` 现返回 Promise，封面下载改为 `await http.get(...)`（hook 回调为 `async`）。

| 用到的 API | v3.4 之前 | v3.4 之后 |
|---|---|---|
| `data.*` | ❌ 不存在 | ✅ |
| `config.list()` | ❌ 不存在 | ✅ |
| `Plugin.UninstallStatus` 字段 | ❌ | ✅ |

## 配额提醒

`data.*` 默认配额（admin 可调）：

- 单 blob ≤ 4 MiB（admin 可调到 64 MiB）
- 单 plugin 总和 ≤ 16 MiB（admin 可调到 256 MiB）

本 demo 限制单张封面 ≤ 200 KiB，按 4000 张番剧算总量约 800 MiB——会超 16 MiB 默认配额。生产场景必须做 LRU。

## 排错

| 现象 | 原因 | 修法 |
|------|------|------|
| 启用后无缓存 | 没触发过 `on_task_completed` | 等任意番剧追完，或手动 `/api/.../api/test`（本 demo 未提供 test 端点，需自加） |
| `cached_count` 涨但 `blob_names` 空 | data.* 配额已满，put 失败 | 调大 `plugin.blob.max_bytes_per_plugin` 或调 `/clear` |
| 始终 `cover too large` | demo 限 200 KiB，但 douban 大图 > 200 KiB | 改 `MAX_COVER_BYTES` 或换 thumb URL |

## 衍生练习

读懂本 demo 后可以试着改：

1. **加 LRU**：用 `data.list()` + `config.get` 拿时间戳，超额时删最旧
2. **改用 sandbox REST**：把 `/stats` 端点的 `blob_names` 替换成实际带预览的 base64 图片（iframe 用 fetch 走 `/sandbox/data/:name`）
3. **加 watchdog**：用 `plugin.registerAPI("/check")` 定期检查每个索引项的 blob 是否还在
