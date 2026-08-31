import "frida-il2cpp-bridge";
import {
  skillMap,
  AttackType,
  TeamType,
  AbilityCompatibility,
  SkillType,
  Timing,
  BattleMode,
} from "./common";
import {
  log,
  dumpArgs,
  parseArgument,
  getNameByTSKBattleNote,
  dumpObject,
  saveJson,
  convertValue,
  getAutoUseSkillIndex,
} from "./utils";
import { TSKBattleLog } from "./TSKBattleLog";

const tskBattleLog = new TSKBattleLog();
var enter_CaluculationNormalDamage = false;
var debug = false;

function onLeaveMethod(
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  retval: InvocationReturnValue,
) {
  if (method.name == "CaluculationNormalDamage") {
    enter_CaluculationNormalDamage = false;
  }
  if (method.name == "GetUnitListRepository") {
    log("GetUnitListRepository returnType:", method.returnType.name);
    log(`GetUnitListRepository return: ${retval}`);

    const result = retval.add(8).readPointer();

    log("UniTask.result =", result);
    if (result.isNull()) {
      log("UniTask.result is null, skip");
      return;
    }
    // try {
    //   const obj = new Il2Cpp.Object(retval);
    //   log("retval class:", obj.class.name);
    // } catch (e) {
    //   log("retval is not Il2Cpp.Object:", e);
    // }
    const TeamUnitListRepository = new Il2Cpp.Object(result);
    // dumpObject(TeamUnitListRepository);
    const TeamUnitListEntity = TeamUnitListRepository.field("result")
      .value as Il2Cpp.Object;
    // dumpObject(TeamUnitListEntity);
    const unit_list = TeamUnitListEntity.field("unit_list")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    log(`unit_list length: ${unit_list.length}`);
    const units: Record<string, any>[] = [];
    for (let i = 0; i < unit_list.length; i++) {
      const UnitEntity = unit_list.get(i);
      const unit: Record<string, any> = {};
      for (const field of UnitEntity.class.fields) {
        try {
          const value = UnitEntity.field(field.name).value;
          unit[field.name] = convertValue(value);
        } catch (e) {
          unit[field.name] = `<error>: ${e}`;
        }
      }
      units.push(unit);
    }
    saveJson("unit_list.json", units);
    log(`unit_list saved to unit_list.json`);
    const sister_unit_list = TeamUnitListEntity.field("sister_unit_list")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    log(`sister_unit_list length: ${sister_unit_list.length}`);
    return;
  }
  log(`${method.name} return: ${retval}\n`);
}

type MethodHandler = (
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments,
) => void;

function handleCaluculationNormalDamage(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  enter_CaluculationNormalDamage = true;
  const attack = new Il2Cpp.Object(args[0]); //TSKBattleNote
  const defence = new Il2Cpp.Object(args[1]); //TSKBattleNote
  const beforeRushCount = args[2].toInt32();
  const rushCount = args[3].toInt32();
  const skillValue = parseArgument(args[4], "float") as number;
  const kind = AttackType[parseArgument(args[8], "enum") as number];
  const criticalUp = parseArgument(args[9], "int");
  const targetCount = parseArgument(args[10], "int");
  const multipleCount = parseArgument(args[11], "int");

  const baseAttack = attack.method("GetBaseAttack").invoke() as number;
  const atk = attack.method("GetAttack").invoke(false) as number;
  const crt = attack.method("GetCritical").invoke() as number;

  log(
    `[CaluculationNormalDamage]: beforeRushCount=${beforeRushCount} rushCount=${rushCount} skillValue=${skillValue}`,
  );
  log(
    `[CaluculationNormalDamage]: kind=${kind} criticalUp=${criticalUp} targetCount=${targetCount} multipleCount=${multipleCount}`,
  );

  const teamPtr = attack.handle.add(0x28).readPointer();
  const team = new Il2Cpp.Object(teamPtr);
  const teamType = team.handle.add(0x28).readS32();
  log(`attack teamType=${TeamType[teamType]}`);
  logSkillEffectList(attack);
  logSkillEffectList(defence);

  log(
    `[CaluculationNormalDamage]: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`,
  );
  log(
    `${getNameByTSKBattleNote(attack)}: ATK倍率=${(atk / baseAttack).toFixed(
      2,
    )} attack=${atk}(ignore charge) skillValue=${skillValue.toFixed(2)}`,
  );
}

function handleSetSkillDamageValue(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const value = args[1].toString();
  const attackAddress = args[4].toString();
  const isCritical = args[8].toInt32() != 0 ? "True" : "False";
  log(`SetSkillDamageValue: value=${value} attackAddress=${attackAddress}`);
  tskBattleLog.addDamageNote(attackAddress, value, "Skill", isCritical);
}

function handleSetDamageValue(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const value = args[1].toString();
  const attackAddress = args[5].toString();
  const isCritical = args[4].toInt32() != 0 ? "True" : "False";
  log(`SetDamageValue: value=${value} attackAddress=${attackAddress}`);
  tskBattleLog.addDamageNote(attackAddress, value, "Normal", isCritical);
}

function handleSetUnisonDamageValue(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const value = args[1].toString();
  const attackAddress = args[4].toString();
  log(`SetUnisonDamageValue: value=${value} attackAddress=${attackAddress}`);
  tskBattleLog.addDamageNote(attackAddress, value, "Unison");
}

function handleSetDamageNormal(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const attack = new Il2Cpp.Object(args[1]); //TSKBattleNote
  const target = new Il2Cpp.Object(args[2]);
  log(
    `SetDamageNormal: ${getNameByTSKBattleNote(
      attack,
    )} -> ${getNameByTSKBattleNote(target)}`,
  );
}

function handleLotterySkill(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  // args[2] = TSKBattleNote
  const unit = new Il2Cpp.Object(args[2]);
  const baseAttack = unit.method("GetBaseAttack").invoke() as number;
  const atk = unit.method("GetAttack").invoke(false) as number;
  const crt = unit.method("GetCritical").invoke() as number;
  log(
    `LotterySkill: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`,
  );

  const selectPattern = new Il2Cpp.Object(args[1]);

  const unitData = unit.field("<UnitData>k__BackingField")
    .value as Il2Cpp.Object;

  const unitName = (
    unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String
  ).content;
  const characterName = (
    unitData.field("<CharacterName>k__BackingField").value as Il2Cpp.String
  ).content;
  const hp = unitData.field("<HP>k__BackingField").value;
  const attack = unitData.field("<Attack>k__BackingField").value;
  const critical = unitData.field("<Critical>k__BackingField").value;

  log(
    `${unitName} (${characterName}): hp=${hp} attack=${attack} critical=${critical}`,
  );

  const skillId = getAutoUseSkillIndex(unitName ?? "", characterName ?? "");
  if (skillId != -1) {
    log(`set ${unitName} skillId=${skillId}`);
    if (skillId == 0) {
      selectPattern.field("skill_rate_1").value = 0;
      selectPattern.field("skill_rate_2").value = 0;
    }
    if (skillId == 1) {
      selectPattern.field("skill_rate_1").value = 100;
      selectPattern.field("skill_rate_2").value = 0;
    }
    if (skillId == 2) {
      selectPattern.field("skill_rate_1").value = 0;
      selectPattern.field("skill_rate_2").value = 100;
    }
    if (skillId == 3) {
      selectPattern.field("skill_rate_1").value = 50;
      selectPattern.field("skill_rate_2").value = 50;
    }
  } else {
    log(
      `${unitName} ${characterName} not found in skillMap: skill_rate_1 = ${
        selectPattern.field("skill_rate_1").value
      }  skill_rate_2 = ${selectPattern.field("skill_rate_2").value}`,
    );
  }
}

function handleLotterySkillAction(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const nowTurnCount = parseInt(args[5].toString(), 16);
  log(`LotterySkillAction: nowTurnCount = ${nowTurnCount}`);
}

function handleInitialize(
  _cls: Il2Cpp.Class,
  _method: Il2Cpp.Method,
  args: InvocationArguments,
) {
  const hp = parseInt(args[1].toString(), 16);
  const maxHp = parseInt(args[2].toString(), 16);
  const stun = parseInt(args[3].toString(), 16);
  const notesList = new Il2Cpp.Object(args[4]);

  const notes = notesList.field("_items").value as Il2Cpp.Array<Il2Cpp.Object>;
  const notesSize = notesList.field("_size").value as number;
  const type = parseInt(args[5].toString(), 16);
  const mode = parseInt(args[6].toString(), 16);
  const overHealRate = parseInt(args[7].toString(), 16);
  // 直接使用枚举的反向映射
  const modeName = BattleMode[mode]; // "DamageChallengeAtMode"
  const teamType = type == 0 ? "Player" : type == 1 ? "Enemy" : "Unknown";
  if (teamType === "Unknown") {
    log(`Unknown team type: ${type}`);
  }

  log(
    `${teamType} Initialize: hp=${hp} maxHp=${maxHp} stun=${stun} notes.length=${notesSize} mode=${modeName} overHealRate=${overHealRate}`,
  );

  if (teamType === "Player" || teamType === "Unknown") {
    tskBattleLog.init(notes);
  }
}

// dumpArgs 类方法的统一处理器
const dumpArgsHandler: MethodHandler = (_cls, method, args) =>
  dumpArgs(method, args);

function traceMethod(
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  handler?: MethodHandler,
) {
  if (method.virtualAddress.isNull()) {
    return;
  }

  log("Trace:", cls.name, method.name);

  Interceptor.attach(method.virtualAddress, {
    onEnter(args) {
      log(`enter ${cls.name}.${method.name}`);
      handler?.(cls, method, args);
      if (method.name == "PlayDamage") {
        const base = Process.getModuleByName("GameAssembly.dll").base;
        const module = Process.getModuleByName("GameAssembly.dll");

        log("module.base =", module.base);
        log("returnAddress =", this.returnAddress);
        log("RVA =", this.returnAddress.sub(module.base));
      }
      if (method.name == "FluctuationOffset") {
        const f = new NativeFunction(method.virtualAddress, "float", []);

        log(f());
      }
    },
    onLeave(retval) {
      onLeaveMethod(cls, method, retval);
    },
  });
}

Il2Cpp.perform(() => {
  log("================================");
  log("Frida IL2CPP Started");

  log("Unity Version:", Il2Cpp.unityVersion);

  log("================================");

  const image = Il2Cpp.domain.assembly("Assembly-CSharp").image;

  function traceMethodByName(
    className: string,
    methodName: string,
    handler?: MethodHandler,
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
    traceMethod(cls, method, handler);
  }
  const TSKBattleMain = image.class("TSKBattleMain");
  const QTEResutl = TSKBattleMain.method("QTEResutl");
  const QTEResutlOriginal = new NativeFunction(
    QTEResutl.virtualAddress,
    "void",
    ["pointer", "int"],
  ) as any;

  QTEResutl.implementation = function (timing: any) {
    log(`QTEResutl called with timing = ${Timing[timing]}(${timing})`);
    // 强制 PREFECT
    const newTiming = 3;
    log(`QTEResutl modified timing to = ${Timing[newTiming]}(${newTiming})`);
    return QTEResutlOriginal(this.handle, newTiming);
  };
  traceMethodByName("TSKBattleAI", "LotterySkill", handleLotterySkill);
  traceMethodByName(
    "TSKBattleAI",
    "LotterySkillAction",
    handleLotterySkillAction,
  );
  traceMethodByName("TSKBattleTeam", "Initialize", handleInitialize);
  traceMethodByName("TSKBattleManager", "InitializeResult", () =>
    tskBattleLog.onEndBattle(),
  );
  traceMethodByName(
    "TSKBattleAttack",
    "SetDamageNormal",
    handleSetDamageNormal,
  );
  traceMethodByName("TSKBattleNote", "SetDamageValue", handleSetDamageValue);
  traceMethodByName(
    "TSKBattleCalculationManager",
    "CaluculationNormalDamage",
    handleCaluculationNormalDamage,
  );

  traceMethodByName(
    "TSKBattleNote",
    "SetSkillDamageValue",
    handleSetSkillDamageValue,
  );
  // traceMethodByName("TSKBattleNote", "SetSkillMultiDamageValue");
  traceMethodByName(
    "TSKBattleNote",
    "SetUnisonDamageValue",
    handleSetUnisonDamageValue,
  );

  // todo:
  // traceMethodByName("TeamCharaListPresenter", "GetUnitListRepository");

  // const TeamCharaListPresenter = image.class("TeamCharaListPresenter");
  // log(TeamCharaListPresenter);
  // const PlayDamage = image.class("DamageText").method("PlayDamage");
  // Il2Cpp.trace(false).methods(PlayDamage).and().attach();
  // hookMethodReturn(
  //   image.class("TSKBattleUtility").method("GetAbilityCompatibility"),
  //   "int",
  //   ["int", "int", "int"],
  //   (ret) => {
  //     log("GetAbilityCompatibility =", ret);
  //   }
  // );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("FluctuationOffset"),
    "float",
    [],
    (ret) => {
      if (enter_CaluculationNormalDamage) {
        log("FluctuationOffset =", ret.toFixed(2));
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("RushOffset"),
    "float",
    ["int", "pointer", "int"],
    (ret) => {
      if (enter_CaluculationNormalDamage) {
        log("RushOffset =", ret.toFixed(2));
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("AttributeOffset"),
    "float",
    ["int", "pointer", "int"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        const compatibility = args[0];
        log(
          `AttributeOffset = ${ret.toFixed(2)} (compatibility=${
            AbilityCompatibility[compatibility]
          })`,
        );
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("CriticalOffset"),
    "float",
    ["bool", "pointer", "int", "int"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        const isCritilal = args[0];
        log(
          `CriticalOffset = ${ret.toFixed(2)} (isCritical=${
            isCritilal == 1 ? "true" : "false"
          })`,
        );
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("DownOffset"),
    "float",
    ["pointer", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        log(`DownOffset = ${ret.toFixed(2)}`);
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleNote").method("GetDamageRateValue"),
    "int64",
    ["pointer", "int64", "int", "int", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        const damage = convertArg(args[0]);
        const damageNum = Number(damage);
        log(
          `GetDamageRateValue = ${damage} -> ${ret} (易伤: ${(
            ret / damageNum
          ).toFixed(2)})`,
        );
      }
    },
  );
  hookMethodReturn(
    image.class("TSKBattleNote").method("GetPassiveDamageRate"),
    "int",
    ["pointer", "int", "int", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        log(`GetPassiveDamageRate = ${ret}`);
      }
    },
  );

  type MethodInfo = {
    start: NativePointer;
    method: Il2Cpp.Method;
  };

  const methods: MethodInfo[] = [];

  Il2Cpp.perform(() => {
    for (const asm of Il2Cpp.domain.assemblies) {
      for (const cls of asm.image.classes) {
        for (const method of cls.methods) {
          if (method.virtualAddress.isNull()) continue;

          methods.push({
            start: method.virtualAddress,
            method,
          });
        }
      }
    }

    methods.sort((a, b) => {
      if (a.start.compare(b.start) < 0) return -1;
      if (a.start.compare(b.start) > 0) return 1;
      return 0;
    });

    log(`indexed ${methods.length} methods`);

    function resolveMethod(addr: NativePointer): string {
      let last: MethodInfo | null = null;

      for (const m of methods) {
        if (m.start.compare(addr) > 0) break;

        last = m;
      }

      if (last == null) return addr.toString();

      const offset = addr.sub(last.start);

      return `${last.method.class.namespace}.${last.method.class.name}.${last.method.name}+${offset}`;
    }
    function printCaller(context: CpuContext, depth = 5) {
      const frames = Thread.backtrace(context, Backtracer.ACCURATE);

      for (let i = 1; i < Math.min(frames.length, depth + 1); i++) {
        log(`${"  ".repeat(i - 1)}└─ ${resolveMethod(frames[i])}`);
      }
    }
  });
});
function hookMethodReturn(
  method: Il2Cpp.Method,
  returnType: NativeFunctionReturnType,
  argTypes: NativeFunctionArgumentType[],
  handler?: (ret: any, args: any[]) => any,
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
      enter_CaluculationNormalDamage &&
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
      enter_CaluculationNormalDamage &&
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

function logSkillEffectList(unit: Il2Cpp.Object) {
  const skillEffectList = unit.field("skillEffectList").value as Il2Cpp.Object;

  if (skillEffectList.isNull()) {
    log("skillEffectList = null");
    return;
  }

  // List<T> 当前元素数量
  const size = skillEffectList.field("_size").value as number;

  // T[] 数组
  const items = skillEffectList.field("_items")
    .value as Il2Cpp.Array<Il2Cpp.Object>;
  const unitName = getNameByTSKBattleNote(unit);
  log(`${unitName} skillEffectList size = ${size}`);
  const valueMap = new Map<string, number>();
  const effectValueMap = new Map<string, number>();
  for (let i = 0; i < size; i++) {
    const effect = items.get(i);
    const type = effect.field("<Type>k__BackingField").value.toString();
    const time = effect.field("<Time>k__BackingField").value as number;
    const value = effect.field("<SkillValue1>k__BackingField").value as number;
    const value2 = effect.field("<SkillValue2>k__BackingField").value as number;
    const value3 = effect.field("<SkillValue3>k__BackingField").value as number;
    const value4 = effect.field("<SkillValue4>k__BackingField").value as number;
    const value5 = effect.field("<SkillValue5>k__BackingField").value as number;
    const effectValue = effect.field("<SkillEffectValue>k__BackingField")
      .value as number;

    // if (time > 9000) continue;
    log(
      `effect ${i}: type=${type} time=${time} value=${value} effectValue=${effectValue} value2=${value2} value3=${value3} value4=${value4} value5=${value5}`,
    );
    valueMap.set(type, (valueMap.get(type) ?? 0) + value);
    effectValueMap.set(type, (effectValueMap.get(type) ?? 0) + effectValue);
  }

  log(`===== ${unitName} Effect Summary =====`);
  for (const [type, totalValue] of valueMap.entries()) {
    const totalEffectValue = effectValueMap.get(type) ?? 0;
    log(`${type}: value=${totalValue} effectValue=${totalEffectValue}`);
  }
}
