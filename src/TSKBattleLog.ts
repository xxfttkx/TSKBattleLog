import { TSKBattleNote } from "./TSKBattleNote";
import { dumpArgs, log, dumpObject, getAutoUseSkillIndex } from "./utils";
import { skillMap } from "./common";

enum DamageType {
  Normal = "Normal",
  Skill = "Skill",
  Unison = "Unison",
}

/** CaluculationNormalDamage 单次调用（一段伤害）的细节 */
export interface CalcSegment {
  attackerAddress: string;
  damage: bigint;
  /** AttackType：Normal / Ex / ... */
  kind: string;
  defenderName: string;
  beforeRushCount: number;
  rushCount: number;
  /** 多段序号，从 0 开始 */
  multipleCount: number;
  skillValue: number;
  turn: number;
  /** 落地后由 Set*DamageValue 回填 */
  isCritical?: string;
  damageType?: string;
}

/** 同一次技能动作的多段伤害分组（同攻击者/回合/kind，multipleCount 连续） */
export interface SkillGroup {
  attackerAddress: string;
  attackerName: string;
  kind: string;
  defenderName: string;
  skillValue: number;
  turn: number;
  segments: CalcSegment[];
}

export class TSKBattleLog {
  notes: TSKBattleNote[] = [];
  logs: string[] = [];
  damageTotal: bigint = BigInt(0);
  unisonDamageTotal: bigint = BigInt(0);
  turnCount = 0;

  /** 攻击者地址 -> 已计算但尚未落地的伤害段队列（calc 返回 → Set*DamageValue 落地） */
  private calcQueue = new Map<string, CalcSegment[]>();
  /** 已闭合的技能分组（战斗结束时汇总） */
  private skillGroups: SkillGroup[] = [];

  constructor() {}

  clear(): void {
    this.notes = [];
    this.logs = [];
    this.damageTotal = BigInt(0);
    this.unisonDamageTotal = BigInt(0);
    this.turnCount = 0;
    this.calcQueue.clear();
    this.skillGroups = [];
  }

  onTurnChange(oldVal: number, newVal: number): void {
    this.turnCount = newVal;
    const msg = `[TSKBattleLog] turn ${oldVal} -> ${newVal}`;
    log(msg);
    this.logs.push(msg);
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
        battleNote.characterName,
      );
      const unitNameInSkillMap = autoSkillIndex != -1;
      log(
        `[TSKBattleLog] add note: ${battleNote.toString()}${
          unitNameInSkillMap ? ` (${autoSkillIndex})` : " (not in skill map)"
        }`,
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

  /**
   * CaluculationNormalDamage 返回时调用：记录一段伤害细节并入队等待落地关联。
   * 只统计我方（notes 中有对应 address）的攻击。
   */
  addCalcSegment(seg: CalcSegment): void {
    const note = this.notes.find((n) => n.address === seg.attackerAddress);
    if (!note) return; // 敌方攻击或未初始化，忽略

    const queue = this.calcQueue.get(seg.attackerAddress) ?? [];
    queue.push(seg);
    this.calcQueue.set(seg.attackerAddress, queue);

    // 分组：同攻击者/回合/kind 的最近一组，multipleCount 归 0 则另起一组
    let group = [...this.skillGroups]
      .reverse()
      .find(
        (g) =>
          g.attackerAddress === seg.attackerAddress &&
          g.turn === seg.turn &&
          g.kind === seg.kind,
      );
    if (!group || seg.multipleCount === 0) {
      group = {
        attackerAddress: seg.attackerAddress,
        attackerName: note.getName(),
        kind: seg.kind,
        defenderName: seg.defenderName,
        skillValue: seg.skillValue,
        turn: seg.turn,
        segments: [],
      };
      this.skillGroups.push(group);
    }
    group.segments.push(seg);
  }

  /**
   * Set*DamageValue 落地时调用：按攻击者地址取出一段 calc 细节（FIFO，
   * 优先匹配伤害值一致的段），用于回填暴击/伤害类型并丰富日志。
   */
  private takeCalcSegment(
    address: string,
    damage: bigint,
  ): CalcSegment | undefined {
    const queue = this.calcQueue.get(address);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex((s) => s.damage === damage);
    if (idx >= 0) return queue.splice(idx, 1)[0];
    return queue.shift();
  }

  addDamageNote(
    address: string,
    damage: string,
    damageType: string,
    isCritical: string = "Unknown",
  ): void {
    let note = this.notes.find((n) => n.address === address);
    if (!note) {
      log(
        `[TSKBattleLog] addDamageNote: note not found for address ${address}`,
      );
      return;
    }
    const damageBigInt = BigInt(damage);
    this.damageTotal += damageBigInt;

    // 关联 calc 细节（多段/防守方/技能倍率），Unison 等不走 calc 的伤害无此细节
    const seg = this.takeCalcSegment(address, damageBigInt);
    if (seg) {
      seg.isCritical = isCritical;
      seg.damageType = damageType;
    }
    const segInfo = seg
      ? ` [${seg.kind}#${seg.multipleCount + 1} -> ${seg.defenderName} sv=${seg.skillValue.toFixed(2)}]`
      : "";

    let logMessage = "";
    if (damageType === DamageType.Unison) {
      logMessage = `[TSKBattleLog] Unison Attack: damage=${damageBigInt} damageTotal=${this.damageTotal}`;
    } else {
      logMessage = `[TSKBattleLog] addDamageNote[${
        note?.getName() ?? address
      }]: damage=${damageBigInt}, critical = ${isCritical}, damageType=${damageType}, damageTotal=${
        this.damageTotal
      }${segInfo}`;
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
      `[TSKBattleLog] ${note!.getName()} damage:${note.damage}(${percentage})`,
    );
  }

  toString(): string {
    return this.logs.join("\n");
  }

  onEndBattle(): void {
    log(
      `[TSKBattleLog] onEndBattle: total damage=${this.damageTotal}, turns=${this.turnCount}`,
    );
    for (const note of this.notes) {
      const value = Number(note.damage) / Number(this.damageTotal);
      const percentage = `${(value * 100).toFixed(0)}%`;
      log(
        `[TSKBattleLog] ${note!.getName()} damage:${note.damage}(${percentage})`,
      );
    }
    const unisonValue =
      Number(this.unisonDamageTotal) / Number(this.damageTotal);
    const unisonPercentage = `${(unisonValue * 100).toFixed(0)}%`;
    log(
      `[TSKBattleLog] unison damage=${this.unisonDamageTotal}(${unisonPercentage})`,
    );

    // 技能分组汇总：多段伤害整合展示
    for (const g of this.skillGroups) {
      const total = g.segments.reduce((acc, s) => acc + s.damage, BigInt(0));
      const crits = g.segments.filter((s) => s.isCritical === "True").length;
      const hits = g.segments.length;
      log(
        `[TSKBattleLog] ${g.attackerName} ${g.kind} -> ${g.defenderName}: ${hits} hit${
          hits > 1 ? "s" : ""
        }, damage=${total}, crit=${crits}, sv=${g.skillValue.toFixed(2)}, turn=${g.turn}`,
      );
    }
  }
}
