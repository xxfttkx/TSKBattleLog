import { guarded, Mod } from "../mod";
import { log, sendHost } from "../utils";
import { ApiName } from "../common";

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
  /** 请求发出时刻（仅 url 事件，SendWebRequest 配对结果；
   * 空 body 请求没有 req 行，这是它们唯一的真实发出时间戳） */
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
  /** 最近一次 ProcessCommon 的 URL 后缀（resp 行命名主依据） */
  private lastUrlPath = "";
  /** SendWebRequest 发出记录（FIFO，按 URL 与 url 事件配对），上限 64 防泄漏 */
  private sentQueue: { url: string; time: string }[] = [];
  /** SendWebRequest 挂钩状态：onLoad 按标准程序集名直取，失败则首次
   * ProcessCommon 用实例类兜底（惰性会漏掉首个请求的发出时刻） */
  private sendHookState: "pending" | "done" | "failed" = "pending";

  onLoad(image: Il2Cpp.Image): void {
    const hc = image.class("TKS.Network.HttpClient");
    if (!hc) {
      log("[network-capture] TKS.Network.HttpClient not found");
      return;
    }

    // FormatData(api 枚举, 密文, key)：请求方向元数据（接口名）
    this.attach(hc, "FormatData", 3, (args) => {
      this.lastApi = apiNameOfValue(args[0].toInt32() & 0xff);
      this.emit({ kind: "meta", api: this.lastApi });
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
        this.emit({
          kind: isReq ? "req" : "resp",
          api: isReq ? "" : this.lastUrlPath || this.lastApi,
          plain: isReq ? input : readIl2CppString(retval),
        });
      },
    );

    // ProcessCommon(req, api 枚举, bool)：最终 URL + HTTP 方法
    // （get_url/get_method 都是简单 getter，invoke 安全）
    this.attach(hc, "ProcessCommon", 3, (args) => {
      let url = "";
      let method = "";
      try {
        const reqObj = new Il2Cpp.Object(args[0]);
        url =
          (reqObj.method("get_url", 0).invoke() as Il2Cpp.String).content ?? "";
        method =
          (reqObj.method("get_method", 0).invoke() as Il2Cpp.String).content ??
          "";
        // SendWebRequest 兜底：onLoad 全程序集解析失败时，
        // 用运行中实例的类再试一次（惰性代价：首个请求无 sentAt）
        if (this.sendHookState === "pending") {
          if (this.hookSendWebRequest(reqObj.class)) {
            this.sendHookState = "done";
          } else {
            this.sendHookState = "failed";
          }
        }
      } catch {
        url = "";
      }
      // api 展示名用 URL 路径后缀（事实）；枚举名错位不可靠，仅在兜底时出场
      const path = url ? pathOf(url) : "";
      if (path) this.lastUrlPath = path;
      // 与 SendWebRequest 记录按 URL FIFO 配对，补上真实发出时刻
      let sentAt: string | undefined;
      const qi = this.sentQueue.findIndex((s) => s.url === url);
      if (qi >= 0) {
        sentAt = this.sentQueue[qi].time;
        this.sentQueue.splice(qi, 1);
      }
      this.emit({
        kind: "url",
        api: path || apiNameOfValue(args[1].toInt32() & 0xff),
        url,
        method,
        ...(sentAt ? { sentAt } : {}),
      });
    });

    log(
      "[network-capture] hooks ready (FormatData / MaskStringWithXOR / ProcessCommon)",
    );

    // SendWebRequest：直接按标准程序集名取（Unity 模块化后 UnityWebRequest
    // 固定在 UnityEngine.UnityWebRequestModule，O(1) 命中，注入零负担）；
    // 失败则首个请求时用实例类兜底（代价：该请求无 sentAt）
    if (this.tryHookSendDirect()) {
      this.sendHookState = "done";
    } else {
      log("[network-capture] SendWebRequest 未定位，等首个请求用实例类兜底");
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
   * 挂 UnityWebRequest.SendWebRequest（实例方法，0 参）：记录每个请求的
   * 真实发出时刻。空 body 的 POST 没有 XOR 加密调用（无 req 行），
   * 这是它们唯一的发送时间戳来源；响应侧 ProcessCommon 按 URL FIFO 配对。
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
        if (url) {
          this.sentQueue.push({ url, time: this.nowStr() });
          if (this.sentQueue.length > 64) this.sentQueue.shift();
        }
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
      `[network-capture] SendWebRequest hook ready（${cls.image.assembly.name}，记录真实发出时刻）`,
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
