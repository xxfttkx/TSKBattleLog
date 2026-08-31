import { log, dumpArgs } from "./utils";

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
  /** 对应 mods.json 中的开关键名 */
  name: string;
  onLoad(image: Il2Cpp.Image): void;
}

// dumpArgs 类方法的统一处理器
export const dumpArgsHandler: MethodEnterHandler = (_cls, method, args) =>
  dumpArgs(method, args);

export function traceMethodByName(
  image: Il2Cpp.Image,
  className: string,
  methodName: string,
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

  Interceptor.attach(method.virtualAddress, {
    onEnter(args) {
      log(`enter ${cls.name}.${method.name}`);
      onEnter?.(cls, method, args);
    },
    onLeave(retval) {
      onLeave?.(cls, method, retval);
      log(`${method.name} return: ${retval}\n`);
    },
  });
}
