import { BattleMode } from "../common";
import { log, getNameByTSKBattleNote } from "../utils";
import { TSKBattleLog } from "../TSKBattleLog";
import {
  Mod,
  MethodEnterHandler,
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
    traceMethodByName(
      image,
      "TSKBattleAttack",
      "SetDamageNormal",
      this,
      this.handleSetDamageNormal,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetDamageValue",
      this,
      this.handleSetDamageValue,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetSkillDamageValue",
      this,
      this.handleSetSkillDamageValue,
    );
    traceMethodByName(
      image,
      "TSKBattleNote",
      "SetUnisonDamageValue",
      this,
      this.handleSetUnisonDamageValue,
    );

    // 需要 dump 参数时取消注释：
    // traceMethodByName(image, "TSKBattleNote", "SetDamage", dumpArgsHandler);
    // traceMethodByName(image, "DamageText", "PlayDamage", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "SetMultiDanameTextView", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "Execute", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "ExecuteWholeMulti", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "SetSkillEffect", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "StartSkillDamage", dumpArgsHandler);

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
      log()
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
    log(`SetSkillDamageValue: value=${value} attackAddress=${attackAddress}`);
    this.tskBattleLog.addDamageNote(attackAddress, value, "Skill", isCritical);
  };

  private handleSetDamageValue: MethodEnterHandler = (_cls, _method, args) => {
    const value = args[1].toString();
    const attackAddress = args[5].toString();
    const isCritical = args[4].toInt32() != 0 ? "True" : "False";
    log(`SetDamageValue: value=${value} attackAddress=${attackAddress}`);
    this.tskBattleLog.addDamageNote(attackAddress, value, "Normal", isCritical);
  };

  private handleSetUnisonDamageValue: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    log(`SetUnisonDamageValue: value=${value} attackAddress=${attackAddress}`);
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
