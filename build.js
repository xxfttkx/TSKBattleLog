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
