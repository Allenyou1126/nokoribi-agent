# dsh-superagent-prototype 实现级分析（面向 Nokoribi 落地）

> 分析对象：`.research/dsh-superagent-prototype/`（commit `6337fc8`，单次导入）。对照基准：`.research/zhihu-article.md`。
> 方法：只读代码/文档，未运行其测试或构建（无 node_modules）。所有结论给出 `文件:行`；无法确认处标「未确认」。

## 0. 结论速览

- **形态**：一个 DSH bundle = 1 个 server 插件（主入口）+ 1 个 Web client 插件 + 2 个 Source 插件入口（GitHub、Feishu）；`src` 约 15.2K 行 TS/TSX（其中 `src/client` 4.0K 行，约占 27%），`tests` 59 个 spec / 约 15.0K 行。`engines.dsh` 为 `^0.2.1-alpha.2`（`package.json:53-55`），与 Nokoribi 固定的 rc.3 存在 alpha→rc 代差。
- **文章五模块覆盖度**：双层架构＝完整实现；事件驱动＝主体实现（3.1/3.2 完整，3.3 简化，3.4 投机执行未实现）；面向人交互＝语义成立但机制换成 DSH jobs/inbox（不是 start/stop 工具原语），多信道只有 2 个源；计算/状态/环境分离＝未实现（单机）；Watchdog＝基础设施级简化实现（没有文章式的「判断 Worker 进展」的 Watchdog Session）。
- **最重要的 3 个可复用机制**：① `src/core` 的 Engine 领域内核（单一写者 + 事务 + 五部件单向依赖）；② 程序门 + LLM 语义两层准入与 Mandate/Policy 版本再校验；③ SQLite 持久 Effects 队列 + Outbox receipt 的可靠投递层。
- **三个直接搬不走的障碍**：① Web 面板与 management HTTP：server 端也硬依赖 `webServer`（`src/index.ts:8`、`src/app/http.ts:231`），client 插件需要 `dsh-client-ui-*` 宿主；② 装配方式：`cordis.patch.yml` 用 alpha 的 `@deepseek-ai/dsh-agent-preset` 内联 preset 定义角色工具集与 5s shell 上限，rc.3 改为 preset registry/profile composition，Nokoribi 未挂 preset registry；③ 单仓库 GitHub 场景写死：repository/agent 账号/worktree/PR 生命周期/`gh` 包装脚本贯穿 Runtime、Executor、Assessor、Outbox。

## 1. 定位与装配方式

README 自述是研究原型、可能含 bug、风格与工程实践可能不一致，且明确「文章里有些设计是未来方向，本原型未实现」（`README.md:3-5`）；定位是「面向一个 GitHub 仓库、可选 Feishu、带 Web 面板」（`README.md:7`）。装配有两层：

- **bundle 层**：`package.json:30-45` 声明 `dsh.bundle.patch=./cordis.patch.yml` 与 `dsh.client`（`platform: web` + 注入 6 个 `@deepseek-ai/dsh-client-ui-*`）。`cordis.patch.yml:4-19` 插入主插件、`dsh-superagent/github-watch`、`dsh-superagent/feishu-watch`（默认 disabled）；`:20-27` 与 `:125-132` 分别定义 worker/router 两个 agent preset，preset 内联完整工具清单，并用 `timeoutMs: 5000`、`maxTimeoutMs: 5000`、`tool-jobs.waitTimeoutMs: 5000` 实现「前台命令 5 秒转后台」（`:38-56`、`:69-74`）。
- **构建层**：`tsdown.config.ts` 双段构建——node ESM 服务端 + browser CJS client bundle，后者用 `window.__ModuleLoader__.load(...)` banner 注入宿主。

版本差是本报告的关键背景：原型依赖 `@deepseek-ai/dsh-agent-preset`、`dsh-host-webserver`、`dsh-client-ui-*` 等 alpha 包；而 Nokoribi 的 rc.3 依赖树里**不存在** `dsh-host-webserver` 与 `dsh-client-ui-*`，`agent-preset` 已变成 `@deepseek-ai/dsh-agent-preset-registry`（声明式 composition / Loader 树）。反过来，rc.3 已具备原型用到的多数服务端服务：`sessionController.create/resolveAgent/rename/modelCatalog`、`agent.inject/steer/followup`、`permissionPresets.set`、`workspaceRegistry.create`、`settings.configure` 均可在 Nokoribi 安装树中核实存在。因此**服务端 agent 控制面大体可移植，Web 与 preset 装配面不可移植**。

## 2. 对照文章五模块

| 文章模块 | 判定 | 主要落点 |
| --- | --- | --- |
| 2 双层架构 | 已实现 | `src/app/sessions.ts`、`src/executor/dsh.ts`、`cordis.patch.yml:20-193` |
| 3.1 两级过滤 | 已实现 | `src/policy.ts:175-207`、`src/admission.ts:13-20`、`src/app/assessment.ts`、`prompts/admission.md` |
| 3.2 订阅直通/多对多 | 已实现 | `src/core/intake.ts:33-58`、`src/sources/poll.ts:5-35`、`docs/001-domain.md:37` |
| 3.3 Inline & Spill / 链式召回 | 简化实现 | `src/executor/dsh.ts:113-128`、`src/app/resources.ts` |
| 3.4 投机执行 | 未实现 | 仅 `acceptMode: off/observe/auto`（`src/policy.ts:84`、`:57`） |
| 4.1 全双工异步 | 实现但机制不同 | `src/executor/background.ts`、`src/app/delivery.ts:60-77`、preset 的 5s 上限 |
| 4.2 多信道 | 部分实现（2 个源） | `src/sources/github*`、`src/sources/feishu*`、`src/app/outbox.ts` |
| 5 计算/状态/环境分离 | 未实现（仅留 seam） | `src/app/execution-environment.ts`、`docs/006-deployment.md:5-19` |
| 6 Watchdog | 简化实现 | `scripts/dsh-superagent`、`docs/006-deployment.md:133-141` |
| 7 实验（消融/批处理） | 未随仓库提供 | 无实验脚本或数据 |

**2.1 双层架构**：Router 是常驻主 Session（`masterId` 持久化在 `KV.runtime.masterId`，`src/app/runtime.ts:104,210`），模型取 `settings.eval.model`；Worker 是每 Ticket 一个 DSH Session `worker-<ticketId>`（`src/executor/dsh.ts:24-26`）与独立目录（`dsh.ts:97-110`；`docs/003-execution.md:25`），模型取 `settings.executor.model`。角色模型只注入到新建 Session、不改全局默认（`src/app/role-models.ts:15-43`）——这是可复用的细节。工具分层既靠 preset，也在代码里二次收紧：主 Session `tools.restrict({allow: ['skill','bash','read','read_image','job_output','job_list','job_kill']})` 并加 no-wait guard（`src/app/sessions.ts:263-264`、`:63-86`），Worker 只保留 20 个工作工具、Ticket 结束即拒绝（`sessions.ts:61-62,289-297`）。偏差：文章说 Worker 不直接与人类交互，但 Worker 的 `orchestrator_ack` 会直接回原信道（`src/app/tools/executor.ts:29-40`），结果类消息才经 Router relay。

**3.1 两级过滤**：程序层由 Source scope + admission 矩阵 + Policy gate 组成（`src/policy.ts:175-207`；admission 默认值 `src/admission.ts:13-20`；Feishu 的 `scope()` 见 `src/sources/feishu.ts:55-58`）；语义层是主 Session 用 `orchestrator_eval`/`orchestrator_eval_read`/`orchestrator_eval_decide` 按 `prompts/admission.md` 做研判，MasterAssessor 负责投递候选卡与记录结果（`src/app/assessment.ts:89-`）。`acceptMode` 三态（off/observe/auto）与 observe 的 `would_accept` 审计（`src/policy.ts:57,84`）比文章更细，可作为 Nokoribi 的现成策略骨架。

**3.2 订阅直通**：`Intake.receive` 在事务内把 Trigger 保存、写 Thread 关联、扇出到订阅 Ticket 的 Inputs，仅当没有 Ticket 的 worker 认领时才进 Eval（`src/core/intake.ts:33-58`）；Source 对订阅 Thread 做轮询（`src/sources/poll.ts:5-35`，14 天 horizon）；多对多与「人消息 resume、bot/CI 不 resume、handback 回收」规则完备（`docs/001-domain.md:37`、`src/core/engine.ts:227-229`）。这是与 QQ IM 场景最相关、也最值得裁掉 GitHub/PR 特化后保留的部分。

**3.3 Inline & Spill**：原型用「截断 + read 指针」实现：Trigger 文本 600 字、assignment 1500 字截断并给 `read` 资源路径（`src/executor/dsh.ts:113-128`），评估窗口取 thread 首 5 条与 trigger 前后各 5 条、长文截断保留字数与 stub（`prompts/admission.md`），另有 `orchestrator_read`/`orchestrator_eval_read` 分页读取。**没有**文章式的统一引用图与链式召回引擎，故判「简化实现」。

**3.4 投机执行**：全仓库无 speculative/预执行相关实现（`grep` 仅 `observe` 命中），"静默复现并修复" 只能由 `auto` + 规则表达；文章 3.4 在原型中**未实现**。

**4.1 全双工**：原型的异步不是把工具改成 `start()/stop()`，而是把 DSH 的 jobs/subagents + Session inbox 用起来：preset 把 shell 与 job wait 上限压到 5 秒（`cordis.patch.yml:38-56,69-74`），`src/executor/background.ts` 用 `ctx.jobs`/`ctx.subagents` 判定 turn 结束后是否仍有后台工作、30 分钟上限后杀 job、Assignment 结束时清场（`docs/003-execution.md:31-47`）；新消息以 `inject`（不唤醒的通知）/`steer`/`followup` 幂等投递（`src/app/delivery.ts:20-33,60-77`），消息 ID 用 `requestId` 保证跨重启不重复。这套语义与文章一致，但依赖的是 DSH 的异步 job/inbox 原语而非文章提到的 start/stop 工具；移植时要按 rc.3 原语重新验证。

**4.2 多信道**：GitHub（notifications/订阅 Issue/PR/CI/合并关闭，`src/sources/github.ts`）与 Feishu（live event consumer + 历史补收 + 订阅轮询，`src/sources/feishu.ts`、`src/sources/feishu-loops.ts:42-`）两个 Source；Channel 写侧统一经 Outbox。IM 约束已落到提示词/工具层（`IM_WORDS` 限制见 `src/app/tools/executor.ts:33`；Feishu 回复长度校验 `src/app/outbox.ts:35`）。但两个源都绑定 CLI 子进程（`gh`/`lark-cli`），没有 SDK 化抽象。

**5. 计算/状态/环境分离**：未实现。部署形态是「一个 DSH profile 进程（tmux）+ 本机 SQLite + 本地 worktree + 操作者 OS 用户」（`docs/006-deployment.md:5-19`、`docs/003-execution.md:27`），`SETUP.md:49-50` 直接问本地 clone。只有 seam：执行环境变量注册表与 prepare command（`src/app/execution-environment.ts:11-46`）。`docs/007-architecture.md:614-618` 的 open questions 也承认部署隔离未解决。文章 5.1/5.2 的云容器与端侧 daemon 均无代码。

**6. Watchdog**：外部控制回路是「操作者自己 profile 里的 hourly 定时 agent + `scripts/dsh-superagent status/restart`」（`docs/006-deployment.md:133-141`；脚本 `--respect-stop` 见 `scripts/dsh-superagent:219-241`），脚本读 management API 的 `/orchestrator/api/state`（`scripts/dsh-superagent:81-95`）并按 0/1/2/3 退出码分流。进程内只有 HealthBoard 单写者健康（`src/infra/health.ts:13-31`）与 Effects 连续 3 次失败才报错（`src/app/effects.ts:7`）。**没有**文章 6 的「判断 Worker 是否有实质进展、方向是否偏离」的 Watchdog Session（`grep watchdog` 无代码命中），只有「LLM 会话读日志并重启」的基础设施级恢复。

## 3. 复用时最关键的机制

- **Engine 领域内核**：`src/core` 不 import app，全部命令同步 + 每命令一个事务，端口在事务内入队副作用、提交后由适配器执行（`src/core/engine.ts:19-38,261-270`；依赖规则 `docs/007-architecture.md:255-287` 明确「单一写者」「请求/事实命名」「core 不做 I/O」）。这是最干净、最可搬的部分。
- **持久化**：`node:sqlite` 的 `DatabaseSync`（`src/app/store.ts:2,56-60`），schema 10→11 自动迁移（`store.ts:56,89`；`src/app/migration.ts` 616 行）；`KV` 把每个键族与类型、属主集中声明（`src/kv.ts:21-57`）；stateDir 用 `proper-lockfile` 防并发（`src/app/runtime.ts:91-95`）。Nokoribi 已有 storage/session-query 栈，可替换而非照搬。
- **Effects 队列 + Outbox**：SQLite 副作用表（kind/key/seq/due/attempts），支持 ordered、并发上限、指数退避、健康上报（`src/app/effects.ts:13-80`）；Outbox 用 receipt 保证幂等与「同 Ticket 同会话保序」，3 次失败升级为系统问题、目标消失则永久丢弃（`src/app/outbox.ts:25-56`）。对 QQ 被动回复（过期/频控/不可达）非常有参考价值——把「被动窗口过期」表达成 channel 返回 `gone` 即可。
- **Source/Channel 契约**：`SourceContext` 是窄接口（`src/sources/host.ts:41-83`），Source 只能经 `receive/threads/tickets/notify/report` 与系统交互；`docs/008-cookbook.md:1-15,86-200` 用一个虚构 `hookq` CLI 演示新增 SourceKind，说明契约可扩展。这是把 QQ 官方 Bot 接进来的正确挂载点。
- **权限边界**：程序层（scope + admission + gate）与语义层（提示词）两层，且提示词反复声明「外部文本/引用不可改策略」（`prompts/orchestrator.md`、`prompts/admission.md`、`prompts/subscriptions.md`）；但执行侧是 `danger-full-access`、以操作者 OS 用户运行、无凭据隔离（`docs/003-execution.md:80`、`docs/006-deployment.md:13-19`）。

## 4. 依赖分层与可移植性

**核心 agent loop 必需**（`package.json:58-86` 的服务端依赖）：`dsh-agent`、`dsh-session(-persistence)`、`dsh-api-session-controller`、`dsh-tools`、`dsh-system-prompt`、`dsh-skill`、`dsh-llm`、`dsh-scope`、`dsh-workspace`、`dsh-permission-presets`、`dsh-subprocess`、`cordis`。**只有 Web 面板/管理面需要**：`dsh-host-webserver`、`dsh-client-ui-*`、`react`/`react-dom`/`jsdom`，以及代码侧的 `src/client/*`（4.0K 行）、`src/app/http.ts`（247 行）、`src/app/views/*`、`src/app/tools/main.ts` 中的 settings/prompts 保存工具。

硬边界证据：`src/index.ts:8` 的 `inject` 包含 `webServer`；`src/app/http.ts:231-235` 要求 `ctx.webServer.host === '127.0.0.1'` 并注册 `/orchestrator` 前缀路由；`src/client/index.tsx:48` 注入 `['slots','locale','sessions','uiWorkspace']`。Nokoribi 的 bundle 未挂 webserver、未安装 `dsh-client-ui-*`，因此**服务端管理 API 与面板都必须整体替换为 QQ 侧入口（审批按钮/命令/文本）**，不能只删 client。

版本迁移要点：服务端 API 大多已在 rc.3 存在（见 §1），需要改的是 ① preset 定义方式（bundle patch 内联 preset → rc.3 的 registry/profile composition，或干脆改为代码内 restrict/guard + 全局 shell 配置）；② 去掉 `webServer`/client 注入；③ `settings.configure({auto:false})` 与 `describe()` 这类 alpha 行为 workaround（`src/index.ts:13-20`）在 rc.3 需重新验证。**未确认**：rc.3 是否仍接受 bundle patch 里的内联 preset 行；`systemPrompt.section({complete})`、`tools.restrict/guard`、skill scope 在 rc.3 的签名是否逐一对齐（未做类型检查）。

## 5. 质量与可观察的工程债

正面：测试规模大（59 spec / 约 15.0K 行，≈源码 1:1），有模拟 DSH 宿主（`tests/fixtures/host.ts`）、管理 API 假件（`tests/fixtures/panel-server.ts`）；还有把文档与代码绑定的元测试（`tests/docs.spec.ts` 校验模块/测试表与文档链接，`tests/class-docs.spec.ts` 要求每个类有 JSDoc，`tests/model-surface.spec.ts` 校验模型可见面大小预算）；依赖方向与「单一写者」有明文规则并被文档化（`docs/007-architecture.md:255-287`）。

债：① README 自述研究代码（`README.md:3`）；② 仅 1 处 TODO（`src/index.ts:17`），但 alpha API workaround 直接写在主路径（`src/app/sessions.ts:270-282` 对 preset registry 两代 API 的 fallback）；③ 7 处静默 `catch`；④ 616 行迁移 + 大量 legacy 兼容（`src/app/migration.ts`）说明 schema 迭代成本高；⑤ 使用实验性 `node:sqlite`（`src/app/store.ts:2`），对 Node 版本敏感；⑥ Source 特化渗漏到通用模块——`docs/007-architecture.md:275-287` 自列 Outbox/links/resources/cards/Runtime/Executor/Assessor/Sessions/Setup 对 GitHub、Feishu 的直接依赖，这是「加 QQ 源」时必须先清理的耦合；⑦ 无真实平台端到端测试：测试全用 fake CLI/宿主，真实账号验证放在 `docs/006-deployment.md:29-49` 的人工步骤；⑧ 单进程假设（stateDir 锁）且 `danger-full-access` 是硬编码默认（`src/app/sessions.ts:152`）。另：`src/core/memory.ts` 是测试用内存 repo，不是长期记忆；文章 8.1 的长程记忆在原型里没有对应实现。

## 6. 移植到 Nokoribi bundle 的清单

**直接复用（改 import/版本即可）**：`src/core/*`（model/engine/tickets/evals/assignments/replies/intake/stage/ports/part/errors/reasons/ids）；`src/policy.ts`、`src/admission.ts`、`src/kv.ts`（键族裁剪）；`src/app/effects.ts`、`outbox.ts`、`store.ts`（或换 Nokoribi storage）、`retry-health.ts`；`src/executor/background.ts`；`prompts/{orchestrator,worker,admission,dispatch,replies,work,subscriptions,handoff,shared}.md` 与 `prompts/team/*`；`src/app/delivery.ts`；`src/app/sessions.ts` 的装饰逻辑。

**必须改造**：`src/index.ts`（去 webServer/settings 注入，接 Nokoribi bundle 装配）；`src/app/runtime.ts`（去 registerHttp/stateDir/`orchestrator-` 命名，定「单 Router 或单 Session」）；`src/deployment.ts`、`src/setup.ts`（panel 配置与 GitHub/Feishu 账号探测 → Nix 选项 + QQ AppID/Secret 校验）；`src/executor/dsh.ts`（去 PR binding/claim、worktree 命名、GitHub relay 文案；5s/30min/slot 常数改配置）；`cordis.patch.yml`（preset → rc.3 profile composition 或代码 restrict/guard）。

**删除**：`src/app/http.ts`、`src/app/views/*`、`src/client/*`、locale、`src/app/tools/main.ts` 中依赖 panel 的 settings/prompts 工具、`tests/panel-*.spec.tsx`。

**以 Feishu 为模板重写**：`src/sources/feishu*` → QQ 官方 Bot Source/Channel（CLI→官方 `@tencent-connect/qqbot-nodejs` 协议，live consumer→Nokoribi `channel-core` 事件，另需被动回复过期、审批/提问按钮、C2C 媒体等 Nokoribi 已有能力）；`src/sources/github*` 整体删除或裁成「只读上下文源」。

**新增**：`systemd` 自恢复（替代 tmux+Python 脚本+hourly prompt）；无 Web 的健康观测（状态文件/命令/日志）；单用户 admission 简化；长程记忆（Nokoribi 已有 memory/session-query，原型无对应）。

## 7. 未确认与建议 Lead 在讨论稿中回答的问题

**未确认**：① 文章 7.1/7.2 的实验数据与仓库代码无法对应（仓库无实验脚本），只能按代码判「实现了什么」，不能复核实验；② rc.3 对内联 preset 行的兼容性；③ rc.3 中 `jobs`/`subagents`/`inbox` 原语与原型写法是否逐一对齐；④ 「Feishu Source」与 Nokoribi `channel-core` 的抽象重合度（本次未核对 Nokoribi channel-core 代码）；⑤ Watchdog 是否算「实现」有争议（我按代码判为基础设施级简化实现）。

**建议 Lead 必须回答**：① Nokoribi 到底要不要「双层」——单用户 QQ 场景下，是保留 Router+Worker 两 Session，还是单 Session + 异步任务 + 审批按钮足够？若保留，rc.3 无 preset registry，角色工具集与 5s 后台上限如何装配？② 事件驱动模型在「QQ 被动回复、无主动推送」约束下应保留多少——Thread/Subscription/订阅直通的价值主要来自多信源与多人协作，单用户单信道时是否只保留 admission/Ticket/Outbox 三件套？③ Watchdog 的目标形态：systemd 自恢复 + 定时 LLM 检查（Nokoribi 已有 schedule）是否足够，还是需要文章式「判断 Worker 进展并介入」的外部 Agent Session（成本与可观测性代价）？
