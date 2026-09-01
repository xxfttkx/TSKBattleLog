import { Timing } from "../common";
import { log } from "../utils";
import { Mod, guarded } from "../mod";

/** QTE 强制 PREFECT（修改型） */
export class QteMod implements Mod {
  name = "qte-perfect";
  category = "修改" as const;
  description = "所有 QTE 结果强制 PERFECT";
  enabled = true;

  onLoad(image: Il2Cpp.Image): void {
    const TSKBattleMain = image.class("TSKBattleMain");
    const QTEResutl = TSKBattleMain.method("QTEResutl");
    const QTEResutlOriginal = new NativeFunction(
      QTEResutl.virtualAddress,
      "void",
      ["pointer", "int"],
    ) as any;

    const self = this;
    QTEResutl.implementation = function (timing: any) {
      if (!self.enabled) {
        // 走原 bridge 实现
        return QTEResutl.invoke(...Array.prototype.slice.call(arguments));
      }
      log(`QTEResutl called with timing = ${Timing[timing]}(${timing})`);
      // 强制 PREFECT
      const newTiming = 3;
      log(`QTEResutl modified timing to = ${Timing[newTiming]}(${newTiming})`);
      return QTEResutlOriginal(this.handle, newTiming);
    };
  }
}
