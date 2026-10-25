# 01 背景与需求

## 1.1 项目背景

目标是基于 DeepSeek Harness 构建一个**个人长程 Agent**，参考 [OpenClaw](https://docs.openclaw.ai/) 的形态：常驻进程、通过 IM 与用户沟通、长期运行、可执行命令与工具、有记忆与定时/目标类能力。

规划阶段（2026-10-25）的工作是：调研 DSH 现有机制、确定精简方式、设计 IM 注入与远程/多 host 执行、把安全与部署方案定下来。本套文档是这次讨论的完整沉淀。

## 1.2 原始需求

用户提出的三条原始需求：

1. **精简 DSH**：尽可能精简掉 DeepSeek Harness 本身不必要的部分，只保留与设计目的相关的部分。
2. **命令执行扩展**：除了可以在工作区内执行，还可以通过 SSH 远程执行。
3. **IM 沟通与消息注入**：用户通过 IM 与 Harness 沟通；有新消息时，除非参数特别指定，否则用类似智能体通信的方法，在不打断本轮 Agent Loop 的情况下注入新消息，而不是直接中断本轮 Agent Loop。

参考对象是 OpenClaw；其 Gateway/多渠道/队列语义（steer、followup、collect、interrupt）是主要参考点，但不是照搬：

- 参考：[OpenClaw Command Queue](https://openclaw-ai.com/en/docs/concepts/queue)、[OpenClaw Messages](https://docs.claw.so/engine/concepts/messages/)。
- 本项目把"消息排队/注入"直接映射到 DSH 原语（`steer` / `followup` / `inject` / `cancel`），不自己实现队列核心。

## 1.3 环境与上下文

规划期间在用户机器上确认的事实：

- 工作区：`/home/allenyou/Projects/Nokoribi/nokoribi-agent`，规划开始时为空目录。
- DSH 安装：
  - CLI 与 dev-context 为 `0.2.1-rc.3`；
  - 用户 profile 的 `node_modules` 里装着约 249 个 `@deepseek-ai/*` 包，版本为 `0.1.5-rc.3`（旧于 CLI）；
  - CLI 的 npm 直接依赖 86 个包，完整安装闭包约 250–300 个 `@deepseek-ai/*` 包，其中大量是 Web/UI 客户端与实验 bundle。
  - 没有可直接修改的 DSH 源码 checkout；调研基于已安装包的 README 与编译产物（lib）。
- 用户环境：NixOS（flake + home-manager + haumea + agenix + 私有 `nixos-secret` 仓库 + `nur-packages`），Node.js 24、pnpm 11.3.0。
- 相关既有项目：`nokoribi-bot`（fraq + Milky 协议 QQ Bot）、AstrBot、`nokoribi-server`。这些是 IM 侧未来适配器的背景，但 v1 不接真实 IM。
- DeepSeek 接入：用户现有 DSH 使用 `deepseek-account` 登录态；本项目最终选择官方 API Key 方式。

## 1.4 需求拆解与最终解释

### R1 精简 DSH

调研结论：DSH 的组合单位是 `profile → bundle → patch 层`，原生支持"只挂载需要的部分"。

最终选择：

- **运行时精简 + 薄启动器**：不 fork DSH 内核，自建一个只依赖所选包的启动器；生产 profile 只挂载核心能力与自研插件，不安装/不加载 Web/UI 客户端栈、Windows/pwsh、ACP/SDK 应用、hooks、实验 bundle 等。
- 不做完整 fork（可维护性差、DSH 仍在 rc）；也不重写 harness。
- 用 NixOS 打包固定版本，保证可复现。

### R2 SSH 远程执行

最终选择：

- 保留"host 路由"设计：`bash` 工具带可选 `host`，host 由插件注册，router 按 `<kind>:<instance>` 路由，并提供 `get_available_shell_host` 发现工具。
- **v1 先做 `local:*` 与 `sandbox:*`，SSH 推迟到 v1 之后**（M7/后置）。原因是先把 host 维度、工具 schema、执行器接口验证完；SSH 到时只新增一个 host provider，不重做架构。

### R3 IM 沟通与不打断注入

最终选择：

- IM 桥接做成**进程内 Cordis host 插件**，直接使用 `ctx.agents` 的能力，而不是外部 gateway 或 SDK JSON-RPC。
- 默认语义：主 Agent 忙碌时 `steer()`（最近 step 边界注入，不打断当前工具/步骤）；空闲时 `followup()`（开始下一轮）；只有显式命令/参数才 `cancel()`（如 `/stop`）。
- IM 侧的显式参数形式：IM 命令前缀（`/steer`、`/queue`、`/stop` 等）+ 代码层投递参数（bridge 内部 API 的 `delivery` 字段）。
- 待审批/提问期间，普通文本优先作为应答；`/steer` 只旁路解析、不打断待应答。

## 1.5 v1 目标

v1（M1–M6）交付：

1. 精简发行版：薄启动器 + 完整插件树 bundle + 自研插件；不依赖官方 `dsh` 包。
2. 单用户、单常驻主会话；持久化、恢复、崩溃修复。
3. 渠道抽象 + 本地测试通道（loopback HTTP + token），验证消息闭环与注入语义。
4. host router + `local`/`sandbox` 两个 host，`bash` 统一入口与发现工具。
5. patched `experimental-auto-review`：Auto 预设、双档 reviewer、审批/提问桥接。
6. memory 工具 + AGENTS.md 分层 + 提炼子代理。
7. schedule 提醒 + 多 goal 子代理 + 归档。
8. NixOS 打包与 systemd 部署、agenix、sudo、看门狗。

## 1.6 非目标与后置项

- 真实 IM 适配器（QQ/Milky、Telegram 等）——后置。
- SSH host 实现——后置（M7）。
- Web UI / web-debug profile——最终决定不做。
- heartbeat / 主动唤醒——不做；主动行为只有 schedule 与 goal。
- 多人/群聊权限模型——不做，仅单用户白名单。
- token 预算插件——不做；靠 goal maxRounds、手动停止、compaction。
- NixOS VM 测试、GitHub Actions CI——不做；本地 Vitest + flake checks。
- 自动备份、自动回滚——不做（用户明确接受）。
- sandbox 的强制隔离（bwrap/容器）——不做；只做约定隔离 + 禁提权。
- overlay/写时复制沙箱——已撤销。

## 1.7 设计原则

1. **用 seam，不 fork 内核**：依赖 `ctx.agents`、`ctx.commands`、`ctx.userQuestions`、approval waterfall、`ctx.jobs`、`ctx.subagents`、`ctx.goals`、`ctx.systemPrompt` 等公开/稳定接口；只对实验性的 auto-review 做 vendor 补丁。
2. **精简优先**：生产进程不加载 Web/UI/客户端栈；安装物通过薄启动器避免官方 `dsh` 的重依赖闭包。
3. **host 语义显式**：默认 `sandbox:default`，持久操作显式选 `local:workspace`；两者都在 systemd 边界内，但 local 拥有主机权限（sudo）。
4. **非中断注入优先**：默认 steer/followup；中断只发生在显式指令。
5. **单用户、单主会话**：goal 等长任务用 continuable 子代理承载，主 Agent 保持响应。
6. **fail closed**：审批/审查/恢复失败时倾向于拒绝、保留状态、通知用户。
7. **可恢复**：会话、inbox、goal 状态、outbox 都持久化；daemon 重启后按状态恢复。
8. **可复现部署**：纯 Nix 只读配置；版本锁定；NixOS 声明式服务。
9. **自动化验收**：Vitest 单元/集成 + 进程级恢复测试 + flake checks；手工验收仅做探索。

## 1.8 成功标准

- 通过本地测试通道发一条消息，主 Agent 能收到并回复；忙碌时新消息在 step 边界注入而非中断。
- `/stop`、`/status`、`/steer`、`/queue`、`/clear`、`/goal` 行为符合规格。
- 审批/提问在 IM 文本中可完成；deny 后单次授权生效。
- 默认 sandbox host 可用；workspace 与 sandbox 的文件边界、TTL、提权限制符合规格。
- 多个 goal 子代理可创建、汇报、重启恢复、归档。
- memory 可跨会话检索；schedule 提醒可主动回复。
- NixOS `nixos-rebuild switch` 后服务常驻、重启恢复、watchdog 生效。
- 本套文档与实现一致；任何实现期偏离决策都回写。
