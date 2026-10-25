import { defineConfig } from "oxfmt";

export default defineConfig({
    ignorePatterns: [".spec", "*.md", "dist", "node_modules"],
    printWidth: 80,
    trailingComma: "es5",
    tabWidth: 4,
    semi: true,
    singleQuote: false,
    useTabs: false,
    importOrderSortSpecifiers: true,
    sortImports: true,
});
