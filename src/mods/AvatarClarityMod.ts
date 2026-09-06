import { Mod } from "../mod";
import { gaugeViewOnTop } from "../debug/gaugeTop";

/**
 * 头像清晰化（修改型）：角色头像 UI（TSKBattleUnitIcon，含 buff/觉醒图标）
 * 常态下不再被游戏淡化到 0.3 半透明，演出动画（淡入/淡出/隐藏）完全保留。
 *
 * 实现与踩坑记录见 src/debug/gaugeTop.ts 头注释和 notes/avatar-clarity.md。
 */
export class AvatarClarityMod implements Mod {
  name = "avatar-clarity";
  category = "修改" as const;
  description =
    "让角色头像（含 buff/觉醒图标）常态清晰显示；演出时游戏仍可正常淡入淡出/隐藏";
  enabled = false;

  onLoad(image: Il2Cpp.Image): void {
    gaugeViewOnTop(image);
  }
}
