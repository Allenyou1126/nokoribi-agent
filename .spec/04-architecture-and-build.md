# 04 架构与构建

## 4.1 总体形态

```
        IM / 本地测试通道
                │
        ┌───────▼────────┐
        │  channel-core  │  driver 契约、ingress、去重、交互 broker、outbox、delivery
        └───────┬────────┘
                │ ctx.agents / ctx.commands / approval / userQuestions / events
        ┌───────▼────────┐
        │   agent-app    │  daemon、主会话、goal 跟踪/恢复、命令、系统通知、提示词装配
        └───┬────┬───────┘
            │    │
   ┌────────▼─┐ ┌▼──────────┐ ┌─────────────┐ ┌──────────────┐
   │ shell-*  │ │ memory    │ │ prompt      │ │ reviewer     │
   │ hosts    │ │ store/tool│ │ SOUL/sections│ │ auto-review  │
   └──────────┘ └───────────┘ └─────────────┘ └──────────────┘
            │
      ctx.subprocess / Nix shell / 文件系统 / jobs
```

设计目标：**不是 fork DSH 内核**，而是在 DSH 的组合系统上做一个精简发行版 + 少量自研插件。所有自研包只依赖稳定 seam（`ctx.agents`、`ctx.commands`、`ctx.userQuestions`、approval waterfall、`ctx.jobs`、`ctx.subagents`、`ctx.goals`、`ctx.systemPrompt`、`ctx.llm` 等）。

## 4.2 仓库结构

```
nokoribi-agent/
├─ packages/
│  ├─ launcher/               # 薄启动器 + vendored profile-boot
│  ├─ shared/                 # zod schema、路径、原子状态文件、日志、通用类型
│  ├─ shell-bash/             # host router、bash(host) 工具、get_available_shell_host
│  ├─ shell-host-local/       # local host provider
│  ├─ shell-host-sandbox/     # sandbox host + sandbox/sandbox_packages 工具
│  ├─ channel-core/           # ChannelDriver 契约、ingress、broker、outbox、delivery
│  ├─ channel-local-test/     # loopback HTTP + token 测试驱动
│  ├─ memory/                 # memory 工具与文件存储
│  ├─ prompt/                 # SOUL.md 加载、系统提示词段、AGENTS.md seed
│  ├─ agent-app/              # daemon、主会话、goal 生命周期、命令、系统通知
│  ├─ reviewer/               # vendor 的 experimental-auto-review + 补丁
│  └─ bundle/                 # cordis.patch.yml 与 profile manifest
├─ vendor/profile-boot/       # 上游启动逻辑副本 + LICENSE + 版本标识
├─ nix/                       # flake、package、NixOS module
├─ templates/                 # AGENTS.md 全局/工作区种子、SOUL.md 占位
├─ tests/                     # 跨包集成与进程级恢复测试
├─ SOUL.md                    # 用户提供的人设文本（源码仓库、Nix 打包）
├─ README.md
└─ .spec/                     # 本套设计文档
```

（`packages/` 的具体名字在实现时可以调整，但边界与依赖方向保持。）

## 4.3 包职责

| 包 | 职责 | 主要依赖 |
|---|---|---|
| `launcher` | 解析参数、读打包 profile、叠加 Nix patch overlay、设置 DSH_HOME、调用 app-boot 启动。vendor profile-boot。 | `@deepseek-ai/dsh-app-boot`、`dsh-cmdline`、`dsh-home-paths`、`dsh-launch-environment`、`dsh-http-proxy`、cordis |
| `shared` | 配置 schema（zod）、DSH_HOME/路径约定、原子读写、单实例锁、日志辅助、公共类型。 | cordis（仅类型/轻量）、node |
| `shell-bash` | `shellHosts` service 定义、`shell-router`（唯一 `ctx.shell` provider）、`bash(host)` 工具、`get_available_shell_host` 工具。 | shared、cordis、`dsh-tools`、`dsh-shell` 类型 |
| `shell-host-local` | local host provider：系统 PATH + extraPackages，cwd 为持久 workspace。 | shared、cordis、`ctx.subprocess` |
| `shell-host-sandbox` | sandbox host provider：profile Nix buildEnv + shellHook、临时目录、TTL、禁提权；`sandbox` 与 `sandbox_packages` 工具。 | shared、cordis、`ctx.subprocess`、`ctx.shellHosts` |
| `channel-core` | driver 注册、ingress 管线（allowlist/去重/命令）、交互 broker、outbox、出站投递、系统通知。 | shared、cordis、`ctx.agents`、`ctx.commands` |
| `channel-local-test` | 本地测试通道：HTTP server、token、长轮询。 | channel-core contract |
| `memory` | memory 工具（search/read/write/forget）、Markdown 文件存储、检索。 | shared、cordis |
| `prompt` | SOUL.md 加载、系统提示词 section 注册、AGENTS.md seed 模板。 | shared、cordis、`ctx.systemPrompt` |
| `agent-app` | daemon 启动、主 agent create/resume、单实例锁、状态文件、goal 跟踪/恢复、`/goal`/`/clear` 等命令、系统通知、提示词/记忆/定时装配。 | shared、prompt、channel-core（契约）、`ctx.*` |
| `reviewer` | vendor 的 auto-review：双 tier、两阶段复审、child 审批桥接。 | 上游 auto-review 依赖 + shared |
| `bundle` | 完整插件树 patch；不包含运行时代码。 | 以上所有 + 选定 `@deepseek-ai/*` |

依赖方向：`shared` 最低；host/channel/memory/prompt 互不直接依赖（通过 Cordis 服务/事件协作）；`agent-app` 编排；`bundle` 只负责装配；`launcher` 独立于运行时插件。

## 4.4 Bundle 组合

采用"完整独立插件树"（类似 `sdk-minimal`，不基于 `dsh-base`），每条行有稳定 id，便于 Nix overlay 覆盖。

### 计划保留的 DSH 行（草案）

核心：

- cordis 基础：timer、include、loader（不启用 HMR；生产不需要模块热替换）。
- `dsh-llm` + `dsh-llm-deepseek-api-key`（实际 API Key 适配器名）+ `dsh-llm-retry`。
- `dsh-session` + `dsh-session-persistence-jsonl` + `dsh-session-projection` + `dsh-session-title` + `dsh-session-checkpoint-policy`。
  0.2.1-rc.3 没有 `dsh-session-projection-cache`；投影缓存由 checkpoint policy 承担。
- `dsh-agent` + `dsh-agent-loop`。
- `dsh-tools`、`dsh-system-prompt`、`dsh-agent-instructions`；`dsh-time-context` 留到 M5。
- `dsh-fs-local`、`dsh-fs-observation-policy`、`dsh-tool-fs`、`dsh-tool-fs-search`。
- `dsh-jobs-local`、`dsh-tool-jobs`。
- `dsh-shell-env`（DSH_* 环境事实；我们的 bash 工具使用它，但 `ctx.shell` 由 router 提供）。
- `dsh-user-approval`、`dsh-user-questions`；`dsh-tool-ask-user` 在 M1 不挂载（没有应答 UI）。
- `dsh-commands`、`dsh-command-compact`。
- `dsh-compaction-basic`、`dsh-compaction-tool-result-pruner`、`dsh-token-meter`。
- `dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver`（不挂 `dsh-command-goal`，`/goal` 由我们实现）。
- `dsh-schedule`。
- `dsh-subagent`、`dsh-subagent-spawn-in-process`、`dsh-tool-subagent`、`dsh-tool-subagent-control`、`dsh-tool-subagent-report`。
- `dsh-permission-presets`、`dsh-working-directory`、patched `experimental-auto-review`。
- `dsh-tool-todo`、`dsh-tool-present`（present 用于交付物；是否启用可在配置层覆盖）。
- `dsh-attachment`（能力/类型包）+ `dsh-attachment-local`（存储 provider）；M1 不启用入站图片。
- `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`（技能能力保留，v1 不重点使用）。
- `dsh-spill-local` + `dsh-spill-policy`、`dsh-session-checkpoint-policy`、`dsh-tool-call-timeout-policy`（实际名）、`dsh-repeat-tool-reminder` 等辅助行。
- `dsh-scope`、`dsh-atomic-write` 是库而不是可加载行；作为编译期/运行期依赖保留。
- 可选：`dsh-tool-web` + `dsh-web-search-deepseek` + `dsh-web-fetch-http`（联网能力；是否 v1 启用需在配置层决定）。
- 可选：`dsh-mcp-client`（v1 不纳入，后续可加）。

### 自研行

- `nokoribi-shell-router`
- `nokoribi-shell-host-local`
- `nokoribi-shell-host-sandbox`
- `nokoribi-tool-bash-hosted`
- `nokoribi-tool-shell-hosts`
- `nokoribi-sandbox-tools`（可与 host-sandbox 同包）
- `nokoribi-channel-core`
- `nokoribi-channel-local-test`
- `nokoribi-memory`
- `nokoribi-prompt`
- `nokoribi-agent-app`
- `nokoribi-reviewer`（替换上游 auto-review 行）

### 明确不安装 / 不加载

- 所有 `dsh-web-*` / `dsh-client-*` / `dsh-client-ui-*` / host webserver / API gateway / apiproxy / typert gateway 的 Web 用途行（本项目没有 Web UI）。
- `dsh-pwsh-*`、`dsh-win32-process`、Windows ACL 相关。
- `dsh-acp*`、`dsh-sdk-*`、`dsh-headless`（v1 不作为表面；可作为开发测试参考，不打包）。
- `dsh-hooks-claude-code`、`dsh-hooks-codex`。
- `dsh-experimental-*`（除被 vendor 的 auto-review）。
- telemetry/OTel、session-stats、turn-outline、message-feedback、plugin-inventory、plugin-market、directory-picker、open-in-app、file-upload、client HMR 等。
- `dsh-tool-ralph`、`dsh-tool-workflow`、`dsh-tool-cordis`、`dsh-tool-worktree`、plan-mode（v1 不需要）。
- `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-shell` 的 provider 行：`ctx.shell` 由我们的 router 提供；DSH 的 shell 类型包作为编译期依赖保留。

> 具体行清单在 M1 以锁定版本逐项验证；不在本清单不等于永久排除，但增加任何行都要回写本文档。

**M1 实际清单**：`packages/bundle/cordis.patch.yml`。M1 分两波装配：

- Wave A（消息闭环必需）：timer、llm/llm-deepseek-api-key/llm-retry、session/persistence-jsonl/projection、agent/agent-loop/tools/system-prompt/agent-instructions/working-directory/commands、fs-local/fs-observation-policy、subprocess-local、shell-env、自研 6 行。
- Wave B（M1 完整）：session-title、session-checkpoint-policy、token-meter、compaction-basic/tool-result-pruner、tool-fs/tool-fs-search、tool-todo、jobs-local/tool-jobs、user-approval/user-questions、tool-call-timeout-policy、spill-local/spill-policy、repeat-tool-reminder、attachment-local。
- 每行有稳定 id；Nix overlay 按 id 覆盖。行数/名称以实际 boot 与测试为准。

## 4.5 薄启动器

动机：官方 `@deepseek-ai/dsh` 启动器直接依赖 86 个包（含 Web/实验 bundle），会破坏安装物精简。

设计：

- `vendor/profile-boot/`：vendored 的 `profile-boot` 逻辑（约 14KB，MIT），保留上游 LICENSE、版本号与来源说明；实现为 workspace 包 `@nokoribi/profile-boot`，便于模块解析。M1 补丁见 `vendor/profile-boot/PATCHES.md`：关闭上限改为 `NOKORIBI_SHUTDOWN_TIMEOUT_MS`（默认 30s）、诊断名、install anchor 环境覆盖。
- 启动器只依赖：
  - `@deepseek-ai/dsh-app-boot`
  - `@deepseek-ai/dsh-cmdline`
  - `@deepseek-ai/dsh-home-paths`
  - `@deepseek-ai/dsh-http-proxy`
  - `@deepseek-ai/dsh-launch-environment`
  - `@deepseek-ai/cordis` 及其 loader/include/timer 等启动所需基础包
  - Node 内置模块
- 参数：M1 实现 `--profile <name>`（只接受 `nokoribi-agent`）、`--patch <file>`（可重复）、`--version`、`--help`；`--dump-config` 留到 M2。
- profile 由打包产物提供，但运行 profile 目录是 `$DSH_HOME/run/profile/`：启动器每次启动原子重写 `package.json` 与空 `cordis.patch.yml`，再用 `loadProfileDirectory()` + `runProfile({ resolvedProfile })` 启动。这样 `profile-boot` 写 `cordis.yml` 时不会碰只读打包目录。
- overlay 顺序：bundle → runtime profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `NOKORIBI_PATCH` → `--patch`。
- 启动器写 `run/ready.json` / `run/startup-error.json` 与自身 pid；启动完成后等待 ready 文件，失败则退出非 0。单实例锁、目录与状态文件仍由 `agent-app` 负责。
- 启动器设置 `NOKORIBI_SOUL_FILE` / `NOKORIBI_TEMPLATES_DIR` 的开发默认值（仓库布局），Nix 部署时由 overlay 显式设置。

## 4.6 构建与装配流水线

### 开发构建

- pnpm workspace；Node.js 24；pnpm 版本固定在 `packageManager` 字段。
- 每个包用 tsdown 构建为 ESM；类型用 `tsc --noEmit` 检查；oxlint/oxfmt。
- 测试用 Vitest。
- 实际脚本：
  - `pnpm build`：tsdown 构建所有 `packages/*`。
  - `pnpm typecheck`：先 `pnpm build`（类型检查依赖各包 `dist/*.d.ts`），再根 `tsc --noEmit` 与每包 `tsc --noEmit`。
  - `pnpm test`：Vitest 单元 + 进程内集成；`pnpm test:process`：构建后跑进程级场景。
  - `pnpm build:bundle` / Nix profile 生成留到 M6。
- M1 的 bundle patch 全部使用包标识符（`@nokoribi/*`、`@deepseek-ai/*`），由 launcher 的安装锚点与 runtime resolution 解析；M6 再决定是否需要相对构建产物路径。
- 类型检查兼容性：TypeScript 7 的 native 实现没有 tsdown dts 需要的 classic API，根 tsconfig 开启 `isolatedDeclarations` 以使用 Oxc 生成声明；导出的函数/常量/类成员必须写显式类型。
- 每条行有稳定 id（如 `nokoribi-shell-router`），Nix overlay 依赖这些 id。

### Nix 打包

- flake 输出 `packages.<system>.default`（整个发行版）与 `nixosModules.default`。
- 构建步骤：pnpm 依赖固定输出（`pnpmDeps`/`fetchPnpmDeps` 或等价方案）→ `pnpm build` → 生成 bundle/profile → 安装到 store。
- store 布局（草案）：

```
$out/
├─ bin/nokoribi-agent            # 启动器 wrapper
└─ lib/nokoribi-agent/
   ├─ node_modules/              # 生产依赖（pnpm 安装）
   ├─ packages/                  # 自研包构建产物
   ├─ profile/                   # profile manifest + bundle patch
   ├─ share/SOUL.md
   └─ share/templates/AGENTS.md
```

- 运行时不写 store；状态全部写入 `DSH_HOME`。

### 配置流

- **纯 Nix 只读配置**：NixOS module 根据选项生成 `overlay.cordis.patch.yml`（store 路径），启动器通过参数或环境变量读取并叠加在 bundle patch 之后。
- `DEEPSEEK_API_KEY` 等秘密通过 systemd `EnvironmentFile`（agenix）注入，不写进 Nix store。
- 测试通道 token 按决策 D119 直接作为 Nix option 明文写入 overlay（store 对本地用户可读，仅验收期启用）。
- 没有运行时 override 文件；改任何参数都要 `nixos-rebuild`。

## 4.7 版本与依赖策略

- 全部 `@deepseek-ai/*` 固定同一版本 `0.2.1-rc.3`；使用 `pnpm.overrides`/精确依赖 + 提交 `pnpm-lock.yaml` 保证一致。
- 升级流程（手动、整批）：
  1. 更新所有 `@deepseek-ai/*` 到同一新版本；
  2. 更新 vendored reviewer 的上游源码与版本标识；
  3. 跑 Vitest / flake checks；
  4. 对照 DSH README 检查本套文档标注的行为是否变化；
  5. 记录升级提交（conventional commit）。
- 不跟随 semver 范围、不自动升级。
- vendored 代码保留上游 LICENSE 与来源/版本注释；补丁尽量小并单独记录。

## 4.8 代码规范

- ESM-only、TypeScript strict、Node 24。
- tsdown 构建；oxlint + oxfmt；`tsc --noEmit`。
- Vitest；测试文件与源码同包或放 `tests/`。
- Conventional commits；提交信息末尾注明使用的 Agent/模型（沿用用户其他项目的约定）。
- 不引入 CJS 依赖（如确需，单独评审）。
