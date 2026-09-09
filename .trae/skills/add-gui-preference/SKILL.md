---
name: "add-gui-preference"
description: "给 FridaTest 控制面板 control.py 的「设置」页添加一项本机个人偏好设置（持久化到 gui_config.json）。当用户想把某个因人而异的显示/行为参数做成可配置（如字号、彩色、倍速、开关）时调用；不适用于可分享的内容配置（mods/char_skill/trace_config）。"
---

# 给控制面板添加一项 GUI 个人偏好设置

本工作区（`f:\Code\js\FridaTest`，Twinkle Star Knights 的 Frida IL2CPP mod）的宿主面板 `control.py` 用 tkinter 实现。用户提出「把 XX 做成可配置 / 加个设置项 / 记住我的选择」且该项是**因人而异的本机偏好**时，按本技能执行。

## 第一步：判断归属（重要，别放错地方）

- **进本技能（gui_config.json，个人偏好）**：窗口几何、日志字号、日志是否彩色、战斗倍速这类「本机用户舒适设置」，换个人/换机器就不一样，不需要分发给别人。
- **不进本技能（内容配置，可分享）**：`mods.json`（mod 开关）、`char_skill.json`（技能映射）、`trace_config.json`（trace 方法列表 / backtrace 深度）。这些是项目知识，会内联进 agent 并由宿主握手下发，不要塞进设置页。

判据：**「换一台电脑/换一个人，这个值还应该一样吗？」** 一样 → 内容配置；不一样 → 个人偏好（本技能）。

## 固定六步套路

所有个人偏好项都落在 `control.py` 的 `App` 类里，遵循同一套结构（参考已实现的 battleSpeed / logFontSize / logColor）：

1. **设置页加控件**：在 `_build_ui` 的「设置」tab（`settings_inner`，Notebook 第三页）里，用 `ttk.LabelFrame` 分组，放控件。控件绑定一个 `self.xxx_var`（`tk.StringVar` / `tk.BooleanVar` 等），初值用 `self._read_xxx()`。
   - 下拉框用 `ttk.Combobox(..., state="readonly")` + `bind("<<ComboboxSelected>>", ...)`；开关用 `ttk.Checkbutton(..., command=...)`。
2. **`_apply_xxx(...)` 应用方法**：把值真正作用到 UI/行为上（如 `log_text.configure(font=...)`、`tag_configure(...)`、`self.bridge.battle_speed = ...`）。要能**重复调用、即时生效**，不依赖只在启动时跑一次。
3. **`_on_xxx_...` 回调**：读 `xxx_var` → 调 `_apply_xxx` → 调 `self._save_gui_config()` 持久化。解析失败要 try/except 静默回退。
4. **`_read_xxx()` 读取方法**：从 `GUI_CONFIG`（gui_config.json）读，带**默认值回退**和合法性钳制，整体 try/except，文件缺失/损坏时返回默认。
5. **`_save_gui_config()` 里加字段**：在合并写 cfg 的地方加 `cfg["xxx"] = ...`（用 try/except 包住取值），与 geometry/battleSpeed/logFontSize/logColor 并列。注意它是**合并写**——先读旧 cfg 再更新，别整体覆盖。
6. **建完控件立即应用一次初值**：在 `_build_ui` 创建该控件之后调用 `self._apply_xxx(self._read_xxx())`，保证启动即按配置生效（控件 var 的初值只影响控件显示，不一定作用到目标）。

## 关键约束 / 易踩坑

- **Notebook 三页顺序固定**：MODs(0) / Logs(1) / 设置(2)。注入成功后 `self.notebook.select(1)` 切到 Logs。**不要在 Logs 之前插页**，否则索引错位。新设置项一律加进第三页 `settings_inner`。
- **gui_config.json 位置**：项目根目录；PyInstaller 打包后用 `ROOT_DIR`（exe 同级），常量 `GUI_CONFIG` 已处理好，直接用。
- **日志外观特殊机制**（改日志显示时参考）：
  - 彩色靠 `log_text` 的 Text **tag**：类常量 `LOG_TAG_COLORS`（`t` 时间戳灰 / `m` 消息浅灰 / `loader` 蓝 / `bridge` 黄 / `err` 红），`_append_log` 按消息前缀打 tag。「关彩色」= `_apply_log_colors(False)` 把所有 tag 的 foreground 统一成 `m` 色（tag 照打、不重绘，即时生效）。
  - 字号 = `_apply_log_font_size(n)` → `log_text.configure(font=("Consolas", n))`。
- **需要下发给 agent 的偏好**（如战斗倍速）：除上述六步外，还要在 `FridaBridge` 加字段 + `post_xxx()` 方法，握手 modList 后按序下发（顺序 initMods → charSkill → traceConfig → 其余），并在已注入时的回调里即时 post。纯本机 UI 偏好（字号/彩色）不需要这步。
- **IDE 缓冲区回写坑（本项目反复出现）**：用户 IDE 常打开旧版 control.py，保存时会把磁盘新代码覆盖回旧版。**每次编辑后必须原子验证**：`python -m py_compile control.py` + `Select-String` grep 关键符号确认终态；不要只信单次 Edit 成功。完成后提醒用户在 IDE 对 control.py 执行「Revert File / 还原文件」。
- PowerShell 5 不支持 `&&`，用 `;` 或 `if ($LASTEXITCODE -eq 0)`。

## 代码模板（以一个布尔开关为例）

```python
# 1) 设置页控件（_build_ui 的 settings_inner 内）
lf = ttk.LabelFrame(settings_inner, text="某某功能", padding=(10, 8))
lf.pack(fill="x", pady=4)
self.foo_var = tk.BooleanVar(value=self._read_foo())
ttk.Checkbutton(lf, text="启用某某", variable=self.foo_var,
                command=self._on_foo_toggle).pack(anchor="w")
self._apply_foo(self._read_foo())  # 6) 启动即应用

# 2) 应用
def _apply_foo(self, enabled: bool):
    ...  # 实际作用到 UI/行为，可重复调用

# 3) 回调
def _on_foo_toggle(self):
    self._apply_foo(bool(self.foo_var.get()))
    self._save_gui_config()

# 4) 读取（带默认回退）
def _read_foo(self) -> bool:
    try:
        cfg = json.loads(GUI_CONFIG.read_text(encoding="utf-8"))
        return bool(cfg.get("fooEnabled", True))
    except Exception:
        return True

# 5) _save_gui_config 内合并写
try:
    cfg["fooEnabled"] = bool(self.foo_var.get())
except Exception:
    pass
```

## 完成标准

- [ ] 六步齐全，控件在「设置」第三页
- [ ] `_read_xxx` 有默认值 + 钳制 + try/except
- [ ] `_save_gui_config` 合并写新字段
- [ ] 启动即应用初值；运行时改动即时生效
- [ ] `python -m py_compile control.py` 通过
- [ ] grep 确认符号终态（防 IDE 回写），并提醒用户 Revert File
- [ ] 更新项目记忆 project_memory.md 的 gui_config 偏好清单
