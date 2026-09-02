import { log } from "../utils";
import { TraceListener } from "../mod";
import {
  buildMethodIndex,
  isMethodIndexBuilt,
  printCaller,
} from "./MethodResolver";

export interface FieldWatchConfig {
  className: string;
  fieldName: string;
  /** API 获取偏移失败时的回退值 */
  fallbackOffset?: number;
  /** 调用栈深度，默认 8 */
  backtraceDepth?: number;
  /** 日志前缀，默认 [field-watch] */
  tag?: string;
}

/**
 * 监控指定类的某个 int 字段在哪个方法里被修改。
 *
 * 原理：hook 该类所有实例方法，onEnter 读旧值、onLeave 读新值，
 * 变化则打印方法名 + onEnter 时刻的调用栈。
 *
 * @returns 已注册的 listener 列表（调用方可持有，需要时 detach）
 */
export function watchField(
  image: Il2Cpp.Image,
  config: FieldWatchConfig,
): TraceListener[] {
  const {
    className,
    fieldName,
    fallbackOffset,
    backtraceDepth = 8,
    tag = "[field-watch]",
  } = config;

  const cls = image.class(className);
  if (!cls) {
    log(`${tag} Class ${className} not found`);
    return [];
  }

  // 优先用 frida-il2cpp-bridge 获取字段偏移
  let offset: number;
  try {
    const field = cls.field(fieldName);
    offset = field.offset;
    log(`${tag} ${className}.${fieldName} offset = 0x${offset.toString(16)}`);
  } catch {
    if (fallbackOffset === undefined) {
      log(`${tag} field "${fieldName}" not found and no fallback offset provided, abort`);
      return [];
    }
    offset = fallbackOffset;
    log(
      `${tag} field "${fieldName}" not found via API, fallback to 0x${offset.toString(16)}`,
    );
  }

  const listeners: TraceListener[] = [];

  for (const method of cls.methods) {
    if (method.isStatic) continue;
    if (method.virtualAddress.isNull()) continue;

    const methodName = method.name;

    let listener: TraceListener;
    try {
      listener = Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          (this as any)._instance = args[0];
          (this as any)._oldVal = args[0].add(offset).readS32();
          (this as any)._enterCtx = this.context;
        },
        onLeave(_retval) {
          const instance = (this as any)._instance as NativePointer;
          const oldVal = (this as any)._oldVal as number;
          if (!instance || oldVal === undefined) return;
          const newVal = instance.add(offset).readS32();
          if (newVal !== oldVal) {
            log(
              `${tag} ${methodName} changed ${fieldName}: ${oldVal} -> ${newVal}`,
            );
            if (!isMethodIndexBuilt()) buildMethodIndex();
            printCaller(
              (this as any)._enterCtx as CpuContext,
              backtraceDepth,
            );
          }
        },
      });
    } catch (e) {
      log(`${tag} skip ${methodName}: ${e}`);
      continue;
    }
    listeners.push(listener);
  }

  log(`${tag} hooked ${listeners.length} instance methods of ${className}`);
  return listeners;
}
