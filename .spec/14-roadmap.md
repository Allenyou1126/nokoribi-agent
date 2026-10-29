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
- 附带观察（2026-10-27 已修复）：shutdown 日志偶发 `shutdown flush failed ... flush on a closed handle`。根因是 Cordis 并发 teardown 中 persistence 先关闭写句柄；该后端 `close()` 会先 drain 已路由事件，数据未丢（`cleanShutdown=true`、session JSONL 完整）。daemon 现在把该错误识别为已持久化并降为 debug；m1 进程测试断言干净退出不再出现该错误。

## 14.8 M7 channel-core IM 基础设施扩展（已实现）

> 状态：**代码已实现（2026-10-27）**；按 D149，本项是 M8 的前置。实现口径见 D162/D163，规格要点见 [17](17-qq-official-bot.md) 17.6.2 与 `.spec/notes/channel-qq-mapping.md` §3/§6.2。

### 交付物

- `contract.ts`：`ReplyContext`、`OutboundContent` 扩展（kind/deliveryId/attempt/reply/actions）、`NonRetryableDeliveryError`、`PassiveReplyExpiredError`、capabilities `activeMessages`/`maxRepliesPerReply`/`outboundActions`/`inboundActions`、`canDeliver?()`/`health?()`/`defaultChatId?`。
- `service.ts`：`trustedChannels`/`defaultChannelId`、`lastInboundByChat`/`turnChat`/`pendingTurnChats`、per-turn 多 driver 路由、notice 的 active-capable 回退与 defer 补投、缺 driver 短路失败、channel health、`restoreActiveChat`。
- `outbox.ts` + `shared/src/schemas.ts`：持久化 `replyTo`/`replyReceivedAt`/`replySeq`、`actions` 与 `deferredNotices`（旧文件兼容）。
- `format.ts` 分段前缀预留、`maxChunks` 截断；`channel-local-test` 适配 + 单测/集成回归。
- **notice defer 等待语义（D161）**：active 不可用时通知保留为 per-chat pending，下一次入站以被动回复补投（有上限/TTL 清理）。
- **动作按钮扩展空间（D163）**：通用 `OutboundAction`/`InboundAction`、能力位与 outbox 持久化；M7 只预留、不实现按钮渲染/回调（M9 起落地 C2C 审批按钮）。
- 不引入 QQ 代码、不新增外部依赖。

### 验收

- `pnpm check`、`pnpm test`、`pnpm test:process`、`nix flake check` 通过；local-test 既有行为兼容。
- 新字段/路由/错误语义/actions 有单测与集成覆盖；outbox 旧文件可读。

### 依赖/风险

- 依赖 M1–M6 代码基线。
- 风险：core 契约改动影响本地通道与既有测试；需独立提交、分批评审。

### M7 实现记录（2026-10-27）

- 已实现契约/outbox/format/routing/service 的扩展；新增 `routing.ts` 纯函数与 `deferredNotices` 持久队列（与 outbox 同文档，不新增状态文件）。
- 已实现 per-turn 路由（`turnChat` + daemon `turn/start` 钩子）、`trustedChannels`、`defaultChannelId`、`restoreActiveChat`、缺 driver 立即 failed、`NonRetryableDeliveryError`/`PassiveReplyExpiredError`、被动槽位截断、通知 active 回退 + defer 补投、outbox 耗尽通知。
- 已验证：`pnpm check`；`pnpm test` 44 文件/328 测试；`pnpm test:unit` 42 文件/314 测试；`pnpm test:process` 6 文件/42 场景；`nix flake check`（package/unit/package-smoke/module-eval）通过。flake unit 使用 `pnpm test:unit`，不跑 `tests/integration`。
- 实现口径（D162）：defer 覆盖 `kind=notice` 及“无可用入站上下文”的 reply；通知优先同 chat，其次其他 active-capable（`defaultChatId`），再次 defer，最后 drop；`lastActiveChat` 恢复不受 active 能力限制；deferred 补投每条 1 个被动槽位并加“⚠️ 补发”。
- 动作按钮（D163）：只落契约、能力位与 outbox 持久化；M7 没有生产者，deferred 通知/回复丢弃 actions。
- 未完成/后置：M8 QQ driver、真实平台事实门禁、按钮渲染与 `INTERACTION_CREATE`（已由 [M9](14-roadmap.md) 认领）、图片链路、M6 目标机 12.12 清单。

## 14.9 M8 真实 IM 适配器：QQ 官方 Bot（代码已实现，真实验收待执行）

> 状态：**代码已实现（2026-10-27）**；14 项平台事实门禁、17.8.2 真实 Bot 清单与目标机部署待用户执行。完整规格见 [17](17-qq-official-bot.md)，调研材料见 `.spec/notes/`，门禁记录见 `.spec/notes/qq-fact-gate.md`。

### 交付物

- `packages/channel-qq-bot`：QQ 官方 Bot driver（官方 `qqbot-nodejs` `./protocol` 传输层，D154）。
- 单聊 + 群内 @ 提及；文本/Markdown 出站；被动优先 + `activeMessageFallback=auto` 能力门禁。
- NixOS module `channel.qqBot.*`、overlay 行、EnvironmentFile 密钥、bundle 行、lock/Nix 哈希更新。
- 自动化测试（fake WS/REST、进程级）+ 真实 Bot 手工验收清单。

### 验收

- 17.8 自动化与真实 Bot 清单通过；目标机部署可用。
- 实现前完成 17.8/notes 的 14 项平台事实门禁（token 域名、intents、被动窗口、`msg_seq` 幂等、主动可用性、消息上限、群字段、WS 在线要求、附件 URL、重连/关闭码、token 刷新、SDK 版本回归）。
- 主动推送已下线（2025-04-21）：提醒/系统通知按 D161 已确认方案（active 尝试 + 失败 defer 补投）实现。

### 依赖/风险

- 依赖 M7（core 扩展）以及 M2/M5/M6（审批、schedule、部署）。
- 最大风险：平台准入/封禁、白名单只有平台边界、主动推送不可用、协议冲突。
- 后置：图片链路（V8）、C2C `is_wakeup` 召回、按钮审批（已由 [M9](14-roadmap.md) 认领）、群全量消息。

### M8 实现记录（2026-10-27）

- 已实现 `packages/channel-qq-bot`：官方 SDK `./protocol` 的 `TokenManager`/`ApiClient`/`GatewayConnection` 薄封装；C2C/群 @ 归一化；被动优先 + `activeMessageFallback=auto`；错误码分类（含 HTTP 200 body `code`）；长度/Markdown 回退；滑动窗口频控；health。
- 已实现 NixOS `channel.qqBot.*`（13 选项）、overlay row、`trustedChannels`、bundle/launcher 装配、`.env.example` 与 flake module-eval/package-smoke；`nix/deps.nix` FOD 哈希更新。
- 已验证：`pnpm check`；`pnpm test` 52 文件/374 测试；`pnpm test:process` 7 文件/52 场景（含 M8 10 场景）；`nix flake check`（package/unit/package-smoke/module-eval）通过；`nix build .#default` 通过。
- 实现口径（D164）：SDK 只消费 protocol；不暴露 `sandbox`/`platformLimitsOnly`/driver 白名单；active 消息不发送 `msg_seq`；HTTP 200 + body code 显式转错；4009 由 SDK 重新 Identify；零依赖 fake WS/REST；不改 core。
- 未完成/后置：14 项平台事实门禁、17.8.2 真实 Bot 验收、目标机部署、按钮/`INTERACTION_CREATE`（已由 [M9](14-roadmap.md) 认领）、图片链路、群全量消息、C2C `is_wakeup`。

## 14.10 M9 QQ 按钮审批（代码完成，真实验收待执行）

> 状态：**代码完成（2026-10-29），真实平台验收待执行**。完整规格见 [18](18-qq-button-approval.md)；需求口径 [D165](03-decision-log.md)/[D166](03-decision-log.md)，实现口径 [D167](03-decision-log.md)。真实平台验收沿用 M8 的 14 项门禁并新增交互门禁（[notes/qq-fact-gate.md](notes/qq-fact-gate.md) #15–#20）。

### 交付物

- channel-core：broker 为审批生成/解释动作按钮（短 token + fallback），新增 `handleAction`；service 入站 action 路由（action 权威、失效提示、不误回退文本）；outbox `actions` 透传语义不变。
- channel-qq-bot：能力位打开；C2C 内联键盘渲染（「允许一次」/「拒绝」）；`INTERACTION_CREATE` 归一化与 `PUT /interactions/{id}` ack；intents `1<<26` 与 Identify 受限降级；`approvalButtons` 配置。
- channel-local-test：可选 inbound `action` 注入 + 能力位，供进程级测试。
- bundle/launcher/NixOS 选项（`channel.qqBot.approvalButtons`）、`.env.example`、文档回写。
- fake WS/REST 单元/集成/进程测试。

### 验收

- `pnpm check`、`pnpm test`、`pnpm test:unit`、`pnpm test:process`、`nix flake check`。
- fake 场景：提示带 keyboard → 按钮允许/拒绝 → 工具执行/拒绝；文本 fallback 回归；超时；重复/过期点击；群聊无按钮；daemon 重启后按钮失效；intent 降级。
- 真实平台：notes 的 #15–#20 门禁通过前只算“代码完成”。

### 依赖/风险

- 依赖 M7/M8；与 M10 无依赖，可并行。
- 风险：`INTERACTION` intent 平台未开放（降级为文本）、keyboard 在文本/Markdown 上的渲染差异、button data 长度/行数限制、ack 幂等。

### M9 实现记录（2026-10-29）

- 已实现 core action 生成/解释、QQ C2C keyboard、`INTERACTION_CREATE` ack/归一化、intents 降级、`approvalButtons` 配置与 local-test action 注入；实现细节与澄清见 [18.11](18-qq-button-approval.md)。
- 验证：`pnpm check`；`pnpm test` 54 文件/403 测试；`pnpm test:unit` 50 文件/383 测试；`pnpm test:process` 8 文件/58 场景；`nix flake check` 通过。真实平台 #15–#20 与 12.14 未执行，只能标“代码完成”。

## 14.11 M10 host-aware 持久终端 + Web（代码完成，目标机用户态 G2/G3/G4/G6 通过）

> 状态：**代码完成（2026-10-29）；G2/G3/G4/G6 已在 hkg-dog-darell 用户态通过，G5 与 systemd 12.14 待执行**。完整规格见 [19](19-persistent-terminal-and-web.md)；决策 [D168–D171](03-decision-log.md)；门禁记录见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)。**不能写“完整 M10 验收通过”。**

### 交付物

- 终端：新包 `packages/terminal-host`（每 host 注册一个上游 `BashTerminalBackend`，注入 `spawnTerminal` 走 `ctx.shellHosts`）；`ShellTerminalLaunch` host 协议 + registry `terminalLaunch`；local/sandbox launch 实现与 sandbox pin（TTL/reset 保护）；`/clear`、goal archive、daemon 退出的显式清理顺序；`nokoribi:pty` 提示词段；NixOS `terminal.*` 选项。
- Web：挂载 `dsh-web` + `dsh-web-search-deepseek` + `dsh-web-fetch-http` + `dsh-web-deepseek-api` + `dsh-tool-web`（默认 pin `deepseek-official` 搜索 / `http` 抓取）；vendor reviewer 的 `exemptTools`（默认 web 工具）；NixOS `web.*` 选项与 `.env.example`。
- 依赖：新增 DSH `0.2.1-rc.3` 包；`pnpm-lock.yaml` 与 `nix/deps.nix` FOD 哈希更新。

### 验收

- `pnpm check`、`pnpm test`、`pnpm test:unit`、`pnpm test:process`、`nix flake check`、`nix build .#default`。
- 终端：fake `spawnTerminal` 单测；local host 真实 PTY 集成（cwd/env 持久、owner 隔离、agent 释放清理、pin/release）；sandbox 终端需 Nix buildEnv（目标机/手工）。
- Web：fake provider 单测/集成（注册、provider 选择、缺 key、截断、豁免不调用 reviewer）；真实搜索需 `DEEPSEEK_API_KEY` + 网络出口（门禁）。

### 依赖/风险

- 依赖 M1–M3 基线；与 M9 无依赖，但建议先做终端方案 spike。
- 风险：`BashTerminalBackend` 注入面非文档化（失败回退 vendoring；实现期确认未触发）、sandbox PTY 与 TTL/reset 的生命周期竞争、NixOS 无 `/bin/bash`（host launch 用 buildEnv bash）、终端输出 token 成本、Web 豁免审查的残余风险。

### M10 实现记录（2026-10-29）

- 终端：新增 `packages/terminal-host`（per-host `BashTerminalBackend` + `AsyncLocalStorage` 传 owner + 注入 `spawnTerminal` 走 `ctx.shellHosts.terminalLaunch`）；`shell-bash` 增加 `TERMINAL_BASH_ARGS`/launch 协议/能力位/`onChange`/发现工具 `terminal` 字段；`local:workspace` 增加 `terminalBashPath` 与 launch；`sandbox:default` 增加 `pins`/`terminalLaunch`/`buildSandboxTerminalArgv`/互锁/`terminalSessions`；`agent-app` 增加 `terminal-cleanup.ts` 与 `/clear`/shutdown/goal 归档清理顺序；`nokoribi:pty` 段 order 3100（保留上游 `tool:pty`）；Nix `terminal.*` 与 overlay 停用行。
- Web：bundle 5 行（`web`/两个默认 provider/`deepseek-api`/`tool-web`）+ 默认 pin `deepseek-official`/`http`；Nix `web.*`（`enable`/provider/上限/`deepseekSearchBaseUrl`）；`web_search`/`web_fetch` 结果带不可信提示；`.env.example`/launcher help 更新。
- Reviewer：vendor 第 6 条补丁 `exemptTools`（hook 在 preset/accepting 之后、审查之前放行）；reviewer 配置默认 `[]`，bundle 默认 `web_search,web_fetch`，Nix `review.exemptTools` 默认同，空列表恢复全审。
- 依赖/Nix：新增 9 个 `@deepseek-ai/*` rc.3 依赖（terminal/web/sandbox-policy/tool-*，`dsh-terminal-bash` 仅类导入）；`pnpm-lock.yaml` 与 `nix/deps.nix` FOD 哈希更新；`module-eval` + `module-eval-disabled` 新断言、package-smoke 新依赖 import 断言。
- 验证（本次施工观察 2026-10-29）：`pnpm test:unit` 56 文件/438 测试、`pnpm test` 60 文件/458 测试、`pnpm test:process` 10 文件/64 场景通过（M10 新增 2 文件/6 场景：真实 local PTY 4 + fake 搜索 HTTP/reviewer 豁免 2）。`pnpm check`、`nix flake check`、`nix build .#default`、`nix run .#default -- --version` 均通过（2026-10-29 最终门禁）。
- 偏差/边界：未触发 vendoring 回退（`BashTerminalBackend` 注入够用），无新决策；rc.3 运行时只导出 `Config` → 自行物化默认值；`maxResultBytes` 属 `dsh-tool-terminal`；Nix 无 `deepseekApiBaseUrl` 选项；sandbox 终端忽略请求 cwd；`/status full` 不展示 `exemptTools`。
- 目标机用户态验证（2026-10-29，hkg-dog-darell，commit 39e331c，isolated `~/nokoribi-tmp/m10`，QQ disabled）：`~/nokoribi-bot` 构建包 `/nix/store/8mhq9430cg7avw9g3da5x1cd2rs1kz3p-nokoribi-agent-0.1.0`；G2 local PTY 回复 `PTY:/tmp:ok`、`/clear` 无 cleanup 错误；G3 sandbox PTY 输出 `SB:<sandbox dir>`、uid 1001、sudo 被 guard 拒绝；G4 真实 `web_search` 返回 nixos.org/distrowatch.com source；G6 `web_fetch https://example.com` HTTP 200，`http://127.0.0.1:9/` 被 non-public 拦截。详见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md) 第 2 节。
- 未完成/后置：G5（`deepseek-search-api`/`deepseek-fetch-api` 切换真实调用）；systemd unit/12.14 完整目标机清单；`terminal_send` 被 reviewer 拒绝的专用进程用例；goal 归档终端清理的进程级用例；跨重启终端（tmux）后置。

## 14.12 后置（v1 之外与 M9/M10 之外）

> 外部对标（Hermes Agent）与后续能力方向/优先级建议见 [notes/hermes-agent-gap-analysis.md](notes/hermes-agent-gap-analysis.md)（2026-10-27 快照，2026-10-29 更新）；后置项的排期与取舍需结合该对比由用户决策。

- **SSH host**（原 M7/M9，因 D149/D165 顺延）：`shell-host-ssh` provider、host 配置映射、ssh_config/agent/ProxyJump、后台任务限制、主机白名单/审批；不改 router/工具。
- **交互按钮扩展**：群聊按钮、`ask_user_question` 选项按钮、按钮点击后的消息编辑/撤回、流式消息；M9 只做 C2C 审批按钮。
- **真实 IM 适配器（第二平台）**：Telegram/Discord 等其他 `ChannelDriver` 实现；sender/chat 白名单细化；图片下载；平台限速/长消息。
- **heartbeat/主动唤醒**：当前明确不做。
- **多人/群聊权限**：需要身份、权限、审计、隔离重新设计。
- **token 预算插件**：可选未来能力。
- **备份/自动回滚**：当前明确不做。
- **web-debug**：当前明确不做；如需诊断，只能看 journald/session 文件/`/status`。
- **NixOS VM 测试/CI**：当前不做；可本地 flake checks。
- **更强的 sandbox 隔离**（bwrap/容器）：在 host 接口下可加。
- **远程文件工具**（read/write/edit 走远程）：未设计。
- **session search/长期记忆增强**：未纳入。
- **持久终端的跨 daemon 重启恢复**：DSH 终端是进程内的；需要 tmux/screen 重新附着，未纳入。

## 14.13 实现前必须验证

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
11. QQ `INTERACTION_CREATE` intent / keyboard 渲染 / ack / 按钮限制（M9 门禁 #15–#20）。
12. `BashTerminalBackend` 注入点 + sandbox 内 setpriv PTY 可行性（M10 spike）。
13. NixOS 上终端 bash 路径与 PTY 可用性。
14. DeepSeek 搜索 API / 目标机网络出口可用性（Web）。
15. sandbox 终端与 TTL/reset/`disposeSession` 的清理顺序（M10）。

## 14.14 v1 完成定义

- M1–M8 代码与自动化门禁通过；M6/M8 真实验收（NixOS 12.12、QQ 14 项门禁/17.8.2）执行并记录。
- 文档（本套）与实现一致；所有偏离回写。
- 安全检查清单（08）中的已接受风险被再次确认。
- 手工验收清单（12.12）执行并记录结果。
- M9/M10 是 v1 后增强，不改变上述 v1 完成定义；其验收标准分别见 [18.6](18-qq-button-approval.md) 与 [19.5](19-persistent-terminal-and-web.md)。

## 14.15 下一阶段里程碑（规划，2026-10-29 确认）

> 状态：**规划已确认（D176），代码未实现**。本节记录 M11–M17 的目标、依赖、范围与验收口径；每个里程碑启动时先写决策/规格再实现，并按 AGENTS.md 回写本文与相关文档。M16 的本地记忆设计见 [09.5](09-prompt-and-memory.md) 自动注入（D172–D174）；M17 的 OpenViking 后端见 [D175](03-decision-log.md)。M11–M17 均为 v1 后增强，不改变 [14.14](14-roadmap.md) 的 v1 完成定义。

**当前顺序（2026-10-29 调整）**：M11 → M12 → M13 → M14 → M15 → M16 → M17。**记忆与 OpenViking 放在最后**（M16/M17）；M17 固定晚于 M12（Skill）与 M13（MCP）；其余里程碑可在启动前按优先级调整（D176）。

| # | 里程碑 | 目标 | 依赖 | 状态 |
|---|---|---|---|---|
| M11 | 会话检索 | `session_search` / `session_read`，复用 `ctx.sessionQuery`（sqlite FTS） | 无（`session-query` 行已挂载） | 待实现 |
| M12 | Skill 技能系统 | `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`；本地 skills 目录与 Nix 打包 | 无 | 待实现 |
| M13 | MCP 客户端 | `dsh-mcp-client` + `dsh-mcp-resources`；Nix `mcp.servers` | 无 | 待实现 |
| M14 | 消息图片 | 入站附件 → 模型图片；出站附件/富媒体与发送工具 | V8 模型视觉、QQ 门禁 #14 | 待实现（分两阶段） |
| M15 | 提问按钮 | `ask_user_question` 选项按钮（core action + QQ C2C keyboard + 文本 fallback） | M9 action 基础设施、QQ 门禁 #15–#20 | 待实现 |
| M16 | 记忆本地自动注入 | pinned 快照 + runtime context 注入 + `pin`/`unpin` + 配置/观测/测试 | 无 | 待实现 |
| M17 | OpenViking 可选后端 | 开关 + 连接配置；启用即停用本地记忆，OpenViking 接管 | M12 + M13 | 待实现 |

### M11 会话检索

- **目标**：模型可按关键词/时间/类型检索历史会话并读取上下文，补足“跨会话回忆原始历史”的能力。
- **做**：新增 `session_search`（会话/事件搜索、过滤、分页）与 `session_read`（事件上下文窗口）；复用 `dsh-session-query-sqlite` ranked FTS；结果截断与“历史内容不可信”标注；提示词段与 Nix 上限；`/status` 或日志可观测。
- **不做**：向量/embedding、跨设备索引、自动召回注入（仍由模型主动调用）。
- **验收**：单测 + 进程测试（真实 sqlite 会话文件）；本地可完整验收，无需外部凭证。
- **风险**：历史内容注入模型（标记不可信）；检索延迟/结果过大；reviewer 是否豁免只读检索需决策。

### M12 Skill 技能系统

- **目标**：模型可发现并按需加载本地技能，复用经验而不是重复推导。
- **做**：挂载 `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`（rc.3）；技能根 = Nix 打包只读目录 + `$DSH_HOME/skills`（可选自定义目录）；`/name` 技能调用与频道命令衔接需实测；`skill.*` Nix 选项；bundle 依赖。
- **不做**：远程 hub/下载、技能市场、技能自动创建生命周期（后续评估）。
- **验收**：本地 skill 目录的发现/加载/调用测试；Nix module-eval；目标机手工。
- **风险**：技能正文是模型可见指令（信任边界）；上游 rc.3 API 行为需核对（🧪）。

### M13 MCP 客户端

- **目标**：接入外部 MCP server 的工具面，复用现成生态。
- **做**：新增 `dsh-mcp-client` + `dsh-mcp-resources`（+ `@modelcontextprotocol/client`）依赖并锁 rc.3；Nix `mcp.servers`（stdio/streamable-http、command/url、env、超时/重连）动态插入行；工具自动进入 Auto review；secret 走 EnvironmentFile/agenix；健康/启动失败降级。
- **不做**：MCP 资源/提示模板全量支持（先 tools/基本 resources）、打包外部 server。
- **验收**：fake MCP stdio/HTTP 进程测试；`nix/deps.nix` FOD 与 lock 更新；`nix flake check`；真实 server 手工。
- **风险**：外部 server 命令权限面、凭据/数据出界、启动延迟、MCP 工具审查成本。

### M14 消息图片（入站 → 出站两阶段）

- **目标**：补齐 IM 图片双向链路：用户发图可给模型；模型可回图/附件。
- **入站**：channel-core 接受 `InboundMessage.images` → `ctx.attachments` → 模型图片块；QQ 附件下载（大小/超时/失败降级为纯文本并提示）；local-test 支持注入；能力位 `inboundImages=true`。
- **出站**：contract/outbox 增加文件字段（内容寻址 attachment ref、重试/重启、deferred 不带附件、仅最后一段）；agent 发送工具（扩展 `send_to_user` 或新增 `send_file`）；QQ 富媒体上传 + `msg_type=7`；local-test 暴露产物。
- **门禁**：V8 真实模型图片调用；QQ 附件 URL/上传门禁 #14 及新增事实；参考 [17](17-qq-official-bot.md) 17.4/17.5 与 notes。
- **风险**：图片提示注入、模型视觉能力/成本、QQ 媒体大小/格式限制、出站失败回退。

### M15 提问按钮

- **目标**：`ask_user_question` 的选项在 QQ C2C 上可点击，文本回复仍可用。
- **做**：core broker 为单选且有 options 的问题生成 callback actions（复用 M9 token 映射）；QQ 仅 C2C 渲染 keyboard；label ≤10、选项数上限、超限回退文本；多选问题保持文本（待决策）；点击后沿用 M9 的 ack 语义。
- **验收**：fake QQ/local-test 进程测试；真实门禁沿用 M9 #15–#20 并新增提问按钮事实；通过前只标“代码完成”。
- **风险**：平台 intent/按钮限制、多选/自定义输入语义、群聊按钮仍后置（D166）。

### M16 记忆本地自动注入

- **目标**：主会话每轮带上 pinned 快照（用户画像 / 长期记忆），同时保持静态提示词与 KV-cache 稳定；完整内容仍按需检索。
- **做**：`packages/memory` 增加 `pinned` frontmatter、`pin`/`unpin` action、快照渲染（默认 3000 字符 / 20 条、超预算 footer）、`ctx.systemPrompt.context` 注入、每轮 turn 冻结刷新、仅主 root agent、`memory.inject.*` Nix 选项、`/status full` pinned/snapshotChars、提示词与 tool description 更新；单元 + fake LLM 进程测试。
- **不做**：每轮自动检索、向量/embedding、外部 memory provider、`/clear` 前自动提炼、多用户作用域。
- **验收**：`pnpm check` / `test` / `test:unit` / `test:process`；`nix flake check` / `nix build`（可用时）；真实手工确认快照与 `/status full`。
- **风险**：记忆内容成为长期上下文（持久化提示注入面）；快照 token/过期；每轮刷新行为；reviewer 不覆盖注入内容（登记 [15](15-verification-and-risks.md)）。

### M17 OpenViking 可选后端

- **目标**：默认本地记忆；可选启用 OpenViking，启用后由其接管记忆，停用本地 memory 组件（D175）。
- **配置（已确认形状）**：Nix `memory.openviking.enable`（默认 `false`）；其他跟 OpenViking 连接相关的配置全部放在 `memory.openviking.*`，包括 `endpoint`、`apiKeyEnv`（指向 EnvironmentFile/agenix 变量，不写入 store）、可选 `peerId`/`workspacePeer`/`recallMaxTokens` 等。
- **做**：启用时 overlay 将 `nokoribi-memory` 行 disabled、`nokoribi-prompt` 不注册 memory 提示词段；加载 `@openviking/dsh-memory-plugin`（Apache-2.0，pin 版本）作为 profile bundle；连接失败/离线降级与 `/status` 展示；本地 entries → OpenViking 一次性迁移说明。
- **不做**：打包 openviking-server、与其双写/双读、在仓库内提供 embedding/VLM 服务。
- **前置**：M12 Skill 与 M13 MCP（插件 peer：`dsh-skill`/`dsh-skill-filesystem`/`dsh-mcp-client`）；插件已验证兼容 DSH `0.2.1-rc.3`。
- **验收**：module-eval（启用时本地行 disabled、`memory.openviking.*` 连接 env 注入、校验必填）；无 server 启动不崩；fake server recall/capture/commit 测试；真实 server spike（外部部署，embedding + VLM provider）记录召回/延迟/降级；许可与部署边界写入文档。
- **风险**：额外 provider/密钥面；记忆数据出界；AGPL server 部署责任；插件版本/API 漂移；启用后无本地 fallback（需文档明确）。
