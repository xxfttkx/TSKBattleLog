import "frida-il2cpp-bridge";
import { log, sendHost } from "./utils";
import { Mod, publishModList } from "./mod";
import { BattleLogMod } from "./mods/BattleLogMod";
import { QteMod } from "./mods/QteMod";
import { AutoSkillMod } from "./mods/AutoSkillMod";
import { DamageCalcTraceMod } from "./mods/DamageCalcTraceMod";
import { UnitListDumpMod } from "./mods/UnitListDumpMod";
import { TraceConfigMod } from "./mods/TraceConfigMod";
import { BacktraceMod, BacktraceEntry } from "./mods/BacktraceMod";
import { TraceEntry } from "./mods/TraceConfigMod";
import { FieldWatchMod } from "./mods/FieldWatchMod";
import { AvatarClarityMod } from "./mods/AvatarClarityMod";
import { getSkillEffects } from "./debug/skillEffects";
import { applyCharSkill } from "./common";
import modsConfig from "../mods.json";
import { BattleSpeedMod } from "./mods/BattleSpeedMod";

const mods: Mod[] = [
  new BattleLogMod(),
  new QteMod(),
  new AutoSkillMod(),
  new DamageCalcTraceMod(),
  new UnitListDumpMod(),
  new TraceConfigMod(),
  new BacktraceMod(),
  new FieldWatchMod(),
  new AvatarClarityMod(),
  new BattleSpeedMod(),
];

// mod 初始开关取构建时内联的 mods.json 快照：无宿主的 frida CLI（run.ps1）模式
// 下直接以此生效；宿主 control.py 握手后会通过 initMods 下发磁盘最新值覆盖。
for (const mod of mods) {
  const enabled = (modsConfig as Record<string, boolean>)[mod.name];
  if (enabled !== undefined) {
    mod.enabled = enabled;
  }
}

/**
 * recv 是一次性的：回调里重新注册自身，实现持续监听宿主消息。
 * 兼容宿主 post 的 {type, payload} 包装和裸 payload 两种形态。
 */
function armRecv(type: string, handler: (payload: any) => void): void {
  (globalThis as any).recv(type, (message: any) => {
    try {
      const payload =
        message && typeof message === "object" && "payload" in message
          ? message.payload
          : message;
      handler(payload);
    } catch (e) {
      log(`[loader] recv(${type}) handler error: ${e}`);
    }
    armRecv(type, handler);
  });
}

Il2Cpp.perform(() => {
  log("================================");
  log("Frida IL2CPP Started");
  log("Unity Version:", Il2Cpp.unityVersion);
  log("================================");

  const image = Il2Cpp.domain.assembly("Assembly-CSharp").image;

  const loadedMods = new Set<string>();

  // 按内联 mods.json 做初始加载（run.ps1 无宿主时的工作路径）；
  // 有宿主时 initMods 随后下发磁盘最新值，差异的 mod 在此处理器中补 onLoad/置标志
  for (const mod of mods) {
    if (mod.enabled) {
      log(`[loader] load mod: ${mod.name}`);
      mod.onLoad(image);
      loadedMods.add(mod.name);
    } else {
      log(`[loader] skip mod: ${mod.name} (disabled)`);
    }
  }

  // 先注册消息接收，再上报 mod 清单（宿主收到 modList 后才会下发
  // initMods/charSkill/traceConfig，保证下发时 recv 已就绪）
  armRecv("initMods", (config: Record<string, boolean>) => {
    // 宿主下发 mods.json 全量内容：据此启用并加载 mod。
    // 复选框注入后冻结，本消息整个会话只处理一次。
    for (const mod of mods) {
      mod.enabled = !!config[mod.name];
      if (mod.enabled && !loadedMods.has(mod.name)) {
        log(`[loader] load mod: ${mod.name}`);
        mod.onLoad(image);
        loadedMods.add(mod.name);
      } else if (!mod.enabled) {
        log(`[loader] skip mod: ${mod.name} (disabled)`);
      }
    }
  });

  // 技能优先级配置（char_skill.json）：模块级 skillMap，不依赖 mod onLoad 顺序
  armRecv("charSkill", (cfg: Record<string, number>) => {
    applyCharSkill(cfg ?? {});
    log(`[loader] charSkill applied: ${Object.keys(cfg ?? {}).length} entries`);
  });

  armRecv("traceConfig", (cfg: any) => {
    const traceMod = mods.find((m) => m instanceof TraceConfigMod) as
      | TraceConfigMod
      | undefined;
    const btMod = mods.find((m) => m instanceof BacktraceMod) as
      | BacktraceMod
      | undefined;
    traceMod?.applyConfig(
      Array.isArray(cfg?.trace) ? (cfg.trace as TraceEntry[]) : [],
    );
    btMod?.applyConfig(
      Array.isArray(cfg?.backtrace) ? (cfg.backtrace as BacktraceEntry[]) : [],
      typeof cfg?.backtraceDepth === "number" ? cfg.backtraceDepth : 5,
    );
  });

  // 战斗倍速（battle-speed）：宿主面板下拉框下发，目标值类配置，onLoad 前后均可
  armRecv("battleSpeed", (cfg: any) => {
    const speedMod = mods.find((m) => m instanceof BattleSpeedMod) as
      | BattleSpeedMod
      | undefined;
    const speed =
      cfg && typeof cfg === "object" ? (cfg.speed as number) : (cfg as number);
    speedMod?.applyConfig(Number(speed));
  });

  // 宿主点击头像查询单位 buff（skillEffectList）+ 实时战斗属性
  armRecv("buffRequest", (data: { address: string }) => {
    try {
      const unit = new Il2Cpp.Object(ptr(data.address));
      const effects = getSkillEffects(unit);
      let stats: any;
      try {
        const baseAttack = unit.method("GetBaseAttack").invoke() as number;
        const atk = unit.method("GetAttack").invoke(false) as number;
        const crt = unit.method("GetCritical").invoke() as number;
        const unitData = unit.field("<UnitData>k__BackingField")
          .value as Il2Cpp.Object;
        const exUp = unitData.field("<ExGaugeRate>k__BackingField")
          .value as number;
        let noteCount: number | string;
        try {
          noteCount = unit.field("noteCount").value as number;
        } catch (e) {
          noteCount = `err: ${e}`;
        }
        stats = {
          baseAttack,
          atk,
          crt,
          exUp,
          noteCount,
          // 通常攻击回复 EX（与 BattleLog 初始化日志口径一致）
          exGain: Math.ceil((100 + exUp) / 3.75),
        };
      } catch (e) {
        stats = { error: String(e) };
      }
      sendHost("buffData", { address: data.address, effects, stats });
    } catch (e) {
      // 战斗结束地址失效等情况：优雅返回错误
      sendHost("buffData", { address: data.address, error: String(e) });
    }
  });

  // 向宿主上报 mod 清单
  publishModList(mods);
});
