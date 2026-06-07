# cookiecloud —— FollowCat Cookie 同步插件

从自托管的 [CookieCloud](https://github.com/easychen/CookieCloud) 服务器定期拉取浏览器同步的 cookies，解密后按域名映射规则写入 PT 站凭据。

## 能力

- ✅ 从 CookieCloud 服务器拉取加密的浏览器 cookie 数据
- ✅ 使用 AES-256-CBC 解密（内嵌 CryptoJS）
- ✅ 按配置的域名→site_id 映射规则分配 cookie
- ✅ 写入 FollowCat 的 `site_cookie_<site_id>` 以供 PT 框架使用
- ✅ 手动同步触发 + 外部 cron 自动化支持
- ✅ 完整同步统计（最后同步时间、成功/失败次数、错误日志）
- ✅ 敏感凭据自动加密存储（cloud_uuid、cloud_pwd）

## 安装

1. 把 `manifest.json` + `index.js` + `ui/` 打包成 zip（zip 根直接包含这三项）
2. 管理页 → 插件 → 上传 zip → 启用

## 配置

在管理页插件详情页的「配置」区写入。**敏感字段必须勾选 `is_secret`**（cloud_uuid、cloud_pwd）。

| key | 是否必填 | 是否 secret | 说明 |
|-----|---------|------------|------|
| `host` | ✅ | 否 | CookieCloud 服务器根 URL（如 `https://cc.example.com`） |
| `cloud_uuid` | ✅ | ✅ | CookieCloud 用户 UUID（解密密钥派生原料） |
| `cloud_pwd` | ✅ | ✅ | CookieCloud 端到端密码（浏览器扩展中设置的密码） |
| `site_map` | ✅ | 否 | JSON 字符串：`{"domain.com": "site_id", ...}` — 域名到 FollowCat site_id 的映射 |
| `last_synced_at` | 否 | 否 | RFC3339 格式时间戳，最后成功同步的时间（自动更新）|
| `last_error` | 否 | 否 | 最后一次失败的错误信息（自动更新） |
| `synced_count` | 否 | 否 | 历史成功同步总次数（自动更新） |

## 工作流程

### 第一次配置

1. 访问 CookieCloud 官网或自托管实例获取个人的 UUID 和端到端密码
2. 在插件配置页填写 host、cloud_uuid、cloud_pwd 和 site_map
3. 保存配置（注意标记敏感字段）
4. 点击「立即同步」按钮测试连接

### 日常使用

**手动同步**：任何时刻可在插件详情页点「立即同步」按钮，拉取最新 cookies

**自动同步**：使用系统 cron 定期触发 plugin API 端点（参考下文 API 文档）

### site_map 配置示例

```json
{
  "hhub.example.com": "hhub",
  "u2.example.com": "ubits",
  "pt.tracker.com": "mypts"
}
```

CookieCloud 中若存在这些域名的 cookies，同步时会被写入对应的 `site_cookie_hhub`、`site_cookie_ubits` 等 FollowCat AppSetting 键。

## API 端点

### 手动同步

```bash
curl -X POST -H "Authorization: Bearer <jwt>" \
  http://localhost:1009/api/plugins/<plugin-id>/api/sync
```

响应：
```json
{
  "ok": true,
  "written": 3
}
```

或失败时：
```json
{
  "ok": false,
  "error": "decrypt failed: ..."
}
```

### 查看状态

```bash
curl -H "Authorization: Bearer <jwt>" \
  http://localhost:1009/api/plugins/<plugin-id>/api/status
```

响应：
```json
{
  "configured": true,
  "last_synced_at": "2026-05-08T10:30:00Z",
  "last_error": "",
  "synced_count": 5
}
```

`<plugin-id>` 在管理页插件详情可见，由 `sha1(source_url + "\x00" + name)[:16]` 派生。本插件默认是 `sha1("https://plugins.followcat.io/cookiecloud\x00cookiecloud")[:16]`。

## 外部 Cron 自动同步

若要在系统级定期自动同步，可用 cron 或任务计划程序调用 API 端点。

**Linux/macOS cron 示例**：

```bash
# 每小时整点同步一次
0 * * * * curl -X POST -H "Authorization: Bearer ${FC_TOKEN}" \
  http://localhost:1009/api/plugins/<plugin-id>/api/sync
```

**Windows 任务计划程序示例**：

创建一个批处理脚本（如 `sync-cookies.bat`）：

```batch
@echo off
curl -X POST -H "Authorization: Bearer <jwt>" ^
  http://localhost:1009/api/plugins/<plugin-id>/api/sync
```

然后在「任务计划程序」中新建计划任务，设置周期（如每小时）执行该脚本。

## 排错

| 现象 | 可能原因 | 修法 |
|------|---------|------|
| 「配置缺失」或无法保存 | host / cloud_uuid / cloud_pwd 未填全 | 检查所有必填项 |
| 同步失败 - 「server 4xx」 | host URL 错 / 服务器拒绝连接 | 确认 CookieCloud 服务器地址、网络连接 |
| 同步失败 - 「decrypt failed」 | cloud_uuid 或 cloud_pwd 错误 | 重新确认 CookieCloud 用户凭据 |
| 同步失败 - 「site_map JSON 无效」 | site_map 字段不是合法 JSON | 检查 JSON 格式（可用 JSON 验证工具）|
| 同步成功但没有写入任何 site | site_map 中的域名不在 CookieCloud 数据里 | 确认浏览器扩展已在这些网站同步 cookie |
| 状态页无反应 | 插件未启用或 JWT token 过期 | 刷新页面，或用 `/api/status` 端点手动检查 |

## 开发者说明

### 内嵌 CryptoJS

plugin runtime 不暴露任何加密 API，因此本插件在 `index.js` 顶部内嵌了 CryptoJS 的子集（MD5 + AES-256-CBC + EVP_BytesToKey），约 1000 行代码。这使得解密逻辑完全自洽，无需宿主依赖。

### 权限声明

```json
"permissions": ["api.http", "ui.embed"]
```

- `api.http`：用于向 CookieCloud 服务器发起 HTTP 请求
- `ui.embed`：用于在插件详情页嵌入配置 UI

### 数据流

```
CookieCloud Server
        ↓ (HTTP GET)
    加密 payload
        ↓ (内嵌 CryptoJS 解密)
    明文 JSON
        ↓ (按 site_map 映射)
site_cookie_<site_id> (写入 AppSetting)
        ↓
  PT 框架读取并使用
```

## 常见问题

**Q：支持周期同步吗？**

A：v1 不支持 plugin runtime 内的 cron hook。请用系统 cron 或任务计划程序定期调用 `/api/sync` 端点，或改为手动在需要时点击「同步」按钮。

**Q：CookieCloud 密码会被加密吗？**

A：会。在保存配置时，标记为 `is_secret=true` 的字段（`cloud_uuid` 和 `cloud_pwd`）会被 FollowCat 使用 AES-256-GCM 加密后存储在数据库中。

**Q：多个 FollowCat 实例可以共享同一个 CookieCloud 账户吗？**

A：可以。每个实例都有独立的 plugin config，可以指向同一个 CookieCloud server，只要凭据相同即可。

**Q：如果 CookieCloud 中的域名被我删除了，之前写入的 cookie 会被清除吗？**

A：不会。本插件仅负责同步写入，不会主动删除。若要清理过期的 site cookie，需要在 FollowCat 管理页手动删除对应的 `site_cookie_<site_id>` 键。

**Q：支持多个 site_map 配置吗？**

A：目前不支持。插件维护单一的 `site_map` JSON。如需为不同用户或不同场景分组，请创建多个 CookieCloud 插件实例，每个配置不同的 site_map。
