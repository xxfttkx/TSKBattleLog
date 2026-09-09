import { log } from "../utils";
import { Mod } from "../mod";

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
 * 做轻量兜底：仅当处于高速段（timeScale≥1.25）且偏离目标值时才纠正，让运行时
 * 改倍率即时生效；timeScale≤1（演出/选技能=1、暂停=0）一律不碰。
 * 战斗结算 InitializeResult 无条件写回 1，避免倍率残留到主城/菜单。
 *
 * 倍率由宿主通过 battleSpeed 消息运行时下发（面板「设置」页下拉框，属个人偏好，
 * 存 gui_config.json）；applyConfig 只更新目标值，兜底下一帧即按新值维持。
 * 无宿主 run.ps1 使用内置默认 2.0。
 */
export class BattleSpeedMod implements Mod {
  name = "battle-speed";
  category = "修改" as const;
  description =
    "战斗倍速（空闲推进加速；QTE/技能演出/选技能保持正常速度，结算自动恢复）";
  enabled = true;

  /** 目标倍速：默认 2.0，宿主可通过 applyConfig 运行时下发（1.0~10.0） */
  speed = 2.0;

  /** 宿主下发倍率（battleSpeed 消息 {speed}）。onLoad 前后均可调用。 */
  applyConfig(speed: number): void {
    if (typeof speed !== "number" || !isFinite(speed)) return;
    const clamped = Math.min(10, Math.max(1, speed));
    if (clamped !== this.speed) {
      log(`[battle-speed] 倍率: ${this.speed} -> ${clamped}`);
      this.speed = clamped;
    }
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
    const staticFields = cfg.handle.add(0xb8).readPointer();
    const readLocked = (): boolean => {
      try {
        return staticFields.add(0x8).readU8() !== 0;
      } catch {
        return true; // 读不到按「锁住」处理，宁可不写也不打断演出
      }
    };
    const readGameSpeed = (): number => {
      try {
        return staticFields.add(0x4).readS32();
      } catch {
        return 2;
      }
    };

    // 核心：替换 SetGameSpeed（游戏「恢复高速」收口）。
    // 锁=0 时游戏原本写 gameSpeed*0.5+1（最高 2），改写成 self.speed（可超 2）；
    // 锁=1 时原方法直接 return（开场/演出中不打断），我们也不写，
    // timeScale 保持游戏设的 1（QTE/技能演出/选技能菜单正常速度）。
    // mod 禁用时复刻原生档位值，行为与未装 mod 一致。
    cfg.method("SetGameSpeed").implementation = function (): void {
      try {
        if (readLocked()) return;
        if (self.enabled) {
          setTimeScale.invoke(self.speed);
        } else {
          setTimeScale.invoke(readGameSpeed() * 0.5 + 1.0);
        }
      } catch (e) {
        log(`[battle-speed] SetGameSpeed replacement 出错: ${e}`);
      }
    };

    // 轻量兜底：BattleUpdate 每帧（~37fps，游戏线程内）仅在高速段维持目标倍率，
    // 让宿主运行时改倍率即时生效。timeScale≥1.25 才算高速段（档位 1.5/2 或自定义
    // ≥1.5）；演出/选技能(=1)、暂停(=0) 一律不碰。
    const battleMain = image.class("TSKBattleMain");
    Interceptor.attach(battleMain.method("BattleUpdate").virtualAddress, {
      onEnter() {
        if (!self.enabled) return;
        try {
          const cur = getTimeScale.invoke() as number;
          if (cur >= 1.25 && Math.abs(cur - self.speed) > 1e-6) {
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

    log(
      `[battle-speed] armed: 空闲推进 ${this.speed}x（演出/选技能/QTE 保持 1x，结算恢复 1）`,
    );
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
