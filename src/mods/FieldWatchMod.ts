import { Mod, TraceListener } from "../mod";
import { watchField } from "../debug/watchField";

/**
 * field-watch（调试）：监控 TSKBattleMain.turnCount 字段的写入。
 * 通用逻辑在 debug/watchField.ts，改 className/fieldName 即可复用。
 */
export class FieldWatchMod implements Mod {
  name = "field-watch";
  category = "调试" as const;
  description = "监控 TSKBattleMain.turnCount 变化，打印修改者方法名和调用栈";
  enabled = false;

  private listeners: TraceListener[] = [];

  onLoad(image: Il2Cpp.Image): void {
    this.listeners = watchField(image, {
      className: "TSKBattleMain",
      fieldName: "turnCount",
      fallbackOffset: 0x19c,
    });
  }
}
