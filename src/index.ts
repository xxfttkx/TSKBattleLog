import "frida-il2cpp-bridge";
import { log } from "./utils";
import { Mod, publishModList, publishModState } from "./mod";
import { BattleLogMod } from "./mods/BattleLogMod";
import { QteMod } from "./mods/QteMod";
import { AutoSkillMod } from "./mods/AutoSkillMod";
import { DamageCalcTraceMod } from "./mods/DamageCalcTraceMod";
import { UnitListDumpMod } from "./mods/UnitListDumpMod";
import modsConfig from "../mods.json";

const mods: Mod[] = [
  new BattleLogMod(),
  new QteMod(),
  new AutoSkillMod(),
  new DamageCalcTraceMod(),
  new UnitListDumpMod(),
];

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

  // 向宿主上报 mod 清单
  publishModList(mods);

  // 接收宿主开关变更消息
  (globalThis as any).recv(
    "toggle",
    (data: { name: string; enabled: boolean }) => {
      const mod = mods.find((m) => m.name === data.name);
      if (mod) {
        mod.enabled = !!data.enabled;
        log(`[loader] ${mod.enabled ? "enable" : "disable"} mod: ${mod.name}`);
        publishModState(mod.name, mod.enabled);
      }
    },
  );
});
