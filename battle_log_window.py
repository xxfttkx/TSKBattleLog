"""战斗日志窗口（含历史回看）——App 的 mixin。

纯搬移自 control.py：运行时 self 仍是 App 实例，经 self 访问 bridge /
_append_log / _save_gui_config 以及宿主注入的常量（self._GUI_CONFIG /
self._BATTLE_LOG_DIR / self._ATTR_COLORS）。本模块不 import control，
避免以 __main__ 方式启动 control.py 时的循环导入。
"""

import json
import os
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

# ---- 仅战斗日志窗口使用的格式化小工具（随区块一并从 control 搬入）----


def _f2(v) -> str:
    """战斗日志系数：数字保留两位，缺失（None）显示 -"""
    return f"{v:.2f}" if isinstance(v, (int, float)) else "-"


def _pct(v) -> str:
    """暴击率等内部刻度值转百分比：4920 -> 49.2%，缺失显示 -"""
    return f"{v / 100:.1f}%" if isinstance(v, (int, float)) else "-"


DEFAULT_ATTR_COLOR = "#555555"  # 未知/0 属性兜底灰


class BattleLogWindowMixin:
    # 宿主（App）必须提供：self._ATTR_COLORS: dict[int, str]

    def _bl_attr_color(self, attr) -> str:
        """属性值 -> 颜色 hex，未知/0/None 返回默认灰"""
        try:
            a = int(attr)
        except (TypeError, ValueError):
            return DEFAULT_ATTR_COLOR
        return self._ATTR_COLORS.get(a, DEFAULT_ATTR_COLOR)

    def _bl_attr_tag(self, attr) -> str:
        """属性值 -> Treeview tag 名，始终返回已注册的 tag（0 也兜底灰色）"""
        try:
            a = int(attr)
        except (TypeError, ValueError):
            a = 0
        return f"attr{a}" if a in self._ATTR_COLORS else "attr0"

    # ---- 战斗日志窗口 ----

    def _on_click_battle_log(self):
        self._open_battle_log_dialog()
        if self.bridge.script is None:
            # 未注入也能开窗口看历史；实时刷新不可用
            self._blog_dialog["info"].configure(
                text="未注入 — 仅可查看历史", foreground="#888888")
        else:
            self._refresh_battle_log()

    def _refresh_battle_log(self):
        if self._blog_dialog is None:
            return
        if self.bridge.script is None:
            self._blog_dialog["info"].configure(
                text="未注入 — 仅可查看历史", foreground="#888888")
            return
        self._blog_dialog["info"].configure(foreground="#1a5fb4",
                                            text="读取中...")
        self.bridge.post({"type": "battleLogRequest"})

    def _read_battle_log_geometry(self) -> str | None:
        """战斗日志窗口上次的几何（WxH+X+Y），缺失/损坏返回 None"""
        try:
            cfg = json.loads(self._GUI_CONFIG.read_text(encoding="utf-8"))
            geom = cfg.get("battleLogGeometry")
            return geom if isinstance(geom, str) and geom else None
        except Exception:
            return None

    def _on_battle_log_close(self):
        """关闭战斗日志窗口：先存几何再销毁，保证下次恢复位置大小"""
        dlg = self._blog_dialog
        if dlg is not None:
            try:
                self._blog_last_geom = dlg["top"].geometry()
                dlg["top"].destroy()
            except Exception:
                pass
        self._blog_dialog = None
        self._save_gui_config()

    def _set_blog_detail_info(self, *parts: tuple[str, str | None]):
        """段详情说明行富文本写入：parts 为 (文本, tag) 二元组，tag=None 用默认色"""
        if self._blog_dialog is None:
            return
        t: tk.Text = self._blog_dialog["detail_info"]
        t.configure(state="normal")
        t.delete("1.0", "end")
        for txt, tag in parts:
            t.insert("end", txt, (tag,) if tag else ())
        t.configure(state="disabled")

    def _open_battle_log_dialog(self):
        if self._blog_dialog is not None:
            top_old = self._blog_dialog["top"]
            try:
                if top_old.winfo_exists():
                    # 最小化的窗口光 lift 不会还原，先 deiconify
                    top_old.deiconify()
                    top_old.lift()
                    return
            except Exception:
                pass
            self._blog_dialog = None  # 引用已死，走重建
        top = tk.Toplevel(self)
        top.title("战斗日志")
        geom = self._read_battle_log_geometry()
        top.geometry(geom or "1080x620")
        top.minsize(920, 480)
        top.attributes("-topmost", self._always_top)
        top.protocol("WM_DELETE_WINDOW", self._on_battle_log_close)

        header = ttk.Frame(top)
        header.pack(fill="x", padx=8, pady=(6, 2))
        info = ttk.Label(header, text="读取中...", foreground="#1a5fb4",
                         font=("", 10, "bold"))
        info.pack(side="left")
        ttk.Button(header, text="刷新",
                   command=self._refresh_battle_log).pack(side="right")

        # 历史列表并入本窗口的第二个标签页，避免多窗口互相遮挡
        notebook = ttk.Notebook(top)
        notebook.pack(fill="both", expand=True, padx=4, pady=(2, 4))
        log_tab = ttk.Frame(notebook)
        notebook.add(log_tab, text="战斗日志")

        ttk.Label(log_tab, text="时间线（回合分隔 / 技能分组 / Unison），点击行查看段详情",
                  foreground="#666").pack(anchor="w", padx=8)

        cols = ("turn", "attacker", "action", "hits", "damage", "crits", "sv")
        tree_frame = ttk.Frame(log_tab)
        tree_frame.pack(fill="both", expand=False, padx=8, pady=(2, 6))
        tree = ttk.Treeview(tree_frame, columns=cols, show="headings", height=12)
        for c, t_, w, anchor in (
            ("turn", "回合", 50, "center"),
            ("attacker", "攻击者", 180, "w"),
            ("action", "动作", 300, "w"),
            ("hits", "段数", 45, "center"),
            ("damage", "伤害", 100, "e"),
            ("crits", "暴击", 45, "center"),
            ("sv", "倍率", 55, "center"),
        ):
            tree.heading(c, text=t_)
            tree.column(c, width=w, anchor=anchor)
        tree.tag_configure("turn", foreground="#888888")
        tree.tag_configure("unison", foreground="#000000")
        tree.tag_configure("attr0", foreground=DEFAULT_ATTR_COLOR)
        for _a, _c in self._ATTR_COLORS.items():
            tree.tag_configure(f"attr{_a}", foreground=_c)
        tree.pack(side="left", fill="both", expand=True)
        tree_sb = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree_sb.pack(side="right", fill="y")
        tree.configure(yscrollcommand=tree_sb.set)

        # 单行富文本（ttk.Label 不支持行内多色），attacker/defender 分色
        detail_info = tk.Text(log_tab, height=1, wrap="none", borderwidth=0,
                              highlightthickness=0, takefocus=0, cursor="arrow",
                              background=top.cget("background"),
                              font=("", 9, "bold"))
        detail_info.tag_configure("base", foreground="#444444")
        detail_info.tag_configure("attacker", foreground="#1a6fd4")
        detail_info.tag_configure("defender", foreground="#e5534b")
        detail_info.pack(fill="x", padx=8)
        detail_info.configure(state="disabled")

        dcols = ("seg", "damage", "crit", "dtype", "sv", "fluc", "rush",
                 "attr", "critco", "down", "rate", "passive")
        detail_frame = ttk.Frame(log_tab)
        detail_frame.pack(fill="both", expand=True, padx=8, pady=(2, 8))
        detail = ttk.Treeview(detail_frame, columns=dcols, show="headings", height=8)
        self._configure_detail_columns(detail, "coeffs")
        detail.pack(side="left", fill="both", expand=True)
        detail_sb = ttk.Scrollbar(detail_frame, orient="vertical",
                                  command=detail.yview)
        detail_sb.pack(side="right", fill="y")
        detail.configure(yscrollcommand=detail_sb.set)

        dlg = {"top": top, "info": info, "tree": tree,
               "detail": detail, "detail_info": detail_info,
               "rows": {}, "notebook": notebook}
        self._blog_dialog = dlg
        dlg["history_tree"] = self._build_history_tab(notebook)
        notebook.bind("<<NotebookTabChanged>>", self._on_blog_tab_changed)
        self._populate_history(dlg["history_tree"])
        tree.bind("<<TreeviewSelect>>",
                  lambda _e: self._on_battle_log_select())

    def _on_blog_tab_changed(self, _event=None):
        """切到「历史」页时重新扫描目录，外部文件变动（新增/手动删除）能即时反映"""
        dlg = self._blog_dialog
        if dlg is None:
            return
        try:
            if dlg["notebook"].index("current") == 1:
                self._populate_history(dlg["history_tree"])
        except Exception:
            pass

    def _configure_detail_columns(self, detail: ttk.Treeview, mode: str):
        """切换段详情表格的列布局：coeffs=系数明细，unison=Unison 发起者/伤害两列"""
        if mode == "unison":
            cols = ("name", "damage")
            detail.configure(columns=cols)
            for c, t_, w, anchor in (
                ("name", "Unison 发起者", 260, "w"),
                ("damage", "伤害", 120, "e"),
            ):
                detail.heading(c, text=t_)
                detail.column(c, width=w, anchor=anchor)
        else:
            cols = ("seg", "damage", "crit", "dtype", "sv", "fluc", "rush",
                    "attr", "critco", "down", "rate", "passive")
            detail.configure(columns=cols)
            for c, t_, w, anchor in (
                ("seg", "段#", 40, "center"),
                ("damage", "伤害", 90, "e"),
                ("crit", "暴击", 55, "center"),
                ("dtype", "落地类型", 70, "center"),
                ("sv", "技能倍率", 70, "center"),
                ("fluc", "乱数", 55, "center"),
                ("rush", "Rush", 55, "center"),
                ("attr", "属性克制", 130, "w"),
                ("critco", "暴伤倍率", 105, "center"),
                ("down", "Stun伤害倍率", 105, "center"),
                ("rate", "易伤(before→after ×倍率)", 200, "w"),
                ("passive", "被动", 60, "center"),
            ):
                detail.heading(c, text=t_)
                detail.column(c, width=w, anchor=anchor)
        # 统一注册属性色 tag（coeffs/unison 两种布局共用）
        detail.tag_configure("attr0", foreground=DEFAULT_ATTR_COLOR)
        for _a, _c in self._ATTR_COLORS.items():
            detail.tag_configure(f"attr{_a}", foreground=_c)

    def _apply_battle_log_data(self, payload: dict):
        dlg = self._blog_dialog
        if dlg is None:
            return
        if payload.get("error"):
            dlg["info"].configure(text=f"读取失败: {payload['error']}",
                                  foreground="#c0392b")
            return
        dlg["info"].configure(foreground="#1a5fb4")
        self._render_battle_log(dlg, payload)

    def _save_ended_battle_log(self, snap: dict):
        """战斗结束：agent 推全量快照，落盘 logs/battles/时间戳.json 供历史回看"""
        try:
            self._BATTLE_LOG_DIR.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d_%H%M%S")
            path = self._BATTLE_LOG_DIR / f"{stamp}.json"
            i = 1
            while path.exists():  # 同秒多场（理论罕见），追加序号
                path = self._BATTLE_LOG_DIR / f"{stamp}_{i}.json"
                i += 1
            path.write_text(json.dumps(snap, ensure_ascii=False, indent=2),
                            encoding="utf-8")
            meta = snap.get("meta") or {}
            players = "、".join(
                p.get("characterName", "?")
                for p in meta.get("players", []))
            self._append_log(
                time.strftime("%H:%M:%S.") +
                f"{int(time.time()*1000)%1000:03d}",
                f"[battle-log] 战斗快照已保存 {path.name}"
                f"（{meta.get('mode', '?')} / {players}）")
        except Exception as e:
            self._append_log(
                time.strftime("%H:%M:%S.") +
                f"{int(time.time()*1000)%1000:03d}",
                f"[battle-log] 快照保存失败: {e}")

    # ---- 战斗日志历史回看 ----

    @staticmethod
    def _history_time_label(name: str) -> str:
        """文件名 20261005_153012[_1].json → 2026-10-05 15:30:12"""
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S",
                                 time.strptime(name[:15], "%Y%m%d_%H%M%S"))
        except Exception:
            return name

    def _build_history_tab(self, notebook: ttk.Notebook) -> ttk.Treeview:
        """在 Notebook 中构建「历史」标签页，返回 Treeview 供外部刷新"""
        hist_tab = ttk.Frame(notebook)
        notebook.add(hist_tab, text="历史")

        bar = ttk.Frame(hist_tab)
        bar.pack(fill="x", padx=8, pady=(6, 2))
        ttk.Label(bar, text="logs/battles/ 下的战斗结束快照",
                  foreground="#666").pack(side="left")
        ttk.Button(bar, text="打开文件夹",
                   command=lambda: os.startfile(self._BATTLE_LOG_DIR)).pack(
            side="right", padx=(4, 0))
        ttk.Button(bar, text="清理未锁定",
                   command=self._clean_unlocked_history).pack(
            side="right", padx=(4, 0))
        ttk.Button(bar, text="删除",
                   command=self._delete_selected_history).pack(
            side="right", padx=(4, 0))
        ttk.Button(bar, text="锁定/解锁",
                   command=self._toggle_lock_selected_history).pack(
            side="right", padx=(4, 0))
        ttk.Button(bar, text="打开",
                   command=self._replay_selected_history).pack(side="right")

        cols = ("lock", "time", "mode", "turns", "damage", "players")
        frame = ttk.Frame(hist_tab)
        frame.pack(fill="both", expand=True, padx=8, pady=(2, 8))
        tree = ttk.Treeview(frame, columns=cols, show="headings")
        for c, t_, w, anchor in (
            ("lock", "锁", 36, "center"),
            ("time", "时间", 140, "center"),
            ("mode", "模式", 130, "center"),
            ("turns", "回合", 50, "center"),
            ("damage", "总伤害", 110, "e"),
            ("players", "出战角色", 400, "w"),
        ):
            tree.heading(c, text=t_)
            tree.column(c, width=w, anchor=anchor)
        tree.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        sb.pack(side="right", fill="y")
        tree.configure(yscrollcommand=sb.set)
        tree.bind("<Double-1>", lambda _e: self._replay_selected_history())
        return tree

    def _populate_history(self, tree: ttk.Treeview):
        for row in tree.get_children():
            tree.delete(row)
        if not self._BATTLE_LOG_DIR.exists():
            return
        files = sorted(self._BATTLE_LOG_DIR.glob("*.json"), reverse=True)
        for path in files:
            try:
                snap = json.loads(path.read_text(encoding="utf-8"))
                meta = snap.get("meta") or {}
                players = "、".join(
                    p.get("characterName", "?")
                    for p in meta.get("players", []))
                tree.insert("", "end", iid=str(path), values=(
                    "🔒" if snap.get("locked") else "",
                    self._history_time_label(path.name),
                    meta.get("mode", "?"),
                    snap.get("turnCount", 0),
                    snap.get("damageTotal", "0"),
                    players,
                ))
            except Exception:
                tree.insert("", "end", iid=str(path),
                            values=("", self._history_time_label(path.name),
                                    "（文件损坏）", "", "", ""))

    def _replay_selected_history(self):
        dlg = self._blog_dialog
        if dlg is None:
            return
        tree: ttk.Treeview = dlg["history_tree"]
        sel = tree.selection()
        if not sel:
            return
        self._replay_battle_log(Path(sel[0]))
        dlg["notebook"].select(0)  # 切回「战斗日志」页展示回放

    def _is_history_locked(self, path: Path) -> bool:
        """快照是否被锁定（缺失 locked 字段视为未锁定；读取失败视为锁定，防误删）"""
        try:
            snap = json.loads(path.read_text(encoding="utf-8"))
            return bool(snap.get("locked"))
        except Exception:
            return True

    def _delete_selected_history(self):
        dlg = self._blog_dialog
        if dlg is None:
            return
        tree: ttk.Treeview = dlg["history_tree"]
        sel = tree.selection()
        if not sel:
            return
        locked = [iid for iid in sel if self._is_history_locked(Path(iid))]
        unlocked = [iid for iid in sel if iid not in locked]
        if not unlocked:
            messagebox.showinfo("提示", "选中的快照均已锁定，未删除任何文件。",
                                parent=dlg["top"])
            return
        hint = f"删除选中的 {len(unlocked)} 条战斗快照？"
        if locked:
            hint += f"\n（其中 {len(locked)} 条已锁定，将跳过）"
        if not messagebox.askyesno("确认", hint,
                                   parent=dlg["top"]):
            return
        for iid in unlocked:
            try:
                Path(iid).unlink()
            except Exception:
                pass
        self._populate_history(tree)

    def _toggle_lock_selected_history(self):
        """切换选中快照的 locked 标记（重写 JSON 文件，随文件走）"""
        dlg = self._blog_dialog
        if dlg is None:
            return
        tree: ttk.Treeview = dlg["history_tree"]
        if not tree.selection():
            return
        for iid in tree.selection():
            path = Path(iid)
            try:
                snap = json.loads(path.read_text(encoding="utf-8"))
                snap["locked"] = not snap.get("locked")
                path.write_text(json.dumps(snap, ensure_ascii=False),
                                encoding="utf-8")
            except Exception:
                pass
        self._populate_history(tree)

    def _clean_unlocked_history(self):
        """一键清理：删除全部未锁定快照，锁定的保留"""
        dlg = self._blog_dialog
        if dlg is None or not self._BATTLE_LOG_DIR.exists():
            return
        top = dlg["top"]
        files = list(self._BATTLE_LOG_DIR.glob("*.json"))
        unlocked = [p for p in files if not self._is_history_locked(p)]
        if not unlocked:
            messagebox.showinfo("提示", "没有未锁定的快照可清理。",
                                parent=top)
            return
        n_locked = len(files) - len(unlocked)
        hint = f"删除全部 {len(unlocked)} 条未锁定快照？"
        if n_locked:
            hint += f"\n（{n_locked} 条已锁定，保留）"
        if not messagebox.askyesno("确认", hint, parent=top):
            return
        deleted = 0
        for p in unlocked:
            try:
                p.unlink()
                deleted += 1
            except Exception:
                pass
        if deleted < len(unlocked):
            messagebox.showwarning(
                "提示", f"已删除 {deleted} 条，"
                        f"{len(unlocked) - deleted} 条删除失败。", parent=top)
        self._populate_history(dlg["history_tree"])

    def _replay_battle_log(self, path: Path):
        """读历史快照灌进战斗日志窗口（复用实时渲染管线）"""
        try:
            snap = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            messagebox.showerror("错误", f"读取失败: {e}")
            return
        if self._blog_dialog is None:
            self._open_battle_log_dialog()
        dlg = self._blog_dialog
        if dlg is None:
            return
        dlg["info"].configure(foreground="#1a5fb4")
        self._render_battle_log(dlg, snap)
        dlg["info"].configure(
            text=f"【历史 {self._history_time_label(path.name)}】"
                 + str(dlg["info"].cget("text")))

    def _render_battle_log(self, dlg: dict, snap: dict):
        tree: ttk.Treeview = dlg["tree"]
        for row in tree.get_children():
            tree.delete(row)
        dlg["rows"].clear()
        detail = dlg["detail"]
        for row in detail.get_children():
            detail.delete(row)
        self._set_blog_detail_info()

        items: list[tuple[int, str, dict]] = []
        for g in snap.get("groups", []):
            items.append((int(g.get("seq", 0)), "group", g))
        for u in snap.get("unison", []):
            items.append((int(u.get("seq", 0)), "unison", u))
        items.sort(key=lambda x: x[0])

        # 合并同回合内连续的 Unison 段为一次 Unison（addDamageNote 里每次
        # Unison 前都 flushGroups，故连续 seq 的 unison 必属同一次）
        merged: list[tuple[int, str, dict]] = []
        for seq, kind, obj in items:
            if kind == "unison" and merged and merged[-1][1] == "unison_comb" \
                    and merged[-1][2].get("turn") == obj.get("turn"):
                merged[-1][2]["segs"].append(obj)
            elif kind == "unison":
                merged.append((seq, "unison_comb",
                               {"turn": obj.get("turn"), "segs": [obj]}))
            else:
                merged.append((seq, kind, obj))

        turns = snap.get("turns", [])
        cur_turn = 0
        unison_count = 0
        for _seq, kind, obj in merged:
            turn = int(obj.get("turn", 0))
            while turn > cur_turn and cur_turn < len(turns):
                rec = turns[cur_turn]
                iid = tree.insert(
                    "", "end",
                    values=(
                        "",
                        f"── turn {rec.get('from')} -> {rec.get('to')}"
                        f"    累计伤害 {rec.get('total')}",
                        "", "", "", "", "",
                    ),
                    tags=("turn",),
                )
                dlg["rows"][iid] = ("turn", rec)
                cur_turn += 1
            if turn > cur_turn:
                cur_turn = turn
            if kind == "group":
                iid = tree.insert(
                    "", "end",
                    values=(
                        turn,
                        obj.get("attackerName", ""),
                        f"{obj.get('kind', '')} -> {obj.get('defenderName', '')}",
                        obj.get("hits", 0),
                        obj.get("totalDamage", ""),
                        obj.get("crits", 0),
                        f"{float(obj.get('skillValue', 0)):.2f}",
                    ),
                    tags=(self._bl_attr_tag(obj.get("attackerAttr")),),
                )
            else:  # unison_comb
                unison_count += 1
                segs = obj.get("segs", [])
                names = " / ".join(s.get("name", "?") for s in segs)
                total = sum(int(s.get("damage", 0)) for s in segs)
                iid = tree.insert(
                    "", "end",
                    values=(
                        turn, "Unison",
                        f"{names} · {len(segs)}段",
                        len(segs), total, "", "",
                    ),
                    tags=("unison",),
                )
            dlg["rows"][iid] = (kind, obj)

        # 尾部残留补插：最后一条回合记录之后若没有新行（如战斗恰在回合切换后
        # 结束），上面的 while 没机会被驱动，最后几条分隔行会丢失
        while cur_turn < len(turns):
            rec = turns[cur_turn]
            iid = tree.insert(
                "", "end",
                values=(
                    "",
                    f"── turn {rec.get('from')} -> {rec.get('to')}"
                    f"    累计伤害 {rec.get('total')}",
                    "", "", "", "", "",
                ),
                tags=("turn",),
            )
            dlg["rows"][iid] = ("turn", rec)
            cur_turn += 1

        total = snap.get("damageTotal", "0")
        unison_total = snap.get("unisonDamageTotal", "0")
        dlg["info"].configure(
            text=f"回合 {snap.get('turnCount', 0)}    总伤害 {total}"
                 f"    Unison伤害 {unison_total}    "
                 f"（技能分组 {len(snap.get('groups', []))} / "
                 f"Unison次数 {unison_count} / "
                 f"当前回合数 {len(turns)}）",
        )

    def _on_battle_log_select(self):
        dlg = self._blog_dialog
        if dlg is None:
            return
        sel = dlg["tree"].selection()
        detail: ttk.Treeview = dlg["detail"]
        for row in detail.get_children():
            detail.delete(row)
        if not sel:
            return
        entry = dlg["rows"].get(sel[0])
        if entry is None:
            return
        kind, obj = entry

        # 默认恢复系数明细列（Unison 行会自行切到两列模式）
        if kind != "unison_comb":
            self._configure_detail_columns(detail, "coeffs")

        if kind == "turn":
            percents = "  ".join(
                f"{p.get('name', '')}({p.get('percent', '')})"
                for p in obj.get("percents", [])
            )
            self._set_blog_detail_info(
                (f"回合 {obj.get('from')} -> {obj.get('to')}    "
                 f"累计伤害 {obj.get('total')}    {percents}", None))
            return

        if kind == "unison_comb":
            segs = obj.get("segs", [])
            names = " / ".join(s.get("name", "?") for s in segs)
            total = sum(int(s.get("damage", 0)) for s in segs)
            self._configure_detail_columns(detail, "unison")
            self._set_blog_detail_info(
                (f"Unison：{names}    共 {len(segs)} 段    "
                 f"合计伤害 {total}（不经 CaluculationNormalDamage，无系数明细）",
                 None))
            for s in segs:
                detail.insert(
                    "", "end",
                    values=(s.get("name", "?"), s.get("damage", "")),
                    tags=(self._bl_attr_tag(s.get("attr")),),
                )
            return

        # group：逐段展开全部入参与系数
        segs = obj.get("segments", [])
        first = segs[0] if segs else {}
        # 按攻防双方属性动态着色（attacker/defender tag 颜色实时重配）
        dlg["detail_info"].tag_configure(
            "attacker", foreground=self._bl_attr_color(obj.get("attackerAttr")))
        dlg["detail_info"].tag_configure(
            "defender", foreground=self._bl_attr_color(obj.get("defenderAttr")))
        self._set_blog_detail_info(
            (obj.get('attackerName', ''), "attacker"),
            (f" {obj.get('kind', '')} -> ", None),
            (obj.get('defenderName', ''), "defender"),
            (f"    基础ATK={first.get('baseAttack', '-')}  "
             f"当前ATK={first.get('attack', '-')}  "
             f"暴击={_pct(first.get('crit'))}  "
             f"criticalUp={first.get('criticalUp', '-')}  "
             f"目标数={first.get('targetCount', '-')}  "
             f"队伍={first.get('teamType', '-')}", None),
        )
        for s in segs:
            co = s.get("coeffs") or {}
            attr = co.get("attribute")
            critco = co.get("critical")
            rate = co.get("damageRate")
            attr_txt = (
                f"{attr['value']:.2f} ({attr['compatibility']})"
                if attr else "-"
            )
            critco_txt = (
                f"{critco['value']:.2f}"
                if critco else "-"
            )
            if rate:
                r = rate.get("rate")
                r_txt = (
                    f"{rate.get('before')}→{rate.get('after')} ×{r:.2f}"
                    if isinstance(r, (int, float)) and r == r else "-"
                )  # NaN 自检 r == r
            else:
                r_txt = "-"
            passive = co.get("passive")
            detail.insert(
                "", "end",
                values=(
                    int(s.get("multipleCount", 0)) + 1,
                    s.get("damage", ""),
                    s.get("isCritical", "-"),
                    s.get("damageType", "-"),
                    _f2(s.get("skillValue")),
                    _f2(co.get("fluctuation")),
                    _f2(co.get("rush")),
                    attr_txt,
                    critco_txt,
                    _f2(co.get("down")),
                    r_txt,
                    passive if passive is not None else "-",
                ),
            )
