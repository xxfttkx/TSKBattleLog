import { log, sendHost } from "../utils";
import { Mod } from "../mod";
import { subscribeApi } from "../apiBus";

/**
 * 导出账号持有数据（观察型，默认关闭）。
 *
 * 数据源：订阅 API 总线（依赖 network-capture 发布），服务器原始全量快照，
 * 经宿主转发落盘项目 userdata/ 目录，agent 不直接写文件：
 * 游戏目录可能受写权限限制，且项目目录无需手动搬运。
 *
 * 当前采集接口：
 *   - unit/list      进主城/角色界面时自动拉取 → unit_list.json + sister_unit_list.json
 *   - warehouse/list 打开仓库界面时拉取        → warehouse.json
 *     （消耗品/强化素材/角色碎片/活动道具 5 个分组原样落盘，筛选交给消费方）
 *
 * 注意：需要同时勾选 network-capture 才有数据来源；只勾本 mod 时
 * 静默待命（日志提醒）。
 */
export class UserDataDumpMod implements Mod {
  name = "user-data-dump";
  category = "观察" as const;
  description =
    "拉取角色列表/打开仓库时自动导出账号持有数据（依赖 network-capture）";
  enabled = false;

  onLoad(_image: Il2Cpp.Image): void {
    log(
      "[user-data-dump] 订阅 unit/list + warehouse/list" +
        "（数据来源 network-capture；若未勾选则不会有数据）",
    );

    subscribeApi("unit/list", (body) => {
      try {
        const result = body?.result;
        if (!result) {
          log("[user-data-dump] unit/list 响应无 result 字段，跳过");
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
        log(`[user-data-dump] unit/list 推送失败: ${e}`);
      }
    });

    subscribeApi("warehouse/list", (body) => {
      try {
        // warehouse_list 为单元素数组，元素内含 5 个分组 list
        // （item_list/stren_list/chara_piece_list/event_item_list/important_item_list）
        const wh = body?.result?.warehouse_list?.[0];
        if (!wh) {
          log("[user-data-dump] warehouse/list 响应无数据，跳过");
          return;
        }
        sendHost("warehouseDump", wh);
        const groups = Object.keys(wh)
          .filter((k) => Array.isArray(wh[k]))
          .map((k) => `${k.replace(/_list$/, "")}:${wh[k].length}`)
          .join(" ");
        log(`warehouse 数据已推送宿主 (${groups})`);
      } catch (e) {
        log(`[user-data-dump] warehouse/list 推送失败: ${e}`);
      }
    });
  }
}
