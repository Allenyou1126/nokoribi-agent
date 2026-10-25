import { defineConfig } from "oxlint";

export default defineConfig({
    env: {
        node: true,
    },
    ignorePatterns: [".spec", "dist", "node_modules"],
    categories: {
        correctness: "warn",
    },
    rules: {
        "eslint/no-unused-vars": "error",
    },
});
