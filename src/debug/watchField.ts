import { log } from "../utils";
import { Mod, TraceListener } from "../mod";
import {
  buildMethodIndex,
  isMethodIndexBuilt,
  printCaller,
} from "./MethodResolver";

export interface FieldTarget {
  /** IL2CPP 元数据里的字段真名（自动属性是 <Xxx>k__BackingField） */
  fieldName: string;
  /** API 获取偏移失败时的回退值 */
  fallbackOffset?: number;
  /** 该字段的日志前缀，缺省用外层 tag */
  tag?: string;
}

export interface FieldWatchConfig {
  className: string;
  /** 同一类的多个字段：类方法只 hook 一次，回调里逐个对比 */
  fields: FieldTarget[];
  /** 调用栈深度，默认 8 */
  backtraceDepth?: number;
  /** 日志前缀，默认 [field-watch] */
  tag?: string;
}

interface ResolvedField {
  fieldName: string;
  offset: number;
  isFloat: boolean;
  tag: string;
}

/**
 * 监控指定类的一个/多个 int|float 字段在哪些方法里被修改。
 *
 * 原理：hook 该类所有实例方法（每个方法只 hook 一次），onEnter 读各字段旧值、
 * onLeave 读新值，任一变化就打印方法名 + 字段旧新值 + onEnter 时刻调用栈。
 * 字段类型自动从 IL2CPP 元数据推断（System.Int32 / System.Single）。
 *
 * @returns 已注册的 listener 列表（调用方可持有，需要时 detach）
 */
export function watchField(
  image: Il2Cpp.Image,
  config: FieldWatchConfig,
  mod?: Mod,
): TraceListener[] {
  const {
    className,
    fields,
    backtraceDepth = 8,
    tag = "[field-watch]",
  } = config;

  const cls = image.class(className);
  if (!cls) {
    log(`${tag} Class ${className} not found`);
    return [];
  }

  // 解析每个字段的偏移和类型
  const resolved: ResolvedField[] = [];
  for (const target of fields) {
    let offset: number;
    let isFloat = false;
    try {
      const field = cls.field(target.fieldName);
      offset = field.offset;
      isFloat = field.type.name === "System.Single";
      log(
        `${target.tag ?? tag} ${className}.${target.fieldName} offset = 0x${offset.toString(
          16,
        )} (${field.type.name})`,
      );
    } catch {
      if (target.fallbackOffset === undefined) {
        log(
          `${target.tag ?? tag} field "${target.fieldName}" not found and no fallback offset, skip`,
        );
        continue;
      }
      offset = target.fallbackOffset;
      log(
        `${target.tag ?? tag} field "${target.fieldName}" not found via API, fallback to 0x${offset.toString(
          16,
        )}`,
      );
    }
    resolved.push({
      fieldName: target.fieldName,
      offset,
      isFloat,
      tag: target.tag ?? tag,
    });
  }

  if (resolved.length === 0) return [];

  const readField = (instance: NativePointer, f: ResolvedField): number =>
    f.isFloat
      ? instance.add(f.offset).readFloat()
      : instance.add(f.offset).readS32();

  const listeners: TraceListener[] = [];

  for (const method of cls.methods) {
    if (method.isStatic) continue;
    if (method.virtualAddress.isNull()) continue;

    const methodName = method.name;

    let listener: TraceListener;
    try {
      listener = Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          const instance = args[0];
          const olds: Record<string, number> = {};
          for (const f of resolved) {
            olds[f.fieldName] = readField(instance, f);
          }
          (this as any)._instance = instance;
          (this as any)._olds = olds;
          (this as any)._enterCtx = this.context;
        },
        onLeave(_retval) {
          if (mod && !mod.enabled) return;
          const instance = (this as any)._instance as NativePointer;
          const olds = (this as any)._olds as Record<string, number>;
          if (!instance || !olds) return;

          let changed = false;
          for (const f of resolved) {
            const newVal = readField(instance, f);
            if (newVal !== olds[f.fieldName]) {
              changed = true;
              log(
                `${f.tag} ${methodName} changed ${f.fieldName}: ${olds[f.fieldName]} -> ${newVal}`,
              );
            }
          }
          if (changed) {
            if (!isMethodIndexBuilt()) buildMethodIndex();
            printCaller((this as any)._enterCtx as CpuContext, backtraceDepth);
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
