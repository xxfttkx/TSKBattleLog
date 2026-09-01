/**
 * IL2CPP 全量方法地址索引构建 + 地址反解。
 *
 * 用途：把 Thread.backtrace 得到的 return address（或任意代码地址）
 *       还原成 "Namespace.Class.Method+0xOffset" 的可读形式，用于分析调用来源。
 *
 * 用法：在需要用到 resolveMethod / printCaller 的 mod.onLoad 里先调
 *       buildMethodIndex() 构建索引，之后就能自由调用。
 *
 * 不建议在注入初期无条件构建：IL2CPP 游戏 method 数量可达数万，
 * 全量排序有几百毫秒~秒级启动开销。只在需要的调试场景启用即可。
 */

import { log } from "../utils";

type MethodInfo = {
  start: NativePointer;
  method: Il2Cpp.Method;
};

let methods: MethodInfo[] = [];
let built = false;

export function isMethodIndexBuilt(): boolean {
  return built;
}

export function buildMethodIndex(): void {
  if (built) return;

  const collected: MethodInfo[] = [];
  for (const asm of Il2Cpp.domain.assemblies) {
    for (const cls of asm.image.classes) {
      for (const method of cls.methods) {
        if (method.virtualAddress.isNull()) continue;
        collected.push({
          start: method.virtualAddress,
          method,
        });
      }
    }
  }

  collected.sort((a, b) => {
    const c = a.start.compare(b.start);
    if (c < 0) return -1;
    if (c > 0) return 1;
    return 0;
  });

  methods = collected;
  built = true;
  log(`[debug] indexed ${methods.length} IL2CPP methods (addr->name resolver ready)`);
}

/** 将任意地址反解为最近的 IL2CPP 方法 + 偏移。找不到则返回原地址字符串。 */
export function resolveMethod(addr: NativePointer): string {
  if (!built) return addr.toString();

  let last: MethodInfo | null = null;
  for (const m of methods) {
    if (m.start.compare(addr) > 0) break;
    last = m;
  }

  if (last == null) return addr.toString();

  const offset = addr.sub(last.start);
  const cls = last.method.class;
  return `${cls.namespace ? cls.namespace + "." : ""}${cls.name}.${last.method.name}+${offset}`;
}

/** 打印基于 CpuContext 的调用栈（跳过第 0 帧 = 自身）。 */
export function printCaller(context: CpuContext, depth = 5): void {
  if (!built) {
    log("[debug] printCaller: MethodResolver index not built yet, skipped");
    return;
  }
  const frames = Thread.backtrace(context, Backtracer.ACCURATE);
  const end = Math.min(frames.length, depth + 1);
  for (let i = 1; i < end; i++) {
    log(`${"  ".repeat(i - 1)}\u2514\u2500 ${resolveMethod(frames[i])}`);
  }
}
