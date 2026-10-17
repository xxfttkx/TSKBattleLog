import { log } from "../utils";

export class TSKBattleNote {
  /** UnitName */
  unitName: string;

  /** CharacterName */
  characterName: string;

  /** il2cpp对象地址 */
  address: string;

  /** 伤害 */
  damage: bigint;

  /** 属性 AttrType：1=炎 2=水 3=雷 4=光 5=闇，0=未知 */
  attr: number;

  ex: number;
  /** ExGaugeRate 基础值（不含技能效果加成） */
  exUp: number;
  /** EX 上升加成（6 类技能效果累计、上限 300；init 时由 skillEffectList 计算） */
  exUpBonus: number;
  hp: number;
  atk: number;
  critical: number;

  init(unitData: Il2Cpp.Object): void {
    this.unitName =
      (unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String)
        .content ?? "Unknown UnitName";
    this.characterName =
      (unitData.field("<CharacterName>k__BackingField").value as Il2Cpp.String)
        .content ?? "Unknown CharacterName";
    this.ex = unitData.field("<InitExGauge>k__BackingField").value as number;
    this.exUp = unitData.field("<ExGaugeRate>k__BackingField").value as number;
    this.hp = unitData.field("<HP>k__BackingField").value as number;
    this.atk = unitData.field("<Attack>k__BackingField").value as number;
    this.critical = unitData.field("<Critical>k__BackingField").value as number;
    // AttrType：1=炎 2=水 3=雷 4=光 5=闇。优先 field 名，失败回退 offset 0x34
    try {
      this.attr = unitData.field("<AttrType>k__BackingField").value as number;
      if (typeof this.attr !== "number") this.attr = 0;
    } catch {
      try {
        this.attr = unitData.handle.add(0x34).readS32();
      } catch {
        this.attr = 0;
      }
    }
  }

  addDamage(damage: bigint): void {
    this.damage += damage;
  }

  constructor() {
    this.unitName = "";
    this.characterName = "";
    this.address = "";
    this.damage = BigInt(0);
    this.attr = 0;
    this.ex = 0;
    this.exUp = 0;
    this.exUpBonus = 0;
    this.hp = 0;
    this.atk = 0;
    this.critical = 0;
  }

  logUnitData(): void {
    // 加成非 0 时以 exUp=117(+30) 形式附带，便于核对 init 时 skillEffectList 是否已挂上
    const exUpStr = `${this.exUp}${
      this.exUpBonus
        ? `(${this.exUpBonus > 0 ? "+" : ""}${this.exUpBonus})`
        : ""
    }`;
    log(
      `${this.getName()}: ex=${this.ex} exUp=${exUpStr} hp=${this.hp} atk=${
        this.atk
      } critical=${
        this.critical
      } 通常攻击回复EX: ${this.getNormalAttackExRate()}`,
    );
  }

  toString(): string {
    return `${this.getName()} damage=${this.damage}`;
  }

  /** 实际生效的 exUp：max(0, 基础 + 加成) */
  getExUpTotal(): number {
    return Math.max(0, this.exUp + this.exUpBonus);
  }

  /** 普攻回复 EX：等价于 40 × (1 + (total−50)/150)，total 为生效值（含加成） */
  getNormalAttackExRate(): number {
    return Math.ceil((100 + this.getExUpTotal()) / 3.75);
  }

  getName(): string {
    return `[${this.unitName}] ${this.characterName}`;
  }

  getAttr(): number {
    return this.attr;
  }
}
