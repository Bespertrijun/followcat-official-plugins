"""scripts/build.py 回归测试：G3（entry 字段取自最新 tag 的 manifest；--check 拦「改了内容没升版本」）、
13（CI 发布时 --release-tag 只让本次 tag 的插件判失败，其它只警告）、12.1（index.json 一个插件只能一条）。

运行：python3 -m unittest tests/build/test_build.py

每个用例在临时目录里建一个独立 git 仓库（拷一份 build.py 进去），在那里提交 / 打 tag，
不碰本仓库的 git 状态。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

BUILD_PY = Path(__file__).resolve().parents[2] / "scripts" / "build.py"


def _manifest(version: str, permissions, description: str = "d", name: str = "demo") -> dict:
    return {
        "name": name,
        "version": version,
        "author": "FollowCat",
        "description": description,
        "source_url": "https://plugins.followcat.io/" + name,
        "homepage_url": "https://example.com/demo",
        "icon": "x",
        "permissions": list(permissions),
        "hooks": [],
    }


class BuildScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="fc-build-test-"))
        (self.dir / "scripts").mkdir()
        shutil.copy(BUILD_PY, self.dir / "scripts" / "build.py")
        self.git("init", "-q")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.dir, check=True, capture_output=True, text=True).stdout

    def write_plugin(self, manifest: dict, code: str) -> None:
        d = self.dir / "plugins" / manifest["name"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (d / "index.js").write_text(code, encoding="utf-8")

    def write_index(self, *manifests: dict) -> None:
        entries = [{k: m[k] for k in ("name", "version", "source_url", "permissions", "hooks")} for m in manifests]
        (self.dir / "index.json").write_text(json.dumps({"version": 1, "entries": entries}), encoding="utf-8")

    def commit(self, msg: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def run_build(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["python3", "scripts/build.py", *args], cwd=self.dir, capture_output=True, text=True)

    def test_entry_fields_come_from_latest_tag_manifest(self) -> None:
        old = _manifest("1.0.0", ["api.http"], description="old")
        self.write_plugin(old, "// v1\n")
        self.write_index(old)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        # HEAD 升版本、改了权限，但还没打新 tag：发布的仍是 1.0.0 的 zip
        new = _manifest("1.1.0", ["api.http", "api.ptsite.read"], description="new")
        self.write_plugin(new, "// v2\n")
        self.write_index(new)
        self.commit("v2")
        res = self.run_build()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        index = json.loads((self.dir / "dist" / "index.json").read_text(encoding="utf-8"))
        entry = index["entries"][0]
        self.assertEqual(entry["version"], "1.0.0")
        self.assertEqual(entry["permissions"], ["api.http"])
        self.assertEqual(entry["description"], "old")

    def test_check_passes_when_head_bumped_but_untagged(self) -> None:
        v1 = _manifest("1.0.0", ["api.http"])
        self.write_plugin(v1, "// v1\n")
        self.write_index(v1)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        v2 = _manifest("1.1.0", ["api.http"])
        self.write_plugin(v2, "// v2 changed\n")
        self.write_index(v2)
        self.commit("v2")
        res = self.run_build("--check")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_check_fails_when_content_changed_without_version_bump(self) -> None:
        v1 = _manifest("1.0.0", ["api.http"])
        self.write_plugin(v1, "// v1\n")
        self.write_index(v1)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        self.write_plugin(v1, "// changed but still 1.0.0\n")
        self.commit("sneaky change")
        res = self.run_build("--check")
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertIn("改了内容却没升版本", res.stdout)
        self.assertIn("plugins/demo/index.js", res.stdout)

    def test_check_passes_when_head_equals_tag(self) -> None:
        v1 = _manifest("1.0.0", ["api.http"])
        self.write_plugin(v1, "// v1\n")
        self.write_index(v1)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        (self.dir / "README.md").write_text("unrelated\n", encoding="utf-8")
        self.commit("docs only outside the plugin dir")
        res = self.run_build("--check")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_every_entry_field_comes_from_the_tag_manifest(self) -> None:
        # G3：不只 version / permissions / description——author / homepage_url / icon / hooks / source_url 也来自 tag
        old = _manifest("1.0.0", ["api.http"], description="old")
        old.update({"author": "A-old", "homepage_url": "https://old.example", "icon": "O", "hooks": ["on_link_done"],
                    "permissions": ["api.http", "hook.link.read"]})
        self.write_plugin(old, "// v1\n")
        self.write_index(old)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        new = dict(old, version="1.1.0", author="A-new", homepage_url="https://new.example", icon="N",
                   hooks=["on_link_done", "on_link_failed"], source_url="https://plugins.followcat.io/demo-new")
        self.write_plugin(new, "// v2\n")
        self.commit("v2")
        res = self.run_build()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        entry = json.loads((self.dir / "dist" / "index.json").read_text(encoding="utf-8"))["entries"][0]
        self.assertEqual(entry["author"], "A-old")
        self.assertEqual(entry["homepage_url"], "https://old.example")
        self.assertEqual(entry["icon"], "O")
        self.assertEqual(entry["hooks"], ["on_link_done"])
        self.assertEqual(entry["source_url"], "https://plugins.followcat.io/demo")
        self.assertEqual(entry["name"], "demo")

    def test_manifest_actions_and_commands_stay_out_of_the_index(self) -> None:
        # 通知交互（主仓阶段 D）：manifest.actions / commands 只随 zip 走（宿主安装 / 升级预览从 zip 里的 manifest 读），
        # 不进 index.json entry——宿主解析 index 是 DisallowUnknownFields，多一个字段整个源都会解析失败
        m = _manifest("1.0.0", ["api.notify.send"])
        m.update({"hooks": ["on_notify_action", "on_bot_command"],
                  "actions": [{"name": "retry", "label": "重试", "requires": ["logs:read"]}],
                  "commands": [{"name": "status", "description": "看状态"}]})
        self.write_plugin(m, "// v1\n")
        self.write_index(m)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        check = self.run_build("--check")
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        res = self.run_build()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        entry = json.loads((self.dir / "dist" / "index.json").read_text(encoding="utf-8"))["entries"][0]
        self.assertEqual(set(entry), {"name", "version", "author", "description", "source_url", "homepage_url", "icon",
                                      "zip_url", "zip_size", "zip_sha256", "permissions", "hooks", "published_at"})
        with zipfile.ZipFile(self.dir / "dist" / "packages" / "demo" / "1.0.0" / "plugin.zip") as zf:
            packed = json.loads(zf.read("manifest.json").decode("utf-8"))
        self.assertEqual(packed["actions"], m["actions"])
        self.assertEqual(packed["commands"], m["commands"])

    def test_check_uses_committed_head_not_the_working_tree(self) -> None:
        # G3：只在工作树里把版本号改大（没提交）骗不过 --check——比较的是已提交的 HEAD
        v1 = _manifest("1.0.0", ["api.http"])
        self.write_plugin(v1, "// v1\n")
        self.write_index(v1)
        self.commit("v1")
        self.git("tag", "demo/v1.0.0")
        self.write_plugin(v1, "// changed, still 1.0.0\n")
        self.commit("sneaky change")
        bumped = _manifest("1.0.1", ["api.http"])
        (self.dir / "plugins" / "demo" / "manifest.json").write_text(json.dumps(bumped), encoding="utf-8")
        self.write_index(bumped)
        res = self.run_build("--check")
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertIn("改了内容却没升版本", res.stdout)

    def _two_plugins_with_unbumped_change_in(self, dirty: str) -> None:
        a = _manifest("1.0.0", ["api.http"], name="alpha")
        b = _manifest("2.0.0", ["api.http"], name="beta")
        self.write_plugin(a, "// a1\n")
        self.write_plugin(b, "// b1\n")
        self.write_index(a, b)
        self.commit("a1 b1")
        self.git("tag", "alpha/v1.0.0")
        self.git("tag", "beta/v2.0.0")
        m = a if dirty == "alpha" else b
        self.write_plugin(m, "// changed without a version bump\n")
        self.commit("change " + dirty)

    def test_release_tag_only_fails_for_the_released_plugin(self) -> None:
        # 13：发布 alpha 时 beta 的「改了没升版本」只警告；本地无参数运行仍失败
        self._two_plugins_with_unbumped_change_in("beta")
        res = self.run_build("--check", "--release-tag", "alpha/v1.0.0")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("[warn]    beta", res.stdout)
        self.assertIn("改了内容却没升版本", res.stdout)
        self.assertIn("[ok]      alpha", res.stdout)
        local = self.run_build("--check")
        self.assertNotEqual(local.returncode, 0, local.stdout)
        self.assertIn("[diff]    beta", local.stdout)

    def test_release_tag_fails_when_the_released_plugin_itself_changed(self) -> None:
        self._two_plugins_with_unbumped_change_in("alpha")
        res = self.run_build("--check", "--release-tag", "refs/tags/alpha/v1.0.0")
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertIn("[diff]    alpha", res.stdout)
        self.assertIn("改了内容却没升版本", res.stdout)

    def test_release_tag_empty_warns_for_everyone_but_blocking_fields_still_fail(self) -> None:
        self._two_plugins_with_unbumped_change_in("alpha")
        res = self.run_build("--check", "--release-tag", "")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("[warn]    alpha", res.stdout)
        # 与 index.json 不一致（blocking 字段）不受 --release-tag 影响，照样失败
        a = _manifest("1.0.0", ["api.http", "api.task.read"], name="alpha")
        (self.dir / "plugins" / "alpha" / "manifest.json").write_text(json.dumps(a), encoding="utf-8")
        res = self.run_build("--check", "--release-tag", "")
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertIn("permissions", res.stdout)

    def test_release_tag_must_be_well_formed_and_name_an_existing_plugin(self) -> None:
        self._two_plugins_with_unbumped_change_in("beta")
        bad = self.run_build("--check", "--release-tag", "main")
        self.assertNotEqual(bad.returncode, 0, bad.stdout)
        self.assertIn("不是 <插件目录>/v<版本> 形式", bad.stdout)
        missing = self.run_build("--check", "--release-tag", "gamma/v1.0.0")
        self.assertNotEqual(missing.returncode, 0, missing.stdout)
        self.assertIn("plugins/gamma 不存在", missing.stdout)
        not_check = self.run_build("--release-tag", "alpha/v1.0.0")
        self.assertNotEqual(not_check.returncode, 0)

    def test_check_rejects_duplicate_entries_for_one_plugin(self) -> None:
        # 12.1：一个插件在 index.json 里只能有一条
        v1 = _manifest("1.0.0", ["api.http"])
        self.write_plugin(v1, "// v1\n")
        self.write_index(v1, v1)
        self.commit("v1")
        res = self.run_build("--check")
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertIn("[dup]     demo", res.stdout)
        self.write_index(v1)
        self.commit("dedupe")
        res = self.run_build("--check")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)


if __name__ == "__main__":
    unittest.main()
