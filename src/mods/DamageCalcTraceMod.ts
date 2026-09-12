import { AttackType, TeamType, AbilityCompatibility } from "../common";
import {
  log,
  parseArgument,
  getNameByTSKBattleNote,
  readFloatReturn,
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

  /**
   * 一次 CaluculationNormalDamage 内各 Offset 的已打印标志。
   * 游戏内部会对部分系数（Attribute/Critical/Down）二次求值，
   * 两次结果相同，每次外层计算只保留第一次调用的输出；
   * 进入外层计算时整体重置（与 enterCalc 同一单线程假设）。
   */
  private offsetPrinted: Record<
    "fluctuation" | "rush" | "attribute" | "critical" | "down",
    boolean
  > = {
    fluctuation: false,
    rush: false,
    attribute: false,
    critical: false,
    down: false,
  };

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

    // 各伤害系数都是 float 返回值（x64 走 XMM0）。
    // frida 17.16+ 起 onLeave 的 CpuContext 直接暴露 xmm 寄存器，
    // 用纯 Interceptor.attach 监听即可，无需再替换 implementation 转发原函数。
    // quiet=true：enter/return 噪声日志交给本 mod 自己打印；mod.enabled
    // 守卫由 traceMethodByName 负责，计算期间守卫见各 handler 的 enterCalc。
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "FluctuationOffset",
      this,
      undefined,
      (_c, _m, _retval, _inv, ctx) => {
        if (this.enterCalc && !this.offsetPrinted.fluctuation) {
          this.offsetPrinted.fluctuation = true;
          log("FluctuationOffset =", readFloatReturn(ctx).toFixed(2));
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "RushOffset",
      this,
      undefined,
      (_c, _m, _retval, _inv, ctx) => {
        if (this.enterCalc && !this.offsetPrinted.rush) {
          this.offsetPrinted.rush = true;
          log("RushOffset =", readFloatReturn(ctx).toFixed(2));
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "AttributeOffset",
      this,
      (_cls, _m, args, _ctx, invocation) => {
        // private static float AttributeOffset(AbilityCompatibility compatibility, TSKBattleNote note, int beforeRushCount) { }
        // static 方法无 this：args[0] 就是第一个真实参数 compatibility，
        // 小值域枚举按字节掩码读，暂存到 invocation 供 onLeave 打印
        (invocation as any)._compatibility = args[0].toInt32() & 0xff;
      },
      (_c, _m, _retval, invocation, ctx) => {
        if (this.enterCalc && !this.offsetPrinted.attribute) {
          this.offsetPrinted.attribute = true;
          const compatibility = (invocation as any)._compatibility as number;
          log(
            `AttributeOffset = ${readFloatReturn(ctx).toFixed(2)} ` +
              `(compatibility=${AbilityCompatibility[compatibility]})`,
          );
        }
      },
      true,
    );
    // private static float CriticalOffset(bool isCritilal, TSKBattleNote note, int criticalUpValue = 0, int beforeRushCount = 0) { }
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "CriticalOffset",
      this,
      (_cls, _m, args, _ctx, invocation) => {
        // bool 参数高 24 位不可信，按字节掩码读取后暂存
        (invocation as any)._isCritical = (args[0].toInt32() & 0xff) !== 0;
      },
      (_c, _m, _retval, invocation, ctx) => {
        if (this.enterCalc && !this.offsetPrinted.critical) {
          this.offsetPrinted.critical = true;
          const isCritical = (invocation as any)._isCritical as boolean;
          log(
            `CriticalOffset = ${readFloatReturn(ctx).toFixed(2)} ` +
              `(isCritical=${isCritical ? "true" : "false"})`,
          );
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "DownOffset",
      this,
      undefined,
      (_c, _m, _retval, _inv, ctx) => {
        if (this.enterCalc && !this.offsetPrinted.down) {
          this.offsetPrinted.down = true;
          log(`DownOffset = ${readFloatReturn(ctx).toFixed(2)}`);
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "GetDamageRateValue",
      this,
      (_cls, _m, args, _ctx, invocation) => {
        // 实例方法：args[0]=this，args[1]=伤害基数(int64)，onLeave 时算易伤倍率
        (invocation as any)._damageBase = args[1];
      },
      (_c, _m, retval, invocation) => {
        if (this.enterCalc) {
          const damage = Number((invocation as any)._damageBase);
          const after = Number(retval);
          log(
            `GetDamageRateValue = ${damage} -> ${after} ` +
              `(易伤: ${(after / damage).toFixed(2)})`,
          );
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "GetPassiveDamageRate",
      this,
      undefined,
      (_c, _m, retval) => {
        if (this.enterCalc) {
          log(`GetPassiveDamageRate = ${Number(retval)}`);
        }
      },
      true,
    );
  }

  private handleCaluculationNormalDamage: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    this.enterCalc = true;
    // 新一轮外层计算：各系数去重标志复位
    this.offsetPrinted = {
      fluctuation: false,
      rush: false,
      attribute: false,
      critical: false,
      down: false,
    };
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

    log(
      `[CaluculationNormalDamage]: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`,
    );
    log(
      `${getNameByTSKBattleNote(attack)}: ATK倍率=${(atk / baseAttack).toFixed(
        2,
      )} attack=${atk}(ignore charge) skillValue=${skillValue.toFixed(2)}`,
    );
  };

  private handleCaluculationNormalDamageLeave: MethodLeaveHandler = () => {
    this.enterCalc = false;
  };

  private handleLotterySkillAction: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    // 第 6 个参数(int)在栈槽，直接按整数读；勿用 parseInt(ptr.toString(),16)
    // ——那是把指针值当地址解析的错误读法
    const nowTurnCount = args[5].toInt32();
    log(`LotterySkillAction: nowTurnCount = ${nowTurnCount}`);
  };
}
