# 舍不得删注释┭┮﹏┭┮

## TSKBattleCalculationManager

```
  // traceMethodByName("TSKBattleCalculationManager", "FluctuationOffset");
  // traceMethodByName("TSKBattleCalculationManager", "RushOffset");
  // traceMethodByName("TSKBattleNote", "GetAttack");
  // traceMethodByName("TSKBattleCalculationManager", "CriticalOffset");
  // traceMethodByName("TSKBattleCalculationManager", "DownOffset");
```
伤害计算相关方法，`Interceptor.attach`的`onLeave(retval)`无法获取float类型的返回值，只能通过重写`method.implementation`来在方法内部获取返回值。

```
  const original = new NativeFunction(
    method.virtualAddress,
    returnType,
    argTypes,
  ) as any;
  method.implementation = function (...args: any[]) {
    if (method.isStatic) {
        ret = original(...args);
    } else {
        ret = original(this.handle, ...nativeArgs);
    }
  }
```

## 伤害
```
 // traceMethodByName("TSKBattleUtility", "GetAbilityCompatibility");
  // traceMethodByName("TSKBattleNote", "SetDamage", dumpArgsHandler);
  // traceMethodByName("DamageText", "PlayDamage", dumpArgsHandler);
  // traceMethodByName("TSKBattleTeam", "SetMultiDanameTextView", dumpArgsHandler);
  // traceMethodByName("TSKBattleSkillManager", "Execute", dumpArgsHandler);
  // traceMethodByName("TSKBattleSkillManager", "ExecuteWholeMulti", dumpArgsHandler);
  // traceMethodByName("TSKBattleSkillManager", "SetSkillEffect", dumpArgsHandler);
  // traceMethodByName("TSKBattleTeam", "StartSkillDamage", dumpArgsHandler);
  // traceMethodByName("TSKBattleCalculationManager", "CaluculationUnisonDamage", dumpArgsHandler);
```
UI层面的伤害显示与技能执行相关方法。

## GetDamageRateValue
```
    // if (method.name == "GetDamageRateValue") {
    //   args.forEach((arg, i) => {
    //     log("arg", i);
    //     log("typeof:", typeof arg);
    //     log("constructor:", arg?.constructor?.name);

    //     if (arg instanceof Il2Cpp.Object) {
    //       log("Object class:", arg.class.name);
    //     }

    //     if (arg instanceof Il2Cpp.ValueType) {
    //       log("ValueType toString:", arg.toString());
    //     }
    //   });
    // }
```
忘了，当初为什么卡住来着？

## PlayDamage
```
    // const PlayDamage = image
    //   .class("TSKBattleNote")
    //   .method("SetSkillDamageValue");
    // Interceptor.attach(PlayDamage.virtualAddress, {
    //   onEnter(args) {
    //     log(resolveMethod(this.returnAddress));
    //     // printCaller(this.context, 5);
    //   },
    //   onLeave(retval) {
    //     log(`return: ${retval}\n`);
    //   },
    // });
```
应该是显示伤害相关的，被调用的很频繁，其余忘了。

## hexdump
```
    // log(
    //   hexdump(retval, {
    //     offset: 0,
    //     length: 0x40,
    //     header: true,
    //     ansi: false,
    //   })
    // );
```
> 把 retval 指向的内存内容以十六进制转储（hexdump）出来

`GetUnitListRepository`的函数签名是`private UniTask<TeamUnitListRepository> GetUnitListRepository(bool _isOld = false) { }`。

这应该是想`尝试观察 retval 附近的原始内存布局`？总之最后这样能拿到结果：

```
    const result = retval.add(8).readPointer();
```

多嘴说一句，`GetUnitListRepository`看起来就像是和仓库中角色相关的函数，但查看所有角色时并没有被调用，反而是在sort或filter时被调用。

之前想导出自己已有角色的json，成功了，但想不到有什么用。。各种场景感觉都是直接爬wiki来的方便。

```
{
    "friend_user_id": 0,
    "is_rental": 0,
    "is_used": 0,
    "is_prohibited": 0,
    "skill_category_id_list": [
      3001,
      1002,
      9999,
      3003,
      2001
    ],
    "skill_category_id_list_by_ex_type": "TKS.Network.Domain.SkillCategoryIdListByExType",
    "effect_rate": 0,
    "u_unit_id": 11123660,
    "unit_id": 1077002,
    "character_id": 77,
    "unit_illust_id": 1077002,
    "unit_view_type": 2,
    "character_name": "蘭美",
    "character_name_kana": "ラヒ",
    "unit_name": "バニーサンタ",
    "rarity": 3,
    "max_rarity": 5,
    "attr_type": 3,
    "role": 1,
    "camp": 3,
    "camp_list": [
      3
    ],
    "affiliation": 2,
    "affiliation_list": [
      2
    ],
    "lv_limit_count": 4,
    "lv": 100,
    "max_lv": 100,
    "core_lv": 0,
    "max_core_lv": 3,
    "total_exp": 680999,
    "current_exp": 0,
    "max_exp": 99999999,
    "love_lv": 13,
    "max_love_lv": 30,
    "total_love_exp": 2456,
    "current_love_exp": 726,
    "max_love_exp": 800,
    "power": 40207,
    "team_hp": 8707,
    "is_bond_unit": 0,
    "is_event_unit": 0,
    "bond_lv": 0,
    "is_awake_unit": 0,
    "awakened_illust_display_type": 0,
    "awake_unit_illust_id": -1,
    "is_have": 0,
    "full_name": "羽宮<style=p24>はねみや</style>蘭美<style=p22>らび</style>",
    "birthday": "3月3日",
    "constellation": 12,
    "guardian_star": "アルネブ",
    "school_year": 3,
    "committee": "九浄家メイド隊・メイド長",
    "club": "",
    "hobby": "メイド修行",
    "cv": "皆月恋",
    "profile": "ヘレナによって新たに作られた、\n蘭美の『クリスマスフォーム』。\n\n肩やお腹、背中部分が大胆に露出した\nセクシーなサンタ服。\n\n「蘭美は胸こそぺったんこだが、\n　脇と腰のくびれが色気を生むのだ！」\nと服のデザインをしたヘレナが力説するほど\nこだわった衣装。\n\n蘭美も胸が薄いことは気にしているものの、\n自身の肉体美には自信があり、\n露出の多い衣装も堂々と着こなす。\n\nちなみに、戦闘服は星術で保護されているため、\n露出が多くてもまったく寒くない。",
    "status_data": "TKS.Network.Domain.UnitStatusEntity",
    "specific_gauge_data": "TKS.Network.Domain.SpecificGaugeDataEntity",
    "skill_data": [
      "TKS.Network.Domain.SkillEntity",
      "TKS.Network.Domain.SkillEntity",
      "TKS.Network.Domain.SkillEntity",
      "TKS.Network.Domain.SkillEntity"
    ],
    "unique_skill_data": [
      "TKS.Network.Domain.UnitUniqueSkillData",
      "TKS.Network.Domain.UnitUniqueSkillData",
      "TKS.Network.Domain.UnitUniqueSkillData"
    ],
    "equip_data": [
      "TKS.Network.Domain.EquipListEntity",
      "TKS.Network.Domain.EquipListEntity",
      "TKS.Network.Domain.EquipListEntity"
    ],
    "resist_data": "TKS.Network.Domain.UnitResistData",
    "sp_equip_types": [
      3
    ],
    "notice_flg": 0,
    "tab_batch_data": "TKS.Network.Domain.TabCharaDetailBatchDataEntity",
    "buff_effect": "<error>: Error: access violation accessing 0x18",
    "exclusive_exchange_shop_data": "TKS.Network.Domain.ExclusiveEquipShopEntity",
    "strengthen_flag_list": "TKS.Network.Domain.StrengthenFlagEntity",
    "base_status_data": "TKS.Network.Domain.UnitBaseStatusDataEntity"
  },
```
数据长这样，有的具体的类懒得dump下去了。有可能有用，但有用不太可能。

## SetDamageNormal
normal attack，现在从 CaluculationNormalDamage 中记录
```
  traceMethodByName(
    image,
    "TSKBattleAttack",
    "SetDamageNormal",
    this,
    this.handleSetDamageNormal,
  );

  private handleSetDamageNormal: MethodEnterHandler = (_cls, _method, args) => {
    const attack = new Il2Cpp.Object(args[1]); //TSKBattleNote
    const target = new Il2Cpp.Object(args[2]);
    log(
      `SetDamageNormal: ${getNameByTSKBattleNote(
        attack,
      )} -> ${getNameByTSKBattleNote(target)}`,
    );
  };
```

## TSKBattleNote.CT
这是turn..，不是note自身的而是当前回合数..和`TSKBattleMain.turnCount`数据相同，但后者是全局的，用起来更安心。
```
{
        fieldName: "<CT>k__BackingField",
        fallbackOffset: 0xa8,
        tag: "[CT-watch]",
      },
```

## TSKBattleNote.CurrentSpeed
下限是5的CT值，很幽默，用到时才更新，感觉有点脱裤子放屁。就是当前你在0的位置时它的数值是你上次的，你攻击完后才会计算你这次要移到哪个位置。
```
{
    className: "TSKBattleNote",
    tag: "[note-watch]",
    backtraceDepth: 6,
    fields: [
      {
        fieldName: "<CurrentSpeed>k__BackingField",
        fallbackOffset: 0xc8,
        tag: "[speed-watch]",
      },
    ],
  },
```

```
[17:14:21.090] [speed-watch] DeployNote changed <CurrentSpeed>k__BackingField: 11 -> 5
[17:14:21.119] └─ UnityEngine.AddressableAssets.AddressablesImpl.<AutoReleaseHandleOnCompletion>b__115_0+0x135e73
[17:14:21.134]   └─ TSKBattleMain.<Attack>b__88_0+0x1a7
[17:14:21.152]     └─ <CheckEndFrame>d__22.MoveNext+0x147
[17:14:21.186]       └─ UnityEngine.SetupCoroutine.InvokeMoveNext+0x65
[17:14:21.186]         └─ 0x7ffe70d7ff69
[17:14:21.186]           └─ 0x7ffe70d7ff09
```

## TSKBattleNote.TurnCount
应该是该角色出手过的次数，但好像没什么用。
```
fields: [
      {
        fieldName: "<TurnCount>k__BackingField",
        fallbackOffset: 0xa4,
        tag: "[turn-count-watch]",
      },
    ],
```

## Windows x64 的 bool 参数坑
`SetSkillDamageValue` 的 `args[8]`（isCritical）直接 `toInt32() != 0` 会把非暴击判成暴击。
Windows x64 ABI 中 bool 参数在栈槽里只有低 8 位有效，高位是残留垃圾（看起来像之前栈上的伤害值）：
落地 0x437ab 时 args[8] 读到 0x43701，低 8 位 0x01 才是真实的 bool，非暴击段读到 0x21a00（低 8 位 0x00）。

正确读法：`(args[8].toInt32() & 0xff) != 0`。`SetDamageValue` 的 `args[4]` 同理。

栈槽高位残留同样会出现在 int 参数上：`CaluculationNormalDamage` 的 `args[11]`（multipleCount）
在段号为 0 时读到 `0x7ffe00000000`（残留地址碎片 + 低 32 位真实的 0）。`toInt32()` 只取低 32 位
碰巧无碍，但说明栈传参的槽位高位一律不可信。

## TSKBattleTeam.Initialize 枚举/int 参数读出垃圾值
现象：普通关卡战斗里玩家队 Initialize 打出 `Unknown team type` / `mode=undefined` /
`overHealRate=140724603473440` 一类垃圾值，而同场敌方队完全正常；换战斗类型后
正常与否也会变。与调用次序无关，纯属参数读取姿势不对。

原因（与上面的 bool 坑同源，x64 栈槽高位一律不可信）：
- `args[5]`（TeamType）和 `args[6]`（BattleMode）是枚举，值域只有 0~7。小值域枚举
  在调用点可能按 1 字节传参，x64 栈槽只有低 8 位有效，其余是之前调用留下的残留，
  且残留模式与战斗类型相关——这解释了"有的类型正常有的不正常"。
- 直接 `toInt32()` 把高位脏位一起带出来 → 枚举反向映射查不到 → `mode=undefined`。
- `args[7]`（overHealRate，Int32）原先用 `parseInt(args[7].toString(), 16)` 读——
  `args[i].toString()` 是把参数当指针打的地址字符串，读出来自然是地址碎片；
  Int32 参数应走 `toInt32()`（本身只取低 32 位，不受高 32 位残留影响）。

解决：
```typescript
const type = args[5].toInt32() & 0xff;          // 枚举值域 0~7，只信低 8 位
const mode = args[6].toInt32() & 0xff;          // BattleMode 同理
const overHealRate = args[7].toInt32() >>> 0;   // Int32，低 32 位按无符号显示
```
枚举反向映射加 raw 兜底，低 8 位也全脏时显示原始值便于诊断：
`BattleMode[mode] ?? "raw:" + mode`。

验证（logs/20260907_202637）：普通关卡玩家队 `mode=Normal overHealRate=20000`、
敌方三波全部 `mode=Normal overHealRate=0`，垃圾值消失。

教训：栈槽参数**一律按类型/值域掩码读取**——bool 用 `& 0xff != 0`、小枚举 `& 0xff`、
int 用 `>>> 0`。也别想靠多读几个参数碰运气（mod.ts 的 argsCopy 方案已回退）：
残留内容取决于调用方路径，读得越多错得越离谱。掩码救不回整段被覆盖的低位，
那种情况只能 dump 原始槽值或换调用方间接获取。

## hook ..ctor 零命中
Unity 的 `MonoBehaviour` 派生类（如 `TSKBattleUnitIcon`）由引擎经 `Instantiate`/克隆/`AddComponent` 创建，
**不会执行托管 `.ctor`**，`Interceptor.attach` 挂上去整场战斗都等不到调用。
要拿存活实例用 `Il2Cpp.gc.choose(image.tryClass("XXX"))`（扫 GC 堆，别高频轮询），
再配一个业务方法（如 `TSKBattleTeam.Initialize`）做触发时机 + `setTimeout` 延迟等 UI 树建完。

## get_name() 返回的名字自带双引号
本环境（Unity 2021.3.25f1 + frida-il2cpp-bridge）下 `String(obj.method("get_name").invoke())`
返回的名字**首尾带双引号字符**，如 `'"TimeLine"'`。直接与 `"TimeLine"` 做相等比较永远失败，
且日志里表现为双重引号（`""UnitPlayerIconRoot""`），非常隐蔽。
gaugeTop 找 TimeLine 连续两轮失败都是这个原因（表现为 "not found"，实际节点就在 MainRoot 下）。

解决办法：比较前 `replace(/"/g, "")` 剥引号；或者根本不走字符串比较，
优先用 Unity 原生 `transform.Find("TimeLine")`（引擎内部按真实名字比较，无此问题）。

排查这类问题时可以打印一层孩子列表做对照：如果 `childNames` 能看到目标名字
而 `findChild` 返回 -1，基本就是名字内容和你以为的不一样。

## gc.choose 混入已销毁对象，invoke 前先查 m_CachedPtr
`Il2Cpp.gc.choose` 扫出的是托管侧仍被引用的对象，native 侧可能早已 `Destroy`。
对死对象 invoke 会抛 `Error: system error`（实测 30 个实例里 25 个是死的），
而且是未定义行为，有一次直接把游戏卡死。

invoke 前先读 `UnityEngine.Object` 的第一个实例字段 `m_CachedPtr`
（x64 下偏移 0x10，`Destroy` 后引擎置 0，这正是 Unity `== null` 判空的实现）：

```typescript
function isNativeAlive(obj: Il2Cpp.Object): boolean {
  try {
    return !obj.handle.add(0x10).readPointer().isNull();
  } catch {
    return true; // 读不到就保守放行
  }
}
```

只读内存不 invoke，对死对象也安全。另外 `try { 整层枚举 } catch` 的写法有陷阱：
枚举孩子时只要有一个失效节点抛错就会把整层结果吞掉，
要**逐孩子 try** 跳过，别把整层包在一个 try 里。
