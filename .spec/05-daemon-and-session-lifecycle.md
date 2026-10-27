# 05 Daemon 与会话生命周期

本文件覆盖：常驻进程、主会话、状态文件、启动/恢复/关闭/崩溃、`/clear`、`/stop`、outbox、待应答失效、系统通知。goal 子代理的专项生命周期见 [10 Goal 与主动行为](10-goals-and-schedule.md)。

## 5.1 进程形态

- 一个 NixOS systemd 服务（`nokoribi-agent`），专用用户 `nokoribi`，`DSH_HOME=/var/lib/nokoribi-agent`。
- 单实例：启动时在 `$DSH_HOME/run/agent.lock` 上取排他文件锁；取不到则启动失败（避免两个 harness 进程共享同一持久存储；DSH 的驻留 Activation 与子代理所有权只在进程内协调）。
- 生命周期内只有一个主 agent（单主会话）；goal/任务子代理由主 agent 创建。
- 进程退出由 systemd 重启（`Restart=on-failure`）；sd_notify watchdog 处理卡死（见 12/13）。

## 5.2 状态文件

`$DSH_HOME/state/agent-state.json`（`writeJsonAtomic`，0600）。M1 还持久化 `state/outbox.json`、`state/ingress-seen.json`；`run/agent.lock` 是 O_EXCL 持有的单实例锁，`run/ready.json` / `run/startup-error.json` 供 launcher 与进程测试握手。M7 的 outbox 文档新增 `deferredNotices[]` 与每条出站的 `replyTo/replyReceivedAt/replySeq/actions` 可选字段（旧文件兼容），不新增状态文件。

字段草案：

```jsonc
{
  "version": 1,
  "mainSessionId": "main-session-...",
  "goals": [
    {
      "sessionId": "child-session-...",
      "goalId": "...",
      "revision": 12,
      "phase": "active",
      "lastKnownRounds": 3,
      "createdAt": "...",
      "updatedAt": "...",
      "source": "subagent-tool"   // 或 "goal-command"
    }
  ],
  "archivedGoals": [],           // 归档索引由 archive/goals.jsonl 承担；这里可放最后游标
  "lastActiveChat": { "channelId": "...", "chatId": "..." },
  "cleanShutdown": true,
  "outboxSeq": 123,
  "lastStartedAt": "...",
  "lastVersion": "0.1.0",
  "lastRestartReason": "first-start"   // first-start | clean | crash | state-corrupt
}
```

- `mainSessionId`：主会话的稳定 id；首次启动创建并写入，之后 resume。
- `goals[]`：桥接通过 `goal/changed` + `listChildren` 识别的 goal 子代理；用于重启恢复与 `/goal` 命令。
- `cleanShutdown`：启动即写 false；SIGTERM 正常退出时置 true。启动时若为 false 视为崩溃恢复并发送通知。
- `lastRestartReason`：M1 增加，供 `/status` 与通知逻辑使用；损坏状态会先备份为 `agent-state.json.corrupt-<ts>`。
- 主会话创建后立即 `ctx.sessions.flush()`，确保“新建后马上崩溃”也能 resume；resume/`dispose()` 不会删除已落盘的 session 文件。
- 归档索引 `$DSH_HOME/archive/goals.jsonl`：每行一条归档记录（见 10）。

## 5.3 启动顺序

M1–M4 实现顺序：

1. `agent-app` 在插件树就绪后取得单实例锁（O_EXCL + holder pid；stale 锁只接管一次；无法读取的锁 fail closed）；随后校验 default shell host 已注册（`ctx.shellHosts.requireDefaultHost()`），缺失则写 startup-error 并拒绝启动。sandbox 的 `baseEnvironment` 允许暂未配置，执行时返回明确错误。
2. 读取/校验 `agent-state.json`；损坏则备份并按首次启动处理，记录 `state-corrupt`。
3. 确保目录存在（state/run/archive/memory/sandboxes/workspace；sessions 由 DSH 创建）。
4. 挂载 Cordis 插件树；`channel-local-test` 先监听 loopback 并缓冲入站。
5. 创建或恢复主 agent：
   - 有 `mainSessionId` 且持久化会话可打开 → `ctx.agents.resume({ resumeSessionId })`；
   - 找不到持久化会话 → 创建新会话并通知；其它 resume 错误 fail loud；
   - 否则 `ctx.agents.create({ sessionId: "main-"+uuid, meta.cwd=workspace })`。
   - 创建/恢复后立即 `permissionPresets.set(session, "auto")`，校验 `current()==="auto"`；失败则 startup-error，不降级为无审查。注册只读 `/permission` scoped 命令。
   - 创建/恢复后立即 flush，随后写回 state。
6. 安装 `session/event` 监听、注册命令、安装 status provider，再 `channels.attachRuntime()`。M7：attach 后立即用 `state.lastActiveChat` 调 `channels.restoreActiveChat()`；session listener 处理 `turn/start` 时调用 `channels.noteTurnStart()` 提升排队来源 chat。
7. goal 恢复（M4）：先 `listChildren` 校验 tracked 子代理，再对 active goal 逐个 `sendMessage` 冷恢复、等待 live、`ctx.goals.resume` re-arm；失败保留 tracked 并通知。
8. schedule 恢复（M5）：上游 `dsh-schedule` 从 `$DSH_HOME/storage/schedule.json` 读取任务；逾期任务通过 `sessionController.resolveAgent()` 等待主会话 ready 后交付。桥接在创建/恢复 main 后 bind，在 `drainBuffered()` 之后 markReady，避免在 session listener 安装前开轮。
9. `channels.resumeOutbox()` 重发 pending（at-least-once）；若 `initialize()` 清理了上次进程的 pending interaction，发送一次失效通知。M7：该通知按恢复后的 chat/active 能力路由，QQ-only 且无 active 时转 deferred，下次入站补投。
10. 非 clean/corrupt 时发送重启或状态损坏通知；resume 找不到会话时发送新会话通知。M7：通知目标按 D162 的路由顺序选择，不再依赖全局 `lastActiveChat` 串渠道。
11. `channels.drainBuffered()` 放行启动期入站；随后 `sessionController.markReady()`、写 `run/ready.json`；若 systemd `NOTIFY_SOCKET` 存在，再发送 `READY=1` 并启动 watchdog（M6，D144）。

> V4 验证结果（M1）：resume 会恢复 `next-turn` inbox，但**不会自动开启新轮**；下一次用户消息或显式唤醒会带上排队消息。M1 不额外重放，后续里程碑可加系统提示唤醒。

> 启动时序需要在实现时验证：Schedule 只给"插件加载后创建"的根 agent 安装工具；因此主 agent 必须在 Schedule 插件就绪后创建/恢复，且 schedule 交付要等 `sessionController.markReady()`。`agent-app` 作为 app-boot 的启动提供方在准备完成后执行主会话生命周期；M5 进程测试已覆盖到期/逾期交付。

## 5.4 正常关闭（SIGTERM）

M1/M2 实际流程：

1. 发送 systemd `STOPPING=1`（若启用），停 watchdog；`channels.pause()` 停止接受新入站。
2. 调用 `channels.abortInteractions("shutdown")`，中止待审批/提问并写入失效提示；outbox 持久化，下次启动继续投递。
3. 等待当前轮完成至 `shutdownGraceMs`（默认 20s，可配）；超时用 `cancel({ kind:'disposed' })`。
4. goal 子代理不在这里逐个清理；由 profile-boot 后续的 context teardown 交给 DSH subagent manager 释放，重启后按 active goal 冷恢复。
5. `ctx.sessions.flush()`，写 state 并置 `cleanShutdown=true`。
6. 进程由 vendored profile-boot 的 bounded shutdown 退出；vendored 上限由 `NOKORIBI_SHUTDOWN_TIMEOUT_MS` 控制，默认 30s。M6 的 systemd `TimeoutStopSec` 必须大于它。

> Cordis 的插件 effect teardown 是并发的，session-persistence 的写句柄 teardown 可能先于第 5 步关闭句柄。该后端 `close()` 会先 drain 已路由事件再释放，因此此时 flush 抛出 `SessionHandleClosedError` 表示“已持久化”，只记 debug，不计为关闭失败；daemon 对 `AggregateError` 中全是该错误的情形做同样处理，m1 进程测试断言干净退出日志不出现 `shutdown flush failed`。

> 关闭时不在 outbox 中的"正在生成的回复"会丢失；若已生成但尚未入队，属于可接受窗口。所有已入 outbox 的消息会重发。

## 5.5 崩溃恢复

场景：kill -9 / OOM / 断电 / watchdog 重启。启动时 `cleanShutdown=false`。

- 主会话：resume；DSH 补写 interrupted turn closers；模型下一次请求会看到中止的工具调用与结果。
- 队列消息：inbox 通过 `agent/inbox/spliced` 持久化，resume 后应恢复。
  - **待验证**：resume 后 driver 是否会自动处理已有 inbox；若不会，桥接会用自己记录的 ingress 待处理队列重放（同一 messageId 去重）或注入一条系统提示唤醒，二选一在实现时决定。
- 待审批/提问：进程内 promise 已消失；重启后无法恢复。启动时 `channels.initialize()` 把 outbox 中残留的 pending interaction 标记为失败，`resumeOutbox()` 后发一次“待应答已失效”提示；broker 内存状态为空。
- goal 子代理：M4 按 state 恢复（见 10.6）；`sendMessage` 冷恢复，等待 child live 后重新 arm；失败保留 tracked 并通知。可能多跑一轮。
- outbox：未发送消息重发；若崩溃前已发送但未标记，可能重复（at-least-once）。
- sandbox：每个 session 的 sandbox 目录落盘；TTL 计时按 `$DSH_HOME/sandboxes/<sessionId>.json` 的 lastUsed 恢复；重启后首次使用若仍在 TTL 内可复用，过期则回收重建。daemon 关闭只停止 TTL 定时器，不删除目录。
- 重启通知：只在 `cleanShutdown=false` 或恢复失败时发送，避免每次部署都刷屏。

## 5.6 `/clear` 与 `/new`

语义：**新建主会话，旧会话归档保留**（D17）。

流程：

1. 若存在活跃 goal 子代理：`/clear` 在 dispose 旧 main 前调用 `GoalManager.clearAll()`；对 live child `interrupt` → `ctx.goals.clear` → drain → 归档 `outcome:"cleared"`，从 `goals[]` 移除；失败记录日志但继续新会话。
2. 取消正在运行的 memory curator（不阻塞 `/clear`；旧 child 随 context/main 生命周期释放）。
3. 若存在待应答：`channels.abortInteractions("clear")` 全部中止并通知用户，同时抑制已排队但未发送的旧提示。
4. 用 `ctx.schedule.catalog()` 找出绑定旧 `mainSessionId` 的全部任务（含 inactive），逐条 `delete`；失败记录日志但继续。确认消息附带删除数量。
5. dispose 主 agent handle；旧会话保持在 DSH 会话库中（不删除）。
6. 生成新的 `mainSessionId`，`ctx.agents.create()` 新会话；重新 bind `sessionController` 与 memory curator；写回 state；保留 outbox（已生成的消息仍发给用户），新消息进入新会话。
7. 删除旧会话对应的 sandbox 目录（per-session scope）。M3 实现：旧 agent `dispose()` 后调用 `ctx.shellHosts.disposeSession(previousId)`，删除目录与 sidecar；失败只记录日志，不阻断 `/clear`。
8. 发送确认消息："已新建会话，旧会话已归档"（如有提醒删除则追加数量）。

- `/new` 与 `/clear` 等价（别名）。
- 不做"继承摘要"：新会话不自动带旧会话上下文；需要总结由用户/主 agent 通过 memory 或手动完成（用户选择 D17 时未选摘要开场）。
- 旧会话仍可通过 session 文件查看（没有 web-debug）。

## 5.7 `/stop`

- 只停主 agent（D91）：`agent.cancel(cause)`，默认清空主 agent 的待处理 inbox 与排队注入；中止当前待审批/提问（approval cancelled、question error）。
- **不影响 goal 子代理**：goal 用 `/goal pause` / `/goal clear` 控制；主 agent 停止后 goal 子代理仍可继续运行并产生 report（主 agent 空闲时 report 会启动主 agent 一轮，这符合设计；若要彻底停止 goal，用 `/goal pause` 或 `/goal clear`）。
- 用户主动 `/stop` 不发送"意外中止"系统通知；命令本身返回"已停止"。

## 5.8 待应答（审批/提问）生命周期

- 只在主 agent 或（补丁后的）子代理的当前轮内存在；与具体 `approval/request` 或 `userQuestions.ask` 的 promise 绑定。
- 串行 FIFO：同一时刻只有一个提示在等；一个解决后再展示下一个（D56）。
- 超时：approval 60 秒 → 拒绝；question 300 秒 → 工具报错（D57，均可配）。
- 进程重启/`/clear`/`/stop`/shutdown：全部中止；`/stop`、`/clear`、shutdown 发失效提示，重启时由 startup 清理发一次提示。
- 提示文本带前缀与目标标识（审批 🔐、提问 ❓；子代理审批带 goal 短 id），用户回复按编号/允许/拒绝/自定义文本解析。
- 实现：`channel-core` 的 `InteractionBroker` 串行处理；提示以 `kind:"interaction"` 进 outbox；已终止的 interaction 提示由 outbox 跳过/标记失败。
- 详见 [06 渠道与交互](06-channel-and-interaction.md)。

## 5.9 系统通知

直接由桥接入 outbox（不经过模型），前缀 ⚠️：

- agent 错误（未处理的 turn 失败）。
- 非用户触发的 turn abort（崩溃/看门狗/内部失败）。
- goal blocked（若主 agent 未及时转述；允许与主 agent 转述重复，稀有情况）。
- daemon 重启（仅非 clean shutdown 或恢复失败时）。
- 待应答因重启/停止失效。
- 恢复失败（goal 子代理冷恢复失败）。

用户主动 `/stop`、正常 `/clear`、正常每轮回复不产生系统通知。

M7 路由与降级（D159/D161/D162）：通知目标优先 `turnChat ?? lastActiveChat`；同 chat 不可投时回退其他有 `defaultChatId` 的 active-capable driver；都没有时对已知 chat 入 `deferredNotices`，下一次该 chat 入站时以被动回复补投（“⚠️ 补发”）；无任何 chat 可寻址才 warn + drop。`/status` 增加 `channels` 与 `deferredNotices` 便于观察。

## 5.10 主会话与消息边界

- 主会话 id 稳定；所有 IM 消息都进入同一主会话（单用户单主会话，D08）。
- 入站消息在 agent 忙碌时 steer、空闲时 followup（D05/D55）。
- 主 agent 一轮的"最终回复"由桥接在 turn 结束时取最后一条非空 assistant 文本发送（见 06）。
- goal 子代理的 report 通过 `parent.steer()` 进入主会话，主 agent 的下一次回复会被镜像到 IM；主 agent 的提示词要求它把子代理报告转述成用户可读的摘要。
- 主会话的 goal 被禁止（D101）：不挂载 main 的 goal 工具；若检测到 main 出现 goal，桥接清除并提示用户。

## 5.11 与 schedule 的关系

- schedule 提醒作为 follow-up 进入主会话；主 agent 处理后的回复被镜像到 IM。
- 逾期提醒只在主 agent live 时交付；启动顺序保证主 agent 先于放行入站消息完成恢复。
- 主 agent 忙碌时提醒不会打断当前轮（DSH schedule 自带），会在空闲后作为 follow-up 处理。
