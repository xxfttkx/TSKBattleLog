# TSKBattleLog

English | [简体中文](README.zh-CN.md)

A battle log analyzer for *Twinkle Star Knights* using Frida and IL2CPP.

TSKBattleLog captures and analyzes battle events from the game runtime — damage, skills, combat states — and provides a floating control panel to load/toggle mods and inspect unit buffs in real time. Auto-battle skill selection is configurable via `char_skill.json`.

## Features

- Real-time battle event logging with millisecond timestamps
- Per-unit damage tracking with post-battle ranking
- Multi-hit skill grouping (per attacker / turn / kind / segment) with crit count and skill multiplier
- Unison damage tracking
- Configurable auto-battle skill selection via `char_skill.json`
- Config-driven debug observation points and IL2CPP backtraces via `trace_config.json`
- Mod loader with runtime enable/disable and a floating control panel
- Unit avatar bar (player icons from the wiki) + compact enemy list; click any unit to view its live buffs, ATK/CRT/NoteCount and EX stats, with detail/summary toggle
- Auto-saved log files + in-panel log viewer (clear / copy / open logs folder)

## Mod categories

- **Observer**: read-only logging / data export, no runtime state change
- **Modifier**: alters in-game behaviour (e.g. QTE result, skill selection)
- **Debug**: verbose low-level trace for analysis (high log volume)

## Installation

```bash
npm install
```

## Usage

### Method A: Floating control panel (recommended)

A Tkinter always-on-top window powered by `frida-python`.

One-time dependency install:

```powershell
pip install frida frida-tools
```

Launch:

```powershell
.\control.ps1
```

The script runs `npm run build` first, then opens the panel. Tick the mods you want, then press **▶ 启动注入**. The game may be started before or after the panel — the bridge waits for the process.

Panel features:

- **窗口置顶** toggle (top-left)
- **MODs / Logs** tabs (never shown at the same time); switch to Logs automatically after injection starts
- Mod list grouped by Observer / Modifier / Debug. Selection is persisted to `mods.json`. Checkboxes are locked after injection starts (changing mods mid-battle is unsafe).
- **重载配置**: re-read `trace_config.json` and update trace/backtrace points at runtime
- **隐藏单位栏**: hide the player avatar bar and enemy list to focus on logs
- Log viewer with **清空 / 复制日志 / 打开日志目录**; logs are also auto-saved to `logs/` (8 KB buffer, flushed on close)
- 5000-line ring buffer; older lines are dropped automatically
- Player avatar bar (48 px wiki icons) and a compact enemy name strip above it. Clicking any unit opens a **Skill Effects** window showing live buffs (detail / summary toggle) plus ATK (base), CRT, NoteCount, EX rate and normal-attack EX gain.

### Method B: Headless injection (console only)

Start the game, then:

```powershell
.\run.ps1
```

This builds the agent, attaches to the running game process, and saves logs to `logs/`.

## Mods

Every feature is its own mod under `src/mods/`. `mods.json` holds the default enabled state and is updated automatically by the panel.

| Key                 | Category | Description                                                                                                  |
|---------------------|----------|--------------------------------------------------------------------------------------------------------------|
| `battle-log`        | Observer | Prints battle-related info (damage stats, multi-hit grouping, turns, post-battle summary)                    |
| `unit-list-dump`    | Observer | On filtering/sorting in the character screen, exports all unit attributes to `unit_list.json`                |
| `qte-perfect`       | Modifier | Forces the battle-start QTE result to PERFECT                                                                |
| `auto-skill`        | Modifier | In auto mode, picks EX1/EX2 automatically per `char_skill.json`                                              |
| `damage-calc-trace` | Debug    | Prints damage calculation parameters — very verbose                                                          |
| `trace-config`      | Debug    | Bulk-registers arg-dump trace points from `trace_config.json` (edit JSON, then press reload on the panel)    |
| `backtrace`         | Debug    | Prints an IL2CPP call stack on entry of methods listed in `trace_config.json`                                |
| `field-watch`       | Debug    | Watches fields of a given class, logging the writer method + call stack on change                            |

## Skill configuration (`char_skill.json`)

Controls the priority used by `auto-skill`.

```json
{
    "星を見るもの": 2,
    "バニーサンタ": 1,
    "夏色マジカル☆": 0
}
```

Values:

- `2`: Prefer EX2
- `1`: Prefer EX1
- `0`: Never auto-cast any EX skill

Fallback lookup order is `[UnitName] CharacterName` → `UnitName`, so a single entry covers all variants of a unit.

## Debug observation points (`trace_config.json`)

Shared by `trace-config` and `backtrace` — adding points requires **no source edit and no re-injection**:

```json
{
  "trace": [
    { "class": "TSKBattleNote", "method": "SetDamageValue" }
  ],
  "backtrace": [
    { "class": "TSKBattleAI", "method": "LotterySkillAction", "depth": 8 }
  ],
  "backtraceDepth": 5
}
```

- `trace`: attaches `dumpArgs` to each listed `class.method`.
- `backtrace`: prints an IL2CPP call stack (resolved through the method address index) on entry; per-entry `depth` overrides the global `backtraceDepth`.
- After editing, press **重载配置** to apply — new points attach and removed points detach at runtime.
- Keep arrays empty by default: tracing a method another mod already hooks doubles that method's log output.

## Disclaimer

For research, analysis and personal use only. Some features modify battle state and may affect game behaviour. Use at your own risk.

## Credits

Thanks to [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) for providing a valuable reference for Frida and IL2CPP runtime analysis.
