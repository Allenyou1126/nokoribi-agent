# Super-agent 设计在 Nokoribi 中的可行性与必要性（讨论稿）

> 状态：2026-11-01 讨论稿，供 Allen 决策，不是已批准的规格。
> 输入材料：
> - 知乎《Super-agent 设计探索：迈向更自主的 Agent 系统》全文：`.research/zhihu-article.md`（抓取于 2026-11-01，作者页 2052 赞同）
> - `https://github.com/deepseek-ai/dsh-superagent-prototype`：clone 于 `.research/dsh-superagent-prototype/`（commit `6337fc8`，单 commit 导入；README 自述 research prototype）
> - 本项目 `.spec/01`–`.spec/25` 与 `packages/*`（事实截至 M17「代码完成」）
> - DSH `0.2.1-rc.3` 完整发行闭包实测（含 `dsh-base`、`dsh-experimental-agent-team` 等）
> 详细证据见三份配套报告：`.research/analysis-prototype.md`、`.research/analysis-nokoribi.md`、`.research/analysis-mapping.md`。
> 口径：**可行性** = 能不能做、要多少代价；**必要性** = 值不值得现在做。成本量级：S ≈ ≤1 人周，M ≈ 2–4 人周，L ≈ ≥1 月（单人，含规格/实现/测试/门禁）。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 文章的设计能否用于本项目？ | **能，但要分层看**。设计思想与局部机制：高可行（S 级，无新依赖）；轻量双层架构：中高可行（B' 复用上游 experimental Agent Team，B'' 自研）；**整包移植原型：低可行，且不必要**；文章模块 5（计算/状态/执行环境分离）在「agent 已常驻服务器」的前提下**不适用**。 |
| 现在是否有必要？ | **整体偏低**。文章四特征中「连续」「持久」本项目已满足，「高效」大半满足，「主动」被 QQ 平台物理限制封死；双层架构的收益前提（多任务并发、多信源、多人协作）在当前单用户单信道下都不成立，而系统成本是真实的。 |
| 我的建议 | **现在做 A+（§6.1）**：开启 spill、补 delegation/后台纪律、加 goal 巡检、Thread 化只做设计预留；**B' 只做 1–2 天 spike**（§6.2）验证收益与冲突；**B'' 等触发条件**（§5.4）；**C 不做**。上述都不改变 M1–M17 的真实验收优先级——那才是当前最大的欠账。 |
| 必须先确认的三件事 | ① 你是否接受「主会话只当 Router、不再亲自执行长任务」；② 未来 3–6 个月是否真有并行多任务/多信源需求；③ 是否允许为了双层引入 experimental 包（需改 `.spec/04`「明确不安装」清单）。 |

## 1. 先澄清两份材料的关系（避免误读）

### 1.1 文章讲的是架构思路，不是某个实现

文章提出 Super-agent 的四个基础特征（连续、高效、主动、持久）与五个模块：

1. **双层架构**：常驻 Router Session 只做交互/分派，Worker Session 隔离并发执行；
2. **事件驱动**：Trigger → 程序 Fast Path + LLM Slow Path 两级过滤 → Thread/订阅直通 → Inline & Spill / 链式召回 → 投机执行；
3. **面向人的交互**：异步 ReAct（start/stop 全双工）+ 按信道定制输出；
4. **计算、状态与环境的分离**：云端无状态 Agent Loop + 持久存储分离 + 端侧轻量 daemon（脑手分离）；
5. **Watchdog**：主系统外部的独立 Agent Session，判断 Worker 是否真有进展、是否偏航并介入。

文章明确说这是「面向工程实践的架构思路探讨，并非对 DSH 现有产品功能的介绍」；文末说部分设计已在原型中实现，原型「只是验证技术路线的原型，并非正式产品」。

### 1.2 原型是文章的一个「单仓库团队协作」局部实现，不是参考实现

对照文章五模块，原型实际覆盖度（详见 `.research/analysis-prototype.md`）：

| 文章模块 | 原型实现情况 | 关键依据 |
| --- | --- | --- |
| 2 双层架构 | **完整实现**（Router/Worker 两个 preset、`worker-<ticketId>` 会话、角色模型只注入新会话、工具二次 restrict） | `src/app/sessions.ts`、`src/executor/dsh.ts:24-26`、`cordis.patch.yml:20-193` |
| 3.1 两级过滤 | **完整实现**（scope + admission 矩阵 + gate；LLM 语义评估；acceptMode `off/observe/auto`） | `src/policy.ts:175-207`、`src/admission.ts`、`prompts/admission.md` |
| 3.2 订阅直通 | **完整实现**（Intake 事务内扇出、多对多、resume/handback、14 天轮询） | `src/core/intake.ts:33-58`、`src/sources/poll.ts` |
| 3.3 Inline & Spill / 链式召回 | **简化**（600/1500 字截断 + read 指针，无统一引用图） | `src/executor/dsh.ts:113-128` |
| 3.4 投机执行 | **未实现** | 全仓库无 speculative 代码 |
| 4.1 全双工 | **语义成立但机制不同**（用 DSH jobs/subagents + inbox `inject/steer/followup`，不是 start/stop 工具；5 秒自动转后台） | `src/executor/background.ts`、`cordis.patch.yml:38-56` |
| 4.2 多信道 | **部分**（只有 GitHub 与 Feishu，且都绑 CLI 子进程） | `src/sources/github*`、`src/sources/feishu*` |
| 5 计算/状态/环境分离 | **未实现**（单机 SQLite + worktree + 操作者 OS 用户，只留 execution environment seam） | `docs/006-deployment.md:5-19` |
| 6 Watchdog | **简化**（Python status/restart 脚本 + 操作者自己 profile 的 hourly LLM 检查；没有「判断 Worker 进展」的 Watchdog Session） | `docs/006-deployment.md:133-141`、`scripts/dsh-superagent` |

### 1.3 版本差没有想象中大，但装配面确实不兼容

- 原型 `package.json` 写的是 `engines.dsh: ^0.2.1-alpha.2`（`package.json:53-55`），乍看与 Nokoribi 的 `0.2.1-rc.3` 有代差；但原型的部署文档实际要求 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`（`docs/006-deployment.md` Install 节），且它使用的服务端控制面（`ctx.agents.create/resume`、`agent.inject/steer/followup`、`permissionPresets`、`workspaceRegistry`、`ctx.subagents`、`ctx.goals`、`ctx.jobs`）在 rc.3 安装树中全部存在并在本项目中已被使用。**结论：服务端 agent 控制面可移植。**
- 真正不能直接搬的是三处：
  1. **Web 硬依赖**：`src/index.ts:8` 的 `inject` 包含 `webServer`，`src/app/http.ts:231` 要求 loopback `webServer` 并注册管理 API；Nokoribi 明确不安装 Web UI/host webserver（`.spec/04-architecture-and-build.md:128-139`）。删 client 不够，服务端管理面也要整体换掉。
  2. **preset 装配方式**：原型用 alpha 的 `@deepseek-ai/dsh-agent-preset` 在 bundle patch 里内联角色工具集与 5 秒 shell 上限；rc.3 改为 `dsh-agent-preset-registry`（声明式 composition），Nokoribi 未挂 registry。Worker 工具集/后台上限必须改用代码级 `tools.restrict`/guard + 全局配置实现。
  3. **单仓库 GitHub 场景写死**：repository/agent 账号/worktree/PR 生命周期/`gh` CLI 包装/auto-merge 文本贯穿 Runtime、Executor、Assessor、Outbox、links、resources；`docs/007-architecture.md:275-287` 自己列出了这层耦合。

## 2. 本项目现状：它其实已经是一个「轻量 Router/Worker」雏形

这一点是讨论的前提，先说清楚**已有**的部分（详见 `.research/analysis-nokoribi.md`）：

| 文章机制 | Nokoribi 现状 | 差距 |
| --- | --- | --- |
| Router 常驻、统一对外 | 唯一主会话 + 单实例锁，所有 IM 入站都进主会话（`.spec/05-daemon-and-session-lifecycle.md:7-9,157-163`） | 主会话**兼职执行**，不是纯 Router；无「只交互不执行」约束 |
| Worker 隔离并发 | **goal child 已提供同构生命周期**：`goal-<uuid>` 预留、`startActivation`、冷恢复 re-arm、归档、报告 steer 回主会话（`packages/agent-app/src/goals/manager.ts:182-231,465-520`；`.spec/10-goals-and-schedule.md:3-36`）；generic `subagent` 也可用 | goal 只面向「长期多轮目标」，对用户不可见；无任务/话题级 Worker 与直通 |
| Worker 不直接对用户说话 | **已天然满足**：出站镜像按 `session.id !== mainSessionId` 过滤，goal/子会话的 turn 不会镜像到 QQ（`packages/agent-app/src/daemon.ts:556`） | 汇报依赖 child 主动 `send_message`，无持久 parent mailbox |
| 全双工异步 | `bash(host)` 支持显式 `run_in_background`，`job_output/job_list/job_kill` + 完成唤醒；subagent 本就异步返回 `started subagent`（`.spec/07-shell-hosts-and-sandbox.md:75-82,233`；DSH `dsh-tool-jobs` README） | 明确**不采用**前台超时自动转后台（D135，`.spec/03-decision-log.md:133`），长前台命令会占住主会话 |
| 事件/两级准入 | 只有 allowlist/去重/命令/待应答分流（`.spec/06-channel-and-interaction.md:86-107`）；Auto review 审的是**工具动作**，不是「事件是否值得响应」（`.spec/08`） | 缺语义级事件准入；**只有 IM 入站 + schedule 两类触发**，无 GitHub/CI/邮件等环境事件源 |
| Thread/订阅直通 | 无 thread 抽象（代码 `grep thread` 无结果）；微信/QQ 只有 chatId 级出站路由 | 缺失；且 QQ 群只收 @ 消息，事件流稀疏，直通没有可优化负载 |
| Inline & Spill | 挂了 `dsh-spill-local` + `dsh-spill-policy`，但 **bundle 里 spill-policy 没有配置 `maxInlineTokens`**（`packages/bundle/cordis.patch.yml:250-251`）；上游 `dsh-base` 设的是 `12500`（`dsh-base/cordis.patch.yml:414-417`）——README 明确「省略即禁用策略」。**即：spill 实际是关的** | 低成本可开；另外 M16 有 memory 快照注入、M11 有 session FTS5 检索 |
| Watchdog | systemd `WatchdogSec=120s` 存活探测 + sd_notify（`.spec/12-nixos-deployment.md:289`）；无任务级监督 | 缺「进程活着但 goal 空转/偏航」的语义级巡检 |
| 存算/环境分离 | agent 已常驻 NixOS 服务器（systemd），会话 JSONL 持久化，崩溃可恢复；执行环境 local/sandbox 双 host；无远程/端侧 daemon | **不适用**：文章模块 5 解决的是「本地设备离线」问题，本项目已用服务器部署绕开；SSH host 后置未排期 |

**关键结论**：文章对 Nokoribi 不是「从零补课」，而是在已有的**会话/注入/审批/持久/上下文**底座上**选择性加一层**。真正的缺口只有三处：事件源 + 语义准入、Thread/订阅对象模型、任务级 Watchdog——而前两者都依赖「有更多事件源」这一前提。

## 3. 可行性分析

### 3.1 三个硬约束

**（a）DSH 版本与装配。** 服务端可移植（见 §1.3）；不可移植的是 Web 面板/管理 API 与 preset 装配。若做轻量双层，需要放弃原型的内联 preset，改用 rc.3 已有的 `ctx.agents.create` + 代码级 `tools.restrict`/guard + 全局 shell 配置；Nokoribi 在 M4 已经用 `tools.restrict` 验证过主会话隐藏 goal 工具（`.spec/10:56`），路径是通的。

**（b）部署形态与 QQ 平台。** 原型是「Web profile + 面板 + 单仓库 GitHub/Feishu + 单机」；本项目是「无 Web UI + QQ 官方 Bot + NixOS systemd 单机」。QQ 的物理限制直接决定「主动」的上限：
- 被动回复窗口：单聊 60 分钟 / 每条最多 4 次，群聊 5 分钟 / 最多 5 次；主动推送官方自 2025-04-21 起不再提供，D161 只能「active 尝试 + 失败 defer 到下次入站」（`.spec/17-qq-official-bot.md:76-78,201-218`）。
- 入站只处理 `C2C_MESSAGE_CREATE` 与 `GROUP_AT_MESSAGE_CREATE`，不接群全量消息（`.spec/17:62-64,295`）。
- 因此 **Worker 的完成汇报最多只能等 Router 下次被入站唤醒时转述**；「主动播报」「实时进展」在 QQ-only 下不可承诺。原文 3.2 订阅直通的价值来自高频 Thread 事件流，而 QQ 群只把被 @ 的消息送进来，**直通机制在当前平台没有可优化的负载**。
- 另一个被低估的点：当前所有 chat（单聊 + 群 @）都汇入**同一个主会话**。若把机器人放进有不可信成员的群，他人 @ 的消息会进入同一个上下文，且 D152 已接受「平台边界即准入」的残余风险（`.spec/17:293-305`）。这既是安全设计问题，也是「Thread 化」最现实的需求来源。

**（c）单用户 vs 团队：价值与成本错配。** 文章双层架构的收益来源在本项目的兑现率：

| 收益来源 | 单用户 QQ 场景兑现 | 依据 |
| --- | --- | --- |
| 交互收敛（用户只面对一个 Agent） | 已兑现，甚至更彻底（单主会话） | `.spec/05:157-163` |
| Router 批处理（积压 Trigger 合并） | ≈0：QQ 单用户日常消息量远低于原文压测的 1–40 条/分钟 | 原文 7.2 |
| 上下文隔离（多任务互不污染） | **可兑现**，前提是确有并行多任务 | 待用户确认 |
| 订阅直通（Router 减负） | 低：群只收 @，无高频 Thread 事件流 | `.spec/17:295` |
| 多信道连续 | **不可兑现**：只有 QQ 一个信道 | 需要第二信道 |
| 团队协作/任务板 | 低：单用户、单 checkout、无跨人写冲突 | agent-team README：共享 checkout |

而系统侧成本是实打实的：多会话 token 上升（原文 7.1 自述「以更多 token 换更短更稳定」，去掉直通后 Router 决策 +30%、token +37%）；审批 broker 全局串行 + 60s 超时 + fail closed（`.spec/05:130-138`），多 Worker 并发会排队，无人值守时大量敏感动作会被拒；memory 只注入主会话（M16，`.spec/09:213-226`）、session-query 按 `cwd` 全等授权（`.spec/20:60-64`）、goal 与 Worker 是两套 child 生命周期。

### 3.2 可行性分级结论

| 方案层级 | 结论 | 成本 | 主要依据 |
| --- | --- | --- | --- |
| **A：只吸收设计思想**（不引入新架构/新依赖） | **高** | S | 全部落在现有包与规格：spill 配置、提示词纪律、goal 巡检、Thread 预留 |
| **B'：复用 rc.3 自带 experimental Agent Team** | **中高**（可行，但无稳定性承诺） | S-M（spike 1–2 天） | rc.3 完整闭包含 `dsh-experimental-agent-team` / `-tool-agent-team`；peer 依赖全在 Nokoribi 安装树；durable session storage 已有；profile 的 UI Host 是 inert，headless 不需要 web server；回退只需删两行 YAML |
| **B''：自研轻量两层**（借鉴原型领域模型） | **中** | M | 可复用 `GoalManager` 约 70%（`.spec/10`），补「话题→Worker 路由」「汇报→Router inbox」「Router 角色约束」；无 experimental 依赖 |
| **C：整包移植 dsh-superagent 原型** | **低** | L+ | Web 硬依赖、preset 装配、GitHub 场景写死、`danger-full-access` 与 Auto review 冲突、双状态系统、研究代码、测试全用 fake CLI；移植 ≈ 重写 |

### 3.3 整包移植为什么不划算（方案 C 的证据）

- 规模与质量：`src` ≈ 15.2K 行（其中 Web client 4.0K，27%），`tests` ≈ 15.0K 行；README 自述研究代码、可能有 bug、工程实践不一致；616 行 schema 迁移 + 实验性 `node:sqlite`；`danger-full-access` 是硬编码默认（`src/app/sessions.ts:152`）。
- 与本项目重复：它自带的 SQLite Store/Effects/Outbox 与 Nokoribi 的 `agent-state.json`/outbox 是两套；它自带的 memory 只是测试用内存 repo（`src/core/memory.ts`），而本项目已有 M16 memory 注入 + M11 session 检索；它的审批/安全姿态（worker 以操作者身份无审批执行）与本项目「每次工具调用 Auto review、fail closed」相反。
- 产品错位：原型的目标是「一个 GitHub 仓库的团队协作者」，不是「个人 IM 助手」。整包移植会**收窄** Nokoribi 的定位，而不是扩展。

## 4. 必要性分析

### 4.1 文章四特征逐项兑现度

| 特征 | 兑现度 | 说明 |
| --- | --- | --- |
| **连续** | 单信道已满足，跨信道不成立 | 所有 QQ 消息进同一主会话；但只有 QQ 一个信道；跨信道连续需要第二信道 |
| **高效** | 大半满足 | steer/followup 非中断注入（`.spec/02:42-47`）+ goal 并发 + jobs 异步；剩余差距是主会话「兼职执行」与不敢用后台 |
| **主动** | **被平台封死** | 无主动推送（D161）；只有用户带来的被动上下文 + schedule 提醒；没有「环境事件观察」的对象 |
| **持久** | 已满足 | systemd 常驻 + 单实例锁 + 会话 resume + goal 冷恢复 + outbox 重发 + 崩溃通知（`.spec/05:92-103`）；文章模块 5 的目标已由「服务器部署」达成 |

### 4.2 为什么整体必要性偏低

1. **收益与成本错配**：双层架构优化的是「多任务并发 + 多信源 + 人的注意力成为瓶颈」。本项目是「单用户 + 单信道 + 低频消息」；文章里被当作问题的「一个人只能跟进 3–5 个活跃 Session」，在本项目里根本不构成瓶颈。把并发做重，收益是想象的，成本（token、审批排队、运维、安全审查、升级维护）是真实的。
2. **文章实验不能外推**：7.1/7.2 是合成负载（约 300 条消息、20 个工作请求、时间工具代替真实编码、5 次重复），且**原型仓库没有实验脚本与数据**，无法复核；它证明的是「在高事件率团队场景下双层优于单 Session+subagent」，不证明「单用户低频场景也成立」。
3. **Nokoribi 已用低成本手段覆盖了文章诊断的主要问题**：长任务用 goal 子代理（宿主创建、并行、冷恢复、归档）；消息注入用 steer 而非打断；审批/提问/出站有完整 broker + outbox；持久性由 systemd 常驻解决。
4. **当前最大的欠账不是架构，是验收**：M6/M8/M9/M10/M11–M17 的真实平台与目标机门禁（`.spec/15` V13–V22）尚未执行，此时新开一个 super-agent 方向会进一步摊薄验收投入。

### 4.3 但有三个真实缺口，即使现在也值得处理

1. **多 chat / 多话题上下文混杂**：所有消息进同一主会话；若机器人进群，他人 @ 也会混进同一上下文（D152）。Thread/话题隔离是「上下文不互污」的最小实现，成本 M，且是 B 的基础。
2. **主会话占用与异步纪律**：D135 明确不自动转后台，长前台命令会占住主会话；提示词也禁止 sleep/轮询/后台循环（`.spec/03:133`、`packages/prompt/src/sections.ts:115`）。这不是要改双层，而是要在提示词/配置层面明确「长任务 start_goal、预计 >N 秒的命令 run_in_background」，让现有异步原语真正被用起来。
3. **任务级 Watchdog 缺失**：systemd 只保活，不判断 goal 是否空转/偏航。利用已有 `schedule` + goal 状态读取 + 系统通知，做一个低成本巡检，是文章第 6 节里**唯一现在就能兑现**的部分。

### 4.4 必要性翻转条件

**变高（任一成立）**：
- 接入可主动推送的信道（邮件、Telegram、企业微信等）或 GitHub/CI 事件——事件源一旦存在，「过滤/路由/隔离/主动」立刻从伪需求变成刚需，B 的价值出现；
- 接入群聊/多人（多人、多话题、不可信输入）——准入、身份、上下文隔离同时成为安全刚需；
- 用户确认有真实并行多任务需求且已造成损失（主会话被长任务拖住、多个话题互相污染、任务丢失）；
- 接受为稳定性/响应时间增加 token 支出（文章 7.1 的代价）。

**变低**：
- 只在 QQ 做低频单任务；
- 现有 goal/start_goal 已持续满足长任务隔离；
- 引入 experimental 包带来的升级回归成本超过收益。

## 5. 建议路线

### 5.1 现在做 A+（低成本，全部落在现有代码/规格，S 级）

| # | 动作 | 改哪里 | 收益 | 风险 |
| --- | --- | --- | --- | --- |
| A0 | **开启 spill retention**：`spill-policy` 补 `maxInlineTokens: 12500`（对齐上游 `dsh-base`） | `packages/bundle/cordis.patch.yml:250-251` | 让超大工具结果变成「预览 + 可检索定位符」，真正落地文章 3.3；注意 `.spec/20:28,68,133` 目前假设 spill 生效，需同步修正 | 无（保留完整文件，失败回退保原文） |
| A1 | **入站上下文 Inline**：入站消息附带被回复消息 + 相邻 N 条 + 长文截断续读指针 | `packages/channel-core` 入站格式化、prompt 段 | 减少反问/工具往返；为将来 Thread 化打底 | 注入变长；引用上下文是 prompt-injection 面（现有 safety 段已声明外部内容为数据） |
| A2 | **delegation / 后台纪律**：主会话提示词明确「长任务 `start_goal`；预计 >30s 的命令 `run_in_background`；不要占住轮次等待」；评估是否把 D135 改为可配（默认仍关闭） | `packages/prompt/src/sections.ts`、`.spec/03` D135 | 让已有异步原语（jobs/goal）真正被使用，零新依赖拿到文章 4.1 的大部分收益 | 提示词变化需回归；后台 job 增多后 outbox/通知需观察 |
| A3 | **goal 巡检（任务级 Watchdog 的 MVP）**：schedule 定时任务 + 只读读取 goal 状态/`listChildren`，异常时系统通知；先不引入独立 LLM watchdog session | `packages/agent-app`、prompt、Nix `schedule` | 填补「进程活着但任务空转/偏航」盲区；对应文章第 6 节 | 误报/巡检 token；需定义「无实质进展」判据 |
| A4 | **Thread/话题键设计预留**：在 `.spec/06` 增加 thread 键（chatId + 回复链/话题）与「何时升级为 Worker」的规则；暂不实现 | `.spec/06`、`.spec/14` 后置 | 为 B 打基础，不增加运行时代码 | 设计可能与未来 DSH 事件模型冲突（可改） |
| A5 | **outbox receipt 语义对照**（低优先）：同会话保序、幂等键、失败 3 次升级为系统问题、目标消失永久丢弃、被动窗口过期分类 | `packages/channel-core/src/service.ts`、QQ driver | 借原型 receipt 经验提高出站可靠性 | 与现有 outbox 状态文件兼容性；低 |

A4 是否需要做，取决于你对「多话题混淆」的感受；A1/A2/A3 建议直接做。

### 5.2 B'：用 1–2 天 spike 验证「上游 experimental Agent Team」是否够用

DSH 0.2.1-rc.3 完整发行闭包里带实验性 Agent Team：

- `@deepseek-ai/dsh-experimental-agent-team`：Lead + 具名 teammate、inbox 直投、durable shared task board（CAS、依赖、write-scope 警告）、wait/interrupt；
- `@deepseek-ai/dsh-experimental-tool-agent-team`：9 个模型工具（`spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`/`team_task_*`）；
- 其 peer 依赖（`dsh-agent`/`dsh-llm`/`dsh-session`/`dsh-session-persistence`/`dsh-session-projection`/`dsh-subagent`）全部是 rc.3 且已在 Nokoribi 安装树；durable session storage 已有（JSONL）；profile 的 UI Host 是 inert，**headless 不需要 web server**。

spike 范围（不改主干、可回退）：
1. headless 挂两行，禁用 legacy 的 `tool-subagent`/`tool-subagent-control`（工具名 `send_message`/`list_agents`/`interrupt_agent` 会被替换——这会与 goal 子代理的报告路径冲突，必须先拆清）；
2. 验证 roster/任务板/`send_message`/`wait_agent` 行为；主会话出站镜像是否被 worker 污染（现有 `daemon.ts:556` 过滤理论上已挡住）；
3. 验证 teammate 的敏感工具是否经 vendor reviewer 的 approval waterfall、多 worker 是否排队、60s fail-closed 的影响；
4. 验证进程重启后 roster 恢复、与 goal child 冷恢复的时序；
5. 验证 `pnpm-lock.yaml` + `nix/deps.nix` FOD 闭包能否构建（M10 有同类先例）。

**go/no-go 判据**：能构建、审批不劣化、汇报可到达 Router、与 goal 共存无冲突 → 再谈 M18 落地；否则走 B''。

### 5.3 B''：自研轻量两层（B' 冲突太大时的退路，M）

复用 `GoalManager` 扩展 WorkerManager：child 生命周期/汇报/冷恢复已有约 70%；补「话题→Worker 路由」「汇报→Router inbox」「Router 角色约束」；单用户场景不需要 CAS 任务板（Router 的上下文就是任务板）。优点：无 experimental 依赖、与 goal 体系天然一致、审批/记忆/检索可按 Nokoribi 的规则设计。

### 5.4 C：不做

见 §3.3 证据。若哪天真要做「团队协作 agent」，正确做法是**参照原型领域模型重写一个贴合 IM/QQ 的小内核**，而不是整包移植。

### 5.5 里程碑建议（不改变 v1 完成定义）

- **现在**：A0/A1/A2/A3（S），先补 M6/M8–M17 真实验收（这才是当前最大风险）。
- **可选 spike**：B'（1–2 天，产出 go/no-go），不占里程碑。
- **触发后**：B'' 或 B' 落地（M18a：Router 角色 + Worker 生命周期；M18b：Thread/订阅；M18c：验收）。触发条件见 §4.4。
- **更远**：第二信道（优先支持主动推送者）——这是「主动」与「跨信道连续」唯一能兑现的前提。

## 6. 需要你拍板的问题

1. **主会话角色**：是否接受「主会话 = Router，不再亲自执行长任务，全部交给 goal/Worker」？（选否则 B 不成立，只能走 A；当前是「短任务直接做、长任务委派」。）
2. **并行需求**：未来 3–6 个月是否真的会「同一个人同时推进多个独立任务、且不能互相污染上下文」？这是双层架构唯一的强必要性来源。
3. **信道路线**：是否计划接第二信道（优先支持主动推送的）/GitHub/群聊？谁提供账号与门禁工时？这决定 A 与 B 的先后顺序。
4. **experimental 依赖**：是否允许引入 `dsh-experimental-agent-team`（无稳定性承诺、要改 `.spec/04:136` 的「明确不安装」清单、替换 legacy 子代理工具面）？还是坚持只走 A + B''？
5. **无人值守授权**：Worker 的敏感动作采用「只读免审 / Router 转述 / broker 排队」哪种？审批 60s 超时是否允许 defer 到下次入站？
6. **进度可见性**：是否需要看 Worker 进度/任务板？QQ 侧只能文本/按钮（Web 明确不做）；若不需要，B' 可不装任何 UI，任务板可裁剪。
7. **token 预算**：是否接受双层带来的 token 上升（文章观测 Router 读缓存 +37%）作为换取稳定性/响应时间的代价？
8. **记忆/召回策略**：先复用现有 memory + session-query（S），还是投入文章式引用图/链式召回（M，依赖 Thread 对象模型）？

## 7. 事实校正与未确认

**本轮核实/校正**：
- 原型引擎写 `^0.2.1-alpha.2`，但其部署文档使用 `dsh@0.2.1-rc.3`；服务端 API 在 rc.3 可用——版本不是最大障碍，Web/preset/场景特化才是。
- 原型**没有**实现文章 3.4 投机执行、5 存算/环境分离、6 的 Watchdog Session；README 自述「文章里有些设计是未来方向，本原型未实现」。
- 原文 7.1/7.2 实验在仓库中**没有脚本/数据**，只能作方向性参考。
- 本项目 `spill-policy` 缺 `maxInlineTokens`（相对上游 `dsh-base` 的 12500），**实际处于禁用状态**；`.spec/20` 关于「溢出由 spill 处理」的说法需要修正。
- D135 明确不自动转后台；文章 4.1 的「全双工」在本项目只部分具备（显式 `run_in_background` + jobs 完成唤醒）。
- rc.3 发行闭包存在 experimental Agent Team（未挂载、未在 `.spec/04` 允许清单内）。

**未确认（需要 spike / 真实门禁）**：
1. experimental 包能否进入本项目的 `pnpm-lock.yaml` + `nix/deps.nix` FOD 闭包并 headless 构建；
2. teammate 完成后是否自动向 Lead 投递完成通知（README 未写）；
3. team 子会话的敏感工具是否经 vendor reviewer approval waterfall、与 broker 串行/60s 超时如何交互；
4. team child 与 goal child 冷恢复时序是否安全；
5. session-query FTS 索引是否覆盖 worker 会话并保持 `cwd` 授权语义；
6. rc.3 后续升级是否破坏 `tools.restrict`/approval 注入面；
7. QQ 真实平台门禁（M8 14 项、M9 #15–#20、M11–M17 V16–V22）均未执行。

## 8. 配套材料索引

| 文件 | 内容 |
| --- | --- |
| `.research/zhihu-article.md` | 知乎原文全文（五模块/四特征/实验/开放问题） |
| `.research/dsh-superagent-prototype/` | 原型代码与文档（只读分析，未修改） |
| `.research/analysis-prototype.md` | 原型实现级分析（对照文章五模块，含 `文件:行`） |
| `.research/analysis-nokoribi.md` | 本项目现状与 DSH rc.3 原语查证（含 `.spec`/`packages` 行号） |
| `.research/analysis-mapping.md` | 19 行映射矩阵、三硬约束、A/B'/B''/C 对比、翻转条件、决策问题 |
