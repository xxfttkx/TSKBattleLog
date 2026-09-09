import { log } from "../utils";
import { Mod } from "../mod";

/**
 * 战斗倍速（修改型）。
 *
 * 方案：每帧直接写 UnityEngine.Time.set_timeScale(SPEED)（看门狗式维持）。
 *
 * 为什么不走游戏自己的速度通道：TSKBattleConfig.SetGameSpeed() 最终也是调
 * Time.set_timeScale（IL2CPP 下 icall 按字符串 "UnityEngine.Time::set_timeScale
 * (System.Single)" 懒解析缓存），换算公式 timeScale = gameSpeed*0.5+1。
 * 但静态字段 TSKBattleConfig.gameSpeed（static_fields+0x4）是要同步给服务器的
 * 设置值，不能改；且 SetGameSpeed 受 TSKBattleConfig.ignoreChangeSpeed(static_fields+0x8) 锁标志保护（慢动作/
 * 过场时置位，阻止恢复档位冲掉演出 timeScale）。直写 timeScale 既不碰服务端
 * 状态，又能连慢动作演出一起快进（绕过锁标志，正是想要的效果）。
 *
 * 锚点 TSKBattleMain.BattleUpdate 实测为战斗驱动循环（~37fps 逐帧调用，
 * TSKBattleMain 无 Unity 原生 Update 消息），在游戏线程内 invoke 无跨线程风险。
 * timeScale==0 是游戏主动暂停，不覆盖；战斗结算 InitializeResult 写回 1；
 * 异常退出路径游戏自己的清理也会恢复（已实测）。
 *
 * 倍率由宿主通过 battleSpeed 消息运行时下发（面板工具栏下拉框，属个人偏好，
 * 存 gui_config.json）；不依赖 onLoad 时机：applyConfig 只更新目标值，
 * 看门狗下一帧即按新值维持。无宿主 run.ps1 使用内置默认 2.0。
 */
export class BattleSpeedMod implements Mod {
  name = "battle-speed";
  category = "修改" as const;
  description =
    "战斗倍速（Time.timeScale；倍率在面板工具栏调整，暂停不干预，战斗结束自动恢复）";
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
    let errorLogged = false;

    // 每帧维持/恢复倍速。均在游戏线程内 invoke（BattleUpdate 是战斗主循环），
    // 无跨线程 invoke 风险；每帧仅 1~2 次静态 icall，开销可忽略。
    // 目标倍率 self.speed 可被宿主运行时更新；timeScale == 0 是游戏主动暂停，
    // 不覆盖；mod 禁用时把当前倍速恢复为 1。
    const apply = (): void => {
      try {
        const cur = getTimeScale.invoke() as number;
        const target = self.speed;
        if (self.enabled) {
          if (cur !== 0 && Math.abs(cur - target) > 1e-6) {
            setTimeScale.invoke(target);
          }
        } else if (Math.abs(cur - target) < 1e-6) {
          setTimeScale.invoke(1);
        }
        errorLogged = false;
      } catch (e) {
        if (!errorLogged) {
          errorLogged = true;
          log(`[battle-speed] timeScale 写入失败: ${e}`);
        }
      }
    };

    const battleMain = image.class("TSKBattleMain");
    // BattleUpdate 是战斗驱动循环（实测战斗中 ~37fps 调用，非回合推进），
    // 在此每帧维持 timeScale
    Interceptor.attach(battleMain.method("BattleUpdate").virtualAddress, {
      onEnter: apply,
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
      `[battle-speed] armed: 战斗中 timeScale=${this.speed}（暂停不干预，结算恢复 1）`,
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
