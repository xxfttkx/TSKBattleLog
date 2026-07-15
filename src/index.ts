import "frida-il2cpp-bridge";
import { skillMap } from "./common";
import { log, dumpArgs } from "./utils";
import { TSKBattleLog } from "./TSKBattleLog";

const tskBattleLog = new TSKBattleLog();

function handleArgs(
  cls: Il2Cpp.Class,
  method: Il2Cpp.Method,
  args: InvocationArguments
) {
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
    const isCritical = args[8].toInt32() != 0;
    log(`SetSkillDamageValue: value=${value} attackAddress=${attackAddress}`);
    tskBattleLog.addDamageNote(attackAddress, value, "Skill");
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
    const isCritical = args[4].toInt32() != 0;
    log(`SetDamageValue: value=${value} attackAddress=${attackAddress}`);
    tskBattleLog.addDamageNote(attackAddress, value, "Normal");
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
      // if (time > 9000) continue;
      // log(`effect ${i}: type=${type} time=${time} value=${value}`);
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

    // dumpObject(type);
    log(
      `${teamType} Initialize: hp=${hp} maxHp=${maxHp} stun=${stun} notes.length=${notesSize} mode=${modeName} overHealRate=${overHealRate}`
    );

    if (teamType === "Player") {
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
    },
    onLeave(retval) {
      log(`return: ${retval}\n`);
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
  traceMethodByName("TSKBattleAI", "LotterySkill");
  traceMethodByName("TSKBattleTeam", "Initialize");
  traceMethodByName("TSKBattleManager", "InitializeResult");
  traceMethodByName("TSKBattleAttack", "SetDamageNormal");
  traceMethodByName("TSKBattleNote", "SetDamageValue");
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
