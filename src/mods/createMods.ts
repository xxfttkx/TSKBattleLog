import { Mod } from "../mod";
import { BattleLogMod } from "./BattleLogMod";
import { QteMod } from "./QteMod";
import { AutoSkillMod } from "./AutoSkillMod";
import { UnitListDumpMod } from "./UnitListDumpMod";
import { TraceConfigMod } from "./TraceConfigMod";
import { BacktraceMod } from "./BacktraceMod";
import { FieldWatchMod } from "./FieldWatchMod";
import { AvatarClarityMod } from "./AvatarClarityMod";
import { BattleSpeedMod } from "./BattleSpeedMod";

/**
 * 全量 mod 注册表（单一事实源）：index.ts（agent 装载）与 modManifest.ts
 * （构建期元数据生成）共用，新增 mod 在这里加一行即可。
 *
 * 注意：实例化只允许初始化元数据字段（name/category/description/enabled），
 * 一切 Il2Cpp/Frida 相关操作必须在 onLoad 里做——本模块会被构建期脚本
 * 在纯 Node 环境执行，frida 全局不存在。
 */
export function createMods(): Mod[] {
  return [
    new BattleLogMod(),
    new QteMod(),
    new AutoSkillMod(),
    new UnitListDumpMod(),
    new TraceConfigMod(),
    new BacktraceMod(),
    new FieldWatchMod(),
    new AvatarClarityMod(),
    new BattleSpeedMod(),
  ];
}
