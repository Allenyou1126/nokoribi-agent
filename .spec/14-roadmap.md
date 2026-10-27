# 14 路线图

## 14.1 总原则

- 分 6 个阶段（D125），每阶段结束都能运行/演示。
- M6 才部署到 NixOS（D126）；M1–M5 在本地用测试通道验收。
- 自动化为主（D127）：Vitest 单元/集成 + 进程级恢复场景；本地 `nix flake check`。
- 任何实现期偏离决策都要回写本套文档。

## 14.2 M1 骨架与消息闭环

### 交付物

- pnpm monorepo 骨架、tsdown/oxlint/oxfmt/tsc/Vitest 配置。
- 薄启动器 + vendored profile-boot；可启动一个最小 bundle。
- 最小 bundle 行：llm、session(+jsonl/projection/cache/title)、agent、agent-loop、tools、system-prompt、agent-instructions、commands、fs/tool-fs、jobs、shell-env、user-approval、user-questions、todo、compaction、timeout/spill/checkpoint、invariants、attachment 等（以实际最小闭包为准）。
- 自研包骨架：shared、channel-core、channel-local-test、agent-app、prompt（基础 section + SOUL 加载 + AGENTS seed）、shell-bash + shell-host-local（可先只做 local host）。
- 单实例锁、`agent-state.json`、主会话 create/resume、inbox/outbox 基础。
- 命令框架：`/stop` `/status` `/clear` `/new`；`/steer` `/queue` 可先桩实现。
- 本地测试通道：`POST /v1/inbound`、`GET /v1/outbound`、`GET /v1/status`。
- 进程级恢复测试骨架（临时 DSH_HOME + daemon 子进程）。

### 验收

- 测试通道发消息 → 主 agent 回复；忙碌/空闲注入语义可验证。
- `/stop`、`/status`、`/clear` 行为符合规格。
- 重启后主会话恢复、outbox 重发、去重记录保留。
- 自动化：ingress/outbox/命令/状态机单元 + 进程内集成 + 重启恢复场景。

### 依赖/风险

- 无外部依赖（除 DSH 包）。
- 风险：DSH 启动/组合 API 细节；profile-boot vendoring；最小 bundle 依赖闭包。

### M1 实现记录（2026-10-25）

- 已完成 pnpm workspace、tsdown/Vitest、vendored `profile-boot`、薄启动器、application-owned runtime profile、bundle 两波行装配。
- 已完成 `shared` / `channel-core` / `channel-local-test` / `agent-app` / `prompt` / `shell-bash` / `shell-host-local`；`bundle` 与 `launcher` 已可启动完整 M1。
- 本地测试通道三端点、长轮询、token、`run/test-channel.json`、`run/ready.json` / `run/startup-error.json` 已实现。
- 已验证：消息→回复、去重、`/status`、`/clear`（旧 session 文件保留）、`/stop`、`/steer`/`/queue` 一次性模式、SIGTERM 干净退出、kill -9 后主会话恢复 + outbox 重发 + 崩溃通知、单实例锁、state 损坏备份与通知。
- 自动化：`pnpm test`（单元/进程内）与 `pnpm test:process`（8 个进程场景）通过；`pnpm check` 通过。
- M1 偏差：默认 host 当时暂为 `local:workspace`（M3 已切到 `sandbox:default`）；`/steer`/`/queue` 直接完整实现；入站图片仍返回 501（**未分配，M2 不做**）；`--dump-config`、`/compact` 后移；`dsh-scope`/`dsh-atomic-write` 是库不是行。
- 后续：sandbox host、模型侧 `bash(host)` 已在 M3 实现；goal 已在 M4 实现；memory/schedule 已在 M5 实现；图片附件链路仍未分配（后续版本单独评估）。

## 14.3 M2 安全闸与审批

### 交付物

- vendor `experimental-auto-review` 并打补丁：双档 reviewer、两阶段、sudo 启发式、child 审批桥接（D131）。
- 挂载 `permission-presets`、`working-directory`；主会话程序化设 Auto；实现 `/permission` 报告。
- interaction broker 完整实现：串行、超时、提示格式、回复解析、`/steer` 旁路、`/stop` 中止。
- 系统提示词 safety 段与 approval/question 说明。
- shell router 报告 `sandboxMode`（满足 permission-presets 挂载条件）。

### 验收

- 工具调用被 reviewer 审查；deny/不确定 → strong 复审 → 仍 deny 时 IM 单次授权。
- 允许后执行、拒绝后失败；reviewer 技术失败 fail closed。
- approval 60s/question 300s 超时行为。
- 多个待应答串行；`/steer` 不打断待应答。
- child 审批（fake goal child）也能到 IM；M2 已验证。
- 自动化：reviewer 路由/JSON 校验/两阶段、broker 状态机、集成场景。

### 依赖/风险

- 依赖 M1 的 channel/agent 骨架。
- 最大不确定性已消除（M2 验证）：auto-review 在 IM-only profile 可用、child approval seam 可行；回退方案仍保留（child 汇报 → 主 agent 询问）。
- 需要 fake reviewer 模型用于测试，避免真实 API。

### M2 实现记录（2026-10-25）

- 已 vendor rc.3 `experimental-auto-review` 到 `packages/reviewer`，实现 fast/strong 两阶段、sudo/root 启发式、reviewer 超时、fail closed 与 child deny→`ask` 桥接；补丁见 `PATCHES.md`。
- 已挂载 `permission-presets`（仅 `danger-full-access` 预设）、`tool-ask-user` 与 `@nokoribi/reviewer`；主会话创建/恢复后程序化设为 `auto`；agent 作用域 `/permission` 只报告、拒绝切换。
- 已实现 `channel-core` 的 `InteractionBroker`：approval + question 串行、60s/300s 超时、提示格式、编号/允许/拒绝/自定义解析、`/steer` 旁路、`/stop`/`/clear`/shutdown 中止、残留 interaction 清理与 outbox terminal 跳过。
- 已增加 `nokoribi:safety` 提示词、更新 interaction 文案，并通过 `system-prompt/assemble` 修正 child delegation 的旧审批说明。
- 验证：`pnpm test`（18 文件/144 测试）、`pnpm test:process`（19 场景：M1 8 + M2 11）、`pnpm check` 全部通过。V1/V2 已验证。
- M2 偏差/边界：图片仍 501（未分配，不在 M2）；`--dump-config` 后移；child question 不桥接（DSH 禁止 child 调 `ask_user_question`，只有 approval 桥接）；child delegation 文案覆盖已有单测，真实 subagent mount 在 M4 再接；reviewer 的 Nix 选项在 M6 接线。
- M3 已完成 sandbox host 与 `bash(host)`；M4 已完成 goal 子代理与真实 subagent 工具链。

## 14.4 M3 shell hosts

### 交付物

- `shellHosts` registry + `shell-router`（唯一 `ctx.shell`）+ `bash(host)` 工具 + `get_available_shell_host`。
- `local:workspace` provider（系统 PATH + extraPackages；sudo 仅部署时可用）。
- `sandbox:default` provider：
  - profile buildEnv + shellHook；
  - 每 session 临时目录；落盘；TTL 30 分钟可配；
  - `no_new_privs` + PATH 去 sudo；
  - `sandbox`（reset/status）+ `sandbox_packages`（add/remove/list）；
  - `DSH_SANDBOX_DIR` / `DSH_WORKSPACE_DIR`；
  - 后台任务支持与 reset 保护。
- 提示词 hosts 段、工具描述、错误提示。
- 默认 host=sandbox；local 可用。

### 验收

- 模型可发现 host 并选择；未知 host 报错。
- sandbox 命令与 workspace 隔离（不挂载）；cp/rsync 往返可用。
- TTL 回收、reset、status、packages 临时加包。
- sandbox 内 sudo 失败；local 可用系统工具。
- 自动化：host 路由/能力校验/发现工具、fake host 集成；sandbox 生命周期（可能需要真实 nix，标记集成测试）。
- 手工：nix shell 启动性能记录（作为风险数据）。

### 依赖/风险

- 依赖 M1（工具注册/提示词）。
- 风险：nix shell 启动延迟；buildEnv + 运行时包叠加；TTL 与后台任务边界；`ctx.shell` façade 的 sandboxMode 兼容。

### M3 实现记录（2026-10-25）

- 已扩展 `shellHosts` 协议（`run`/`start`/`reset`/`status`/`disposeSession` + `spawnBash`），`shell-router` 是唯一 `ctx.shell` provider；`ctx.shell` 仅服务 sessionless local，default 为 sandbox 时 fail closed（D134）。
- 已实现 `@nokoribi/shell-bash/tool`：`bash(host)`、`get_available_shell_host`、`nokoribi:hosts` 提示词、后台 job 适配；只有显式 `run_in_background` 注册 job（D135）；前台超时不自动转后台。
- 已实现 `local:workspace`（前台/后台、`extraPackages` PATH）与 `sandbox:default`（每 session 目录、sidecar、generation、TTL、reset/status、`sandbox_packages`、`disposeSession`）。
- sandbox 执行使用受限 PATH + `setpriv --no-new-privs` + sudo/su/pkexec/doas shim；有临时包时叠加 `nix shell`；base-only 直接受限 PATH；用户命令仅作为 `$1` 传入；`DSH_SANDBOX_DIR`/`DSH_WORKSPACE_DIR` 注入。
- 默认 host 改为 `sandbox:default`；`agent-app` 启动校验 default host；`/clear` 删除旧 session sandbox；默认 baseEnvironment 为空时命令返回明确错误，M6 负责构建。
- 验证：`pnpm test` 24 文件/193 测试、`pnpm test:process` 24 场景（M1 8 + M2 11 + M3 5）、`pnpm check` 全部通过。
- 手工真实 Nix 验证（M3，2026-10-25）：用 `buildEnv { bash coreutils }` 作为 baseEnvironment，`ShellRouter` + `SandboxHost` 直连 `SubprocessLocal`：cwd 在 sandbox、`DSH_SANDBOX_DIR` 正确、workspace→sandbox `cp` 成功、sudo shim 返回禁用、`sandbox_packages add nixpkgs#hello` 后 `hello` 可执行、reset 清空包且 generation+1。
- M3 偏差/边界：`ctx.shell` sessionless façade；无前台超时转后台；sandbox 非强制隔离（D48）；`setpriv`/`nix` 由部署提供。

## 14.5 M4 goal 子代理（2026-10-25 已实现）

### 交付物

- 挂载 goal 服务/tool/round-driver、subagent spawn/tool/control；rc.3 无独立 report 包，用 `send_message` + `subagent/end` 结算。
- goal 跟踪：`goal/changed` + `listChildren`、多 goal、sessionId 前缀 id、state 持久化。
- 两条创建路径：主 agent 工具；`/goal new` 桥接直接 spawn。
- `/goal list/status/pause/resume/clear/archive`。
- 主会话禁 goal（隐藏工具 + 误建清理）。
- 重启恢复：冷恢复消息 + re-arm；失败通知/重试。
- 归档：释放 Activation、archive JSONL、删除 sandbox、保留 session；完成询问流程。
- goal child persona、汇报格式提示词。
- 系统通知（blocked/error/恢复失败）。

### 验收

- 自然语言与 `/goal new` 均可创建 goal；多个并行。
- 子代理里程碑/完成/阻塞报告到主 agent，主 agent 转述。
- daemon 重启后 goal 自动恢复并继续；失败时通知且状态保留。
- `/goal archive` 后不再出现在 list；archive JSONL 正确；sandbox 删除。
- `/goal clear` 停止并归档。
- 主会话建 goal 被阻止。
- 自动化：tracking 状态机、命令、归档；进程级重启恢复场景。

### 依赖/风险

- 依赖 M1/M2/M3（主会话、审批、sandbox）。
- 风险：cold resume 时序（sendMessage→live→re-arm）；goal 工具对 main/child 的可见性控制；多 goal 汇报噪声；完成通知重复。

### M4 实现记录（2026-10-25）

- 已挂载 `goal`/`tool-goal`/`goal-round-driver`/`subagent`/`subagent-spawn-in-process`/`tool-subagent`/`tool-subagent-control` 与 `session-query-sqlite`（`openAt:"never"`）；不挂 `dsh-command-goal`。
- rc.3 的 `create_goal` 只允许根 agent 直接人类输入，因此采用 D136：`start_goal` 工具 + `/goal new` 均由宿主启动 `goal-*` child 并 `ctx.goals.create()`；main 的 goal 工具隐藏；D137 用 `send_message` + `subagent/end` 汇报。
- GoalManager 支持跟踪、短 id、`/goal list/status/pause/resume/clear/archive`、归档 JSONL、sandbox 删除、`/clear` 清理、SIGKILL 冷恢复；恢复失败保留 tracked 并通知。
- 验证：`pnpm test` 208 tests、`pnpm test:process` 33 scenarios、`pnpm check` 通过。
- M4 偏差/边界：goal 模型当时固定（D138，M5 已补 allowlist）；goal child persona 由 prompt 承担；`/goal pause` 对 cold child 报错，先 resume。

## 14.6 M5 memory + schedule + 提示词收尾（2026-10-25 已实现）

### 交付物

- memory 工具 + 文件存储 + 检索 + archive。
- 记忆提炼子代理（secondary、里程碑触发）。
- `dsh-schedule` + `dsh-time-context`；schedule 工具可用；逾期交付验证。
- 全局/工作区 AGENTS.md 种子模板；SOUL.md 加载与 persona 落地。
- 六段系统提示词定稿（除 M2 的 safety 外全部）；提示词与工具行为对齐。
- `/status` full 完整实现。

### 验收

- "记住…" 后可跨会话 search 到；提炼子代理写入去重；不存秘密。
- 创建提醒，到期后主 agent 主动回复；重复/逾期行为符合 DSH。
- SOUL.md 身份生效；AGENTS.md seed 不覆盖；提示词与实现一致。
- 自动化：memory 单元/集成、prompt 快照、schedule 到期/逾期进程场景、提炼子代理脚本化。

### 依赖/风险

- 依赖 M1–M4。
- 风险：提取子代理成本/噪声；全局 memory 跨项目可见；schedule 工具安装时序；SOUL 长度与模板转义。

### M5 实现记录（2026-10-25）

- `packages/memory` 实现全局文件 memory：`memory` 工具（search/read/write/forget）、frontmatter、secret guard、软归档、原子写；`/status full` 统计 active/archived/invalid/bytes。
- memory 提炼：goal `complete`/`blocked` 触发一次性 `memory-*` child；`delivery:"caller"`；输入 objective + 最后 report；失败静默。M5 **不做 memory 自动注入**（D143）。
- schedule：挂载 `dsh-storage`/`storage-json`/`storage-domain`/`dsh-schedule`/`dsh-tool-schedule`/`dsh-time-context`；新增最小 `sessionController` 桥；到期/逾期交付与 `/clear` 清理已验证。rc.3 `every_seconds` 最小 60 秒、`title` 必填、四工具（含 `schedule_update`）。
- goal 模型：`NOKORIBI_GOAL_MODELS` allowlist；`start_goal`/`/goal new` 可选 model/effort；state/status/archive 记录路由；generic `subagent` 的 DSH model selection 因 rc.3 scoped 限制后移。
- 提示词：`nokoribi:memory`（5000）、`nokoribi:schedule`（7000）；SOUL/AGENTS seed 与六段顺序对齐；AGENTS 模板更新。
- `/status full` + `GET /v1/status?full=1`：goals/sandbox、active schedule、memory、recent warn/error、reviewer、版本；recent buffer 只在进程内。
- 验证：`pnpm test` 285 tests、`pnpm test:process` 40 scenarios（M5 新增 7）、`pnpm check` 0 warnings/errors。
- 偏差/边界：D139（schedule Host-wide bridge）、D141（generic subagent model selection 后移）、D143（memory 自动注入后移）；`/clear` 期间到期交付有极小在途窗口。

## 14.7 M6 NixOS 部署

### 交付物

- flake package + NixOS module；纯 Nix overlay 配置。
- 专用用户/组、StateDirectory、systemd unit、sd_notify watchdog、journald。
- agenix EnvironmentFile（`DEEPSEEK_API_KEY`）。
- `sudo.enable` → `NOPASSWD: ALL` 规则（默认 false）。
- 测试通道 token（Nix option 明文）。
- SOUL/AGENTS 打包与 seed；sandbox buildEnv 构建。
- 部署文档更新、手工验收清单执行。
- `nix flake check` 本地门禁。

### 验收

- 12.12 手工清单全部通过。
- 重启系统自启、会话/goal/outbox 恢复。
- watchdog 能拉起卡死进程。
- 升级流程演练一次（同版本重构建/重启恢复；真实 DSH bump + reviewer vendor 更新留待后续版本）。

### 依赖/风险

- 依赖 M1–M5 功能完整。
- 风险：pnpm 固定输出构建；systemd 无硬化下的权限；agenix owner/mode；watchdog 实现（sd_notify）；Nix store 可写性禁止；NixOS 手工验收成本。

### M6 实现记录（2026-10-25）

- 已添加 `flake.nix`/`flake.lock` 与 `nix/`（source/deps/package/module/overlay/tests，以及 `check-module.py`）。
- 发行版使用 `fetchPnpmDeps`（fetcherVersion 4、pnpm_12）与 nixpkgs Node 构建；安装阶段只保留生产依赖。运行时使用官方 Node 24.21.0（x86_64/aarch64），wrapper 经 Nix glibc loader 启动，解决 DSH `node-addon-require-builtin` 对 nixpkgs Node 不兼容的问题（D145）。
- NixOS module 生成完整 Cordis overlay；提供专用用户/组、StateDirectory/自定义 tmpfiles、`Type=notify`、`NotifyAccess=all`、`WatchdogSec=120`、`TimeoutStartSec=300`、`TimeoutStopSec=45`、`KillMode=mixed`、agenix `EnvironmentFile`、可选 sudo、sandbox buildEnv、测试通道 token。
- 运行时新增 `SystemdNotifier`（READY/WATCHDOG/STOPPING）、`NOKORIBI_LOG_LEVEL`、`homeDir`、`NOKORIBI_READY_TIMEOUT_MS`、host/channel `enabled` 开关、`goalDefaultMaxRounds`。
- 验证：`pnpm check` 0 warnings/errors；`pnpm test` 42 文件/299 测试；`pnpm test:process` 6 文件/42 场景（M1 8 + M2 11 + M3 5 + M4 9 + M5 7 + M6 2）；`nix build .#default`、`nix run .#default -- --version`、`nix flake check` 通过；package runtime smoke 在本机通过。
- 手工验收：当前开发机是 Arch Linux，未执行 NixOS `nixos-rebuild` 与 12.12 清单；该部分必须在目标 NixOS 主机执行并记录。M6 因此只能标记“代码实现完成、手工验收待执行”。
- 偏差/边界：D144（systemd-notify helper）、D145（official Node）、D146（module 选项口径）、D147（验收边界）；DSH 仍固定 0.2.1-rc.3，本轮不执行真实版本 bump。

### M6 目标机临时部署记录（2026-10-27）

- 在 hkg-dog-darell（NixOS 26.05、x86_64）以用户态临时部署：GitHub 私有仓库 + `git clone`/`git pull`（未用 scp/rsync 传项目文件），`nix build .#default` 成功，构建产物与开发机同一 store 路径；未安装 systemd unit、未改系统配置。
- 3 轮测试对话暴露目标机阻塞缺陷：`bash(host)` 对 `local:workspace` 与 `sandbox:default` 均 100% 失败，报 `subprocess scope exited before its bootstrap consumed the launch request`；模型调用的 `read`/状态通道正常。用户 journal 显示 systemd-run scope 实际执行的是 `ld-linux runner.js`，loader 报 invalid ELF header——即 D145 wrapper 使 `process.execPath` 指向 loader，与 DSH subprocess runner 不兼容。
- 已按 D148 修复：新增 `bin/node-shim` 与 `--require` execPath preload；在目标机用真实内核/用户 systemd 复现问题并验证修复（subprocess native scope 启动成功、daemon 启动与 native addon 检查正常）。临时 fallback 方案（去掉 `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` 强制无 scope）未采用。
- 本次仅覆盖：拉取/构建、daemon 启动、测试通道 `/v1/status`、真实模型对话、bash 缺陷复现与修复验证。12.12 清单其余项（审批、sandbox 生命周期、goal、memory、schedule、watchdog、重启恢复、升级演练）仍未在目标机执行。
- 附带观察：shutdown 时偶发 `shutdown flush failed ... flush on a closed handle`；本次数据未丢（`cleanShutdown=true`、session JSONL 完整），作为后续清理项记录。

## 14.8 后置（v1 之外）

- **M7 SSH host**：`shell-host-ssh` provider、host 配置映射、ssh_config/agent/ProxyJump、后台任务限制、主机白名单/审批；不改 router/工具。
- **真实 IM 适配器**：QQ/Milky、Telegram 等实现 ChannelDriver；sender/chat 白名单；图片下载；平台限速/长消息。
- **heartbeat/主动唤醒**：当前明确不做。
- **多人/群聊权限**：需要身份、权限、审计、隔离重新设计。
- **token 预算插件**：可选未来能力。
- **备份/自动回滚**：当前明确不做。
- **web-debug**：当前明确不做；如需诊断，只能看 journald/session 文件/`/status`。
- **NixOS VM 测试/CI**：当前不做；可本地 flake checks。
- **更强的 sandbox 隔离**（bwrap/容器）：在 host 接口下可加。
- **远程文件工具**（read/write/edit 走远程）：未设计。
- **session search/长期记忆增强**：未纳入。

## 14.9 实现前必须验证（进入 M1 前/早期）

详见 [15 待验证项与风险](15-verification-and-risks.md)。摘要：

1. IM-only profile 下 Auto 预设程序化设置与 permission-presets 挂载。
2. patched auto-review 的两档路由与 child 审批桥接可行性。
3. goal 冷恢复顺序与 re-arm 时序。
4. resume 后 inbox 是否自动处理。
5. schedule 工具安装时序 vs 主会话创建。
6. nix buildEnv + 运行时包叠加性能。
7. pnpm 依赖的 Nix 固定输出构建。
8. 主模型图像支持（查 API 目录）。
9. 主 agent 隐藏 goal 工具的实现方式。
10. `/clear` 时 outbox 旧消息处理（文档中标注待实现决策）。

## 14.10 v1 完成定义

- M1–M6 验收全部通过；`nix flake check` 通过。
- 文档（本套）与实现一致；所有偏离回写。
- 安全检查清单（08）中的已接受风险被再次确认。
- 手工验收清单（12.12）执行并记录结果。
