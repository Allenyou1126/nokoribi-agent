import { defineConfig } from "oxfmt";

const config: ReturnType<typeof defineConfig> = defineConfig({
    ignorePatterns: [".spec", "*.md", "dist", "node_modules", "vendor"],
    printWidth: 80,
    trailingComma: "es5",
    tabWidth: 4,
    semi: true,
    singleQuote: false,
    useTabs: false,
    importOrderSortSpecifiers: true,
    sortImports: true,
});

export default config;
