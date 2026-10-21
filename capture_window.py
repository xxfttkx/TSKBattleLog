# 网络抓包查看页（Notebook「Capture」标签页）
# ==============================
# 以 mixin 形式挂在 App 上（同 battle_log_window 的模式，避免反向 import）：
# - 文件下拉 + 刷新 + 打开目录：浏览 logs/capture/*.jsonl（按修改时间倒序）
# - Treeview 事件列表（seq/time/kind/api/preview，kind 着色）
# - 点击行在右侧只读 Text 显示该次请求的完整链路（JSON 自动缩进美化）
# 数据落盘由 control.py 的 FridaBridge._append_capture 完成，本页只做浏览。

import json
import os
import re
import tkinter as tk
from pathlib import Path
from tkinter import ttk, scrolledtext

# kind -> 前景色（与 Logs 页彩色 tag 同风格）
_CAPTURE_KIND_COLORS = {
    "req": "#1a5fb4",
    "resp": "#26a269",
    "meta": "#77767b",
    "url": "#813d9c",
}

# 详情区深色底（#1e1e1e）专用配色，参照 VS Code dark+ 的 JSON 高亮
_DETAIL_TAG_COLORS = {
    "json_key": "#9cdcfe",
    "json_str": "#ce9178",
    "json_num": "#b5cea8",
    "json_bool": "#569cd6",
    "json_punct": "#d4d4d4",
    "seg_head": "#e6e6e6",
    "req": "#7aa2f7",
    "resp": "#9ece6a",
    "meta": "#a0a0a0",
    "url": "#bb9af7",
}

# JSON token 匹配：带冒号的字符串=键；其余字符串=值；数字/布尔/null/标点
_JSON_TOKEN_RE = re.compile(
    r'("(?:\\.|[^"\\])*")(?=\s*:)'      # 1: 键（后随冒号）
    r'|("(?:\\.|[^"\\])*")'             # 2: 字符串值
    r'|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)'  # 3: 数字
    r'|\b(true|false)\b'                # 4: 布尔
    r'|\b(null)\b'                      # 5: null
)

_PREVIEW_LEN = 100


def _short(s: str, n: int) -> str:
    s = s or ""
    return (s[:n] + "…") if len(s) > n else s


def _time_diff_ms(t0: str | None, t1: str | None) -> int | None:
    """'HH:MM:SS.mmm' 差值（ms）；跨午夜/解析失败返回 None"""
    try:
        def parse(t: str) -> int:
            h, m, rest = t.split(":")
            s, ms = rest.split(".")
            return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)
        d = parse(t1) - parse(t0)
        return d if d >= 0 else None
    except (AttributeError, ValueError):
        return None


class CaptureTabMixin:
    def _build_capture_tab(self, notebook):
        tab = ttk.Frame(notebook)
        # 页面顺序由调用时机保证：必须在 Logs 之后、设置页 add 之前调用
        notebook.add(tab, text="Capture")

        # ---- 工具条 ----
        header = ttk.Frame(tab)
        header.pack(anchor="w", fill="x", pady=(8, 4), padx=8)
        ttk.Label(header, text="网络抓包", font=("", 10, "bold")).pack(
            side="left")
        self.capture_file_var = tk.StringVar()
        self.capture_file_combo = ttk.Combobox(
            header, textvariable=self.capture_file_var,
            state="readonly", width=32)
        self.capture_file_combo.pack(side="left", padx=(12, 4))
        self.capture_file_combo.bind(
            "<<ComboboxSelected>>", lambda _e: self._load_capture_file())
        ttk.Button(header, text="刷新",
                   command=self._refresh_capture_files).pack(side="left",
                                                             padx=4)
        ttk.Button(header, text="打开目录",
                   command=self._open_capture_dir).pack(side="left", padx=4)
        # 「原始事件」开关：开=显示全部（含 meta、重复 resp）；
        # 关（默认）=隐藏 meta、同段相同 resp 只显示一次。存 gui_config.json
        self.capture_raw_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(header, text="原始事件",
                        variable=self.capture_raw_var,
                        command=self._on_capture_raw_toggle).pack(
            side="left", padx=(12, 0))

        # ---- 主区：左事件列表 + 右详情（横向可拖分栏）----
        paned = ttk.PanedWindow(tab, orient="horizontal")
        paned.pack(side="top", fill="both", expand=True, padx=8, pady=(0, 8))

        # 左：事件列表（带纵向滚动条）。默认合并视图一行=一次请求
        # （displaycolumns 隐藏 kind/latency 中不适用的一列，按模式切换）
        tree_frame = ttk.Frame(paned)
        cols = ("seq", "time", "kind", "api", "latency", "preview")
        self.capture_tree = ttk.Treeview(
            tree_frame, columns=cols, show="headings")
        for col, text, width in (
            ("seq", "#", 40),
            ("time", "时间", 80),
            ("kind", "类型", 48),
            ("api", "接口", 150),
            ("latency", "耗时", 72),
            ("preview", "预览", 200),
        ):
            self.capture_tree.heading(col, text=text)
            self.capture_tree.column(
                col, width=width, anchor="w",
                stretch=(col == "preview"))
        for kind, color in _CAPTURE_KIND_COLORS.items():
            self.capture_tree.tag_configure(kind, foreground=color)
        # 合并视图：响应 code 非 1000 的请求整行标红
        self.capture_tree.tag_configure("err", foreground="#e01b24")
        ysb = ttk.Scrollbar(tree_frame, orient="vertical",
                            command=self.capture_tree.yview)
        self.capture_tree.configure(yscrollcommand=ysb.set)
        self.capture_tree.grid(row=0, column=0, sticky="nsew")
        ysb.grid(row=0, column=1, sticky="ns")
        tree_frame.rowconfigure(0, weight=1)
        tree_frame.columnconfigure(0, weight=1)
        self.capture_tree.bind("<<TreeviewSelect>>",
                               self._on_capture_select)
        paned.add(tree_frame, weight=3)

        # 右：详情（选中行显示整段链路）
        self.capture_detail = scrolledtext.ScrolledText(
            paned, wrap="none", font=("Consolas", 9), undo=False,
            bg="#1e1e1e", fg="#e6e6e6")
        paned.add(self.capture_detail, weight=2)
        for tag, color in _DETAIL_TAG_COLORS.items():
            self.capture_detail.tag_configure(tag, foreground=color)
        self.capture_detail.configure(state="disabled")

        self._capture_rows: list[dict] = []
        self._capture_loaded_path: Path | None = None
        # 请求段分组（req 行开段，段内事件同属一次请求交互）
        self._capture_segments: list[list[dict]] = []
        self._capture_row_seg: list[int] = []

        # Treeview 行字号走独立 style（ttk 控件字体不能直接 configure）
        style = ttk.Style()
        style.configure("Capture.Treeview", font=("Consolas", 9),
                        rowheight=9 * 2 + 6)
        self.capture_tree.configure(style="Capture.Treeview")

        # 切到本页时自动刷新（新抓包文件/文件增长），保证看到本次会话最新数据
        notebook.bind("<<NotebookTabChanged>>", self._on_capture_tab_changed)

        self._refresh_capture_files()
        self._show_capture_legend()

    def _on_capture_tab_changed(self, event):
        if event.widget is not getattr(self, "notebook", None):
            return
        try:
            if self.notebook.tab(self.notebook.select(), "text") == "Capture":
                self._refresh_capture_files()
        except tk.TclError:
            pass

    def apply_capture_font(self, size: int):
        """与设置页「字号」联动：事件列表与详情区跟随 log 字号"""
        size = int(size)
        self.capture_tree.configure(style="Capture.Treeview")
        ttk.Style().configure("Capture.Treeview",
                              font=("Consolas", size), rowheight=size * 2 + 6)
        self.capture_detail.configure(font=("Consolas", size))

    # ---- 文件 ----
    def _capture_dir(self) -> Path:
        return getattr(self, "_CAPTURE_DIR", None) or (
            Path(__file__).resolve().parent / "logs" / "capture")

    def _refresh_capture_files(self):
        cap_dir = self._capture_dir()
        files = []
        if cap_dir.is_dir():
            files = sorted(cap_dir.glob("*.jsonl"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
        names = [p.name for p in files]
        self.capture_file_combo.configure(values=names)
        if names:
            # 优先跳当次抓包会话文件（captureFile 消息回填）；
            # 无当次文件（未注入/纯翻旧账）时才回退到最新文件
            target = getattr(self, "_capture_current_file", None)
            if target and target in names:
                self.capture_file_var.set(target)
            elif self.capture_file_var.get() not in names:
                self.capture_file_var.set(names[0])
            self._load_capture_file()
        else:
            self.capture_file_var.set("")
            self._capture_rows = []
            self._capture_loaded_path = None
            self._render_capture_tree()

    def _load_capture_file(self):
        name = self.capture_file_var.get()
        path = self._capture_dir() / name if name else None
        self._capture_rows = []
        self._capture_loaded_path = path
        if path and path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            self._capture_rows.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            except OSError:
                pass
        (self._capture_segments,
         self._capture_row_seg) = self._group_capture_segments(
            self._capture_rows)
        # req 行 api 为空（发出时自身 URL 尚未出现）：用同段 url 行的
        # 路径后缀回填显示名（仅改内存显示数据，不动 jsonl 文件）
        for seg in self._capture_segments:
            url_api = next((r.get("api") for r in seg
                            if r.get("kind") == "url" and r.get("api")), "")
            if url_api:
                for r in seg:
                    if r.get("kind") == "req" and not r.get("api"):
                        r["api"] = url_api
        self._render_capture_tree()

    @staticmethod
    def _group_capture_segments(rows: list[dict]):
        """分段：req 或 url 行开新段；例外——段内仅一条 req 时紧随的 url
        属于同一请求（请求加密先于 ProcessCommon），不切开。
        api 变化不作边界：展示名来自 URL 后缀、meta 带枚举名，混用会误切。
        返回 (segments, row_to_seg)。"""
        segs: list[list[dict]] = []
        row_to_seg: list[int] = []
        cur: list[dict] | None = None
        for r in rows:
            kind = r.get("kind")
            boundary = False
            if kind == "req":
                boundary = True
            elif kind == "url" and cur:
                boundary = not (len(cur) == 1
                                and cur[0].get("kind") == "req")
            if cur is None or boundary:
                cur = [r]
                segs.append(cur)
            else:
                cur.append(r)
            row_to_seg.append(len(segs) - 1)
        return segs, row_to_seg

    def _open_capture_dir(self):
        cap_dir = self._capture_dir()
        if cap_dir.is_dir():
            os.startfile(cap_dir)

    def _on_capture_raw_toggle(self):
        self._render_capture_tree()
        self._save_gui_config()

    # ---- 渲染 ----
    def _render_capture_tree(self):
        tree = self.capture_tree
        children = tree.get_children()
        if children:
            tree.delete(*children)
        raw = bool(self.capture_raw_var.get())
        # 显示行 -> 所属段（选中时渲染整段用）
        self._capture_display_segs: list[list[dict]] = []
        if raw:
            # 原始视图：逐事件一行（含 meta、重复 resp、AssetBundle 等非 API 请求），kind 着色
            tree.configure(
                displaycolumns=("seq", "time", "kind", "api", "preview"))
            for seg in self._capture_segments:
                for row in seg:
                    kind = row.get("kind", "")
                    tree.insert(
                        "", "end",
                        values=(
                            row.get("seq", ""),
                            row.get("time", ""),
                            kind,
                            row.get("api", ""),
                            "",
                            self._capture_preview(row),
                        ),
                        tags=(kind,) if kind else (),
                    )
                    self._capture_display_segs.append(seg)
            return
        # 合并视图（默认）：一行 = 一次请求，错误响应整行标红；
        # 过滤掉非 /api/ 段（AssetBundle / 资源下载等），勾「原始事件」才看得见
        tree.configure(
            displaycolumns=("seq", "time", "api", "latency", "preview"))
        for seg in self._capture_segments:
            # 非 /api/ 段（AssetBundle / 资源下载等）默认隐藏，
            # 勾「原始事件」才显示；用 url 字段判断完整路径
            seg_url = next((r.get("url", "") for r in seg if r.get("kind") == "url"), "")
            if seg_url and "/api/" not in seg_url:
                continue
            values, err = self._merged_row(seg)
            tree.insert("", "end", values=values,
                        tags=("err",) if err else ())
            self._capture_display_segs.append(seg)

    def _merged_row(self, seg: list[dict]):
        """段 -> 合并行 (values, err)。时间=请求发出时刻；耗时=发出到
        resp 的间隔（url 行 time 就是真实发出时刻；旧 jsonl 文件 sentAt
        作为兜底；都没有时回退段首事件时刻）。预览=请求参数摘要
        → 响应大小。"""
        first = seg[0]
        req = next((r for r in seg if r.get("kind") == "req"), None)
        resp = next((r for r in seg if r.get("kind") == "resp"), None)
        url_row = next((r for r in seg if r.get("kind") == "url"), None)
        api = next((r.get("api") for r in seg if r.get("api")), "")
        latency = ""
        if resp is not None:
            # 优先级：sentAt（旧文件真实时刻）> url.time（新文件真实时刻）
            # 旧文件 url.time 是 ProcessCommon 错位时刻（假发出时刻），
            # 新文件 url.time 就是 SendWebRequest 真实发出时刻，没有 sentAt
            t0 = (url_row or {}).get("sentAt") \
                or (url_row or {}).get("time") \
                or first.get("time")
            d = _time_diff_ms(t0, resp.get("time"))
            latency = f"{d}ms" if d is not None else ""
        if req is not None and req.get("plain"):
            preview = _short(req["plain"], 60)
        else:
            preview = "(无参)"
        err = False
        if resp is not None:
            plain = resp.get("plain") or ""
            preview += f"  →  {len(plain) // 1024}KB"
            m = re.search(r'"code"\s*:\s*(\d+)', plain)
            if m and m.group(1) != "1000":
                err = True
        values = (first.get("seq", ""), first.get("time", ""), "",
                  api, latency, preview)
        return values, err

    @staticmethod
    def _filter_segment_display(seg: list[dict]) -> list[dict]:
        """非原始模式：隐藏 meta；同段内 (api, plain) 相同的 resp 只保留第一条
        （游戏对同一份响应密文会解密两次，内容逐字节相同）"""
        out: list[dict] = []
        seen_resp: set = set()
        for r in seg:
            kind = r.get("kind")
            if kind == "meta":
                continue
            if kind == "resp":
                key = (r.get("api"), r.get("plain"))
                if key in seen_resp:
                    continue
                seen_resp.add(key)
            out.append(r)
        return out

    @staticmethod
    def _capture_preview(row: dict) -> str:
        if row.get("kind") == "url":
            method = row.get("method")
            text = (f"{method} " if method else "") + row.get("url", "")
        elif row.get("kind") == "meta":
            text = ""
        else:
            text = (row.get("plain") or "").replace("\n", " ")
        if len(text) > _PREVIEW_LEN:
            text = text[:_PREVIEW_LEN] + "…"
        return text

    def _on_capture_select(self, _event):
        sel = self.capture_tree.selection()
        if not sel:
            return
        try:
            idx = self.capture_tree.index(sel[0])
        except tk.TclError:
            return
        if idx >= len(self._capture_display_segs):
            return
        seg = self._capture_display_segs[idx]
        # 详情区与列表同口径：非原始模式隐藏 meta、去重 resp
        rows = seg if bool(self.capture_raw_var.get()) \
            else self._filter_segment_display(seg)
        self.capture_detail.configure(state="normal")
        self.capture_detail.delete("1.0", "end")
        self._insert_capture_segment(rows)
        self.capture_detail.configure(state="disabled")

    def _insert_json_highlighted(self, text):
        """JSON 文本带语法高亮插入详情区；非 JSON 按原样插入。
        大 JSON 性能关键：逐 token insert 会产生数万次 tk 调用（秒级卡死），
        改为攒「文本/tag 交替」段批量插入；美化后超过 200KB 截断保护
        （1MB 原文美化后约 2.5MB/20 万 token，Text 插入秒级卡顿，
        完整内容始终在 jsonl 文件里）。"""
        try:
            pretty = json.dumps(json.loads(text), ensure_ascii=False,
                                indent=2)
        except (json.JSONDecodeError, TypeError):
            self.capture_detail.insert("end", str(text or "(空)") + "\n")
            return
        truncated = len(pretty) > 200_000
        if truncated:
            pretty = pretty[:200_000]
        buf: list = []
        pos = 0
        for m in _JSON_TOKEN_RE.finditer(pretty):
            if m.start() > pos:
                buf += [pretty[pos:m.start()], ""]
            if m.group(1) is not None:
                tag = "json_key"
            elif m.group(2) is not None:
                tag = "json_str"
            elif m.group(3) is not None:
                tag = "json_num"
            else:
                tag = "json_bool"  # true/false/null 同色
            buf += [m.group(0), tag]
            pos = m.end()
            if len(buf) >= 2000:
                self.capture_detail.insert("end", *buf)
                buf.clear()
        buf += [pretty[pos:] + "\n", ""]
        if truncated:
            buf += ["（内容过大已截断，完整见 jsonl 文件）\n", ""]
        self.capture_detail.insert("end", *buf)

    @staticmethod
    def _time_to_ms(t: str) -> int | None:
        """HH:MM:SS.mmm -> 毫秒数（用于段内偏移计算；解析失败返回 None）"""
        try:
            hms, ms = t.split(".")
            h, m, s = hms.split(":")
            return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)
        except (ValueError, AttributeError):
            return None

    def _insert_capture_segment(self, seg: list[dict]):
        """一次请求交互的完整链路：头部信息 + URL/请求/响应（JSON 高亮）。
        点段内任意行（含 req）都能看到服务器返回内容。
        头部时间取段首；各事件行自带时间戳 + 段内偏移 (+Nms)——
        实测时序：req(加密)先发生，url/meta/resp 在响应到达的同一帧执行，
        偏移值让「req -> resp = 网络耗时」一眼可读。"""
        seg_api = next(
            (r.get("api") for r in seg if r.get("api")), "(api待定)")
        head = seg[0]
        url_row = next((r for r in seg if r.get("kind") == "url"), None)
        resp_row = next((r for r in seg if r.get("kind") == "resp"), None)
        # 真实网络耗时：旧文件优先 sentAt（真发出时刻），新文件走 url.time
        start_t = (url_row or {}).get("sentAt") \
            or (url_row or {}).get("time") \
            or head.get("time", "")
        end_t = (resp_row or head).get("time", "")
        span = f"{start_t} → {end_t}" if end_t and end_t != start_t else start_t
        net_latency = ""
        if url_row is not None and resp_row is not None:
            t0 = url_row.get("sentAt") or url_row.get("time")
            d = _time_diff_ms(t0, resp_row.get("time"))
            if d is not None:
                net_latency = f"    网络耗时 {d}ms"
        self.capture_detail.insert(
            "end",
            f"── #{head.get('seq', '')} {seg_api}  {span}{net_latency}\n",
            "seg_head")
        base_ms = self._time_to_ms(start_t)
        for r in seg:
            kind = r.get("kind")
            ts = r.get("time", "")
            if ts:
                off = self._time_to_ms(ts)
                delta = (off - base_ms) if (off is not None
                                            and base_ms is not None) else 0
                ts = f"{ts} (+{delta}ms) " if delta > 0 else f"{ts} "
            if kind == "url":
                self.capture_detail.insert("end", f"\n[URL ] {ts}", "url")
                method = r.get("method")
                prefix = f"{method} " if method else ""
                self.capture_detail.insert(
                    "end", f"{prefix}{r.get('url', '')}\n")
            elif kind == "req":
                self.capture_detail.insert("end", f"\n[REQ ] {ts}\n", "req")
                self._insert_json_highlighted(r.get("plain"))
            elif kind == "resp":
                self.capture_detail.insert("end", f"\n[RESP] {ts}\n", "resp")
                self._insert_json_highlighted(r.get("plain"))
            elif kind == "meta" and len(seg) == 1:
                # 独立 meta 段（旧格式文件）才单独展示
                self.capture_detail.insert("end", f"\n[META] {ts}", "meta")
                self.capture_detail.insert(
                    "end", f"接口: {r.get('api', '')}\n")

    def _show_capture_legend(self):
        """详情区初始图例：事件类型说明"""
        text = (
            "事件类型说明：\n"
            "  [REQ ] 请求明文 —— 客户端发给服务器、即将加密的 JSON\n"
            "  [RESP] 响应明文 —— 服务器返回、解密后的 JSON\n"
            "  [URL ] 最终请求 URL\n"
            "  [META] 接口调用记录（仅接口名，标志该请求用的接口）\n"
            "点击列表任意行，右侧显示该次请求的完整链路"
            "（请求 / URL / 响应）。"
        )
        self.capture_detail.configure(state="normal")
        self.capture_detail.delete("1.0", "end")
        self.capture_detail.insert("1.0", text)
        self.capture_detail.configure(state="disabled")
