# 13 测试与运维

## 13.1 测试策略（D127/D128/D129/D130）

- 框架：**Vitest**。
- 无 GitHub Actions CI；验收通过本地 `nix flake check`（其中包含单元/集成测试、package 构建、module eval）。
- **不做 NixOS VM 测试**；NixOS 部署层靠手工验收清单（12.12）。
- 自动化为主：每阶段有对应测试；手工验收只做探索性确认。
- 测试类型：
  1. 单元测试
  2. 进程内集成 harness
  3. 进程级场景/恢复测试
  4. flake checks（构建 + 静态配置检查）

M1 落点：单元测试在各包 `test/`；进程级场景在 `tests/process/`，用 `dsh-llm-mock-server` + 临时 DSH_HOME + launcher 子进程；命令为 `pnpm test` 与 `pnpm test:process`。flake checks 留到 M6。

M2 落点：`tests/process/m2.test.ts` 用脚本化 LLM（按 model/system 路由）覆盖 reviewer allow/deny/批准/拒绝/超时/提问/steer/stop/clear/残留交互；`tests/integration/m2-child-approval.test.ts` 用 `dsh-agent-loop-testkit` + fake shell + fake channel 覆盖 child → broker → IM。

M3 落点：`packages/shell-bash/test/` 覆盖 host 协议、router façade、bash(host)、background job、discovery、hosts 提示词；`packages/shell-host-sandbox/test/` 覆盖 command wrapper、meta、TTL/reset、guarded PATH、setpriv/nix 缺失、`sandbox`/`sandbox_packages`；`packages/shell-host-local/test/` 覆盖 extraPackages 与 background；`tests/process/m3.test.ts` 覆盖 local、sandbox、未知 host + discovery、background job、`/clear` 清理。真实 Nix/sudo 为手工/门控集成验收。

## 13.2 测试替身

- **fake ChannelDriver**：内存 driver，记录入站/出站，可脚本化注入消息与失败。
- **scripted fake LLM**：不调用真实 API；按脚本返回 assistant 文本/工具调用；用于 agent-loop、reviewer、记忆提炼测试。
- **fake shell host**：内存 host provider，返回预设输出/退出码，模拟 background/超时/错误；用于 channel/agent 集成测试。
- **fake clock**：TTL、超时、退避重试测试；避免真实等待。
- **临时 DSH_HOME**：每个测试用独立目录，结束后清理；保证并发测试隔离。
- **测试 kit**：如 DSH 提供的 `dsh-agent-loop-testkit` 可用则复用；否则自建最小 harness。

## 13.3 测试矩阵

| 子系统 | 单元 | 集成 | 进程级 |
|---|---|---|---|
| channel ingress | allowlist、去重、命令解析、delivery 解析 | 消息→steer/followup、未知命令、待应答优先 | 重启后去重持久 |
| interaction broker | 解析、超时、串行 FIFO、提示格式 | approval deny→用户允许/拒绝；question 多选/自定义 | 崩溃后状态清理 |
| outbox/delivery | 分段、markdown 降级、seq、重试退避 | turn 结束取最后文本、空回复、系统通知、多 chat 路由 | 重启重发/重复窗口 |
| commands | `/steer`/`/queue` 模式、`/goal` 子命令解析 | 命令执行与结果回传 | `/clear` 后命令状态 |
| daemon/state | 状态文件 schema/原子写、锁 | 启动/关闭顺序、缓冲入站 | kill -9 恢复、SIGTERM 干净退出 |
| goal | tracking 状态机、短 id、归档索引 | 创建/汇报/归档/clear、主会话 goal 拦截 | 冷恢复 + re-arm、失败通知 |
| memory | 文件格式、检索、upsert/forget、去重 | 工具调用、提炼子代理 | 跨重启检索 |
| prompt | 模板渲染、SOUL 转义、section 顺序 | 组装快照（不含动态值） | 启动加载 |
| shell hosts | host 路由、id 解析、能力校验、命令包装/TTL/meta | bash(host)、未知 host、background job、发现工具、fake sandbox base | local 执行、sandbox 隔离/sudo、`/clear` 清理 |
| sandbox | command wrapper、sidecar、generation、TTL sweep、guard、setpriv/nix 缺失 | `sandbox`/`sandbox_packages`、reset 保护、fake subprocess | 手工 Nix buildEnv：cp/rsync、sudo 失败、TTL/reset |
| reviewer patch | 两档路由、sudo 启发式、JSON 校验、超时 | 双阶段复审、fail closed、child 审批桥接 | 进程级 allow/deny/超时 |
| interaction broker | 提示格式、解析、超时、串行、abort | approval/question 端到端、steer 旁路、stop/clear | 重启残留清理 |
| NixOS module | option schema/eval | overlay 生成快照 | 手工（12.12） |

## 13.4 关键场景

1. **注入语义**：主 agent 正在执行一个长工具（fake shell host 阻塞）；入站消息不取消工具；轮次继续后模型在下一步看到消息。
2. **审批**：Auto review（fake reviewer）返回 deny → strong 复审 → broker 发提示 → 用户回复允许 → 工具执行一次；拒绝/超时则失败；reviewer 技术失败 → 调用失败且不询问。
3. **Crash**：进程发消息 → 工具执行中 kill -9 → 重启 → 会话恢复、inbox 恢复（或重放）、outbox 重发、待应答通知失效。
4. **Goal 重启**：goal child 活跃 → kill daemon → 重启 → 冷恢复消息 → re-arm → 下一轮继续 → 报告主 agent。
5. **归档**：goal complete → 主 agent 询问 → 用户 `/goal archive` → state 移除、archive JSONL 追加、sandbox 删除、session 保留。
6. **Sandbox**：默认 host 执行；TTL 到期回收；reset 拒绝有后台任务；`sandbox_packages` add 后可执行；sandbox 内 sudo 失败。M3 自动化用 fake baseEnv 覆盖 local/sandbox/background/`/clear`；真实 Nix 按 12.12 手工。
7. **Memory**：任务结束提炼子代理写入；跨会话 search 命中；forget 归档。
8. **Schedule**：创建 1 分钟提醒（或 fake clock）→ 到期 follow-up → 主 agent 回复镜像到测试通道。

## 13.5 flake checks（草案）

- `checks.<system>.unit`：Vitest 单元测试。
- `checks.<system>.integration`：进程内集成 harness 测试。
- `checks.<system>.package`：构建发行版。
- `checks.<system>.module-eval`：NixOS module 选项组合 eval（不启动 VM）。
- 可选 `checks.<system>.lint`：tsc/oxlint。
- 本地运行：`nix flake check`。

## 13.6 日志

- 全部 stdout/stderr → journald。
- 行格式（草案）：`<iso time> <level> <module> <message> key=value ...`；关键事件带结构化字段：
  - `turn.start` / `turn.end`（agent id、turn id、耗时、token 用量可选）
  - `goal.changed`（短 id、phase、rounds）
  - `interaction.request/decision`（kind、agent、decision、reason）
  - `channel.send.failed`（channel、message id、attempts）
  - `daemon.recovery`（原因、恢复项）
  - `sandbox.reset/reclaim`（session、generation）
- 不打印完整用户消息内容到日志（只记录 id/摘要），避免敏感信息；会话 JSONL 本身保存内容。
- sudo 日志由 sudo 自身进 journald；不开启 `log_output`。
- 日志保留由系统 journald 配置决定，本项目不额外配置。

## 13.7 `/status`

- 摘要（默认）：version、uptime、agentStatus（running/idle）、mainSessionId、model、permission、活跃 goal 数、待应答数、outbox 长度。
- `/status full`：
  - 每个 goal：短 id、phase、rounds、child 运行状态、sandbox generation/TTL；
  - 每个 sandbox：session、目录、创建/最近使用、已加包；
  - 最近错误（最近 N 条系统通知级别）；
  - last restart reason/时间；
  - permission preset（auto）；reviewer 两档与超时；
  - 依赖版本（DSH、发行版）。
- 不展示 API key、完整消息内容、sandbox 包以外的敏感信息。
- 同时提供给本地测试通道 `GET /v1/status`（JSON）。

## 13.8 运维手册（草案）

### 常用命令

```sh
systemctl status nokoribi-agent
systemctl restart nokoribi-agent
journalctl -u nokoribi-agent -f
journalctl -u nokoribi-agent --since "1 hour ago"
```

### 发消息验收（测试通道）

```sh
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"status"}'

curl -s "http://127.0.0.1:8787/v1/outbound?after=0" \
  -H "Authorization: Bearer $TOKEN"
```

### 升级

1. 更新 flake input/版本（DSH 整批 bump + reviewer vendor 更新）。
2. `nix flake check`（本地）。
3. `nixos-rebuild switch`。
4. `systemctl status` + journald 检查恢复。
5. 手工验收清单（12.12）按需执行。
6. 不做备份/快照；回滚需自行承担 session format 风险。

### 故障排查

| 现象 | 检查 |
|---|---|
| 服务起不来 | journald；单实例锁；DSH_HOME 权限；profile/overlay patch 错误 |
| 无回复 | `/v1/status`；agent 是否 running；outbox 是否积压；reviewer 是否卡在审批 |
| 审批没提示 | broker 日志；driver 是否在线；待应答是否已超时 |
| goal 不续跑 | goal 是否 active/armed；round 额度；child 是否 live；restart 后是否 re-arm |
| sandbox 命令失败 | host 是否启用；sandbox 是否被回收；nix/buildEnv 是否可用；是否触发 no_new_privs |
| 升级后会话打不开 | session format 不兼容（无自动回滚）；人工评估 |

### 归档查看（无 web-debug）

- `$DSH_HOME/archive/goals.jsonl` 查归档索引。
- session 文件在 `$DSH_HOME/sessions/`（DSH JSONL 格式）；按 sessionId 查找，人工/脚本查看。
- 不提供网页界面（D108）。

## 13.9 观测缺口（已接受）

- 没有 metrics/OTel/告警。
- 没有集中式日志。
- 没有 NixOS VM 自动化测试。
- 没有自动备份/回滚。
- 没有 web-debug。
- 日志只到 journald，保留策略由系统决定。
