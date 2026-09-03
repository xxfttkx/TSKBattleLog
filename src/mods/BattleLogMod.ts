import { AttackType, BattleMode } from "../common";
import { log, getNameByTSKBattleNote, parseArgument } from "../utils";
import { TSKBattleLog, CalcSegment } from "../TSKBattleLog";
import {
  Mod,
  MethodEnterHandler,
  MethodLeaveHandler,
  traceMethodByName,
  dumpArgsHandler,
} from "../mod";

/** 战斗伤害统计（观察型） */
export class BattleLogMod implements Mod {
  name = "battle-log";
  category = "观察" as const;
  description = "战斗中与结束时输出各单位伤害";
  enabled = true;

  private tskBattleLog = new TSKBattleLog();

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TSKBattleTeam",
      "Initialize",
      this,
      this.handleInitialize,
    );
    traceMethodByName(image, "TSKBattleManager", "InitializeResult", this, () =>
      this.tskBattleLog.onEndBattle(),
    );
    // Set*DamageValue：quiet hook，只做累计+暴击回填，日志由 flushGroups 统一输出
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetDamageValue",
      this,
      this.handleSetDamageValue,
      undefined,
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetSkillDamageValue",
      this,
      this.handleSetSkillDamageValue,
      undefined,
      true,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetUnisonDamageValue",
      this,
      this.handleSetUnisonDamageValue,
      undefined,
      true,
    );

    // 需要 dump 参数时取消注释：
    // traceMethodByName(image, "TSKBattleNote", "SetDamage", dumpArgsHandler);
    // traceMethodByName(image, "DamageText", "PlayDamage", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "SetMultiDanameTextView", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "Execute", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "ExecuteWholeMulti", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "SetSkillEffect", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "StartSkillDamage", dumpArgsHandler);

    // CaluculationNormalDamage：quiet hook（进出日志由 damage-calc-trace 打印），
    // 仅采集段细节（防守方/多段序号/skillValue）供 Set*DamageValue 落地时关联
    traceMethodByName(
      image,
      "TSKBattleCalculationManager",
      "CaluculationNormalDamage",
      this,
      this.handleCalcDamageEnter,
      this.handleCalcDamageLeave,
      true,
    );

    // 回合计数：hook BattleUpdate，对比 turnCount 变化
    this.setupTurnCountHook(image);
  }

  private setupTurnCountHook(image: Il2Cpp.Image): void {
    const cls = image.class("TSKBattleMain");
    if (!cls) {
      log("[battle-log] TSKBattleMain not found, skip turn count");
      return;
    }

    let offset: number;
    try {
      offset = cls.field("turnCount").offset;
    } catch {
      offset = 0x19c;
      log("[battle-log] turnCount field not found via API, fallback to 0x19c");
    }

    const method = cls.method("BattleUpdate");
    if (!method || method.virtualAddress.isNull()) {
      log("[battle-log] BattleUpdate not found, skip turn count");
      return;
    }

    const self = this;
    Interceptor.attach(method.virtualAddress, {
      onEnter(args) {
        (this as any)._instance = args[0];
        (this as any)._oldTurn = args[0].add(offset).readS32();
      },
      onLeave() {
        if (!self.enabled) return;
        const oldVal = (this as any)._oldTurn as number;
        const newVal = (this as any)._instance.add(offset).readS32();
        if (newVal !== oldVal) {
          self.tskBattleLog.onTurnChange(oldVal, newVal);
        }
      },
    });
  }

  // ===== CaluculationNormalDamage 段细节采集（quiet hook）=====

  private handleCalcDamageEnter: MethodEnterHandler = (
    _cls,
    _method,
    args,
    _ctx,
    invocation,
  ) => {
    const ctx = invocation as any;
    ctx._calcAttackerAddr = args[0].toString();
    const defence = new Il2Cpp.Object(args[1]);
    ctx._calcDefenderName = getNameByTSKBattleNote(defence);
    ctx._calcKind =
      AttackType[parseArgument(args[8], "enum") as number] ?? "Unknown";
    ctx._calcBeforeRush = args[2].toInt32();
    ctx._calcRush = args[3].toInt32();
    ctx._calcMultiple = parseArgument(args[11], "int") as number;
    ctx._calcSkillValue = parseArgument(args[4], "float") as number;
  };

  private handleCalcDamageLeave: MethodLeaveHandler = (
    _cls,
    _method,
    retval,
    invocation,
  ) => {
    const ctx = invocation as any;
    if (ctx._calcAttackerAddr === undefined) return;
    const seg: CalcSegment = {
      attackerAddress: ctx._calcAttackerAddr,
      damage: BigInt(retval.toString()),
      kind: ctx._calcKind,
      defenderName: ctx._calcDefenderName,
      beforeRushCount: ctx._calcBeforeRush,
      rushCount: ctx._calcRush,
      multipleCount: ctx._calcMultiple,
      skillValue: ctx._calcSkillValue,
      turn: this.tskBattleLog.turnCount,
    };
    this.tskBattleLog.addCalcSegment(seg);
  };

  private handleInitialize: MethodEnterHandler = (_cls, _method, args) => {
    const hp = parseInt(args[1].toString(), 16);
    const maxHp = parseInt(args[2].toString(), 16);
    const stun = parseInt(args[3].toString(), 16);
    const notesList = new Il2Cpp.Object(args[4]);

    const notes = notesList.field("_items")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    const notesSize = notesList.field("_size").value as number;
    const type = parseInt(args[5].toString(), 16);
    const mode = parseInt(args[6].toString(), 16);
    const overHealRate = parseInt(args[7].toString(), 16);
    // 直接使用枚举的反向映射
    const modeName = BattleMode[mode]; // "DamageChallengeAtMode"
    const teamType = type == 0 ? "Player" : type == 1 ? "Enemy" : "Unknown";
    if (teamType === "Unknown") {
      log(`Unknown team type: ${type}`);
    }

    log(
      `${teamType} Initialize: hp=${hp} maxHp=${maxHp} stun=${stun} notes.length=${notesSize} mode=${modeName} overHealRate=${overHealRate}`,
    );

    if (teamType === "Player" || teamType === "Unknown") {
      this.tskBattleLog.init(notes);
    }
  };

  private handleSetSkillDamageValue: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    const isCritical = args[8].toInt32() != 0 ? "True" : "False";
    this.tskBattleLog.addDamageNote(attackAddress, value, "Skill", isCritical);
  };

  private handleSetDamageValue: MethodEnterHandler = (_cls, _method, args) => {
    const value = args[1].toString();
    const attackAddress = args[5].toString();
    const isCritical = args[4].toInt32() != 0 ? "True" : "False";
    this.tskBattleLog.addDamageNote(attackAddress, value, "Normal", isCritical);
  };

  private handleSetUnisonDamageValue: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    this.tskBattleLog.addDamageNote(attackAddress, value, "Unison");
  };

  private handleSetDamageNormal: MethodEnterHandler = (_cls, _method, args) => {
    const attack = new Il2Cpp.Object(args[1]); //TSKBattleNote
    const target = new Il2Cpp.Object(args[2]);
    log(
      `SetDamageNormal: ${getNameByTSKBattleNote(
        attack,
      )} -> ${getNameByTSKBattleNote(target)}`,
    );
  };
}
