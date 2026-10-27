import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    fixedExtension: false,
    clean: true,
    external: [/^@deepseek-ai\//, /^@nokoribi\//, /^@tencent-connect\//],
});
