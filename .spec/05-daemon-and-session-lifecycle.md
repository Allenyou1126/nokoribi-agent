# 05 Daemon 与会话生命周期

本文件覆盖：常驻进程、主会话、状态文件、启动/恢复/关闭/崩溃、`/clear`、`/stop`、outbox、待应答失效、系统通知。goal 子代理的专项生命周期见 [10 Goal 与主动行为](10-goals-and-schedule.md)。

## 5.1 进程形态

- 一个 NixOS systemd 服务（`nokoribi-agent`），专用用户 `nokoribi`，`DSH_HOME=/var/lib/nokoribi-agent`。
- 单实例：启动时在 `$DSH_HOME/run/agent.lock` 上取排他文件锁；取不到则启动失败（避免两个 harness 进程共享同一持久存储；DSH 的驻留 Activation 与子代理所有权只在进程内协调）。
- 生命周期内只有一个主 agent（单主会话）；goal/任务子代理由主 agent 创建。
- 进程退出由 systemd 重启（`Restart=on-failure`）；sd_notify watchdog 处理卡死（见 12/13）。

## 5.2 状态文件

`$DSH_HOME/state/agent-state.json`（原子写；实现可用 `dsh-atomic-write` 或自有实现）。

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
  "lastVersion": "0.1.0"
}
```

- `mainSessionId`：主会话的稳定 id；首次启动创建并写入，之后 resume。
- `goals[]`：桥接通过 `goal/changed` + `listChildren` 识别的 goal 子代理；用于重启恢复与 `/goal` 命令。
- `cleanShutdown`：SIGTERM 正常退出时置 true；启动时若为 false，视为崩溃恢复并发送通知。
- 归档索引 `$DSH_HOME/archive/goals.jsonl`：每行一条归档记录（见 10）。

## 5.3 启动顺序

1. 取得单实例锁。
2. 读取/校验 `agent-state.json`；损坏则保留原文件并重命名备份，按首次启动处理（记录错误日志）。
3. 确保目录结构存在：`$DSH_HOME/{state,sessions,memory,archive,sandboxes,run,logs?}`（日志由 journald，不强制本地目录）。
4. 挂载 Cordis 插件树（bundle + Nix overlay）；等待服务就绪（agent-loop、session persistence、tools、prompt、commands、approval 等）。
5. 创建或恢复主 agent：
   - 有 `mainSessionId` 且持久化会话存在 → `ctx.agents.resume({ sessionId })`；
   - 否则 `ctx.agents.create({ sessionId: 新 id, ... })` 并写回 state。
   - DSH 会在 resume 时补写 `interruptedTurnClosers`，修复中断轮次。
6. 挂载渠道 driver，缓冲入站消息（不立即注入，等恢复完成）。
7. 恢复 goal 子代理（见 10.6）；逐个冷恢复，失败记录并通知。
8. 清空内存中的待审批/待提问状态；若上次为崩溃恢复，通知用户"待应答已失效"。
9. 重发 outbox 中未发送消息（at-least-once）。
10. 若非 clean shutdown，发送"进程重启，已恢复会话"通知（⚠️）。
11. 放行缓冲的入站消息，按正常 ingress 处理。
12. schedule 的逾期提醒在主 agent live 后由 DSH 交付（作为 follow-up）。

> 启动顺序中的 4–5 与 12 的时序需要在实现时验证：Schedule 只给"插件加载后创建"的 agent 安装工具；因此主 agent 必须在 Schedule 插件就绪后创建/恢复。`agent-app` 应作为 app-boot 的启动提供方在准备完成后执行主会话生命周期。

## 5.4 正常关闭（SIGTERM）

1. 停止接受新入站消息（driver 停止/关闭）。
2. 若主 agent 正在运行：有限时间等待当前轮完成（配置，草案 20–30 秒；systemd `TimeoutStopSec` 要大于它）；超时则 `cancel()`，让会话记录中止状态。
3. 中止所有待审批/提问（approval 以 cancelled/denied 结算，question 以错误结算），清空内存状态。
4. 对 goal 子代理：不逐个等待；通过 Cordis teardown / `drainContinuableDescendants([mainAgent])` 释放；它们的状态在会话日志中，重启恢复。
5. flush 会话与 state（`ctx.sessions.flush`、原子写 state），标记 `cleanShutdown=true`。
6. dispose 主 agent handle；退出进程（0）。

> 关闭时不在 outbox 中的"正在生成的回复"会丢失；若已生成但尚未入队，属于可接受窗口。所有已入 outbox 的消息会重发。

## 5.5 崩溃恢复

场景：kill -9 / OOM / 断电 / watchdog 重启。启动时 `cleanShutdown=false`。

- 主会话：resume；DSH 补写 interrupted turn closers；模型下一次请求会看到中止的工具调用与结果。
- 队列消息：inbox 通过 `agent/inbox/spliced` 持久化，resume 后应恢复。
  - **待验证**：resume 后 driver 是否会自动处理已有 inbox；若不会，桥接会用自己记录的 ingress 待处理队列重放（同一 messageId 去重）或注入一条系统提示唤醒，二选一在实现时决定。
- 待审批/提问：进程内 promise 已消失；重启后无法恢复。启动时清空 broker 状态，并给用户发提示。
- goal 子代理：按 state 恢复（见 10.6）；可能多跑一轮（冷恢复需要发送一条"继续"消息）。
- outbox：未发送消息重发；若崩溃前已发送但未标记，可能重复（at-least-once）。
- sandbox：每个 session 的 sandbox 目录落盘；TTL 计时按 lastUsed 恢复；重启后首次使用若仍在 TTL 内可复用，过期则回收重建。
- 重启通知：只在 `cleanShutdown=false` 或恢复失败时发送，避免每次部署都刷屏。

## 5.6 `/clear` 与 `/new`

语义：**新建主会话，旧会话归档保留**（D17）。

流程：

1. 若存在活跃 goal 子代理：`interrupt` 当前轮 →（live 时）`ctx.goals.clear(child)` → `drainContinuableChildren(main, childIds)` 释放；从 `goals[]` 移除并写入归档索引（作为"被 clear 归档"）。
2. 若存在待应答：全部中止并通知用户。
3. dispose 主 agent handle；旧会话保持在 DSH 会话库中（不删除）。
4. 生成新的 `mainSessionId`，`ctx.agents.create()` 新会话；写回 state；清空 outbox 中属于旧会话的未发送回复？——**待实现决策**：草案为保留 outbox（已生成的消息仍发给用户）但给旧会话 id 标记；新消息进入新会话。
5. 删除旧会话对应的 sandbox 目录（per-session scope）。
6. 发送确认消息："已新建会话，旧会话已归档"。

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
- 进程重启/`/clear`/`/stop`：全部中止；发提示说明失效。
- 提示文本带前缀与目标标识（审批 🔐、提问 ❓；子代理审批带 goal 短 id），用户回复按编号/允许/拒绝/自定义文本解析。
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
