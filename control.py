# -*- coding: utf-8 -*-
"""
TSKBattleLog 控制面板（悬浮窗）
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
import urllib.request
from pathlib import Path

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
from PIL import Image, ImageTk

ROOT_DIR = Path(__file__).resolve().parent
MODS_DIR = ROOT_DIR / "src" / "mods"
MODS_JSON = ROOT_DIR / "mods.json"
TRACE_CONFIG_JSON = ROOT_DIR / "trace_config.json"
AGENT_JS = ROOT_DIR / "dist" / "agent.js"
LOG_DIR = ROOT_DIR / "logs"
GUI_CONFIG = ROOT_DIR / "gui_config.json"
ICON_CACHE_DIR = ROOT_DIR / "cache" / "icons"
PROCESS_NAME = "twinkle_starknightsX.exe"
LOG_MAX_LINES = 5000  # 日志缓存上限，超出自动裁剪头部
WIKI_BASE = "https://twinklestarknights.wikiru.jp"


def wiki_icon_url(unit_name: str, character_name: str) -> str:
    """构造 wiki 头像直链。
    规律（已验证）：attach2/696D67_<hex_utf8('［UnitName］角色名_icon_NF.png')>.png
    其中 696D67 是 "img" 的 hex 前缀。"""
    page = f"［{unit_name}］{character_name}_icon_NF.png"
    hx = page.encode("utf-8").hex().upper()
    return f"{WIKI_BASE}/attach2/696D67_{hx}.png"


# ---------- mod 元数据 ----------
# 从 src/mods/*.ts 中正则提取 Mod 类的 name/category/description 字面量，
# 让 control.py 在未启动注入前也能拿到正确的元信息展示。
# 支持 = 后换行再接字符串的写法（如较长的 description）。

_CLASS_FIELD_RE = re.compile(
    r'''^\s*(name|category|description)\s*=\s*(?:\n\s*)?(["'])(.*?)\2''',
    re.MULTILINE,
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
        for m in _CLASS_FIELD_RE.finditer(src):
            key = m.group(1)
            if key not in fields:
                fields[key] = m.group(3)
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
# Host -> Agent（通过 script.post(...)）
#   type == "toggle"      : {name, enabled}
#   type == "traceConfig" : trace_config.json 全量内容（trace/backtrace/backtraceDepth）


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

    def post(self, message: dict):
        """向 agent 发送任意消息（要求 script 已加载）"""
        if self.script is None:
            return
        try:
            self.script.post(message)
        except Exception as e:
            self._log_internal(f"[bridge] post {message.get('type')} 失败: {e}")

    def toggle_mod(self, name: str, enabled: bool):
        if self.script is None:
            return
        try:
            self.script.post({"type": "toggle",
                              "payload": {"name": name, "enabled": enabled}})
        except Exception as e:
            self._log_internal(f"[bridge] toggle {name}={enabled} 失败: {e}")

    def post_trace_config(self):
        """把 trace_config.json 全量下发给 agent（trace-config / backtrace 两个 mod 消费）"""
        if self.script is None:
            self._log_internal("[bridge] 尚未注入，无法下发 traceConfig")
            return
        try:
            cfg = json.loads(TRACE_CONFIG_JSON.read_text(encoding="utf-8"))
            self.script.post({"type": "traceConfig", "payload": cfg})
            self._log_internal("[bridge] traceConfig 已下发")
        except Exception as e:
            self._log_internal(f"[bridge] 下发 traceConfig 失败: {e}")

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
                # 收到 modList 说明 agent 侧 recv 已注册完毕，此时下发调试观察点配置
                self.post_trace_config()
            elif msg_type == "modState":
                self.ui_queue.put(
                    ("modState", (payload.get("name"), payload.get("enabled")))
                )
            elif msg_type == "unitList":
                self.ui_queue.put(("unitList", payload))
            elif msg_type == "buffData":
                self.ui_queue.put(("buffData", payload))
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
        self.title("TSKBattleLog 控制面板")
        self.geometry("680x480")
        self.minsize(460, 320)
        # 恢复上次的窗口位置与大小（geometry: "WxH+X+Y"）
        self._restore_geometry()
        # 默认置顶
        self._always_top = True
        self.attributes("-topmost", True)

        self.ui_queue: "queue.Queue" = queue.Queue()
        self.bridge = FridaBridge(self.ui_queue)
        self.mod_vars: dict[str, tk.BooleanVar] = {}
        self.mod_rows: dict[str, dict] = {}  # 存 label 等引用，便于刷新状态
        self._started = False  # 是否已点击过「启动注入」
        # 出战角色头像栏 + buff 弹窗
        self.unit_buttons: dict[str, ttk.Button] = {}
        self.unit_photos: dict[str, ImageTk.PhotoImage] = {}  # 保引用防 GC
        self.enemy_buttons: dict[str, ttk.Button] = {}  # 敌人紧凑文字按钮
        self._buff_dialog: dict | None = None
        self._log_file = None  # 自动落盘文件句柄，注入启动时创建

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

        ttk.Button(
            toolbar, text="重载配置", command=self._reload_trace_config
        ).pack(side="left", padx=4)

        # 隐藏/显示角色头像栏和敌人条（专注看日志时用）
        self.hide_units_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            toolbar, text="隐藏单位栏", variable=self.hide_units_var,
            command=self._toggle_units_visibility,
        ).pack(side="left", padx=4)

        ttk.Button(toolbar, text="清空日志", command=self._clear_log).pack(
            side="right", padx=4
        )
        ttk.Button(toolbar, text="复制日志", command=self._copy_log).pack(
            side="right", padx=4
        )
        ttk.Button(
            toolbar, text="打开日志目录", command=self._open_log_dir
        ).pack(side="right", padx=4)

        self.status_var = tk.StringVar(value="未连接")
        ttk.Label(toolbar, textvariable=self.status_var,
                  foreground="#555").pack(side="left", padx=16)

        # 出战角色头像栏（战斗初始化后由 agent 上报 unitList 填充）
        self.units_bar = ttk.Frame(self)  # 初始不 pack，收到 unitList 才显示
        # 敌人紧凑条（纯文字小按钮，不下载头像）
        self.enemies_bar = ttk.Frame(self)

        # 主体：Notebook 两页切换（MODs / Logs），不同时显示
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(side="top", fill="both", expand=True, padx=8, pady=(0, 8))

        # ---- Tab 1：MOD 选择（Canvas 滚动容器，锁定勾选后仍可滚动查看） ----
        mods_tab = ttk.Frame(self.notebook)
        self.notebook.add(mods_tab, text="MODs")

        mods_canvas = tk.Canvas(mods_tab, highlightthickness=0)
        mods_scrollbar = ttk.Scrollbar(mods_tab, orient="vertical",
                                       command=mods_canvas.yview)
        mods_inner = ttk.Frame(mods_canvas, padding=(10, 8))
        mods_inner.bind(
            "<Configure>",
            lambda e: mods_canvas.configure(
                scrollregion=mods_canvas.bbox("all")),
        )
        mods_canvas.create_window((0, 0), window=mods_inner, anchor="nw",
                                  tags="inner")
        mods_canvas.bind(
            "<Configure>",
            lambda e: mods_canvas.itemconfigure("inner", width=e.width),
        )
        mods_canvas.configure(yscrollcommand=mods_scrollbar.set)
        mods_canvas.pack(side="left", fill="both", expand=True)
        mods_scrollbar.pack(side="right", fill="y")

        # Windows 滚轮直接生效；绑定在 canvas 与内部控件上（锁定复选框不影响）
        def _on_mousewheel(event):
            mods_canvas.yview_scroll(int(-event.delta / 120), "units")

        def _bind_wheel(widget):
            widget.bind("<MouseWheel>", _on_mousewheel)
            for child in widget.winfo_children():
                _bind_wheel(child)

        _bind_wheel(mods_inner)
        self._bind_mods_wheel = _bind_wheel  # 供 _upsert_mod_row 给动态行绑定

        mods_tab = mods_inner
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

        # 跟随状态：初始跟随；用户上滚则暂停，滚回底部自动恢复
        self._log_follow = True
        self.log_text.bind("<MouseWheel>",
                           lambda e: self.after_idle(self._update_log_follow))
        self.log_text.vbar.bind(
            "<ButtonPress-1>",
            lambda e: self.after_idle(self._update_log_follow))
        self.log_text.vbar.bind(
            "<B1-Motion>",
            lambda e: self.after_idle(self._update_log_follow))

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
                        description: str, preserve_state: bool = False):
        category = category if category in self.category_frames else "观察"
        parent = self.category_frames[category]

        if name in self.mod_vars:
            info = self.mod_rows[name]
            # 同步描述；勾选状态默认跟随上报值，preserve_state 时保留用户勾选
            if not preserve_state:
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
        # 新行动态绑定滚轮，保证鼠标悬停在行上也能滚动
        if hasattr(self, "_bind_mods_wheel"):
            self._bind_mods_wheel(row)

        cb = ttk.Checkbutton(
            row, variable=var, text=name,
            command=lambda n=name, v=var: self._on_mod_toggled(n, v),
        )
        cb.pack(side="left")

        desc_label = ttk.Label(row, text=description or "",
                               foreground="#666", font=("", 9))
        desc_label.pack(side="left", padx=8)

        self.mod_vars[name] = var
        self.mod_rows[name] = {"row": row, "checkbox": cb,
                               "description": desc_label}

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

    def _toggle_units_visibility(self):
        """隐藏/显示玩家头像栏与敌人条（不影响头像下载和 buff 查询）"""
        hidden = bool(self.hide_units_var.get())
        if hidden:
            self.units_bar.pack_forget()
            self.enemies_bar.pack_forget()
        else:
            # 重新按固定顺序排回：敌人条在玩家头像栏之上
            if self.enemy_buttons:
                before = self.units_bar \
                    if self.units_bar.winfo_manager() == "pack" \
                    else self.notebook
                self.enemies_bar.pack(side="top", fill="x", padx=8,
                                      pady=(2, 4), before=before)
            if self.unit_buttons:
                self.units_bar.pack(side="top", fill="x", padx=8,
                                    pady=(0, 2), before=self.notebook)

    def _on_click_start(self):
        if self._started:
            return
        self._started = True
        self.start_btn.configure(state="disabled", text="启动中（等待进程...）")
        self.status_var.set("等待游戏进程...")
        # 锁定所有 mod 复选框，注入后不允许再改
        for info in self.mod_rows.values():
            info["checkbox"].configure(state="disabled")
        # 勾选变更先写一次 mods.json（作为 agent 加载初始值）
        self._save_mods_json()
        # 创建本次会话的自动落盘日志文件
        LOG_DIR.mkdir(exist_ok=True)
        log_name = time.strftime("%Y%m%d_%H%M%S") + "_panel.log"
        self._log_file = open(LOG_DIR / log_name, "w", encoding="utf-8",
                             buffering=8192)
        self.bridge.start()
        # 立即切到 Logs 页，避免用户注入期间还在改勾选
        self.notebook.select(1)

    def _reload_trace_config(self):
        self.bridge.post_trace_config()

    def _on_mod_toggled(self, name: str, var: tk.BooleanVar):
        enabled = bool(var.get())
        # 只有 bridge.script 已就绪才实时推送给 agent；否则仅保存到 mods.json
        # 作为启动注入时的初始值。
        if self.bridge.script is not None:
            self.bridge.toggle_mod(name, enabled)
        self._save_mods_json()

    def _clear_log(self):
        self._log_follow = True
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _copy_log(self):
        content = self.log_text.get("1.0", "end-1c")
        self.clipboard_clear()
        self.clipboard_append(content)

    def _open_log_dir(self):
        LOG_DIR.mkdir(exist_ok=True)
        try:
            os.startfile(str(LOG_DIR))
        except Exception as e:
            messagebox.showerror("打开失败", f"无法打开日志目录:\n{e}")

    def _restore_geometry(self):
        """从 gui_config.json 恢复窗口位置与大小；越界/损坏时静默回退默认"""
        try:
            cfg = json.loads(GUI_CONFIG.read_text(encoding="utf-8"))
            geom = cfg.get("geometry")
            if isinstance(geom, str):
                self.geometry(geom)
        except Exception:
            pass

    def _save_geometry(self):
        """保存当前窗口位置与大小到 gui_config.json"""
        try:
            GUI_CONFIG.write_text(
                json.dumps({"geometry": self.geometry()}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _on_close(self):
        self._save_geometry()
        self.bridge.stop()
        if self._log_file:
            try:
                self._log_file.flush()
                self._log_file.close()
            except Exception:
                pass
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
                elif kind == "unitList":
                    self._apply_unit_list(data)
                elif kind == "buffData":
                    self._apply_buff_data(data)
                elif kind == "unitIconReady":
                    self._apply_unit_icon(*data)
                elif kind == "unitIconFailed":
                    self._apply_unit_icon_failed(*data)
        except queue.Empty:
            pass
        self.after(80, self._poll_queue)

    def _apply_mod_list(self, mods: list[dict]):
        # agent 的 modList 反映的是 build 时打包进 agent.js 的旧配置；
        # 保留用户在 GUI 里的勾选意图（preserve_state），不做反向覆盖
        for m in mods:
            self._upsert_mod_row(
                m.get("name", "?"),
                enabled=bool(m.get("enabled", False)),
                category=m.get("category", "观察"),
                description=m.get("description", ""),
                preserve_state=True,
            )

        # 把 GUI 勾选状态与 agent 实际状态做 diff，差异的下发 toggle。
        # agent 收到 enabled=true 且未加载的 mod 会补执行 onLoad（运行时启用），
        # enabled=false 只置标志（hook 已挂的由守卫跳过）。
        synced = 0
        for m in mods:
            name = m.get("name", "?")
            if name not in self.mod_vars:
                continue
            desired = bool(self.mod_vars[name].get())
            if desired != bool(m.get("enabled", False)):
                self.bridge.toggle_mod(name, desired)
                synced += 1
        if synced > 0:
            t = time.strftime("%H:%M:%S.") + f"{int(time.time()*1000)%1000:03d}"
            self._append_log(
                t, f"[bridge] 按面板勾选同步 {synced} 个 mod 开关到 agent"
            )

        # 状态栏以面板勾选为准（同步消息随后由 agent 确认）
        desired_enabled = sum(
            1 for m in mods
            if m.get("name") in self.mod_vars
            and self.mod_vars[m["name"]].get()
        )
        self.status_var.set(f"已加载 {desired_enabled}/{len(mods)} 个 mod")

    def _apply_mod_state(self, name: str, enabled: bool):
        if name in self.mod_vars:
            self.mod_vars[name].set(bool(enabled))

    # ---- 出战角色头像栏 / buff 查询 ----

    def _apply_unit_list(self, payload):
        """agent 战斗初始化后上报单位：team=Player 走头像栏，Enemy 走紧凑文字条。
        兼容旧格式（直接传 units 数组，视为玩家）。"""
        if isinstance(payload, dict):
            team = payload.get("team", "Player")
            units = payload.get("units", [])
        else:
            team, units = "Player", payload
        if team == "Enemy":
            self._apply_enemy_list(units)
        else:
            self._apply_player_list(units)

    def _apply_player_list(self, units: list[dict]):
        """玩家方：头像按钮，后台下载/读缓存 wiki 头像"""
        for w in self.units_bar.winfo_children():
            w.destroy()
        self.unit_buttons.clear()
        self.unit_photos.clear()
        if not units:
            self.units_bar.pack_forget()
            return
        # 用户勾选隐藏时：按钮照常构建（取消隐藏立即可见），仅不 pack 栏
        if not self.hide_units_var.get():
            self.units_bar.pack(side="top", fill="x", padx=8, pady=(0, 2),
                                before=self.notebook)
        for u in units:
            address = u.get("address", "")
            name = u.get("characterName", "?")
            btn = ttk.Button(
                self.units_bar, text=name, compound="top",
                command=lambda a=address, n=name: self._on_unit_click(a, n),
            )
            btn.pack(side="left", padx=6, pady=2)
            self.unit_buttons[address] = btn
            threading.Thread(target=self._download_icon, args=(u,),
                             daemon=True).start()
        self._append_log(time.strftime("%H:%M:%S.") +
                         f"{int(time.time()*1000)%1000:03d}",
                         f"[units] 出战角色 {len(units)} 名，点击头像可查看 buff")

    def _apply_enemy_list(self, units: list[dict]):
        """敌方：紧凑文字小按钮条（不下载头像，少占空间），放在玩家头像栏上方"""
        for w in self.enemies_bar.winfo_children():
            w.destroy()
        self.enemy_buttons.clear()
        if not units:
            self.enemies_bar.pack_forget()
            return
        # 用户勾选隐藏时：按钮照常构建，仅不 pack 栏
        if not self.hide_units_var.get():
            # 敌人条排在玩家头像栏之上；玩家栏还没出现时退而贴在 notebook 前
            before = self.units_bar \
                if self.units_bar.winfo_manager() == "pack" \
                else self.notebook
            self.enemies_bar.pack(side="top", fill="x", padx=8, pady=(2, 4),
                                  before=before)
        ttk.Label(self.enemies_bar, text="敌人:",
                  foreground="#c0392b").pack(side="left", padx=(0, 4))
        for u in units:
            address = u.get("address", "")
            name = u.get("characterName", "?")
            short = name if len(name) <= 12 else name[:11] + "…"
            btn = tk.Button(
                self.enemies_bar, text=short, font=("", 8),
                relief="flat", bg="#fdecea", fg="#c0392b",
                activebackground="#f5c6cb", bd=0, padx=6, pady=1,
                cursor="hand2",
                command=lambda a=address, n=name: self._on_unit_click(a, n),
            )
            btn.pack(side="left", padx=3)
            self.enemy_buttons[address] = btn
        self._append_log(time.strftime("%H:%M:%S.") +
                         f"{int(time.time()*1000)%1000:03d}",
                         f"[units] 敌人 {len(units)} 名，点击名字可查看 buff")

    def _download_icon(self, unit: dict):
        """后台线程：读缓存或从 wiki 下载头像，结果经 ui_queue 回主线程"""
        address = unit.get("address", "")
        try:
            url = wiki_icon_url(unit.get("unitName", ""),
                                unit.get("characterName", ""))
            fname = url.rsplit("/", 1)[-1]
            ICON_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path = ICON_CACHE_DIR / fname
            if not path.exists():
                req = urllib.request.Request(
                    url, headers={"User-Agent": "Mozilla/5.0 FridaTestControl"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read()
                if len(data) < 100:
                    raise ValueError(f"响应过小 ({len(data)} bytes)，URL 可能失效")
                path.write_bytes(data)
            img = Image.open(path).convert("RGBA").resize((48, 48))
            self.ui_queue.put(("unitIconReady", (address, img)))
        except Exception as e:
            self.ui_queue.put(("unitIconFailed",
                               (address, str(e), unit.get("characterName", "?"))))

    def _apply_unit_icon(self, address: str, img: "Image.Image"):
        photo = ImageTk.PhotoImage(img)
        self.unit_photos[address] = photo  # 保引用，防止被 GC 后图片消失
        btn = self.unit_buttons.get(address)
        if btn:
            btn.configure(image=photo)

    def _apply_unit_icon_failed(self, address: str, err: str, name: str):
        self._append_log(time.strftime("%H:%M:%S.") +
                         f"{int(time.time()*1000)%1000:03d}",
                         f"[units] 头像加载失败 {name}: {err}")

    def _on_unit_click(self, address: str, name: str | None = None):
        if self.bridge.script is None:
            messagebox.showinfo("提示", "尚未注入，无法查询 buff")
            return
        self._open_buff_dialog(address, name)
        self.bridge.post({"type": "buffRequest", "payload": {"address": address}})

    def _open_buff_dialog(self, address: str, name: str | None = None):
        if self._buff_dialog is not None:
            try:
                self._buff_dialog["top"].destroy()
            except Exception:
                pass
        top = tk.Toplevel(self)
        top.title(f"Skill Effects - {name or address}")
        top.geometry("860x420")
        top.attributes("-topmost", self._always_top)

        header = ttk.Frame(top)
        header.pack(fill="x", padx=8, pady=4)
        info = ttk.Label(header, text="读取中...")
        info.pack(side="left")
        # 切换：逐条明细 / 同 type 汇总（仅累计 value、effectValue）
        mode_var = tk.BooleanVar(value=False)
        toggle_btn = ttk.Button(header, text="切换为汇总",
                                command=lambda: self._toggle_buff_mode())
        toggle_btn.pack(side="right")

        # 战斗实时属性（ATK/CRT/EX），buffData 回来后填充
        stats_label = ttk.Label(
            top, text="", font=("", 10, "bold"),
            foreground="#1a5fb4",
        )
        stats_label.pack(anchor="w", padx=8, pady=(0, 2))

        cols = ("type", "time", "value", "effectValue",
                "value2", "value3", "value4", "value5")
        widths = (300, 70, 80, 90, 70, 70, 70, 70)
        tree = ttk.Treeview(top, columns=cols, show="headings")
        for c, w in zip(cols, widths):
            tree.heading(c, text=c)
            tree.column(c, width=w, anchor="center")
        tree.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self._buff_dialog = {"top": top, "tree": tree, "info": info,
                             "stats_label": stats_label,
                             "address": address, "mode_var": mode_var,
                             "toggle_btn": toggle_btn, "effects": None}

    def _toggle_buff_mode(self):
        dlg = self._buff_dialog
        if dlg is None or dlg["effects"] is None:
            return
        total_mode = not dlg["mode_var"].get()
        dlg["mode_var"].set(total_mode)
        dlg["toggle_btn"].configure(
            text="切换为明细" if total_mode else "切换为汇总")
        tree = dlg["tree"]
        for row in tree.get_children():
            tree.delete(row)
        if total_mode:
            tree.configure(columns=("type", "count", "value", "effectValue"))
            for c, w, t in (("type", 360, "type"), ("count", 70, "count"),
                            ("value", 100, "value"),
                            ("effectValue", 110, "effectValue")):
                tree.heading(c, text=t)
                tree.column(c, width=w, anchor="center")
            totals: dict[str, list] = {}
            for it in dlg["effects"]:
                t_ = it.get("type", "")
                acc = totals.setdefault(t_, [0, 0, 0])
                acc[0] += 1
                acc[1] += it.get("value", 0) or 0
                acc[2] += it.get("effectValue", 0) or 0
            for t_, (cnt, v, ev) in sorted(
                totals.items(), key=lambda kv: -kv[1][1]):
                tree.insert("", "end", values=(t_, cnt, v, ev))
        else:
            tree.configure(columns=("type", "time", "value", "effectValue",
                                    "value2", "value3", "value4", "value5"))
            for c, w in zip(("type", "time", "value", "effectValue",
                             "value2", "value3", "value4", "value5"),
                            (300, 70, 80, 90, 70, 70, 70, 70)):
                tree.heading(c, text=c)
                tree.column(c, width=w, anchor="center")
            for it in dlg["effects"]:
                tree.insert("", "end", values=(
                    it.get("type", ""), it.get("time", ""), it.get("value", ""),
                    it.get("effectValue", ""), it.get("value2", ""),
                    it.get("value3", ""), it.get("value4", ""),
                    it.get("value5", ""),
                ))

    def _apply_buff_data(self, payload: dict):
        dlg = self._buff_dialog
        if dlg is None or payload.get("address") != dlg["address"]:
            return
        if "error" in payload:
            dlg["info"].configure(text=f"读取失败（战斗结束后地址会失效）: {payload['error']}")
            dlg["stats_label"].configure(text="")
            return
        effects = payload.get("effects", [])
        dlg["effects"] = effects
        dlg["info"].configure(text=f"共 {len(effects)} 个效果")

        # 战斗实时属性（ATK 含 buff / base / CRT / EX 上升 / 普攻回复 EX）
        stats = payload.get("stats") or {}
        if stats.get("error"):
            dlg["stats_label"].configure(
                text=f"(属性读取失败: {stats['error']})", foreground="#999")
        elif stats:
            crt = stats.get("crt")
            crt_str = f"{crt/100:.2f}%" if isinstance(crt, (int, float)) else str(crt)
            note_count = stats.get("noteCount")
            dlg["stats_label"].configure(
                text=(f"ATK: {stats.get('atk')}  (base {stats.get('baseAttack')})    "
                      f"CRT: {crt_str}    "
                      f"NoteCount: {note_count}    "
                      f"EX上升: {stats.get('exUp')}    "
                      f"普攻回复EX: {stats.get('exGain')}"),
                foreground="#1a5fb4")
        else:
            dlg["stats_label"].configure(text="")
        # 每次新数据先重置为明细模式，再渲染
        dlg["mode_var"].set(False)
        dlg["toggle_btn"].configure(text="切换为汇总")
        tree = dlg["tree"]
        tree.configure(columns=("type", "time", "value", "effectValue",
                                "value2", "value3", "value4", "value5"))
        for c, w in zip(("type", "time", "value", "effectValue",
                         "value2", "value3", "value4", "value5"),
                        (300, 70, 80, 90, 70, 70, 70, 70)):
            tree.heading(c, text=c)
            tree.column(c, width=w, anchor="center")
        for row in tree.get_children():
            tree.delete(row)
        for it in effects:
            tree.insert("", "end", values=(
                it.get("type", ""), it.get("time", ""), it.get("value", ""),
                it.get("effectValue", ""), it.get("value2", ""),
                it.get("value3", ""), it.get("value4", ""), it.get("value5", ""),
            ))

    # ---- 日志渲染 ----

    def _update_log_follow(self):
        """用户滚轮/拖滚动条后调用：位于底部则恢复跟随，否则暂停"""
        self._log_follow = float(self.log_text.yview()[1]) >= 0.999

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

        # 跟随模式：用户停在底部（或从未上滚）才自动滚到底
        if self._log_follow:
            self.log_text.see("end")

        self.log_text.configure(state="disabled")

        # 同步写入文件（缓冲 8KB，不每行碰磁盘）
        if self._log_file:
            try:
                self._log_file.write(f"[{time_str}] {message}\n")
            except Exception:
                pass


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
