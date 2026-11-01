# Nokoribi Agent 现状事实梳理（对照 super-agent 五模块）

> 方法：精读 `README.md`、`AGENTS.md`、`.spec/01`–`.spec/25` 的关键章节与 `packages/*` 源码，并在已安装的 DSH 0.2.1-rc.3 包（`packages/bundle/node_modules/@deepseek-ai/*` 与 DSH 完整安装闭包）中查证原语。
> 事实分级：**代码已实现** / **规格设计（未落地）** / **未实现或后置** / **未确认**。DSH 版本固定 `0.2.1-rc.3`（`README.md:7`，`packages/bundle/package.json`）。本文只交付事实与缺口，不写最终建议。

## 1. 运行形态与装配

- **单进程 daemon + NixOS systemd**：专用用户 `nokoribi`、`DSH_HOME=/var/lib/nokoribi-agent`、`Type=notify`、`WatchdogSec=120s`、`Restart=on-failure`、`KillMode=mixed`（`.spec/12:239-291`）。状态目录布局（`sessions/`、`state/`、`memory/`、`storage/schedule.json`、`sandboxes/`、`run/`）见 `.spec/12:335-355`。
- **薄启动器**：不依赖官方 `dsh` CLI，vendor `profile-boot`；默认 bundle 只有 `["@nokoribi/bundle"]`，仅 OpenViking 后端启用时追加第二个 bundle（`packages/launcher/src/index.ts:14-32`；`.spec/04:160-180`）。
- **bundle 是完整 Cordis 树**（496 行 `packages/bundle/cordis.patch.yml`）：session/agent/agent-loop/tools、subagent+goal+goal-round-driver（`:291-316`）、schedule（`:282-289`）、jobs-local+tool-jobs（`:220-224`）、session-query FTS5（`:44-55`）与 tool-session-query（`:134-144`）、terminal/web、reviewer，以及自研 memory/prompt/shell/channel/agent-app 行（`:322-496`）。版本升级为手动整批（`.spec/04:228-241`）。
- **无 Web UI 是有意的**：v1 明确不安装 client/UI、API gateway 等行；`sessionController` 由自研最小桥实现，只实现 `dsh-schedule` 需要的 `resolveAgent()`（`.spec/04:128-139`；`.spec/01:81`；`packages/agent-app/src/session-bridge.ts:34-47`）。官方 `dsh-api-session-controller` 包在 lock 闭包中（`dsh-schedule` 的 peer），但**不作为行挂载**。
- **主会话生命周期**：启动取单实例锁 → 校验状态 → `ctx.agents.resume()` 或 `create()`（`sessionId=main-<uuid>`、`cwd=workspace`）→ 程序化设 Auto 预设 → 恢复 goal/outbox → 放行缓冲入站 → `sessionController.markReady()` → 写 ready（`packages/agent-app/src/daemon.ts:384-410`、`:431-456`；`.spec/05:51-74`）。重启后：会话 resume、goal 冷恢复、outbox 重发（at-least-once）、待审批/提问失效提示（`.spec/05:92-103`）。

## 2. 会话与并发模型

- **单用户、单常驻主会话**是硬性设计原则（D08）；同一时刻只有一个主 agent，goal/任务子代理由主 agent 创建（`.spec/05:7-9`、`.spec/05:157-163`；`.spec/01:96`）。
- **注入语义**：IM 消息经 channel-core ingress（allowlist/去重/action/命令/待应答 → 默认投递）后，忙则 `agent.steer()`（最近 step 边界、不打断工具）、闲则 `followup()`，只有 `/stop` 等显式命令才 `cancel()`（`.spec/06:86-107`；`packages/channel-core/src/service.ts:975-983`、`:1415-1434`；DSH 原语见 `.spec/02:42-47`）。**这天然已有"Router 批处理"效果的雏形**：主 agent 忙时到达的消息在 inbox 积压、下一边界合并领取。
- **goal 子代理是唯一的多会话并行形态**：宿主 `start_goal`/`/goal new` 预留 `goal-<uuid>` child id → `ctx.subagents.startActivation()` → `ctx.goals.create()`，round-driver 自动续跑（`packages/agent-app/src/goals/manager.ts:182-231`；`.spec/10:3-36`）。多个 goal 可并行、无并发上限；重启后 `sendMessage` 冷恢复 + 重新 arm（`manager.ts:465-520`；`.spec/10:60-84`）；归档只写索引、保留 DSH 会话文件（`.spec/10:117-142`）。
- **子代理能力暴露**：挂载 `dsh-subagent`+`dsh-subagent-spawn-in-process`+`dsh-tool-subagent`+`dsh-tool-subagent-control`，`maxDepth:1`、并发数不限（`packages/bundle/cordis.patch.yml:294-312`）。rc.3 的 child 是 continuable activation：`startActivation`/`sendMessage`/`listChildren`/`drainContinuableChildren`（`packages/bundle/node_modules/@deepseek-ai/dsh-subagent/README.md:61,69`）；工具调用立即返回 `started subagent <childId>` 不等结果（`dsh-tool-subagent/README.md:59,209`）。`dsh-subagent-fork-in-process` 在 rc.3 闭包中存在但本项目未挂载。
- **无 Router/Worker 分层、无多会话调度器**：所有 chat 汇入同一主会话（`.spec/05:159-163`）；per-chat 路由只是出站投递选择（`packages/channel-core/src/routing.ts:6-110`）。用户与主会话一对一，goal 对用户不可见（报告经 `parent.steer()` 进主会话由主 agent 转述，`.spec/05:162`）。
- **QQ 入站链路**：driver 归一化 `InboundMessage`（`c2c:`/`group:` 命名空间）→ channel-core 串行 ingress → steer/followup（`.spec/17:146-154`；`.spec/06:86-107`）。

## 3. 事件驱动与主动行为

- **schedule 是"定时 follow-up"，不是事件总线**：rc.3 `dsh-schedule` 为 Host-wide 服务，任务存 `$DSH_HOME/storage/schedule.json`，到期经 `sessionController.resolveAgent()` 把 `[SCHEDULE REMINDER]` 作为 user 消息投回主会话，需主 agent live 且不打断当前轮（`.spec/10:157-168`；`packages/bundle/node_modules/@deepseek-ai/dsh-schedule/README.md:26,65`）。桥接只解析当前主会话（`packages/agent-app/src/session-bridge.ts:34-47`、`:71-80`）。
- **无 heartbeat、无周期唤醒**（D62）：主动行为只有 schedule 提醒与 goal 续跑；提示词明文禁止 sleep/轮询/后台循环（`.spec/10:167`；`packages/prompt/src/sections.ts:115`）。仓库中唯一 "heartbeat" 是 systemd 存活心跳（`packages/shared/src/systemd.ts:160-180`），不是任务推进监控。
- **事件过滤只有程序层**：allowlist、`channelId+messageId` 去重、`trustedChannels` 跳过白名单、命令解析、待应答分流（`.spec/06:86-107`；`.spec/17:281-291`）。**没有语义层事件判别**，也没有 LLM 的事件准入（auto-review 审的是工具动作，不是事件是否值得响应）。
- **QQ 平台硬约束（代码与规格一致，真实平台门禁未执行）**：被动回复窗口单聊 60 分钟/4 次、群 5 分钟/5 次（`.spec/17:76`）；主动推送官方自 2025-04-21 起不再提供（`.spec/17:78`）；因此 D161 采用"active 尝试 + 失败 defer 到下次入站补投"（`.spec/17:201-218`；`packages/channel-qq-bot/src/driver.ts:792-806`；`packages/channel-core/src/service.ts:1037-1060`）。入站只处理 `C2C_MESSAGE_CREATE` 与 `GROUP_AT_MESSAGE_CREATE`，不接群全量消息、不做驱动白名单（`.spec/17:62-64`、`:295`）。**结论：QQ-only 部署下"主动触达"不可保证——Agent 只能在用户带来被动上下文时学习外部事件；服务端主动提醒最长延迟到用户下次发言。**
- **无 Thread/多主题概念**：代码无 thread 抽象（`grep thread packages/*/src` 无结果）；同一 chat 的多个话题混在单主会话；群内不同来源的消息靠 chatId 区分，但不隔离上下文。
- **链式召回的半成品**：session 侧有 5 个只读工具（`session_search`/`session_event_search`/`session_trace`/`session_event_trace`/`session_event_read`），`session_trace` 提供祖先链+后代树的引用式追溯，检索排除调用者会话、按 `cwd` 全等授权（`dsh-tool-session-query/README.md:12,47-49`；`.spec/20:9-17`、`:60-64`）；memory 侧 M16 把 pinned 快照（默认 3000 字符/20 条）以 runtime context 每轮注入，全文仍要主动检索（`packages/memory/src/inject.ts:20-30`、`:223`；`.spec/09:175-195`、`:213-226`）。**但 Trigger/Thread/Worker 对象与内联 ID 图不存在**，召回只覆盖"历史会话 + 记忆条目"。

## 4. 面向人的交互

- **出站统一 outbox**：每轮最后一条非空 assistant 文本镜像到 IM、系统通知、`send_to_user` 补发；按 driver 能力分段/降级 markdown；at-least-once、失败退避、缺 driver 短路（`.spec/06:186-222`）。
- **多 driver 抽象已实现**：`ChannelDriver` 契约含 capabilities/`canDeliver`/`health`/动作按钮（`packages/channel-core/src/contract.ts:117-130`）；已实现 local-test（loopback HTTP+token 长轮询）与 QQ 官方 Bot 两个 driver；`trustedChannels` 让 QQ 跳过静态白名单（`.spec/06:10-83`；`packages/bundle/cordis.patch.yml:420-467`）。
- **富交互（代码完成，真实平台门禁待执行）**：M9 审批按钮（仅 C2C、2 按钮、action 权威、失败不回退文本、`PUT /interactions/{id}` ack）、M15 提问按钮、M14 入站图片→模型 image block 与出站文件（`.spec/06:177-184`；`.spec/14:452-484`）。审批/提问串行 FIFO、approval 60s→拒绝、question 300s→报错、进程重启全部失效（`.spec/05:130-138`）。
- **缺口**：无流式/过程播报、无 Web UI、无多用户/群权限模型；群聊按钮、语音视频、群全量消息、第二 IM 平台均后置（`.spec/01:77-88`；`.spec/14:366-382`）。

## 5. 计算 / 状态 / 环境分离与 Watchdog

- **状态**：DSH 事件溯源 JSONL 存在 `$DSH_HOME/sessions/`，自研 state/outbox/memory/schedule/sandbox 元数据落盘；单实例文件锁保证一个 `DSH_HOME` 只有一个 daemon（`.spec/05:7-49`；`.spec/12:335-355`）。
- **执行环境二选一**：`local:workspace`（真机、可 NOPASSWD sudo）与 `sandbox:default`（Nix buildEnv、临时目录、TTL、`no_new_privs`、PATH 去 sudo；**不是安全隔离边界**）（`.spec/08:102-113`；`.spec/07`）。M10 的 `terminal_*` 是 host-aware 持久 PTY，但**进程内持久**、daemon 重启即丢（`packages/terminal-host/src/index.ts:38-60`；`.spec/19:1-20`）。
- **计算、状态、环境三者仍在同一台 NixOS 主机上**：无远程/多设备 daemon、无端侧轻量 daemon、SSH host 顺延未排期（`.spec/01:80`；`.spec/14:366-382`）。"持久"只到"进程可重启恢复"级别。
- **Watchdog 现状 = 存活探测，不是任务监督**：`SystemdNotifier` 按 `WATCHDOG_USEC/3` 发 `WATCHDOG=1`，事件循环卡死时 systemd 超时重启；验收用 `kill -STOP` 手工触发（`.spec/12:289`、`:394`；`.spec/03:357`）。**没有**文章第 6 节那种独立 Watchdog Session：不会由模型判断 Worker 是否有实质进展/是否偏航，也不会用自然语言在线修正系统行为。异常恢复手段只有：systemd restart、会话 resume、goal 冷恢复 re-arm、outbox 重发。

## 6. 安全与审批：引入"环境事件自动触发"会撞到的约束

- 全局 Auto preset：**每次原生工具调用**先用 fast→strong LLM reviewer 审查，deny/不确定才走 IM 单次授权，失败 fail closed；唯一豁免是 `web_search`/`web_fetch`（`.spec/08:15-24`、`:43-73`、`:129-137`；`packages/reviewer/src/config.ts:31`）。进程内 child 默认 `never`，由 vendor 补丁改成 deny 后走 `ask` 桥接（`.spec/08:74-88`；`.spec/02:265-272`）。
- 准入只依赖平台边界：`trustedChannels` 跳过白名单（D152），任何能私聊/群 @ 机器人的人都能驱动全权限 agent；开启 sudo 时等价远程 root 入口（`.spec/17:293-305`；`.spec/15:148`）。无 per-user 配额、无多用户权限模型（`.spec/01:83`）。
- **对"自动触发"的具体约束**：① 事件正文进入上下文即构成 prompt-injection 面，reviewer 只能审"动作"不能审"触发源是否可信"；② 审批 broker 全局串行、同一时刻只有一个待应答，worker 并发会把授权请求排队（`.spec/05:132-138`）；③ 审批超时 60s 无人应答即拒绝，长时间自主运行中人类不在线时多数敏感动作会 fail closed；④ QQ 被动窗口决定"被自动触发后的回复"可能根本送不出去（第 3 节）。

## 7. DSH 0.2.1-rc.3 可复用原语查证（重点）

> 证据路径约定：已安装的包在 `packages/bundle/node_modules/@deepseek-ai/<包>/`；`dsh-api-session-controller` 在 `node_modules/.pnpm/`（`dsh-schedule` 的 peer）；`dsh-base` 与 experimental 包在 DSH 完整安装闭包（harness-dev-context 的 `.pacquet/` 目录）中，本项目未安装。

| 能力 | rc.3 结论 | 证据（包名 + 文件/关键串） |
|---|---|---|
| 异步 start/stop 后台任务 | **语义已存在，但非统一 start()/stop() 工具对**：jobs 提供 `run_in_background` 启动 + `job_output`/`job_list`/`job_kill` 停止 + 完成通知（busy 注入下一步、idle 用 follow-up 唤醒）；文章 4.1 "已在 DSH 实现但默认未开启"与本 rc.3 的对应关系**未确认**（jobs 行在官方 `dsh-base` 默认挂载，本项目也挂载） | `dsh-tool-jobs/README.md:12,28,32-42`；`dsh-jobs`/`dsh-jobs-local`；producer：`packages/shell-bash/src/tool.ts:181-330`（本项目 bash 已支持 `run_in_background`+job 收集）、`dsh-tool-terminal/README.md:57,64`、`dsh-tool-subagent/README.md:59,209`（子代理本就异步返回 `started subagent`）；`dsh-base/cordis.patch.yml:96-97,289-290` |
| 会话创建 API（session controller / agents） | **已存在**：`ctx.agents.create()`/`resume()`（本项目主会话即用它）；Web 版 `dsh-api-session-controller` 提供 `session.create/fork/prompt/list`（项目 lock 中有、未挂载；项目自写最小 `ctx.sessionController` 只实现 `resolveAgent`） | `dsh-agent/README.md:32`；`packages/agent-app/src/daemon.ts:431-456`；`dsh-api-session-controller/README.md`（"Create and fork are the only operations that create a new Agent directly"）；`packages/agent-app/src/session-bridge.ts:34-47` |
| goal 机制 | **已存在且已用**：每会话一个持久 goal，phase/activation 分离，session-start 必 disarm、需显式 `resume()` re-arm；round-driver 对任意 live agent 自动续跑 | `dsh-goal/README.md:12,56-72`；`dsh-goal-round-driver/README.md:6,12,28`；本项目 `.spec/10:3-9`、`manager.ts:182-231` |
| subagent | **已存在且已用**：continuable activation、`startActivation`/`sendMessage`/`listChildren`、工具不是阻塞式 | `dsh-subagent/README.md:61,69`；`dsh-tool-subagent/README.md:59,240`；`.spec/02:285-293` |
| memory 注入 | **DSH rc.3 无 memory 包（不存在）**；但**注入通道存在**：`ctx.systemPrompt` 支持 runtime context（durable user 快照），本项目 M16 自研 memory 用它；OpenViking 为外部插件 | 完整 rc.3 安装闭包中无 `dsh-*memory*` 包；`dsh-system-prompt/README.md:33,47`；`packages/memory/src/inject.ts:20-30,223` |
| session 检索 | **已存在且已用**：SQLite FTS5 派生索引（`openAt=startup/first-search/never`）+ 5 个只读检索工具，按 `cwd` 全等授权、排除调用者会话 | `dsh-session-query-sqlite/README.md:12,45-46,67`；`dsh-tool-session-query/README.md:12,47-49`；`packages/bundle/cordis.patch.yml:44-55,134-144` |
| 额外可复用面（未安装） | rc.3 完整闭包中有 `dsh-experimental-agent-team`（Lead + 具名 teammates + 持久共享任务板）与 `dsh-experimental-tool-agent-team`（9 个工具：spawn_teammate/send_message/list_agents/wait_agent/interrupt_agent/team_task_*），另有 `dsh-tool-workflow`、`dsh-tool-ralph`、`dsh-subagent-fork-in-process`；均为 experimental，无稳定性保证，本项目未安装 | `@deepseek-ai/dsh-experimental-agent-team/README.md`（Summary 与 "durable shared task board"）；`dsh-experimental-tool-agent-team/README.md`（九工具清单）；`dsh-tool-ralph/README.md` |

## 8. 路线图、验收状态与 v1 非目标

- **M1–M17 代码已实现；真实验收未完成**：M6 目标机手工清单、M8 QQ 14 项平台事实门禁/17.8.2、M9 #15–#20、M10 G5 与 systemd 12.14、M11–M17 的 V16–V22 均待执行（`README.md:5-9`；`.spec/15`）。当前只能标"代码完成"，**不可作为生产服务**（`README.md:179`）。
- 本地门禁通过（`pnpm check`、单元/进程测试、flake checks、`nix build`/`nix run`；`README.md:9`、`.spec/14:485-498`）。
- **下一阶段候选**（`.spec/14:412-427`）：先做既有里程碑的真实验收；SSH host 顺延未排期；`heartbeat/主动唤醒` 明确不做（`.spec/14:366-382`）。
- **与 super-agent 直接冲突的 v1 非目标**：Web UI/web-debug、heartbeat/主动唤醒、多人/群聊权限、token 预算插件、备份/自动回滚、NixOS VM 测试/CI、sandbox 强制隔离（`.spec/01:77-88`）；设计原则里的"单用户、单主会话"与"默认非中断注入"（`.spec/01:90-100`）。

## 9. 若引入双层 Router/Worker：现有代码的复用 / 新建 / 冲突（仅事实）

**可复用（已实现）**
1. `channel-core`：driver 契约、ingress 管线、去重、outbox、被动回复上下文、broker（审批/提问串行）、多 driver 路由、动作按钮（`contract.ts:117-130`；`.spec/06`）。
2. `agent-app` 的会话与子会话管理：主会话 create/resume/恢复/ready 时序、`GoalManager`（child 预留 id、启动、跟踪、冷恢复、归档、报告转述）——这是现有最接近 "Router 派发 + Worker 生命周期" 的实现（`daemon.ts:384-456`；`goals/manager.ts:182-231,465-520`；`.spec/10`）。
3. DSH 原语：`ctx.subagents`（continuable child）、`ctx.goals`+round-driver、`ctx.jobs`（异步执行 + 完成唤醒）、`ctx.systemPrompt.context`（注入）、session-query FTS5（召回）、schedule（定时触发）；按会话/子代理选择模型的路由也已存在（`NOKORIBI_GOAL_MODELS` allowlist 与 `start_goal.model`/`--model`，`.spec/10:35-36`），可作为 Router 轻模型 / Worker 强模型的基础。
4. 运行时底座：systemd 常驻 + sd_notify + 单实例锁 + 崩溃恢复；terminal-host/shell hosts（执行环境）；reviewer（动作安全闸）。

**需新建（当前不存在）**
1. 事件源与 Trigger 抽象：现在只有 IM 入站与 schedule，无 GitHub/邮件/CI/群全量等环境事件接入。
2. 两级事件过滤（程序 Fast Path + LLM Slow Path）：现只有 allowlist/去重/命令分流。
3. Thread（话题/事件流）标识与 Worker 订阅/直通机制：代码中无 thread 概念，所有消息进单主会话。
4. Worker→Router 的统一汇报与"Router 只交互不执行"的角色约束：goal 报告是唯一先例，且依赖主会话在线、无持久 parent mailbox（`.spec/10:170-178`）。
5. 独立的 Watchdog Session（任务进展/偏航监督）与主动恢复策略；跨设备/端侧 daemon 与存算分离。

**会冲突 / 成本**
1. 单主会话 + 单实例锁（D08）：Worker 并行需要多会话调度，但出站镜像、审批 broker、系统通知都假设"一个主会话"（`.spec/05:7-9,132-138,157-163`；`.spec/06:186-193`）。
2. 审批串行 + 60s/300s 超时 + fail closed：多 Worker 并发敏感动作会把授权排成队，无人值守时大量自动动作被拒（`.spec/05:132-138`；`.spec/08:68-73`）。
3. QQ 平台：被动窗口限制 + 主动推送下线，Worker 完成通知/主动进展很可能无法及时送达（第 3 节；`.spec/15:101-104,148-150`）。
4. v1 非目标：heartbeat、多用户权限、token 预算、Web UI 均被排除（`.spec/01:77-88`）。
5. 细节约束：`maxDepth:1` 限制 Worker 内再委派；session-query 只按 `cwd` 隔离（`.spec/20:60-64`）；memory 全局单库；持久终端进程内（`.spec/19:1-20`）；subagent 冷恢复只有 `sendMessage` 路径（`.spec/02:85`）。

**不适用或当前无前置（事实层面）**
1. **云端无状态计算容器 + 水平扩展**：本项目是单用户单机 daemon；DSH 会话写所有权只在进程内协调、单实例文件锁保证一个 `DSH_HOME` 一个进程（`.spec/05:8`；`.spec/02:83-90`），无集群/持久消息队列基础设施，也没有多机共享会话存储。
2. **多租户/多人权限隔离、群全量事件流、A2A 协作**：v1 非目标，准入只依赖平台边界（`.spec/01:83`；`.spec/17:293-305`）。
3. **端侧轻量 daemon / 跨设备环境接入**：SSH host 与远程文件工具均未排期，现只有本机的 `local:*`/`sandbox:*`（`.spec/01:80`；`.spec/14:366-382`）。

## 10. 未确认 / 无法核验点

1. 文章 4.1 "异步任务机制已在 DSH 实现但默认未开启"与 rc.3 的 jobs/后台化机制是否同一实现：**未确认**（rc.3 观测到分工具异步 + 完成通知，未见统一 start()/stop() 控制对；无法证明"默认未开启"）。
2. rc.3 之后 DSH 是否新增真正的全双工 ReAct / 事件驱动框架：**未确认**（本次只核验 0.2.1-rc.3）。
3. QQ 主动推送是否完全不可用、被动窗口真实值：**未确认**（文档冲突，真实平台 14 项门禁未执行，`.spec/15:66`、`.spec/17:78`）。
4. NixOS 目标机 systemd/PTY、真实视觉模型、真实 OpenViking、FTS 规模等：**未确认**（V13–V22 待执行）。
5. M8–M17 的"代码完成"不等于验收通过；真实平台行为均未记录（`README.md:9,179`）。
