# -*- coding: utf-8 -*-
"""
FridaTest 控制面板（悬浮窗）
============================

功能：
- 等游戏进程启动后用 frida-python 附加并加载 dist/agent.js
- 左侧：mod 复选框（按分类分组，运行时动态开关，选中后写入 mods.json 下次沿用）
- 右侧：实时日志流（带自动滚动、清空、复制到剪贴板、保存到日志）
- 窗口默认置顶，可随时切到非置顶
"""

import json
import os
import queue
import re
import sys
import threading
import time
from pathlib import Path

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

ROOT_DIR = Path(__file__).resolve().parent
MODS_DIR = ROOT_DIR / "src" / "mods"
MODS_JSON = ROOT_DIR / "mods.json"
AGENT_JS = ROOT_DIR / "dist" / "agent.js"
LOG_DIR = ROOT_DIR / "logs"
PROCESS_NAME = "twinkle_starknightsX.exe"
LOG_MAX_LINES = 5000  # 日志缓存上限，超出自动裁剪头部


# ---------- mod 元数据 ----------
# 从 src/mods/*.ts 中正则提取 Mod 类的 name/category/description 字面量，
# 让 control.py 在未启动注入前也能拿到正确的元信息展示。

_CLASS_FIELD_RE = re.compile(
    r'''^\s*(name|category|description)\s*=\s*(["'])(.*?)\2''',
)


def _parse_mod_manifest() -> list[dict]:
    if not MODS_DIR.is_dir():
        return []
    result: list[dict] = []
    for path in sorted(MODS_DIR.glob("*.ts")):
        try:
            src = path.read_text(encoding="utf-8")
        except Exception:
            continue
        fields: dict = {}
        for line in src.splitlines():
            m = _CLASS_FIELD_RE.match(line)
            if m:
                fields[m.group(1)] = m.group(3)
        if "name" in fields:
            result.append({
                "name": fields["name"],
                "category": fields.get("category", "观察"),
                "description": fields.get("description", ""),
            })
    return result


# ---------- 通信协议 ----------
# Agent -> Host（通过 Frida script.on("message")）
#   type == "log"     : payload = {time, message}
#   type == "modList" : payload = {mods: [{name, description, category, enabled}]}
#   type == "modState": payload = {name, enabled}
#
# Host -> Agent（通过 script.post({"type": "toggle", ...})）
#   type == "toggle"  : {name, enabled}


# ============== Frida 会话线程 ==============

class FridaBridge:
    def __init__(self, ui_queue: "queue.Queue"):
        self.ui_queue = ui_queue
        self.device = None
        self.session = None
        self.script = None
        self._stop = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        try:
            if self.script:
                self.script.unload()
        except Exception:
            pass
        try:
            if self.session:
                self.session.detach()
        except Exception:
            pass

    def toggle_mod(self, name: str, enabled: bool):
        if self.script is None:
            return
        try:
            self.script.post({"type": "toggle",
                              "payload": {"name": name, "enabled": enabled}})
        except Exception as e:
            self._log_internal(f"[bridge] toggle {name}={enabled} 失败: {e}")

    # ------- 内部 -------

    def _run(self):
        try:
            import frida  # 延迟导入，用户没装时还能打开 UI 看提示
        except ImportError:
            self.ui_queue.put(("error",
                               "未安装 frida，请先执行：pip install frida frida-tools"))
            return

        self.device = frida.get_local_device()

        # 1) 等待目标进程启动（轮询，和 run.ps1 保持一致）
        self._log_internal(f"[bridge] 等待进程 {PROCESS_NAME} ...")
        pid = None
        while not self._stop.is_set():
            try:
                for p in self.device.enumerate_processes():
                    if p.name.lower() == PROCESS_NAME.lower():
                        pid = p.pid
                        break
            except Exception as e:
                self._log_internal(f"[bridge] 枚举进程出错: {e}，2 秒后重试")
                time.sleep(2)
                continue
            if pid is not None:
                break
            time.sleep(2)

        if self._stop.is_set():
            return

        # 2) attach + 加载脚本
        self._log_internal(f"[bridge] 找到进程 pid={pid}，开始注入 ...")
        try:
            self.session = self.device.attach(pid)
        except Exception as e:
            self.ui_queue.put(("error", f"附加进程失败: {e}"))
            return

        agent_source = AGENT_JS.read_text(encoding="utf-8")
        try:
            self.script = self.session.create_script(agent_source)
        except Exception as e:
            self.ui_queue.put(("error", f"创建 Frida script 失败: {e}"))
            return

        self.script.on("message", self._on_script_message)
        try:
            self.script.load()
        except Exception as e:
            self.ui_queue.put(("error", f"加载 agent.js 失败: {e}"))
            return
        self._log_internal("[bridge] 注入完成")
        self.ui_queue.put(("connected", True))

    def _on_script_message(self, message, data):
        if message["type"] == "send":
            info = message["payload"]
            msg_type = info.get("type")
            payload = info.get("payload", {})
            if msg_type == "log":
                self.ui_queue.put(
                    ("log", (payload.get("time", ""), payload.get("message", "")))
                )
            elif msg_type == "modList":
                self.ui_queue.put(("modList", payload.get("mods", [])))
            elif msg_type == "modState":
                self.ui_queue.put(
                    ("modState", (payload.get("name"), payload.get("enabled")))
                )
        elif message["type"] == "error":
            err = message.get("stack") or message.get("description") or str(message)
            self._log_internal(f"[agent-error] {err}")

    def _log_internal(self, text: str):
        # 宿主内部日志，没有时间戳，用 "bridge:" 前缀区分
        t = time.strftime("%H:%M:%S.") + f"{int(time.time()*1000)%1000:03d}"
        self.ui_queue.put(("log", (t, text)))


# ============== UI ==============

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("FridaTest 控制面板")
        self.geometry("680x480")
        self.minsize(460, 320)
        # 默认置顶
        self._always_top = True
        self.attributes("-topmost", True)

        self.ui_queue: "queue.Queue" = queue.Queue()
        self.bridge = FridaBridge(self.ui_queue)
        self.mod_vars: dict[str, tk.BooleanVar] = {}
        self.mod_rows: dict[str, dict] = {}  # 存 label 等引用，便于刷新状态
        self._started = False  # 是否已点击过「启动注入」

        self._build_ui()
        self._load_mods_json_defaults()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # UI 事件轮询（Frida 消息→主线程）
        self.after(80, self._poll_queue)

    # ---- UI 构建 ----

    def _build_ui(self):
        # 顶部工具栏
        toolbar = ttk.Frame(self, padding=(8, 6))
        toolbar.pack(side="top", fill="x")

        self.topmost_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            toolbar, text="窗口置顶", variable=self.topmost_var,
            command=self._toggle_topmost,
        ).pack(side="left")

        # 启动注入按钮（点击后切到日志页；注入完成后按钮置为"✓ 已注入"）
        self.start_btn = ttk.Button(
            toolbar, text="▶ 启动注入", command=self._on_click_start,
        )
        self.start_btn.pack(side="left", padx=(12, 4))

        ttk.Button(toolbar, text="清空日志", command=self._clear_log).pack(
            side="right", padx=4
        )
        ttk.Button(toolbar, text="复制日志", command=self._copy_log).pack(
            side="right", padx=4
        )
        self.save_btn = ttk.Button(
            toolbar, text="保存日志", command=self._save_log
        )
        self.save_btn.pack(side="right", padx=4)

        self.status_var = tk.StringVar(value="未连接")
        ttk.Label(toolbar, textvariable=self.status_var,
                  foreground="#555").pack(side="left", padx=16)

        # 主体：Notebook 两页切换（MODs / Logs），不同时显示
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(side="top", fill="both", expand=True, padx=8, pady=(0, 8))

        # ---- Tab 1：MOD 选择 ----
        mods_tab = ttk.Frame(self.notebook, padding=(10, 8))
        self.notebook.add(mods_tab, text="MODs")

        ttk.Label(
            mods_tab,
            text="先勾选所需 mod，再点击上方「▶ 启动注入」",
            font=("", 10, "bold"),
        ).pack(anchor="w", pady=(0, 8))

        self.category_frames: dict[str, ttk.LabelFrame] = {}
        for cat in ("观察", "修改", "调试"):
            lf = ttk.LabelFrame(mods_tab, text=cat, padding=(10, 6))
            lf.pack(fill="x", pady=4)
            self.category_frames[cat] = lf

        # ---- Tab 2：运行日志 ----
        logs_tab = ttk.Frame(self.notebook)
        self.notebook.add(logs_tab, text="Logs")

        log_header = ttk.Frame(logs_tab)
        log_header.pack(anchor="w", fill="x", pady=(8, 4), padx=8)
        ttk.Label(log_header, text="运行日志",
                  font=("", 10, "bold")).pack(side="left")

        self.log_text = scrolledtext.ScrolledText(
            logs_tab,
            wrap="none",
            font=("Consolas", 9),
            undo=False,
            bg="#1e1e1e",
            fg="#e6e6e6",
            insertbackground="#eee",
        )
        self.log_text.pack(side="top", fill="both", expand=True, padx=8, pady=(0, 8))
        # 彩色 tag
        self.log_text.tag_configure("t", foreground="#888888")   # 时间戳
        self.log_text.tag_configure("m", foreground="#e6e6e6")   # 消息
        self.log_text.tag_configure(
            "loader", foreground="#66ccff"
        )  # loader 前缀
        self.log_text.tag_configure(
            "bridge", foreground="#ffcc66"
        )  # bridge 前缀
        self.log_text.tag_configure(
            "err", foreground="#ff6666"
        )  # 错误
        self.log_text.configure(state="disabled")

    # ---- 初始化 / 保存 mods.json ----

    def _load_mods_json_defaults(self):
        """启动时按 mods.json + src/mods/*.ts 元数据渲染初始复选框。
        元数据来自源码解析（无需等 agent 注入就有正确 desc/category），
        勾选状态来自 mods.json（缺省则用 enabled）。"""
        cfg: dict = {}
        if MODS_JSON.exists():
            try:
                cfg = json.loads(MODS_JSON.read_text(encoding="utf-8"))
            except Exception:
                cfg = {}
        manifest = _parse_mod_manifest()
        if not manifest:
            # 拿不到源码时退回按 mods.json 盲渲染
            for name, enabled in cfg.items():
                self._upsert_mod_row(name, enabled=bool(enabled),
                                     category="观察", description="")
            return
        for meta in manifest:
            enabled = cfg[meta["name"]] if meta["name"] in cfg else True
            self._upsert_mod_row(
                meta["name"],
                enabled=bool(enabled),
                category=meta.get("category", "观察"),
                description=meta.get("description", ""),
            )

    def _upsert_mod_row(self, name: str, *, enabled: bool, category: str,
                        description: str):
        category = category if category in self.category_frames else "观察"
        parent = self.category_frames[category]

        if name in self.mod_vars:
            info = self.mod_rows[name]
            # 勾选/描述同步
            self.mod_vars[name].set(enabled)
            info["description"].configure(text=description or "")
            # 分组变化：拆出来挂到新分组
            if info["row"].master is not parent:
                info["row"].pack_forget()
                info["row"].pack(in_=parent, fill="x", pady=1)
            return

        var = tk.BooleanVar(value=enabled)
        row = ttk.Frame(parent)
        row.pack(fill="x", pady=1)

        cb = ttk.Checkbutton(
            row, variable=var, text=name,
            command=lambda n=name, v=var: self._on_mod_toggled(n, v),
        )
        cb.pack(side="left")

        desc_label = ttk.Label(row, text=description or "",
                               foreground="#666", font=("", 9))
        desc_label.pack(side="left", padx=8)

        self.mod_vars[name] = var
        self.mod_rows[name] = {"row": row, "description": desc_label}

    def _save_mods_json(self):
        data = {n: bool(v.get()) for n, v in self.mod_vars.items()}
        try:
            MODS_JSON.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except Exception as e:
            messagebox.showerror("保存失败",
                                 f"写入 mods.json 失败:\n{e}")

    # ---- UI 事件 ----

    def _toggle_topmost(self):
        self._always_top = bool(self.topmost_var.get())
        self.attributes("-topmost", self._always_top)

    def _on_click_start(self):
        if self._started:
            return
        self._started = True
        self.start_btn.configure(state="disabled", text="启动中（等待进程...）")
        self.status_var.set("等待游戏进程...")
        # 勾选变更先写一次 mods.json（作为 agent 加载初始值）
        self._save_mods_json()
        self.bridge.start()
        # 立即切到 Logs 页，避免用户注入期间还在改勾选
        self.notebook.select(1)

    def _on_mod_toggled(self, name: str, var: tk.BooleanVar):
        enabled = bool(var.get())
        # 只有 bridge.script 已就绪才实时推送给 agent；否则仅保存到 mods.json
        # 作为启动注入时的初始值。
        if self.bridge.script is not None:
            self.bridge.toggle_mod(name, enabled)
        self._save_mods_json()

    def _clear_log(self):
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _copy_log(self):
        content = self.log_text.get("1.0", "end-1c")
        self.clipboard_clear()
        self.clipboard_append(content)

    def _save_log(self):
        LOG_DIR.mkdir(exist_ok=True)
        fname = LOG_DIR / (time.strftime("%Y%m%d_%H%M%S") + "_panel.log")
        content = self.log_text.get("1.0", "end-1c")
        fname.write_text(content, encoding="utf-8")
        messagebox.showinfo("已保存", f"日志已保存到:\n{fname}")

    def _on_close(self):
        self.bridge.stop()
        self.destroy()

    # ---- 消息轮询 ----

    def _poll_queue(self):
        try:
            while True:
                kind, data = self.ui_queue.get_nowait()
                if kind == "log":
                    self._append_log(*data)
                elif kind == "modList":
                    self._apply_mod_list(data)
                elif kind == "modState":
                    self._apply_mod_state(*data)
                elif kind == "error":
                    self._append_log(time.strftime("%H:%M:%S.") +
                                     f"{int(time.time()*1000)%1000:03d}",
                                     data, error=True)
                    messagebox.showerror("错误", data)
                elif kind == "connected":
                    self.start_btn.configure(state="disabled", text="✓ 已注入")
        except queue.Empty:
            pass
        self.after(80, self._poll_queue)

    def _apply_mod_list(self, mods: list[dict]):
        for m in mods:
            self._upsert_mod_row(
                m.get("name", "?"),
                enabled=bool(m.get("enabled", False)),
                category=m.get("category", "观察"),
                description=m.get("description", ""),
            )
        self.status_var.set(
            f"已加载 {sum(1 for m in mods if m.get('enabled'))}/{len(mods)} 个 mod"
        )

    def _apply_mod_state(self, name: str, enabled: bool):
        if name in self.mod_vars:
            self.mod_vars[name].set(bool(enabled))

    # ---- 日志渲染 ----

    def _append_log(self, time_str: str, message: str, error: bool = False):
        self.log_text.configure(state="normal")

        # 消息 tag 分流
        msg_tags = ("m",)
        if error:
            msg_tags = ("err",)
        elif message.startswith("[loader]"):
            msg_tags = ("loader",)
        elif message.startswith("[bridge]") or message.startswith(
            "[agent-error]"
        ):
            msg_tags = ("bridge",)

        self.log_text.insert("end", f"[{time_str}] ", ("t",))
        self.log_text.insert("end", message + "\n", msg_tags)

        # 裁剪过旧日志
        line_count = int(self.log_text.index("end-1c").split(".")[0])
        if line_count > LOG_MAX_LINES:
            self.log_text.delete("1.0", f"{line_count - LOG_MAX_LINES}.0")

        # 自动滚到底（只在用户停留在底部时，避免手动向上翻看被顶走）
        if float(self.log_text.yview()[1]) > 0.9:
            self.log_text.see("end")

        self.log_text.configure(state="disabled")


def main():
    # 让中文在高 DPI 显示器下清晰
    if sys.platform.startswith("win"):
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
