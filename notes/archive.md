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
下限是5的CT值，很幽默，用到时才更新，感觉有点脱裤子放屁。
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