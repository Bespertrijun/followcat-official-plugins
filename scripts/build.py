"""
followcat-official-plugins 构建脚本
====================================

扫描 plugins/ 下所有插件（含 manifest.json 的目录），按 git tag 抽取对应版本的源码，
打包成 zip，计算 sha256，生成 dist/index.json（符合 SCHEMA.md 定义的 followcat
plugin-registry schema v1）。

设计要点（参考 drivecat-official-plugins/scripts/build.py，适配 followcat schema）：

- 版本号来自 git tag：tag 命名规范 `<plugin_dir>/v<semver>`，例 `media-library-filter/v0.1.0`。
  没有 tag 的插件会被跳过（避免误发未冻结的代码）。
- entry 的**所有字段**（name / author / description / source_url / homepage_url / icon / permissions /
  hooks）都读**最新 tag 里的 manifest**，与 zip 同源——HEAD 上已经改了权限但还没打新 tag 时，
  发布出去的仍是旧 zip，entry 必须如实描述旧 zip（宿主安装时会核对 zip 内 manifest 与 entry）。
- 历史版本可重建：每个 tag 都用 `git archive` 抽取一份 zip，落到
  `dist/packages/<name>/<version>/plugin.zip`，老版本永远可下载。
- index.json 只暴露每个插件的最新版本（符合现有 schema），但 zip 仍保留全部历史。
- zip 内保留目录结构（不使用 `zip -j`），确保 `ui/index.html` 等子路径能被宿主正确加载。
- zip_sha256 必填（schema blocking）；可选 Ed25519 签名（M2 前瞻），通过环境变量
  `SIGNING_KEY` 或 `keys/private.pem` 提供，签名文件写到 zip 同目录的 `plugin.sig`，
  不进入 index.json（避免与现有 schema 冲突）。
- BASE_URL 环境变量决定 zip_url 前缀。默认 GitHub Pages 风格相对路径，CI 会注入完整 URL。

用法：

    python scripts/build.py              # 构建所有有 tag 的插件
    python scripts/build.py --check      # 校验（不写文件）：manifest 与 index.json 一致；
                                         # index.json 里一个插件只能有一条 entry；
                                         # HEAD 与最新 tag 同版本号时插件目录内容也必须相同
    python scripts/build.py --check --release-tag media-library-filter/v0.4.0
                                         # CI 发布用：「同版本内容不同」只对这个 tag 的插件判失败，
                                         # 其它插件只打警告（它们这次不发布，HEAD 上的半成品不该拦别人发版）；
                                         # 传空串（手动触发、不是 tag 构建）= 所有插件都只警告
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
PLUGINS_DIR = ROOT / "plugins"
PRIVATE_KEY_PATH = ROOT / "keys" / "private.pem"

# zip 内忽略的内部目录
SKIP_PARTS = {"__pycache__", ".git", ".DS_Store"}

# Schema 强约束：每条 entry 必须出现并与 manifest 完全一致的字段（顺序无关）
ENTRY_BLOCKING_FIELDS = ("name", "source_url", "permissions", "hooks")


# ─────────────────────── 工具函数 ───────────────────────


def _git(*args: str, cwd: Path = ROOT, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


def _git_bytes(*args: str, cwd: Path = ROOT) -> bytes:
    """运行 git 并返回 stdout 原始字节（不做文本解码）。"""
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    if res.returncode != 0:
        return b""
    return res.stdout


def _iter_plugin_dirs() -> Iterable[Path]:
    if not PLUGINS_DIR.is_dir():
        return
    for p in sorted(PLUGINS_DIR.iterdir()):
        if not p.is_dir() or p.name.startswith("."):
            continue
        if (p / "manifest.json").exists():
            yield p


# ─────────────────────── 版本号（基于 git tag） ───────────────────────


_TAG_RE = re.compile(r"^([a-z0-9-]+)/v(.+)$")


def _get_tags_for_plugin(plugin_name: str) -> List[Tuple[str, str]]:
    """返回 [(tag, version), ...] 按语义版本降序。"""
    res = _git("tag", "--list", f"{plugin_name}/v*", "--sort=-v:refname")
    if res.returncode != 0 or not res.stdout.strip():
        return []
    out: List[Tuple[str, str]] = []
    for line in res.stdout.strip().splitlines():
        m = _TAG_RE.match(line.strip())
        if m and m.group(1) == plugin_name:
            out.append((line.strip(), m.group(2)))
    return out


# ─────────────────────── 签名（可选） ───────────────────────


def _load_private_key():
    """优先 env SIGNING_KEY（PEM 文本），其次 keys/private.pem。"""
    pem = os.environ.get("SIGNING_KEY")
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
    except ImportError:
        if pem or PRIVATE_KEY_PATH.exists():
            print("  ! cryptography 未安装但提供了私钥；跳过签名（pip install cryptography）")
        return None

    if pem:
        return load_pem_private_key(pem.encode(), password=None)
    if PRIVATE_KEY_PATH.exists():
        return load_pem_private_key(PRIVATE_KEY_PATH.read_bytes(), password=None)
    return None


def _sign_bytes(data: bytes, private_key) -> bytes:
    digest = hashlib.sha256(data).digest()
    return private_key.sign(digest)


# ─────────────────────── 打包 ───────────────────────


def _pack_zip_for_tag(repo_rel: str, version: str, tag: str, out_zip: Path) -> bool:
    """从 git tag 抽取插件目录（repo_rel 形如 plugins/<name>），注入版本号到 manifest，打包到 out_zip。"""
    out_zip.parent.mkdir(parents=True, exist_ok=True)

    archive = _git_bytes("archive", "--format=tar", tag, "--", f"{repo_rel}/")
    if not archive:
        return False

    manifest_blob = _git_bytes("show", f"{tag}:{repo_rel}/manifest.json")
    if not manifest_blob:
        return False
    manifest = json.loads(manifest_blob.decode("utf-8"))
    manifest = {**manifest, "version": version}

    prefix = f"{repo_rel}/"
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r") as tar:
            for m in tar.getmembers():
                if not m.isfile() or not m.name.startswith(prefix):
                    continue
                rel = m.name[len(prefix):]
                if not rel or rel == "manifest.json":
                    continue
                if any(part in SKIP_PARTS for part in Path(rel).parts):
                    continue
                f = tar.extractfile(m)
                if f is not None:
                    zf.writestr(rel, f.read())
        # 注入注满版本号的 manifest，避免 tag 内 manifest.version 漂移
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    return True


def _sha256_hex(path: Path) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def _read_manifest(plugin_dir: Path) -> dict:
    return json.loads((plugin_dir / "manifest.json").read_text(encoding="utf-8"))


def _manifest_at(ref: str, repo_rel: str) -> Optional[dict]:
    """读某个 git ref（tag / HEAD）里的 manifest.json；不存在或解析失败返回 None。"""
    blob = _git_bytes("show", f"{ref}:{repo_rel}/manifest.json")
    if not blob:
        return None
    try:
        return json.loads(blob.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _is_draft(manifest: dict) -> bool:
    """manifest 里 draft=true 的插件视为「未发布草稿」：不进 index、不打包，--check 也不要求其有 entry。

    用途：插件已写好但依赖的宿主能力还没发布（例如要等宿主开放某个新 facade / 权限），
    需要留在仓库当参考实现，但不能进注册表。删掉 draft 字段即转为正式发布。
    """
    return bool(manifest.get("draft", False))


def _check_version_bumped(plugin_dir: Path, head_manifest: dict) -> List[str]:
    """HEAD 与最新 tag 同版本号时，插件目录内容必须与 tag 完全相同（改了内容就得升版本）。

    正常开发状态「HEAD 已升版本、还没打 tag」不算错；没有 tag 的插件也不查。
    比较的是已提交的 HEAD（工作树里未提交的改动不看）。
    """
    tags = _get_tags_for_plugin(plugin_dir.name)
    if not tags:
        return []
    tag, tag_version = tags[0]
    repo_rel = plugin_dir.relative_to(ROOT).as_posix()
    head_committed = _manifest_at("HEAD", repo_rel)
    head_version = (head_committed or head_manifest).get("version")
    if head_version != tag_version:
        return []
    res = _git("diff", "--quiet", tag, "HEAD", "--", f"{repo_rel}/")
    if res.returncode == 0:
        return []
    changed = _git("diff", "--name-only", tag, "HEAD", "--", f"{repo_rel}/").stdout.split()
    return [
        f"  HEAD 与最新 tag {tag} 同为 v{tag_version}，但插件内容不同（改了内容却没升版本）：",
        *[f"    {c}" for c in changed],
    ]


# ─────────────────────── 校验 ───────────────────────


def _check_manifest_vs_entry(manifest: dict, entry: dict) -> List[str]:
    """检查 schema blocking 字段一致性，返回错误列表。"""
    errors: List[str] = []
    for field in ENTRY_BLOCKING_FIELDS:
        m_val = manifest.get(field)
        e_val = entry.get(field)
        if isinstance(m_val, list) and isinstance(e_val, list):
            if sorted(m_val) != sorted(e_val):
                errors.append(f"  {field}: manifest={m_val} index={e_val}")
        elif m_val != e_val:
            errors.append(f"  {field}: manifest={m_val!r} index={e_val!r}")
    return errors


def _duplicate_entry_names(entries: List[dict]) -> List[str]:
    """index.json 里出现不止一次的插件名（按首次出现顺序）。宿主解析 index 时同样拒绝：一个插件只能有一条。"""
    seen: dict = {}
    for e in entries:
        name = e.get("name") if isinstance(e, dict) else None
        seen[name] = seen.get(name, 0) + 1
    return [n for n, c in seen.items() if c > 1]


def _release_plugin(release_tag: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """解析 --release-tag：返回 (插件目录名, 错误)。None = 本地运行（没传），"" = 传了空串（非 tag 构建）。"""
    if release_tag is None:
        return None, None
    tag = release_tag.strip()
    if tag.startswith("refs/tags/"):
        tag = tag[len("refs/tags/"):]
    if tag == "":
        return "", None
    m = _TAG_RE.match(tag)
    if not m:
        return None, f"--release-tag {release_tag!r} 不是 <插件目录>/v<版本> 形式"
    return m.group(1), None


def cmd_check(release_tag: Optional[str] = None) -> int:
    """校验现有 index.json 与各插件 manifest.json 一致性、entry 不重复，以及「改了内容就得升版本」。

    release_tag 为 None（本地无参数运行）：「改了内容没升版本」对所有插件都判失败。
    release_tag 给出时（CI 发布）：只对该 tag 对应的插件判失败，其它插件只打警告；空串 = 全部只警告。
    """
    index_path = ROOT / "index.json"
    if not index_path.exists():
        print("index.json 不存在")
        return 1

    release_plugin, tag_err = _release_plugin(release_tag)
    if tag_err:
        print(tag_err)
        return 1

    index = json.loads(index_path.read_text(encoding="utf-8"))
    entries = index.get("entries", [])
    fail = False
    dups = _duplicate_entry_names(entries)
    if dups:
        for n in dups:
            print(f"  [dup]     {n} 在 index.json 里出现了不止一次（一个插件只能有一条 entry）")
        fail = True
    entries_by_name: dict = {}
    for e in entries:
        entries_by_name.setdefault(e.get("name"), e)

    if release_plugin and not (PLUGINS_DIR / release_plugin / "manifest.json").exists():
        print(f"  [missing] --release-tag 指向的插件 plugins/{release_plugin} 不存在")
        fail = True

    for plugin_dir in _iter_plugin_dirs():
        manifest = _read_manifest(plugin_dir)
        name = manifest["name"]
        if _is_draft(manifest):
            print(f"  [draft]   {name} — 草稿（未发布），跳过校验")
            continue
        entry = entries_by_name.get(name)
        if entry is None:
            print(f"  [missing] {name} 在 index.json 中没有对应 entry")
            fail = True
            continue
        errors = _check_manifest_vs_entry(manifest, entry)
        bump_errors = _check_version_bumped(plugin_dir, manifest)
        warnings: List[str] = []
        if bump_errors and release_plugin is not None and plugin_dir.name != release_plugin:
            # CI 发布别的插件：这个插件这次不发布，HEAD 上的改动不拦发版，只提醒
            warnings = bump_errors
        else:
            errors += bump_errors
        if errors:
            print(f"  [diff]    {name}")
            for e in errors:
                print(e)
            fail = True
        elif warnings:
            print(f"  [warn]    {name}（本次不发布它，只警告）")
            for w in warnings:
                print(w)
        else:
            print(f"  [ok]      {name}")

    if fail:
        print("\n校验未通过，请修正 manifest 或 index.json 后重试。")
        return 1
    print("\n所有 entry 与 manifest 一致。")
    return 0


# ─────────────────────── 构建 ───────────────────────


def cmd_build() -> int:
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    DIST_DIR.mkdir(exist_ok=True)
    private_key = _load_private_key()
    if private_key:
        print(f"  signing: enabled (Ed25519)")
    else:
        print(f"  signing: disabled (set SIGNING_KEY env or keys/private.pem)")

    entries: List[dict] = []
    fail = 0

    for plugin_dir in _iter_plugin_dirs():
        manifest = _read_manifest(plugin_dir)
        name = manifest["name"]
        if _is_draft(manifest):
            print(f"  [draft]   {name} — 草稿（未发布），跳过打包")
            continue
        repo_rel = plugin_dir.relative_to(ROOT).as_posix()  # e.g. plugins/<name>，供 git archive/show 用
        if name != plugin_dir.name:
            print(f"  [warn]   {plugin_dir.name}: manifest.name={name} 与目录名不一致")

        tags = _get_tags_for_plugin(plugin_dir.name)
        if not tags:
            print(f"  [skip]   {name} — 未找到 tag（创建：git tag {plugin_dir.name}/v{manifest.get('version', '1.0.0')}）")
            continue

        # 为每个版本（含历史）从对应 tag 构建 zip
        sha_by_version: dict = {}
        size_by_version: dict = {}
        for tag, version in tags:
            pkg_dir = DIST_DIR / "packages" / plugin_dir.name / version
            zip_path = pkg_dir / "plugin.zip"
            if not _pack_zip_for_tag(repo_rel, version, tag, zip_path):
                print(f"  [fail]   {name} v{version} — git archive 失败")
                fail += 1
                continue

            sha, size = _sha256_hex(zip_path)
            sha_by_version[version] = sha
            size_by_version[version] = size

            if private_key:
                sig = _sign_bytes(zip_path.read_bytes(), private_key)
                (pkg_dir / "plugin.sig").write_bytes(sig)

            print(f"  [pack]   {name} v{version} sha256={sha[:12]}…")

        latest_version = tags[0][1]
        if latest_version not in sha_by_version:
            print(f"  [fail]   {name}: latest tag 打包失败，跳过 entry")
            fail += 1
            continue

        rel_zip_path = f"packages/{plugin_dir.name}/{latest_version}/plugin.zip"
        zip_url = f"{base_url}/{rel_zip_path}" if base_url else rel_zip_path

        # entry 字段全部取自最新 tag 里的 manifest（与 zip 同源），不用 HEAD 的 manifest
        tag_manifest = _manifest_at(tags[0][0], repo_rel)
        if tag_manifest is None:
            print(f"  [fail]   {name}: 读不到 {tags[0][0]} 里的 manifest.json，跳过 entry")
            fail += 1
            continue
        if tag_manifest.get("name") != name:
            print(f"  [warn]   {plugin_dir.name}: {tags[0][0]} 里的 manifest.name={tag_manifest.get('name')} 与 HEAD 的 {name} 不一致，按 tag 发布")

        # 构造符合 followcat schema v1 的 entry
        entry = {
            "name": tag_manifest.get("name", name),
            "version": latest_version,
            "author": tag_manifest.get("author", ""),
            "description": tag_manifest.get("description", ""),
            "source_url": tag_manifest["source_url"],
            "homepage_url": tag_manifest.get("homepage_url", ""),
            "icon": tag_manifest.get("icon", ""),
            "zip_url": zip_url,
            "zip_size": size_by_version[latest_version],
            "zip_sha256": sha_by_version[latest_version],
            "permissions": list(tag_manifest.get("permissions", [])),
            "hooks": list(tag_manifest.get("hooks", [])),
            "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        entries.append(entry)

    index = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "entries": entries,
    }
    out_path = DIST_DIR / "index.json"
    out_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n built {len(entries)} entries → {out_path.relative_to(ROOT)}")
    if fail:
        print(f" {fail} plugin(s) failed to build")
        return 1
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build followcat plugin registry artifacts")
    parser.add_argument("--check", action="store_true", help="仅校验 manifest 与 index.json 一致性")
    parser.add_argument(
        "--release-tag",
        default=None,
        help="配合 --check（CI 发布用）：本次发布的 tag（<插件目录>/v<版本>，可带 refs/tags/ 前缀）。"
             "「同版本内容不同」只对这个插件判失败，其它插件只警告；空串 = 全部只警告",
    )
    args = parser.parse_args(argv)

    if args.release_tag is not None and not args.check:
        parser.error("--release-tag 只能与 --check 一起用")
    if args.check:
        return cmd_check(args.release_tag)
    return cmd_build()


if __name__ == "__main__":
    sys.exit(main())
