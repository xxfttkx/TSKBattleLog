# avatar-clarity：头像清晰化功能经历记录

> 功能：让战斗中的角色头像 UI（`TSKBattleUnitIcon`，含 buff/觉醒图标）常态下不再半透明，
> 同时完整保留游戏的演出动画（该淡入淡出就淡入淡出、该隐藏就隐藏）。
>
> 实现位置：`src/debug/gaugeTop.ts`（逻辑）+ `src/mods/AvatarClarityMod.ts`（mod 壳）。
> 本文记录整个功能的摸索过程、走过的弯路和最终方案的原理。

## 背景

战斗 UI 中，包含角色头像、buff 图标、觉醒标志的分支平时显示得半透明、不清晰。
最初以为只是渲染层级问题（被上层的"时间轴（回合顺序条）"盖住了），
目标从"把 `TSKBattleUnitIcon.specificGaugeView` 提到高层"一路演变成"常态不透明"。

## 关键诊断

一系列 dump 日志（`logs/20260906_*.log`）最终定位到真相：

- 头像分支根节点是 `UnitPlayerIconRoot`（`MainRoot`/`BattleUIRoot` 的直接子节点），
  时间轴 `TimeLine` 是它的**兄弟分支**——不是父子层级关系。
- 半透明的真凶不是层级，而是 `UnitPlayerIconRoot` 上的 `CanvasGroup.alpha` 被游戏动画化：

| 状态 | CanvasGroup.alpha |
| --- | --- |
| 常态（空闲） | `0.30000001192092896`（float 0.3） |
| 出手 / EX 演出 | `1` |
| 演出结束隐藏 | `0` |

游戏靠 **alpha + 渲染顺序** 这套组合控制演出节奏，动层级就会打架。

## 弯路记录

1. **认错组件**：一开始把对象当成 `TSKBattleStatusIconView`（时间轴上的状态图标），
   给它加 `Canvas`（`overrideSorting=true, sortingOrder=30000`）毫无效果——
   教训：加 `Canvas` 只影响自身子树，**兄弟分支之间的遮挡**它管不了。
2. **`SetAsLastSibling` 提层**：把整个头像分支挪到最后绘制，能变清晰，
   但破坏了游戏演出节奏；某版诊断代码（gc.choose + 大量 invoke）还把游戏卡死过一次。
3. **强制 Canvas 置顶 + hook 保活**：游戏会反复把 `overrideSorting` 重置回 false、
   `sortingOrder` 重置回 0，只能再 `Interceptor.replace` 这两个 setter 硬顶——
   结果头像挡住了 ex gauge，且"演出时自动隐藏"失效。此路不通，全部回退。

## 最终方案（第 12 版）

**完全不动层级，只最小化干预 alpha**：

- 战斗初始化（`TSKBattleTeam.Initialize`）后 2s/5s/9s/15s/25s 扫描 `TSKBattleUnitIcon`，
  向上找到头像分支根 `UnitPlayerIconRoot`，把它的 `CanvasGroup` 句柄加入看守名单。
- `Interceptor.replace` 整个 `UnityEngine.CanvasGroup.set_alpha`：
  - float 参数走 XMM 寄存器，`args[1].replace` 改不动，
    必须用 `NativeCallback("void", ["pointer","float"])` 整体替换 + `NativeFunction` 调原函数；
  - 只有**看守名单中的对象**且**新值恰好是常态淡化值 0.3** 时改传 `1`；
  - 其余值（0 隐藏、1 演出显示、渐变中间值）一律原样放行。

拦截条件必须最窄：第 11 版曾把整个 `(0,1)` 区间都改成 1，
结果演出渐隐动画（1→0）每一帧都被顶成 1——头像全程不透明、
直到最后一帧才"啪"地消失，这就是当时"时不时抖两下 + 挡住 ex gauge"的原因。

淡化值匹配用精确值 `0.30000001192092896`（float 0.3 提升为 double 的精确值）
加 ±1e-9 窄窗口：JS 字面量 `0.3` 是另一个 double，直接 `=== 0.3` 永远不成立；
而渐变插值的中间值也不可能落进这个窗口，不会误伤动画。

## 卡死事件与排查（mod 转正当晚）

第 12 版转正为 mod 后连续两次游戏卡死（`logs/20260906_224254/225026`）：

- 224254：战斗跑到 Unison 演出、`turn 2->3` 后日志戛然而止；
- 225026：`t=2s scan` 完成后戛然而止，`t=5s scan` 再无输出——**此时 alphaHook 一次都未触发过**，排除 hook 回调本身。

结论指向 scan 的"复查"逻辑：每轮 scan 即使没有新实例，也会对存活实例跑一遍完整
`apply()`（14 层父链遍历 + `dumpSubtreeAlpha` 深度 4 全树 `GetComponent`），
全部是 **从 Frida 线程 invoke Unity API**；与此同时游戏主线程正在被
`Interceptor.replace` 的 `CanvasGroup.set_alpha` 里等待 JS runtime 锁——
两边互等即死锁。这个结构性风险从第 9 版起就存在，之前没炸只是概率。

对策（第 13 版）：

1. 删除"无新实例也复查"的 scan 逻辑，诊断 dump 只跑一次；
2. 扫描点从 5 个减到 3 个（2s/10s/20s），只处理新实例；
3. 已看守分支的实例向上遍历提前短路（句柄已在看守名单则直接命中）；
4. hook 回调 try/catch 全包（异常绝不冒泡到 native）；
5. 回调内零字符串分配：看守名单比对改用 `NativePointer[]` + `equals()`，
   不再对每次 `set_alpha` 调用做 `toString()`。

另：开发期间遇到 IDE 缓冲区把旧内容写回、覆盖已保存修改的情况，
导致 `guardedPtrs` 声明丢失而引用还在、`SCAN_DELAYS` 回退旧值——
编译报 `Cannot find name 'guardedPtrs'` 才暴露。改完文件后务必在 IDE 里
重新加载（Revert File）再继续编辑。

## 卡顿分析与最终形态（第 14 版：纯轮询，零 hook）

转正后用户反馈"不卡死了但仍时常卡顿"。231858 会话的日志给出决定性数据：
**打满三回合，修正只发生 5 次**（进场、演出结束、回合切换）——游戏并不是
每帧设置 alpha，而是在演出节点**直接赋值常量 0.3**（5 次值全部精确等于
float 0.3 的 double 精确值，非插值产物）。

结论：全局 `Interceptor.replace set_alpha` 的修正路径几乎不工作，
**卡顿全部来自放行路径**——战斗 UI（时间轴/血条/buff/伤害数字）每帧几百次
`set_alpha`，每次都要 native→JS→native 往返（抢 QuickJS 锁 + 构造调用帧），
累计每帧数毫秒。这是机制开销，收窄拦截条件无法消除。

抓栈定位源头的尝试也失败了：`Thread.backtrace` 在 NativeCallback 里不传
context 只能拿到垃圾帧（地址都是 `0xffffffff...` 前缀），80046 个方法的
符号表建好了却一帧都没匹配上。（教训：要在 hook 内抓栈需从 `attach` 的
`onEnter` 拿 `this.context`，或解决 NativeCallback 内取当前 CpuContext 的问题。）

最终方案改回**轻量轮询**（第 9 版思路 + 精确值匹配的教训）：

1. 完全不 hook 任何函数，游戏原生 `set_alpha` 零开销；
2. 每 200ms 对看守的 1 个 CanvasGroup `invoke get_alpha`，恰为 0.3 才 `set_alpha(1)`；
3. 每秒 5 次 getter，开销可忽略；修正延迟 ≤200ms，游戏设 0.3 是离散事件，无感知；
4. 看守对象销毁（`m_CachedPtr` 判活失败）即清理，名单清空即停表；
5. 插值中间值不可能精确命中 0.3 常量，不会重现第 9 版"(0,1) 全改"式闪烁。

> 取舍：hook 高层源头方法仍是理论最优（零开销 + 零延迟），但需要先解决
> 抓栈问题或逆向定位；轮询已实测够轻，先落地验证。

## 闪退事件与第 15 版（CModule 纯 native hook）

第 14 版轮询首次出现**闪退**（此前只是卡死）。232558 会话：战斗打到 turn 5
后进程崩溃。根因：轮询每 200ms 从 **Frida 的 JS 定时器线程**跨线程 invoke
Unity 引擎 icall（get_alpha/set_alpha），`isNativeAlive` 检查与 invoke 之间
存在竞态窗口——主线程恰好销毁战斗 UI（演出切换/UI 重建高发）时即
use-after-free → 进程崩溃。卡死是互等锁、闪退是竞态 UAF，**同为跨线程碰
Unity 对象的恶果，这条路彻底封死**。

（澄清：231858 会话的 5 次修正不是对应 5 个角色——看守对象只有 1 个全队
共享的 UnitPlayerIconRoot；5 次对应 5 个演出节点。）

第 15 版改为 `CModule` 纯 native hook，**零 JS 参与、零跨线程 invoke**。
初版踩了一个坑：CModule 的数据页只读（内存 slab 靠近代码段分配），JS 直接
`writePointer` 写其全局变量 `orig_set_alpha` 直接 access violation
（233839 会话 `nativeHook failed: access violation`，整场战斗零修正）。
数据区改为 JS 侧 `Memory.alloc` 的可写堆，经 `new CModule(source, symbols)`
注入为 C 的 `extern` 符号后解决。

## 最终实现详解（第 16 版，当前形态）

### 架构：控制面 JS + 数据面 C

```
┌─ JS 侧（控制面，低频）─────────────────────────────┐
│ 注入时:  Memory.alloc 数据区(RW堆：表×2/计数/orig指针) │
│          new CModule(C源码, {extern符号→堆地址})       │
│          Interceptor.replace(set_alpha, cm.set_alpha_hook) │
│ 每场战斗: Initialize onEnter(游戏线程) → 清表(防句柄复用)  │
│           → 2s/10s/20s setTimeout scan               │
│           scan: gc.choose(TSKBattleUnitIcon) 新实例    │
│           → apply 向上找 UnitPlayerIconRoot            │
│           → trackAlphaGuard: 句柄+m_CachedPtr 写入 C 表 │
│ 每 5 秒:  读 fix_count 内存 → 有变化才打日志            │
└──────────────┬──────────────────────────────┘
               │ 两个平行表（JS 写，C 读；先写槽数据后更新 count）
┌─ C 侧（数据面，CModule/tcc 编译，游戏线程执行）────────┐
│ set_alpha_hook(self, value, method):                   │
│   遍历 guarded[0..n):                                  │
│     guarded[i]==self 且 *(self+0x10)==guarded_native[i]│
│     → value==0.3f ? orig(self,1.0) : orig(self,value)  │
│     → return                                           │
│   句柄命中但校验失败（复用死槽位）→ break 落到放行        │
│   其余（未命中）→ orig(self,value) 原样放行             │
└────────────────────────────────────────────────┘
```

### 关键设计逐条

1. **为什么 hook 引擎函数**：游戏在演出节点直接赋值常量 0.3（三回合 5 次），
   只有 `set_alpha` 这一个必经之路；想 hook 更高层方法需要先解决抓栈问题（未果）。
2. **为什么 replacement 必须是 C**：`set_alpha` 是全游戏 UI 热路径（每帧几百
   次调用），JS 闭包版每次要走 native→QuickJS 锁→JS 帧→native 往返，累计
   每帧数毫秒 = 卡顿。C replacement 在游戏线程原生执行，纳秒级。
3. **C 里如何调原函数**：`orig_set_alpha` 指向被 patch 的入口，gum 的
   re-entrancy 保护检测到当前线程已在 hook 上下文，直接跳到原始指令的重定位
   副本（relocated trampoline）。该机制与 replacement 语言无关，第 11~13 版
   JS 版已连续实证。
4. **icall 第一参数 = il2cpp 托管句柄**：实证于第 11~13 版（`cg.handle` 匹配
   `selfPtr` 命中），所以 C 表直接存 `cg.handle`，无需解 m_CachedPtr 才能比对。
5. **值匹配**：`value == 0.3f`——C 字面量与游戏常量编码为同一 float
   （0x3E99999A），精确比较；动画插值中间值不可能命中，演出 0 隐藏/1 显示
   全放行，"动画时自动隐藏"完整保留。
6. **双重校验防句柄复用误伤**（第 16 版新增）：战斗 UI 销毁后 il2cpp GC 释放
   句柄，新对象可能分到同一地址。表槽从 1 字段变 2 字段（`guarded[]` 句柄 +
   `guarded_native[]` 创建时读到的 m_CachedPtr），C 命中句柄后再比对
   `*(self+0x10)`——复用对象该值必然不同 → 死槽位放行。误伤窗口归零。
   m_CachedPtr 读取与 `isNativeAlive` 同源（x64 偏移 0x10），只读内存无竞态。
7. **生命周期管理**：战斗 `Initialize` onEnter（游戏线程）清表 → 旧句柄立即
   出表 → 2s 后 scan 重填新战斗的分支根。表容量 16，实际只占 1 槽
   （全队共享一个 UnitPlayerIconRoot）。
8. **线程安全**：写侧（JS scan，低频）先写槽数据后 `writeS32` 更新 count，
   C 读侧先读 count 再读槽——x64 TSO + volatile 保证顺序；数据在 RW 堆，
   C 侧全程无内存写（除 JS 堆上的 fix_count++）。

### 与"典型 Frida 写法"的对照

| | 典型写法 | 本实现 |
| --- | --- | --- |
| replacement | `NativeCallback`（JS 闭包） | CModule 导出的 C 函数 |
| 每次调用开销 | 抢 QuickJS 锁 + 构造调用帧 | 纯 native，纳秒级 |
| 适用场景 | 低频函数、业务逻辑 | 引擎级热路径 |

JS 只做"找对象、填表、看计数"（控制面），逐次调用的过滤判断完全下沉到
native（数据面）——思想类似 eBPF/XDP：控制面留在用户态，数据面下沉内核态。

### 第 17 版：scan 数据源改为 notes 直读（当前形态）

003220 回归通过后仍有"前几回合卡顿"，头号嫌疑是 scan 的 `Il2Cpp.gc.choose`：
它不是查 UI 树，而是对整个 GC 堆做 **liveness 可达性计算**，期间
`stopWorld()` 暂停全部游戏线程（bridge 实现：stopWorld → livenessAllocateStruct
→ livenessCalculationFromStatics/Finalize → startWorld），大堆上一次几十 ms；
2s/10s/20s 三轮全压开场，与卡顿时间窗吻合。它返回的是"GC 可达"对象，混着
引擎侧已 Destroy 但 C# 包装仍可达的实例（15 total / 5 alive 的来源）。

改法：图标实例不扫堆，沿数据链直读——`TSKBattleTeam.Initialize` 的 `args[4]`
是 notes List（battle-log 同款读取），`_items[i]` → `TSKBattleNote.unitIcon`
（偏移 0x58）→ `TSKBattleUnitIcon`，全程字段/数组偏移的纯内存读，零 invoke、
零 stop-the-world。仅玩家队扫描（type==0，x64 栈槽按低 8 位判）；unitIcon 在
onEnter 时可能未赋值（图标 UI 晚于数据层挂载），靠多轮 scan 兜底，t=20s 仍空
则打日志提示。invoke 只剩 apply 的父链 walk（新图标才走，看守命中即短路）。
顺带修一个旧隐患：跨场 scan 的 `seenInstances` 去重表此前不随战斗清空，
句柄被 GC 复用时会漏扫新图标，现随 clearGuardTable 一并清空。

## 检验过程

整个功能的验证依赖"日志证据链"，每轮测试都从 `logs/*_panel.log` 读结论：

| 会话（时刻） | 版本 | 现象 | 证据 → 结论 |
| --- | --- | --- | --- |
| 221645 | 11 | 常态清晰但"抖两下"、挡 ex gauge | `(0,1)` 全拦截把渐隐动画每帧顶成 1 → 拦截条件必须收窄 |
| 231858 | 14 | 不卡死但闪退；打满三回合仅 5 次修正 | 修正值全部精确= float 0.3 → 游戏是离散赋值非插值；轮询跨线程 invoke → UAF 闪退 |
| 233839 | 15 初版 | 整场零修正 | `nativeHook failed: access violation` → CModule 数据页只读，数据区必须放 JS 堆 |
| 234059（后续） | 15 修正版 | 常态清晰、无卡顿、无闪退 | `nativeHook: CModule 已接管` + 5s 计数日志出现 → 方案成立 |
| 003220 | 16 | 常态清晰、演出淡入淡出正常、无卡死/闪退，修正计数随演出节点递增至 13+ | `CModule 已接管`（无 failed）+ `看守` + `淡化 0.3 -> 1（第N次）` 三条齐全 → v16 回归通过（跨场生效待验证） |

> 16 版回归前还踩了一次"IDE 缓冲区覆盖把已改好的源码打回去"（001106 会话）：
> 构建产物缺 `guarded_native` 符号，tcc 链接失败 → hook 静默降级为仅诊断模式
> （scan/看守日志照打，但看守表永远填不进、零修正）。对策：改码后构建前先
> grep 源码、构建后 grep `dist/agent.js`（`guarded_native` 应命中 3 处：
> C extern、C 使用、JS symbols 映射），全部确认后再注入。

### 回归测试清单（每次改版后过一遍）

1. 注入日志：`nativeHook: CModule 已接管 CanvasGroup.set_alpha`（无 failed）
2. 进战斗 2s：`看守: 已盯住 UnitPlayerIconRoot`（scan 找到分支根）
3. 常态：头像、buff、觉醒标志清晰不透明
4. 出手/EX 演出：头像演出时显示、演出结束正常淡出，**不挡 ex gauge**
5. 战斗中：无卡顿、无卡死、无闪退（打满 5+ 回合）
6. 连打多场：第二场战斗依然生效（清表/重填正确），日志有 `nativeHook: 淡化 0.3 -> 1（第N次）` 递增
7. 反检测考量：这是修改型 mod，在意反检测时在 GUI 取消勾选 `avatar-clarity`
   即可——禁用后不 onLoad，`set_alpha` 完全不被 hook

## 踩坑清单

- `get_name()` 返回值自带双引号，比较前必须剥引号；
  `Transform.Find` 的 string 参数在本环境 invoke 会报 incorrect parameter types，
  孩子查找用"枚举 + 剥引号比较"。
- `Il2Cpp.gc.choose` 会混入已销毁对象：invoke 前先读 `m_CachedPtr`（x64 偏移 0x10）判活，
  只读内存对已销毁对象也安全。
- 枚举 Transform 孩子要**逐孩子 try**，别把整层包在一个 try 里（单个销毁孩子拖垮全部）。
- hook 带 float 参数的 IL2CPP 方法：参数在 XMM 寄存器里，只能整体 replace，不能原地改 args。
- 引擎级全局 hook（如 `CanvasGroup.set_alpha`，全游戏共用）的拦截条件必须收窄到"精确值 + 白名单"，
  未命中路径必须原样放行，否则会破坏游戏其他 UI 的动画。
- 修"显示不清晰"应先查 `CanvasGroup.alpha` / `CanvasGroup.interactable` 这类状态，
  最后才考虑动渲染层级；uGUI 遮挡要先分清是**父子层级**还是**兄弟顺序**问题。

## 涉及文件

- `src/debug/gaugeTop.ts` — 全部逻辑（扫描、看守名单、set_alpha 替换、诊断 dump）
- `src/mods/AvatarClarityMod.ts` — mod 壳（`mods.json` 键名 `avatar-clarity`，分类：修改）
- `src/mods/BattleLogMod.ts` — 旧临时挂载点（已移除）
- `notes/archive.md` — 通用踩坑（Windows x64 bool 参数、层级渲染等）
