import { log } from "./utils";

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
  exUp: number;
  hp: number;
  atk: number;
  critical: number;

  initByUnitData(unitData: Il2Cpp.Object): void {
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
    this.hp = 0;
    this.atk = 0;
    this.critical = 0;
  }

  logUnitData(): void {
    log(
      `${this.getName()}: ex=${this.ex} exUp=${this.exUp} hp=${this.hp} atk=${
        this.atk
      } critical=${
        this.critical
      } 通常攻击回复EX: ${this.getNormalAttackExRate()}`,
    );
  }

  toString(): string {
    return `${this.getName()} damage=${this.damage}`;
  }

  getNormalAttackExRate(): number {
    return Math.ceil((100 + this.exUp) / 3.75);
  }

  getName(): string {
    return `[${this.unitName}] ${this.characterName}`;
  }

  getAttr(): number {
    return this.attr;
  }
}
