# super-agent 设计 → Nokoribi：映射、差距与落地方案对比

> 输入：`.research/zhihu-article.md`（原文，下称「原文」）、`.research/analysis-prototype.md`（原型实现分析，下称「P 报告」）、`.research/analysis-nokoribi.md`（Nokoribi 现状，下称「N 报告」），以及本轮对 DSH 0.2.1-rc.3 完整发行闭包中 experimental Agent Team 包的直接核对（路径见 §7）。
> 事实分级：**已核实**（有文件:行或 README 原文）/ **未确认**（推断或未做 spike）。本文只刻画可行性与必要性，不替代决策。
> 成本口径：S ≈ ≤1 人周，M ≈ 2–4 人周，L ≈ ≥1 月（含规格、实现、测试、门禁；按单人投入估）。成本分解顺序固定为「代码结构 / DSH 版本 / 平台 / 运维 / 安全审查」。
> 引用约定：`.spec/NN` 指 `.spec/NN-*.md`；`N 报告 §x` 指 `.research/analysis-nokoribi.md`，`P 报告 §x` 指 `.research/analysis-prototype.md`。

## 0. 结论速览

- **可行性**：五模块中「双层架构」「事件驱动」「面向人交互」**可行但需重装配**（rc.3 服务端原语齐备，Web/preset 面不可搬）；「计算/状态/环境分离」**在 Nokoribi 定位下不适用**；「Watchdog」**可行且性价比最高**。整体：A 类机制高、B 类中、C 方案低。
- **必要性**：**当前偏低**。四特征中「连续」「持久」已满足，「高效」已由 steer/followup + goal + jobs 覆盖大半，「主动」被 QQ 平台（无主动推送，D161）物理封死。双层架构的收益前提是「多任务并发 + 多信源 + 人的注意力成为瓶颈」，Nokoribi 是单用户单信道，**收益来源与系统成本错配**。
- **方案排序**：**A（现在做）→ B'（先 1–2 天 spike）→ B''（若 team 不适配且确有并行需求）→ C（不推荐）**。B 若做优先 B'（回退成本两行 YAML）。
- **三个关键待定项**：① 是否接受「主会话只当 Router、不再亲自执行」；② 是否真有并行多任务/多话题需求（唯一强必要性来源）；③ 是否引入 experimental 包（无稳定性承诺，且要改 `.spec/04` 排除清单）。

## 1. 逐项矩阵

矩阵一行为一个机制。原型列给可核验落点，Nokoribi 列给现有实现或规格位置。「差距」四态：已有 / 部分 / 缺失 / 不适用。「成本」按 §0 口径。

| # | super-agent 机制 | 原型落点（P 报告） | Nokoribi 现状 | 差距 | 成本（结构/版本/平台/运维/安全） | 前置条件 |
|---|---|---|---|---|---|---|
| 1 | Router 常驻主会话，只交互不执行 | `src/app/sessions.ts`、`src/app/runtime.ts:104,210`；主会话工具 restrict 见 `sessions.ts:263-264` | 主会话常驻已实现（`packages/agent-app/src/daemon.ts:384-456`；D08 单主会话 `.spec/05:7-9`），但兼职执行 | 部分（缺角色约束） | S/—/—/S/M（Router 持 bash 则退化） | 仅需提示词 + 工具 restrict；`agent-scoped tools.restrict` 已被 M4 验证（`.spec/10:56`） |
| 2 | Worker 隔离会话，每任务/话题一个 | `src/executor/dsh.ts:24-26,97-110`（`worker-<ticketId>` + 独立目录） | goal child 已提供同构生命周期：预留 `goal-<uuid>`、`startActivation`、冷恢复、归档（`packages/agent-app/src/goals/manager.ts:182-231,465-520`；`.spec/10:3-36`） | 部分（goal 仅长任务、对用户不可见、无直通/汇报规范） | M/M/—/S/M | Worker 生命周期管理 + 汇报通道 + 工具集装配（rc.3 无内联 preset，需 restrict/guard） |
| 3 | 角色工具集分层（Router 无 bash / Worker 全工具） | `cordis.patch.yml:20-193`（preset 内联工具清单） | 主会话隐藏 goal 工具已用 `tools.restrict` 实现（`.spec/10:56`）；全局子代理工具为连续子代理 | 部分 | S-M/M/—/—/S | 放弃原型的内联 preset；改写 restrict/guard + 全局 shell 配置 |
| 4 | 全双工异步（文章 4.1，start/stop + 完成回注） | `src/executor/background.ts`；preset 把 shell/job 等待压到 5s（`cordis.patch.yml:38-56,69-74`） | **基本已有**：`bash(host)` 支持 `run_in_background`（`packages/shell-bash/src/tool.ts:181-330`）、`job_output/list/kill` 与完成唤醒、`dsh-tool-subagent` 立即返回 `started subagent`（N 报告 §7） | 已有（无统一 start/stop 对） | S/S/—/—/— | 无。注：原文「已在 DSH 实现但默认未开启」与 rc.3 的对应关系**未确认**（N 报告 §10.1） |
| 5 | 事件过滤程序层（Fast Path） | `src/policy.ts:175-207`、`src/admission.ts:13-20` | allowlist/去重/命令/待应答分流已实现（`.spec/06:83,86-107`） | 已有（缺 Source scope 矩阵，因只有 2 类来源） | S/—/—/—/— | 无 |
| 6 | 事件过滤语义层（Slow Path，LLM 准入） | `prompts/admission.md` + `orchestrator_eval*`（`src/app/assessment.ts`） | **缺失**：reviewer 审的是工具动作，不是「事件是否值得响应」（`.spec/08:15-24`；N 报告 §3） | 缺失 | S-M/—/—/S/M（prompt injection 面） | 真实事件源；单用户 QQ 的入站本身就是人类指令，此层无对象可滤 |
| 7 | Thread 标识 + 订阅直通（多对多） | `src/core/intake.ts:33-58`、`src/sources/poll.ts:5-35`；语义见 `docs/001-domain.md:37` | **缺失**：代码无 thread 抽象（N 报告 §3；`grep thread packages/*/src` 无结果），仅 chatId 出站路由（`packages/channel-core/src/routing.ts:6-110`） | 缺失 | M/—/—/—/M | Worker 层 + 事件源；单用户单信道时价值最低 |
| 8 | Inline & Spill 上下文注入 | `src/executor/dsh.ts:113-128`（Trigger 600 字/assignment 1500 字截断 + read 指针） | 有 spill 基础设施（bundle 挂 `dsh-spill-local`/`dsh-spill-policy`）、memory 3000 字快照注入（`.spec/09:175-195`）、session 检索 | 部分（无统一对象截断/续读约定） | S/—/—/—/S | 无（可独立落地，见 A1） |
| 9 | 链式召回（引用图 + 多跳） | 原型无统一引用图，只有 `orchestrator_read`/`orchestrator_eval_read` 分页（P 报告 §2） | **部分**：`session_trace` 祖先链+后代树、5 个只读检索工具（`.spec/20:36`）；无 Trigger/Thread/Worker 对象 ID 图 | 部分 | M/—/—/—/S | 依赖 #7 的对象模型；否则只能做「会话图」 |
| 10 | 投机执行（提前行动） | **未实现**（全仓库无 speculative；`acceptMode: off/observe/auto` 只是准入审计） | 无 | 缺失/不适用 | L/L/—/M/M | Worker 层 + token 预算；文章 3.4 在原型中无代码，不能「照抄」 |
| 11 | 多信道（IM + 异步工作信道） | GitHub `src/sources/github.ts`、Feishu `src/sources/feishu.ts`（均绑 CLI 子进程） | `ChannelDriver` 契约 + outbox + 多 driver 路由已实现（`.spec/06:10-83`）；实际 driver 只有 local-test 与 QQ 官方 Bot | 部分（抽象有、信道少） | M-L/S/M（平台门禁）/M/S | 平台账号 + 真实验收（M8 14 项门禁未执行，`.spec/15`） |
| 12 | 计算与状态分离（5.1 云端无状态） | 未实现（`docs/006-deployment.md:5-19` 单机） | 单机 systemd + 单实例文件锁（`.spec/05:7-9`；`.spec/12:239-291`） | 不适用 | L/L/—/L/L | 共享会话存储与多进程写所有权；DSH 未提供，属于重写级 |
| 13 | 计算与执行环境分离（5.2 端侧 daemon） | 仅 seam（`src/app/execution-environment.ts:11-46`） | local/sandbox 双 host 已实现（`.spec/07`）；无远程环境 | 不适用（本机已够） | L/L/—/L/M | SSH host（后置未排期，`.spec/14:366-382`） |
| 14 | Watchdog（任务进展/偏航监督） | 外部脚本 + hourly 定时 agent（`scripts/dsh-superagent:219-241`、`docs/006-deployment.md:133-141`）；**无任务级判断**（grep watchdog 无代码命中） | systemd 存活 watchdog + sd_notify（`.spec/12:289,394`）、schedule 定时提醒、goal 状态可查 | 部分（缺语义级） | S-M/—/—/S/M | 无需新原语；schedule 已挂载（`.spec/10:157-168`） |
| 15 | 特征-连续（跨信道同一 Agent） | Router 单点 + 多源 | 单主会话最连续（所有 IM 进同一会话，`.spec/05:157-163`）；仅一个信道 | 已有（单信道） | 跨信道部分见 #11（L）；单信道见 #1（S） | 需要第二信道 |
| 16 | 特征-高效（不阻塞、并行） | 双层 + 异步工具 | steer/followup 非中断注入（`.spec/02:42-47`）+ goal 并发 + jobs | 部分 | 见 #2/#4（M） | B 方案 |
| 17 | 特征-主动（观察事件并推进） | Source 轮询/事件消费 | 只有 schedule 与 goal 续跑；**QQ 主动推送官方下线（D161）**，defer 到下次入站（`.spec/17:201-218`） | 不适用（平台硬约束） | L/—/L/—/— | 换成可主动触达的信道 |
| 18 | 特征-持久（在线+自愈） | tmux + 脚本 + hourly | systemd `Restart=on-failure` + resume + goal 冷恢复 + outbox 重发（`.spec/05:92-103`） | 已有 | —（A6 增强为 S-M） | 无 |
| 19 | 长程记忆（原文 8.1 开放问题） | **无实现**：`src/core/memory.ts` 是测试用内存 repo（P 报告 §5） | **强于原型**：memory pinned 注入（M16）+ session FTS5 检索（M11，`.spec/20`） | 已有（且超出） | S | 若要引用图，见 #9 |

**矩阵读数**：19 项中「已有/部分」11 项、「缺失」4 项、「不适用」3 项、「已超原型」1 项。原文五模块对 Nokoribi 不是「补课」，而是**在已有会话/注入/审批/持久底座上选择性加一层**；真缺口只有三处：Thread/直通对象模型（#7/#9）、语义级事件准入（#6）、多信道（#11），且三者都依赖「有更多事件源」这一前提。

## 2. 三个硬约束

### 2.1 DSH 版本与装配差

**已核实**：Nokoribi 全部 `@deepseek-ai/*` 固定 `0.2.1-rc.3`（`packages/bundle/package.json`；`README.md:7`；升级策略见 `.spec/04:228-241`），原型 peer 为 `^0.2.1-alpha.2`（P 报告 §0，`package.json:53-55`）。原型用到的服务端控制面（`ctx.agents.create/resume`、`agent.inject/steer/followup`、`permissionPresets`、`workspaceRegistry`、`ctx.subagents`、`ctx.goals`、`ctx.jobs`）在 rc.3 均已存在并在 Nokoribi 中使用（N 报告 §7；`packages/bundle/node_modules/@deepseek-ai/*` 共 72 包）。

**不可搬的两处装配面**（P 报告 §1/§4，已核实）：① Web：`src/index.ts:8` 注入 `webServer`、`src/app/http.ts:231` 要求 127.0.0.1 webserver，Nokoribi 明确不装 `dsh-client-*`/host webserver（`.spec/04:128-139`）；② preset：原型的 `cordis.patch.yml:20-27,125-132` 用 alpha 的 `@deepseek-ai/dsh-agent-preset` 内联角色工具集，rc.3 改为 preset registry/profile composition，Nokoribi 未挂 registry。因此「Worker 工具集与 5s 后台上限」必须改用代码级 `tools.restrict`/guard + 全局配置实现。

**rc.3 的新变量（本轮补充，已核实）**：完整发行闭包含 4 个 experimental Agent Team 包。`dsh-experimental-agent-team` 的 peer 依赖（`dsh-agent`/`dsh-llm`/`dsh-session`/`dsh-session-persistence`/`dsh-session-projection`/`dsh-subagent`，均 rc.3）**全部已在 Nokoribi 安装树中**；README 明确「experimental、requires durable session storage」「one process and one shared checkout」（agent-team README:12,203），Nokoribi 的 jsonl 持久化（`packages/bundle/cordis.patch.yml:26`）与单进程单 checkout 恰好满足。profile README:61 明确 UI Host 入口是 inert，**headless 不需要 web server**。故 B' 在版本/装配上**可行**：只需禁用 4 个 legacy 子代理行中的 `tool-subagent`/`tool-subagent-control`（tool README:12），并注意 `forkProvider` 所需 fork provider 当前未挂（Nokoribi 只挂 spawn provider）。

**未确认**：experimental 包能否进入 Nokoribi 的 `pnpm-lock.yaml` + `nix/deps.nix` FOD 闭包（M10 先例是 9 个 rc.3 依赖的整批更新，`.spec/14`）；team 子会话是否经过 vendored reviewer 的 approval waterfall；teammate 完成后是否自动向 Lead 投递完成通知（README 未写，需 spike）；rc.3 是否仍接受 bundle patch 内联 preset。

### 2.2 部署形态与 QQ 平台差

原型是「DSH Web profile + 面板 + 单仓库 GitHub/Feishu + 单机 SQLite」，Nokoribi 是「无 Web UI + QQ 官方 Bot + NixOS systemd 单机」。**不可复用**：面板与 `/orchestrator` 管理 API（P 报告 §4）、多信道来源（GitHub/Feishu 全绑 CLI 子进程）、以及依赖「主动推送」的完成通知/进展播报。

**可对齐的三点**：① 出站镜像天然只镜像 Router —— `daemon.ts:554-580` 的 `session/event` 监听按 `session.id !== this.mainSessionId` 过滤，Worker（teammate）的 turn 不会镜像到 QQ，这恰好就是「Worker 不直接与人交互」；② outbox 已有 at-least-once/退避/deferredNotices（`.spec/06:186-222`），原型的 receipt 语义（同 Ticket 保序、3 次失败升级、目标消失丢弃，P 报告 §3）可补进来；③ 审批 broker 串行 FIFO + approval 60s 拒绝（`.spec/05:130-138`）在多 Worker 并发下会变成「授权排长队 + 无人值守 fail closed」，这是 B 方案必须先回答的安全设计，不是实现细节。

**QQ 的物理约束（已核实于规格，真实平台门禁未执行）**：被动回复单聊 60 分钟/4 次、群 5 分钟/5 次；主动推送自 2025-04-21 下线，D161 用「active 尝试 + 失败 defer 到下次入站」兜底（`.spec/17:70-82,196-218`）。入站只处理 `C2C_MESSAGE_CREATE` 与 `GROUP_AT_MESSAGE_CREATE`，不接群全量消息（`.spec/17:62-64,295`）。**结论**：Worker 的完成汇报最多只能等 Router 下次被入站唤醒时转述；「主动播报」「实时进展」在 QQ-only 下不可承诺。原文 3.2 直通的价值来自「同一 Thread 的高频后续事件」，而 QQ 群只把被 @ 的消息送进来，事件流本身就稀疏——**直通机制在 Nokoribi 当前平台没有可优化的负载**。

### 2.3 单用户 vs 团队：价值与成本错配

原文双层架构的四份收益在 Nokoribi 的兑现率：

| 收益来源 | 单用户 QQ 场景兑现 | 依据 |
|---|---|---|
| 交互收敛（用户只面对一个 Agent） | 已兑现且更彻底（单主会话） | `.spec/05:157-163` |
| Router 批处理（积压 Trigger 合并） | ≈0：QQ 入站速率远低于原文压测的 1–40 条/分钟 | 原文 7.2；QQ 单用户日常消息量 |
| 上下文隔离（多任务互不污染） | **可兑现**，前提是用户确实并行推进多任务 | 需要用户确认（决策问题 2） |
| 订阅直通（Router 减负） | 低：群只收 @，无高频 Thread 事件流 | `.spec/17:295` |
| 多信道连续 | **不可兑现**：只有 QQ 一个信道 | 方案 A/B 都无法凭空造信道 |
| 团队协作/任务板 | 低：单用户单 checkout，无跨人写冲突 | agent-team README:203（shared checkout） |

**系统侧成本却是实打实的**：多会话带来 token 上升（原文 7.1：读缓存 token 高于单 Session；去掉直通后 Router 决策 +30%、token +37%）；Nokoribi 无 token 预算插件（`.spec/01` 非目标），只有 goal maxRounds 兜底；审批全局串行、memory 只注入主会话（M16，`.spec/09:213-226`）、session-query 按 `cwd` 全等授权（`.spec/20:58-64`）、goal 与 Worker 是两套 child 生命周期（`.spec/10` 冷恢复/归档语义不能直接套用）。**错配本质**：原文把「人的注意力上限 3–5 个 session」当作要消除的约束，而 Nokoribi 只有一个用户、一个 QQ、一天几条指令——把并发做重，收益是想象的，成本是运维、token、审批与安全的真实增加。单用户场景真正放大的需求只有两个：**长任务不打断主对话**（goal 已覆盖）与**多话题上下文不混**（Thread 化，可低成本做）。

## 3. 方案 A：只吸收设计思想（推荐先做）

A 不引入任何新架构/新依赖，全部落在现有包与规格上。

| 点 | 改哪里 | 收益 | 风险 | 成本 |
|---|---|---|---|---|
| A1 Inline & Spill 注入约定 | `packages/prompt/src/sections.ts`、`channel-core` 入站格式化、goal 报告模板 | 入站消息附「回复引用 + 前后各 N 条 + thread 摘要 + 长文截断续读指针」，减少反问与工具往返 | 注入变长挤占窗口；引用上下文是 prompt-injection 面 | S |
| A2 事件准入（语义层） | `packages/channel-core` ingress 新增可选判定钩子；只对「非用户显式指令」的事件生效 | 为将来接群聊/GitHub 打底；现在几乎无对象可滤 | 多一次 LLM 调用 = 延迟与成本；单用户场景价值接近 0 | S |
| A3 Thread 化 QQ 会话 | `channel-core` 入站加 thread 键（chatId + 话题/回复链），会话内分区；高价值话题可升级为 goal child | 同一用户多话题不互污；给 B 打基础 | 自动话题切分会切错；分区后 Router 需要话题索引 | M |
| A4 Router 化的 goal 并发（伪双层） | 主会话提示词改为「只交互、不执行长任务、一律 `start_goal`/派发」+ 主会话 `tools.restrict` 去掉 bash/写工具 | **零依赖**拿到双层架构 80% 的交互形态；立刻可试 | 文章 7.1 恰好证明「单 Session + subagent + 提示词」不稳定：中性提示 5/5 不委派，p95 29.5 分钟；只能当过过渡实验 | S-M |
| A5 outbox 可靠性强化 | `packages/channel-core/src/service.ts`、QQ driver | 借原型 receipt：同会话保序、幂等键、失败 3 次升级为系统问题、目标消失永久丢弃；补被动窗口过期分类 | 与现有 outbox 状态文件/兼容性；低 | S |
| A6 Watchdog 增强（任务级） | schedule 新增巡检任务 + 只读工具（goal 状态、`listChildren`、`session_trace`）+ 系统通知 | 填补「进程活着但任务空转/偏航」的盲区，是原文第 6 节里**唯一低成本可兑现**的部分 | 误报、巡检 token；需定义「无实质进展」判据 | S |
| A7 审批策略细化 | `packages/reviewer`（vendor）、`channel-core` broker | per-tool 授权、超时后 defer 而非终局 deny，为多 Worker 并发铺路 | 改 vendor 需同步 PATCHES/VERSION；安全审查重 | M |

A 的取舍：先做 **A6+A1+A3+A5**，A4 作为一周内可控实验，A2 待有第二事件源，A7 视是否做 B。

## 4. 方案 B：轻量双层（Router → Worker）

### 4.1 B'：复用上游 experimental Agent Team（不移植原型）

**最小实现范围**：bundle 增 2 行（`dsh-experimental-agent-team` + `dsh-experimental-tool-agent-team`），禁用 `tool-subagent`/`tool-subagent-control` 两行，不装 profile/client-ui 包；主会话提示词改为 Router 角色；Worker 工具集用 `tools.restrict` + guard 装配（补上 `dsh-subagent-fork-in-process` 或把 `forkProvider` 指向 `spawn` 以避免 fork 创建失败）；`/status` 增 team roster。**估算 3–6 天**（含 1–2 天 spike）。

| 维度 | B'（上游 experimental agent-team） | B''（自研轻量两层，借鉴原型领域模型） |
|---|---|---|
| 代码量 | ≈0（2 行 YAML + 提示词 + restrict） | 2–4k 行（会话路由、汇报、任务板、恢复、测试） |
| 实验性/稳定性 | 无稳定性承诺（agent-team README:202）；rc.3 契约随时可变；Nokoribi 固定版本 + 手动整批升级可对冲，但升级时要回归 team 契约 | 自控，但同样要维护 |
| 是否依赖 Web | **不依赖**：domain/tool 包只 peer `dsh-agent/session/subagent/...`；profile 的 UI Host inert（profile README:61）；只要不装 client-ui 包 | 不依赖 |
| 与单主会话/出站镜像冲突 | **不冲突且契合**：主会话就是 Lead/Router，出站镜像按 mainSessionId 过滤，Worker 天然不镜像（`daemon.ts:554-580`） | 同样契合（复用同一过滤） |
| 与 goal 体系冲突 | **冲突**：team child 与 goal child 是两套生命周期/冷恢复/所有权；需决定 goal 迁移、并存或禁用 team 的 task board | 可把 GoalManager 直接扩成 WorkerManager，冲突最小 |
| 与 memory/检索冲突 | memory 注入只主会话（M16），Worker 无注入，只能主动检索；session-query 按 cwd 全等，team 共享 cwd → Worker 会话可被检索（需验证索引归属） | 同 B'，但可自定义注入策略 |
| 与审批 broker 冲突 | **未确认**：teammate 是进程内 child，vendor 把 child 的 `never` 改成 deny→ask；是否真的走 broker、多个 Worker 是否排队，必须 spike | 可显式设计（如 Worker 只读工具免审、写动作回 Router 审批） |
| 对 QQ 被动回复影响 | Worker 完成汇报没有官方完成通知保证（README 未写），Router 需 `wait_agent`/`list_agents` 或自研完成桥；最坏情况汇报延迟到下次入站 | 可自行实现「完成 → Router inbox」的投递语义 |
| Nix bundle 接入 | 加 2–3 个 `@deepseek-ai/*` 依赖 → `pnpm-lock.yaml` + `nix/deps.nix` FOD 哈希 + module-eval 断言；与 M10 先例同构 | 无新依赖 |
| 测试与回退成本 | 回退 = 删 2 行恢复 2 行，历史 worker 会话文件留在 `DSH_HOME` 不影响；测试可走现有进程级 fake driver 场景 | 回退要删代码；测试要自建 |
| 规格冲突 | `.spec/04:136` 明确「`dsh-experimental-*`（除 vendor 的 auto-review）不安装」；B' 必须改规格 + 决策记录（D 编号） | 不违反该条（自研非 experimental 包），但仍是重大架构变更，需新 D |

**对 steer/followup 的影响**：用户消息仍只进主会话 → steer（忙）/followup（闲）语义不变；Worker 侧用 `send_message`（等价 steer 到最近 step 边界）或 `interrupt_agent`，不触碰 `agent.cancel` 默认清空 inbox 的语义，「非中断注入优先」原则保持（`.spec/01` 设计原则 4）。**对审批的影响**：Worker 的敏感动作会撞上全局 Auto preset 与串行 broker，60s 无人应答即拒——B 落地前必须先定义「Worker 可用的工具白名单」与「无人值守时的授权策略」，否则 Worker 会大面积 fail closed。

**分阶段里程碑建议（与 M18+ 对齐）**：
- **M18a / spike（1–2 天，不改主干）**：headless 挂 agent-team 两行，验证 roster/任务板/`send_message`/`wait_agent`、主会话出站镜像是否被 Worker 污染、审批是否经 broker、进程重启后 roster 恢复、`.spec/04` 依赖闭包能否构建。**产出 go/no-go**。
- **M18b / 落地（3–5 天）**：Router 角色提示词 + 工具 restrict + 完成汇报桥（若无原生完成通知）+ `/status` roster + 进程级测试（fake QQ driver）。规格新增 `.spec/26-router-worker.md` 与决策记录。
- **M18c / 验收**：进程级 4 场景（并行派发/汇报、审批不排队、重启恢复、outbox 被动过期 defer）+ 真实 QQ 门禁子集（审批按钮与多消息顺序）。不追 M9–M17 未完成的平台门禁。
- **M19（可选，M）**：Thread/订阅直通（A3 升级）+ Worker 订阅对象模型；**M20（可选，L）**：第二信道（可主动推送者优先），此时 B 的收益才真正兑现。

**验证方式**：沿用 `pnpm test:process` 的场景风格（构建后起真实 daemon + fake channel driver），加 token/轮次观测对照单会话基线；对 team 契约变化用固定 rc.3 版本锁 + 升级回归清单。

### 4.2 B''：自研轻量两层（不推荐优先，但保留）

基于 `packages/agent-app/src/goals/manager.ts` 扩展 WorkerManager：child 生命周期、汇报、冷恢复已有约 70% 可复用（`.spec/10`），补「话题→Worker 路由」「汇报→Router inbox」「Router 角色约束」即可。优点是**无 experimental 依赖、无工具面替换、与 goal 体系天然一致**；缺点是任务板/写范围/roster 要自研（单用户用不上 CAS 任务板——Lead 的上下文就是任务板）。若 B' spike 发现冲突太大，B'' 是退路，成本 M。

### 4.3 方案 C：整包移植原型（不推荐）

证据（P 报告，可核验）：src ≈15.2K 行（client 占 4.0K、27%），tests ≈15.0K 行；Web 硬依赖（`src/index.ts:8`、`src/app/http.ts:231`）；preset 装配基于 alpha 内联定义（`cordis.patch.yml:20-27`）；GitHub/Feishu 特化渗漏到 Outbox/links/resources/cards/Runtime/Executor/Assessor/Sessions/Setup（`docs/007-architecture.md:275-287` 自列）；616 行 schema 迁移 + 实验性 `node:sqlite`；执行侧硬编码 `danger-full-access`（`src/app/sessions.ts:152`）与单进程锁；测试全用 fake CLI/宿主。移植 = 删 Web + 换装配 + 重写 Source + 清 GitHub 耦合 + 重做部署，成本 ≥ 移植后重写，且与既有 goal/memory/审批/outbox 重复。**可行性最低，必要性也不成立**。

## 5. 两个独立结论与翻转条件

### 5.1 可行性结论

**分级**：A 类 **高**（无新依赖，S 级）；B' **中高**（闭包齐备、headless 可行，风险是 experimental 稳定性 + 审批/goal 冲突，需 spike）；B'' **中**（可控但工作量 M）；C **低**。模块级：双层 **中高**、事件驱动 **中**（平台限制）、面向人交互 **高**、计算状态分离 **不适用**、Watchdog **高**。

**翻转条件（可行性变高）**：DSH 升级到 experimental 转正/异步任务默认开启；Nokoribi 增加第二信道且支持主动触达；上游提供跨进程会话存储（存算分离才有意义）。
**翻转条件（可行性变低）**：rc.4+ 破坏 `ctx.subagents`/`tools.restrict`/approval waterfall 注入面；experimental 包契约变动且无替代；QQ 平台政策进一步收紧（如被动窗口缩短）。

### 5.2 必要性结论

**当前：偏低。** 判断依据：原文四特征中「连续」「持久」已满足，「高效」大半满足，「主动」被 QQ 封死；双层收益依赖多任务/多信源/多人，Nokoribi 是单用户单信道；文章 7.1/7.2 的实验是合成负载（约 300 条消息/20 个工作请求），且原型仓库**没有实验脚本**（P 报告 §2），数据不能外推到 Nokoribi。

**必要性变高的反转条件（任一）**：① 接入可主动推送的信道（邮件/Telegram/企业微信等）或 GitHub——事件源一旦存在，「过滤/路由/隔离」立刻从伪需求变成刚需；② 用户确认有并行多任务需求且当前上下文混杂已造成实际损失（如同时派发 3 个以上独立任务、主会话被长任务打断）；③ 接入群聊（多人、多话题、不可信输入）——准入与上下文隔离成为安全刚需；④ 用户接受为稳定性/响应时间增加 token 支出（原文 7.1 明说以更多 token 换更短更稳定）。
**必要性变低的反转条件**：① 用户实际只在 QQ 上做低频单任务；② 现有 goal `start_goal` 已能满足长任务隔离（当前就是）；③ 引入 experimental 包带来的升级回归成本超过收益。

## 6. 需要用户拍板的决策问题

1. **主会话角色**：是否接受「主会话 = Router，不再亲自执行长任务，长任务一律 goal/Worker」？（选否则 B 不成立，只能走 A）
2. **并行需求**：未来 3–6 个月是否真的会「同一个人同时推进多个独立任务、且不能互相污染上下文」？（唯一强必要性来源）
3. **信道路线**：是否计划接第二信道（优先支持主动推送的）/GitHub/群聊？谁提供账号与门禁工时？（决定 A 与 B 的先后顺序）
4. **experimental 依赖**：是否允许引入 `dsh-experimental-agent-team`（无稳定性承诺、需改 `.spec/04` 排除清单、替换 legacy 子代理工具面）？还是坚持「不装 experimental」只走 A + B''？
5. **无人值守授权**：Worker 敏感动作是「只读免审 / Router 转述 / broker 排队」哪种？审批 60s 超时是否允许 defer 到下次入站？
6. **进度可见性**：用户是否需要看 Worker 进度/任务板？（QQ 侧只能文本/按钮，Web 明确不做）若不需要，B' 可不装任何 UI，任务板可裁剪。
7. **token 预算**：是否接受双层带来的 token 上升（文章观测 +37% Router 读缓存量）作为换取稳定性/响应时间的代价？
8. **记忆/召回策略**：先复用现有 memory + session-query（S），还是投入文章式引用图/链式召回（M，且依赖 Thread 对象模型）？

## 7. 未确认清单

1. experimental 包在 Nokoribi 的 `pnpm-lock.yaml` + `nix/deps.nix` FOD 闭包中能否解析构建（**未做 spike**）。
2. teammate 完成后是否自动向 Lead 投递完成通知；`wait_agent`/`list_agents` 是否足以支撑「汇报」语义（agent-team README 未写）。
3. team 子会话的敏感工具调用是否经过 Nokoribi vendored reviewer 的 approval waterfall、是否与 broker 串行/60s 超时正确交互。
4. team child 与 goal child 共存时，GoalManager 冷恢复与 team roster 恢复的时序是否安全。
5. session-query FTS 索引是否覆盖 team/worker 会话并保持 `cwd` 授权语义。
6. rc.3 升级到后续版本时 `tools.restrict`/`spawnTerminal`/approval 注入面是否变化（见 `.spec/04:228-241` 回归清单）。
7. 原文 7.1/7.2 实验数据无法用仓库复现（无实验脚本），只能作为方向性参考。
8. QQ 真实平台门禁（M8 14 项、M9 #15–#20、M11–M17 V16–V22）均未执行，B 的 QQ 侧行为验证仍要排在它们之后。

> 关键外部路径（供复核）：`$PACQUET/@deepseek-ai+dsh-experimental-agent-team@0.2.1-rc.3_*/node_modules/@deepseek-ai/dsh-experimental-agent-team/README.md:12,202-203`；`.../dsh-experimental-agent-team-profile/README.md:12,61`；`.../dsh-experimental-tool-agent-team/README.md:12,28,48`。`$PACQUET` = `/home/allenyou/.cache/pnpm/dlx/3c27ef3f7e5aeb6f0186aa5b40b76c6e/mvvc95fi-3mh/node_modules/.pacquet/`。
