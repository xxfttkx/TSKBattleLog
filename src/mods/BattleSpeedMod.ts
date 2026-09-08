import { log } from "../utils";
import { Mod } from "../mod";

/** 战斗倍速（修改型） */
export class BattleSpeedMod implements Mod {
  name = "battle-speed";
  category = "修改" as const;
  description =
    "战斗中 2 倍速（Time.timeScale；游戏暂停时不干预，战斗结束自动恢复）";
  enabled = true;

  /** 目标倍速：想改倍率改这里（3.0 即 3 倍速） */
  private static readonly SPEED = 2.0;

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
    const SPEED = BattleSpeedMod.SPEED;
    const self = this;
    let errorLogged = false;

    // 每帧维持/恢复倍速。均在游戏线程内 invoke（BattleUpdate 是战斗主循环），
    // 无跨线程 invoke 风险；每帧仅 1~2 次静态 icall，开销可忽略。
    // timeScale == 0 是游戏主动暂停，不覆盖；mod 禁用时把倍速恢复为 1。
    const apply = (): void => {
      try {
        const cur = getTimeScale.invoke() as number;
        if (self.enabled) {
          if (cur !== 0 && Math.abs(cur - SPEED) > 1e-6) {
            setTimeScale.invoke(SPEED);
          }
        } else if (Math.abs(cur - SPEED) < 1e-6) {
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
      `[battle-speed] armed: 战斗中 timeScale=${SPEED}（暂停不干预，结算恢复 1）`,
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
