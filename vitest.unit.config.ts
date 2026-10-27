import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
    test: {
        include: ["packages/*/test/**/*.test.ts"],
        environment: "node",
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});

export default config;
