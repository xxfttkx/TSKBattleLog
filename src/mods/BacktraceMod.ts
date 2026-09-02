import traceConfigRaw from "../../trace_config.json";
import { log } from "../utils";
import { Mod, MethodEnterHandler, TraceListener, traceMethodByName } from "../mod";
import {
  buildMethodIndex,
  isMethodIndexBuilt,
  printCaller,
} from "../debug/MethodResolver";

export interface BacktraceEntry {
  class: string;
  method: string;
  /** 单条覆盖全局深度，不填用 backtraceDepth */
  depth?: number;
}

/**
 * backtrace：按 trace_config.json 的 backtrace 列表，在方法进入时打印
 * IL2CPP 调用栈（复用 MethodResolver 的地址反解），用于回答"这个方法是谁调的"。
 */
export class BacktraceMod implements Mod {
  name = "backtrace";
  category = "调试" as const;
  description = "按 trace_config.json 在指定方法进入时打印 IL2CPP 调用栈";
  enabled = false;

  private image?: Il2Cpp.Image;
  private globalDepth = 5;
  /** key=类名.方法名 -> listener + 实际生效深度 */
  private registered = new Map<string, { listener: TraceListener; depth: number }>();

  onLoad(image: Il2Cpp.Image): void {
    this.image = image;
    const cfg = traceConfigRaw as unknown as {
      backtrace?: BacktraceEntry[];
      backtraceDepth?: number;
    };
    this.globalDepth = cfg.backtraceDepth ?? 5;
    this.applyConfig(cfg.backtrace ?? [], this.globalDepth);

    // 启动即启用且配置了观察点时预构建索引，避免第一次触发时卡顿
    if (this.enabled && this.registered.size > 0 && !isMethodIndexBuilt()) {
      buildMethodIndex();
    }
  }

  /** 全量应用配置：新增挂 hook，移除 detach，深度变化则重挂 */
  applyConfig(entries: BacktraceEntry[], globalDepth: number): void {
    if (!this.image) {
      log("[backtrace] onLoad 尚未执行，忽略配置下发");
      return;
    }
    this.globalDepth = globalDepth;

    const wanted = new Map<string, BacktraceEntry>();
    for (const e of entries) {
      wanted.set(`${e.class}.${e.method}`, e);
    }

    for (const [key, reg] of this.registered) {
      const next = wanted.get(key);
      if (!next || (next.depth ?? this.globalDepth) !== reg.depth) {
        reg.listener.detach();
        this.registered.delete(key);
        log(`[backtrace] detach ${key}`);
      }
    }

    for (const [key, e] of wanted) {
      if (this.registered.has(key)) continue;
      const depth = e.depth ?? this.globalDepth;
      const listener = traceMethodByName(
        this.image,
        e.class,
        e.method,
        this,
        this.makeHandler(depth),
      );
      if (listener) {
        this.registered.set(key, { listener, depth });
        log(`[backtrace] attach ${key} (depth=${depth})`);
      }
    }
    log(`[backtrace] ${this.registered.size} 个调用栈观察点已激活`);
  }

  private makeHandler(depth: number): MethodEnterHandler {
    return (cls, method, _args, context) => {
      // 运行时才开启本 mod 时，索引可能在首次触发时尚未构建
      if (!isMethodIndexBuilt()) {
        buildMethodIndex();
      }
      log(`backtrace ${cls.name}.${method.name} (depth=${depth}):`);
      printCaller(context, depth);
    };
  }
}
