const { execSync } = require("child_process");
const esbuild = require("esbuild");

// 第 1 步：类型检查（esbuild 只转译不查类型，类型断裂会静默产出坏产物；
// 半回写/签名不匹配等问题必须在打包前拦截）
execSync("npx tsc --noEmit", { stdio: "inherit" });

// 第 2 步：打包
esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/agent.js",
    platform: "neutral",
    format: "iife",
    target: "es2020"
}).catch(() => process.exit(1));

// 第 3 步：生成 mod 元数据清单（Node 执行 mods 数组，单一事实源；
// control.py 注入前渲染 MODs 页与 CI 打包共用，源码正则解析已废弃）
esbuild.build({
    entryPoints: ["src/modManifest.ts"],
    bundle: true,
    outfile: "dist/modManifest.js",
    platform: "node",
    format: "cjs",
    target: "es2020"
}).then(() => {
    const out = execSync("node dist/modManifest.js").toString();
    require("fs").writeFileSync("dist/mod_manifest.json", out);
    console.log("mod_manifest.json generated");
}).catch(() => process.exit(1));
