import { guarded, Mod } from "../mod";
import { log, sendHost } from "../utils";
import { ApiName } from "../common";
import { hasApiSubscribers, publishApi } from "../apiBus";

/** ApiName 枚举数值 -> 接口名（common.ts 离线枚举快照；缺失时显示原始值）。
 * 枚举值与游戏实际定义存在错位（StoryTop↔warehouse/list 等已实证），
 * 仅作 meta 行的原始诊断信息；事件展示名以 URL 路径后缀为准（那是事实） */
function apiNameOfValue(ev: number): string {
  return (ApiName as any)[ev] ?? `ApiName#${ev}`;
}

/** 完整 URL -> 接口路径后缀（/api/friend/followList -> friend/followList） */
function pathOf(url: string): string {
  const m = url.match(/\/api\/(.+)$/);
  return m ? m[1] : url;
}

/** 从原生参数/返回值指针读托管字符串内容（失败返回空串，不抛出） */
function readIl2CppString(p: NativePointer): string {
  try {
    return new Il2Cpp.String(p).content ?? "";
  } catch {
    return "";
  }
}

/** 截断预览，避免长 JSON 刷屏 */
function short(s: string, max = 160): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 落盘到 logs/capture/*.jsonl 的事件结构（host 侧逐行 append） */
type CaptureEvent = {
  seq: number;
  time: string;
  kind: "meta" | "req" | "resp" | "url";
  api: string;
  plain?: string;
  url?: string;
  /** HTTP 方法（仅 url 事件，来自 UnityWebRequest.get_method） */
  method?: string;
  /** ApiName 枚举原始数值（仅 meta 事件），用于建真实 enum->URL 映射表 */
  apiRaw?: number;
  /** @deprecated 旧版本遗留，现在 url 事件 time 就是真实发出时刻；
   * 保留字段是为了旧 jsonl 文件向后兼容 */
  sentAt?: string;
};

/**
 * 全局网络抓包（观察型，默认关闭）。
 *
 * 实测流程（独立脚本 v1/v2 验证）：
 *   1. MaskStringWithXOR(json明文) -> 密文      （请求方向，先发生）
 *   2. FormatData(apiName, 密文, key)           （_data 是密文）
 *   ... 响应回来 ...
 *   3. MaskStringWithXOR(密文) -> json明文      （响应方向）
 * 方向判据 = MaskStringWithXOR 的 input 是否以 { / [ 开头。
 *
 * 全部用只读 Interceptor.attach（不 replace、不 invoke 参数回传）：
 * 枚举参数原样回传 invoke 会导致 native 参数错乱（v2 崩溃根因）。
 * req 行的 api 为空串，由紧随其后的 meta 行（FormatData）补关联，
 * 落盘 append-only，按 seq 时序阅读。
 */
export class NetworkCaptureMod implements Mod {
  name = "network-capture";
  category = "观察" as const;
  description = "抓取网络请求/响应明文 JSON，落盘 logs/capture/";
  enabled = false;

  private seq = 0;
  private lastApi = "(unknown)";
  /** 最近一次 SendWebRequest 的 URL 后缀（resp 行命名主依据，枚举表错位，URL 才是事实） */
  private lastUrlPath = "";

  onLoad(image: Il2Cpp.Image): void {
    const hc = image.class("TKS.Network.HttpClient");
    if (!hc) {
      log("[network-capture] TKS.Network.HttpClient not found");
      return;
    }

    // FormatData(api 枚举, 密文, key)：请求方向元数据（接口名）
    this.attach(hc, "FormatData", 3, (args) => {
      const raw = args[0].toInt32() & 0xff;
      this.lastApi = apiNameOfValue(raw);
      this.emit({ kind: "meta", api: this.lastApi, apiRaw: raw });
    });

    // MaskStringWithXOR(input, mask) -> string：明文正主。
    // Ghidra 确认为 static 方法：args[0]=input（要抓的串），args[1]=mask。
    // （曾按实例方法读 args[1]——拿到的是 mask 密钥串，永不以 { 开头，
    //   请求方向全被误判成 resp、req 行恒为 0）
    this.attach(
      hc,
      "MaskStringWithXOR",
      2,
      (_args, ctx) => {
        (ctx as any)._input = readIl2CppString(_args[0]);
      },
      (retval, ctx) => {
        const input = ((ctx as any)._input as string) ?? "";
        const isReq = input.startsWith("{") || input.startsWith("[");
        // req 行 api 留空（此时自身 URL 尚未出现，host 按同段 url 行回填）；
        // resp 行优先用最近一次 URL 后缀（枚举表错位，URL 才是事实）
        const plain = isReq ? input : readIl2CppString(retval);
        this.emit({
          kind: isReq ? "req" : "resp",
          api: isReq ? "" : this.lastUrlPath || this.lastApi,
          plain,
        });
        // API 总线：有 mod 订阅该接口时发布响应体（按需 parse，双 resp 去重在 bus 内）
        if (
          !isReq &&
          plain &&
          hasApiSubscribers(this.lastUrlPath || this.lastApi)
        ) {
          publishApi(this.lastUrlPath || this.lastApi, plain);
        }
      },
    );

    // URL 事件由 SendWebRequest 钩点直接 emit（真实发出时刻）。
    // AssetBundle / 资源下载不走 SendWebRequest（游戏 HttpClient 层封装），
    // 但我们只关心 /api/ 业务接口，不需要 ProcessCommon 兜底。

    log(
      "[network-capture] hooks ready (FormatData / MaskStringWithXOR / SendWebRequest)",
    );

    // SendWebRequest：按标准程序集名直取（UnityWebRequest 固定在 UnityEngine.UnityWebRequestModule，
    // O(1) 命中，注入零负担）
    if (!this.tryHookSendDirect()) {
      log("[network-capture] SendWebRequest 未定位，网络抓包可能无 url 事件");
    }
  }

  /** 按标准程序集名直接定位 UnityEngine.Networking.UnityWebRequest 并挂钩 */
  private tryHookSendDirect(): boolean {
    try {
      const image = Il2Cpp.domain.assembly(
        "UnityEngine.UnityWebRequestModule",
      ).image;
      const cls = image.tryClass("UnityEngine.Networking.UnityWebRequest");
      return !!cls && this.hookSendWebRequest(cls);
    } catch {
      return false;
    }
  }

  /** 类内 attach helper：支持按参数数量消解重载，guarded 包装开关检查 */
  private attach(
    cls: Il2Cpp.Class,
    name: string,
    paramCount: number,
    onEnter?: (args: InvocationArguments, ctx: any) => void,
    onLeave?: (retval: InvocationReturnValue, ctx: any) => void,
  ): void {
    let method: Il2Cpp.Method;
    try {
      method = cls.method(name, paramCount);
    } catch (e) {
      log(
        `[network-capture] resolve ${cls.name}.${name}(${paramCount}) failed: ${e}`,
      );
      return;
    }
    if (!method || method.virtualAddress.isNull()) {
      log(`[network-capture] ${cls.name}.${name} address is null, skip`);
      return;
    }
    const enter = onEnter ? guarded(this, onEnter as any) : undefined;
    const leave = onLeave ? guarded(this, onLeave as any) : undefined;
    // 跨 enter/leave 的状态必须存在 this（InvocationContext）上：
    // gum 保证同一调用的 enter/leave 共享它。绝不能存 this.context——
    // 那是 CpuContext（寄存器），enter/leave 是两个不同对象，
    // 存进去的值 leave 时取不回（曾导致 input 恒为 ""、req 行恒为 0）
    Interceptor.attach(method.virtualAddress, {
      ...(enter
        ? {
            onEnter(args) {
              enter(args, this);
            },
          }
        : {}),
      ...(leave
        ? {
            onLeave(retval) {
              leave(retval, this);
            },
          }
        : {}),
    });
  }

  /**
   * 挂 UnityWebRequest.SendWebRequest（实例方法，0 参）：在请求真正发出的瞬间
   * 直接 emit url 事件，time 就是真实发出时刻，不再依赖 ProcessCommon 配对。
   * 同时更新 lastUrlPath，resp 事件命名靠它。
   * 返回是否挂钩成功。
   */
  private hookSendWebRequest(cls: Il2Cpp.Class): boolean {
    let m: Il2Cpp.Method;
    try {
      m = cls.method("SendWebRequest", 0);
    } catch (e) {
      log(`[network-capture] resolve SendWebRequest failed: ${e}`);
      return false;
    }
    if (!m || m.virtualAddress.isNull()) {
      log("[network-capture] SendWebRequest address is null, skip");
      return false;
    }
    const handler = guarded(this, (args: InvocationArguments) => {
      try {
        const obj = new Il2Cpp.Object(args[0]);
        const url =
          (obj.method("get_url", 0).invoke() as Il2Cpp.String).content ?? "";
        const method =
          (obj.method("get_method", 0).invoke() as Il2Cpp.String).content ?? "";
        const path = url ? pathOf(url) : "";
        if (path) this.lastUrlPath = path;
        this.emit({
          kind: "url",
          api: path || "(api待定)",
          url,
          method,
        });
      } catch {
        /* 单条失败忽略 */
      }
    });
    Interceptor.attach(m.virtualAddress, {
      onEnter(args) {
        handler(args);
      },
    });
    log(
      `[network-capture] SendWebRequest hook ready（${cls.image.assembly.name}，真实发出时刻）`,
    );
    return true;
  }

  /** HH:MM:SS.mmm 时间戳 */
  private nowStr(): string {
    const now = new Date();
    return (
      `${now.getHours().toString().padStart(2, "0")}:` +
      `${now.getMinutes().toString().padStart(2, "0")}:` +
      `${now.getSeconds().toString().padStart(2, "0")}.` +
      `${now.getMilliseconds().toString().padStart(3, "0")}`
    );
  }

  /** 事件推给宿主落盘；控制台只留短预览（CLI 模式可见，不进 host Logs 页） */
  private emit(evt: Omit<CaptureEvent, "seq" | "time">): void {
    const e: CaptureEvent = { seq: ++this.seq, time: this.nowStr(), ...evt };
    sendHost("captureData", e);
    const detail = e.kind === "url" ? (e.url ?? "") : short(e.plain ?? "");
    console.log(
      `[capture] #${e.seq} ${e.kind} ${e.api || "(api待定)"} ${detail}`,
    );
  }
}
