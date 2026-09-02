import { log, getAutoUseSkillIndex } from "../utils";
import { Mod, MethodEnterHandler, traceMethodByName } from "../mod";

/** 自动技能选择：按 char_skill.json 配置覆盖 skill_rate（修改型） */
export class AutoSkillMod implements Mod {
  name = "auto-skill";
  category = "修改" as const;
  description = "按 char_skill.json 配置自动选择 EX1/EX2";
  enabled = true;

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TSKBattleAI",
      "LotterySkill",
      this,
      this.handleLotterySkill,
    );
  }

  private handleLotterySkill: MethodEnterHandler = (_cls, _method, args) => {
    // args[2] = TSKBattleNote
    const unit = new Il2Cpp.Object(args[2]);
    const baseAttack = unit.method("GetBaseAttack").invoke() as number;
    const atk = unit.method("GetAttack").invoke(false) as number;
    const crt = unit.method("GetCritical").invoke() as number;
    log(
      `LotterySkill: baseAttack=${baseAttack} attack=${atk}(ignore charge) critical=${crt}`,
    );

    const selectPattern = new Il2Cpp.Object(args[1]);

    const unitData = unit.field("<UnitData>k__BackingField")
      .value as Il2Cpp.Object;

    const unitName = (
      unitData.field("<UnitName>k__BackingField").value as Il2Cpp.String
    ).content;
    const characterName = (
      unitData.field("<CharacterName>k__BackingField").value as Il2Cpp.String
    ).content;
    const hp = unitData.field("<HP>k__BackingField").value;
    const attack = unitData.field("<Attack>k__BackingField").value;
    const critical = unitData.field("<Critical>k__BackingField").value;
    const name = `[${unitName}] ${characterName}`;
    log(`${name}: hp=${hp} attack=${attack} critical=${critical}`);

    const skillId = getAutoUseSkillIndex(unitName ?? "", characterName ?? "");
    if (skillId != -1) {
      log(`set ${name} skillId=${skillId}`);
      if (skillId == 0) {
        selectPattern.field("skill_rate_1").value = 0;
        selectPattern.field("skill_rate_2").value = 0;
      }
      if (skillId == 1) {
        selectPattern.field("skill_rate_1").value = 100;
        selectPattern.field("skill_rate_2").value = 0;
      }
      if (skillId == 2) {
        selectPattern.field("skill_rate_1").value = 0;
        selectPattern.field("skill_rate_2").value = 100;
      }
      if (skillId == 3) {
        selectPattern.field("skill_rate_1").value = 50;
        selectPattern.field("skill_rate_2").value = 50;
      }
    } else {
      log(
        `${unitName} ${characterName} not found in skillMap: skill_rate_1 = ${
          selectPattern.field("skill_rate_1").value
        }  skill_rate_2 = ${selectPattern.field("skill_rate_2").value}`,
      );
    }
  };
}
