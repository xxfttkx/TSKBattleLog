import { AttackType, TeamType, AbilityCompatibility } from "../common";
import {
  log,
  parseArgument,
  getNameByTSKBattleNote,
  hookMethodReturn,
  convertArg,
} from "../utils";
import {
  Mod,
  MethodEnterHandler,
  MethodLeaveHandler,
  traceMethodByName,
} from "../mod";

/** 伤害公式分析（调试工具）：CaluculationNormalDamage 期间输出各系数偏移 */
export class DamageCalcTraceMod implements Mod {
  name = "damage-calc-trace";
  category = "调试" as const;
  description = "打印伤害计算相关的各个参数";
  enabled = true;

  /** CaluculationNormalDamage 执行期间的守卫标志，限定 Offset 系列日志只在计算期间输出 */
  private enterCalc = false;

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "CaluculationNormalDamage",
      this,
      this.handleCaluculationNormalDamage,
      this.handleCaluculationNormalDamageLeave,
    );
    traceMethodByName(
      image,
      "TSKBattleAI",
      "LotterySkillAction",
      this,
      this.handleLotterySkillAction,
    );

    const verbose = () => this.enabled && this.enterCalc;

    hookMethodReturn(
      image.class("TSKBattleCalculationManager").method("FluctuationOffset"),
      "float",
      [],
      (ret) => {
        if (this.enterCalc) {
          log("FluctuationOffset =", ret.toFixed(2));
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleCalculationManager").method("RushOffset"),
      "float",
      ["int", "pointer", "int"],
      (ret) => {
        if (this.enterCalc) {
          log("RushOffset =", ret.toFixed(2));
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleCalculationManager").method("AttributeOffset"),
      "float",
      ["int", "pointer", "int"],
      (ret, args) => {
        if (this.enterCalc) {
          const compatibility = args[0];
          log(
            `AttributeOffset = ${ret.toFixed(2)} (compatibility=${
              AbilityCompatibility[compatibility]
            })`,
          );
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleCalculationManager").method("CriticalOffset"),
      "float",
      ["bool", "pointer", "int", "int"],
      (ret, args) => {
        if (this.enterCalc) {
          const isCritilal = args[0];
          log(
            `CriticalOffset = ${ret.toFixed(2)} (isCritical=${
              isCritilal == 1 ? "true" : "false"
            })`,
          );
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleCalculationManager").method("DownOffset"),
      "float",
      ["pointer", "pointer"],
      (ret, args) => {
        if (this.enterCalc) {
          log(`DownOffset = ${ret.toFixed(2)}`);
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleNote").method("GetDamageRateValue"),
      "int64",
      ["pointer", "int64", "int", "int", "pointer"],
      (ret, args) => {
        if (this.enterCalc) {
          const damage = convertArg(args[0]);
          const damageNum = Number(damage);
          log(
            `GetDamageRateValue = ${damage} -> ${ret} (易伤: ${(
              ret / damageNum
            ).toFixed(2)})`,
          );
        }
      },
      verbose,
    );
    hookMethodReturn(
      image.class("TSKBattleNote").method("GetPassiveDamageRate"),
      "int",
      ["pointer", "int", "int", "pointer"],
      (ret, args) => {
        if (this.enterCalc) {
          log(`GetPassiveDamageRate = ${ret}`);
        }
      },
      verbose,
    );

    hookMethodReturn(
      image.class("TSKBattleUtility").method("GetAbilityCompatibility"),
      "int",
      ["int", "int", "int"],
      (ret) => {
        log("GetAbilityCompatibility =", ret);
      },
      verbose,
    );
  }

  private handleCaluculationNormalDamage: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    this.enterCalc = true;
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
    this.logSkillEffectList(attack);
    this.logSkillEffectList(defence);

    log(
      `[CaluculationNormalDamage]: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`,
    );
    log(
      `${getNameByTSKBattleNote(attack)}: ATK倍率=${(atk / baseAttack).toFixed(
        2,
      )} attack=${atk}(ignore charge) skillValue=${skillValue.toFixed(2)}`,
    );
  };

  private handleCaluculationNormalDamageLeave: MethodLeaveHandler = (
    _cls,
    _method,
    _retval,
  ) => {
    this.enterCalc = false;
  };

  private handleLotterySkillAction: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    const nowTurnCount = parseInt(args[5].toString(), 16);
    log(`LotterySkillAction: nowTurnCount = ${nowTurnCount}`);
  };

  private logSkillEffectList(unit: Il2Cpp.Object) {
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
    const unitName = getNameByTSKBattleNote(unit);
    log(`${unitName} skillEffectList size = ${size}`);
    const valueMap = new Map<string, number>();
    const effectValueMap = new Map<string, number>();
    for (let i = 0; i < size; i++) {
      const effect = items.get(i);
      const type = effect.field("<Type>k__BackingField").value.toString();
      const time = effect.field("<Time>k__BackingField").value as number;
      const value = effect.field("<SkillValue1>k__BackingField")
        .value as number;
      const value2 = effect.field("<SkillValue2>k__BackingField")
        .value as number;
      const value3 = effect.field("<SkillValue3>k__BackingField")
        .value as number;
      const value4 = effect.field("<SkillValue4>k__BackingField")
        .value as number;
      const value5 = effect.field("<SkillValue5>k__BackingField")
        .value as number;
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
}
