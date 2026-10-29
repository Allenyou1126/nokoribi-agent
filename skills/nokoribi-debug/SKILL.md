---
name: nokoribi-debug
description: 排查 Nokoribi Agent daemon 启动失败、无回复、goal/记忆/定时任务异常时的日志与状态文件顺序。
whenToUse: 当 Nokoribi Agent 服务不健康、消息无回复、启动失败或某个会话行为异常，需要按顺序定位原因时使用。
---

# nokoribi-debug

按顺序定位，每一步都先读证据再改配置。不要删除 `$DSH_HOME` 下的用户数据
（sessions/、memory/、state/），也不要手改运行时状态文件来“修复”。

## 1. 服务与启动

- `systemctl status nokoribi-agent`：是否 `active`、是否 notify ready、
  最近退出码与重启计数。
- `journalctl -u nokoribi-agent -b -n 200`：先看启动段，再看最后一个
  失败 turn。重点关键字：
  - `startup-error` / `failed to start`
  - `ready` / `systemd-notify`
  - 单实例锁 `agent.lock`（另一个 daemon 占用？）
  - `subprocess scope exited before its bootstrap consumed the launch
    request`：D148 的 wrapper/preload 问题（`bin/node-shim` 必须存在）。
- `$DSH_HOME/run/startup-error.json`：启动失败的结构化原因；
  `$DSH_HOME/run/ready.json`：就绪握手的 pid/时间。

## 2. 会话与消息

- `/v1/status`/`/status`：`mainSessionId`、`agentStatus`、`pending
  interactions`、`outboxLength`、`lastRestartReason`。
- `$DSH_HOME/sessions/**.jsonl`：最近一个会话文件按行看事件；
  找 user 消息、tool 调用、错误事件、turn 结束位置。会话文件只读。
- 无回复时：确认渠道（local-test / QQ bot）已启用、`trustedChannels`
  正确、被动窗口未过期；QQ 主动消息可能失败并 defer 到下一条 inbound。
- 卡住/上下文太长：`/clear` 开新主会话（旧会话文件保留，可用
  `session_search` 检索）；不要 `rm` sessions。

## 3. goal / schedule / memory

- goal：`/goal list` 或 `/status full` 的 goals；检查 phase 是否卡在
  running/awaiting；goal 有独立 session id 与 model 路由。
- schedule：`/status full` 的 schedules 与 `storage/schedule.json`；
  逾期提醒在重启后仍应投递（outbox 重发顺序）。
- memory：`/status full` 的 active/archived/invalid/bytes；条目损坏会
  被跳过并计入 invalid；自动注入的快照只读，完整内容用 `memory search`。

## 4. 环境/host 问题

- 默认 sandbox host 需要 `NOKORIBI_SANDBOX_BASE_ENV`（绝对 Nix buildEnv）
  与 `setpriv`；开发机没有 Nix 环境时用
  `NOKORIBI_DEFAULT_HOST=local:workspace`。
- 文件看不到/写不了：确认 host 的 workspace 边界、`/status full` 的
  sandboxes、以及是否在 sandbox 内跑（sandbox 与 workspace 路径不同）。
- 网络/密钥类错误：检查 systemd EnvironmentFile 是否注入了
  `DEEPSEEK_API_KEY` 等变量；journald 里不要打印完整秘密。

## 5. 汇报与修复边界

- 给用户结论时列出：现象、证据（日志行/状态字段/会话事件）、根因、
  已采取的最小修复、残余风险。
- 只改配置/代码并在需要时 `systemctl restart nokoribi-agent`；
  不要删用户数据，不要绕过 Auto review 边界，不要把 secret 写进仓库。
