import { TSKBattleNote } from "./TSKBattleNote";
import { log } from "./utils";
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

  constructor() {}

  clear(): void {
    this.notes = [];
    this.logs = [];
    this.damageTotal = BigInt(0);
  }

  init(notes: Il2Cpp.Array<Il2Cpp.Object>): void {
    this.clear();
    for (const note of notes) {
      const battleNote = new TSKBattleNote();
      const unitData = note.field("<UnitData>k__BackingField")
        .value as Il2Cpp.Object;
      battleNote.unitName =
        (unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String)
          .content ?? "Unknown UnitName";
      battleNote.characterName =
        (
          unitData.field("<CharacterName>k__BackingField")
            .value as Il2Cpp.String
        ).content ?? "Unknown CharacterName";
      battleNote.address = note.handle.toString();
      this.notes.push(battleNote);
      const unitNameInSkillMap = skillMap.has(battleNote.unitName);
      log(
        `[TSKBattleLog] add: note=${battleNote.toString()}${
          unitNameInSkillMap ? "" : " (not in map)"
        }`
      );
    }
    log(`[TSKBattleLog] init: notes=${this.notes.length}`);
  }

  addDamageNote(address: string, damage: string, damageType: string): void {
    let note = this.notes.find((n) => n.address === address);
    const damageBigInt = BigInt(damage);
    this.damageTotal += damageBigInt;
    log(
      `[TSKBattleLog] addDamageNote: address=${address}, damage=${damageBigInt}, damageType=${damageType}, damageTotal=${this.damageTotal}`
    );
    if (!note) {
      log(
        `[TSKBattleLog] addDamageNote: note not found for address ${address}`
      );

      return;
    }
    if (damageType === DamageType.Unison) {
      // tototo do: 处理Unison伤害类型
      return;
    }
    note!.addDamage(damageBigInt);
    const value = Number(note.damage) / Number(this.damageTotal);
    const percentage = `${(value * 100).toFixed(0)}%`;
    log(
      `[TSKBattleLog] ${note!.getName()} damage:${note.damage}(${percentage})`
    );
    this.logs.push(`[${damageType}] ${note!.toString()}`);
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
  }
}
