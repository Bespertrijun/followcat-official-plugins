"""
followcat 插件 Dev Runtime（参考 drivecat-official-plugins/devrt/server.py 改写）
==============================================================================

无需启动完整的 FollowCat 主服务，使用本脚本可在本地：

  - 加载 <plugin>/manifest.json + index.js + ui/* 到一个仿真宿主中
  - 在浏览器里看到插件的 iframe UI（带可工作的 FC.* SDK）
  - 模拟触发任意 hook（自带各 hook 的示例 payload）
  - 调用通过 plugin.registerAPI 注册的端点
  - 编辑插件配置（含 secret 字段；本地内存存储，不加密）
  - 实时查看 log.* 输出

执行模型：

  - 插件 index.js 在 Node 子进程（devrt/sandbox.js）里跑，使用 Node 的 vm 模块
    模拟 goja 沙箱，注入 plugin / log / config / http / anime / task 全局
  - http.* 默认 mock（仅打日志），加 --allow-http 后真实出网
  - Python 端持有 mock config（含 is_secret 标记；默认仅内存；加 --persist 写到
    devrt/data/<plugin>/config.json）
  - iframe 桥（host.html）讲生产协议，经 /api/sandbox/* 取数；这组端点按生产
    internal/api/plugin_handler.go 的 Sandbox* 复刻（统一信封、secret 脱敏、键/值校验）；
    /plugin-ui 带与生产 plugin_ui_handler.go 相同的 CSP / 安全头

用法：

    pip install -r requirements.txt
    python devrt/server.py media-library-filter
    python devrt/server.py cookiecloud --port 9100
    python devrt/server.py media-library-filter --allow-http --persist
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import posixpath
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue, Empty
from typing import Any, Dict, List, Optional

try:
    from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
except ImportError:
    print("请先安装依赖：pip install -r requirements.txt", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parent.parent
DEVRT_DIR = ROOT / "devrt"
DATA_DIR = DEVRT_DIR / "data"

# ─── 与生产宿主逐字对齐的常量 ───
# internal/api/plugin_ui_handler.go ServeUI：插件 UI 响应头（CSP 只在 UI 路由上设）
PLUGIN_UI_HEADERS: Dict[str, str] = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; connect-src 'none'; font-src 'self' data:; frame-ancestors 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
}

# internal/api/contract/response.go 错误码
ERR_INVALID_PARAM = 40001
ERR_NOT_FOUND = 40400
ERR_INTERNAL = 50000

# internal/plugin/config/validate.go
CONFIG_KEY_PATTERN = re.compile(r"[a-zA-Z0-9_.\-]{1,128}")  # 用 fullmatch，等价 Go 的 ^...$
CONFIG_DENIED_KEYS = {"__proto__", "constructor", "prototype"}
CONFIG_MAX_VALUE_BYTES = 64 * 1024


def _now_iso() -> str:
    # Go time.Time 的 JSON（RFC3339Nano，带本地时区偏移）；精度到微秒
    return datetime.datetime.now().astimezone().isoformat()


def validate_config_key(key: str) -> Optional[str]:
    """复刻 pluginconfig.ValidateConfigKey：返回错误文案，合法返回 None。"""
    if not CONFIG_KEY_PATTERN.fullmatch(key):
        return "invalid config key: must match ^[a-zA-Z0-9_.\\-]{1,128}$"
    if key in CONFIG_DENIED_KEYS:
        return f"invalid config key: {json.dumps(key)} is a reserved name"
    return None


def validate_config_value(value: str) -> Optional[str]:
    """复刻 pluginconfig.ValidateConfigValue（按 UTF-8 字节计）。"""
    n = len(value.encode("utf-8"))
    if n > CONFIG_MAX_VALUE_BYTES:
        return f"invalid config value: value {n} bytes exceeds max {CONFIG_MAX_VALUE_BYTES}"
    return None


def canonical_api_path(raw: str) -> str:
    """复刻 internal/plugin/runtime.go canonicalAPIPath；非法时抛 ValueError(生产文案)。"""
    s = raw.strip()
    if s == "":
        raise ValueError("plugin api path is empty")
    if any(seg == ".." for seg in s.split("/")):
        raise ValueError(f"plugin api path {json.dumps(raw)} contains traversal")
    if not s.startswith("/"):
        s = "/" + s
    cleaned = posixpath.normpath(s)
    # Go path.Clean 会把前导 "//" 收成 "/"，posixpath.normpath 保留（POSIX 特例）
    cleaned = "/" + cleaned.lstrip("/")
    if cleaned == "/":
        raise ValueError(f"plugin api path {json.dumps(raw)} is empty after clean")
    return cleaned


_STACK_FRAME = re.compile(r"^\s+at\s")
# vm 同步抛错时 Node 给 stack 加的源码定位装饰头："<file>:<line>\n<源码行>\n   ^\n\n"
_STACK_DECORATION = re.compile(r"\A[^\n]*:\d+\n[^\n]*\n[ \t]*\^+[ \t]*\n\n")


def plugin_error_message(raw: str) -> str:
    """sandbox.js 回的是 Node 的 err.stack；去掉源码定位装饰头与 "    at ..." 栈帧行，
    留下 String(err)（如 "Error: boom"）——与生产 rejectionError 的文案一致。多行 message 保留。"""
    text = _STACK_DECORATION.sub("", str(raw), count=1)
    lines = [ln for ln in text.split("\n") if not _STACK_FRAME.match(ln)]
    return "\n".join(lines).rstrip()

# ─── 默认 hook payload，便于点一键触发 ───
# 字段与类型按宿主真实形态（主仓 internal/domain/event.go、plugin_hooks.go、plugin/event_bridge.go）：
# anime_id / task_id 是数字，media_id 是字符串，aka 是数组，hdr / dv 是字符串（没识别到是 "无"）。
# 字段集合与宿主一致：sdk.md 里标 ? 的字段也恒在，没有有效值时是零值（0 / "" / []），不会缺省。
HOOK_SAMPLES: Dict[str, Dict[str, Any]] = {
    "on_episode_found": {
        "anime_id": 1,
        "episode": 1,
        "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
    },
    "on_download_done": {
        "anime_id": 1,
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "hash": "abcdef0123456789",
        "files": [{"path": "S01E01.mkv", "size": 524288000}],
        "size": 524288000,
        "save_path": "/data/downloads/DevRT Sample Anime",
        "category": "anime",
    },
    "on_download_failed": {
        "anime_id": 1,
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "episode_end": 0,
        "hash": "abcdef0123456789",
        "reason": "tracker timeout",
    },
    "on_link_done": {
        "anime_id": 1,
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "dest": "/media/anime/DevRT Sample Anime/S01E01.mkv",
        "tmdb_episode": 1,
    },
    "on_link_failed": {
        "anime_id": 1,
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "episode_end": 0,
        "reason": "destination occupied",
        "hash": "abcdef0123456789",
    },
    "on_episode_acquired": {
        "source": "mikan",
        "task_id": 1,
        "media_id": "1",
        "media_title": "DevRT Sample Anime",
        "episodes": [3],
        "unit_kind": "episode",
        "completed_units": 3,
        "total_units": 12,
    },
    "on_task_completed": {
        "source": "mikan",
        "task_id": 1,
        "media_id": "1",
        "media_title": "DevRT Sample Anime",
        "anime_title": "DevRT Sample Anime",
        "total_ep": 12,
    },
    "on_task_reopened": {
        "source": "mikan",
        "task_id": 1,
        "media_id": "1",
        "media_title": "DevRT Sample Anime",
        "old_total_ep": 12,
        "new_total_ep": 13,
        "acquired_units": 12,
    },
    "on_task_subscribed": {
        "source": "mikan",
        "trigger": "auto",
        "task_id": 1,
        "media_id": "1",
        "media_title": "DevRT Sample Anime",
        "site_id": "mikan-sample",
    },
    "should_download": {
        "flow_id": "flow-1",
        "media": {
            "tmdb_id": "1429",
            "tmdb_type": "tv",
            "imdb_id": "",
            "season": 1,
            "episode": 8,
            "episode_end": 0,
            "title": "DevRT Sample Anime",
            "original_title": "",
            "aka": ["DevRT 示例动画"],
            "year": 2024,
        },
        "tags": {
            "resolution": "1080p",
            "video_encode": "HEVC",
            "audio_encode": "AAC",
            "dv": "无",
            "hdr": "HDR",
            "code_bits": "10bit",
            "format": "MKV",
            "language": "",
            "source": "",
            "group": "SubGroup",
            "special_content": "",
            "part_alias": "",
        },
        "ctx": {
            "raw_title": "[SubGroup] DevRT Sample Anime - 08 [1080p HEVC AAC HDR]",
            "subtitle": "",
            "description": "",
            "tag": "",
            "anime_id": 1,
            "task_id": 1,
            "link_subdir": "",
            "directory": "",
            "source_site": "mikan",
            "category": "",
            "size": 524288000,
            "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
            "is_movie": False,
            "is_show": False,
        },
    },
    "should_download_batch": {
        "flow_id": "flow-1",
        "media": {
            "tmdb_id": "1429",
            "tmdb_type": "tv",
            "imdb_id": "",
            "season": 1,
            "episode": 9,
            "episode_end": 10,
            "title": "DevRT Sample Anime",
            "original_title": "",
            "aka": ["DevRT 示例动画"],
            "year": 2024,
        },
        "tags": {
            "resolution": "1080p",
            "video_encode": "HEVC",
            "audio_encode": "AAC",
            "dv": "无",
            "hdr": "无",
            "code_bits": "10bit",
            "format": "MKV",
            "language": "",
            "source": "",
            "group": "SubGroup",
            "special_content": "",
            "part_alias": "",
        },
        "ctx": {
            "raw_title": "[SubGroup] DevRT Sample Anime - 09-10 [1080p HEVC AAC]",
            "subtitle": "",
            "description": "",
            "tag": "",
            "anime_id": 1,
            "task_id": 1,
            "link_subdir": "",
            "directory": "",
            "source_site": "mikan",
            "category": "",
            "size": 1048576000,
            "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
            "is_movie": False,
            "is_show": False,
        },
    },
}


class PluginTimeout(RuntimeError):
    """插件调用超过宿主墙钟（sandbox.js 回 {error, timeout: true}）；生产宿主对应 ErrRuntimeTimeout → HTTP 504。"""


# ─── Node 子进程封装 ───────────────────────────────────────────────────────


@dataclass
class SandboxState:
    plugin_dir: Path
    plugin_id: str = ""
    manifest: Dict[str, Any] = field(default_factory=dict)
    hooks_registered: List[str] = field(default_factory=list)
    apis_registered: List[str] = field(default_factory=list)
    load_error: Optional[str] = None


class NodeSandbox:
    """同步 JSON-RPC 客户端，封装 Node 子进程。"""

    def __init__(self, plugin_dir: Path, allow_http: bool):
        self.plugin_dir = plugin_dir
        self.allow_http = allow_http
        self.state = SandboxState(plugin_dir=plugin_dir)
        self._proc: Optional[Any] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._pending: Dict[str, Queue] = {}
        self._log_subscribers: List[Queue] = []
        self._config_cache: Dict[str, str] = {}  # key → 明文 value（原样喂给 sandbox）
        # key → {"is_secret": bool, "updated_at": str}；与 _config_cache 同步维护
        self._config_meta: Dict[str, Dict[str, Any]] = {}
        self._config_lock = threading.RLock()
        # 串行化「改内存 → configReplace 进 sandbox → 落盘」。reader 线程不拿它；调 sandbox
        # 时绝不能持有 _config_lock，否则插件同时 config.set 发来的事件会卡住 reader 线程，
        # configReplace 的回复读不出来（死等到超时）。
        self._sync_lock = threading.Lock()
        self.logs: List[Dict[str, Any]] = []

    # public

    def start(self) -> None:
        import subprocess

        env = os.environ.copy()
        env["ALLOW_HTTP"] = "1" if self.allow_http else "0"
        sandbox_js = DEVRT_DIR / "sandbox.js"
        self._proc = subprocess.Popen(
            ["node", str(sandbox_js), str(self.plugin_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        threading.Thread(target=self._stderr_drain, daemon=True).start()

        # 把已有 config（持久化或上次内存）注入 sandbox
        self.call("configReplace", {"entries": self._config_cache})

        manifest = self.plugin_dir / "manifest.json"
        if manifest.exists():
            self.state.manifest = json.loads(manifest.read_text(encoding="utf-8"))
            self.state.plugin_id = self.state.manifest.get("name", self.plugin_dir.name)

        info = self.call("init", {})
        self.state.hooks_registered = info.get("hooks", [])
        self.state.apis_registered = info.get("apis", [])
        self.state.load_error = info.get("loadError")

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            try:
                self.call("shutdown", {}, timeout=2)
            except Exception:
                pass
            try:
                self._proc.terminate()
            except Exception:
                pass

    def call(self, method: str, params: Dict[str, Any], timeout: float = 12.0) -> Any:
        if not self._proc or self._proc.poll() is not None:
            raise RuntimeError("sandbox not running")
        msg_id = uuid.uuid4().hex
        q: Queue = Queue()
        self._pending[msg_id] = q
        msg = json.dumps({"id": msg_id, "method": method, "params": params}) + "\n"
        with self._lock:
            assert self._proc.stdin is not None
            self._proc.stdin.write(msg)
            self._proc.stdin.flush()
        try:
            reply = q.get(timeout=timeout)
        finally:
            self._pending.pop(msg_id, None)
        if "error" in reply:
            if reply.get("timeout"):
                raise PluginTimeout(reply["error"])
            raise RuntimeError(reply["error"])
        return reply.get("result", {})

    def trigger(self, hook: str, data: Dict[str, Any]) -> Any:
        return self.call("trigger", {"hook": hook, "data": data})

    def call_api(self, path: str, req: Dict[str, Any]) -> Any:
        return self.call("callApi", {"path": path, "req": req})

    def get_config(self) -> Dict[str, str]:
        with self._config_lock:
            return dict(self._config_cache)

    def get_config_secrets(self) -> List[str]:
        with self._config_lock:
            return sorted(k for k, m in self._config_meta.items() if m.get("is_secret"))

    def _meta_for(self, key: str) -> Dict[str, Any]:
        m = self._config_meta.get(key)
        if m is None:
            m = {"is_secret": False, "updated_at": _now_iso()}
            self._config_meta[key] = m
        return m

    def sandbox_config_list(self) -> List[Dict[str, Any]]:
        """复刻 SandboxGetConfig：按 key 升序；secret 脱敏；value 按 Go omitempty（空串不出现）。"""
        out: List[Dict[str, Any]] = []
        with self._config_lock:
            for key in sorted(self._config_cache.keys()):
                meta = self._meta_for(key)
                item: Dict[str, Any] = {"key": key}
                value = self._config_cache[key]
                if not meta["is_secret"] and value != "":
                    item["value"] = value
                item["is_secret"] = bool(meta["is_secret"])
                item["updated_at"] = meta["updated_at"]
                out.append(item)
        return out

    def put_config_entries(self, entries: List[Dict[str, Any]], persist: Optional[Path] = None) -> None:
        """复刻 SandboxPutConfig / SetBatchWithSecret：每条显式写 is_secret（不保留旧标记）。"""
        now = _now_iso()
        with self._sync_lock:
            with self._config_lock:
                for e in entries:
                    self._config_cache[e["key"]] = e["value"]
                    self._config_meta[e["key"]] = {"is_secret": bool(e["is_secret"]), "updated_at": now}
            self._sync_config(persist, {e["key"]: e["value"] for e in entries}, [])

    def set_config_entries(
        self,
        entries: Dict[str, str],
        persist: Optional[Path] = None,
        secrets: Optional[List[str]] = None,
    ) -> None:
        """侧栏（类比管理页）写入：只写传进来的（改过的）key；已有 key 保留原 is_secret，除非 secrets
        显式点名；值变了才刷 updated_at。"""
        now = _now_iso()
        with self._sync_lock:
            with self._config_lock:
                for k, v in entries.items():
                    meta = self._config_meta.get(k)
                    if meta is None or self._config_cache.get(k) != v:
                        self._config_meta[k] = {
                            "is_secret": bool(meta and meta.get("is_secret")),
                            "updated_at": now,
                        }
                    self._config_cache[k] = v
                for k in secrets or []:
                    if k in self._config_meta:
                        self._config_meta[k]["is_secret"] = True
            self._sync_config(persist, dict(entries), [])

    def delete_config_keys(self, keys: List[str], persist: Optional[Path] = None) -> List[str]:
        """侧栏显式删除（管理页的「删除配置项」）：返回真正删掉的 key。"""
        with self._sync_lock:
            with self._config_lock:
                removed = [k for k in keys if k in self._config_cache]
                for k in removed:
                    self._config_cache.pop(k, None)
                    self._config_meta.pop(k, None)
            self._sync_config(persist, {}, removed)
        return removed

    def _sync_config(self, persist: Optional[Path], changed: Dict[str, str], deleted: List[str]) -> None:
        # 调用方持有 _sync_lock、不持有 _config_lock（见 __init__ 注释）。
        # 只把这次改动（changed / deleted）下发给 sandbox：整表 configReplace 会把插件同时
        # config.set 的其它 key 冲回旧值（事件还在管道里时）。
        with self._config_lock:
            values = dict(self._config_cache)
            doc = {
                "version": 2,
                "entries": {
                    k: {
                        "value": values[k],
                        "is_secret": bool(self._meta_for(k)["is_secret"]),
                        "updated_at": self._meta_for(k)["updated_at"],
                    }
                    for k in sorted(values.keys())
                },
            }
        if self._proc and self._proc.poll() is None and (changed or deleted):
            self.call("configPatch", {"set": changed, "delete": deleted})
        if persist is not None:
            persist.parent.mkdir(parents=True, exist_ok=True)
            persist.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_persisted_config(self, src: Path) -> None:
        """读 --persist 文件。新格式 {"version":2,"entries":{k:{value,is_secret,updated_at}}}；
        兼容旧的扁平 {k: v}（全部当普通项）。"""
        if not src.exists():
            return
        try:
            raw = json.loads(src.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        cache: Dict[str, str] = {}
        meta: Dict[str, Dict[str, Any]] = {}
        if isinstance(raw, dict) and raw.get("version") == 2 and isinstance(raw.get("entries"), dict):
            for k, e in raw["entries"].items():
                if not isinstance(e, dict):
                    continue
                cache[k] = "" if e.get("value") is None else str(e.get("value"))
                meta[k] = {
                    "is_secret": bool(e.get("is_secret")),
                    "updated_at": e.get("updated_at") or _now_iso(),
                }
        elif isinstance(raw, dict):
            for k, v in raw.items():
                cache[k] = "" if v is None else str(v)
                meta[k] = {"is_secret": False, "updated_at": _now_iso()}
        with self._config_lock:
            self._config_cache = cache
            self._config_meta = meta

    def subscribe_logs(self) -> Queue:
        q: Queue = Queue()
        self._log_subscribers.append(q)
        return q

    def unsubscribe_logs(self, q: Queue) -> None:
        if q in self._log_subscribers:
            self._log_subscribers.remove(q)

    # internal

    def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "event" in msg:
                self._dispatch_event(msg)
            elif "id" in msg:
                q = self._pending.get(msg["id"])
                if q is not None:
                    q.put(msg)

    def _dispatch_event(self, msg: Dict[str, Any]) -> None:
        ev = msg.get("event")
        if ev == "log":
            entry = {
                "ts": time.time(),
                "level": msg.get("level", "info"),
                "args": msg.get("args", []),
            }
            self.logs.append(entry)
            self.logs[:] = self.logs[-1000:]
            for q in list(self._log_subscribers):
                try:
                    q.put_nowait(entry)
                except Exception:
                    pass
        elif ev == "configDelete":
            # 插件后端 config.delete（宿主 R4）：删键并释放配额行
            key = msg.get("key")
            if key is not None:
                with self._config_lock:
                    self._config_cache.pop(key, None)
                    self._config_meta.pop(key, None)
        elif ev == "config":
            # 插件后端 config.set：同生产 PluginConfigStore.Set——新 key is_secret=false，
            # 已有 key 保留原 is_secret
            key, value = msg.get("key"), msg.get("value")
            if key is not None:
                with self._config_lock:
                    self._config_cache[key] = value
                    meta = self._config_meta.get(key)
                    self._config_meta[key] = {
                        "is_secret": bool(meta and meta.get("is_secret")),
                        "updated_at": _now_iso(),
                    }

    def _stderr_drain(self) -> None:
        if not self._proc or not self._proc.stderr:
            return
        for line in self._proc.stderr:
            text = line.rstrip()
            if not text:
                continue
            self.logs.append({"ts": time.time(), "level": "error", "args": ["[node] " + text]})


# ─── FastAPI 应用 ─────────────────────────────────────────────────────────


def build_app(sandbox: NodeSandbox, persist_path: Optional[Path]) -> FastAPI:
    app = FastAPI(title="followcat-plugin-devrt")

    plugin_dir = sandbox.plugin_dir

    # /plugin-ui 下的一切响应（含 404）带与生产 ServeUI 完全相同的 CSP / 安全头。
    # 只挂在 UI 路由上：host.html 自己要 fetch /api/*，不能被 connect-src 'none' 波及。
    @app.middleware("http")
    async def plugin_ui_security_headers(request: Request, call_next):
        response = await call_next(request)
        if request.url.path == "/plugin-ui" or request.url.path.startswith("/plugin-ui/"):
            for name, value in PLUGIN_UI_HEADERS.items():
                response.headers[name] = value
        return response

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        html = (DEVRT_DIR / "host.html").read_text(encoding="utf-8")
        return HTMLResponse(html)

    @app.get("/plugin-sdk.js")
    def plugin_sdk() -> FileResponse:
        return FileResponse(DEVRT_DIR / "plugin-sdk.js", media_type="application/javascript")

    # iframe entry: serve the plugin's ui/ directory
    ui_dir = plugin_dir / "ui"
    if ui_dir.exists():
        app.mount("/plugin-ui", StaticFiles(directory=str(ui_dir), html=True), name="plugin-ui")
    else:
        @app.get("/plugin-ui/{rest:path}")
        def no_ui(rest: str) -> HTMLResponse:
            return HTMLResponse(
                f"<h3>No UI</h3><p>{plugin_dir.name}/ui not found. Plugin UI iframe disabled.</p>",
                status_code=404,
            )

    # ─── meta / state ───
    @app.get("/api/state")
    def state() -> Dict[str, Any]:
        return {
            "plugin_id": sandbox.state.plugin_id,
            "manifest": sandbox.state.manifest,
            "hooks_registered": sandbox.state.hooks_registered,
            "apis_registered": sandbox.state.apis_registered,
            "load_error": sandbox.state.load_error,
            "hook_samples": HOOK_SAMPLES,
            "config": sandbox.get_config(),
            "config_secrets": sandbox.get_config_secrets(),
            "ui_available": ui_dir.exists(),
            "allow_http": sandbox.allow_http,
        }

    @app.get("/api/logs")
    def get_logs() -> Dict[str, Any]:
        return {"logs": sandbox.logs[-200:]}

    @app.get("/api/logs/stream")
    async def logs_stream(request: Request):
        from fastapi.responses import StreamingResponse

        async def gen():
            q = sandbox.subscribe_logs()
            try:
                # initial backlog
                for entry in sandbox.logs[-50:]:
                    yield f"data: {json.dumps(entry)}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        # 阻塞等待放线程里：直接 q.get(timeout=1.0) 会卡住事件循环，日志面板一开，
                        # 其它请求（iframe 桥的 /api/sandbox/*）每个都要排队数秒
                        entry = await asyncio.to_thread(q.get, True, 1.0)
                        yield f"data: {json.dumps(entry)}\n\n"
                    except Empty:
                        yield ": keepalive\n\n"
            finally:
                sandbox.unsubscribe_logs(q)

        return StreamingResponse(gen(), media_type="text/event-stream")

    # ─── hooks / api ───
    @app.post("/api/trigger")
    async def trigger(payload: Dict[str, Any]) -> Dict[str, Any]:
        hook = payload.get("hook")
        data = payload.get("data") or {}
        if hook not in sandbox.state.hooks_registered:
            raise HTTPException(400, f"hook not registered: {hook}")
        try:
            # 放到线程里等：插件回调可 async（sandbox 侧 await 其 Promise），阻塞等待不能卡住
            # 事件循环，否则一个在 await 的慢 hook 会让其它请求（UI 调 API 等）全部排队
            res = await asyncio.to_thread(sandbox.trigger, hook, data)
            out: Dict[str, Any] = {"ok": True}
            if hook == "should_download" and isinstance(res, dict):
                # 回显宿主会得出的裁决：verdict ∈ allow / veto / have_bitmap；fail_open = 超时 / 抛错 / reject 放行
                for k in ("result", "verdict", "fail_open", "error"):
                    if k in res:
                        out[k] = res[k]
            return out
        except PluginTimeout as e:
            raise HTTPException(504, str(e))
        except Exception as e:
            raise HTTPException(500, str(e))

    @app.post("/api/call-api")
    async def call_api(payload: Dict[str, Any]) -> Dict[str, Any]:
        path = payload.get("path", "")
        req = payload.get("req") or {"method": "GET", "body": "", "query": {}}
        if path not in sandbox.state.apis_registered:
            raise HTTPException(404, f"api not registered: {path}")
        try:
            result = await asyncio.to_thread(sandbox.call_api, path, req)
            return {"ok": True, "result": result.get("result")}
        except PluginTimeout as e:
            raise HTTPException(504, str(e))
        except Exception as e:
            raise HTTPException(500, str(e))

    # ─── config ───
    @app.get("/api/config")
    def cfg_get() -> Dict[str, str]:
        return sandbox.get_config()

    @app.post("/api/config")
    async def cfg_set(payload: Dict[str, Any]) -> Dict[str, Any]:
        entries = payload.get("entries") or {}
        if not isinstance(entries, dict):
            raise HTTPException(400, "entries must be an object")
        secrets = payload.get("secrets") or []
        if not isinstance(secrets, list):
            raise HTTPException(400, "secrets must be an array of keys")
        clean: Dict[str, str] = {k: ("" if v is None else str(v)) for k, v in entries.items()}
        for k, v in clean.items():
            err = validate_config_key(k) or validate_config_value(v)
            if err:
                raise HTTPException(400, f"{k}: {err}")
        await asyncio.to_thread(
            sandbox.set_config_entries, clean, persist_path, [str(k) for k in secrets]
        )
        return {"ok": True, "saved": list(clean.keys())}

    @app.delete("/api/config/{key}")
    async def cfg_delete(key: str) -> Dict[str, Any]:
        # 显式删除一项（侧栏 ×）：不再靠「保存时少传一个 key」表达删除
        removed = await asyncio.to_thread(sandbox.delete_config_keys, [key], persist_path)
        if not removed:
            raise HTTPException(404, f"config key not found: {key}")
        return {"ok": True, "deleted": removed}

    # ─── iframe 桥专用：复刻生产 /api/plugins/:id/sandbox/* ───
    # host.html 的 postMessage 桥照 PluginIframeHost.vue 调这组端点；响应是生产的统一信封
    # {code, data, message}，错误码 / HTTP 状态 / 文案按 plugin_handler.go 对齐。

    def envelope_ok(data: Any) -> JSONResponse:
        return JSONResponse({"code": 0, "data": data, "message": "ok"})

    def envelope_fail(status: int, code: int, message: str) -> JSONResponse:
        return JSONResponse({"code": code, "data": None, "message": message}, status_code=status)

    @app.api_route(
        "/api/sandbox/api/{action:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    )
    async def sandbox_dispatch(action: str, request: Request) -> JSONResponse:
        # SandboxDispatch：gin 的 *action 带前导 "/"，Starlette 的 path 参数不带
        action = "/" + action
        if action.strip() == "" or action == "/":
            return envelope_fail(400, ERR_INVALID_PARAM, "plugin api action is required")
        # buildPluginAPIRequest：{method, body: 原始请求体字符串, query: 每个 key 取第一个值}
        raw_body = await request.body()
        query: Dict[str, str] = {}
        for k, v in request.query_params.multi_items():
            query.setdefault(k, v)
        req = {"method": request.method, "body": raw_body.decode("utf-8", errors="replace"), "query": query}
        # Manager.CallAPI：canonicalAPIPath 归一化后查注册表
        try:
            clean = canonical_api_path(action)
        except ValueError as e:
            return envelope_fail(400, ERR_INVALID_PARAM, str(e))
        registered = {}
        for p in sandbox.state.apis_registered:
            try:
                registered.setdefault(canonical_api_path(p), p)
            except ValueError:
                continue
        target = registered.get(clean)
        if target is None:
            return envelope_fail(
                404, ERR_NOT_FOUND,
                f"plugin {sandbox.state.plugin_id} api {json.dumps(clean)} not registered",
            )
        try:
            result = await asyncio.to_thread(sandbox.call_api, target, req)
        except PluginTimeout as e:
            # B1：registerAPI 墙钟超时 → 504（生产 SandboxDispatch 同）
            return envelope_fail(504, ERR_INTERNAL, str(e))
        except Exception as e:
            full = str(e)
            if full and full != plugin_error_message(full):
                # 完整 Node 栈只进日志面板，回给 UI 的文案对齐生产（去栈帧）
                sandbox._dispatch_event({"event": "log", "level": "error", "args": [f"[api {target}] " + full]})
            return envelope_fail(500, ERR_INTERNAL, plugin_error_message(full) or "plugin api call failed")
        return envelope_ok(result.get("result"))

    @app.get("/api/sandbox/config")
    def sandbox_get_config() -> JSONResponse:
        return envelope_ok(sandbox.sandbox_config_list())

    @app.put("/api/sandbox/config")
    async def sandbox_put_config(request: Request) -> JSONResponse:
        # SandboxPutConfig：ShouldBindJSON(PluginConfigPutReq) → 逐条 ValidateConfigKey/Value → 批量写
        try:
            payload = json.loads(await request.body() or b"null")
        except Exception as e:
            return envelope_fail(400, ERR_INVALID_PARAM, f"invalid JSON body: {e}")
        if not isinstance(payload, dict):
            return envelope_fail(400, ERR_INVALID_PARAM, "request body must be a JSON object")

        def json_kind(v: Any) -> str:
            # Go encoding/json UnmarshalTypeError 的 Value 用词
            if isinstance(v, bool):
                return "bool"
            if isinstance(v, (int, float)):
                return "number"
            if isinstance(v, dict):
                return "object"
            if isinstance(v, list):
                return "array"
            return "string"

        def as_str(v: Any, field_name: str) -> str:
            if v is None:
                return ""  # Go：JSON null / 缺字段 → 零值
            if not isinstance(v, str):
                raise ValueError(
                    f"json: cannot unmarshal {json_kind(v)} into Go struct field "
                    f"PluginConfigEntry.{field_name} of type string"
                )
            return v

        def as_bool(v: Any, field_name: str) -> bool:
            if v is None:
                return False
            if not isinstance(v, bool):
                raise ValueError(
                    f"json: cannot unmarshal {json_kind(v)} into Go struct field "
                    f"PluginConfigEntry.{field_name} of type bool"
                )
            return v

        try:
            raw_entries = payload.get("entries")
            if raw_entries is not None and not isinstance(raw_entries, list):
                raise ValueError("json: cannot unmarshal entries into Go struct field PluginConfigPutReq.entries")
            entries: List[Dict[str, Any]] = []
            for e in raw_entries or []:
                if not isinstance(e, dict):
                    raise ValueError("json: cannot unmarshal entry into Go struct field PluginConfigPutReq.entries")
                entries.append({
                    "key": as_str(e.get("key"), "entries.key"),
                    "value": as_str(e.get("value"), "entries.value"),
                    "is_secret": as_bool(e.get("is_secret"), "entries.is_secret"),
                })
            if not entries:
                key = as_str(payload.get("key"), "key")
                if key == "":
                    return envelope_fail(400, ERR_INVALID_PARAM, "either 'key' or 'entries' is required")
                entries = [{
                    "key": key,
                    "value": as_str(payload.get("value"), "value"),
                    "is_secret": as_bool(payload.get("is_secret"), "is_secret"),
                }]
        except ValueError as e:
            return envelope_fail(400, ERR_INVALID_PARAM, str(e))

        for e in entries:
            if e["key"] == "":
                return envelope_fail(400, ERR_INVALID_PARAM, "entry key cannot be empty")
            err = validate_config_key(e["key"]) or validate_config_value(e["value"])
            if err:
                return envelope_fail(400, ERR_INVALID_PARAM, err)

        await asyncio.to_thread(sandbox.put_config_entries, entries, persist_path)
        return envelope_ok({"updated": len(entries)})

    @app.delete("/api/sandbox/config/{key:path}")
    async def sandbox_delete_config(key: str) -> JSONResponse:
        # SandboxDeleteConfig（宿主 R4，iframe 桥 FC.config.delete）：键校验同 config.put，
        # 回 {deleted: bool}——是否真的删到一行（没设过的键 → false，不是 404）
        if key == "":
            return envelope_fail(400, ERR_INVALID_PARAM, "entry key cannot be empty")
        err = validate_config_key(key)
        if err:
            return envelope_fail(400, ERR_INVALID_PARAM, err)
        removed = await asyncio.to_thread(sandbox.delete_config_keys, [key], persist_path)
        return envelope_ok({"deleted": bool(removed)})

    return app


# ─── CLI ──────────────────────────────────────────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="followcat plugin Dev Runtime")
    p.add_argument("plugin", help="plugin directory name (e.g. media-library-filter) or absolute path")
    p.add_argument("--port", type=int, default=9000)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--allow-http", action="store_true", help="允许 http.* 真实出网（默认 mock）")
    p.add_argument("--persist", action="store_true", help="把 mock config 持久化到 devrt/data/<plugin>/config.json")
    args = p.parse_args(argv)

    plugin_dir = Path(args.plugin)
    if not plugin_dir.is_absolute():
        # 插件现位于 plugins/ 下；优先在那里解析，回退到仓库根（兼容直接传相对路径）
        candidate = ROOT / "plugins" / args.plugin
        plugin_dir = candidate if (candidate / "manifest.json").exists() else ROOT / args.plugin
    if not (plugin_dir / "manifest.json").exists():
        print(f"manifest.json not found in {plugin_dir}", file=sys.stderr)
        return 2

    persist_path: Optional[Path] = None
    if args.persist:
        persist_path = DATA_DIR / plugin_dir.name / "config.json"

    sandbox = NodeSandbox(plugin_dir=plugin_dir, allow_http=args.allow_http)
    if persist_path is not None:
        sandbox.load_persisted_config(persist_path)
    sandbox.start()

    print(f"\n  followcat plugin DevRT — http://{args.host}:{args.port}")
    print(f"  plugin   : {plugin_dir.name}")
    print(f"  hooks    : {', '.join(sandbox.state.hooks_registered) or '(none)'}")
    print(f"  apis     : {', '.join(sandbox.state.apis_registered) or '(none)'}")
    print(f"  http     : {'real' if args.allow_http else 'mocked (use --allow-http for real)'}")
    print(f"  persist  : {persist_path or '(memory only)'}")
    if sandbox.state.load_error:
        print(f"  load err : {sandbox.state.load_error}")
    print()

    app = build_app(sandbox, persist_path)
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        sandbox.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
