# TSKBattleLog

A battle log analyzer for Twinkle Star Knights using Frida and IL2CPP.

TSKBattleLog captures and analyzes battle events from the game runtime, including damage events, skill usage, and combat states. It also provides configurable auto-battle skill selection through `char_skill.json`.

## Features

- Real-time battle event logging
- Damage tracking and post-battle damage summary
- Skill usage tracing
- Unison damage tracking
- Combat state analysis
- Configurable auto-battle skill selection via `char_skill.json`

## Example Output

After a battle, TSKBattleLog can generate a damage summary from captured battle events:

```text
[00:10:27] enter TSKBattleManager.InitializeResult
[00:10:27] [TSKBattleLog] onEndBattle: total damage=34096197125
[00:10:27] [TSKBattleLog] 初日の出を迎えて (フィオナ) damage:1542869178(5%)
[00:10:27] [TSKBattleLog] バニーサンタ (蘭美) damage:8171700221(24%)
[00:10:27] [TSKBattleLog] 霹靂の射手 (梨緒) damage:11016266663(32%)
[00:10:27] [TSKBattleLog] 夏色マジカル☆ (リーリア) damage:289089448(1%)
[00:10:27] [TSKBattleLog] 星を見るもの (フィオナ《魔王》) damage:10674388148(31%)
[00:10:27] return: 0x7ffcd60e2bd0
```

## Technical Notes

TSKBattleLog uses Frida and frida-il2cpp-bridge to hook IL2CPP methods at runtime and reconstruct battle events.

The project observes game runtime behavior by tracing relevant methods and converting internal battle data into readable logs.

## Installation

Install dependencies:

```bash
npm install
```

## Usage

两种运行方式（任选其一）：

### 方式 A：悬浮窗控制面板（**推荐**）

用 Tkinter + frida-python 做的置顶小窗口，可在运行时开关任意 mod、实时查看和导出日志。

安装一次性依赖（仅首次）：

```powershell
pip install frida frida-tools
```

启动：

```powershell
.\control.ps1
```

启动后会先 `npm run build` 编译最新的 agent.js，然后弹出悬浮窗。**先开游戏、后开面板**也能自动等待并注入。

悬浮窗功能：

- 左上角可切换「窗口置顶」
- 左侧按**观察 / 修改 / 调试**三类分组显示 mod，勾选后**立即生效**并自动写入 `mods.json` 下次沿用
- 右侧是实时日志面板，带「清空日志」「复制到剪贴板」「保存到 logs/」按钮
- 日志上限 5000 行，超出自动裁剪最旧内容

### 方式 B：传统注入（仅控制台）

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

## Mod 开关配置（`mods.json`）

所有功能按 mod 拆分，在 `mods.json` 中配置默认启用状态。方式 A 中勾选/取消会自动回写到此文件。

```json
{
    "battle-log": true,
    "qte-perfect": true,
    "auto-skill": true,
    "damage-calc-trace": true,
    "unit-list-dump": false
}
```

| key | 分类 | 说明 |
|-----|------|------|
| `battle-log` | 观察 | 战斗伤害统计（战斗结束输出排名） |
| `qte-perfect` | 修改 | QTE 强制 PERFECT |
| `auto-skill` | 修改 | auto 时按 `char_skill.json` 自动选择 EX1/EX2 |
| `damage-calc-trace` | 调试 | 打印 CaluculationNormalDamage 参数与各 Offset 系数（日志量大） |
| `unit-list-dump` | 观察 | 筛选编队界面时导出单位属性到游戏目录下的 `unit_list.json`（默认关） |

## Configuration

`char_skill.json` can be used to configure skill selection rules during auto battle.

Example:

```json
{
    "星を見るもの":2,
    "バニーサンタ":1,
    "夏色マジカル☆":0
}
```

Configuration values:

- `2`: Automatically use EX2 if the current EX gauge is enough to pay the EX2 skill cost.
- `1`: Automatically use EX1 if the current EX gauge is enough to pay the EX1 skill cost.
- `0`: Never use any EX skill automatically.

The configuration controls the skill priority used by the auto-battle system.

## Disclaimer

This project is intended for research, analysis, and personal customization purposes.

Some features involve modifying battle-related data and may affect game behavior. Use at your own risk.

## Credits

Thanks to [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) for providing a valuable reference for Frida and IL2CPP runtime analysis.