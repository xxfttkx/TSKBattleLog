import { SkillType } from "../common";

export interface SkillEffectInfo {
  /** SkillType 枚举名（如 AtkUp），查不到底值时为原始字符串 */
  type: string;
  /** SkillType 数字底值，与 SkillEffectTypes.json 的 id 同一体系，供宿主查字段含义 */
  t: number;
  time: number;
  value: number;
  effectValue: number;
  value2: number;
  value3: number;
  value4: number;
  value5: number;
}

/**
 * 数据版 skillEffectList 读取（只返回数据、不打日志），
 * 供宿主 GUI 按需查询单位 buff。
 */
export function getSkillEffects(unit: Il2Cpp.Object): SkillEffectInfo[] {
  const skillEffectList = unit.field("skillEffectList").value as Il2Cpp.Object;
  if (skillEffectList.isNull()) return [];

  const size = skillEffectList.field("_size").value as number;
  const items = skillEffectList.field("_items")
    .value as Il2Cpp.Array<Il2Cpp.Object>;

  const out: SkillEffectInfo[] = [];
  for (let i = 0; i < size; i++) {
    const effect = items.get(i);
    const rawType = effect.field("<Type>k__BackingField").value;
    const typeNum = Number(rawType);
    // 枚举底值反查名字，查不到则原样输出
    const type =
      Number.isFinite(typeNum) && (SkillType as any)[typeNum] !== undefined
        ? (SkillType as any)[typeNum]
        : String(rawType);
    out.push({
      type,
      // 优先用底值；部分 enum 字段返回的是枚举对象（toString 给名字），
      // Number() 会得到 NaN，此时用枚举名从 SkillType 双向反查数值
      t: Number.isFinite(typeNum) ? typeNum : ((SkillType as any)[type] ?? -1),
      time: effect.field("<Time>k__BackingField").value as number,
      value: effect.field("<SkillValue1>k__BackingField").value as number,
      effectValue: effect.field("<SkillEffectValue>k__BackingField")
        .value as number,
      value2: effect.field("<SkillValue2>k__BackingField").value as number,
      value3: effect.field("<SkillValue3>k__BackingField").value as number,
      value4: effect.field("<SkillValue4>k__BackingField").value as number,
      value5: effect.field("<SkillValue5>k__BackingField").value as number,
    });
  }
  return out;
}

/**
 * 按游戏内公式计算 EX 上升加成（Ghidra 还原自实际 EX 回复计算）：
 * ExRateUp(+SkillValue1) / ExRateDown(−SkillValue1) /
 * ExRateUpAllyCount / ExRateUpAttrOut / ExRateUpSkillCount(+SkillEffectValue) /
 * ExRateUpSpecific(+SkillValue1)，加成上限 300（不设下限，负值由 total 兜底）。
 */
export function calcExUpBonus(effects: SkillEffectInfo[]): number {
  let bonus = 0;
  for (const e of effects) {
    switch (e.t) {
      case SkillType.ExRateUp:
      case SkillType.ExRateUpSpecific:
        bonus += e.value;
        break;
      case SkillType.ExRateDown:
        bonus -= e.value;
        break;
      case SkillType.ExRateUpAllyCount:
      case SkillType.ExRateUpAttrOut:
      case SkillType.ExRateUpSkillCount:
        bonus += e.effectValue;
        break;
    }
  }
  return Math.min(bonus, 300);
}

/** 实际生效的 exUp 总值：max(0, 基础 + 加成) */
export function calcExUpTotal(base: number, bonus: number): number {
  return Math.max(0, base + bonus);
}
