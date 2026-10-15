import {
  log,
  dumpArgs,
  sendHost,
  readFloatReturn,
  readDoubleReturn,
} from "./utils";

export type MethodEnterHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments,
  /** Interceptor 的 CpuContext，可用于 Thread.backtrace（BacktraceMod 使用） */
  context: CpuContext,
  /** Interceptor 的 InvocationContext，可在 onEnter/onLeave 间暂存字段 */
  invocation: InvocationContext,
) => void;

export type MethodLeaveHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  retval: InvocationReturnValue,
  /** Interceptor 的 InvocationContext，可读取 onEnter 阶段暂存的字段 */
  invocation: InvocationContext,
  /** Interceptor 的 CpuContext；x86/x64 下浮点返回值在 context.xmm0（readFloatReturn/readDoubleReturn） */
  context: CpuContext,
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
  /**
   * 可选：宿主「诊断日志」全局开关翻转时回调（setDebug 消息广播给所有 mod）。
   * onLoad 前后均可能调用；需要装/拆重型探针的 mod 据此响应。
   * 普通细粒度日志直接用 utils 的 logDebug（自带全局门控），无需实现本方法。
   */
  applyDebugConfig?(on: boolean): void;
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
  /** quiet=true 时不打印注册/进入/返回日志（用于多个 mod trace 同一函数时避免重复） */
  quiet = false,
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

  log(`Trace${quiet && "(quiet)"}:`, cls.name, method.name);

  // 进入日志也可被 mod 开关抑制
  const logEnter = `enter ${cls.name}.${method.name}`;
  // 返回日志按 IL2CPP 返回类型取真实值并标注类型：float/double 经 XMM0 返回，
  // retval（RAX）对它们是垃圾；类型由 il2cpp-bridge 元数据给出，无需手动 dump 签名
  const returnTypeName = method.returnType.name;
  const isFloatRet = returnTypeName === "System.Single";
  const isDoubleRet = returnTypeName === "System.Double";
  const isVoidRet = returnTypeName === "System.Void";
  const isInt32Ret = returnTypeName === "System.Int32";
  const isBoolRet = returnTypeName === "System.Boolean";
  const logReturn = (retval: any, ctx: CpuContext | undefined) => {
    // void 的 retval 只是 RAX 残留值，无意义，不打印
    if (isVoidRet) {
      return `${method.name} return(System.Void)\n`;
    }
    if (isFloatRet && ctx) {
      return `${method.name} return(${returnTypeName}): ${readFloatReturn(ctx)}\n`;
    }
    if (isDoubleRet && ctx) {
      return `${method.name} return(${returnTypeName}): ${readDoubleReturn(ctx)}\n`;
    }
    // Int32 按有符号十进制显示（retval.toString() 是无符号 hex，0xffffffff 实为 -1）；
    // bool 按低 8 位解码（Windows x64 高位可能是残留垃圾）
    if (isInt32Ret) {
      return `${method.name} return(${returnTypeName}): ${retval.toInt32()}\n`;
    }
    if (isBoolRet) {
      return `${method.name} return(${returnTypeName}): ${
        (retval.toInt32() & 0xff) !== 0
      }\n`;
    }
    return `${method.name} return(${returnTypeName}): ${retval}\n`;
  };

  // 按需挂载回调：onLeave 会迫使 Gum 额外拦截函数返回路径（改写返回地址 +
  // 保存/恢复调用上下文），纯 onEnter 探针不应承担这份开销；
  // enter/return 日志分别在 onEnter/onLeave 里输出，故 !quiet 时两个都得挂。
  const needEnter = onEnter !== undefined || !quiet;
  const needLeave = onLeave !== undefined || !quiet;
  if (!needEnter && !needLeave) {
    return undefined; // 无回调且 quiet，没有安装钩子的意义
  }

  // guarded 包装闭包提升到 attach 外，避免每次调用重新分配
  const enterHandler = onEnter
    ? mod
      ? guarded(mod, onEnter)
      : onEnter
    : undefined;
  const leaveHandler = onLeave
    ? mod
      ? guarded(mod, onLeave)
      : onLeave
    : undefined;
  // onLeave 里需要 ctx 的两种情况：有 leaveHandler，或返回值是 float/double（读 XMM0）
  const needCtx = leaveHandler !== undefined || isFloatRet || isDoubleRet;

  return Interceptor.attach(method.virtualAddress, {
    ...(needEnter
      ? {
          onEnter(args) {
            if (!quiet && (mod === undefined || mod.enabled)) {
              log(logEnter);
            }
            if (enterHandler) {
              // InvocationContext 可能直接是 CpuContext 或持有 .context 字段，两者兜底
              const self = this as any;
              const ctx: CpuContext = self.context ?? self;
              enterHandler(cls, method, args, ctx, self as InvocationContext);
            }
          },
        }
      : {}),
    ...(needLeave
      ? {
          onLeave(retval) {
            const self = this as any;
            const ctx = needCtx ? (self.context ?? self) : undefined;
            if (leaveHandler) {
              leaveHandler(
                cls,
                method,
                retval,
                self as InvocationContext,
                ctx as CpuContext,
              );
            }
            if (!quiet && (mod === undefined || mod.enabled)) {
              log(logReturn(retval, ctx));
            }
          },
        }
      : {}),
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
