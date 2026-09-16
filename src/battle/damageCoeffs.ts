import { AbilityCompatibility } from "../common";
import { readFloatReturn } from "../utils";
import { Mod, traceMethodByName } from "../mod";

/** 一次 CaluculationNormalDamage 内采集到的各乘区系数 */
export interface CalcCoeffs {
  /** 乱数偏移 */
  fluctuation?: number;
  /** 连击（Rush）偏移 */
  rush?: number;
  /** 属性克制偏移 */
  attribute?: { value: number; compatibility: string };
  /** 暴击偏移 */
  critical?: { value: number; isCritical: boolean };
  /** 击倒（Down）偏移 */
  down?: number;
  /** 易伤：GetDamageRateValue 变换前/后与倍率。before/after 为 int64 原值
   *  用 string 存（JSON 安全），rate 为浮点比值 */
  damageRate?: { before: string; after: string; rate: number };
  /** 被动伤害率 */
  passive?: number;
}

/** 外层 CaluculationNormalDamage 的入参与攻击方快照（供详情展示/控制台格式化） */
export interface CalcInputSnapshot {
  beforeRushCount: number;
  rushCount: number;
  skillValue: number;
  kind: string;
  criticalUp: number;
  targetCount: number;
  multipleCount: number;
  baseAttack: number;
  attack: number;
  critical: number;
  teamType: string;
  attackerName: string;
}

interface Bag {
  fluctuation?: number;
  rush?: number;
  attributeValue?: number;
  compatibility?: number;
  criticalValue?: number;
  isCritical?: boolean;
  down?: number;
  rateBefore?: bigint;
  rateAfter?: bigint;
  passive?: number;
}

/**
 * 伤害系数采集器（单例）。
 *
 * 7 个系数方法都在 CaluculationNormalDamage 函数体内被同步调用，因此用
 * begin()/end() 包住外层调用即可完成关联，无需按线程 id 映射；用栈而非单
 * bag 是为了容忍理论上的嵌套调用。游戏内部会对部分系数二次求值（两次结果
 * 相同），bag 全部采用「第一次调用为准」。
 *
 * 采集由 battle-log 驱动（数据进 CalcSegment，宿主「战斗日志」窗口展示）。
 */
class DamageCoeffCollector {
  private stack: Bag[] = [];
  private installed = false;

  /** 注册 7 个系数 hook（quiet），只装一次；mod 为驱动方（battle-log） */
  install(image: Il2Cpp.Image, mod: Mod): void {
    if (this.installed) return;
    this.installed = true;

    // 5 个 Offset 都是 private static float，返回值走 XMM0
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "FluctuationOffset",
      mod,
      undefined,
      (_c, _m, _r, _inv, ctx) => {
        const bag = this.top();
        if (bag && bag.fluctuation === undefined) {
          bag.fluctuation = readFloatReturn(ctx);
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "RushOffset",
      mod,
      undefined,
      (_c, _m, _r, _inv, ctx) => {
        const bag = this.top();
        if (bag && bag.rush === undefined) {
          bag.rush = readFloatReturn(ctx);
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "AttributeOffset",
      mod,
      // private static float AttributeOffset(AbilityCompatibility compatibility, TSKBattleNote note, int beforeRushCount)
      // static 无 this：args[0] 即第一个真实参数，小值域枚举按字节掩码
      (_cls, _m, args) => {
        const bag = this.top();
        if (bag && bag.compatibility === undefined) {
          bag.compatibility = args[0].toInt32() & 0xff;
        }
      },
      (_c, _m, _r, _inv, ctx) => {
        const bag = this.top();
        if (bag && bag.attributeValue === undefined) {
          bag.attributeValue = readFloatReturn(ctx);
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "CriticalOffset",
      mod,
      // private static float CriticalOffset(bool isCritilal, TSKBattleNote note, ...)
      (_cls, _m, args) => {
        const bag = this.top();
        if (bag && bag.isCritical === undefined) {
          // bool 高 24 位不可信，按字节掩码
          bag.isCritical = (args[0].toInt32() & 0xff) !== 0;
        }
      },
      (_c, _m, _r, _inv, ctx) => {
        const bag = this.top();
        if (bag && bag.criticalValue === undefined) {
          bag.criticalValue = readFloatReturn(ctx);
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "DownOffset",
      mod,
      undefined,
      (_c, _m, _r, _inv, ctx) => {
        const bag = this.top();
        if (bag && bag.down === undefined) {
          bag.down = readFloatReturn(ctx);
        }
      },
      true,
    );
    // 实例方法：args[0]=this，args[1]=伤害基数(int64)
    traceMethodByName(
      image,
      "TSKBattleNote",
      "GetDamageRateValue",
      mod,
      (_cls, _m, args) => {
        const bag = this.top();
        if (bag && bag.rateBefore === undefined) {
          // int64 参数：NativePointer 是无符号的，用 toString() 转 BigInt
          // 保留 64 位精度（高练度伤害可能超 2^53）
          bag.rateBefore = BigInt(args[1].toString());
        }
      },
      (_c, _m, retval) => {
        const bag = this.top();
        if (bag && bag.rateAfter === undefined) {
          bag.rateAfter = BigInt(retval.toString());
        }
      },
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "GetPassiveDamageRate",
      mod,
      undefined,
      (_c, _m, retval) => {
        const bag = this.top();
        if (bag && bag.passive === undefined) {
          bag.passive = Number(retval);
        }
      },
      true,
    );
  }

  /** 外层 CaluculationNormalDamage onEnter：压入新 bag */
  begin(): void {
    this.stack.push({});
  }

  /** 外层 onLeave：弹出 bag 物化为系数，返回给数据管线 */
  end(): CalcCoeffs | undefined {
    const bag = this.stack.pop();
    if (!bag) return undefined;
    return materialize(bag);
  }

  private top(): Bag | undefined {
    return this.stack[this.stack.length - 1];
  }
}

function materialize(bag: Bag): CalcCoeffs {
  const coeffs: CalcCoeffs = {};
  if (bag.fluctuation !== undefined) coeffs.fluctuation = bag.fluctuation;
  if (bag.rush !== undefined) coeffs.rush = bag.rush;
  if (bag.attributeValue !== undefined) {
    const raw = bag.compatibility ?? 0;
    coeffs.attribute = {
      value: bag.attributeValue,
      compatibility: AbilityCompatibility[raw] ?? `raw:${raw}`,
    };
  }
  if (bag.criticalValue !== undefined) {
    coeffs.critical = {
      value: bag.criticalValue,
      isCritical: bag.isCritical ?? false,
    };
  }
  if (bag.down !== undefined) coeffs.down = bag.down;
  if (bag.rateBefore !== undefined && bag.rateAfter !== undefined) {
    // 比值用 number 计算（浮点除法）：即使原值超 2^53，比值相对误差极小
    const beforeNum = Number(bag.rateBefore);
    const afterNum = Number(bag.rateAfter);
    coeffs.damageRate = {
      before: bag.rateBefore.toString(),
      after: bag.rateAfter.toString(),
      rate: beforeNum > 0 ? afterNum / beforeNum : NaN,
    };
  }
  if (bag.passive !== undefined) coeffs.passive = bag.passive;
  return coeffs;
}

export const damageCoeffs = new DamageCoeffCollector();
