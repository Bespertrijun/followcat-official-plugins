# followcat-official-plugins

FollowCat 插件市场的官方注册表（GitHub：[`Bespertrijun/followcat-official-plugins`](https://github.com/Bespertrijun/followcat-official-plugins)）。FollowCat 服务端按 [`marketplace_index_url`](./docs/plugins/marketplace.md) 拉取本仓的 `index.json`，从中浏览/安装插件。

## 仓库结构

```
followcat-official-plugins/
├── index.json              # 手维护的「清单」：CI 用 build.py --check 核对它与各插件 manifest 一致（线上用的是 CI 生成的 dist/index.json）
├── SCHEMA.md               # index.json schema 完整说明（必读）
├── README.md               # 本文件
├── requirements.txt        # 构建 + DevRT 的 Python 依赖
├── plugins/                # 所有插件源码（每个子目录 = 一个插件：manifest + index.js + README [+ ui/]）
│   ├── dashboard-stats/
│   ├── cookiecloud/
│   └── media-library-filter/
├── docs/plugins/           # SDK / 开发指南 / 市场 / schema 文档
├── scripts/build.py        # 构建脚本：扫描 plugins/ → 按 git tag 打包 zip + 计算 sha256 → 写 dist/index.json
├── devrt/                  # Plugin Dev Runtime：本地仿真宿主，无需启动 FollowCat 即可调试插件
├── tests/                  # node --test 测试（按插件 / devrt 分目录）+ build.py 的 unittest
└── .github/workflows/      # CI：push tag 时跑测试 → 校验 → 构建 → 部署 GitHub Pages → 建 Release
```

## 使用方式

### 终端用户（FollowCat admin）

打开 FollowCat 管理页 → 插件市场 → 浏览/安装/升级。首次启动时宿主自动添加官方源 `https://Bespertrijun.github.io/followcat-official-plugins/index.json`（本仓 CI 部署到 GitHub Pages 的注册表，见下文「发布新版本」）。

### 自托管私有 registry

如果你想搭建私有 registry（公司内部插件）：
1. Fork 本仓或新建一个仓库，保持 `index.json` 同样的 schema
2. 把你自己的插件 zip 上传到任意 HTTPS 静态托管（GitHub Release / S3 / 内网 nginx）
3. 在 FollowCat 管理页「插件市场设置」中改 `index_url` 指向你的 `index.json`
4. 私网托管需勾选 `allow_private_hosts`（注意 SSRF 风险，详见 [marketplace.md](./docs/plugins/marketplace.md)）

## 本地开发与调试（DevRT）

无需启动完整的 FollowCat 主服务，使用内置的 **Plugin Dev Runtime** 即可在本地跑插件、触发 hook、调用 API、调试 UI iframe。

```bash
pip install -r requirements.txt
python devrt/server.py media-library-filter
# → 🐱 followcat plugin DevRT — http://127.0.0.1:9000
```

| 选项 | 说明 |
|------|------|
| `<plugin>` | 插件目录名（`dashboard-stats` / `cookiecloud` / `media-library-filter` / 自己的目录） |
| `--port 9100` | 改端口（默认 9000） |
| `--allow-http` | 允许 `http.*` 真实出网（默认 mock，仅打日志），调试 Telegram / Emby / Plex 等真实 HTTP 时打开 |
| `--persist` | 把 mock config 持久化到 `devrt/data/<plugin>/config.json`，重启不丢 |

**浏览器 UI 提供：**
- 每个已注册 hook 一个按钮，点击用内置示例 payload 一键触发；展开 "编辑 payload" 可改 JSON
- `plugin.registerAPI` 端点列表，点击立即调用并显示返回值
- mock config 编辑器（增 / 改 / 删 / 保存）
- 实时 SSE 日志流（`log.info / warn / error` 都会显示）
- 居中 iframe 加载 `<plugin>/ui/`，`FC.*` SDK 经 postMessage 完全工作

更多设计细节、与生产宿主的差异、已知限制见 [`devrt/README.md`](./devrt/README.md)。

## 发布新版本（自动化流程）

仓库使用 **git tag 驱动的自动化构建**，无需手动 zip + 计算 sha256。

### Tag 命名规范

`<插件目录名>/v<semver>`，例如 `media-library-filter/v0.1.0`、`dashboard-stats/v1.0.0`。

> 目录名指 `plugins/` 下的**叶子名**，tag **不带 `plugins/` 前缀**（构建脚本按叶子名匹配 tag、生成 zip_url，与目录是否嵌套无关）。

### 发布步骤

```bash
# 1. 修改 plugins/<plugin>/manifest.json（升 version）+ index.js + ui/，提交合并到 main
git add plugins/media-library-filter/ && git commit -m "media-library-filter: ..." && git push

# 2. 打 tag 并推送（决定发布版本号——build.py 只认最新 git tag，不看工作树里的 version）
git tag media-library-filter/v0.4.0
git push origin media-library-filter/v0.4.0
```

推送 tag 即触发 `.github/workflows/deploy.yml`（**只从 tag 发布**，一步完成，不需要再补 main 构建）：
1. 跑 `tests/` 下的测试与 `build.py --check --release-tag <本次 tag>`，有一项不过就不发布（「改了内容没升版本」只对本次 tag 的插件判失败，其它插件只警告，见下文）
2. 用 `git archive` 从每个插件的**最新** tag 抽出源码 → 打成 `dist/packages/<插件>/<版本>/plugin.zip`（历史版本的 zip 也一并重建）
3. 计算 `zip_sha256` 与 `zip_size`，生成 `dist/index.json`——entry 的权限 / hooks / 说明等字段**全部取自该 tag 里的 manifest**，与 zip 同源
4. 把 `dist/` 部署到 GitHub Pages（FollowCat 服务端按 Pages URL 拉 `index.json`）
5. 创建 GitHub Release `<插件>/v<版本>` 并附上 zip + sig（如配置签名）

> 旧版本工作流同时从 main 和 tag 部署 Pages，GitHub 只把 main 的部署当线上版，导致「打完 tag 还得补一次 main 构建」。现在改成 tag-only，这个坑已经不存在。

### 本地预演构建

提交前可以本地跑构建，输出到 `dist/`：

```bash
pip install -r requirements.txt

# 校验（blocking）：manifest 与 index.json 一致（permissions / hooks / source_url）；index.json 里一个插件只能有一条；
# HEAD 与某插件最新 tag 同版本号时，插件目录内容必须与 tag 完全相同（改了内容却没升版本 → 失败）
python scripts/build.py --check

# CI 发布时的口径：只有本次 tag 的插件「改了内容没升版本」才失败，其它插件只打 [warn]
python scripts/build.py --check --release-tag media-library-filter/v0.4.0

# 测试（CI 同款）
for f in tests/*/*.test.js devrt/*.test.js; do node --test "$f"; done
python3 -m unittest tests/build/test_build.py

# cookiecloud 设置页端到端（不进 CI；要 Playwright + chromium，脚本自己起 devrt 与假 CookieCloud，用法见文件头）
node tests/cookiecloud/ui-e2e.playwright.js

# 完整构建（需要先 git tag <plugin>/v<ver>，否则会被跳过）
python scripts/build.py
```

可选：设置 `SIGNING_KEY`（PEM 格式 Ed25519 私钥）环境变量或放在 `keys/private.pem`，构建时会同步生成 `plugin.sig`（M2 签名前瞻；未启用时不影响）。

### 不可变约束（CI 不会替你修复，自己注意）

- **`name` 和 `source_url` 一旦发布过就不要改** —— 它们联合派生 `plugin_id`，改动会让所有存量用户的"升级"变成"全新插件"，配置丢失
- **`permissions` 和 `hooks` 必须与对应 entry 的 manifest 一致**（顺序无关，集合相等），CI 的 `--check` 会在发布前拦下不一致的 tag
- **改了插件内容就要升版本**：HEAD 与最新 tag 同版本号但插件目录内容不同，`--check` 失败（HEAD 已升版本、还没打 tag 是正常开发状态，不算错）。CI 发布某个插件的 tag 时，这条只拦**这个插件**；别的插件在 main 上的半成品只打警告，不挡这次发布（本地无参数运行照旧全部拦）
- **一个插件在 index.json 里只能有一条 entry**：FollowCat 解析插件源时发现同一插件出现多次，整个源解析失败；`--check` 也会拦（`[dup]`）

## 当前注册表内容

| 插件 | 版本 | 说明 |
|------|------|------|
| `dashboard-stats` | 1.0.0（未发布：没打过 tag，不在线上注册表里） | 仅暴露统计 API 端点（headless） |
| `media-library-filter` | 0.4.0（开发中；已发布 0.3.3） | 下载去重器：在 `should_download` hook 里拿种子 tags 与 Emby/Plex 库内副本按 7 维+3 种操作符（==/≥/regex）逐副本比对，库内已有同规格副本则跳过下载（fail-open / 3s 超时；0.4.0 要求 FollowCat 事件循环插件运行时） |
| `cookiecloud` | 1.0.0（未发布） | 从自建 CookieCloud 同步浏览器 cookie 到 PT 站凭据与豆瓣 Cookie：两种加密方式都支持、本地解密（密码不出 FollowCat）、按各站 RSS 域名匹配 cookie、只写变了的、可定时自动同步（要求 FollowCat 宿主已开放定时器且 `ptsite.list` 带 `hosts`） |

> Slack / Telegram 通知业务自 FollowCat v3.5 起在主仓 `internal/notify` 内置；早期的 `notify` / `notify-telegram` / `notify-extension` 示例插件已从本仓删除（参考 git 历史）。

## 安全模型

- **sha256 必填**：FollowCat 下载 zip 后必须 hash 对得上才安装；防止 zip_url 中间人篡改
- **manifest 一致性**：服务端解 zip 后比对 manifest 与 index entry 的 `name` / `source_url` / `permissions` / `hooks`，不一致 block 安装（防止 registry 撒谎）
- **HTTPS only**（默认）：fetcher 默认 SSRF guard 拒绝 loopback / 私网；`allow_private_hosts` 是显式 opt-in
- **M2 路线图**：将引入 minisign 签名，签名 zip + 签名 index.json

## 相关文档

- [`SCHEMA.md`](./SCHEMA.md) — index.json schema 完整定义
- [`docs/plugins/marketplace.md`](./docs/plugins/marketplace.md) — 用户向使用文档
- [`docs/plugins/sdk.md`](./docs/plugins/sdk.md) — 插件作者 SDK 参考（含 v3.4 `data.*` / `config.list`，以及同步否决 hook `should_download` + `ruleflow.list`）
- [`docs/plugins/dev-guide.md`](./docs/plugins/dev-guide.md) — 插件开发实战教程
- [`docs/plugins/registry-schema.md`](./docs/plugins/registry-schema.md) — Registry schema 维护者参考
- [`docs/plugins/MIGRATION-v3.4.md`](./docs/plugins/MIGRATION-v3.4.md) — **v3.4 升级指南**（新 `data.*` API、配额可调、UninstallStatus）

## ⚠️ 根目录 index.json 不是线上注册表

仓库根目录的 `index.json` 是手维护的清单，各 entry 的 `zip_url` 与 `zip_sha256` 是占位值（64 个 0），**不能**拿来安装——FollowCat 下载 zip 后按 sha256 校验，对不上会拒绝安装。它的作用是让 CI 的 `build.py --check` 核对「每个插件的 manifest（权限 / hooks / source_url）与清单一致」。

线上注册表是 CI 生成并部署到 GitHub Pages 的 `dist/index.json`，FollowCat 管理页的 `index_url` 应指向 `https://<owner>.github.io/<repo>/index.json`（本仓即 `https://Bespertrijun.github.io/followcat-official-plugins/index.json`）。还没打过 tag 的插件（如 `cookiecloud`、`dashboard-stats`）不会出现在线上注册表里。
