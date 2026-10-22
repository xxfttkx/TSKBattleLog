import { AttackType, BattleMode, TeamType } from "../common";
import {
  log,
  logDebug,
  isDebugLog,
  getNameByTSKBattleNote,
  getAttrByTSKBattleNote,
  parseArgument,
  sendHost,
} from "../utils";
import {
  TSKBattleLog,
  BattleLogSnapshot,
  CalcSegment,
} from "../battle/TSKBattleLog";
import {
  Mod,
  MethodEnterHandler,
  MethodLeaveHandler,
  traceMethodByName,
  dumpArgsHandler,
} from "../mod";
import { gaugeViewOnTop } from "../debug/gaugeTop";
import { damageCoeffs, CalcInputSnapshot } from "../battle/damageCoeffs";
import { subscribeApi } from "../apiBus";

/** 战斗伤害统计（观察型） */
export class BattleLogMod implements Mod {
  name = "battle-log";
  category = "观察" as const;
  description = "打印战斗相关各种信息";
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
    traceMethodByName(
      image,
      "TSKBattleManager",
      "InitializeResult",
      this,
      this.handleEndBattle,
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

    // 关卡名数据源：battle/start 响应（需勾 network-capture；未勾时快照无关卡名，历史列表回退显示 mode）
    subscribeApi("battle/start", (body) => {
      const r = (body as any)?.result;
      if (!r) return;
      if (typeof r.quest_name === "string")
        this.tskBattleLog.questName = r.quest_name;
      if (typeof r.stage_name === "string")
        this.tskBattleLog.stageName = r.stage_name;
    });

    // 需要 dump 参数时取消注释：
    // traceMethodByName(image, "TSKBattleNote", "SetDamage", dumpArgsHandler);
    // traceMethodByName(image, "DamageText", "PlayDamage", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "SetMultiDanameTextView", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "Execute", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "ExecuteWholeMulti", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleSkillManager", "SetSkillEffect", dumpArgsHandler);
    // traceMethodByName(image, "TSKBattleTeam", "StartSkillDamage", dumpArgsHandler);

    // CaluculationNormalDamage：quiet hook，
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
    // GetTeam*Count NativeFunction 惰性解析（archive.md「invoke 失败」坑）
    this.resolveTeamCountFns(image);

    // 伤害系数采集器（5 Offset + 易伤 + 被动），数据挂到 CalcSegment.coeffs
    damageCoeffs.install(image, this);
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

  /** TSKBattleNote 4 个 GetTeamXxxCount 的 NativeFunction 表（惰性解析）。
   * 不用 il2cpp-bridge invoke：带 ContainsUnimplementedInstructions，invoke 静默失败
   * （archive.md「il2cpp-bridge invoke 失败」同款坑） */
  private teamCountFns: Partial<
    Record<
      "attackType" | "attr" | "race" | "role",
      (h: NativePointer) => number
    >
  > = {};
  private teamCountResolved = false;
  /** 玩家队 notes List 句柄（Initialize 的 args[4]，type==0 时记录） */
  private playerNotesListHandle: NativePointer | null = null;

  /** 惰性解析 4 个 GetTeamXxxCount 为 NativeFunction，解析失败只警告一次 */
  private resolveTeamCountFns(image: Il2Cpp.Image): void {
    if (this.teamCountResolved) return;
    this.teamCountResolved = true;
    try {
      const cls = image.tryClass("TSKBattleNote");
      if (!cls) {
        log("[battle-log] TSKBattleNote not found, GetTeam*Count disabled");
        return;
      }
      const defs: Array<
        [keyof typeof this.teamCountFns, string, NativeFunctionArgumentType[]]
      > = [
        ["attackType", "GetTeamAttackTypeCount", []],
        // GetTeamAttrCount(bool isMainOnly=false)：默认参数 il2cpp 是调用方填的语法糖，
        // NativeFunction 必须显式传；false=数全队（含 sub），true=只数 main
        ["attr", "GetTeamAttrCount", ["bool"]],
        ["race", "GetTeamRaceCount", []],
        ["role", "GetTeamRoleCount", []],
      ];
      for (const [key, name, extraArgs] of defs) {
        try {
          const m = cls.method(name, extraArgs.length);
          if (!m || m.virtualAddress.isNull()) {
            log(`[battle-log] ${name} address is null`);
            continue;
          }
          const fn = new NativeFunction(m.virtualAddress, "int", [
            "pointer",
            ...extraArgs,
            "pointer",
          ] as NativeFunctionArgumentType[]);
          // 末尾 NULL 是 method_info 槽位；extraArgs 全填默认值（false / 0）
          this.teamCountFns[key] = (h) =>
            (fn as any)(h, ...extraArgs.map(() => 0), NULL) as number;
        } catch (e) {
          log(`[battle-log] resolve ${name} failed: ${e}`);
        }
      }
      log(
        `[battle-log] GetTeam*Count resolved: ${Object.keys(this.teamCountFns).join(",")}`,
      );
    } catch (e) {
      log(`[battle-log] resolve TSKBattleNote failed: ${e}`);
    }
  }

  /** 从我方 notes List 第一项现算 4 个 GetTeam*Count。
   * 只在 snapshot() 被拉取时调用——删除 teamCount 推送后不再周期计算，
   * 战斗日志窗口的「刷新」按钮驱动一次计算，开销可忽略。
   * 失败/战斗中未初始化返回 null */
  private computeTeamCounts(): {
    attackType: number;
    attr: number;
    race: number;
    role: number;
  } | null {
    const fnEntries = Object.entries(this.teamCountFns);
    if (fnEntries.length === 0) return null;
    if (!this.playerNotesListHandle || this.playerNotesListHandle.isNull())
      return null;
    let noteHandle: NativePointer;
    try {
      // List<TSKBattleNote>._items[0] -> note
      const list = new Il2Cpp.Object(this.playerNotesListHandle);
      const items = list.field("_items").value as Il2Cpp.Array<Il2Cpp.Object>;
      if (items.length === 0) return null;
      const note = items.get(0);
      if (!note || note.handle.isNull()) return null;
      noteHandle = note.handle;
    } catch {
      return null;
    }
    const values: Record<string, number> = {};
    for (const [key, fn] of fnEntries) {
      try {
        values[key] = (fn as (h: NativePointer) => number)(noteHandle);
      } catch {
        return null;
      }
    }
    return {
      attackType: values.attackType,
      attr: values.attr,
      race: values.race,
      role: values.role,
    };
  }

  // ===== CaluculationNormalDamage 段细节采集（quiet hook）=====
  // public static long CaluculationNormalDamage(TSKBattleNote attack, TSKBattleNote defence, int beforeRushCount, int rushCount, float skillValue, out bool isCritical, out AbilityCompatibility compatibility, out long rate, AttackType kind, int criticalUp = 0, int targetCount = 1, int multipleCount = 0) { }
  private handleCalcDamageEnter: MethodEnterHandler = (
    _cls,
    _method,
    args,
    _ctx,
    invocation,
  ) => {
    const ctx = invocation as any;
    ctx._calcAttackerAddr = args[0].toString();
    const attack = new Il2Cpp.Object(args[0]);
    const defence = new Il2Cpp.Object(args[1]);
    ctx._calcDefenderAddr = args[1].toString();
    ctx._calcDefenderName = getNameByTSKBattleNote(defence);
    ctx._calcAttackerAttr = getAttrByTSKBattleNote(attack);
    ctx._calcDefenderAttr = getAttrByTSKBattleNote(defence);
    if (isDebugLog()) {
      logDebug(
        `[battle-log] attr attacker=${ctx._calcAttackerAttr}` +
          ` defender=${ctx._calcDefenderAttr}`,
      );
    }
    ctx._calcKind =
      AttackType[parseArgument(args[8], "enum") as number] ?? "Unknown";
    const beforeRushCount = args[2].toInt32();
    const rushCount = args[3].toInt32();
    const skillValue = parseArgument(args[4], "float") as number;
    const criticalUp = parseArgument(args[9], "int") as number;
    const targetCount = parseArgument(args[10], "int") as number;
    const multipleCount = parseArgument(args[11], "int") as number;
    ctx._calcBeforeRush = beforeRushCount;
    ctx._calcRush = rushCount;
    ctx._calcMultiple = multipleCount;
    ctx._calcSkillValue = skillValue;

    // 外层入参/攻击方快照（详情面板 + 控制台订阅者用）。
    // 注意：begin() 必须在这些 invoke 之后——若 getter 内部恰好调用
    // GetDamageRateValue，bag 尚未建立，采集钩子会直接忽略，不会污染。
    const baseAttack = attack.method("GetBaseAttack").invoke() as number;
    const atk = attack.method("GetAttack").invoke(false) as number;
    const crt = attack.method("GetCritical").invoke() as number;
    let teamType = "Unknown";
    try {
      const teamPtr = attack.handle.add(0x28).readPointer();
      teamType = TeamType[teamPtr.add(0x28).readS32()] ?? "Unknown";
    } catch {
      /* 个别调用链 team 可能缺失 */
    }
    const inputs: CalcInputSnapshot = {
      beforeRushCount,
      rushCount,
      skillValue,
      kind: ctx._calcKind,
      criticalUp,
      targetCount,
      multipleCount,
      baseAttack,
      attack: atk,
      critical: crt,
      teamType,
      attackerName: getNameByTSKBattleNote(attack),
    };
    ctx._calcInputs = inputs;
    // 系数 bag 最后打开：onEnter 返回后游戏函数体才开始调用 7 个系数方法
    damageCoeffs.begin();
  };

  private handleCalcDamageLeave: MethodLeaveHandler = (
    _cls,
    _method,
    retval,
    invocation,
  ) => {
    const ctx = invocation as any;
    const finalDamage = BigInt(retval.toString());
    // 系数 bag 收口，物化为系数挂到本段
    const coeffs = ctx._calcInputs ? damageCoeffs.end() : undefined;
    if (ctx._calcAttackerAddr === undefined) return;
    const seg: CalcSegment = {
      attackerAddress: ctx._calcAttackerAddr,
      damage: finalDamage,
      kind: ctx._calcKind,
      attackerAttr: ctx._calcAttackerAttr ?? 0,
      defenderAddress: ctx._calcDefenderAddr,
      defenderName: ctx._calcDefenderName,
      defenderAttr: ctx._calcDefenderAttr ?? 0,
      beforeRushCount: ctx._calcBeforeRush,
      rushCount: ctx._calcRush,
      multipleCount: ctx._calcMultiple,
      skillValue: ctx._calcSkillValue,
      turn: this.tskBattleLog.turnCount,
      baseAttack: ctx._calcInputs?.baseAttack,
      attack: ctx._calcInputs?.attack,
      crit: ctx._calcInputs?.critical,
      criticalUp: ctx._calcInputs?.criticalUp,
      targetCount: ctx._calcInputs?.targetCount,
      teamType: ctx._calcInputs?.teamType,
      coeffs,
    };
    this.tskBattleLog.addCalcSegment(seg);
  };

  /** 宿主「战斗日志」窗口按需拉取当前战斗快照 */
  snapshot(): BattleLogSnapshot {
    // 现算 teamCounts 写入 tskBattleLog（仅此处触发 NativeFunction 调用，
    // 删除 teamCount 推送后平时零开销）
    this.tskBattleLog.teamCounts = this.computeTeamCounts();
    return this.tskBattleLog.snapshot();
  }

  /** 战斗结束：控制台汇总 + 全量快照推宿主落盘（历史回看）。
   *  守卫：只有本场真正有 Player Initialize 且有出击角色时才保存，
   *  避免无玩家信息的 End 事件（误触发/重复 End/只有敌方初始化）落盘脏快照。 */
  private handleEndBattle: MethodEnterHandler = () => {
    // 战斗结束：清空 notes 缓存（下一场 init 才会重填）
    // 先 snapshot（内部现算 teamCounts，此刻 playerNotesListHandle 还有效）再清
    if (this.tskBattleLog.shouldSave()) {
      this.tskBattleLog.onEndBattle();
      sendHost("battleLogEnded", this.snapshot());
    }
    this.playerNotesListHandle = null;
  };

  private handleInitialize: MethodEnterHandler = (_cls, _method, args) => {
    // x64 寄存器槽位高位不可信：int 参数直接 toInt32()，
    // 勿用 parseInt(ptr.toString(),16)——那是把寄存器值当地址解析
    const hp = args[1].toInt32();
    const maxHp = args[2].toInt32();
    const stun = args[3].toInt32();
    // x64 栈槽高位一律不可信（与 bool 参数同一规则）：type/mode 值域 ⊆ 0~7，
    // 只读低 8 位；overHealRate 是 Int32（20000 > 255），读低 32 位
    // 踩坑记录见 notes/archive.md
    const type = args[5].toInt32() & 0xff;
    const mode = args[6].toInt32() & 0xff;
    const overHealRate = args[7].toInt32() >>> 0;

    const notesList = new Il2Cpp.Object(args[4]);
    const notes = notesList.field("_items")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    const notesSize = notesList.field("_size").value as number;
    // 枚举反向映射；低 8 位也脏时显示 raw 值便于诊断
    const modeName = BattleMode[mode] ?? `raw:${mode}`;
    const teamType =
      type == 0 ? "Player" : type == 1 ? "Enemy" : `Unknown(type=${type})`;
    if (type != 0 && type != 1) {
      log(`Unknown team type: ${type}`);
    }

    log(
      `${teamType} Initialize: hp=${hp} maxHp=${maxHp} stun=${stun} notes.length=${notesSize} mode=${modeName} overHealRate=${overHealRate}`,
    );

    // 收集双方单位（玩家头像栏 / 敌人紧凑条 / buff 查看入口共用）
    const units: {
      address: string;
      unitName: string;
      characterName: string;
    }[] = [];
    for (let i = 0; i < notesSize; i++) {
      const note = notes.get(i);
      const unitData = note.field("<UnitData>k__BackingField")
        .value as Il2Cpp.Object | null;
      if (!unitData || unitData.handle.isNull()) {
        // 敌方某些模式下 UnitData 未赋值，跳过以免 access violation
        units.push({
          address: note.handle.toString(),
          unitName: "???",
          characterName: "???",
        });
        continue;
      }
      const unitName =
        (unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String)
          ?.content ?? "";
      const characterName =
        (
          unitData.field("<CharacterName>k__BackingField")
            .value as Il2Cpp.String
        )?.content ?? "";
      units.push({
        address: note.handle.toString(),
        unitName,
        characterName,
      });
    }

    if (teamType === "Player" || teamType === "Unknown") {
      this.tskBattleLog.init(notes, modeName);
      this.playerNotesListHandle = args[4];
    } else if (teamType === "Enemy") {
      // 敌方不进 notes（伤害统计只认玩家），仅留名单 + 定格模式供结束快照。
      // Player Initialize 恒报 Normal 不可信，真正的模式只在 Enemy Initialize；
      // setEnemies 内部按「首次有效值」定格，重复调用幂等（防御性）
      this.tskBattleLog.setEnemies(units, modeName);
    }
    // 敌我双方都上报，GUI 按 team 区分展示（玩家带头像，敌人纯文字紧凑条）
    sendHost("unitList", { team: teamType, units });
  };

  private handleSetSkillDamageValue: MethodEnterHandler = (
    _cls,
    _method,
    args,
  ) => {
    const value = args[1].toString();
    const attackAddress = args[4].toString();
    // bool 参数在栈槽中只有低 8 位有效，高位是残留垃圾，必须 & 0xff
    const isCritical = (args[8].toInt32() & 0xff) != 0 ? "True" : "False";
    this.tskBattleLog.addDamageNote(attackAddress, value, "Skill", isCritical);
  };

  private handleSetDamageValue: MethodEnterHandler = (_cls, _method, args) => {
    const value = args[1].toString();
    const attackAddress = args[5].toString();
    const isCritical = (args[4].toInt32() & 0xff) != 0 ? "True" : "False";
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
}
