# TSKBattleLog

English | [简体中文](README.zh-CN.md)

A battle log analyzer for Twinkle Star Knights using Frida and IL2CPP.

TSKBattleLog captures and analyzes battle events from the game runtime, including damage events, skill usage, and combat states. It also provides configurable auto-battle skill selection through `char_skill.json`.

## Features

- Real-time battle event logging
- Damage tracking and post-battle damage summary
- Skill usage tracing
- Unison damage tracking
- Combat state analysis
- Configurable auto-battle skill selection via `char_skill.json`
- Config-driven debug observation points and IL2CPP backtraces via `trace_config.json`
- Runtime mod toggling with a floating control panel
- Millisecond-precision runtime log viewer

## Example Output

After a battle, TSKBattleLog generates a damage summary from captured battle events:

```text
[13:59:55.017] enter TSKBattleManager.InitializeResult
[13:59:55.018] [TSKBattleLog] onEndBattle: total damage=8865136
[13:59:55.018] [TSKBattleLog] [バニーサンタ] 蘭美 damage:113626(1%)
[13:59:55.018] [TSKBattleLog] [初日の出を迎えて] フィオナ damage:50699(1%)
[13:59:55.018] [TSKBattleLog] [炎宿せし宝石] ルルゥ damage:3903(0%)
[13:59:55.018] [TSKBattleLog] [霹靂の射手] 梨緒 damage:431585(5%)
[13:59:55.018] [TSKBattleLog] [星を見るもの] フィオナ《魔王》 damage:8104144(91%)
[13:59:55.019] [TSKBattleLog] unison damage=161179(2%)
[13:59:55.065] InitializeResult return: 0x1c853b5e000
```

## Technical Notes

TSKBattleLog uses Frida and `frida-il2cpp-bridge` to hook IL2CPP methods at runtime and reconstruct battle events.

The project observes game runtime behavior by tracing relevant methods and converting internal battle data into readable logs.

Mods are organized into three categories:
- **Observer**: read-only logging / data export, no runtime state change
- **Modifier**: alters in-game behaviour (e.g. QTE result, skill selection)
- **Debug**: verbose low-level trace for analysis (high log volume)

## Installation

Install Node dependencies:

```bash
npm install
```

## Usage

Choose either entry point below.

### Method A: Floating control panel (recommended)

A Tkinter always-on-top window powered by `frida-python`. It lets you pick which mods to load before injection, toggle any mod at runtime, and view/export logs in real time.

One-time dependency install:

```powershell
pip install frida frida-tools
```

Launch:

```powershell
.\control.ps1
```

The script runs `npm run build` first, then opens the panel. Tick the mods you want, start the game (or start the game first, either order works), then press **▶ Start Injection**.

Panel features:

- **Always-on-top** toggle (top-left corner)
- **Mod list** grouped by Observer / Modifier / Debug. Tick/untick to apply immediately; selection is persisted to `mods.json` for the next launch.
- **Log viewer** (right pane) with Clear / Copy to clipboard / Save as log file buttons.
- Ring buffer keeps the last 5000 lines; older lines are dropped automatically.

### Method B: Headless injection (console only)

Start the game, then run the provided PowerShell script:

```powershell
.\run.ps1
```

The script will:

* Build the Frida agent using `npm run build`
* Attach the agent to the running game process
* Save runtime logs to the `logs` directory

Log files are generated with timestamps:

```
logs/
└── 20260716_001234.log
```

## Mod configuration (`mods.json`)

Every feature lives in its own mod under `src/mods/`. `mods.json` defines the default enabled state for each mod. Ticking/unticking through Method A writes back to this file automatically.

```json
{
  "auto-skill": true,
  "backtrace": false,
  "battle-log": false,
  "damage-calc-trace": false,
  "qte-perfect": true,
  "trace-config": false,
  "unit-list-dump": true
}
```

| Key                 | Category   | Description                                                                           |
|---------------------|------------|---------------------------------------------------------------------------------------|
| `battle-log`        | Observer   | Post-battle per-unit damage ranking (read-only)                                       |
| `qte-perfect`       | Modifier   | Forces every QTE result to PERFECT                                                    |
| `auto-skill`        | Modifier   | Auto-picks EX1 / EX2 / off during auto-mode based on `char_skill.json`                |
| `damage-calc-trace` | Debug      | Prints `CaluculationNormalDamage` args and every Offset coefficient — very verbose    |
| `unit-list-dump`    | Observer   | Exports every unit's attributes to `unit_list.json` when the party editor is opened   |
| `trace-config`      | Debug      | Bulk-registers arg-dump trace points listed in `trace_config.json`                    |
| `backtrace`         | Debug      | Prints an IL2CPP call stack on entry for methods listed in `trace_config.json`        |

## Skill configuration

`char_skill.json` controls the priority used by the `auto-skill` mod.

Example:

```json
{
    "星を見るもの": 2,
    "バニーサンタ": 1,
    "夏色マジカル☆": 0
}
```

Values:

- `2`: Prefer EX2; auto-cast it whenever the EX gauge covers the EX2 cost.
- `1`: Prefer EX1; auto-cast it whenever the EX gauge covers the EX1 cost.
- `0`: Never auto-cast any EX skill for this unit.

The fallback lookup order is `[UnitName] CharacterName` → `UnitName` so a single entry can cover all variants of a unit when no exact override exists.

## Debug observation points (`trace_config.json`)

The `trace-config` and `backtrace` mods share `trace_config.json`, so adding new observation points requires **no source edit and no re-injection**:

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

- `trace`: attaches `dumpArgs` to every `class.method` listed.
- `backtrace`: prints an IL2CPP call stack (addresses resolved through the method address index) each time the method is entered; per-entry `depth` overrides the global `backtraceDepth`.
- After editing the file, press **重载配置** on the control panel to apply immediately — new points attach and removed points detach at runtime. The file is also read once at injection time.
- Keep the arrays empty by default: tracing a method that another mod (e.g. `battle-log`) already hooks doubles the log output for that method.

## Disclaimer

This project is intended for research, analysis, and personal customization purposes.

Some features modify battle-related state and may affect game behaviour. Use at your own risk.

## Credits

Thanks to [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) for providing a valuable reference for Frida and IL2CPP runtime analysis.
