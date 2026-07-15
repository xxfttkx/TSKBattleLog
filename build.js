const esbuild = require("esbuild");

esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/agent.js",
    platform: "neutral",
    format: "iife",
    target: "es2020"
}).catch(() => process.exit(1));