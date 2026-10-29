# AGENTS.md

Nokoribi Agent 的仓库开发指南。项目定位与技术规格见 [README.md](README.md) 与 [.spec/](.spec/)。

## 当前状态

- M1（骨架与消息闭环）、M2（安全闸与审批）、M3（shell hosts 与 sandbox）、M4（goal 子代理）、M5（memory、schedule、提示词收尾）、M6（NixOS 部署闭环）、M7（channel-core IM 基础设施扩展）、M8（QQ 官方 Bot）、M9（QQ C2C 审批按钮）与 M10（host-aware 持久终端 + Web Search/Fetch）的代码已实现；M6 的 NixOS 目标机手工验收、M8 的 14 项平台事实门禁与 17.8.2、M9 的交互门禁 #15–#20、M10 的 G5（DeepSeek Search/Fetch API 切换）与 systemd 12.14 目标机验收仍需执行；M10 的 G2/G3/G4/G6 已于 2026-10-29 在 hkg-dog-darell 用户态通过。代码在 `packages/`，入口是 `packages/launcher`，部署在 `nix/`。
- M2 的 reviewer 是 `packages/reviewer` 中 vendored 的 rc.3 auto-review；修改 vendor 时同步更新 `PATCHES.md`/`VERSION.md`。
- M3 的默认 shell host 是 `sandbox:default`；sandbox 需要绝对 Nix buildEnv（`NOKORIBI_SANDBOX_BASE_ENV`）与 `setpriv`。无 Nix 的开发环境用 `NOKORIBI_DEFAULT_HOST=local:workspace`。实现细节与偏差见 [.spec/07](.spec/07-shell-hosts-and-sandbox.md) 7.12。
- M4 的 goal child 由宿主创建（`start_goal` / `/goal new`，D136），main 隐藏 goal 工具；M5 起 goal 默认模型由 `NOKORIBI_GOAL_MODEL` 提供，可通过 `NOKORIBI_GOAL_MODELS` allowlist 在 `start_goal`/`/goal new --model` 中选择（D138/D141）。实现细节见 [.spec/10](.spec/10-goals-and-schedule.md) 10.13。
- M5 的 memory 是**主动检索**（`memory` 工具），不会自动注入到会话；automatic injection 后移（D143）。默认 workspace 下的 sandbox 与 schedule 需要 daemon 常驻。实现细节见 [.spec/09](.spec/09-prompt-and-memory.md) 9.5 与 [.spec/10](.spec/10-goals-and-schedule.md) 10.13。
- M6 的 Nix 包保留官方 Node 24.21.0 运行时（D145），wrapper 经 Nix glibc loader 启动；不要把它换回 nixpkgs Node，否则 `node-addon-require-builtin` 会让 daemon 启动失败。wrapper 同时用 `--require` 预加载 `nix/exec-path-preload.cjs` 并把 `process.execPath` 指向 `bin/node-shim`（D148）；否则 DSH subprocess runner 会拿 loader 执行 runner.js，所有 `bash(host)` 调用报 `subprocess scope exited before its bootstrap consumed the launch request`。NixOS module 选项与手工清单见 [.spec/12](.spec/12-nixos-deployment.md)。
- **M7（channel-core IM 基础设施扩展）的代码已实现（2026-10-27）**：被动回复上下文（core+outbox）、多 driver 路由、`trustedChannels`、`NonRetryableDeliveryError`/被动过期降级、通知 defer 补投（D161）与动作按钮契约预留（D163）。实现口径见 [.spec/14](.spec/14-roadmap.md) 14.8 与 [D162/D163](.spec/03-decision-log.md)。
- **M8（真实 IM：QQ 官方 Bot）的代码已实现（2026-10-27）**：`packages/channel-qq-bot`（官方 `@tencent-connect/qqbot-nodejs@1.0.5` 的 `./protocol`，D154），单聊 + 群 @、被动优先 + `activeMessageFallback=auto`、错误分类/频控、`channel.qqBot.*` NixOS 选项、bundle/launcher 装配与 fake WS/REST 进程测试。实现口径见 [.spec/14](.spec/14-roadmap.md) 14.9、[.spec/17](.spec/17-qq-official-bot.md) 17.10.4 与 [D164](.spec/03-decision-log.md)。**真实平台验收尚未执行**：14 项平台事实门禁、17.8.2 真实 Bot 清单与目标机部署需要 AppID/ClientSecret/开发体验用户/自己的群；探针与记录见 [.spec/notes/qq-fact-gate.md](.spec/notes/qq-fact-gate.md)。关键事实：主动推送官方已宣告下线（D161：active 尝试 + 失败 defer）；准入只依赖平台边界（D152，残余风险已接受）。
- **M9（QQ C2C 按钮审批）代码已实现（2026-10-29）**，真实平台门禁 #15–#20 与目标机 12.14 待执行：仅审批、2 按钮「允许一次/拒绝」、不补发确认、文本 fallback 保留；core action 权威路由、QQ 先 `PUT /interactions/{id}` ack 再 ingress、intents `1<<26` 失败自动降级。规格见 [.spec/18](.spec/18-qq-button-approval.md)，决策 D165–D167。
- **M10（host-aware 持久终端 + Web）代码已实现（2026-10-29）**，G2/G3/G4/G6 目标机用户态通过，G5 与 systemd 12.14 待执行：新包 `packages/terminal-host` 复用上游 `BashTerminalBackend`，每个 terminal-capable host 一个 backend，注入 `spawnTerminal` 走 `ctx.shellHosts.terminalLaunch`（`terminal_open.type`=host id；用 `AsyncLocalStorage` 把 registry 的 owner/session 传给注入 seam）；`shell-bash` 增加 `terminal` 能力位、launch 协议、`onChange`；local 用 `terminalBashPath`，sandbox 用 terminal pin（TTL/reset/dispose 互锁、`terminalSessions`），`/clear`/goal 归档/daemon 退出先杀终端再 `disposeSession`（5s 有界、失败 warn）；`nokoribi:pty` 段 order 3100，上游 `tool:pty` 保留。Web 挂 `web`/`web-search-deepseek`/`web-fetch-http`/`web-deepseek-api`/`tool-web`，bundle/dev 默认 pin `deepseek-official`+`http`；`web_search`/`web_fetch` 按 D170 豁免 Auto review（reviewer `exemptTools`，bundle 默认 `web_search,web_fetch`，空列表恢复全审）。配置：Nix `terminal.*`/`web.*`/`review.exemptTools`，bundle env `NOKORIBI_TERMINAL_*`/`NOKORIBI_WEB_*`/`NOKORIBI_REVIEW_EXEMPT_TOOLS`。规格见 [.spec/19](.spec/19-persistent-terminal-and-web.md) 与 [.spec/07](.spec/07-shell-hosts-and-sandbox.md) 7.13，决策 D168–D171，门禁记录 [.spec/notes/m10-fact-gate.md](.spec/notes/m10-fact-gate.md)（G1/G7 自动化通过；G2/G3/G4/G6 目标机用户态通过；G5 与 systemd 12.14 待执行；`pnpm test:unit` 56/438、`pnpm test` 60/458、`pnpm test:process` 10/64 为 2026-10-29 观察值）。**M10 仍不能标“完整验收通过”。**
- `pnpm check` 会先构建 workspace 包（类型检查依赖各包 `dist/*.d.ts`），然后运行 tsc/oxlint/oxfmt；`nix flake check` 额外跑 package/unit/package-smoke/module-eval。当前开发机是 Arch，不能执行 NixOS 12.12 或 QQ 真实平台验收。
- 决策以 [.spec/03-decision-log.md](.spec/03-decision-log.md) 为准；被取代/撤销的决定登记在 [.spec/16-superseded-and-glossary.md](.spec/16-superseded-and-glossary.md)。
- 实现偏离规格时必须同步更新规格与决策记录，不能只改代码。

## 工具链

- Node.js 24，ESM（`package.json` 的 `"type": "module"`）。
- pnpm；`packageManager` 已固定，锁文件随依赖一起提交。
- oxfmt（格式化）、oxlint（lint）、`tsc --noEmit`（类型检查）。
- 工具配置在根目录 `oxfmt.config.ts`、`oxlint.config.ts`、`tsconfig.json`；不要把配置挪到 CLI flag。
- 只能通过 `pnpm run <script>` 或 `pnpm <script>` 执行工具，**禁止直接执行 `node_modules` 下的二进制**（如 `./node_modules/.bin/oxlint`）。
- tsdown 构建、Vitest 测试；`pnpm test:process` 会先构建再跑进程级场景；`pnpm test:unit` 是 flake unit 使用的 package-only 入口。
- Markdown 文档由人工维护，oxfmt 已忽略 `*.md` 与 `.spec/`。

## 命令

- `pnpm install` — 安装依赖
- `pnpm format` — 格式化
- `pnpm format:check` — 检查格式
- `pnpm lint` / `pnpm lint:fix` — lint / 自动修复
- `pnpm typecheck` — 先构建 workspace 包，再根与每包 `tsc --noEmit`
- `pnpm check` — 依次执行 typecheck（含构建）、lint、format:check
- `pnpm test:process` — 构建后运行进程级场景
- `pnpm test:unit` — 只运行 `packages/*/test`（flake unit 使用，不含 `tests/integration`）
- `nix build .#default` — 构建发行版（官方 Node wrapper）
- `nix run .#default -- --version` — package smoke
- `nix flake check` — package/unit/module-eval；不能替代 NixOS 12.12 手工清单
- 提交前运行 `pnpm check`；改 Nix 时同时跑 `nix flake check`。

## 结构

- `.spec/`：设计规格；[README.md](README.md) 为索引。
- 已创建的 `packages/*`、`vendor/profile-boot`、`templates/`、`nix/` 与 `flake.nix` 见 [.spec/04-architecture-and-build.md](.spec/04-architecture-and-build.md)；保持该文件中的边界与依赖方向。
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
