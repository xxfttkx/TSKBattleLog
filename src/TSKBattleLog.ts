import { TSKBattleNote } from "./TSKBattleNote";
import { dumpArgs, log, dumpObject, getAutoUseSkillIndex } from "./utils";
import { skillMap } from "./common";

enum DamageType {
  Normal = "Normal",
  Skill = "Skill",
  Unison = "Unison",
}

export class TSKBattleLog {
  notes: TSKBattleNote[] = [];
  logs: string[] = [];
  damageTotal: bigint = BigInt(0);
  unisonDamageTotal: bigint = BigInt(0);

  constructor() {}

  clear(): void {
    this.notes = [];
    this.logs = [];
    this.damageTotal = BigInt(0);
    this.unisonDamageTotal = BigInt(0);
  }

  init(notes: Il2Cpp.Array<Il2Cpp.Object>): void {
    this.clear();
    for (const note of notes) {
      const battleNote = new TSKBattleNote();
      const unitData = note.field("<UnitData>k__BackingField")
        .value as Il2Cpp.Object;
      battleNote.initByUnitData(unitData);
      battleNote.address = note.handle.toString();
      this.notes.push(battleNote);
      const autoSkillIndex = getAutoUseSkillIndex(
        battleNote.unitName,
        battleNote.characterName
      );
      const unitNameInSkillMap = autoSkillIndex != -1;
      log(
        `[TSKBattleLog] add note: ${battleNote.toString()}${
          unitNameInSkillMap ? ` (${autoSkillIndex})` : " (not in skill map)"
        }`
      );
    }
    log(`[TSKBattleLog] Init complete: notes=${this.notes.length}`);
    for (const note of this.notes) {
      note.logUnitData();
    }
    let totalEx = 0;
    for (const note of this.notes) {
      totalEx += note.ex;
    }
    log(`战斗初始EX: ${totalEx}`);
    log(`一巡可使用EX: ${this.getTotalNormalAttackExRate() + 40 * 5}`);
  }

  getTotalNormalAttackExRate(): number {
    let totalExRate = 0;
    for (const note of this.notes) {
      totalExRate += note.getNormalAttackExRate();
    }
    return totalExRate;
  }

  addDamageNote(
    address: string,
    damage: string,
    damageType: string,
    isCritical: string = "Unknown"
  ): void {
    let note = this.notes.find((n) => n.address === address);
    if (!note) {
      log(
        `[TSKBattleLog] addDamageNote: note not found for address ${address}`
      );
      return;
    }
    const damageBigInt = BigInt(damage);
    this.damageTotal += damageBigInt;
    let logMessage = "";
    if (damageType === DamageType.Unison) {
      logMessage = `[TSKBattleLog] Unison Attack: damage=${damageBigInt} damageTotal=${this.damageTotal}`;
    } else {
      logMessage = `[TSKBattleLog] addDamageNote[${
        note?.getName() ?? address
      }]: damage=${damageBigInt}, critical = ${isCritical}, damageType=${damageType}, damageTotal=${
        this.damageTotal
      }`;
    }
    log(logMessage);
    this.logs.push(logMessage);

    if (damageType === DamageType.Unison) {
      this.unisonDamageTotal += damageBigInt;
      return;
    }
    note!.addDamage(damageBigInt);
    const value = Number(note.damage) / Number(this.damageTotal);
    const percentage = `${(value * 100).toFixed(0)}%`;
    log(
      `[TSKBattleLog] ${note!.getName()} damage:${note.damage}(${percentage})`
    );
  }

  toString(): string {
    return this.logs.join("\n");
  }

  onEndBattle(): void {
    log(`[TSKBattleLog] onEndBattle: total damage=${this.damageTotal}`);
    for (const note of this.notes) {
      const value = Number(note.damage) / Number(this.damageTotal);
      const percentage = `${(value * 100).toFixed(0)}%`;
      log(
        `[TSKBattleLog] ${note!.getName()} damage:${note.damage}(${percentage})`
      );
    }
    const unisonValue =
      Number(this.unisonDamageTotal) / Number(this.damageTotal);
    const unisonPercentage = `${(unisonValue * 100).toFixed(0)}%`;
    log(
      `[TSKBattleLog] unison damage=${this.unisonDamageTotal}(${unisonPercentage})`
    );
  }
}
