import { skillMap } from "./common";

// ===== 宿主通信：向外部 control.py 宿主推送事件 =====
type HostMessageType = "log" | "modList" | "modState";

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

function dumpArray(ptr: NativePointer, type: string): string {
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
      value = dumpArray(arg, type);
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

function saveFile(fileName: string, content: string) {
  const FridaFile = (globalThis as any).File;

  const file = new FridaFile(fileName, "w");

  file.write(content);

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
    if (method.isStatic) {
      ret = original(...nativeArgs);
    } else {
      ret = original(this.handle, ...nativeArgs);
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
  dumpArgs,
  parseArgument,
  getNameByTSKBattleNote,
  dumpObject,
  saveJson,
  convertValue,
  getAutoUseSkillIndex,
  hookMethodReturn,
  convertArg,
  sendHost,
};
