# TSKBattleLog

[English](README.md) | 简体中文

基于 Frida 和 IL2CPP 的《闪耀星骑士》战斗日志分析工具。

TSKBattleLog 捕获并分析游戏运行时的战斗事件——伤害、技能、战斗状态——并提供悬浮控制面板用于加载/切换 mod 和实时查看单位 buff。自动战斗技能选择可通过 `char_skill.json` 配置。

## 功能特性

- 毫秒级时间戳的实时战斗事件日志
- 各单位伤害追踪与战后排名
- 多段技能分组（按攻击者 / 回合 / 类型 / 段数），含暴击数与技能倍率
- 合击（Unison）伤害追踪
- 通过 `char_skill.json` 配置自动战斗技能选择
- 通过 `trace_config.json` 配置调试观测点与 IL2CPP 调用栈回溯
- Mod 加载器，支持运行时开关，配悬浮控制面板
- 单位头像栏（玩家 wiki 图标）+ 紧凑敌人列表；点击任意单位可查看实时 buff、ATK/CRT/NoteCount 及 EX 相关属性，支持明细/汇总切换
- 日志自动落盘 + 面板内日志查看器（清空 / 复制 / 打开日志目录）

## Mod 分类

- **观察**：只读日志 / 数据导出，不改变运行时状态
- **修改**：改变游戏内行为（如 QTE 结果、技能选择）
- **调试**：用于分析的详细底层追踪（日志量很大）

## 安装

```bash
npm install
```

## 使用方法

### 方式一：悬浮控制面板（推荐）

基于 `frida-python` 的 Tkinter 置顶窗口。

一次性安装依赖：

```powershell
pip install frida frida-tools
```

启动：

```powershell
.\control.ps1
```

脚本会先执行 `npm run build`，然后打开面板。勾选需要的 mod，点击 **▶ 启动注入**。游戏可在面板之前或之后启动——桥接器会等待进程出现。

面板功能：

- **窗口置顶**开关（左上角）
- **MODs / Logs** 标签页（不同时显示）；启动注入后自动切到 Logs
- Mod 列表按 观察 / 修改 / 调试 分组，勾选结果持久化到 `mods.json`。注入开始后复选框锁定（战斗中切换 mod 不安全）
- **重载配置**：重新读取 `trace_config.json`，运行时更新 trace/backtrace 观测点
- **隐藏单位栏**：隐藏玩家头像栏与敌人列表，专注看日志
- 日志查看器带 **清空 / 复制日志 / 打开日志目录**；日志同时自动写入 `logs/`（8 KB 缓冲，关闭时 flush）
- 5000 行环形缓冲；更早的日志自动丢弃
- 玩家头像栏（48 px wiki 图标）及其上方的紧凑敌人名条。点击任意单位弹出 **Skill Effects** 窗口，显示实时 buff（明细/汇总切换）以及 ATK（含基础值）、CRT、NoteCount、EX 上升率和普攻回复 EX

### 方式二：无界面注入（仅控制台）

先启动游戏，然后：

```powershell
.\run.ps1
```

脚本会构建 agent、附加到正在运行的游戏进程，并将日志保存到 `logs/`。

## Mod 列表

每个功能都是 `src/mods/` 下独立的 mod。`mods.json` 保存默认启用状态，并由面板自动更新。

| 键                  | 分类 | 说明                                                                                               |
|---------------------|------|----------------------------------------------------------------------------------------------------|
| `battle-log`        | 观察 | 打印战斗相关各种信息（伤害统计、多段分组、回合、战斗结算）                                          |
| `unit-list-dump`    | 观察 | 角色界面进行筛选或排序操作时将所有单位属性导出到 `unit_list.json`                                   |
| `qte-perfect`       | 修改 | 战斗开始时的 QTE 结果强制 PERFECT                                                                   |
| `auto-skill`        | 修改 | auto模式下按 `char_skill.json` 配置自动选择 EX1/EX2                                                 |
| `damage-calc-trace` | 调试 | 打印伤害计算相关的各个参数——日志量非常大                                                            |
| `trace-config`      | 调试 | 按 `trace_config.json` 批量注册参数 dump 观察点（改 JSON 后点面板重载配置即生效）                    |
| `backtrace`         | 调试 | 按 `trace_config.json` 在指定方法进入时打印 IL2CPP 调用栈                                           |
| `field-watch`       | 调试 | 监控指定类的指定字段变化，打印修改者方法名和调用栈                                                   |

## 技能配置（`char_skill.json`）

控制 `auto-skill` 的优先级。

```json
{
    "星を見るもの": 2,
    "バニーサンタ": 1,
    "夏色マジカル☆": 0
}
```

取值：

- `2`：优先 EX2
- `1`：优先 EX1
- `0`：从不自动释放 EX 技能

回退查找顺序为 `[单位名] 角色名` → `单位名`，因此单个条目可覆盖一个单位的所有变体。

## 调试观测点（`trace_config.json`）

`trace-config` 与 `backtrace` 共用此文件——添加观测点**无需改源码，也无需重新注入**：

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

- `trace`：为列出的每个 `类.方法` 挂载 `dumpArgs`
- `backtrace`：进入方法时打印 IL2CPP 调用栈（经方法地址索引解析）；每条目可单独设 `depth`，覆盖全局 `backtraceDepth`
- 编辑后点击 **重载配置** 立即生效——新观测点运行时挂载，被移除的运行时卸载
- 默认保持数组为空：追踪已被其他 mod（如 `battle-log`）hook 的方法会导致该方法日志翻倍

## 免责声明

仅供研究、分析和个人使用。部分功能会修改战斗状态，可能影响游戏行为。使用风险自负。

## 致谢

感谢 [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) 为 Frida 与 IL2CPP 运行时分析提供宝贵参考。
