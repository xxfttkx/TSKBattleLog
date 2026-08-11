import "frida-il2cpp-bridge";
import {
  skillMap,
  AttackType,
  TeamType,
  AbilityCompatibility,
  SkillType,
  Timing,
} from "./common";
import { log, dumpArgs, parseArgument } from "./utils";
import { TSKBattleLog } from "./TSKBattleLog";

const tskBattleLog = new TSKBattleLog();
var enter_CaluculationNormalDamage = false;

function onLeaveMethod(
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  retval: InvocationReturnValue
) {
  if (method.name == "CaluculationNormalDamage") {
    enter_CaluculationNormalDamage = false;
  }
  log(`${method.name} return: ${retval}\n`);
}

function handleArgs(
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments
) {
  if (method.name == "CaluculationNormalDamage") {
    enter_CaluculationNormalDamage = true;
    const attack = new Il2Cpp.Object(args[0]); //TSKBattleNote
    const defence = new Il2Cpp.Object(args[1]); //TSKBattleNote
    const beforeRushCount = args[2].toInt32();
    const rushCount = args[3].toInt32();
    const skillValue = parseArgument(args[4], "float");
    const kind = AttackType[parseArgument(args[8], "enum") as number];
    const criticalUp = parseArgument(args[9], "int");
    const targetCount = parseArgument(args[10], "int");
    const multipleCount = parseArgument(args[11], "int");
    // dumpArgs(method, args);

    const baseAttack = attack.method("GetBaseAttack").invoke() as number;
    const atk = attack.method("GetAttack").invoke(false) as number;
    const crt = attack.method("GetCritical").invoke() as number;
    log(
      `[CaluculationNormalDamage]: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`
    );
    log(
      `[CaluculationNormalDamage]: beforeRushCount=${beforeRushCount} rushCount=${rushCount} skillValue=${skillValue}`
    );
    log(
      `[CaluculationNormalDamage]: kind=${kind} criticalUp=${criticalUp} targetCount=${targetCount} multipleCount=${multipleCount}`
    );

    const teamPtr = attack.handle.add(0x28).readPointer();
    const team = new Il2Cpp.Object(teamPtr);
    const teamType = team.handle.add(0x28).readS32();
    log(`attack teamType=${TeamType[teamType]}`);

    // const TSKBattleUtility = Il2Cpp.domain
    //   .assembly("Assembly-CSharp")
    //   .image.class("TSKBattleUtility");
    // const GetAbilityCompatibility = TSKBattleUtility.methods.find(
    //   (m) =>
    //     m.name === "GetAbilityCompatibility" &&
    //     m.parameters[0].type.name === "TSKBattleNote" &&
    //     m.parameters[1].type.name === "TSKBattleNote"
    // );
    // if (!GetAbilityCompatibility) {
    //   log("GetAbilityCompatibility not found");
    //   return;
    // }
    // log(GetAbilityCompatibility.toString());

    // const result = GetAbilityCompatibility?.invoke(attack, defence, teamType);
    // log(`GetAbilityCompatibility result = ${result?.toString()}`);

    const GetSkillEffect = defence.method("GetSkillEffect");
    console.log(GetSkillEffect.toString());
    const DmgUpList = GetSkillEffect!.invoke(
      SkillType["DmgUp"]
    ) as Il2Cpp.Object;
    // dumpObject(DmgUpList);
    var size = DmgUpList.field("_size").value as number;
    var items = DmgUpList.field("_items").value as Il2Cpp.Array;
    log(`defencer DmgUpList count = ${size}`);
    for (let i = 0; i < size; i++) {
      const item = items.get(i) as Il2Cpp.Object;

      log(`item[${i}] = ${item.class.name}`);
    }
    const DamageDowList = GetSkillEffect!.invoke(
      SkillType["DamageDown"]
    ) as Il2Cpp.Object;
    size = DamageDowList.field("_size").value as number;
    log(`defencer DamageDowList count = ${size}`);
    const AtkUpList = attack
      .method("GetSkillEffect")!
      .invoke(SkillType["AtkUp"]) as Il2Cpp.Object;
    size = AtkUpList.field("_size").value as number;
    log(`attcker AtkUpList count = ${size}`);
    logSkillEffectList(defence);
    return;
  }
  if (method.name == "GetAbilityCompatibility") {
    // dumpArgs(method, args);
    return;
  }
  if (method.name == "CaluculationUnisonDamage") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "Execute") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "SetSkillDamageValue") {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    const isCritical = args[8].toInt32() != 0 ? "True" : "False";
    log(`SetSkillDamageValue: value=${value} attackAddress=${attackAddress}`);
    tskBattleLog.addDamageNote(attackAddress, value, "Skill", isCritical);
    return;
  }
  if (method.name == "SetSkillMultiDamageValue") {
    // const arr = new Il2Cpp.Array(args[1]);
    // const count = arr.length;

    // var damage = BigInt(0);
    // for (let i = 0; i < count; i++) {
    //   damage += BigInt(arr.get(i).toString());
    // }
    // const value = damage.toString();
    // const attack = new Il2Cpp.Object(args[0]);
    // const attackAddress = attack.handle.toString();
    // // const isCritical = args[8].toInt32() != 0;
    // log(
    //   `SetSkillMultiDamageValue: value=${value} attackAddress=${attackAddress}`
    // );
    // tskBattleLog.addDamageNote(attackAddress, value, "Skill");
    return;
  }
  if (method.name == "SetDamageValue") {
    const value = args[1].toString();
    const attackAddress = args[5].toString();
    const isCritical = args[4].toInt32() != 0 ? "True" : "False";
    log(`SetDamageValue: value=${value} attackAddress=${attackAddress}`);
    tskBattleLog.addDamageNote(attackAddress, value, "Normal", isCritical);
    return;
  }
  if (method.name == "SetUnisonDamageValue") {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    log(`SetUnisonDamageValue: value=${value} attackAddress=${attackAddress}`);
    tskBattleLog.addDamageNote(attackAddress, value, "Unison");
    return;
  }
  if (method.name == "SetSkillEffect") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "ExecuteWholeMulti") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "SetMultiDanameTextView") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "StartSkillDamage") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "SetDamageNormal") {
    const attack = new Il2Cpp.Object(args[1]); //TSKBattleNote
    const attackUnitData = attack.field("<UnitData>k__BackingField")
      .value as Il2Cpp.Object;
    const target = new Il2Cpp.Object(args[2]);
    const targetUnitData = target.field("<UnitData>k__BackingField")
      .value as Il2Cpp.Object;
    const name_a_0 = attackUnitData.field("<UnitName>k__BackingField").value;
    const name_a_1 = attackUnitData.field(
      "<CharacterName>k__BackingField"
    ).value;
    const name_t_0 = targetUnitData.field("<UnitName>k__BackingField").value;
    const name_t_1 = targetUnitData.field(
      "<CharacterName>k__BackingField"
    ).value;
    log(`SetDamageNormal: ${name_a_0} ${name_a_1} -> ${name_t_0} ${name_t_1}`);
  }
  if (method.name == "SetDamage") {
    dumpArgs(method, args);
    return;
  }
  if (method.name == "PlayDamage") {
    dumpArgs(method, args);
    return;
    const damageValue = parseInt(args[1].toString(), 16);
    const rate = parseInt(args[2].toString(), 16);
    const isCritical = parseInt(args[3].toString(), 16);
    const isDamageOverTime = parseInt(args[4].toString(), 16);
    const isIndividualDamage = parseInt(args[5].toString(), 16);
    const isInvalid = parseInt(args[6].toString(), 16);
    log(
      `PlayDamage damageValue = ${damageValue}, rate = ${rate}, isCritical = ${isCritical}, isDamageOverTime = ${isDamageOverTime}, isIndividualDamage = ${isIndividualDamage}, isInvalid = ${isInvalid}`
    );
  }
  if (method.name == "LotterySkill") {
    // args[2] = TSKBattleNote
    const unit = new Il2Cpp.Object(args[2]);
    const baseAttack = unit.method("GetBaseAttack").invoke() as number;
    const atk = unit.method("GetAttack").invoke(false) as number;
    const crt = unit.method("GetCritical").invoke() as number;
    log(
      `LotterySkill: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`
    );

    const selectPattern = new Il2Cpp.Object(args[1]);

    const skillEffectList = unit.field("skillEffectList")
      .value as Il2Cpp.Object;

    if (skillEffectList.isNull()) {
      log("skillEffectList = null");
      return;
    }

    // List<T> 当前元素数量
    const size = skillEffectList.field("_size").value as number;

    // T[] 数组
    const items = skillEffectList.field("_items")
      .value as Il2Cpp.Array<Il2Cpp.Object>;

    log("skillEffectList size =", size);
    const effectMap = new Map<string, number>();
    for (let i = 0; i < size; i++) {
      const effect = items.get(i);
      const type = effect.field("<Type>k__BackingField").value.toString();
      const time = effect.field("<Time>k__BackingField").value as number;
      const value = effect.field("<SkillValue1>k__BackingField")
        .value as number;
      const effectValue = effect.field("<SkillEffectValue>k__BackingField")
        .value as number;
      // if (time > 9000) continue;
      // log(
      //   `effect ${i}: type=${type} time=${time} value=${value} effectValue=${effectValue}`
      // );
      effectMap.set(type, (effectMap.get(type) ?? 0) + value);
    }

    log("===== Effect Summary =====");
    for (const [type, total] of effectMap) {
      log(`${type}: ${total}`);
    }

    const unitData = unit.field("<UnitData>k__BackingField")
      .value as Il2Cpp.Object;

    var unitName = (
      unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String
    ).content;
    const characterName = (
      unitData.field("<CharacterName>k__BackingField").value as Il2Cpp.String
    ).content;
    const hp = unitData.field("<HP>k__BackingField").value;
    const attack = unitData.field("<Attack>k__BackingField").value;
    const critical = unitData.field("<Critical>k__BackingField").value;

    log(
      `${unitName} ${characterName}: hp=${hp} attack=${attack} critical=${critical}`
    );

    if (unitName && skillMap.has(unitName)) {
      const skillId = skillMap.get(unitName);
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
        }  skill_rate_2 = ${selectPattern.field("skill_rate_2").value}`
      );
    }
  }
  if (method.name == "LotterySkillAction") {
    const nowTurnCount = parseInt(args[5].toString(), 16);
    log(`LotterySkillAction: nowTurnCount = ${nowTurnCount}`);
    return;
    for (var i = 0; i < 7; i++) {
      if (args[i] != null) {
        const arg = new Il2Cpp.Object(args[i]);
        if (arg) {
          log(`arg[${i}] = ${arg.class.name}`);
          dumpObject(arg);
        }
      }
    }
  }
  if (method.name == "InitializeResult") {
    tskBattleLog.onEndBattle();
  }
  if (method.name == "Initialize") {
    const hp = parseInt(args[1].toString(), 16);
    const maxHp = parseInt(args[2].toString(), 16);
    const stun = parseInt(args[3].toString(), 16);
    const notesList = new Il2Cpp.Object(args[4]);

    const notes = notesList.field("_items")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    const notesSize = notesList.field("_size").value as number;
    const type = parseInt(args[5].toString(), 16);
    const mode = parseInt(args[6].toString(), 16);
    const overHealRate = parseInt(args[7].toString(), 16);
    enum BattleMode {
      None = 0,
      Normal = 1,
      Boss = 2,
      OnlyBoss = 3,
      DamageAttack = 4,
      DefeatAttack = 5,
      DamageChallengeAtMode = 6,
      DamageChallenge = 7,
    }
    // 直接使用枚举的反向映射
    const modeName = BattleMode[mode]; // "DamageChallengeAtMode"
    const teamType = type == 0 ? "Player" : type == 1 ? "Enemy" : "Unknown";
    if (teamType === "Unknown") {
      log(`Unknown team type: ${type}`);
    }

    // dumpObject(type);
    log(
      `${teamType} Initialize: hp=${hp} maxHp=${maxHp} stun=${stun} notes.length=${notesSize} mode=${modeName} overHealRate=${overHealRate}`
    );

    if (teamType === "Player" || teamType === "Unknown") {
      tskBattleLog.init(notes);
    }
  }
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

function traceMethod(cls: Il2Cpp.Class, method: Il2Cpp.Method) {
  if (method.virtualAddress.isNull()) {
    return;
  }

  log("Trace:", cls.name, method.name);

  Interceptor.attach(method.virtualAddress, {
    onEnter(args) {
      log(`enter ${cls.name}.${method.name}`);
      handleArgs(cls, method, args);
      if (method.name == "PlayDamage") {
        const base = Process.getModuleByName("GameAssembly.dll").base;
        const module = Process.getModuleByName("GameAssembly.dll");

        log("module.base =", module.base);
        log("returnAddress =", this.returnAddress);
        log("RVA =", this.returnAddress.sub(module.base));
      }
      if (method.name == "FluctuationOffset") {
        const f = new NativeFunction(method.virtualAddress, "float", []);

        console.log(f());
      }
    },
    onLeave(retval) {
      onLeaveMethod(cls, method, retval);
      // console.log(method.returnType.name);
      // console.log(method.virtualAddress);
    },
  });
}

Il2Cpp.perform(() => {
  log("================================");
  log("Frida IL2CPP Started");

  log("Unity Version:", Il2Cpp.unityVersion);

  log("================================");

  const image = Il2Cpp.domain.assembly("Assembly-CSharp").image;

  function traceMethodByName(className: string, methodName: string) {
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
    traceMethod(cls, method);
  }
  const TSKBattleMain = image.class("TSKBattleMain");
  const QTEResutl = TSKBattleMain.method("QTEResutl");
  const QTEResutlOriginal = new NativeFunction(
    QTEResutl.virtualAddress,
    "void",
    ["pointer", "int"]
  ) as any;

  QTEResutl.implementation = function (timing: any) {
    log(`QTEResutl called with timing = ${Timing[timing]}(${timing})`);
    // 强制 PREFECT
    const newTiming = 3;
    log(`QTEResutl modified timing to = ${Timing[newTiming]}(${newTiming})`);
    return QTEResutlOriginal(this.handle, newTiming);
  };
  traceMethodByName("TSKBattleAI", "LotterySkill");
  traceMethodByName("TSKBattleAI", "LotterySkillAction");
  traceMethodByName("TSKBattleTeam", "Initialize");
  traceMethodByName("TSKBattleManager", "InitializeResult");
  traceMethodByName("TSKBattleAttack", "SetDamageNormal");
  traceMethodByName("TSKBattleNote", "SetDamageValue");
  traceMethodByName("TSKBattleCalculationManager", "CaluculationNormalDamage");
  // traceMethodByName("TSKBattleUtility", "GetAbilityCompatibility");
  // traceMethodByName("TSKBattleNote", "SetDamage");
  // traceMethodByName("DamageText", "PlayDamage");
  // traceMethodByName("TSKBattleTeam", "SetMultiDanameTextView");
  // traceMethodByName("TSKBattleSkillManager", "Execute");
  // traceMethodByName("TSKBattleSkillManager", "ExecuteWholeMulti");
  traceMethodByName("TSKBattleNote", "SetSkillDamageValue");
  // traceMethodByName("TSKBattleNote", "SetSkillMultiDamageValue");
  traceMethodByName("TSKBattleNote", "SetUnisonDamageValue");
  // traceMethodByName("TSKBattleSkillManager", "SetSkillEffect");
  // traceMethodByName("TSKBattleTeam", "StartSkillDamage");
  // traceMethodByName("TSKBattleCalculationManager", "CaluculationUnisonDamage");

  // const PlayDamage = image.class("DamageText").method("PlayDamage");
  // Il2Cpp.trace(false).methods(PlayDamage).and().attach();
  // hookMethodReturn(
  //   image.class("TSKBattleUtility").method("GetAbilityCompatibility"),
  //   "int",
  //   ["int", "int", "int"],
  //   (ret) => {
  //     console.log("GetAbilityCompatibility =", ret);
  //   }
  // );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("FluctuationOffset"),
    "float",
    [],
    (ret) => {
      if (enter_CaluculationNormalDamage) {
        console.log("FluctuationOffset =", ret);
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("RushOffset"),
    "float",
    ["int", "pointer", "int"],
    (ret) => {
      if (enter_CaluculationNormalDamage) {
        console.log("RushOffset =", ret);
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("AttributeOffset"),
    "float",
    ["int", "pointer", "int"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        const compatibility = args[0];
        console.log(
          `AttributeOffset = ${ret} (compatibility=${AbilityCompatibility[compatibility]})`
        );
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("CriticalOffset"),
    "float",
    ["bool", "pointer", "int", "int"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        const isCritilal = args[0];
        console.log(
          `CriticalOffset = ${ret} (isCritical=${
            isCritilal == 1 ? "true" : "false"
          })`
        );
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleCalculationManager").method("DownOffset"),
    "float",
    ["pointer", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        console.log(`DownOffset = ${ret}`);
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleNote").method("GetDamageRateValue"),
    "int64",
    ["pointer", "int64", "int", "int", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        console.log(`GetDamageRateValue = ${ret}`);
      }
    }
  );
  hookMethodReturn(
    image.class("TSKBattleNote").method("GetPassiveDamageRate"),
    "int",
    ["pointer", "int", "int", "pointer"],
    (ret, args) => {
      if (enter_CaluculationNormalDamage) {
        console.log(`GetPassiveDamageRate = ${ret}`);
      }
    }
  );
  // traceMethodByName("TSKBattleCalculationManager", "FluctuationOffset");
  // traceMethodByName("TSKBattleCalculationManager", "RushOffset");
  // traceMethodByName("TSKBattleNote", "GetAttack");
  // traceMethodByName("TSKBattleCalculationManager", "CriticalOffset");
  // traceMethodByName("TSKBattleCalculationManager", "DownOffset");
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
        console.log(`${"  ".repeat(i - 1)}└─ ${resolveMethod(frames[i])}`);
      }
    }
    // const PlayDamage = image
    //   .class("TSKBattleNote")
    //   .method("SetSkillDamageValue");
    // Interceptor.attach(PlayDamage.virtualAddress, {
    //   onEnter(args) {
    //     log(resolveMethod(this.returnAddress));
    //     // printCaller(this.context, 5);
    //   },
    //   onLeave(retval) {
    //     log(`return: ${retval}\n`);
    //   },
    // });
  });
});
function hookMethodReturn(
  method: Il2Cpp.Method,
  returnType: NativeFunctionReturnType,
  argTypes: NativeFunctionArgumentType[],
  handler?: (ret: any, args: any[]) => any
) {
  if (!method) {
    console.log("[hookMethodReturn] method is undefined");
    return;
  }
  const original = new NativeFunction(
    method.virtualAddress,
    returnType,
    argTypes
  ) as any;
  const isStatic = method.isStatic;
  method.implementation = function (...args: any[]) {
    const expectedArgsNum = isStatic ? argTypes.length : argTypes.length - 1;
    console.log(
      `${method.name} args:`,
      args.map((x) => typeof x + ":" + x)
    );
    // if (method.name == "GetDamageRateValue") {
    //   args.forEach((arg, i) => {
    //     console.log("arg", i);
    //     console.log("typeof:", typeof arg);
    //     console.log("constructor:", arg?.constructor?.name);

    //     if (arg instanceof Il2Cpp.Object) {
    //       console.log("Object class:", arg.class.name);
    //     }

    //     if (arg instanceof Il2Cpp.ValueType) {
    //       console.log("ValueType toString:", arg.toString());
    //     }
    //   });
    // }
    if (expectedArgsNum !== args.length) {
      console.log(
        `[${method.name}] arg count mismatch: expected ${expectedArgsNum}, got ${args.length}, fallback`
      );
      // 走原 bridge implementation
      return method.invoke(...args);
    }
    const nativeArgs = args.map(convertArg);
    console.log(
      `${method.name} nativeArgs:`,
      nativeArgs.map((x) => typeof x + ":" + x)
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

  log("skillEffectList size =", size);
  const effectMap = new Map<string, number>();
  for (let i = 0; i < size; i++) {
    const effect = items.get(i);
    const type = effect.field("<Type>k__BackingField").value.toString();
    const time = effect.field("<Time>k__BackingField").value as number;
    const value = effect.field("<SkillValue1>k__BackingField").value as number;
    const effectValue = effect.field("<SkillEffectValue>k__BackingField")
      .value as number;

    // if (time > 9000) continue;
    log(
      `effect ${i}: type=${type} time=${time} value=${value} effectValue=${effectValue}`
    );
    effectMap.set(type, (effectMap.get(type) ?? 0) + value);
  }

  log("===== Effect Summary =====");
  for (const [type, total] of effectMap) {
    log(`${type}: ${total}`);
  }
}
