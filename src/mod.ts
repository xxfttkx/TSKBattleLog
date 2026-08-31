import { log, dumpArgs, sendHost } from "./utils";

export type MethodEnterHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments,
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

export function traceMethodByName(
  image: Il2Cpp.Image,
  className: string,
  methodName: string,
  mod?: Mod,
  onEnter?: MethodEnterHandler,
  onLeave?: MethodLeaveHandler,
) {
  const cls = image.class(className);
  if (!cls) {
    log(`Class ${className} not found`);
    return;
  }
  const method = cls.method(methodName);
  if (!method) {
    log(`Method ${methodName} not found in class ${className}`);
    return;
  }
  if (method.virtualAddress.isNull()) {
    return;
  }

  log("Trace:", cls.name, method.name);

  // 进入日志也可被 mod 开关抑制
  const logEnter = `enter ${cls.name}.${method.name}`;
  const logReturn = (retval: any) => `${method.name} return: ${retval}\n`;

  Interceptor.attach(method.virtualAddress, {
    onEnter(args) {
      if (mod === undefined || mod.enabled) {
        log(logEnter);
      }
      if (onEnter) {
        const guardedEnter = mod ? guarded(mod, onEnter) : onEnter;
        guardedEnter(cls, method, args);
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
