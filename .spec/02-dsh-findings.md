# 02 DSH 调研事实

本文件记录规划阶段对 DeepSeek Harness（DSH）的调研结论。内容来自本机已安装包的 README 与编译产物（`~/.dsh/profiles/node_modules/@deepseek-ai/*`、CLI 的 dlx 安装），不是 DSH 源码。实现目标版本为 `0.2.1-rc.3`，实际行为要在实现时对锁定版本再核对。

## 2.1 组合系统：精简可以不 fork

DSH 的运行组合单位是 **profile → bundle → patch 层**：

- `profile` 位于 `$DSH_HOME/profiles/<name>`，由 `package.json` 的 `dsh.profile.bundles`、profile 自己的 `cordis.patch.yml` 与 `patchReload` 组成。
- `bundle` 是发布包，`package.json` 里 `dsh.bundle.patch` 指向它携带的 patch YAML。
- patch 是扁平的 loader patch 条目数组：可以按 id 覆盖配置、禁用行（`disabled: true`）、插入新行；插入的插件名可以是包标识符、绝对路径或文件 URL；`!!js` 表达式在启动时求值。
- 用户自己的 patch 层在 bundle 层之后应用（先 profile 文件，再 home 级文件）。

调研到的组合规模：

| 组合 | 插件行数 |
|---|---|
| `@deepseek-ai/dsh-sdk-minimal`（完整独立树，不基于 base） | 31 |
| `@deepseek-ai/dsh-base` | 84 |
| `@deepseek-ai/dsh-web-app` | 68（其中大量是 Web/UI 客户端与 host API 行） |

因此"精简"可以用"自定义 bundle 的完整插件树"实现：只列需要的行，不安装 Web/UI/Windows/ACP/hooks/实验 bundle。**运行时精简**成立。

安装体积方面：

- `@deepseek-ai/dsh`（官方 CLI）直接依赖 86 个包，完整安装闭包约 250–300 个 `@deepseek-ai/*` 包（含 `dsh-web-app`、各种 `dsh-experimental-*`、client UI 等）。即使换成精简 profile，只要仍用官方 `dsh` 启动器，这些依赖仍会被安装。
- 要做到安装物也精简，需要一个**薄启动器**。调研确认官方 `@deepseek-ai/dsh/profile-boot` 是导出可复用的，其编译产物约 16KB，静态依赖只有：
  - `@deepseek-ai/dsh-app-boot`
  - `@deepseek-ai/dsh-cmdline`
  - `@deepseek-ai/dsh-home-paths`
  - `@deepseek-ai/dsh-http-proxy`
  - `@deepseek-ai/dsh-launch-environment`
  - node 内置模块
- 因此可以 vendor 这段启动逻辑（MIT），不依赖 `@deepseek-ai/dsh` 本体。

`@deepseek-ai/dsh-app-boot` 提供 `installFailLoud` 与 `boot` 等启动入口；它负责加载环境层、组合 profile、启动插件、返回运行中的应用。官方建议"产品功能放到 profile bundle，而不是新增 app bin"——本项目的薄启动器只承担发行层职责，功能都放在 bundle 与插件里。

## 2.2 Agent Loop 原语与事件

`@deepseek-ai/dsh-agent` 提供 `ctx.agents` 与 `Agent` 句柄。关键方法：

- `followup(message)`：排队一条普通的"下一轮"输入，并唤醒驱动器；空闲时开始新一轮。
- `steer(message)`：提交到下一步输入；忙碌时在最近安全 step 边界被领取，空闲时也会唤醒驱动器。
- `inject(message)`：添加面向模型的上下文但不唤醒驱动器，因此落在下一个被接纳的步骤中；空闲时会等待其他唤醒。
- `cancel(cause, options?)`：中止当前活动，默认清空待处理 inbox；`{ keepInbox: true }` 保留待处理项。
- `whenIdle()`：等待整个 agent 完全停稳。
- `send(message, target, wakeup)`：底层带 target/wakeup 的发送；公开封装更常用。

Inbox：

- `Agent.inbox` 暴露待处理的 `nextTurn` / `nextStep` 消息，支持 append/prepend/replace/remove/clear/splice。
- inbox 变更会持久写为 `agent/inbox/spliced` 事件，属于会话投影，重启恢复后可重建；因此**排队中的消息不是纯内存态**。
- 在步骤边界，循环通过纯删除 splice 领取待处理输入；领取后插入的消息等待后续边界。

`agent/*` 事件（用于观察/拦截）：

- `agent/pre-step`：可拒绝拟进入的步骤或替换进入它的消息批次。
- `agent/request-error`：可重试失败的模型请求。
- `agent/turn-stopping`：轮次关闭前运行，可通过 steer 保持打开。
- `agent/assistant-stream`：进程本地有序 start/chunk/end frame；loop 在 committed end 前会把完整紧凑 stream 提交为 `assistant/message` / `assistant/attempt`。
- `agent/status`、`agent/created`、`agent/disposed`、逐消息的 `agent/inbox/*`。
- `agent/session-start`：会话开始边界（恢复、分叉等都会触发）。
- 发起方作用域：`ctx.agents.withInitiator(agent, ...)`；身份归因只在进程内，跨进程必须显式传递。

限制：没有内置轮次预算；工具调用或 steering 会延长轮次，限制只能从已有生命周期扩展点（如 `agent/turn-stopping`）取消。

## 2.3 会话、持久化与恢复

`@deepseek-ai/dsh-session` 是事件溯源的只追加会话日志；持久化由 `@deepseek-ai/dsh-session-persistence-jsonl` 等后端叠加。

- `ctx.agents.create()` / `ctx.agents.resume()` 由 agent-loop 的工厂创建/恢复 agent；`resume` 会先取得写所有权，读取有效日志。
- 对"轮次中途崩溃"的日志，loop 会追加 `interruptedTurnClosers` 作为普通批次，做语义崩溃修复；恢复后 agent 可以继续。
- 持久化句柄通过 `session/event`、`session/flush`、`session/disposed` 路由；teardown 时先关闭写路径再 detach。
- `dsh-session-projection` 提供投影注册表；`dsh-session-projection-cache` 写 checkpoint；`dsh-session-query-sqlite` 提供元数据查询（未在本项目挂载）。
- 恢复与分叉会保留历史；compaction 只隐藏旧节点，不删除日志。

## 2.4 子代理（Subagent）

`@deepseek-ai/dsh-subagent` 是能力 seam，支持一次性和可继续（continuable）子代理。

- 可继续子代理：保留持久 Session，同一时刻至多一个进程内 Activation；调用方拿到稳定 child id，可 `sendMessage()` 继续对话、`interrupt()` 中断当前轮而不销毁。
- 冷恢复：**只有父 Agent 用 `sendMessage()` 给 absent 的 direct child 发消息时会从持久化会话冷恢复**；没有"静默恢复"公开 API。
- `report` 工具（`dsh-tool-subagent-report`）：子代理→父代理的返回通道，默认用 `parent.steer()` 投递；父级必须在注册表中在线；不会自动结束轮次；支持 `quiet`（`inject`）部署策略。
- 限制：
  - child→parent 投递要求直接 parent 在线；没有持久 parent mailbox。
  - 驻留 Activation 只在进程内；两个 harness 进程不能共享同一持久存储（需要持久邮箱/租约协议，未提供）。
  - 崩溃可能丢失"已被接受但尚未写入子会话日志"的消息，不会自动回放。
  - ACP 子代理仍为一次性，无法通过追踪枚举。
- 发现：`ctx.subagents.listChildren(parentSessionId)`、`listDescendants(rootSessionId)` 可以只读在线会话存储与持久化、不加载子代理；`drainContinuableChildren(parent, childIds)` 可释放驻留子代理，`drainContinuableDescendants(parents)` 用于 teardown。

## 2.5 Goal

`@deepseek-ai/dsh-goal` 是每会话一个的持久目标服务，状态由会话日志事件溯源。

- 生命周期 phase：`active` / `paused` / `blocked` / `complete`；进程本地 `activation`：`armed` / `disarmed`。
- 每会话至多一个当前 goal；未完成的 goal 必须先 edit/pause/resume/block/clear 才能被替换。
- **续行启用状态不持久化**：任何 `agent/session-start` 边界都会 disarm，即使回放发现 phase 为 active；需要 `ctx.goals.resume(agent, ref)` 显式重新 arm（也用于会话恢复/分叉后重新启用）。
- `@deepseek-ai/dsh-goal-round-driver`：对 `ctx.agents.list()` 中的 live agent 生效，按 agent 读 `ctx.goals`；agent 空闲、续行 armed、且轮次额度有剩余时，自动 `followup` 一条 goal round prompt。它会响应 `agent/created`、`agent/status`、`goal/changed`、inbox 事件等。
- `/goal` 命令由 `dsh-command-goal` 提供；`/compact` 由 `dsh-command-compact` 提供。
- 观测：`ctx.goals.get(agent)` 返回 `GoalView`（objective、phase、roundsStarted、maxGoalRounds、blocker reason、activation）。

结论：把 goal 放到子代理上是可行的（round-driver 对任意 live agent 生效），但**每次冷恢复/重启后必须重新 arm**，且冷恢复要先用父级 `sendMessage()` 唤醒子代理。

## 2.6 Schedule

`@deepseek-ai/dsh-schedule` 提供会话本地持久提醒：

- 工具：`schedule_create` / `schedule_list` / `schedule_delete`（本机安装的 0.1.5 版本另有 `schedule_delete`；0.2.1 版本以锁定版本为准）。
- 到期提醒在会话空闲后作为普通 follow-up 消息进入同一会话；agent 不会被打断。
- 需要 live 根 agent 才能交付；会话关闭/cold 时提醒保持逾期，直到未来的 live 根 agent 恢复会话；不会通过邮件/短信/推送发送。
- 重复提醒只支持固定间隔，最小 5 分钟；错过的重复只展示最新一次。
- 插件只给"插件加载后创建"的根 agent 安装工具；运行时子 agent 不获得 Schedule。
- 状态由会话日志的 `schedule/change` 事件持久化；session projection 可选。

## 2.7 Commands

`@deepseek-ai/dsh-commands` 是交互式 UI 的斜杠命令注册表：

- 插件用 `ctx.commands.register()` 注册小写名称、描述、可选 input hint 和 handler。
- `ctx.commands.list(agent)` 列出当前 agent 可见命令；`ctx.commands.execute(agent, line, submittedAttachments, signal)` 解析并执行已知命令，**不产生模型消息**，执行记录写入会话日志。
- UI 在模型历史之外渲染结果；无 UI 自动化（ACP/headless）不提供命令面。

本项目的 IM 桥接充当"交互式 UI 适配器"，通过 `execute` 透传 DSH 命令并注册桥接自有命令。

## 2.8 审批与用户提问

- `@deepseek-ai/dsh-user-approval`：与通道无关的一次性审批 seam；`ask` 策略把每个请求交给部署中的人类/机器应答者，`never` 直接拒绝；应答者缺失或失败时返回 `unavailable` 并拒绝（fail closed）。应答者是 `approval/request` waterfall 监听器，返回结果即作答，否则 `next()` 委托；限定到 agent 的监听器只接收该 agent 的请求。
- `@deepseek-ai/dsh-user-questions`：`ctx.userQuestions.ask(request)` 派发回答者 waterfall，等待第一个接受请求的回答；类型包含 questions（id/question/detail/header/options/multiSelect/intent）与 answers。
- `@deepseek-ai/dsh-tool-ask-user` 提供模型侧 `ask_user_question`；它**不渲染界面**，调用方必须提供用户交互表面；工具文档明确：归属于运行时其他 agent 的子级**不能调用**此工具，必须在最终结果中报告未解决问题。

## 2.9 experimental-auto-review（重点）

`@deepseek-ai/dsh-experimental-auto-review` 是 Web profile 的"Auto"权限预设的实验层。调研到的事实：

- 它是 **permission preset 的一部分**：只有会话当前 preset 等于 `AUTO_PRESET`（通过 `permissionPresets.registerAuto()` 注册）时，`tools/pre-execute` 监听器才生效。
- 生效后**每次工具调用**（原生调用与已开始的 PTC inner call）在执行前用**当前 agent 的 provider/model** 审查一次；允许则调用以 **Full access（danger-full-access）** 执行；拒绝则在 `ask` 审批策略下走 approval seam 询问用户，用户批准后单次执行；`never` 策略下拒绝是终局。
- 风险策略固定（REVIEW_POLICY）：
  - low / medium 可 allow，high 必 deny；
  - medium 包括不可逆删除、force push、生产读写/部署、外部写入、权限/安全控制/系统变更；medium allow 需要"当前人类或直接父级明确授权动作、目标与范围"；
  - high 包括跨信任边界泄露敏感信息；
  - 效果不明确或授权冲突未解决 → deny（fail closed）。
- 模型输出必须是严格 JSON：`{"risk":...,"decision":...}`（deny 可带 `reason`）；只有 `low+allow`、`medium+allow`、`medium+deny`、`high+deny` 合法；非法输出会让调用失败且不执行。
- **进程内委派 child 固定 `never` 策略**，其拒绝是最终结果；进程外 child 在父委派调用获准后保留原生权限系统。这一条对"goal 子代理的审批"很关键，本项目需要打补丁把 child 审批也桥接到用户。
- 依赖：approval、LLM、permissionPresets、session、tools、agent-instructions、working-directory 等；实现是按 Web profile 写的，需要在 IM-only profile 里验证。
- 包内评审函数未导出；要改 reviewer 模型或 child 审批行为，只能 vendor 源码并维护补丁。
- 已知限制：可能误放行/误拒绝、无确定性豁免、无持久 grant、无重试层；外层 `run_code` transport 与 PTC 程序内直接 Node 效果不经过 inner-tool review。

## 2.10 Permission Presets

`@deepseek-ai/dsh-permission-presets`：

- 把沙箱模式与审批策略捆绑成命名预设（内置 `workspace-write`、`danger-full-access`）；`/permission` 命令报告/切换；有 `defaultPreset`。
- 挂载需要一个"具有约束能力、会报告 `sandboxMode`"的 bash 执行器，以及审批服务。
- `custom` 名称保留给推导出的非预设状态。
- Auto 预设由 auto-review 注册；选择 Auto 会设置 danger-full-access 沙箱值与 ask 审批策略。

本项目要让自己的 shell router 报告 `sandboxMode` 以满足该服务的挂载条件。

## 2.11 Shell / Subprocess / Sandbox Seam

### `ctx.shell`（`@deepseek-ai/dsh-shell`）

- 服务定义：`ShellExecutor` 抽象类，方法 `resolve(request) → spec`、`run(spec)`、`start(spec)`；`sandboxMode` getter 表示默认沙箱模式。
- **一个组合只挂载一个 provider**：重复提供 `ctx.shell` 会按 Cordis 的 duplicate-service 行为失败。官方 POSIX 实现是 `dsh-bash-local`（`LocalBashExecutor`）与 `dsh-bash-sandbox`（`SandboxBashExecutor extends LocalBashExecutor`）；两者都导出类，但同时挂载会冲突。
- `ShellExecRequest` 字段：command、workdir、timeoutMs、stdoutMaxBytes、signal、stdin、env、dshEnv、sandboxPolicy；`resolve` 填充默认值与上限；`run` 只在基础设施失败时 reject，非零退出/超时/中止都 resolve 为结果。
- `run` 的结果包含 exitCode/signal/timedOut/aborted/stdout/stderr/spill 信息；共享退出标记约定由 `parseExitStatus` 解析（`[exit code: N]` / `[killed by signal: X]`）。
- 后台进程：`start` 立即返回 `ShellProcess`（readOutput/kill/done），job id/所有权/轮询属于 `ctx.jobs`，不归 shell seam。
- 模型侧 `dsh-tool-bash` 注入 `tools`、`shell`、`systemPrompt`、`shellEnv`；每次调用新 shell，不保留 cwd/env；支持 `run_in_background`；在沙箱模式时暴露 `sandbox_permissions`/`justification` 升权字段。

### `ctx.subprocess`（`@deepseek-ai/dsh-subprocess`）

- 解析可执行文件、启动显式 argv 或真实终端、流式/有界收集输出、终止受管进程范围。
- 每个组合配置一个实现（本地提供方是 `dsh-subprocess-local`）；请求携带 argv/cwd/stdio/env overrides/grace/cancel signal，不加 shell 解释。
- 子进程环境会先移除凭据与 `DSH_*`，再应用显式覆盖。
- 文档提到"根据命令运行位置选择本地或远程执行"，但发布的实现只有本地；远程执行需要自己提供。

### `ctx.sandbox`

- 进程沙箱服务约定：read-only / workspace-write / danger-full-access；无法强制执行时 `SANDBOX_UNAVAILABLE`，不会不带限制地运行。
- DSH 原生 Linux 实现基于 Landlock；它是**同机文件访问策略**，不是容器/临时环境，也没有"回收重置"语义。

结论：SSH/多环境执行不适合硬塞进 `ctx.shell` 的单 provider 模型；本项目在工具层做 host 路由（见 07）。

## 2.12 提示词与工作区指令

### `@deepseek-ai/dsh-system-prompt`

- 提供 `ctx.systemPrompt` 注册表；每个 agent 的贡献可带作用域，agent 作用域会遮蔽同名全局项。
- 配置：`includeHarnessIdentity`（默认 true，第一方身份句，order −1000）、`includeRuntimeContext`（默认 true）、`personaPrefix`（order 0）、`personaSuffix`（order 10200）、`toolOrder`。
- 段落：`ctx.systemPrompt.section({ name, order, text })`；按 order 升序拼接；order 相同时按名称代码单元排序。runtime-context 贡献方用 `getContextOrder(name)`。
- 变量：段落文本可用 `{{name}}`，每次组装解析；作用域变量遮蔽全局；内置循环变量 `model`、`cwd`。
- `complete: true` 段会成为精确的完整提示词；多个 complete 段会失败。

### `@deepseek-ai/dsh-persona`

- 用于单个 agent（preset 内）注册 persona prefix/suffix，遮蔽部署级 persona；`complete` 可让前缀成为唯一系统提示词；`includeRuntimeContext: false` 可抑制该 agent 的 runtime-context。
- 只能在 agent scope 挂载；全局挂载会与 system-prompt 的部署 persona 注册冲突。
- 本项目主 agent 为单 agent，可直接用 system-prompt 的 `personaPrefix`；子代理用 subagent 工具的 persona 配置。

### `@deepseek-ai/dsh-agent-instructions`

- 首次请求加载：用户全局 `$DSH_HOME/AGENTS.md`，再从项目根到会话 cwd 的每个目录中的 `AGENTS.md`、`CLAUDE.md`，以及本地 overlay `AGENTS.local.md`、`CLAUDE.local.md`。
- 项目根用 `.git` 等 marker 标记；成功 read/write/edit 后会发现更深层的新适用文件；恢复会话会对账基线。
- `maxBytes` 必填（base 用 65536）；渲染优先保留更具体的文件；超预算会发通知。
- 不支持监视外部编辑（只有 fs 操作/恢复会触发更新）。

### `@deepseek-ai/dsh-time-context`

- 可选时钟：每步注入持久、带来源的 user 角色读数（时间、时区策略、经过时长）。
- 默认不启用；Schedule overlay 会挂载它；可用 `refreshIntervalMs` 抑制注入频率。
- 每条注入都是历史中的额外 user 消息，有 token 成本。

### `@deepseek-ai/dsh-skill*`

- `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`：按需加载的领域技能（SKILL.md）。本项目未把它作为 v1 重点，但计划保留（见决策）。

## 2.13 Compaction 与 Token Meter

- `@deepseek-ai/dsh-compaction-basic`：接近上下文上限时把最旧历史摘要并保留近期；提供 provider 溢出错误后的压缩重试；支持 `/compact`；每次压缩多一次模型请求；不能缩系统提示词/工具 schema/不可分单元。
- `@deepseek-ai/dsh-compaction-tool-result-pruner`：压缩前修剪超大工具输出。
- `@deepseek-ai/dsh-token-meter`：回放会话日志做确定性的 token/context 估算，不调模型；有 `measure(session, requestHeader?)` 与 `estimateMessage(message)`；提供 `tokenUsage`、`contextPressure`、`contextBreakdown` 投影。

## 2.14 外部集成面（为什么不做外部 gateway）

调研过、最终未采用的接入方式：

- **SDK JSON-RPC**（`dsh-sdk-app` / `dsh-sdk-jsonrpc-server` / `dsh-sdk-protocol`）：方法只有 `initialize`、`session/prompt`、`shutdown`，通知有 `session.event`、`session.status`、`subagent.started/finished`。提示词是"持久入队"语义，**不暴露 steer/inject**，无法精确满足"不打断本轮"的要求；也没有 approval/userQuestions 的应答面。
- **ACP**：面向编辑器/自动化的 Agent Client Protocol，同样不适合作为 IM 桥接；一次性子代理限制也在文档中。
- **Web API**（`dsh-api-session-controller`）：源码中 prompt 请求支持 `mode: "steer"` 与 followup，看起来可用；但它属于 Web 应用的内部 API，需要保留 web 服务/鉴权栈，与"精简、无 Web UI"冲突。
- **进程内 Cordis 插件**：最终选择。可直接 `ctx.agents`、订阅事件、注册 approval/userQuestions 应答者、使用 commands seam，不需要自建协议。

## 2.15 版本与环境事实

- CLI 与 dev-context 版本 `0.2.1-rc.3`；用户 profile `node_modules` 是 `0.1.5-rc.3` 的旧安装（249 个 `@deepseek-ai/*` 包）。
- 本规划的目标是 **0.2.1-rc.3**；实现时所有 `@deepseek-ai/*` 固定同一版本。
- `@deepseek-ai/dsh` CLI 的 dlx 安装闭包中 `@deepseek-ai/*` 目录约 296 个（包含部分非 dsh 包），直接依赖 86 个。
- 本机没有可编辑的 DSH 源码 checkout；`harness-dev-context` 指到的路径实际是一个 pnpm dlx 缓存中的包目录，不是源码仓库。

## 2.16 OpenClaw 对照

参考 OpenClaw 的消息队列概念（[Command Queue](https://openclaw-ai.com/en/docs/concepts/queue)、[Messages](https://docs.claw.so/engine/concepts/messages/)）：

| OpenClaw 模式 | DSH 对应 | 本项目用法 |
|---|---|---|
| steer（注入当前 run） | `Agent.steer()` | IM 默认：忙碌时在最近 step 边界注入 |
| followup（排到下一轮） | `Agent.followup()` | IM 空闲时的默认；`/queue` 强制 |
| collect/backlog（合并/积压） | 无直接原语；可在 bridge 自行合并 | v1 不合并（按条 steer）；保留为未来可配置项 |
| interrupt（中断当前 run） | `Agent.cancel()` | 仅显式 `/stop`（只停主 agent） |
| session 串行 | 单主会话 + inbox FIFO | 串行；goal 在子代理并行 |
| channel gateway | 进程内 Cordis 插件 + ChannelDriver 抽象 | 不做独立 gateway |
| heartbeat/cron | DSH `dsh-schedule`（提醒） | v1 只做 schedule；不做 heartbeat |
| memory | 无内置；自研 memory 工具 + AGENTS.md | 见 09 |
| multi-agent/subagents | `dsh-subagent` continuable child | goal 子代理；多 goal 并行 |

## 2.17 调研对设计的硬约束

1. `ctx.shell` 单 provider → 多 host 必须走 router，而不是多个 executor 插件各自注册。
2. auto-review 是实验包、按 Web profile 写的、内部函数未导出 → 要双档 reviewer 与 child 审批桥接，必须 vendor + 补丁。
3. goal 在 session-start 后一定 disarm；子代理冷恢复只有 `sendMessage` 路径 → 重启恢复需要"发消息 → 重新 arm"两步。
4. 进程内 child 的 approval 原为 `never` → 要"子代理审批也问用户"必须改 auto-review/child 策略。
5. DSH 会话不提供删除 API → goal 归档只能是"释放 + 隐藏 + 索引 + 保留 session 文件"。
6. 官方 CLI 依赖很重 → 安装体积精简必须自建薄启动器。
7. DSH 在 rc 阶段、包/API 会变 → 锁版本 + 只依赖稳定 seam + vendor 实验代码并记录上游版本。
