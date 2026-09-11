import { isDebugLog, log, logDebug } from "../utils";
import { Mod } from "../mod";
import { buildMethodIndex, resolveMethod } from "../debug/MethodResolver";

/**
 * 战斗倍速（修改型）。
 *
 * 实测机制（logs/20260910_000145）：游戏只在「空闲自动推进」段用档位高速，
 * QTE / 技能与攻击演出 / 选技能菜单 / 开场 全部主动把 timeScale 设回 1（正常
 * 速度），结束后才调 TSKBattleConfig.SetGameSpeed() 恢复档位。SetGameSpeed 是
 * 「恢复高速」的唯一收口：它无参，读静态字段 gameSpeed(static_fields+0x4, 三档
 * 0/1/2)，锁标志 ignoreChangeSpeed(static_fields+0x8) 为 0 时才写
 * timeScale = gameSpeed*0.5+1，锁=1（开场/演出中）直接 return 不写。
 *
 * 方案：replacement SetGameSpeed——锁=0 时把原本要写的 gameSpeed*0.5+1 换成
 * self.speed（自定义倍率，可超过游戏上限 2）；锁=1 时和原方法一样什么都不做，
 * timeScale 保持游戏设的 1（演出/选技能/QTE 保持正常速度，不压缩操作与动画）。
 * 不碰 gameSpeed（服务器同步），也不 hook set_timeScale（避开 x64 浮点走 XMM
 * 寄存器、onEnter 读 args 拿不到 float 的坑）。
 *
 * 另挂 TSKBattleMain.BattleUpdate（战斗驱动循环，~37fps，游戏线程内 invoke）
 * 做兜底，判据是 ignoreChangeSpeed 锁本身而非 timeScale 当前值：锁=0（空闲可高速）
 * 且非暂停时每帧维持目标值——即使进战斗首个空闲段游戏没调 SetGameSpeed、cur 还
 * 停在 1 也能立即提速（旧门槛 cur>=1.25 会「卡在 1 永远提不上来」，已废）；
 * 锁=1（开场/演出/选技能）、timeScale=0（暂停）一律不碰。
 *
 * forceSpeed 全局开关（面板，默认关）：开启后兜底无视锁，每帧锁定 timeScale=speed，
 * 等同旧看门狗——EX 选择与大招演出全程加速（普通选技能菜单/QTE/开场也会一并变快）。
 * 战斗结算 InitializeResult 无条件写回 1，避免倍率残留到主城/菜单。
 *
 * 倍率由宿主通过 battleSpeed 消息运行时下发（面板「设置」页下拉框，属个人偏好，
 * 存 gui_config.json），载荷 {speed, force}；applyConfig 只更新目标值，
 * 兜底下一帧即按新值维持。无宿主 run.ps1 使用内置默认 2.0。
 *
 * 诊断输出（[speed]/[ex] 探针日志）受全局诊断开关控制（宿主 setDebug 消息，
 * 所有 mod 共用，见 utils.logDebug/isDebugLog）；本 mod 额外实现 applyDebugConfig
 * 在开关翻转时即时装/拆重型探针（set_timeScale 观察者 + 100ms 轮询）。
 */
export class BattleSpeedMod implements Mod {
  name = "battle-speed";
  category = "修改" as const;
  description =
    "战斗倍速（空闲推进加速；QTE/技能演出/选技能保持正常速度，结算自动恢复）";
  enabled = true;

  /** 目标倍速：默认 2.0，宿主可通过 applyConfig 运行时下发（1.0~10.0） */
  speed = 2.0;

  /**
   * 全局模式（宿主 battleSpeed 消息 {force} 下发，个人偏好，默认关）。
   * 关：仅锁=0 的空闲推进段加速，演出/选技能/QTE 保持 1x；
   * 开：BattleUpdate 每帧无视锁锁定 timeScale=speed（旧看门狗行为），
   *     EX 选择与大招演出、连普通选技能菜单/QTE/开场都一起加速。
   */
  forceSpeed = false;

  /** onLoad 是否完成（探针只能在 hook 引用就绪后装拆） */
  private loaded = false;
  /** 诊断探针依赖的 onLoad 局部引用，开启时取用 */
  private timeGet: Il2Cpp.Method | null = null;
  private timeSet: Il2Cpp.Method | null = null;
  private readLockedFn: (() => boolean) | null = null;
  /** 已装探针句柄：set_timeScale 观察者 / 100ms 轮询定时器，关闭即 detach+clear */
  private exListener: InvocationListener | null = null;
  private exPollTimer: ReturnType<typeof setInterval> | null = null;

  /** 宿主下发倍率（battleSpeed 消息 {speed}）。onLoad 前后均可调用。 */
  applyConfig(speed: number): void {
    if (typeof speed !== "number" || !isFinite(speed)) return;
    const clamped = Math.min(10, Math.max(1, speed));
    log(`[battle-speed] 倍率: ${clamped}`);
    if (clamped !== this.speed) {
      this.speed = clamped;
    }
  }

  /** 宿主下发全局模式开关（battleSpeed 消息 {force}）。onLoad 前后均可。 */
  applyForceConfig(force: boolean): void {
    const v = !!force;
    log(`[battle-speed] 全局加速: ${v ? "开" : "关"}`);
    if (v !== this.forceSpeed) {
      this.forceSpeed = v;
    }
  }

  /**
   * 全局诊断开关翻转回调（宿主 setDebug 广播，Mod 接口可选方法）。
   * onLoad 已完成时即时装/拆速度探针；细粒度日志本身走 logDebug 全局门控。
   * 翻转反馈始终留一行普通日志（关的瞬间此行仍可见）。
   */
  applyDebugConfig(on: boolean): void {
    const v = !!on;
    log(`[battle-speed] 诊断日志: ${v ? "开" : "关"}`);
    if (this.loaded) this.setExProbes(v);
  }

  onLoad(image: Il2Cpp.Image): void {
    // 查找 UnityEngine.Time：不预设程序集名/命名空间，遍历所有程序集，
    // 以「类名 Time 且含静态 get/set_timeScale」为判据（同名自定义类据此排除）
    const timeCls = this.findTimeClass();
    if (!timeCls) {
      log("[battle-speed] UnityEngine.Time 未找到，mod 不生效");
      return;
    }

    const getTimeScale = timeCls.method("get_timeScale");
    const setTimeScale = timeCls.method("set_timeScale");
    log(`[battle-speed] Time 类定位: ${timeCls.namespace}.${timeCls.name}`);

    const self = this;

    // TSKBattleConfig 静态字段区（Il2CppClass.static_fields，本 Unity 版本偏移
    // 0xb8，Ghidra + 诊断日志双重标定）：
    //   +0x4 = int  gameSpeed（三档 0/1/2，服务器同步，只读不改）
    //   +0x8 = byte ignoreChangeSpeed（锁：0=应用档位/可恢复高速，1=演出/开场中不应用）
    const cfg = image.class("TSKBattleConfig");
    // 静态字段指针必须惰性解析，不能在 onLoad 时一次缓存：
    // IL2CPP 类的 static_fields 内存在类首次使用时才分配。若注入时游戏还在
    // 主菜单（TSKBattleConfig 尚未初始化），这里读到 NULL 并缓存，之后所有
    // 读取都走 catch→true，表现为「整场恒锁、倍速永不生效」（2026-09-11 首战 bug）。
    // 拿到非空指针后缓存——IL2CPP 分配后地址在进程生命周期内稳定。
    let staticFields: NativePointer = NULL;
    const resolveStaticFields = (): NativePointer => {
      if (!staticFields.isNull()) return staticFields;
      try {
        const p = cfg.handle.add(0xb8).readPointer();
        if (!p.isNull()) {
          staticFields = p;
          if (isDebugLog()) {
            logDebug(`[speed] TSKBattleConfig 静态字段已分配: ${p}`);
          }
        }
      } catch {
        /* 类尚未初始化，下一帧再试 */
      }
      return staticFields;
    };
    const readLocked = (): boolean => {
      const sf = resolveStaticFields();
      if (sf.isNull()) return true; // 类未初始化：按「锁住」处理，宁可不写也不打断演出
      try {
        return sf.add(0x8).readU8() !== 0;
      } catch {
        return true;
      }
    };
    const readGameSpeed = (): number => {
      const sf = resolveStaticFields();
      if (sf.isNull()) return 2;
      try {
        return sf.add(0x4).readS32();
      } catch {
        return 2;
      }
    };

    // 存给诊断探针动态装拆用（applyDebugConfig 运行时开关）
    this.timeGet = getTimeScale;
    this.timeSet = setTimeScale;
    this.readLockedFn = readLocked;

    // 核心：替换 SetGameSpeed（游戏「恢复高速」收口）。
    // 锁=0 时游戏原本写 gameSpeed*0.5+1（最高 2），改写成 self.speed（可超 2）；
    // 锁=1 时原方法直接 return（开场/演出中不打断），我们也不写，
    // timeScale 保持游戏设的 1（QTE/技能演出/选技能菜单正常速度）。
    // mod 禁用时复刻原生档位值，行为与未装 mod 一致。
    cfg.method("SetGameSpeed").implementation = function (): void {
      try {
        const locked = readLocked();
        if (self.enabled && isDebugLog()) {
          // 诊断日志（全局诊断开关）：SetGameSpeed 一场只调几次，
          // 打印锁值/写倍率，定位「游戏在哪段上锁、哪段恢复」
          logDebug(
            `[speed] SetGameSpeed: locked=${locked ? 1 : 0} -> ` +
              (locked ? "不动（演出/开场）" : `写 ${self.speed}x`),
          );
        }
        if (locked) return;
        if (self.enabled) {
          setTimeScale.invoke(self.speed);
        } else {
          setTimeScale.invoke(readGameSpeed() * 0.5 + 1.0);
        }
      } catch (e) {
        log(`[battle-speed] SetGameSpeed replacement 出错: ${e}`);
      }
    };

    // 兜底：BattleUpdate 每帧（~37fps）维持目标倍率。
    //  - forceSpeed 关（默认）：读 ignoreChangeSpeed 锁，锁=0（空闲推进）才维持；
    //    锁=1（开场/演出/选技能）、cur=0（暂停）不碰。不看 cur 当前值，所以进战斗
    //    首个空闲段即使游戏没调 SetGameSpeed、cur 还停在 1 也能立即提速。
    //  - forceSpeed 开（全局）：无视锁，只要非暂停每帧锁定 timeScale=speed（旧看门狗），
    //    EX 选择+大招演出、连普通选技能菜单/QTE/开场都一起加速。
    // 诊断日志（全局诊断开关）：仅在「锁翻转」或「速度段变化」时打印，避免每帧刷屏。
    const battleMain = image.class("TSKBattleMain");
    let lastLocked: boolean | null = null;
    let lastBucket = -999;
    Interceptor.attach(battleMain.method("BattleUpdate").virtualAddress, {
      onEnter() {
        try {
          const cur = getTimeScale.invoke() as number;
          const locked = readLocked();
          if (isDebugLog()) {
            const bucket = cur === 0 ? -1 : Math.round(cur * 10);
            if (locked !== lastLocked || bucket !== lastBucket) {
              logDebug(
                `[speed] 状态: locked=${locked ? 1 : 0} curTimeScale=${cur} ` +
                  `target=${self.speed} force=${self.forceSpeed ? 1 : 0} ` +
                  `enabled=${self.enabled ? 1 : 0}`,
              );
              lastLocked = locked;
              lastBucket = bucket;
            }
          }

          if (!self.enabled || cur === 0) return; // 禁用 / 暂停不碰
          const shouldHold = self.forceSpeed || !locked;
          if (shouldHold && Math.abs(cur - self.speed) > 1e-6) {
            setTimeScale.invoke(self.speed);
          }
        } catch {
          /* 单帧失败忽略，下一帧再试 */
        }
      },
    });

    // 战斗结束（结算画面）：无条件恢复正常速度，避免倍速残留到主城/菜单
    const battleManager = image.class("TSKBattleManager");
    Interceptor.attach(
      battleManager.method("InitializeResult").virtualAddress,
      {
        onEnter() {
          try {
            setTimeScale.invoke(1);
          } catch {
            /* ignore */
          }
        },
      },
    );

    // 诊断探针默认不装（避免全量方法索引的秒级启动开销与常驻轮询）；
    // 全局诊断开关开时才装，运行时关开即时装拆，见 setExProbes。
    this.loaded = true;
    if (isDebugLog()) this.setExProbes(true);

    log(
      `[battle-speed] armed: ${this.speed}x force=${this.forceSpeed ? 1 : 0}` +
        `（关：空闲推进加速、演出/选技能/QTE 1x；开：全程锁定；结算恢复 1）`,
    );
  }

  /**
   * 诊断探针装/拆（debug 开关驱动，运行时可反复调用）。
   *  1) Interceptor 挂 set_timeScale：onEnter 记调用者，onLeave 读「已生效的新值」
   *     （float 参数在 xmm，onEnter 的 args 读不到，故在 onLeave 用 get_timeScale 读），
   *     值变化才打印，带调用者反解；
   *  2) setInterval 100ms 在 Il2Cpp.perform 里轮询 timeScale + 锁——即使某段
   *     TSKBattleMain.BattleUpdate 不跑也能看到 timeScale 变化（EX 演出即靠它定性）。
   * 判读：轮询一直是 3 但画面 1x → 演出不读 timeScale；掉到 1 → 看 [ex-diag] 的 by。
   * 关闭时 detach 钩子 + clearInterval，不留常驻开销；方法索引本身幂等，只建一次。
   */
  private setExProbes(on: boolean): void {
    if (on) {
      if (this.exListener || this.exPollTimer !== null) return;
      const getTimeScale = this.timeGet;
      const setTimeScale = this.timeSet;
      const readLocked = this.readLockedFn;
      if (!getTimeScale || !setTimeScale || !readLocked) return;

      try {
        buildMethodIndex();
      } catch {
        /* 索引构建失败也不影响轮询，只是调用者反解成裸地址 */
      }

      let lastSetVal = -999;
      let pendingCaller: NativePointer | null = null;
      this.exListener = Interceptor.attach(setTimeScale.virtualAddress, {
        onEnter() {
          pendingCaller = this.returnAddress;
        },
        onLeave() {
          try {
            const v = getTimeScale.invoke() as number;
            if (Math.abs(v - lastSetVal) > 1e-6) {
              lastSetVal = v;
              log(
                `[ex-diag] set_timeScale -> ${v}  by ${resolveMethod(
                  pendingCaller ?? this.returnAddress,
                )}`,
              );
            }
          } catch {
            /* ignore */
          }
        },
      });

      let lastPollVal = -999;
      let lastPollLock: boolean | null = null;
      this.exPollTimer = setInterval(() => {
        Il2Cpp.perform(() => {
          try {
            const v = getTimeScale.invoke() as number;
            const lk = readLocked();
            if (Math.abs(v - lastPollVal) > 1e-6 || lk !== lastPollLock) {
              lastPollVal = v;
              lastPollLock = lk;
              log(`[ex-poll] timeScale=${v} locked=${lk ? 1 : 0}`);
            }
          } catch {
            /* 场景切换等瞬间读取失败，忽略 */
          }
        });
      }, 100);

      log("[ex-diag] 诊断探针已装上：复现一次速度异常即可（如手动放 EX）");
      return;
    }

    // 关闭：先停定时器再拆钩子，两路都要清
    if (this.exPollTimer !== null) {
      clearInterval(this.exPollTimer);
      this.exPollTimer = null;
    }
    if (this.exListener) {
      try {
        this.exListener.detach();
      } catch {
        /* ignore */
      }
      this.exListener = null;
    }
    logDebug("[ex] 诊断探针已拆除");
  }

  /**
   * 查找 UnityEngine.Time。
   * frida-il2cpp-bridge 的 image.tryClass：命名空间下的类必须传完整名
   * "Namespace.Name"（裸名只命中无命名空间的类）。先完整名快速路径，
   * 再全量枚举兜底；以含 get/set_timeScale 方法验明正身。
   */
  private findTimeClass(): Il2Cpp.Class | null {
    for (const asm of Il2Cpp.domain.assemblies) {
      let c: Il2Cpp.Class | null = null;
      try {
        // 命名空间下的类 tryClass 必须传完整名 "UnityEngine.Time"；
        // 裸类名只命中无命名空间的类（游戏代码 TSKBattleXxx 之类）
        c =
          asm.image.tryClass("UnityEngine.Time") ?? asm.image.tryClass("Time");
      } catch {
        continue;
      }
      if (c && this.hasTimeScale(c)) return c;
    }
    // 兜底：全量枚举类名（tryClass 命名规则不符时仍能定位）
    for (const asm of Il2Cpp.domain.assemblies) {
      try {
        for (const cls of asm.image.classes) {
          if (cls.name === "Time" && this.hasTimeScale(cls)) {
            log(
              `[battle-speed] Time 类定位（枚举兜底）: ${cls.namespace}.${cls.name}`,
            );
            return cls;
          }
        }
      } catch {
        /* ignore */
      }
    }
    log("[battle-speed] 遍历所有程序集仍未找到含 timeScale 的 Time 类");
    return null;
  }

  /** 验明正身：该类同时拥有静态 get/set_timeScale（icall），同名自定义类据此排除 */
  private hasTimeScale(c: Il2Cpp.Class): boolean {
    try {
      c.method("get_timeScale");
      c.method("set_timeScale");
      return true;
    } catch {
      return false;
    }
  }
}
