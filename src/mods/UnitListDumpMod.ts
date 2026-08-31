import { log, saveJson, convertValue } from "../utils";
import { Mod, MethodLeaveHandler, traceMethodByName } from "../mod";

/** 导出编队单位数据到 unit_list.json（观察型，默认关闭） */
export class UnitListDumpMod implements Mod {
  name = "unit-list-dump";

  onLoad(image: Il2Cpp.Image): void {
    traceMethodByName(
      image,
      "TeamCharaListPresenter",
      "GetUnitListRepository",
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
      const UnitEntity = unit_list.get(i);
      const unit: Record<string, any> = {};
      for (const field of UnitEntity.class.fields) {
        try {
          const value = UnitEntity.field(field.name).value;
          unit[field.name] = convertValue(value);
        } catch (e) {
          unit[field.name] = `<error>: ${e}`;
        }
      }
      units.push(unit);
    }
    saveJson("unit_list.json", units);
    log(`unit_list saved to unit_list.json`);
    const sister_unit_list = TeamUnitListEntity.field("sister_unit_list")
      .value as Il2Cpp.Array<Il2Cpp.Object>;
    log(`sister_unit_list length: ${sister_unit_list.length}`);
  };
}
