# AGENTS.md

Nokoribi Agent 的仓库开发指南。项目定位与技术规格见 [README.md](README.md) 与 [.spec/](.spec/)。

## 当前状态

- M1（骨架与消息闭环）与 M2（安全闸与审批）已实现；M3–M6 按 [.spec/14-roadmap.md](.spec/14-roadmap.md) 推进。代码在 `packages/`，入口是 `packages/launcher`。
- M2 的 reviewer 是 `packages/reviewer` 中 vendored 的 rc.3 auto-review；修改 vendor 时同步更新 `PATCHES.md`/`VERSION.md`。
- `pnpm check` 会先构建 workspace 包（类型检查依赖各包 `dist/*.d.ts`），然后运行 tsc/oxlint/oxfmt。
- 决策以 [.spec/03-decision-log.md](.spec/03-decision-log.md) 为准；被取代/撤销的决定登记在 [.spec/16-superseded-and-glossary.md](.spec/16-superseded-and-glossary.md)。
- 实现偏离规格时必须同步更新规格与决策记录，不能只改代码。

## 工具链

- Node.js 24，ESM（`package.json` 的 `"type": "module"`）。
- pnpm；`packageManager` 已固定，锁文件随依赖一起提交。
- oxfmt（格式化）、oxlint（lint）、`tsc --noEmit`（类型检查）。
- 工具配置在根目录 `oxfmt.config.ts`、`oxlint.config.ts`、`tsconfig.json`；不要把配置挪到 CLI flag。
- 只能通过 `pnpm run <script>` 或 `pnpm <script>` 执行工具，**禁止直接执行 `node_modules` 下的二进制**（如 `./node_modules/.bin/oxlint`）。
- tsdown 构建、Vitest 测试；`pnpm test:process` 会先构建再跑进程级场景。
- Markdown 文档由人工维护，oxfmt 已忽略 `*.md` 与 `.spec/`。

## 命令

- `pnpm install` — 安装依赖
- `pnpm format` — 格式化
- `pnpm format:check` — 检查格式
- `pnpm lint` / `pnpm lint:fix` — lint / 自动修复
- `pnpm typecheck` — 先构建 workspace 包，再根与每包 `tsc --noEmit`
- `pnpm check` — 依次执行 typecheck（含构建）、lint、format:check
- 提交前运行 `pnpm check`。

## 结构

- `.spec/`：设计规格；[README.md](README.md) 为索引。
- 已创建的 `packages/*`、`vendor/profile-boot`、`templates/` 与将来的 `nix/` 见 [.spec/04-architecture-and-build.md](.spec/04-architecture-and-build.md)；保持该文件中的边界与依赖方向。
- 每个 package 建立后拥有自己的 `tsconfig`，并继承根 TypeScript 约束（strict、`verbatimModuleSyntax`、`isolatedModules`）。
- 不提交密钥、真实 token、运行时状态或本机配置。

## 代码约定

- TypeScript strict、ESM-only，目标 Node 24；不使用 CJS。
- 类型导入必须使用 `import type`（`verbatimModuleSyntax` + `isolatedModules`）。
- 格式由 oxfmt 统一：4 空格缩进、双引号、分号、80 列；不要手工对抗格式化。
- lint 规则：correctness 类别为 warn，`eslint/no-unused-vars` 为 error；不要用 disable 注释绕过，除非有明确原因并注释说明。
- 新增依赖需要有明确理由；保持依赖方向：`shared` 最低，`bundle` 只做装配，细节见 `.spec/04`。
- 不在代码中写死超时/路径/模型等部署参数；按规格从配置读取。

## 提交约定

- 使用 Conventional Commits：`type(scope): subject`。
- type：`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `build` / `ci` / `perf` / `style` / `revert`。
- scope 可选，使用包名或区域（如 `channel`、`shell`、`nix`）。
- subject 简洁、祈使语气、不超过 72 字符；正文说明 what/why/影响，可用 bullet。
- **适当拆分**：一个提交只做一个逻辑变更；文档、工具链、代码改动分开；纯格式化与行为修改分开；不要把多个不相关改动塞进一个提交。
- 每次 agent 完成的提交，末尾必须加：
  `Assisted-By: DeepSeek Harness:deepseek-flash`
  （格式：`Assisted-By: [Agent Name]:[Model Name]`；使用实际执行的 Agent 与模型）
- 提交前运行 `pnpm check`；涉及文档时确认 README/规格链接未失效。
- 不提交 WIP 或生成物；`dist/`、`coverage/`、`node_modules/` 已忽略。
- 未经要求不要 amend、rebase 或改写已有提交。
