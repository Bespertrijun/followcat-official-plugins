# followcat/plugin-registry

FollowCat 插件市场的官方注册表。FollowCat 服务端按 [`marketplace_index_url`](./docs/plugins/marketplace.md) 拉取本仓的 `index.json`，从中浏览/安装插件。

## 仓库结构

```
plugin-registry/
├── index.json              # 注册表索引，FollowCat 服务端拉取的唯一文件（手写或 CI 生成）
├── SCHEMA.md               # index.json schema 完整说明（必读）
├── CODEOWNERS              # 防止恶意 PR 合并
├── README.md               # 本文件
├── requirements.txt        # 构建 + DevRT 的 Python 依赖
├── plugins/                # 所有插件源码（每个子目录 = 一个插件：manifest + index.js + README [+ ui/]）
│   ├── dashboard-stats/
│   ├── cookiecloud/
│   └── media-library-filter/
├── docs/plugins/           # SDK / 开发指南 / 市场 / schema 文档
├── scripts/build.py        # 构建脚本：扫描 plugins/ → 按 git tag 打包 zip + 计算 sha256 → 写 dist/index.json
├── devrt/                  # Plugin Dev Runtime：本地仿真宿主，无需启动 FollowCat 即可调试插件
└── .github/workflows/      # CI：PR 校验、push 到 main 部署 GitHub Pages、tag 触发 Release
```

## 使用方式

### 终端用户（FollowCat admin）

打开 FollowCat 管理页 → 插件市场 → 浏览/安装/升级。默认拉取 `https://raw.githubusercontent.com/followcat/plugin-registry/main/index.json`。

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
# 1. 修改 plugins/<plugin>/manifest.json + index.js + ui/，提交合并到 main
git add plugins/media-library-filter/ && git commit -m "media-library-filter: ..." && git push

# 2. 打 tag 并推送（决定发布版本号——build.py 只认最新 git tag，不看工作树里的 version）
git tag media-library-filter/v0.1.0
git push origin media-library-filter/v0.1.0

# 3. ⚠ 关键：打完 tag 后，再触发一次 main 构建，Pages 上的 index.json 才会更新到新版本
#    （空提交即可；原因见下方「顺序陷阱」）
git commit --allow-empty -m "chore(ci): 触发 main 构建发布 media-library-filter 0.1.0" && git push
```

之后 `.github/workflows/deploy.yml` 自动：
1. 用 `git archive` 从该 tag 抽出插件源码 → 打成 `dist/packages/media-library-filter/0.1.0/plugin.zip`
2. 计算 `zip_sha256` 与 `zip_size`，生成 `dist/index.json`
3. 把 `dist/` 部署到 GitHub Pages（FollowCat 服务端按 Pages URL 拉 `index.json`）
4. 创建 GitHub Release `media-library-filter/v0.1.0` 并附上 zip + sig（如配置签名）

> **⚠️ 顺序陷阱：打完 tag 必须再触发一次 `main` 构建，否则 Pages 上的版本指针不会更新。**
>
> 本仓的 GitHub Pages **只把 `main` 分支的部署提升为线上生效版**；tag 触发的构建虽然会产出新版 zip 并建好 GitHub Release，但它那次的 **Pages 部署不会生效**（job 仍报绿，容易误判）。而 `build.py` 的版本号取「最新 git tag」——若最后一次生效的 `main` 构建跑在新 tag 推送**之前**，它就按旧 tag 发布，Pages 便停在旧版本。
>
> 正确做法：**先打 tag，再让一次 `main` 构建跑起来**（上面步骤 3 的空提交；等价：Actions 里对 `main` 手动 `workflow_dispatch`，或重跑最近一次 `main` run）。**重跑 tag 工作流没用**——tag 部署永远不被提升为线上。GitHub Release + zip 不受影响，缺的只是 Pages 上 `index.json` 的版本指针。

### 本地预演构建

提交前可以本地跑构建，输出到 `dist/`：

```bash
pip install -r requirements.txt

# 校验 manifest 与 index.json 一致性（permissions / hooks / source_url 必须匹配，blocking）
python scripts/build.py --check

# 完整构建（需要先 git tag <plugin>/v<ver>，否则会被跳过）
python scripts/build.py
```

可选：设置 `SIGNING_KEY`（PEM 格式 Ed25519 私钥）环境变量或放在 `keys/private.pem`，构建时会同步生成 `plugin.sig`（M2 签名前瞻；未启用时不影响）。

### 不可变约束（CI 不会替你修复，自己注意）

- **`name` 和 `source_url` 一旦发布过就不要改** —— 它们联合派生 `plugin_id`，改动会让所有存量用户的"升级"变成"全新插件"，配置丢失
- **`permissions` 和 `hooks` 必须与对应 entry 的 manifest 一致**（顺序无关，集合相等），CI 的 `--check` 会提前 block 不一致的 PR

## 当前注册表内容

| 插件 | 版本 | 说明 |
|------|------|------|
| `dashboard-stats` | 1.0.0 | 仅暴露统计 API 端点（headless） |
| `media-library-filter` | 0.3.0 | 下载去重器：在 `should_download` hook 里拿种子 tags 与 Emby/Plex 库内副本按 7 维+3 种操作符（==/≥/regex）逐副本比对，库内已有同规格副本则跳过下载（fail-open / 3s 超时；要求 FollowCat ≥ v3.5） |
| `cookiecloud` | 1.0.0 | ⚠️ **草稿（未发布）** —— 从 CookieCloud server 同步浏览器 cookies 到 PT 站凭据；manifest 标 `"draft": true`，暂不进 `index.json`、不打包。其依赖的 `ui.embed` 已由主仓实现，技术阻塞已解除；走完发布流程（删 `draft` → 打 tag → CI 回填 `index.json`）即可上架 |

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

## ⚠️ 当前 index.json 状态

仓库根目录的 `index.json` 中各 entry 的 `zip_url` 与 `zip_sha256` 仍是占位值（64 个 0）。在创建第一个 git tag 让 CI 跑通之前，FollowCat 服务端**会拒绝安装**（sha256 不匹配实际 zip）。

**首次发布步骤**：

```bash
# 一次性给所有「正式」插件打 tag（cookiecloud 是 draft，跳过）
git tag dashboard-stats/v1.0.0
git tag media-library-filter/v0.1.0
git push origin --tags
```

`.github/workflows/deploy.yml` 会自动：
- 为每个 tag 跑构建 → 生成 zip + sha256
- 推 `dist/index.json` 到 GitHub Pages（取代根目录的占位 `index.json`）
- 为每个 tag 建 GitHub Release 并附上 zip / sig

之后把 FollowCat 管理页的 `index_url` 指向 `https://<owner>.github.io/<repo>/index.json`（CI 部署目标），用户即可看到全部真插件。
