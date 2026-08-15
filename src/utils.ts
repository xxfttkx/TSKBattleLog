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

export { log, dumpArgs, parseArgument, getNameByTSKBattleNote };
