import { log } from "../utils";
import { Mod, MethodEnterHandler, traceMethodByName } from "../mod";
import {
  damageCoeffs,
  CalcCoeffs,
  CalcInputSnapshot,
} from "../debug/damageCoeffs";

/**
 * 伤害公式分析（调试工具）：控制台文本视图。
 *
 * 系数 hook 与数据采集统一在 battle-log 的 damageCoeffs 采集器里（一份 hook，
 * 数据进 CalcSegment 供宿主详情面板），本 mod 只订阅采集完成事件打印文本，
 * 不再自行 hook 任何伤害计算方法。
 */
export class DamageCalcTraceMod implements Mod {
  name = "damage-calc-trace";
  category = "调试" as const;
  description = "打印伤害计算相关的各个参数";
  enabled = true;

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TSKBattleAI",
      "LotterySkillAction",
      this,
      this.handleLotterySkillAction,
    );

    damageCoeffs.subscribe((coeffs, inputs, finalDamage) => {
      if (!this.enabled) return;
      this.printCalc(coeffs, inputs, finalDamage);
    });
  }

  /** 一次 CaluculationNormalDamage 完成后的控制台输出（顺序沿用旧版） */
  private printCalc(
    coeffs: CalcCoeffs,
    i: CalcInputSnapshot,
    finalDamage: string,
  ): void {
    log(
      `[CaluculationNormalDamage]: beforeRushCount=${i.beforeRushCount} rushCount=${i.rushCount} skillValue=${i.skillValue}`,
    );
    log(
      `[CaluculationNormalDamage]: kind=${i.kind} criticalUp=${i.criticalUp} targetCount=${i.targetCount} multipleCount=${i.multipleCount}`,
    );
    log(`attack teamType=${i.teamType}`);
    log(
      `[CaluculationNormalDamage]: baseAttack=${i.baseAttack} attack=${i.attack}(ignore charge) critical=${i.critical}`,
    );
    const rate =
      i.baseAttack > 0 ? (i.attack / i.baseAttack).toFixed(2) : "N/A";
    log(
      `${i.attackerName}: ATK倍率=${rate} attack=${i.attack}(ignore charge) skillValue=${i.skillValue.toFixed(2)}`,
    );

    if (coeffs.fluctuation !== undefined) {
      log(`FluctuationOffset = ${coeffs.fluctuation.toFixed(2)}`);
    }
    if (coeffs.rush !== undefined) {
      log(`RushOffset = ${coeffs.rush.toFixed(2)}`);
    }
    if (coeffs.attribute) {
      log(
        `AttributeOffset = ${coeffs.attribute.value.toFixed(2)} ` +
          `(compatibility=${coeffs.attribute.compatibility})`,
      );
    }
    if (coeffs.critical) {
      log(
        `CriticalOffset = ${coeffs.critical.value.toFixed(2)} ` +
          `(isCritical=${coeffs.critical.isCritical})`,
      );
    }
    if (coeffs.down !== undefined) {
      log(`DownOffset = ${coeffs.down.toFixed(2)}`);
    }
    if (coeffs.passive !== undefined) {
      log(`GetPassiveDamageRate = ${coeffs.passive}`);
    }
    if (coeffs.damageRate) {
      const r = Number.isNaN(coeffs.damageRate.rate)
        ? "N/A"
        : coeffs.damageRate.rate.toFixed(2);
      log(
        `GetDamageRateValue = ${coeffs.damageRate.before} -> ${coeffs.damageRate.after} ` +
          `(易伤: ${r})`,
      );
    }
    log(`CaluculationNormalDamage return: ${finalDamage}`);
  }

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
