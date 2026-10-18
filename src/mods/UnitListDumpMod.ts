import { log, sendHost } from "../utils";
import { Mod } from "../mod";
import { subscribeApi } from "../apiBus";

/**
 * 导出编队单位数据（观察型，默认关闭）。
 *
 * 数据源：订阅 API 总线的 unit/list 响应（依赖 network-capture 发布）——
 * 游戏进入主城/角色界面时自动拉取，服务器原始全量数据（约 221 个单位）。
 * 数据经宿主转发落盘项目 gamedata/ 目录（unitList 消息），agent 不直接
 * 写文件：游戏目录可能受写权限限制，且项目目录无需手动搬运。
 * 旧实现 hook GetUnitListRepository 遍历 IL2CPP 实体类，实测有
 * <error> 访问违规字段与 int64 字符串化问题，已整体替换为网络侧数据。
 *
 * 注意：需要同时勾选 network-capture 才有数据来源；只勾本 mod 时
 * 静默待命（日志提醒）。
 */
export class UnitListDumpMod implements Mod {
  name = "unit-list-dump";
  category = "观察" as const;
  description =
    "游戏拉取角色列表时自动导出全量单位数据（依赖 network-capture）";
  enabled = false;

  onLoad(_image: Il2Cpp.Image): void {
    log(
      "[unit-list-dump] 订阅 unit/list（数据来源 network-capture；" +
        "若未勾选 network-capture 则不会有数据）",
    );

    subscribeApi("unit/list", (body) => {
      try {
        const result = body?.result;
        if (!result) {
          log("[unit-list-dump] unit/list 响应无 result 字段，跳过");
          return;
        }
        const unitList = result.unit_list ?? [];
        const sisterList = result.sister_unit_list ?? [];
        sendHost("unitListDump", {
          unit_list: unitList,
          sister_unit_list: sisterList,
        });
        log(`unit_list 数据已推送宿主 (${unitList.length} units)`);
      } catch (e) {
        log(`[unit-list-dump] 推送失败: ${e}`);
      }
    });
  }
}
