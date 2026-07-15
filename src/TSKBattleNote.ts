export class TSKBattleNote {
  /** UnitName */
  unitName: string;

  /** CharacterName */
  characterName: string;

  /** il2cpp对象地址 */
  address: string;

  /** 伤害 */
  damage: bigint;

  addDamage(damage: bigint): void {
    this.damage += damage;
  }

  constructor() {
    this.unitName = "";
    this.characterName = "";
    this.address = "";
    this.damage = BigInt(0);
  }

  clear(): void {
    this.unitName = "";
    this.characterName = "";
    this.address = "";
    this.damage = BigInt(0);
  }

  clone(): TSKBattleNote {
    const note = new TSKBattleNote();
    note.unitName = this.unitName;
    note.characterName = this.characterName;
    note.address = this.address;
    note.damage = this.damage;
    return note;
  }

  toString(): string {
    return `[address:${this.address}] ${this.unitName} (${this.characterName}) damage=${this.damage}`;
  }

  getName(): string {
    return `${this.unitName} (${this.characterName})`;
  }
}
