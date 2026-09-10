import { skillMap } from "./common";

// ===== 宿主通信：向外部 control.py 宿主推送事件 =====
type HostMessageType = "log" | "modList" | "unitList" | "buffData";

function sendHost(type: HostMessageType, payload: any) {
  try {
    // Frida runtime 下全局 `send` 可用
    (globalThis as any).send({ type, payload });
  } catch (_) {
    // 非宿主模式（比如直接 frida -l）忽略推送，不影响本地输出
  }
}

function formatArgs(args: any[]): string {
  return args
    .map((x) => {
      if (
        typeof x === "object" &&
        x !== null &&
        !(x instanceof Il2Cpp.Object)
      ) {
        try {
          return JSON.stringify(x);
        } catch {
          return String(x);
        }
      }
      return String(x);
    })
    .join(" ");
}

function log(...args: any[]) {
  const now = new Date();
  const time =
    `${now.getHours().toString().padStart(2, "0")}:` +
    `${now.getMinutes().toString().padStart(2, "0")}:` +
    `${now.getSeconds().toString().padStart(2, "0")}.` +
    `${now.getMilliseconds().toString().padStart(3, "0")}`;

  const message = formatArgs(args);
  console.log(`[${time}]`, ...args);
  sendHost("log", { time, message });
}

// ===== 全局诊断日志开关（宿主 setDebug 消息控制，默认关）=====
// 所有 mod 共用：细粒度排查日志一律走 logDebug，开关关时零输出。
let debugLogEnabled = false;

/** 宿主翻转全局诊断开关（index.ts 的 setDebug 消息调用） */
function setDebugLog(on: boolean): void {
  debugLogEnabled = !!on;
}

/** 诊断日志当前是否开启（需要按开关决定装/拆探针等重行为时用） */
function isDebugLog(): boolean {
  return debugLogEnabled;
}

/**
 * 诊断日志：仅全局开关开启时输出。自动带统一前缀 [debug]，
 * 宿主面板据此打特殊颜色；调用方消息里不用再写 [debug]。
 */
function logDebug(...args: any[]) {
  if (debugLogEnabled) log("[debug]", ...args);
}

function dumpArray(ptr: NativePointer): string {
  if (ptr.isNull()) {
    return "null";
  }

  const arr = new Il2Cpp.Array(ptr);

  const result: string[] = [];

  const count = Math.min(arr.length, 10); // 最多打印10个

  for (let i = 0; i < count; i++) {
    result.push(String(arr.get(i)));
  }

  if (arr.length > count) {
    result.push("...");
  }

  return `[${result.join(", ")}] (len=${arr.length})`;
}

function dumpArgs(method: Il2Cpp.Method, args: InvocationArguments) {
  // 实例方法 args[0] 是 this
  let index = method.isStatic ? 0 : 1;
  log(
    `dumpArgs: method=${method.name}, isStatic=${method.isStatic}, method.parameterCount=${method.parameterCount}`,
  );
  for (const p of method.parameters) {
    const arg = args[index++];
    const type = p.type.name;
    let value: unknown;
    if (type.endsWith("[]")) {
      value = dumpArray(arg);
    } else {
      switch (type) {
        case "System.Boolean":
          value = arg.toInt32() != 0;
          break;
        case "System.Int32":
          value = arg.toInt32();
          break;
        case "System.Int64":
          value = parseInt(arg.toString(), 16); // 先输出十六进制
          break;
        case "System.Single":
          value = intBitsToFloat(arg.toString());
          break;
        default:
          value = arg.toString();
      }
    }
    log(`args[${index - 1}] ${p.name} (${type}) = ${value}`);
  }
}

function parseArgument(arg: NativePointer, typeName: string): unknown {
  switch (typeName) {
    case "float":
      return intBitsToFloat(arg.toString());
    case "enum":
      return arg.toInt32();
    case "int":
      return arg.toInt32();
    default:
      return arg.toString();
  }
}

function intBitsToFloat(hex: string): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);

  view.setUint32(0, parseInt(hex, 16), true);

  return view.getFloat32(0, true);
}

function getNameByTSKBattleNote(note: Il2Cpp.Object): string {
  // note: TSKBattleNote
  const unitData = note.field("<UnitData>k__BackingField")
    .value as Il2Cpp.Object; // TSKBattleUnit
  const name_0 = unitData.field("<UnitName>k__BackingField").value;
  const name_1 = unitData.field("<CharacterName>k__BackingField").value;
  return `[${name_0}] ${name_1}`;
}

function dumpObject(obj: Il2Cpp.Object) {
  log(`\n===== ${obj.class.name} =====`);

  for (const field of obj.class.fields) {
    try {
      const value = obj.field(field.name).value;
      log(`${field.name} = ${value}`);
    } catch (e) {
      log(`${field.name} = <error>`);
    }
  }
}

function saveJson(fileName: string, data: any[]) {
  const FridaFile = (globalThis as any).File;

  const file = new FridaFile(fileName, "w");

  file.write(JSON.stringify(data, null, 2));

  file.close();
}

function convertValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  // System.String
  if (value instanceof Il2Cpp.String) {
    return value.content;
  }

  // Il2Cpp.Array
  if (value instanceof Il2Cpp.Array) {
    const result = [];

    for (let i = 0; i < value.length; i++) {
      result.push(convertValue(value.get(i)));
    }

    return result;
  }

  // 其他 Il2Cpp.Object
  if (value instanceof Il2Cpp.Object) {
    return value.class.type.name;
  }

  return value;
}

/**
 * 递归展平 Il2Cpp.Object 为纯 JSON 结构。
 * - 带 maxDepth 防止无限递归（默认 2 层）
 * - 用 handle 地址做循环引用检测
 * - 每个字段读取都有 try/catch，单字段失败不会炸整个 dump
 *
 * 用于 UnitListDump 等导出场景，不用于常规运行时 hook。
 */
function dumpIl2CppObject(
  value: any,
  maxDepth = 2,
  visited: Set<string> = new Set(),
): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Il2Cpp.String) {
    return value.content;
  }

  if (value instanceof Il2Cpp.Array) {
    const arr: any[] = [];
    for (let i = 0; i < value.length; i++) {
      try {
        arr.push(dumpIl2CppObject(value.get(i), maxDepth, visited));
      } catch (e) {
        arr.push(`<error>: ${e}`);
      }
    }
    return arr;
  }

  if (value instanceof Il2Cpp.Object) {
    const handleKey = value.handle.toString();
    if (visited.has(handleKey)) {
      return "<circular>";
    }
    if (maxDepth <= 0) {
      return value.class.type.name;
    }
    visited.add(handleKey);
    const result: Record<string, any> = {};
    result["class_name"] = value.class.type.name;
    for (const field of value.class.fields) {
      try {
        const fv = value.field(field.name).value;
        result[field.name] = dumpIl2CppObject(fv, maxDepth - 1, visited);
      } catch (e) {
        result[field.name] = `<error>: ${e}`;
      }
    }
    visited.delete(handleKey);
    return result;
  }

  // number / boolean / 基本类型
  return value;
}

function getAutoUseSkillIndex(unitName: string, characterName: string): number {
  const name = `[${unitName}] ${characterName}`;
  return skillMap.get(name) ?? skillMap.get(unitName) ?? -1;
}

// hookMethodReturn 的详细日志开关
let debug = false;

/**
 * 替换 method.implementation，用 NativeFunction 调用原实现并拦截返回值。
 * verbose: 可选的详细日志开关（配合 debug 使用）
 */
function hookMethodReturn(
  method: Il2Cpp.Method,
  returnType: NativeFunctionReturnType,
  argTypes: NativeFunctionArgumentType[],
  handler?: (ret: any, args: any[]) => any,
  verbose?: () => boolean,
) {
  if (!method) {
    log("[hookMethodReturn] method is undefined");
    return;
  }
  const original = new NativeFunction(
    method.virtualAddress,
    returnType,
    argTypes,
  ) as any;
  const isStatic = method.isStatic;
  // args 中不含this
  method.implementation = function (...args: any[]) {
    const expectedArgsNum = isStatic ? argTypes.length : argTypes.length - 1;
    debug &&
      verbose?.() &&
      log(
        `${method.name} args:`,
        args.map((x) => typeof x + ":" + x),
      );
    if (expectedArgsNum !== args.length) {
      log(
        `[${method.name}] arg count mismatch: expected ${expectedArgsNum}, got ${args.length}, fallback`,
      );
      // 走原 bridge implementation
      return method.invoke(...args);
    }
    const nativeArgs = args.map(convertArg);
    debug &&
      verbose?.() &&
      log(
        `${method.name} nativeArgs:`,
        nativeArgs.map((x) => `${typeof x}:${x}`),
      );
    var ret: any;
    try {
      if (method.isStatic) {
        ret = original(...nativeArgs);
      } else {
        ret = original(this.handle, ...nativeArgs);
      }
    } catch (e) {
      // convertArg 转换失败或参数类型不匹配时，回退到 bridge 原生调用
      log(`[${method.name}] original() call failed: ${e}, fallback to invoke`);
      return method.invoke(...args) as any;
    }

    const result = handler?.(ret, nativeArgs);

    return (result ?? ret) as any;
  };
}

function convertArg(arg: any): any {
  // bool
  if (typeof arg === "boolean") {
    return arg ? 1 : 0;
  }
  // Il2Cpp.Object
  if (arg instanceof Il2Cpp.Object) {
    return arg.handle;
  }

  // ValueType (enum / struct)
  if (arg instanceof Il2Cpp.ValueType) {
    return arg.handle.readS32();
  }

  // frida-il2cpp-bridge Int64 / UInt64
  if (
    arg?.constructor?.name === "Int64" ||
    arg?.constructor?.name === "UInt64"
  ) {
    return BigInt(arg.toString());
  }

  return arg;
}

export {
  log,
  logDebug,
  setDebugLog,
  isDebugLog,
  dumpArgs,
  parseArgument,
  getNameByTSKBattleNote,
  dumpObject,
  saveJson,
  convertValue,
  dumpIl2CppObject,
  getAutoUseSkillIndex,
  hookMethodReturn,
  convertArg,
  sendHost,
};
