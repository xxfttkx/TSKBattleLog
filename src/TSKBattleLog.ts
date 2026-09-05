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
  defenderAddress: string;
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

/** 同一次技能动作的多段伤害分组（同攻击者/回合/kind/目标，multipleCount 连续） */
export interface SkillGroup {
  attackerAddress: string;
  attackerName: string;
  kind: string;
  defenderAddress: string;
  defenderName: string;
  skillValue: number;
  turn: number;
  segments: CalcSegment[];
  /** 是否已输出汇总日志 */
  printed?: boolean;
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
  /** 当前正在输出的攻击者，用于检测攻击者切换并 flush 分组 */
  private currentAttacker?: string;

  constructor() {}

  clear(): void {
    this.notes = [];
    this.logs = [];
    this.damageTotal = BigInt(0);
    this.unisonDamageTotal = BigInt(0);
    this.turnCount = 0;
    this.calcQueue.clear();
    this.skillGroups = [];
    this.currentAttacker = undefined;
  }

  onTurnChange(oldVal: number, newVal: number): void {
    // 回合切换视为上一回合所有动作结束，先输出未 flush 的分组
    this.flushGroups();
    this.turnCount = newVal;
    const msg = `[TSKBattleLog] turn ${oldVal} -> ${newVal}    damageTotal=${this.damageTotal}`;
    log(msg);
    this.logs.push(msg);
    let damageMsg = ``;
    for (const note of this.notes) {
      const percentage = this.getDamagePercentage(note.damage);
      damageMsg += `${note.characterName}(${percentage}) `;
    }
    log(damageMsg);
    this.logs.push(damageMsg);
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
   * 攻击者切换时 flush 之前攻击者的分组汇总。
   */
  addCalcSegment(seg: CalcSegment): void {
    const note = this.notes.find((n) => n.address === seg.attackerAddress);
    if (!note) return; // 敌方攻击或未初始化，忽略

    // 攻击者切换：上一个攻击者的动作已结束，输出其分组汇总
    if (this.currentAttacker !== seg.attackerAddress) {
      this.flushGroups();
      this.currentAttacker = seg.attackerAddress;
    }

    const queue = this.calcQueue.get(seg.attackerAddress) ?? [];
    queue.push(seg);
    this.calcQueue.set(seg.attackerAddress, queue);

    // 分组：同攻击者/回合/kind/目标的最近一组，multipleCount 归 0 则另起一组
    let group = [...this.skillGroups]
      .reverse()
      .find(
        (g) =>
          g.attackerAddress === seg.attackerAddress &&
          g.turn === seg.turn &&
          g.kind === seg.kind &&
          g.defenderAddress === seg.defenderAddress,
      );
    if (!group || seg.multipleCount === 0) {
      group = {
        attackerAddress: seg.attackerAddress,
        attackerName: note.getName(),
        kind: seg.kind,
        defenderAddress: seg.defenderAddress,
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
   * 输出尚未输出的技能分组汇总。
   * @param kind 只输出指定 kind 的组（如 "Normal"）；不传则输出全部
   */
  flushGroups(kind?: string): void {
    for (const g of this.skillGroups) {
      if (g.printed) continue;
      if (kind !== undefined && g.kind !== kind) continue;
      g.printed = true;
      const total = g.segments.reduce((acc, s) => acc + s.damage, BigInt(0));
      const crits = g.segments.filter((s) => s.isCritical === "True").length;
      const hits = g.segments.length;
      const msg =
        `[TSKBattleLog] ${g.attackerName} ${g.kind} -> ${g.defenderName}: ` +
        `${hits} hit${hits > 1 ? "s" : ""}, damage=${total}, crit=${crits}` +
        `, sv=${g.skillValue.toFixed(2)}`;
      log(msg);
      this.logs.push(msg);
    }
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
    const note = this.notes.find((n) => n.address === address);
    if (!note) {
      log(
        `[TSKBattleLog] addDamageNote: note not found for address ${address}`,
      );
      return;
    }
    const damageBigInt = BigInt(damage);
    this.damageTotal += damageBigInt;

    // 关联 calc 细节（多段/防守方/技能倍率），暴击回填到段上
    const seg = this.takeCalcSegment(address, damageBigInt);
    if (seg) {
      seg.isCritical = isCritical;
      seg.damageType = damageType;
    }

    if (damageType === DamageType.Unison) {
      // Unison 视为该攻击者动作的收尾：先 flush 挂着的分组，保证
      // 分组汇总显示在 Unison 之前（与实际动作顺序一致）
      this.flushGroups();
      this.currentAttacker = address;
      this.unisonDamageTotal += damageBigInt;
      log(
        `[TSKBattleLog] Unison Attack[${note.getName()}]: damage=${damageBigInt}`,
      );
      return;
    }
    note.addDamage(damageBigInt);

    // Normal 必为单段，落地（暴击已回填）后立即输出
    if (damageType === DamageType.Normal) {
      this.flushGroups("Normal");
    }
  }

  toString(): string {
    return this.logs.join("\n");
  }

  onEndBattle(): void {
    // 兜底：战斗结束时最后攻击者的分组可能还没 flush
    this.flushGroups();
    log(
      `[TSKBattleLog] onEndBattle: total damage=${this.damageTotal}, turns=${this.turnCount}`,
    );
    for (const note of this.notes) {
      const percentage = this.getDamagePercentage(note.damage);
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
  }

  getDamagePercentage(damage: bigint): string {
    const value = Number(damage) / Number(this.damageTotal);
    return `${(value * 100).toFixed(0)}%`;
  }
}
