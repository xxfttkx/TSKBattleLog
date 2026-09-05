import { log, saveJson, dumpIl2CppObject } from "../utils";
import { Mod, MethodLeaveHandler, traceMethodByName } from "../mod";

/** 导出编队单位数据到 unit_list.json（观察型，默认关闭） */
export class UnitListDumpMod implements Mod {
  name = "unit-list-dump";
  category = "观察" as const;
  description =
    "角色界面进行筛选或排序操作时将所有单位属性导出到 unit_list.json";
  enabled = false;

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TeamCharaListPresenter",
      "GetUnitListRepository",
      this,
      undefined,
      this.handleGetUnitListRepository,
    );
  }

  private handleGetUnitListRepository: MethodLeaveHandler = (
    _cls,
    method,
    retval,
  ) => {
    log("GetUnitListRepository returnType:", method.returnType.name);

    const result = retval.add(8).readPointer();

    log("UniTask.result =", result);
    if (result.isNull()) {
      log("UniTask.result is null, skip");
      return;
    }
    const TeamUnitListRepository = new Il2Cpp.Object(result);
    const TeamUnitListEntity = TeamUnitListRepository.field("result")
      .value as Il2Cpp.Object;
    const unit_list = TeamUnitListEntity.field("unit_list")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    log(`unit_list length: ${unit_list.length}`);
    const units: Record<string, any>[] = [];
    for (let i = 0; i < unit_list.length; i++) {
      // 深度 3：UnitEntity 本身占一层，其字段（如 status_data）再展开两层，
      // 与逐字段 dumpIl2CppObject(field, 2) 的展开深度一致
      units.push(dumpIl2CppObject(unit_list.get(i), 3));
    }
    saveJson("unit_list.json", units);
    log(`unit_list saved to unit_list.json`);
    const sister_unit_list = TeamUnitListEntity.field("sister_unit_list")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    log(`sister_unit_list length: ${sister_unit_list.length}`);
  };
}
