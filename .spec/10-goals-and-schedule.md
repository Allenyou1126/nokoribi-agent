# 10 Goal 与主动行为

## 10.1 goal 的基本事实（DSH）

- `dsh-goal` 是每会话一个的持久目标服务；状态由会话日志的 `goal/change` 事件溯源。
- phase：`active` / `paused` / `blocked` / `complete`；`activation`（armed/disarmed）是进程本地状态。
- 任何 `agent/session-start` 边界都会 disarm；恢复会话/分叉/冷恢复后必须显式 `ctx.goals.resume(agent, ref)` 才能重新自动续跑。
- `dsh-goal-round-driver` 对任意 live agent 生效：agent 空闲 + goal active + armed + 有轮次额度时，自动 `followup` 一条 goal round prompt。
- 每会话至多一个当前 goal；多个并行 goal 必须放在不同子代理会话里。

## 10.2 最终设计（D18/D22/D88–D102）

- goal **由子代理持有**；主 agent 只负责创建、转述、询问归档。
- 允许多个 goal 子代理**并行**，**不设并发上限**（D93/D96）；靠完成后的归档控制长期数量。
- goal 子代理是 **continuable subagent**：持久会话、可继续、可中断、可冷恢复。
- 主会话**禁止**持有 goal（D101）。
- 短 id 使用 **child sessionId 前缀**（D102），命令用该前缀引用。
- 两条创建路径都支持（D88，M4 按 D136 调整）：
  1. 主 agent 通过专用 `start_goal` 工具创建；generic `subagent` 仍用于普通委托；
  2. `/goal new` 命令由桥接直接创建。
- `/goal` 命令包含创建（D89）。
- 重启后自动冷恢复并 re-arm（D90）。
- 完成后保留会话、写归档索引；由主 agent 询问用户，用户命令归档（D94/D98/D100）。

## 10.3 创建路径 A：主 agent 通过 `start_goal` 工具

- M4 挂载 `dsh-subagent` + `dsh-subagent-spawn-in-process` + `dsh-tool-subagent` + `dsh-tool-subagent-control`；没有 `backgroundMode` 配置，spawn child 本身就是 continuable activation。
- 用户自然语言描述长期目标 → 主 agent 调 `start_goal({ objective, description, max_goal_rounds? })`（D136）：
  1. 工具执行者校验调用者为主 agent；
  2. 宿主预留 `goal-<uuid>` child id，`ctx.subagents.startActivation()` 启动 child，bootstrap prompt 要求 child 等待首个 `<goal_round>`；
  3. 宿主立即 `ctx.goals.create(child, ...)`，返回 short id；
  4. round-driver 自动续跑；child 用 `get_goal`/`update_goal` 控制完成/阻塞。
- `start_goal` 调用与子代理后续工具调用都过 Auto review。
- 桥接通过 `goal/changed`、`subagent/start|end` 与 child session 事件跟踪（见 10.5）。
- 模型选择：默认 `NOKORIBI_GOAL_PROVIDER`/`NOKORIBI_GOAL_MODEL`；M5 起 `NOKORIBI_GOAL_MODELS` 提供额外精确路由，`start_goal.model`/`reasoning_effort` 与 `/goal new --model/--effort` 可选择；generic `subagent` 仍继承主模型（D138/D141）。
- 轮次上限：显式 `max_goal_rounds`/`--rounds` 优先；省略时使用 `goalDefaultMaxRounds`（env `NOKORIBI_GOAL_DEFAULT_MAX_ROUNDS`，默认 256），该值同时写入 bootstrap prompt 与 `ctx.goals.create({ maxGoalRounds })`。

## 10.4 创建路径 B：`/goal new`

- `/goal new <目标> [--rounds N] [--model provider/model] [--effort ID]` 由桥接命令处理器调用与 `start_goal` 相同的 `GoalManager.startGoal()`：
  - provider：`spawn`（进程内）；parent：主 agent；
  - 预留 `goal-*` child id；bootstrap prompt 说明宿主创建 goal、等待首个 round；
  - 宿主调用 `ctx.goals.create()`；路由使用默认 goal 路由或 allowlist 选中的 route（D141）。
- 该路径不产生主 agent 模型消息；子代理后续动作仍过 Auto review。
- 创建成功后返回短 id、child sessionId 与轮次上限。

## 10.5 跟踪与识别

- 桥接监听 `goal/changed`、`subagent/start|end` 与 `session/event`；主会话 goal 单独拦截。
- 校验来源：`agent.session.header.parentSession === mainSessionId`；启动恢复时用 `ctx.subagents.listChildren(mainSessionId)` 校验。
  - 命中 → 登记到 `agent-state.json` 的 `goals[]`（sessionId、goalId、revision、phase、rounds、objective、maxGoalRounds、source、label、model）。
  - 未命中（例如主会话里出现 goal）→ 主会话 goal 策略：清掉并提示用户（D101）。
- goal 轮次通过 child 的 goal-sourced `user/message` 事件更新 `lastKnownRounds`。
- 不限制数量；同一 child 只有一个 goal（DSH 限制）。
- 短 id：`sessionId` 前缀（建议 8 字符）；state 中保存映射，`/goal` 命令用前缀查找。
- 主 agent 的 goal 工具已隐藏（M4：`agentCtx.tools.restrict({deny:[create_goal,get_goal,update_goal]})`；main setup 注册，启动/resume 都生效）。
- child 的 goal 工具需要可用：由全局 `dsh-tool-goal` 提供，或按 agent 作用域安装；实现需保证 main 不可见、child 可见。
- 若模型误在 main 创建 goal：桥接检测到后 `ctx.goals.clear(main, ref)` 并通知用户；同时记录日志。

## 10.6 重启恢复

启动顺序（详见 05.3）：

1. resume 主会话。
2. 对 `goals[]` 中每个 tracked child：
   - 用 `listChildren` 确认持久化 child 存在且 mode=continuable；不存在则通知并清理。
   - 若原 phase 为 `paused`/`blocked`/`complete`：不自动恢复（保持原状；blocked/complete 可通知）。
   - 若原 phase 为 `active`：
     a. `ctx.subagents.sendMessage(mainAgent, childId, [text("（系统）进程已重启，请继续当前 goal，不要重复已完成工作。")], ...)` 触发冷恢复；
     b. 等待 child live（`agent/created` 或轮询 `ctx.agents.get(childId)`，设置超时）；
     c. `ctx.goals.get(childAgent)` 读取最新 view；
     d. 若 phase=active 且 round 额度有剩余 → `ctx.goals.resume(childAgent, ref)` 重新 arm；
     e. 若额度耗尽/blocked → 不 arm，通知用户。
   - 冷恢复消息会多引入一轮；用户已接受（D90）。
3. 恢复失败：通知用户、保留 tracked（D95）；等 `/goal resume <前缀>` 或新消息重试。
4. 失败重试时再次尝试冷恢复；如果 child 永远无法恢复，可 `/goal clear` 归档。

实现注意：

- 冷恢复通过 `ctx.subagents.sendMessage(main, childId, [...])`；content 是模型可见消息，应尽量短。
- child 冷恢复的第一轮会先处理这条消息；随后 round-driver 才会排下一轮；不要在这轮之前重复注入目标。
- 如果 child 的 goal 是 `active` 但 activation 已 disarm（正常），必须在 child live 后重新 arm。
- 多个 goal 顺序恢复，避免同时打满；恢复期间入站消息继续缓冲。

## 10.7 `/goal` 命令

| 命令 | 行为 |
|---|---|
| `/goal new <目标> [--rounds N] [--model provider/model] [--effort ID]` | 桥接创建 continuable child + 提示其创建 goal；返回短 id；model/effort 由 allowlist 校验 |
| `/goal list` | 列出 tracked goals：短 id、phase、rounds、目标摘要、是否 running |
| `/goal status <前缀>` | 详情：objective、model、phase、roundsStarted/max、blocker、child 状态、sandbox 状态 |
| `/goal pause <前缀>` | 若 live：`ctx.goals.pause(child, ref)`；若 cold：返回错误，提示先 `/goal resume`（M4 实现） |
| `/goal resume <前缀>` | live 且 active/paused → `ctx.goals.resume(child, ref)`；cold → 冷恢复后 arm；blocked/complete 需先 edit/clear（DSH 语义） |
| `/goal clear <前缀>` | 停止当前轮（`interrupt`）→ live 时 `ctx.goals.clear` → 释放 Activation → 移出 tracked → 自动归档（D99） |
| `/goal archive <前缀>` | 用户确认归档已完成 goal：释放/确认无 running → 移出 tracked → 写归档索引 → 删除 sandbox → 保留 session 文件（D98/D100） |

- 命令失败时回明确错误（不存在/前缀歧义/cold 不可操作/额度耗尽）。
- 命令不产生主 agent 模型消息；结果直接回 IM。
- `/stop` 只停主 agent，不停 goal 子代理（D91）。

## 10.8 汇报、完成与归档

### 汇报

- M4 子代理使用 `send_message` 向直接父级发送记录；主 agent 忙碌时在 step 边界收到，空闲时启动新一轮。`subagent/end` 另发自动结算通知。
- 格式见 [09.6](09-prompt-and-memory.md#96-goal-汇报格式)。
- 主 agent 的提示词要求：收到子代理报告时转述为 IM 摘要；不把原始格式直接发用户。
- 频率：里程碑/阻塞/完成；不要每轮。
- 子代理完成 goal 后应 report done；主 agent 的该轮回复被镜像到 IM。

### 完成

- 子代理调用 `ctx.goals.complete`（goal 工具）标记完成。
- 主 agent 收到结算通知/报告；通过 `ask_user_question` 询问用户是否归档。
- 用户回复后用 `/goal archive <前缀>`（不是模型工具；D100）。

### 归档

`/goal archive <前缀>` 流程：

1. 校验：goal phase=complete（或用户显式决定归档）；子代理无运行中任务。
2. `ctx.subagents.drainContinuableChildren(mainAgent, [childId])` 释放驻留 Activation（若 live）。
3. 从 `goals[]` 移除；写 `$DSH_HOME/archive/goals.jsonl`：

```jsonc
{
  "shortId": "a1b2c3d4",
  "sessionId": "child-session-...",
  "objective": "...",
  "outcome": "complete",
  "rounds": 12,
  "createdAt": "...",
  "completedAt": "...",
  "archivedAt": "...",
  "source": "subagent-tool",
  "model": { "provider": "...", "model": "..." }
}
```

4. 删除该 child session 的 sandbox 目录（per-session scope）。
5. 保留 DSH session 文件（不删除；没有 web-debug，可按 sessionId 在会话存储中查看原始记录）。
6. 回用户"已归档 <前缀>"。

### blocked / 失败

- 子代理 mark blocked：主 agent 收到报告；桥接发 ⚠️ 系统通知（可能重复）。
- 子代理崩溃/错误：DSH 结算通知到主 agent；桥接发系统通知；tracked 状态保留，等用户决定 resume/clear。
- goal 轮次耗尽：round-driver 会 block；通知用户。

## 10.9 Sandbox 与 goal

- sandbox 按 session 独立（D92）：每个 goal child 有自己的 sandbox 目录与 TTL。
- 归档/`/goal clear`/`/clear` 时通过 `ctx.shellHosts.disposeSession(childId)` 删除对应 sandbox（如果存在）。
- 重启恢复 goal child 时；其 sandbox 若仍在 TTL 内可复用，过期则重建。
- goal child 默认使用 sandbox host（跟随 defaultHost）；需要持久化 workspace 时可以在任务中显式使用 `local:*`（受 auto-review）。

## 10.10 Schedule（主动提醒）

- 挂载 `dsh-schedule` + `dsh-tool-schedule` + `dsh-time-context`；rc.3 的 Schedule 是 Host-wide，任务存于 `$DSH_HOME/storage/schedule.json`（storage-domain/JSON）。
- 主 agent 通过 `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` 工具管理提醒；`title` 必填（≤120 字符），时间参数六选一；`every_seconds` 最小 60 秒。
- 到期作为普通 follow-up user 消息进入原主会话（`[SCHEDULE REMINDER]` / 批次 `[SCHEDULE REMINDER BATCH]`）；主 agent 处理后的回复被镜像到 IM——这就是主动播报。
- 需要主 agent live；daemon 常驻 + 启动恢复保证。`sessionController` 桥只解析当前主会话，并在 daemon ready 前阻塞交付，避免在 session listener 安装前开轮。
- 错过的重复只显示最新一次；逾期提醒在恢复 live 后交付（依赖启动顺序，见 05）。
- 主 agent 忙碌时提醒不会打断当前轮。
- `/clear` 在 dispose 旧 main 前删除旧主会话的全部任务（active + inactive）；否则它们会一直重试。任务不跨主会话迁移。
- 子代理不能使用 Schedule（工具层拒绝）；主会话独享。
- **不做 heartbeat**（D62）；没有独立"周期性唤醒检查任务"的能力。主动行为只有 schedule 提醒和 goal 自动续跑。
- 已知限制：Host 必须运行；enqueue 与任务写入非原子，崩溃可能重复交付；存储损坏会让 schedule 启动失败（fail loud）。

## 10.11 已知限制与风险

- 冷恢复必须发送一条消息，可能多一轮；用户已接受。
- 没有持久 parent mailbox：主 agent 必须在报告到达时在线；daemon 常驻保证，但 `/clear`/重启窗口可能拒绝。
- child 崩溃前已接受但未写入日志的消息可能丢失（DSH 限制）。
- 多个 goal 并行时汇报会增多；主 agent 需要控制转述频率（提示词约束）。
- goal 完成的通知/转述/系统通知可能重复（主 agent report + 结算通知 + bridge 通知）；稀有，接受。
- 主 agent 隐藏 goal 工具已用 agent-scoped `tools.restrict` 验证（M4）。
- 归档只是隐藏 + 索引；DSH 会话不可删除，磁盘会增长；需要时人工清理（无备份/无 VM 测试）。


## 10.12 M4 实现记录（2026-10-25）

- 挂载 `dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver`、`dsh-subagent`、`dsh-subagent-spawn-in-process`、`dsh-tool-subagent`、`dsh-tool-subagent-control`、`dsh-session-query-sqlite`（`openAt:"never"`）。不挂 `dsh-command-goal`。
- 采用 D136：`start_goal` 工具 / `/goal new` → 宿主预留 `goal-*` child id、`startActivation` → `ctx.goals.create()`；main 的 `create_goal/get_goal/update_goal` 通过 agent setup + `ctx.tools.restrict` 隐藏。
- 采用 D137：child 用 `send_message` 汇报；`subagent/end` 自动结算；无独立 report 包。
- `GoalManager` 跟踪 `goal/changed`、child goal round、`subagent/end`；支持 `/goal list/status/pause/resume/clear/archive`。
- 启动恢复：`listChildren` 校验 → active goal `sendMessage` 冷恢复 → 等待 live → `ctx.goals.resume`；失败保留 tracked + ⚠️ 通知。
- `/clear` 在 dispose 旧 main 前 `clearAll()`：interrupt → clear → drain → 归档 `cleared` → 删除 sandbox；session 保留。
- 归档索引 `$DSH_HOME/archive/goals.jsonl`；`/goal archive` 只接受 complete。
- 验证：`pnpm test` 208 tests、`pnpm test:process` 33 scenarios、`pnpm check`；新增 M4 进程场景覆盖 `/goal new` 完成/归档、`start_goal`、main 隐藏、pause/resume、SIGKILL 冷恢复、`/clear`、多 goal、恢复失败、`send_message` 汇报。
- M4 偏差/边界：goal 模型当时固定为 `NOKORIBI_GOAL_MODEL`（D138，M5 已补 allowlist）；goal child persona 由 prompt 承担而非 agent preset；`/goal pause` 对 cold child 返回错误（先 resume）。

## 10.13 M5 实现记录（2026-10-25）

- Schedule：挂载 `dsh-storage`/`storage-json`/`storage-domain`/`dsh-schedule`/`dsh-tool-schedule`/`dsh-time-context`；新增 `@nokoribi/agent-app/session-bridge` 最小 `sessionController`，只解析当前 main 并在 ready 前等待。
- `/clear`：创建新 main 前用 `ctx.schedule.catalog()` + `delete` 删除旧 main 的全部任务，返回删除数量；`sessionController` 重新 bind 新 main。
- Goal 模型：`NOKORIBI_GOAL_MODELS` allowlist；`start_goal` 支持 `model`/`reasoning_effort`，`/goal new` 支持 `--model`/`--effort`；state/status/archive 记录 route；默认路由始终允许。
- 记忆提炼：goal `complete`/`blocked` 触发一次性 `memory-*` child，输入 objective + 最后 report；`delivery:"caller"`，超时/失败静默。`/clear` 取消当前 curator。
- 验证：`pnpm test` 285 tests、`pnpm test:process` 40 scenarios（M5 新增 7）、`pnpm check` 0 warnings/errors。
- 偏差/边界：D139（Host-wide schedule 桥）、D141（generic subagent 模型选择后移）、D143（memory 自动注入后移）；`/clear` 期间到期交付有极小在途窗口。
