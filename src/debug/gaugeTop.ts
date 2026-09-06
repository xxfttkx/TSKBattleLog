import { log } from "../utils";

/**
 * [gauge-top]：avatar-clarity mod 的实现（mods.json 键名 "avatar-clarity"）。
 * 角色头像 UI（TSKBattleUnitIcon，含 buff/觉醒图标）常态下不半透明。
 * 经历与方案演进见 notes/avatar-clarity.md。
 *
 * 实测结论（logs/20260906_221645 + 231858）：
 * - 半透明真凶：UnitPlayerIconRoot 的 CanvasGroup.alpha 被游戏动画化——
 *   常态 0.3、隐藏时 0、出手/EX 演出时 1。
 * - 层级（canvas overrideSorting）不能动：游戏靠它+alpha 控制演出节奏。
 * - 游戏只在演出节点直接赋值 0.3（三回合仅 5 次，值恒为 float 0.3），并非
 *   每帧持续设置；动画插值中间值不可能精确命中 0.3 常量。
 *
 * 方案演进与教训：
 * - 第 11~13 版 Interceptor.replace set_alpha（JS replacement）：卡顿——
 *   战斗 UI 每帧几百次 set_alpha 全要走 native->JS->native 往返（抢 QuickJS
 *   锁），修正路径本身极轻，开销全在放行路径，收窄条件无法消除。
 * - 第 14 版轮询（200ms invoke get/set_alpha）：闪退——从 Frida 的 JS 定时器
 *   线程跨线程 invoke Unity 引擎 icall，isNativeAlive 检查与 invoke 之间有
 *   竞态窗口，主线程恰好销毁战斗 UI 时即 use-after-free（卡死则是互等锁，
 *   同为跨线程碰 Unity 对象的恶果）。此路彻底封死。
 *
 * 第 15 版策略：CModule 纯 native hook，零 JS 参与、零跨线程 invoke。
 * 第 16 版：双重校验防句柄复用误伤——C 表存句柄 + 创建时的 m_CachedPtr，
 * 命中句柄后比对 *(self+0x10)，不一致（复用死槽位）即放行。
 * 第 17 版：scan 数据源弃用 Il2Cpp.gc.choose（liveness 计算 + stopWorld 暂停
 * 全部游戏线程，大堆上几十 ms，三轮全压开场 = 前几回合卡顿主嫌疑），改为
 * Initialize(args[4]) 的 notes List 直读：_items[i] -> TSKBattleNote.unitIcon
 * (0x58) -> TSKBattleUnitIcon，纯内存读零 invoke；type==0（玩家队）才扫。
 * - replacement 是 C 函数（CModule 编译），在游戏线程直接执行：查 16 槽
 *   指针表命中看守对象 && value == 0.3f → 改传 1.0f 调原函数，否则放行。
 *   纳秒级开销，游戏原生路径零感知。
 * - 数据区必须放 JS 堆（Memory.alloc RW）：CModule 的数据页只读（slab 靠近
 *   代码段分配），JS 写其全局变量直接 access violation（233839 实测），
 *   经 new CModule(source, symbols) 注入为 extern 符号。
 * - JS 侧只在 scan 找到看守对象时把句柄写表（纯内存写）；战斗 Initialize
 *   时（游戏线程）清表防旧句柄复用误伤，2s 后 scan 重填。
 * - 修正计数由 C 维护，JS 每 5s 读一次内存打日志（不碰 Unity 对象）。
 * - gum 对 replace 的 re-entrancy 保护与 replacement 语言无关（第 11~13 版
 *   已实证"replacement 内调原地址"安全跳 relocated original），C 里直接调
 *   原地址同理。
 *
 * 踩坑记录（详见 notes/archive.md）：
 * - get_name() 返回的名字自带双引号 → 比较前剥引号；Transform.Find 的 string 参数
 *   在本环境 invoke 会报 incorrect parameter types，孩子查找用枚举+剥引号比较
 * - gc.choose 混入已销毁对象（引擎侧已 Destroy 但 C# 包装仍可达），invoke 前
 *   先读 m_CachedPtr（偏移 0x10）判活
 * - 枚举孩子要逐孩子 try，别把整层包在一个 try 里
 * - Thread.backtrace 不传 context 只能得到垃圾帧（0xffffffff... 前缀），
 *   NativeCallback 内抓栈需另想办法（本功能最终不需要抓栈，工具已删）
 * - IL2CPP 的 set_alpha icall 第一参数就是 il2cpp 托管对象 handle
 *   （第 11~13 版 JS hook 用 cg.handle 匹配 selfPtr 命中，实证）
 */

const SCAN_DELAYS = [2000, 10000, 20000];
const MAX_GUARDED = 16;

/**
 * 游戏"常态淡化值"= float 0.3 的 32 位模式（0x3E99999A）。C 侧用
 * value == 0.3f 精确比较（编译器把字面量编码为同一 float），日志实测
 * 游戏 5 次赋值全部精确命中该值。
 */

/** CModule 源码：native 层 set_alpha 过滤器（不进 JS，纳秒级开销） */
const CM_SOURCE = `
#define MAX_GUARDED ${MAX_GUARDED}

typedef void (*set_alpha_t) (void * self, float value, void * method);

extern volatile void * guarded[MAX_GUARDED];
extern volatile void * guarded_native[MAX_GUARDED];
extern volatile int guarded_count;
extern volatile unsigned int fix_count;
extern volatile set_alpha_t orig_set_alpha;

void set_alpha_hook (void * self, float value, void * method)
{
  set_alpha_t orig = orig_set_alpha;
  if (orig == 0)
    return;
  int n = guarded_count;
  if (n > 0)
  {
    for (int i = 0; i < n; i++)
    {
      if (guarded[i] == self)
      {
        /* 双重校验：战斗 UI 销毁后 il2cpp GC 释放句柄，新对象可能分到同一
         * 地址（句柄复用）。创建时记录该对象的 m_CachedPtr（x64 偏移 0x10，
         * 指向引擎侧 native 对象），复用地址的新对象该值必然不同 → 视为
         * 死槽位，跳出循环走末尾的原样放行，杜绝误伤无关 UI。
         * 只读内存，无竞态崩溃面。 */
        if (*(void **)((char *) self + 0x10) == guarded_native[i])
        {
          if (value == 0.3f)
          {
            fix_count++;
            orig (self, 1.0f, method);
          }
          else
          {
            orig (self, value, method);
          }
          return;
        }
        /* 校验失败：复用的死槽位，self 不是看守对象 → 放行 */
        break;
      }
    }
  }
  orig (self, value, method);
}
`;

const seenInstances = new Set<string>();
/** 看守的 CanvasGroup 句柄（JS 侧去重；真名单位在 C 表里） */
const alphaGuarded = new Set<string>();
/** C 表的 JS 侧镜像（顺序数组，index i ↔ guarded[i]） */
const guardedList: NativePointer[] = [];
let dumped = false;
let warnedNoBranch = false;
let lastChainKey = "";
let chainLogCount = 0;
let cm: CModule | null = null;
/** 数据区在 JS 堆（RW），经 symbols 注入 CModule 的 extern 符号 */
let guardedTable: NativePointer | null = null;
/** 句柄对应的 m_CachedPtr 值表（双重校验防句柄复用误伤） */
let guardedNativeTable: NativePointer | null = null;
let guardedCountPtr: NativePointer | null = null;
let fixCountPtr: NativePointer | null = null;
let lastFixCount = 0;
/** Initialize(args[4]) 传入的玩家队 notes List 句柄（scanNotes 的数据源） */
let notesListHandle: NativePointer = ptr(0);
/** unitIcon 为空的提示只打一次（每场战斗重置） */
let warnedNullIcon = false;

export function gaugeViewOnTop(image: Il2Cpp.Image): void {
  const teamCls = image.tryClass("TSKBattleTeam");
  if (!teamCls) {
    log("[gauge-top] TSKBattleTeam not found");
    return;
  }
  let init: Il2Cpp.Method;
  try {
    init = teamCls.method("Initialize");
  } catch {
    log("[gauge-top] TSKBattleTeam.Initialize not found");
    return;
  }
  if (init.virtualAddress.isNull()) {
    log("[gauge-top] TSKBattleTeam.Initialize is null");
    return;
  }

  // hook 挂载失败时降级为"仅诊断模式"：仍挂 Initialize 扫描，
  // 保证 scan/dump 日志可见（只是没有修正能力）
  armNativeHook(image);

  Interceptor.attach(init.virtualAddress, {
    onEnter(args) {
      // 游戏线程清表：旧战斗对象的句柄出表，防句柄复用误伤；
      // 延迟 scan 重新盯住新战斗的分支根并重填
      clearGuardTable();
      // 只扫玩家队（type==0；x64 栈槽高位不可信，按低 8 位判）：
      // TSKBattleNote.unitIcon 仅玩家侧指向 TSKBattleUnitIcon
      if ((args[5].toInt32() & 0xff) !== 0) return;
      notesListHandle = args[4];
      for (const delay of SCAN_DELAYS) {
        setTimeout(() => scanNotes(`t=${delay / 1000}s`), delay);
      }
    },
  });

  log(
    `[gauge-top] armed: native hook + notes(unitIcon) 直读 scan ${SCAN_DELAYS.map((d) => `${d / 1000}s`).join("/")} after battle init（零 gc.choose、零 stop-the-world）`,
  );
}

/** 挂 CModule native hook：成功返回 true */
function armNativeHook(image: Il2Cpp.Image): boolean {
  try {
    const cgCls =
      image.tryClass("UnityEngine.CanvasGroup") ??
      findClass("UnityEngine.CanvasGroup");
    if (!cgCls) {
      log("[gauge-top] nativeHook: UnityEngine.CanvasGroup not found");
      return false;
    }
    const setAlpha = cgCls.method("set_alpha");
    if (setAlpha.virtualAddress.isNull()) {
      log("[gauge-top] nativeHook: set_alpha 无地址");
      return false;
    }
    // 数据区用 JS 堆（Memory.alloc RW）：CModule 的数据页只读，直接写
    // 其全局变量会 access violation（233839 会话实测），经 symbols 注入 extern
    const table = Memory.alloc(Process.pointerSize * MAX_GUARDED);
    const nativeTable = Memory.alloc(Process.pointerSize * MAX_GUARDED);
    const countPtr = Memory.alloc(4);
    const fixPtr = Memory.alloc(4);
    const origPtr = Memory.alloc(Process.pointerSize);
    countPtr.writeS32(0);
    fixPtr.writeU32(0);
    // 先写原函数地址再 replace：hook 空表时全放行，无副作用
    origPtr.writePointer(setAlpha.virtualAddress);
    cm = new CModule(CM_SOURCE, {
      guarded: table,
      guarded_native: nativeTable,
      guarded_count: countPtr,
      fix_count: fixPtr,
      orig_set_alpha: origPtr,
    });
    guardedTable = table;
    guardedNativeTable = nativeTable;
    guardedCountPtr = countPtr;
    fixCountPtr = fixPtr;
    Interceptor.replace(setAlpha.virtualAddress, cm.set_alpha_hook);
    // 修正计数 5s 读一次内存打日志（纯内存读，不碰 Unity 对象）
    setInterval(() => {
      if (!fixCountPtr) return;
      const n = fixCountPtr.readU32();
      if (n !== lastFixCount) {
        lastFixCount = n;
        log(`[gauge-top] nativeHook: 淡化 0.3 -> 1（第${n}次）`);
      }
    }, 5000);
    log("[gauge-top] nativeHook: CModule 已接管 CanvasGroup.set_alpha");
    return true;
  } catch (e) {
    log(`[gauge-top] nativeHook failed: ${e}`);
    cm = null;
    guardedTable = null;
    guardedNativeTable = null;
    guardedCountPtr = null;
    fixCountPtr = null;
    return false;
  }
}

/** 清空看守表（战斗 Initialize 时调用，防旧句柄复用误伤） */
function clearGuardTable(): void {
  // 新战斗重新扫描：旧 seen 句柄可能被 GC 复用，必须一并清掉
  // （放在守卫检查前：hook 挂载失败的诊断模式下也要重置）
  seenInstances.clear();
  warnedNullIcon = false;
  if (!guardedCountPtr) return;
  guardedList.length = 0;
  alphaGuarded.clear();
  guardedCountPtr.writeS32(0);
}

/** 把句柄写入 C 看守表（append；句柄复用由清表机制兜底） */
function writeGuardSlot(handle: NativePointer): void {
  if (
    !guardedTable ||
    !guardedNativeTable ||
    !guardedCountPtr ||
    guardedList.length >= MAX_GUARDED
  )
    return;
  // m_CachedPtr（x64 偏移 0x10）：该对象的引擎侧 native 指针，
  // C 侧用它做双重校验——句柄被 GC 复用后新对象的该值必然不同
  let nativePtr: NativePointer;
  try {
    nativePtr = handle.add(0x10).readPointer();
  } catch {
    nativePtr = ptr(0); // 读不到则该槽永不通过校验，等效放行
  }
  const index = guardedList.length;
  guardedList.push(handle);
  guardedTable.add(index * Process.pointerSize).writePointer(handle);
  guardedNativeTable.add(index * Process.pointerSize).writePointer(nativePtr);
  guardedCountPtr.writeS32(index + 1);
}

/**
 * UnityEngine.Object 的 native 存活检查：
 * m_CachedPtr 是第一个实例字段（x64 下偏移 0x10），Destroy 后引擎置 0。
 * 只读内存不 invoke，对已销毁对象也安全。
 */
function isNativeAlive(obj: Il2Cpp.Object): boolean {
  try {
    return !obj.handle.add(0x10).readPointer().isNull();
  } catch {
    return true; // 读不到就保守放行
  }
}

/**
 * 从 Initialize 的 notes List 参数直读图标实例：
 * notesList._items[i] -> TSKBattleNote.unitIcon(0x58) -> TSKBattleUnitIcon。
 * 全程字段/数组偏移的纯内存读，替代 Il2Cpp.gc.choose（liveness 计算要
 * stopWorld 暂停全部游戏线程，大堆上几十 ms，三轮全压开场 = 前几回合
 * 卡顿主嫌疑）。invoke 只剩 apply 的父链 walk：新图标才走，看守命中即短路。
 */
function scanNotes(tag: string): void {
  if (notesListHandle.isNull()) return;
  let fresh = 0;
  let dead = 0;
  try {
    const list = new Il2Cpp.Object(notesListHandle);
    const items = list.field("_items")
      .value as Il2Cpp.Array<Il2Cpp.Object> | null;
    const size = list.field("_size").value as number;
    for (let i = 0; items && size && i < size; i++) {
      const note = items.get(i);
      if (!note || note.handle.isNull()) continue;
      const icon = note.field("unitIcon").value as Il2Cpp.Object | null;
      if (!icon || icon.handle.isNull()) {
        if (!warnedNullIcon) {
          warnedNullIcon = true;
          log(
            `[gauge-top] ${tag} note[${i}].unitIcon 为空（图标未挂载，等下一轮）`,
          );
        }
        continue;
      }
      const key = icon.handle.toString();
      if (!isNativeAlive(icon)) {
        if (!seenInstances.has(key)) {
          seenInstances.add(key);
          dead++;
        }
        continue;
      }
      if (seenInstances.has(key)) continue;
      seenInstances.add(key);
      const wantDump = !dumped;
      dumped = true;
      try {
        apply(icon, wantDump, tag);
      } catch (e) {
        log(`[gauge-top] ${tag} error: ${e}`);
      }
      fresh++;
    }
  } catch (e) {
    log(`[gauge-top] ${tag} notes scan failed: ${e}`);
    return;
  }
  if (fresh > 0 || dead > 0) {
    log(`[gauge-top] ${tag} scan: ${fresh} alive new (dead skipped: ${dead})`);
  }
  if (tag === "t=20s" && alphaGuarded.size === 0) {
    log(
      "[gauge-top] 三轮 scan 后看守表仍为空：unitIcon 可能一直未赋值，检查字段名/时序",
    );
  }
}

function findClass(name: string): Il2Cpp.Class | null {
  // Domain 上没有按全名查类的 API，遍历所有程序集查找
  for (const assembly of Il2Cpp.domain.assemblies) {
    try {
      const c = assembly.image.tryClass(name);
      if (c) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** GameObject 上的 CanvasGroup（可能没有），连同 alpha 一起返回 */
function canvasGroupOf(go: Il2Cpp.Object): [Il2Cpp.Object | null, string] {
  const cgCls = findClass("UnityEngine.CanvasGroup");
  if (!cgCls) return [null, "?"];
  const cg = go
    .method("GetComponent")
    .inflate(cgCls)
    .invoke() as Il2Cpp.Object | null;
  if (!cg || cg.handle.isNull()) return [null, ""];
  return [cg, String(cg.method("get_alpha").invoke())];
}

/** 读取名字并剥掉环境附加的双引号 */
function cleanName(obj: Il2Cpp.Object): string {
  try {
    return String(obj.method("get_name").invoke()).replace(/"/g, "");
  } catch {
    return "<err>";
  }
}

function childNames(parent: Il2Cpp.Object): string[] {
  const names: string[] = [];
  let count = 0;
  try {
    count = parent.method("get_childCount").invoke() as number;
  } catch {
    return names;
  }
  for (let i = 0; i < count; i++) {
    // 逐孩子 try：单个已销毁孩子不能拖垮整层枚举
    try {
      const c = parent.method("GetChild").invoke(i) as Il2Cpp.Object;
      names.push(c && !c.handle.isNull() ? cleanName(c) : `<null#${i}>`);
    } catch {
      names.push(`<destroyed#${i}>`);
    }
  }
  return names;
}

/** 把 CanvasGroup 加入 native 看守表（层级不动，只防常态淡化） */
function trackAlphaGuard(cg: Il2Cpp.Object): void {
  const key = cg.handle.toString();
  if (alphaGuarded.has(key)) return;
  alphaGuarded.add(key);
  writeGuardSlot(cg.handle);
  log(
    "[gauge-top] 看守: 已盯住 UnitPlayerIconRoot 的 CanvasGroup（native 表）",
  );
}

/** 递归打印子树里 CanvasGroup.alpha != 1 的节点（定位"半透明"真凶，仅一次性 dump） */
function dumpSubtreeAlpha(t: Il2Cpp.Object, depth: number, tag: string): void {
  if (depth <= 0) return;
  const name = cleanName(t);
  const p = tag ? `${tag}/${name}` : name;
  try {
    const [_, alpha] = canvasGroupOf(
      t.method("get_gameObject").invoke() as Il2Cpp.Object,
    );
    if (alpha && alpha !== "1" && alpha !== "0") {
      log(`[gauge-top] faded: ${p} (CanvasGroup.alpha=${alpha})`);
    }
  } catch {
    /* ignore */
  }
  let count = 0;
  try {
    count = t.method("get_childCount").invoke() as number;
  } catch {
    return;
  }
  for (let i = 0; i < count; i++) {
    try {
      const c = t.method("GetChild").invoke(i) as Il2Cpp.Object;
      if (c && !c.handle.isNull()) dumpSubtreeAlpha(c, depth - 1, p);
    } catch {
      /* skip destroyed child */
    }
  }
}

function apply(self: Il2Cpp.Object, dump: boolean, tag: string): void {
  // 从头像图标向上找 MainRoot/BattleUIRoot 的直接子节点（头像分支根）
  let node = self.method("get_transform").invoke() as Il2Cpp.Object;
  const below: string[] = [cleanName(node)];
  const path: string[] = [cleanName(node)];
  let hit = false;
  for (let i = 0; i < 14; i++) {
    // 分支根已被盯住：本实例与其共享祖先，无需继续向上（减少 invoke 次数）
    if (alphaGuarded.has(node.handle.toString())) {
      hit = true;
      break;
    }
    const parent = node.method("get_parent").invoke() as Il2Cpp.Object | null;
    if (!parent || parent.handle.isNull()) break;
    const pname = cleanName(parent);
    if (pname === "MainRoot" || pname === "BattleUIRoot") {
      hit = true;
      // 盯住头像分支根的 CanvasGroup（层级不动，只防淡化）
      try {
        const bgo = node.method("get_gameObject").invoke() as Il2Cpp.Object;
        const [cg] = canvasGroupOf(bgo);
        if (cg && !cg.handle.isNull()) {
          trackAlphaGuard(cg);
        }
      } catch {
        /* ignore */
      }
      if (dump) {
        log(
          `[gauge-top] "${cleanName(node)}" siblings: [${childNames(parent).join(" | ")}]`,
        );
        // 监测图标是否被重新挂载：父链（图标名归一为 <icon>）变化才打日志
        const chainKey = ["<icon>", ...below.slice(1)].join("/");
        if (chainKey !== lastChainKey && chainLogCount < 6) {
          lastChainKey = chainKey;
          chainLogCount++;
          log(`[gauge-top] ${tag} chain(self->branch): ${chainKey}`);
        }
        // alpha 排查（仅一次性 dump）
        try {
          dumpSubtreeAlpha(node, 4, tag);
        } catch {
          /* ignore */
        }
        // 头像分支顶部结构
        log(
          `[gauge-top] "${cleanName(node)}" children: [${childNames(node).join(" | ")}]`,
        );
        // UnitStatusIconRoot 结构（确认 buff 图标住哪）
        const st = childByName(parent, "UnitStatusIconRoot");
        if (st) {
          log(
            `[gauge-top] UnitStatusIconRoot children: [${childNames(st).join(" | ")}]`,
          );
        } else {
          log("[gauge-top] MainRoot 下没找到 UnitStatusIconRoot");
        }
        // 解剖 UnitIcon0：孩子结构（深度 2）+ specificGaugeView 的位置
        dumpIconInternals(self);
      }
      break;
    }
    node = parent;
    const nname = cleanName(node);
    below.push(nname);
    path.push(nname);
  }
  if (!hit && !warnedNoBranch) {
    warnedNoBranch = true;
    log(
      `[gauge-top] MainRoot/BattleUIRoot not found; path(self->up): ${path.join(" / ")}`,
    );
  }
  if (dump) dumpInfo(self);
}

/** 在 parent 的直接孩子里按剥引号后的名字找 Transform */
function childByName(
  parent: Il2Cpp.Object,
  name: string,
): Il2Cpp.Object | null {
  let count = 0;
  try {
    count = parent.method("get_childCount").invoke() as number;
  } catch {
    return null;
  }
  for (let i = 0; i < count; i++) {
    try {
      const c = parent.method("GetChild").invoke(i) as Il2Cpp.Object;
      if (c && !c.handle.isNull() && cleanName(c) === name) return c;
    } catch {
      /* skip destroyed child */
    }
  }
  return null;
}

/** 解剖第一个 UnitIcon：孩子结构（深度 2）+ specificGaugeView 的父节点/兄弟序号 */
function dumpIconInternals(self: Il2Cpp.Object): void {
  try {
    const t = self.method("get_transform").invoke() as Il2Cpp.Object;
    log(`[gauge-top] UnitIcon0 children: [${childNames(t).join(" | ")}]`);
    let count = 0;
    try {
      count = t.method("get_childCount").invoke() as number;
    } catch {
      return;
    }
    for (let i = 0; i < count; i++) {
      try {
        const c = t.method("GetChild").invoke(i) as Il2Cpp.Object;
        if (c && !c.handle.isNull()) {
          log(
            `[gauge-top]   UnitIcon0/${cleanName(c)}: [${childNames(c).join(" | ")}]`,
          );
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    log(`[gauge-top] internals dump error: ${e}`);
  }
  // specificGaugeView 挂在哪、排在第几个（用户最初要清晰化的就是它）
  try {
    const gauge = self.field("specificGaugeView").value as Il2Cpp.Object;
    if (gauge && !gauge.handle.isNull()) {
      const gt = gauge.method("get_transform").invoke() as Il2Cpp.Object;
      const idx = gt.method("GetSiblingIndex").invoke() as number;
      const p = gt.method("get_parent").invoke() as Il2Cpp.Object;
      log(
        `[gauge-top] specificGaugeView: parent="${cleanName(p)}" siblingIndex=${idx} siblings: [${childNames(p).join(" | ")}]`,
      );
    } else {
      log("[gauge-top] specificGaugeView is null");
    }
  } catch (e) {
    log(`[gauge-top] specificGaugeView dump error: ${e}`);
  }
  // noteData 的 GameObject 探测：buff 图标若在 Note 子树（不在 UnitIcon 子树），
  // 下一步就得抬 Note 而不是 Icon。TSKBattleNote 不是 Component 时会抛，也能说明问题。
  try {
    const note = self.field("noteData").value as Il2Cpp.Object;
    if (note && !note.handle.isNull()) {
      const ngo = note.method("get_gameObject").invoke() as Il2Cpp.Object;
      if (ngo && !ngo.handle.isNull()) {
        const nt = ngo.method("get_transform").invoke() as Il2Cpp.Object;
        log(
          `[gauge-top] noteData gameObject: "${cleanName(ngo)}" children: [${childNames(nt).join(" | ")}]`,
        );
      }
    }
  } catch (e) {
    log(`[gauge-top] noteData probe: ${e}（可能不是 Component）`);
  }
}

/** 第一个实例的完整诊断（只打一次） */
function dumpInfo(self: Il2Cpp.Object): void {
  try {
    const chain: string[] = [];
    let c: Il2Cpp.Class | null = self.class;
    while (c) {
      chain.push(c.name);
      c = c.parent;
    }
    log("[gauge-top] class chain:", chain.join(" <- "));

    for (const f of self.class.fields) {
      log(`[gauge-top]   field ${f.name}: ${f.type.name}`);
    }

    const go = self.method("get_gameObject").invoke() as Il2Cpp.Object;
    log("[gauge-top] gameObject:", cleanName(go));

    // 父链：名字 + 每级 CanvasGroup alpha（排查 alpha 淡化）
    const parts: string[] = [];
    let t = go.method("get_transform").invoke() as Il2Cpp.Object;
    for (let i = 0; i < 14; i++) {
      let name = cleanName(t);
      const [_, alpha] = canvasGroupOf(
        t.method("get_gameObject").invoke() as Il2Cpp.Object,
      );
      if (alpha) name += ` (CanvasGroup.alpha=${alpha})`;
      parts.push(name);
      const p = t.method("get_parent").invoke() as Il2Cpp.Object | null;
      if (!p || p.handle.isNull()) break;
      t = p;
    }
    log("[gauge-top] hierarchy(self->root):", parts.join(" / "));
  } catch (e) {
    log(`[gauge-top] dump error: ${e}`);
  }
}
