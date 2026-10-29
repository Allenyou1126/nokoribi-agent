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

M4 落点：`packages/agent-app/test/` 覆盖 goal 命令解析、tracker（sessionId/goalId 分离、短 id、轮次）、归档 JSONL、main 工具限制；`packages/prompt/test/` 覆盖 goal section 与 `tool:goal` 改写；`tests/process/m4.test.ts` 覆盖 `/goal new` 完成/归档、`start_goal`、main 隐藏、pause/resume、SIGKILL 冷恢复、`/clear`、多 goal、恢复失败与 `send_message` 汇报。M4 进程测试用 local host，不依赖 Nix。

M5 落点：`packages/memory/test/` 覆盖 frontmatter、检索/排序、upsert/forget/supersedes、密钥拒绝与损坏条目；`packages/agent-app/test/` 覆盖 session bridge、curator prompt、full status 渲染、goal route 解析；`packages/prompt/test/` 覆盖 memory/schedule 段与顺序；`packages/shared/test/` 覆盖 recent log 缓冲与版本读取；`tests/process/m5.test.ts` 覆盖 memory 跨重启、提醒到期、SIGKILL 逾期、`/clear` 删除旧提醒、goal 模型 allowlist、curator 写入与 `/status full`/time-context。Schedule 使用 2 秒真实定时器（上游 Host 服务没有 fake clock seam）；M5 仍用 local host + scripted LLM。

M6 落点：`packages/shared/test/systemd.test.ts` 覆盖 notifier no-op、READY/WATCHDOG/STOPPING 参数、`WATCHDOG_USEC` 间隔与失败路径；`packages/shared/test/log.test.ts`/`paths.test.ts` 覆盖 `NOKORIBI_LOG_LEVEL`、`homeDir`；`packages/agent-app` 与 bundle 覆盖 `goalDefaultMaxRounds`；`packages/channel-local-test`/`shell-host-*` 覆盖 `enabled`；`tests/process/m6.test.ts` 用临时 fake `systemd-notify` 脚本验证 READY/心跳/STOPPING，并验证默认 goal 轮次。Flake 侧：`package`、`package-smoke`、`unit`、`module-eval`；NixOS 12.12 仍为手工。

M7 落点（已实现，2026-10-27）：`packages/channel-core/test/` 的 outbox/format/routing 单测覆盖 reply/actions 持久化、旧文件兼容、`replySeq` 分配、deferred TTL/上限/移除、分段前缀预留与 `maxChunks` 截断、通知目标选择；`tests/integration/m7-channel-routing.test.ts` 用双 FakeDriver + `dsh-agent-loop-testkit` 覆盖 per-turn 路由、`trustedChannels`、notice active 回退/defer 补投、`NonRetryableDeliveryError`、`PassiveReplyExpiredError`、缺 driver、槽位截断、`restoreActiveChat`、health 与 actions；`tests/integration/m2-child-approval.test.ts` 同步新 `send()` 签名。实测：`pnpm test` 44 文件/328 测试；`pnpm test:unit` 42 文件/314 测试；`pnpm test:process` 6 文件/42 场景；`nix flake check`（package/unit/package-smoke/module-eval）通过。

M8 落点（已实现，2026-10-27）：`packages/channel-qq-bot/test/` 共 7 文件/44 测试，覆盖事件归一化（C2C/群 @、忽略全量事件/附件/机器人消息）、被动优先/`replySeq`/超窗回退、错误码分类、长度/Markdown 回退、频控、token 缓存/401 刷新、gateway Identify/READY/断线/致命关闭与配置。`tests/integration/m8-qq.test.ts` 用 `dsh-agent-loop-testkit` + 真实 driver + fake transport 覆盖 trustedChannels、被动回复、active 关闭时 defer/补投。`tests/process/m8-qq.test.ts`（10 场景，零依赖 fake QQ server：token/发送 HTTP + WS 握手/帧）覆盖启动、C2C/群 @、去重、超窗 active、active 失败 defer、被动过期重试、token 刷新、断线 Resume、SIGTERM 与双渠道路由。实测：`pnpm test` 52 文件/374 测试；`pnpm test:process` 7 文件/52 场景；`nix flake check`（package/unit/package-smoke/module-eval）与 `nix build .#default` 通过。真实 Bot 14 项门禁/17.8.2 仍待手工验收，不进入 flake。

M9 落点（已实现，2026-10-29）：`packages/channel-core/test/` 覆盖 broker 审批 action 生成/`handleAction`/过期与重复点击、service 入站 action 路由（action 权威、失效不回退文本）、outbox actions 透传；`packages/channel-qq-bot/test/` 覆盖 C2C keyboard body、群聊剥离、interaction 归一化、ack 调用、intents 与降级、markdown 回退保留 keyboard；`packages/channel-local-test/test/` 覆盖 inbound `action`；`tests/integration/m9-qq-buttons.test.ts` 用真实 driver + fake transport 走审批按钮端到端；`tests/process/m9-qq-buttons.test.ts` 用 daemon + fake QQ server 覆盖“提示带 keyboard → 注入 INTERACTION_CREATE → 工具执行/拒绝、文本 fallback、重启后失效、群聊无按钮、intent 降级”。实测 `pnpm test` 54 文件/403 测试；`pnpm test:unit` 50 文件/383 测试；`pnpm test:process` 8 文件/58 场景；真实平台 #15–#20 门禁不进入 flake。

M10 落点（已实现，2026-10-29）：`packages/shell-bash/test/` 覆盖 `ShellTerminalLaunch` 协议、`terminal` 能力位双向校验与 `terminalLaunch` 路由、`onChange`、发现工具 `terminal` 字段按实际注册 backend 隐藏、hosts 提示词终端指引；`packages/terminal-host/test/` 5 文件/33 测试用注入的 fake `spawnTerminal` 覆盖 per-host backend 注册/注销/串行、launch 规格（argv/cwd/env）、上游 env 透传、release 幂等与失败清理、缺 owner 上下文报错、`enabled=false`；`packages/shell-host-*` 覆盖 local launch 与 sandbox `pins`/TTL/reset/dispose 拒绝/`terminalSessions`/`buildSandboxTerminalArgv`；`packages/reviewer/test/` 覆盖 `exemptTools` schema 默认与自定义解析；`packages/agent-app/test/terminal-cleanup.test.ts` 覆盖 5s 有界清理与失败降级；`tests/process/m10-terminal.test.ts` 用真实 `dsh-subprocess-local` PTY（local host）4 场景验证 open/send/read/list/close、状态持久、`/clear` 清理、`enabled=false` 不暴露工具与提示、SIGTERM；`tests/process/m10-web.test.ts` 用 fake LLM + 本地 fake DeepSeek 搜索 HTTP 2 场景覆盖 web 工具不触发 reviewer、`bash` 仍审查、非公网 fetch 被拒、空豁免列表恢复全审。sandbox 终端与真实搜索/API/公网抓取走手工门禁（[12.14](12-nixos-deployment.md) 与 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)）。实测（本次施工观察，2026-10-29 21:42）：`pnpm test:unit` **56 文件/438 测试**；`pnpm test` **60 文件/458 测试**；`pnpm test:process` **10 文件/64 场景**；`pnpm check`、`nix flake check`、`nix build .#default`、`nix run .#default -- --version` 均通过（2026-10-29 最终门禁）。flake unit 不跑真实 PTY 测试。

M11–M17 落点（已实现，2026-10-30）：

- **M11 会话检索**：`tests/process/m11-session-search.test.ts`（2 场景，真实 sqlite + fake LLM：历史会话 sentinel 在 `/clear` 后经 `session_search` 命中且工具结果进入后续请求、索引文件创建；停用 env 隐藏工具且不建索引）。
- **M12 技能**：`tests/process/m12-skills.test.ts`（3 场景：bundled 目录 → durable catalog → `skill` 工具加载正文；`/nokoribi-debug` 用户消息经未知斜杠透传注入 `<skill_content>`；`skill.enable=false` 无 catalog/tool）。`packages/prompt/test/` 覆盖 `memorySection`/safety 段。
- **M13 MCP**：`tests/process/m13-mcp.test.ts`（1 场景：测试生成的 patch 插入 mcp-client 行 → 零依赖 fake MCP stdio server（`support/fake-mcp.ts`，JSON-RPC initialize/tools/list/tools/call）→ fake LLM 调用 `mcp__fake__echo` → 结果回传且 reviewer 观察到审查）。streamable-http fake 变体未自动化（22.9 记录）。
- **M14 消息媒体**：`packages/channel-core/test/service-media.test.ts`（7）、`channel-qq-bot/test/driver.test.ts`（图片/文件新增 10）、`channel-local-test/test/http.test.ts`（图片注入 + 附件下载）、`tests/integration/m14-*`（2）、`tests/process/m14-message-media.test.ts`（4：local-test 图片 → 模型请求/session JSONL 含 image block、存储失败降级文本、fake QQ WS 图片下载 → 模型、`send_to_user` 文件 → local-test 元数据 + `/v1/attachments/<id>` 字节一致）。
- **M15 提问按钮**：`packages/channel-core/test/broker.test.ts`（新增 7 单选 action/结算/token 作用域/fallback/截断/超时清理）、`channel-qq-bot/test/{driver,gateway}.test.ts`（question keyboard/C2C/门禁/ack）、`tests/integration/m15-*`（3）、`tests/process/m15-question-buttons.test.ts`（2：local-test action 回调结算 `ask_user_question`、数字文本 fallback 仍结算）。
- **M16 记忆注入**：`packages/memory/test/`（6 文件/91 测试：frontmatter pinned 兼容、snapshot 10、inject 11、store/tool/secret）、`packages/prompt/test/`（26）、`packages/agent-app/test/status.test.ts`（4）、`tests/process/m16-memory-inject.test.ts`（6：pinned 写入 → 下轮快照 + `/status full` 字段、main-only vs goal child、注入关闭、超预算 footer、重启不重复、`NOKORIBI_MEMORY_ENABLED=false` 无 memory 段/工具）；m5 进程回归 7/7。
- **M17 OpenViking**：`tests/process/m17-openviking.test.ts`（2：不可达 endpoint 启动不崩 + 本地 memory 工具/存储关闭；零依赖 fake server（`support/fake-openviking.ts`）下 `/health`/recall (`/api/v1/search/search`) 注入模型请求、`/api/v1/sessions/*/messages` capture、正常回复与关闭）；真实 server spike 未自动化的部分见 V18。
- **实测（2026-10-30 最终门禁）**：`pnpm check` 通过；`pnpm test:unit` **60 文件/512 测试**；`pnpm test` **66 文件/537 测试**；`pnpm test:process` **17 文件/84 场景**；`nix flake check --offline`（package/unit/package-smoke/module-eval ×4）通过；`nix build --offline .#default` 与 `nix run --offline .#default -- --version`（`nokoribi-agent 0.1.0`）通过。真实平台/目标机项（V16–V22）仍待执行，不进入 flake。

## 13.2 测试替身

- **fake ChannelDriver**：内存 driver，记录入站/出站（含 `kind/reply/actions`），可配置 `capabilities`、`canDeliver`、`health`、一次性/永久失败；M7 集成用双 driver 验证 per-turn 路由与通知回退。
- **scripted fake LLM**：不调用真实 API；按脚本返回 assistant 文本/工具调用；用于 agent-loop、reviewer、记忆提炼测试。
- **fake shell host**：内存 host provider，返回预设输出/退出码，模拟 background/超时/错误；用于 channel/agent 集成测试。
- **fake clock**：TTL、超时、退避重试测试；避免真实等待。
- **fake terminal spawn（M10 已实现）**：向 `BashTerminalBackend` 注入的 `spawnTerminal` stub，记录 argv/cwd/env 并返回可控 `SubprocessTerminalHandle`；用于 backend/launch/pin 单测，不需要真实 PTY。
- **fake PTY（M10 已实现）**：真实 `dsh-subprocess-local` PTY 仅用于本地进程测试（`tests/process/m10-terminal.test.ts`）；flake unit 与无 PTY 环境不跑。
- **fake web provider（M10 已实现，进程层）**：本地 fake DeepSeek Messages 搜索 HTTP（`tests/process/support/fake-web-search.ts`）与 non-public fetch 用例；用于 web 工具注册/豁免/阻断断言，禁止真实网络。未单独为 `ctx.web` 写单元 fake provider 包。
- **fake MCP stdio server（M13 已实现）**：零依赖 JSON-RPC 2.0 stdio 进程（`tests/process/support/fake-mcp.ts`），覆盖 initialize/tools/list/tools/call；用于 `mcp__<server>__<tool>` 桥接与 reviewer 审查断言。
- **fake OpenViking server（M17 已实现）**：零依赖 HTTP server（`tests/process/support/fake-openviking.ts`），覆盖 `/health`、sessions、system-status、fs-ls/content-read、skills、`/api/v1/search/*`、`sessions/*/messages|commit`；用于无 server 启动与 recall/capture 断言。
- **fake attachment service（M14）**：`tests/integration/{m2,m7,m8,m9}.test.ts` 向 channel-core 的 `attachments` 静态注入提供 fake（图片保存/文件流）；进程测试用真实 `dsh-attachment-local`。
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
| memory | 文件格式、检索/排序、upsert/forget/supersedes、密钥拒绝 | 工具调用、curator prompt/触发 | 跨重启检索 |
| schedule | bridge ready-gate、catalog/clear（上游工具由 DSH 覆盖） | 到期 follow-up、`/clear` 删除旧任务 | 逾期重启交付 |
| status | full 渲染、recent log、sandbox 归一化 | `/v1/status?full=1`、`/status full` | 进程级字段完整性 |
| prompt | 模板渲染、SOUL 字面量、section 顺序 | 六段组装快照（不含动态值） | 启动加载 |
| shell hosts | host 路由、id 解析、能力校验、命令包装/TTL/meta | bash(host)、未知 host、background job、发现工具、fake sandbox base | local 执行、sandbox 隔离/sudo、`/clear` 清理 |
| sandbox | command wrapper、sidecar、generation、TTL sweep、guard、setpriv/nix 缺失 | `sandbox`/`sandbox_packages`、reset 保护、fake subprocess | 手工 Nix buildEnv：cp/rsync、sudo 失败、TTL/reset |
| reviewer patch | 两档路由、sudo 启发式、JSON 校验、超时 | 双阶段复审、fail closed、child 审批桥接 | 进程级 allow/deny/超时 |
| interaction broker | 提示格式、解析、超时、串行、abort | approval/question 端到端、steer 旁路、stop/clear | 重启残留清理 |
| channel-core M7 | reply context/replySeq、trustedChannels、canDeliver、NonRetryableDeliveryError/PassiveReplyExpiredError、缺 driver 短路、actions 持久化、deferred 上限/TTL | per-turn 多 driver 路由、notice 回退/defer 补投、双 driver 集成、actions 最后一段 | 重启后被动上下文/超窗（进程回归覆盖 outbox 重发） |
| channel-qq-bot（M8） | 事件归一化、被动/主动策略、错误分类、频控、config、gateway/rest | fake WS+REST + core 的 trustedChannels/defer | daemon + fake QQ server、重连/token 刷新/双渠道 |
| action/按钮（M9 已实现） | broker action 生成/handle、token 生命周期、service action 路由、outbox actions 透传 | QQ C2C keyboard body/群聊剥离、interaction 归一化/ack、local-test action 注入 | 审批按钮端到端、文本 fallback、超时/重启失效、intent 降级 |
| terminal-host（M10 已实现） | per-host backend 注册/注销、launch 规格（argv/cwd/env）、release 幂等/pin、封装 handle 清理、fake spawnTerminal | local 真实 PTY（open/send/read/list/close、状态持久、`/clear`、disabled、SIGTERM）、sandbox launch/pin 单测 | daemon 清理顺序、`/clear`/goal archive/重启无残留；owner 隔离由上游 registry |
| web（M10 已实现） | tool 注册/参数校验、provider pin/切换（配置层）、错误码、截断、`exemptTools` schema | fake 搜索 HTTP + fake LLM：web 不审、bash 仍审、空列表恢复全审、非公网 fetch 阻断 | 真实搜索/抓取/API provider（手工门禁 G4–G6）、网络失败降级 |
| session search（M11 已实现） | 工具注册/配置、FTS 派生索引路径与 openAt | 真实 sqlite 跨会话检索、停用分支、workspace 授权 | 历史会话 sentinel 命中 + 索引文件/无索引断言（进程测试） |
| skill（M12 已实现） | 目录发现/frontmatter/catalog 渲染、`/name` 透传 | durable catalog、`skill` 工具加载、`<skill_content>` 注入、停用 | bundled 根 + `NOKORIBI_SKILL_*`（进程测试） |
| MCP client（M13 已实现） | 配置/命名（`mcp__<server>__<tool>`）、env 间接 | fake stdio MCP server 工具发现/调用 + reviewer 审查 | daemon patch 插入 client 行（进程测试） |
| message media（M14 已实现） | 图片 → attachment → image block、files/actionKind outbox、QQ 下载/上传、local-test 端点 | local-test/QQ fake 图片入站、`send_to_user` 文件 e2e | 进程：模型 request image block、文件字节一致；真实平台 V16 手工 |
| question buttons（M15 已实现） | broker 单选 action/token/结算/fallback、QQ keyboard/门禁 | action 回调与文本 fallback 双向结算 | local-test action 进程测试；真实平台 V17 手工 |
| memory inject（M16 已实现） | pinned/snapshot 渲染/预算/footer、inject 刷新/失效/mainOnly | fake LLM 下快照出现/隔离/关闭、/status full 字段 | 跨轮/重启/停用本地记忆（进程测试） |
| OpenViking（M17 已实现） | launcher bundle/env 映射、无 server 降级 | fake server recall/capture、本地 memory 互斥 | 不可达 + fake server 两场景；真实 server V18 手工 |
| NixOS module | option schema/eval | overlay 生成快照（含 mcp 动态行） | 手工（12.12 / 12.13 / M11–M17 项） |

## 13.4 关键场景

1. **注入语义**：主 agent 正在执行一个长工具（fake shell host 阻塞）；入站消息不取消工具；轮次继续后模型在下一步看到消息。
2. **审批**：Auto review（fake reviewer）返回 deny → strong 复审 → broker 发提示 → 用户回复允许 → 工具执行一次；拒绝/超时则失败；reviewer 技术失败 → 调用失败且不询问。
3. **Crash**：进程发消息 → 工具执行中 kill -9 → 重启 → 会话恢复、inbox 恢复（或重放）、outbox 重发、待应答通知失效。
4. **Goal 重启**：goal child 活跃 → kill daemon → 重启 → 冷恢复消息 → re-arm → 下一轮继续 → 报告主 agent。
5. **归档**：goal complete → 主 agent 询问 → 用户 `/goal archive` → state 移除、archive JSONL 追加、sandbox 删除、session 保留。
6. **Sandbox**：默认 host 执行；TTL 到期回收；reset 拒绝有后台任务；`sandbox_packages` add 后可执行；sandbox 内 sudo 失败。M3 自动化用 fake baseEnv 覆盖 local/sandbox/background/`/clear`；真实 Nix 按 12.12 手工。
7. **Memory**：任务结束提炼子代理写入；跨会话 search 命中；forget 归档。
8. **Schedule**：创建 1 分钟提醒（或 fake clock）→ 到期 follow-up → 主 agent 回复镜像到测试通道。
9. **QQ Bot（M8）**：fake QQ 网关推 C2C/群 @ 事件 → agent 回复 → REST 收到带 `msg_id/msg_seq` 的被动请求；重复事件去重；被动超窗 → 主动尝试/失败；active 失败 defer 到下一次入站；被动过期码 → 清 reply 后 active 重试；断线 Resume/重连后可继续收发；token 401 刷新；`40054005` 视为成功；文件/群全量/机器人消息被忽略。
10. **QQ 按钮审批（M9 已实现）**：fake reviewer deny → 审批提示（C2C 带 keyboard）→ fake WS 推 `INTERACTION_CREATE` type=11 → PUT ack → broker 结算 → 工具执行/拒绝；文本回复路径回归；超时/daemon 重启后点击旧按钮提示失效；群聊提示不带 keyboard；`approvalButtons=false` 或 intent 受限时降级文本。
11. **持久终端（M10 已实现）**：local host `terminal_open` → `terminal_send` 改变 cwd/env → 后续 `terminal_send`/`terminal_list` 看到持久状态 → `terminal_close` 清理进程树；`/clear`、daemon SIGTERM 前 terminals 关闭且 sandbox `disposeSession` 不因 pin 失败（进程测试已覆盖）；goal child 归档与 main/child owner 隔离由上游 owner scope + goal 清理接线保证（未单列进程场景）。
12. **Web 工具（M10 已实现）**：fake 搜索 HTTP 下 `web_search` 合并 query/上限、`web_fetch` 非公网 URL 返回 blocked；`web_search`/`web_fetch` 不触发 fake reviewer，`bash` 仍触发；`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 恢复全审（已覆盖）。真实 provider 的缺 key/歧义/截断错误由上游行为；真实搜索与公网抓取走手工门禁（G4–G6）。
13. **会话检索（M11 已实现）**：先建一条含唯一 sentinel 的主会话 → `/clear` → 新会话让模型调用 `session_search` → 命中旧会话并把工具结果带入后续请求；`NOKORIBI_SESSION_SEARCH_ENABLED=false` 时不暴露工具且不建 FTS 索引。
14. **技能（M12 已实现）**：bundled 技能出现在 durable catalog → `skill` 工具加载全文；`/skill-name` 用户消息经未知斜杠透传注入 `<skill_content>`；`NOKORIBI_SKILL_ENABLED=false` 时无 catalog/工具。
15. **MCP（M13 已实现）**：测试 patch 插入 `mcp__fake__echo` client 行 → fake stdio JSON-RPC server → 模型调用工具 → 结果回传且 reviewer 观察到审查（daemon-ready 与 MCP discovery 有 100–300ms 竞态，测试用消息轮询等待工具出现）。
16. **消息媒体（M14 已实现）**：local-test/QQ 入站图片 → session JSONL/模型请求出现 image block（无法保存时降级纯文本）；`send_to_user` 工作区文件 → local-test outbox 元数据 + `/v1/attachments/<id>` 字节与源文件一致。
17. **提问按钮（M15 已实现）**：单选问题带 C2C keyboard → local-test 注入 action 回调 → `ask_user_question` 结算；数字文本 fallback 仍结算；群聊/多选保持文本。
18. **记忆注入（M16 已实现）**：memory 工具写 pinned → 下一轮主会话请求出现快照且 `/status full` 显示 pinned/snapshotChars/inject；goal child 无快照；关闭/超预算/重启去重/停用本地记忆均覆盖。
19. **OpenViking（M17 已实现）**：`NOKORIBI_OPENVIKING_ENABLED=true` + 不可达 endpoint → daemon ready、本地 memory 工具/提示词关闭、无崩溃；fake server 下 `/health`、recall 注入、capture 写入均观察。真实 server 与 NixOS 目标机走 V18/V19 手工门禁。

## 13.5 flake checks

- `checks.<system>.package`：构建发行版（official Node runtime + 生产依赖）。
- `checks.<system>.package-smoke`：wrapper `--version` / `--help` 与 store 布局；M8 增加 SDK `./protocol` 从生产闭包导入、运行时 `WebSocket`/`fetch` 全局可用断言（官方 Node 运行时）；M10 增加 `dsh-terminal`/`dsh-terminal-bash`/`dsh-web`/`dsh-tool-web`/`@nokoribi/terminal-host` 从生产闭包导入断言；**M11–M17** 增加 `share/skills/nokoribi-{deploy,debug}/SKILL.md` 存在、`dsh-tool-session-query`/`dsh-skill`/`dsh-skill-filesystem`/`dsh-tool-skill`/`dsh-mcp-client`/`dsh-mcp-resources` 与 launcher anchor 的 `@openviking/dsh-memory-plugin` 导入断言。
- `checks.<system>.unit`：`pnpm build` + `pnpm test:unit`；只跑 `packages/*/test`（不含 `tests/integration`，后者在本地 `pnpm test` 运行；M7 起用 `vitest.unit.config.ts` 固定该边界；M10 的 real-PTY 进程测试不进 flake）。
- `checks.<system>.module-eval`：NixOS eval 最小配置，断言 unit 字段，并用 PyYAML 解析生成的 `_overlayText`（M8 增加 `nokoribi-channel-qq-bot` 行与 `trustedChannels`；M10 增加 terminal/web/reviewer exempt 行与 `DEEPSEEK_SEARCH_BASE_URL` 断言，并新增 `module-eval-disabled` 断言 `terminal.enable=false`/`web.enable=false` 时相关行 `disabled` 且 local host 仍启用；**M11–M17** 增加 `module-eval-openviking`（启用/停用 env + endpoint 必填 + 本地 memory 开关）与 `module-eval-mcp-single`（`mcp.servers` 0/1/2 行矩阵），并断言 sessionSearch/skill/sendFile/QQ 新 config 与无字面密钥）。
- 本地运行：`nix flake check`（当前系统）。NixOS VM 测试不做（D130）；12.12/12.13 手工清单仍必须执行。

## 13.6 日志

- 全部 stdout/stderr → journald。
- 级别由 `NOKORIBI_LOG_LEVEL`（debug/info/warn/error，默认 info）过滤；NixOS module 设置 `log.level`。warn/error 同时进入进程内 recent 环形缓冲供 `/status full`。
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

- 摘要（默认）：version、uptime、agentStatus（running/idle）、mainSessionId、model、permission、活跃 goal 数、待应答数、outbox 长度。M7 增加 `channels`（每个 driver 的 `id=online|connecting|offline`）与 `deferredNotices` 计数。
- `/status full`：
  - 每个 goal：短 id、phase、rounds、model、child 运行状态、sandbox generation/TTL/active；
  - 每个 sandbox：session、目录、存在性、generation、activity、`terminals=N`（活动持久终端数，M10）、TTL、临时包、最近使用；
  - active schedule：id/title/kind/scheduledAt/state；
  - memory：active/archived/invalid/bytes；M16 增加 pinned、snapshotChars、inject=enabled|disabled（本地 memory 停用/OpenViking 后端时显示 disabled）；
  - 最近 10 条 warn/error（进程内存环形缓冲，不持久化，不含字段值）；
  - last restart reason/时间、lastVersion、workspace/state/lock/storage 路径；
  - reviewer 两档与超时；DSH/app 版本。
- 不展示 API key、完整消息内容、提醒 prompt、memory 正文或 sandbox 包以外的敏感信息。
- `GET /v1/status?full=1` 返回摘要 + `details`；默认 `GET /v1/status` 仍只有摘要。

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

1. 更新 flake input / 包版本；lockfile 变化时更新 `pnpmDeps.hash`。
2. DSH 整批 bump 时同步 reviewer vendor；官方 Node 变更时更新 `nodeRuntime` 版本与 hash。
3. `nix flake check`（本地）与 `pnpm check` / `pnpm test` / `pnpm test:process`。
4. `nixos-rebuild switch`。
5. `systemctl status` + journald 检查恢复；确认 notify ready。
6. 手工验收清单（12.12）按需执行。
7. 不做备份/快照；回滚需自行承担 session format 风险。
8. 当前没有新 DSH 版本可 bump；M6 只做同版本重构建/重启恢复演练（D147）。

### 故障排查

| 现象 | 检查 |
|---|---|
| 服务起不来 | journald；单实例锁；DSH_HOME 权限；profile/overlay patch 错误；`systemd-notify` 是否可执行 |
| 启动一直 activating | 是否发送 READY；goal 恢复是否超 `TimeoutStartSec`；`NOKORIBI_READY_TIMEOUT_MS` |
| 被 watchdog 重启 | 事件循环是否卡死；journald 中 `WATCHDOG`/systemd 超时；不要用 SIGSTOP 测试后忘记 CONT |
| 无回复 | `/v1/status`；测试通道是否启用；agent 是否 running；outbox 是否积压；reviewer 是否卡在审批 |
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
