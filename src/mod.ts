import { log, dumpArgs, sendHost } from "./utils";

export type MethodEnterHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments,
  /** Interceptor 的 CpuContext，可用于 Thread.backtrace（BacktraceMod 使用） */
  context: CpuContext,
) => void;

export type MethodLeaveHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  retval: InvocationReturnValue,
) => void;

export interface Mod {
  /** 对应 mods.json / 宿主开关中的键名 */
  name: string;
  /** 人类可读描述，显示在悬浮窗中 */
  description?: string;
  /** 悬浮窗中 mod 分类（观察型 / 修改型 / 调试工具） */
  category?: "观察" | "修改" | "调试";
  /** 运行时开关：初始化后由宿主或 mods.json 控制 */
  enabled: boolean;
  onLoad(image: Il2Cpp.Image): void;
}

// dumpArgs 类方法的统一处理器
export const dumpArgsHandler: MethodEnterHandler = (_cls, method, args) =>
  dumpArgs(method, args);

/**
 * 在 handler 外层包一层开关检查：当 mod.enabled 为 false 时，直接跳过执行。
 * 这样无需卸载 Interceptor，就能做到运行时停/启用 mod 逻辑。
 */
export function guarded<T extends (...args: any[]) => void>(
  mod: Mod,
  handler: T,
): T {
  return ((...args: any[]) => {
    if (!mod.enabled) return;
    handler(...args);
  }) as T;
}

/** Interceptor.attach 的返回值，调用 .detach() 可单独摘除某个 hook */
export type TraceListener = ReturnType<typeof Interceptor.attach>;

export function traceMethodByName(
  image: Il2Cpp.Image,
  className: string,
  methodName: string,
  mod?: Mod,
  onEnter?: MethodEnterHandler,
  onLeave?: MethodLeaveHandler,
): TraceListener | undefined {
  const cls = image.class(className);
  if (!cls) {
    log(`Class ${className} not found`);
    return undefined;
  }
  const method = cls.method(methodName);
  if (!method) {
    log(`Method ${methodName} not found in class ${className}`);
    return undefined;
  }
  if (method.virtualAddress.isNull()) {
    return undefined;
  }

  log("Trace:", cls.name, method.name);

  // 进入日志也可被 mod 开关抑制
  const logEnter = `enter ${cls.name}.${method.name}`;
  const logReturn = (retval: any) => `${method.name} return: ${retval}\n`;

  return Interceptor.attach(method.virtualAddress, {
    onEnter(args) {
      if (mod === undefined || mod.enabled) {
        log(logEnter);
      }
      if (onEnter) {
        // InvocationContext 可能直接是 CpuContext 或持有 .context 字段，两者兜底
        const self = this as any;
        const ctx: CpuContext = self.context ?? self;
        const guardedEnter = mod ? guarded(mod, onEnter) : onEnter;
        guardedEnter(cls, method, args, ctx);
      }
    },
    onLeave(retval) {
      if (onLeave) {
        const guardedLeave = mod ? guarded(mod, onLeave) : onLeave;
        guardedLeave(cls, method, retval);
      }
      if (mod === undefined || mod.enabled) {
        log(logReturn(retval));
      }
    },
  });
}

/** 上报当前 mod 列表给宿主 */
export function publishModList(mods: Mod[]) {
  sendHost("modList", {
    mods: mods.map((m) => ({
      name: m.name,
      description: m.description ?? "",
      category: m.category ?? "观察",
      enabled: m.enabled,
    })),
  });
}

/** 宿主侧开关变更时推送一条状态确认消息 */
export function publishModState(name: string, enabled: boolean) {
  sendHost("modState", { name, enabled });
}
