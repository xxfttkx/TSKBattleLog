/**
 * mod 元数据清单生成入口（仅构建期在 Node 里执行，不进 agent 产物）。
 *
 * mod 类实例化只初始化元数据字符串、不触碰 Il2Cpp/Frida 运行时，因此可
 * 纯 Node 求值：build.js 用 node 平台打包本文件并执行，stdout 即
 * mod_manifest.json，供 control.py 注入前渲染 MODs 页与 CI 打包共用。
 * 源码正则解析已废弃（正则对多行字符串/引号变化脆弱，且 CI 与 GUI 需各抄一份）。
 */
import { createMods } from "./mods/createMods";

const manifest = createMods().map((m) => ({
  name: m.name,
  category: m.category ?? "观察",
  description: m.description ?? "",
}));

console.log(JSON.stringify(manifest, null, 2));
