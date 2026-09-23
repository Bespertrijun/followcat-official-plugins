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
  - Python 端持有 mock config（默认仅内存；加 --persist 写到 devrt/data/<plugin>/config.json）

用法：

    pip install -r requirements.txt
    python devrt/server.py media-library-filter
    python devrt/server.py cookiecloud --port 9100
    python devrt/server.py media-library-filter --allow-http --persist
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
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

# ─── 默认 hook payload，便于点一键触发 ───
HOOK_SAMPLES: Dict[str, Dict[str, Any]] = {
    "on_episode_found": {
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
    },
    "on_download_done": {
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "hash": "abcdef0123456789",
        "size": 524288000,
        "save_path": "/data/downloads/DevRT Sample Anime",
        "category": "anime",
        "files": [{"path": "S01E01.mkv", "size": 524288000}],
    },
    "on_download_failed": {
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "hash": "abcdef0123456789",
        "reason": "tracker timeout",
    },
    "on_link_done": {
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "dest": "/media/anime/DevRT Sample Anime/S01E01.mkv",
        "tmdb_episode": 1,
    },
    "on_link_failed": {
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "reason": "destination occupied",
    },
    "on_task_completed": {
        "task_id": "task-001",
        "anime_title": "DevRT Sample Anime",
        "total_ep": 12,
    },
    "on_task_reopened": {
        "source": "mikan",
        "task_id": "task-001",
        "media_id": "anime-001",
        "media_title": "DevRT Sample Anime",
        "old_total_ep": 12,
        "new_total_ep": 13,
        "acquired_units": 12,
    },
    "on_notification_before_send": {
        "event_type": "on_download_done",
        "channel": "slack",
        "text": "✅ DevRT Sample Anime 第 1 集 下载完成",
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
    },
    "on_notification_after_send": {
        "event_type": "on_download_done",
        "channel": "slack",
        "text": "✅ DevRT Sample Anime 第 1 集 下载完成",
        "anime_id": "anime-001",
        "anime_title": "DevRT Sample Anime",
        "episode": 1,
        "success": True,
        "error_message": "",
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
            "aka": "",
            "year": 2024,
        },
        "tags": {
            "resolution": "1080p",
            "video_encode": "hevc",
            "audio_encode": "aac",
            "code_bits": "10bit",
            "hdr": False,
            "dv": False,
            "format": "mkv",
        },
        "ctx": {
            "raw_title": "[SubGroup] DevRT Sample Anime - 08 [1080p HEVC AAC]",
            "source_site": "mikan",
            "size": 524288000,
            "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
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
            "aka": "",
            "year": 2024,
        },
        "tags": {
            "resolution": "1080p",
            "video_encode": "hevc",
            "audio_encode": "aac",
            "code_bits": "10bit",
            "hdr": False,
            "dv": False,
            "format": "mkv",
        },
        "ctx": {
            "raw_title": "[SubGroup] DevRT Sample Anime - 09-10 [1080p HEVC AAC]",
            "source_site": "mikan",
            "size": 1048576000,
            "torrent_url": "magnet:?xt=urn:btih:abcdef0123456789",
        },
    },
}


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
        self._config_cache: Dict[str, str] = {}
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
            raise RuntimeError(reply["error"])
        return reply.get("result", {})

    def trigger(self, hook: str, data: Dict[str, Any]) -> None:
        self.call("trigger", {"hook": hook, "data": data})

    def call_api(self, path: str, req: Dict[str, Any]) -> Any:
        return self.call("callApi", {"path": path, "req": req})

    def get_config(self) -> Dict[str, str]:
        return dict(self._config_cache)

    def set_config_entries(self, entries: Dict[str, str], persist: Optional[Path] = None) -> None:
        self._config_cache.update(entries)
        if self._proc and self._proc.poll() is None:
            self.call("configReplace", {"entries": self._config_cache})
        if persist is not None:
            persist.parent.mkdir(parents=True, exist_ok=True)
            persist.write_text(json.dumps(self._config_cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_persisted_config(self, src: Path) -> None:
        if src.exists():
            try:
                self._config_cache = json.loads(src.read_text(encoding="utf-8"))
            except Exception:
                self._config_cache = {}

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
        elif ev == "config":
            key, value = msg.get("key"), msg.get("value")
            if key is not None:
                self._config_cache[key] = value

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
                        entry = q.get(timeout=1.0)
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
            await asyncio.to_thread(sandbox.trigger, hook, data)
            return {"ok": True}
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
        clean: Dict[str, str] = {k: ("" if v is None else str(v)) for k, v in entries.items()}
        sandbox.set_config_entries(clean, persist=persist_path)
        return {"ok": True, "saved": list(clean.keys())}

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
