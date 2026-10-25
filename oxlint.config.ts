import { defineConfig } from "oxlint";

const config: ReturnType<typeof defineConfig> = defineConfig({
    env: {
        node: true,
    },
    ignorePatterns: [
        ".spec",
        "dist",
        "node_modules",
        "vendor",
        "packages/reviewer/vendor",
    ],
    categories: {
        correctness: "warn",
    },
    rules: {
        "eslint/no-unused-vars": "error",
    },
});

export default config;
