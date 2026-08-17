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
  }

  addDamage(damage: bigint): void {
    this.damage += damage;
  }

  constructor() {
    this.unitName = "";
    this.characterName = "";
    this.address = "";
    this.damage = BigInt(0);
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
      } 通常攻击回复EX: ${this.getNormalAttackExRate()}`
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
}
