# Plugin Registry Schema（Registry 维护者参考）

> 本文面向自托管 plugin registry 的维护者。用户侧安装/升级操作说明见 [`marketplace.md`](./marketplace.md)。

---

## index.json 完整 Schema

```json
{
  "version": 1,
  "updated_at": "2026-05-01T00:00:00Z",
  "entries": [
    {
      "name":         "notify",
      "version":      "1.1.0",
      "author":       "FollowCat Team",
      "description":  "多渠道通知插件",
      "source_url":   "https://github.com/followcat/plugin-notify",
      "homepage_url": "https://github.com/followcat/plugin-notify#readme",
      "icon":         "🔔",
      "zip_url":      "https://github.com/followcat/plugin-notify/releases/download/v1.1.0/notify-1.1.0.zip",
      "zip_size":     81920,
      "zip_sha256":   "a3f1c2d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      "permissions":  ["hook.download.read", "hook.link.read", "hook.task.read", "api.http", "ui.embed"],
      "hooks":        ["on_download_done", "on_link_done", "on_task_completed"],
      "published_at": "2026-05-01T00:00:00Z"
    }
  ]
}
```

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | `int` | ✅ | Schema 版本，M0 固定为 `1` |
| `updated_at` | `string` | ✅ | RFC3339 时间戳，表示本次 index 更新时间 |
| `entries` | `array` | ✅ | 插件条目列表，最多 500 条；**一个插件（按 `name`）只能有一条**（见下） |

### entry 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✅ | 匹配 `[a-z0-9-]{3,64}`，与 manifest.json 中的 `name` 必须完全一致 |
| `version` | `string` | ✅ | semver-ish（`X.Y.Z[-prerelease]`），与 manifest 版本必须一致（否则展示 diff，非 blocking） |
| `source_url` | `string` | ✅ | 与 manifest.json 中的 `source_url` 必须完全一致（**身份字段，blocking**） |
| `zip_url` | `string` | ✅ | HTTPS URL，FollowCat 服务端直接下载（不经过浏览器） |
| `zip_sha256` | `string` | ✅ | **64 位小写十六进制 SHA-256**；格式不合法或与实际 zip 不符时请求被拒绝 |
| `permissions` | `[]string` | ✅ | 必须与 manifest `permissions` 集合完全一致（顺序无关，**blocking**） |
| `hooks` | `[]string` | ✅ | 必须与 manifest `hooks` 集合完全一致（顺序无关，**blocking**） |
| `author` | `string` | 可选 | 作者信息，仅展示 |
| `description` | `string` | 可选 | 插件简介，显示在市场卡片 |
| `homepage_url` | `string` | 可选 | 文档/GitHub 链接 |
| `icon` | `string` | 可选 | emoji 或 HTTPS 图片 URL |
| `zip_size` | `int64` | 可选 | 预估字节数（advisory），实际以 Content-Length 为准 |
| `published_at` | `string` | 可选 | RFC3339 时间戳 |

### 一个插件只能有一条 entry

index 只描述每个插件**当前发布的那一个版本**：同一个 `name` 在 `entries` 里出现多次，FollowCat 解析这个源时**整个源失败**（与其它字段校验一样严格），报错点名重复的插件：

```
duplicate plugin "media-library-filter": entry[0] and entry[3] (a plugin may appear only once per index)
```

要发新版本就改那一条 entry 的 `version` / `zip_url` / `zip_sha256`，不要追加一条。本仓的 `python scripts/build.py --check` 也会检查根目录 `index.json` 有没有重复 entry（`[dup]`，失败）；CI 生成的 `dist/index.json` 本来就每个插件一条（取最新 tag）。

---

## 如何计算 zip_sha256

打包完 zip 后运行：

```bash
# Linux / macOS
sha256sum notify-1.1.0.zip | awk '{print $1}'

# Windows PowerShell
(Get-FileHash notify-1.1.0.zip -Algorithm SHA256).Hash.ToLower()
```

将输出的 64 位小写十六进制字符串填入 `zip_sha256`。

> **重要**：每次修改 zip 内容（即使只改了一行 JS）都需要重新计算 sha256 并更新 index.json。

---

## 发布流程（PR 模板）

手工维护一个 registry 时的流程（本仓 `Bespertrijun/followcat-official-plugins` 不走这套：推 `<插件>/v<版本>` tag 后由 CI 自动打包、算 sha256、生成并发布 `index.json`，见根目录 README「发布新版本」）：

1. **打包 zip**（zip 根目录直接是 `manifest.json` 和 `index.js`；带 UI 的插件请保留 `ui/` 子路径，不要用 `-j`）：
   ```bash
   # 无 UI 的插件：用 -j 把文件平铺到 zip 根
   zip -j media-library-filter-0.1.0.zip media-library-filter/manifest.json media-library-filter/index.js

   # 带 UI 的插件：保留目录结构（cd 进插件目录或省略 -j）
   ( cd cookiecloud && zip -r ../cookiecloud-1.0.0.zip manifest.json index.js ui )
   ```

2. **上传到 GitHub Release**（或任意 HTTPS 静态托管）并获得直链。

3. **计算 sha256**：
   ```bash
   sha256sum media-library-filter-0.1.0.zip | awk '{print $1}'
   ```

4. **提 PR 到 index.json**，更新或新增对应 entry：
   - 版本升级时，更新 `version`、`zip_url`、`zip_sha256`
   - 新插件时，新增完整 entry
   - **严禁修改已发布 entry 的 `name` 或 `source_url`**（会破坏 plugin_id 导致存量用户升级失效）

5. PR 描述须包含：
   - 变更原因（功能/修复/安全）
   - sha256 计算命令与输出
   - 与旧版本的 diff（permissions/hooks 有变化时重点说明）

---

## CODEOWNERS 提醒

建议在 plugin-registry 仓库根目录设置 `CODEOWNERS`，确保每个插件只有其维护者可以自主合并自己的 entry，index.json 整体变更需要 registry 管理员审核：

```
# CODEOWNERS
/index.json  @registry-admin
```

---

## M2 签名前瞻

M2 版本计划引入 [minisign](https://jedisct1.github.io/minisign/) 签名：

- 每个 zip 附带 `.minisig` 签名文件
- index.json 整体由 registry 管理员签名
- FollowCat 服务端验证签名后才允许安装

M2 前的 M0/M1 版本**不需要签名**，依赖 sha256 + HTTPS 保证完整性。
