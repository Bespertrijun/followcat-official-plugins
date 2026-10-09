# FollowCat 插件市场（Marketplace M0）

> 本文是面向普通用户的操作指南。插件作者发布流程见 [`registry-schema.md`](./registry-schema.md)；SDK 开发参考见 [`sdk.md`](./sdk.md)。

---

## 概览

插件市场是 FollowCat 内置的插件发现与一键安装入口。它从一个 **HTTPS 静态 registry**（`index.json`）拉取插件目录，在管理页以卡片形式展示，支持直接安装、升级，以及安装前的 manifest 一致性校验。

与手动 zip 上传的区别：

| | 手动上传 zip | 插件市场安装 |
|---|---|---|
| 来源 | 本地文件 | Registry index → HTTPS zip |
| sha256 校验 | 无 | **强制**（zip_sha256 必填） |
| manifest diff 检查 | 无 | **强制**（blocking 不一致禁止安装） |
| 升级 | 手动重新上传 | 管理页一键升级 |

---

## 浏览插件

1. 打开 FollowCat → 管理页（admin 权限）→ **插件** → **市场** 标签。
2. 首次进入若缓存为空，点击「**刷新目录**」拉取最新 index。
3. 每张卡片显示：插件名称、版本、作者、简介、权限列表。
4. 已安装的插件会显示当前版本；有新版本时右上角出现升级角标。

---

## 安装插件

1. 在市场卡片上点击「**安装**」。
2. 系统弹出**安装预览**对话框，显示：
   - Registry 声明的 entry 信息（name / version / source_url / permissions / hooks）
   - 实际从 zip 解析出的 manifest 内容
   - **manifest_diff**：对比两者的差异
   - 插件声明的通知交互：动作按钮（名字、说明、谁能点）与 Telegram bot 命令（`/完整名`、说明、谁能用）；升级时标出新增、删除与权限要求的变化

### sha256 与 manifest 一致性说明

- 服务器会先对下载的 zip 计算 SHA-256，与 registry entry 中的 `zip_sha256` 比对。**checksum 不一致时直接拒绝，不会解析 zip 内容。**
- sha256 通过后，解析 `manifest.json` 并与 entry 对比以下字段：
  - `name`、`source_url` — 身份字段，不一致即 **blocking**
  - `permissions`、`hooks` — 安全字段，不一致即 **blocking**
  - `version` — 非 blocking（允许 entry 版本与 manifest 不同，仅展示）

3. 若 `manifest_diff.blocking == true`，安装按钮变为**禁用**，提示具体不一致的字段。此时只能联系插件作者修正 registry 条目。
4. `blocking == false` 时点击「**确认安装**」完成安装，插件自动出现在已安装列表。

### 安装结果：已安装，但启用失败

安装 / 升级（市场与本地上传 zip 都一样）的结果按插件**实际是否在运行**提示：

- 文件替换成功、插件也启动了 → 「已安装」。
- 文件已经替换成新版本，但新版本**启用失败**（如入口脚本 10 秒没跑完、入口脚本里宿主出错）→ 这**不算安装失败**：提示「已安装，但启用失败：原因」，插件留在已安装列表里、处于停用状态，原因也写进插件详情的最近错误。修好后重新启用即可，不用重装。接口上是 HTTP 200，响应里 `enabled: false`、`enable_error` 为原因（市场升级的响应也从 `{plugin_id}` 变成 `{plugin_id, enabled, enable_error?}`）。
- 安装前的校验（下载、sha256、zip 结构、manifest 一致性）都在停掉旧版本**之前**做完；停掉旧版本之后才失败的，旧版本原来的运行状态会恢复。

预览对话框里的「当前已启用」指的是这个插件**现在是否在运行**（覆盖安装会沿用它）。

### zip 结构要求

zip 内每个条目的路径都要安全（不能有 `..`、绝对路径），归一化之后**不能重名**（例如同时有 `manifest.json` 和 `./manifest.json`、或同名文件出现两次）——有任何重复，整个 zip 直接被拒绝（`duplicate entry "..."`），预览与安装都一样。`ui/` 下只允许界面资源（`.html` `.css` `.js` `.json` `.map` `.txt`、`.svg` `.png` `.jpg` `.jpeg` `.gif` `.webp`、`.woff` `.woff2`）；单文件 ≤ 5 MiB、解压总大小 ≤ 20 MiB、最多 200 个条目。

### 同名插件只能装一个

已经装了一个 `name` 相同、但来源（`source_url`）不同的插件时，预览和安装都会被拒（HTTP 409）：「已安装同名插件「<name>」（来自 <已装那个的 source_url>），请先卸载它」。先卸载旧的再装。同一来源的升级 / 重装不受影响。

---

## 升级插件

当 registry 中同一插件（由 `source_url + name` 联合确定身份，AD4 不可变 identity）有更高版本时，市场卡片和已安装列表均会出现**升级角标**。

升级流程：

1. 点击「**升级**」。
2. 系统重新走完整安装流程（下载 zip → sha256 校验 → manifest diff）。
3. blocking diff 同样会阻止升级。
4. 升级成功后版本号更新，配置数据**保留不丢失**。

> **AD4 不可变 identity 规则**：`plugin_id = sha1(source_url + "\x00" + name)[:16]`。若 entry 的 `source_url` 或 `name` 发生变化，系统视其为**不同插件**，不会出现在旧插件的升级列表中。

---

## 自托管私有 Registry

可以将 FollowCat 配置为使用自建的私有 registry：

1. 管理页 → 插件 → 市场 → **设置**。
2. 修改 `index_url` 为自建服务的 HTTPS 地址。
3. 如需访问局域网地址，开启 `allow_private_hosts`（**生产环境请谨慎**：这会绕过 SSRF 防护，允许服务器访问内网地址）。
4. 可调整 `cache_ttl_seconds`（默认 900 秒 / 15 分钟）控制缓存刷新频率。

index.json 格式说明见 [`registry-schema.md`](./registry-schema.md)。

---

## index.json 字段速查

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | `[a-z0-9-]{3,64}` |
| `version` | ✅ | semver-ish：`X.Y.Z[-prerelease]` |
| `source_url` | ✅ | 与 manifest 中的 `source_url` **必须完全一致**（身份字段） |
| `zip_url` | ✅ | HTTPS URL，服务器端下载并校验 |
| `zip_sha256` | ✅ | **64 位小写十六进制 SHA-256**，格式错误直接拒绝 |
| `permissions` | ✅ | 必须与 zip manifest 声明一致，否则 blocking |
| `hooks` | ✅ | 同上 |
| `author` | 可选 | 显示用 |
| `description` | 可选 | 卡片简介 |
| `homepage_url` | 可选 | 外链 |
| `icon` | 可选 | emoji 或 HTTPS 图片 URL |
| `zip_size` | 可选 | 预估大小（字节），以实际 Content-Length 为准 |
| `published_at` | 可选 | RFC3339 时间戳 |

---

## 常见错误

### "registry unreachable"

服务器无法访问 `index_url`。可能原因：
- 网络不通或域名解析失败
- `allow_private_hosts=false` 时尝试访问了内网地址（SSRF 防护拦截）
- index 服务器返回非 200 状态码

此时管理页会展示上次成功缓存的内容（若有），并在顶部提示 stale 警告。

### "checksum mismatch"

zip 文件的实际 SHA-256 与 registry entry 中 `zip_sha256` 不一致。可能原因：
- zip 文件被篡改或传输损坏
- registry 维护者上传了新 zip 但没有更新 `zip_sha256`

解决方案：联系 registry 维护者重新计算并更新 `zip_sha256`。

### "duplicate plugin ..."

registry 的 `index.json` 里同一个插件出现了不止一条 entry，整个源解析失败（一个插件只能有一条，见 [`registry-schema.md`](./registry-schema.md#一个插件只能有一条-entry)）。解决方案：联系 registry 维护者删掉多余的 entry。

### "manifest diff blocking"

zip 内的 `manifest.json` 与 registry entry 声明的 `permissions` / `hooks` / `name` / `source_url` 不一致。这是安全拦截，防止 registry 声明了一套权限、zip 里实际申请另一套权限。

解决方案：联系插件作者同步 manifest 与 registry entry，或由 registry 维护者更新 entry。

---

## M1/M2 路线图

- **M1**（计划中）：插件评分、安装量统计、按 tag 筛选、官方精选列表
- **M2**（计划中）：`minisign` 签名验证、多 registry 来源、离线模式

> 当前 M0 版本不需要签名；M2 后可用 minisign 对 zip 和 index 签名，详见届时发布的文档。
