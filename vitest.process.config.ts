import { defineConfig } from "vitest/config";

const config: ReturnType<typeof defineConfig> = defineConfig({
    test: {
        include: ["tests/process/**/*.test.ts"],
        environment: "node",
        fileParallelism: false,
        testTimeout: 60000,
        hookTimeout: 60000,
    },
});

export default config;
