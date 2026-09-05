# TSKBattleLog

[English](README.md) | 简体中文

基于 Frida 和 IL2CPP 的 Twinkle Star Knights 战斗日志分析工具。

TSKBattleLog 捕获并分析游戏运行时的战斗事件，包括伤害事件、技能使用和战斗状态。它还通过 `char_skill.json` 提供可配置的自动战斗技能选择。

## 功能特性

- 实时战斗事件日志
- 伤害追踪与战后伤害统计
- 技能使用追踪
- 合击（Unison）伤害追踪
- 战斗状态分析
- 通过 `char_skill.json` 配置自动战斗技能选择
- 通过 `trace_config.json` 配置调试观测点与 IL2CPP 调用栈回溯
- 通过悬浮控制面板在运行时切换 mod
- 毫秒级精度的运行时日志查看器

## 输出示例

战斗结束后，TSKBattleLog 会根据捕获的战斗事件生成伤害统计：

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

## 技术说明

TSKBattleLog 使用 Frida 和 `frida-il2cpp-bridge` 在运行时 hook IL2CPP 方法，重建战斗事件。

项目通过追踪相关方法、将游戏内部战斗数据转换为可读日志来观测游戏运行时行为。

Mod 分为三类：

- **Observer（观测类）**：只读日志 / 数据导出，不改变运行时状态
- **Modifier（修改类）**：改变游戏内行为（如 QTE 结果、技能选择）
- **Debug（调试类）**：用于分析的详细底层追踪（日志量很大）

## 安装

安装 Node 依赖：

```bash
npm install
```

## 使用方法

以下两种入口任选其一。

### 方式一：悬浮控制面板（推荐）

一个基于 `frida-python` 的 Tkinter 置顶窗口。可以在注入前选择要加载的 mod，在运行时切换任意 mod，并实时查看/导出日志。

一次性安装依赖：

```powershell
pip install frida frida-tools
```

启动：

```powershell
.\control.ps1
```

脚本会先执行 `npm run build`，然后打开面板。勾选需要的 mod，启动游戏（或先启动游戏，顺序不限），然后点击 **▶ 启动注入**。

面板功能：

- **窗口置顶**开关（左上角）
- **Mod 列表**，按 Observer / Modifier / Debug 分组。勾选/取消勾选立即生效；选择结果会持久化到 `mods.json`，供下次启动使用。
- **日志查看器**（右侧面板），带清空 / 复制到剪贴板 / 另存为日志文件按钮。
- 环形缓冲区保留最近 5000 行；更早的日志会自动丢弃。

### 方式二：无界面注入（仅控制台）

先启动游戏，然后运行提供的 PowerShell 脚本：

```powershell
.\run.ps1
```

脚本会：

* 使用 `npm run build` 构建 Frida agent
* 将 agent 附加到正在运行的游戏进程
* 将运行时日志保存到 `logs` 目录

日志文件带时间戳生成：

```
logs/
└── 20260716_001234.log
```

## Mod 配置（`mods.json`）

每个功能都位于 `src/mods/` 下独立的 mod 中。`mods.json` 定义每个 mod 的默认启用状态。通过方式一勾选/取消勾选会自动写回该文件。

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

| 键                  | 分类     | 说明                                                                 |
|---------------------|----------|----------------------------------------------------------------------|
| `battle-log`        | Observer | 战后各单位伤害排名（只读）                                           |
| `qte-perfect`       | Modifier | 强制每次 QTE 结果为 PERFECT                                          |
| `auto-skill`        | Modifier | 自动模式下根据 `char_skill.json` 自动选择 EX1 / EX2 / 关闭           |
| `damage-calc-trace` | Debug    | 打印 `CaluculationNormalDamage` 参数及每个 Offset 系数——日志量非常大 |
| `unit-list-dump`    | Observer | 打开编队编辑器时将每个单位的属性导出到 `unit_list.json`              |
| `trace-config`      | Debug    | 批量注册 `trace_config.json` 中列出的参数转储追踪点                  |
| `backtrace`         | Debug    | 进入 `trace_config.json` 中列出的方法时打印 IL2CPP 调用栈            |

## 技能配置

`char_skill.json` 控制 `auto-skill` mod 使用的优先级。

示例：

```json
{
    "星を見るもの": 2,
    "バニーサンタ": 1,
    "夏色マジカル☆": 0
}
```

取值：

- `2`：优先 EX2；只要 EX 槽满足 EX2 消耗就自动释放。
- `1`：优先 EX1；只要 EX 槽满足 EX1 消耗就自动释放。
- `0`：该单位从不自动释放任何 EX 技能。

回退查找顺序为 `[单位名] 角色名` → `单位名`，因此在没有精确覆盖项时，单个条目即可覆盖一个单位的所有变体。

## 调试观测点（`trace_config.json`）

`trace-config` 和 `backtrace` 两个 mod 共用 `trace_config.json`，因此添加新的观测点**无需修改源码，也无需重新注入**：

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

- `trace`：为列出的每个 `类.方法` 挂载 `dumpArgs`。
- `backtrace`：每次进入该方法时打印 IL2CPP 调用栈（地址通过方法地址索引解析）；每条目可单独设置 `depth`，覆盖全局的 `backtraceDepth`。
- 编辑文件后，点击控制面板上的 **重载配置** 即可立即生效——新观测点会在运行时挂载，被移除的观测点会在运行时卸载。文件在注入时也会读取一次。
- 默认请保持数组为空：追踪已被其他 mod（如 `battle-log`）hook 的方法，会导致该方法的日志输出翻倍。

## 免责声明

本项目仅供研究、分析和个人定制使用。

部分功能会修改战斗相关状态，可能影响游戏行为。使用风险自负。

## 致谢

感谢 [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) 为 Frida 与 IL2CPP 运行时分析提供了宝贵参考。
