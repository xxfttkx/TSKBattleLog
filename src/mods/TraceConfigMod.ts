import traceConfigRaw from "../../trace_config.json";
import { log } from "../utils";
import { Mod, TraceListener, dumpArgsHandler, traceMethodByName } from "../mod";

export interface TraceEntry {
  class: string;
  method: string;
}

/**
 * trace-config：按 trace_config.json 的 trace 列表批量注册 dumpArgs 观察点（调试）。
 * 支持运行时通过 traceConfig 消息全量重载：新增的挂 hook，移除的 detach。
 */
export class TraceConfigMod implements Mod {
  name = "trace-config";
  category = "调试" as const;
  description = "按 trace_config.json 批量注册参数 dump 观察点（改 JSON 后点面板重载配置即生效）";
  enabled = false;

  private image?: Il2Cpp.Image;
  private listeners = new Map<string, TraceListener>();
  private lastConfigKey = "";

  onLoad(image: Il2Cpp.Image): void {
    this.image = image;
    const cfg = traceConfigRaw as unknown as { trace?: TraceEntry[] };
    this.applyConfig(cfg.trace ?? []);
  }

  /** 全量应用配置：以 key=类名.方法名 做差量挂载/摘除 */
  applyConfig(entries: TraceEntry[]): void {
    // 去重：配置内容未变时跳过（避免 onLoad 和宿主下发重复打印）
    const key = JSON.stringify(entries);
    if (key === this.lastConfigKey) return;
    this.lastConfigKey = key;

    if (!this.image) {
      log("[trace-config] onLoad 尚未执行，忽略配置下发");
      return;
    }

    const wanted = new Map<string, TraceEntry>();
    for (const e of entries) {
      wanted.set(`${e.class}.${e.method}`, e);
    }

    for (const [key, listener] of this.listeners) {
      if (!wanted.has(key)) {
        listener.detach();
        this.listeners.delete(key);
        log(`[trace-config] detach ${key}`);
      }
    }

    for (const [key, e] of wanted) {
      if (this.listeners.has(key)) continue;
      const listener = traceMethodByName(
        this.image,
        e.class,
        e.method,
        this,
        dumpArgsHandler,
      );
      if (listener) {
        this.listeners.set(key, listener);
      }
    }
    log(`[trace-config] ${this.listeners.size} 个观察点已激活`);
  }
}
