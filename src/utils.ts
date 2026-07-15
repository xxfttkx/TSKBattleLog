function log(...args: any[]) {
  const now = new Date();
  const time =
    `${now.getHours().toString().padStart(2, "0")}:` +
    `${now.getMinutes().toString().padStart(2, "0")}:` +
    `${now.getSeconds().toString().padStart(2, "0")}`;

  console.log(`[${time}]`, ...args);
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
    `dumpArgs: method=${method.name}, isStatic=${method.isStatic}, method.parameterCount=${method.parameterCount}`
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

        case "System.Int64":
          value = parseInt(arg.toString(), 16); // 先输出十六进制
          break;

        default:
          value = arg.toString();
      }
    }
    log(`args[${index - 1}] ${p.name} (${type}) = ${value}`);
  }
}

export { log, dumpArgs };
