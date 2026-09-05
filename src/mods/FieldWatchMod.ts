import { Mod, TraceListener } from "../mod";
import { watchField, FieldWatchConfig } from "../debug/watchField";

/**
 * field-watch（调试）：监控字段写入，值变化时打印修改者方法名 + 调用栈。
 * 通用逻辑在 debug/watchField.ts，想观察新字段时往对应类的 fields 里加一条即可。
 *
 * 注意：字段名用 IL2CPP 元数据里的真名（自动属性是 <Xxx>k__BackingField），
 * 字段类型（int/float）自动从元数据推断，取不到偏移时才用 fallbackOffset。
 */
const TARGETS: FieldWatchConfig[] = [
  // {
  //   className: "TSKBattleMain",
  //   tag: "[turn-watch]",
  //   fields: [{ fieldName: "turnCount", fallbackOffset: 0x19c }],
  // },
  {
    className: "TSKBattleNote",
    tag: "[note-watch]",
    backtraceDepth: 6,
    fields: [
      {
        fieldName: "noteCount",
        fallbackOffset: 0x138,
        tag: "[note-count-watch]",
      },
    ],
  },
];

export class FieldWatchMod implements Mod {
  name = "field-watch";
  category = "调试" as const;
  description = "监控指定类的指定字段变化，打印修改者方法名和调用栈";
  enabled = false;

  private listeners: TraceListener[] = [];

  onLoad(image: Il2Cpp.Image): void {
    for (const target of TARGETS) {
      this.listeners.push(...watchField(image, target, this));
    }
  }
}
