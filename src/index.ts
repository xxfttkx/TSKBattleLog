import "frida-il2cpp-bridge";
import { log } from "./utils";
import { Mod, publishModList, publishModState } from "./mod";
import { BattleLogMod } from "./mods/BattleLogMod";
import { QteMod } from "./mods/QteMod";
import { AutoSkillMod } from "./mods/AutoSkillMod";
import { DamageCalcTraceMod } from "./mods/DamageCalcTraceMod";
import { UnitListDumpMod } from "./mods/UnitListDumpMod";
import { TraceConfigMod } from "./mods/TraceConfigMod";
import { BacktraceMod, BacktraceEntry } from "./mods/BacktraceMod";
import { TraceEntry } from "./mods/TraceConfigMod";
import { FieldWatchMod } from "./mods/FieldWatchMod";
import modsConfig from "../mods.json";

const mods: Mod[] = [
  new BattleLogMod(),
  new QteMod(),
  new AutoSkillMod(),
  new DamageCalcTraceMod(),
  new UnitListDumpMod(),
  new TraceConfigMod(),
  new BacktraceMod(),
  new FieldWatchMod(),
];

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

  // 初始开关：以 mods.json 为默认值（宿主后续可覆盖）
  for (const mod of mods) {
    const enabled = (modsConfig as Record<string, boolean>)[mod.name];
    if (enabled !== undefined) {
      mod.enabled = enabled;
    }
  }

  for (const mod of mods) {
    if (mod.enabled) {
      log(`[loader] load mod: ${mod.name}`);
      mod.onLoad(image);
    } else {
      log(`[loader] skip mod: ${mod.name} (disabled)`);
    }
  }

  // 默认关闭的 mod 也执行 onLoad（onLoad 只注册 hook，执行逻辑由 enabled 守卫），
  // 这样宿主在运行时打开它们也能生效。
  for (const mod of mods) {
    if (!mod.enabled) {
      log(`[loader] defer mod: ${mod.name} (hooks pre-registered)`);
      mod.onLoad(image);
    }
  }

  // 先注册消息接收，再上报 mod 清单（宿主收到 modList 后才会下发 traceConfig，
  // 保证下发时 recv 已就绪）
  armRecv("toggle", (data: { name: string; enabled: boolean }) => {
    const mod = mods.find((m) => m.name === data.name);
    if (mod) {
      mod.enabled = !!data.enabled;
      log(`[loader] ${mod.enabled ? "enable" : "disable"} mod: ${mod.name}`);
      publishModState(mod.name, mod.enabled);
    }
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

  // 向宿主上报 mod 清单
  publishModList(mods);
});
