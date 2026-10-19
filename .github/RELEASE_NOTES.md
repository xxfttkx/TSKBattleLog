## 新增

- **Capture 标签页**：抓游戏 API 请求/响应明文 JSON 落盘 `logs/capture/`。同一次请求合并显示（接口名、耗时、参数摘要），点行看完整 JSON（语法高亮），失败响应标红；「原始事件」开关看未合并事件流
- **user-data-dump**：订阅 API 把账号数据落盘 `userdata/`
  - `unit/list` → `unit_list.json` + `sister_unit_list.json`
  - `warehouse/list` → `warehouse.json`（含角色碎片）
- buff 弹窗显示 EX 上升加成（`148（+60）` 格式），普攻回复 EX 同步
- 战斗日志回合分隔行显示累计伤害和一巡可使用 EX

## 修复

- `Interceptor.attach` 跨回调状态丢失（导致 req 行抓不到）
- `traceMethodByName` 按需挂载

## 变更

- mod key `unit-list-dump` → `user-data-dump`
