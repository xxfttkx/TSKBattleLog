import { Timing } from "../common";
import { log } from "../utils";
import { Mod } from "../mod";

/** QTE 强制 PREFECT（修改型） */
export class QteMod implements Mod {
  name = "qte-perfect";

  onLoad(image: Il2Cpp.Image): void {
    const TSKBattleMain = image.class("TSKBattleMain");
    const QTEResutl = TSKBattleMain.method("QTEResutl");
    const QTEResutlOriginal = new NativeFunction(
      QTEResutl.virtualAddress,
      "void",
      ["pointer", "int"],
    ) as any;

    QTEResutl.implementation = function (timing: any) {
      log(`QTEResutl called with timing = ${Timing[timing]}(${timing})`);
      // 强制 PREFECT
      const newTiming = 3;
      log(`QTEResutl modified timing to = ${Timing[newTiming]}(${newTiming})`);
      return QTEResutlOriginal(this.handle, newTiming);
    };
  }
}
