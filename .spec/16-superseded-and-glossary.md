# 16 被取代/否决与术语

## 16.1 被取代或被撤销的决策

| 旧决策 | 新决策 | 原因/影响 |
|---|---|---|
| D02 生产纯 IM + 按需 Web 调试 profile | D108 不做 web-debug | 继续精简；归档/排查改为 journald + session 文件 + `/status` |
| D15 出站由 subagent 总结、调 send_message | D20 主 agent 直接回复 | 减少一次模型调用/延迟与可靠性依赖；goal 报告由主 agent 转述 |
| D28 `sandbox:workspace` 命名/权限沙箱语义 | D29/D44/D49：`sandbox:default`，干净环境 | DSH 的权限沙箱在 Auto 下是 full access；host 改为执行位置/干净环境 |
| D30 非沙箱 host 单独审批 | D31/D82 全局 Auto | 用户选择 A 方案；host 选择本身不再授权，所有工具调用过 reviewer |
| D32 host 授权粒度 | 随 D30 失效 | 在全局 Auto 下没有 per-host 授权问题 |
| D36/D38 overlay 沙箱（workspace lower + temp upper） | D44 撤销，改为干净隔离环境 | overlayfs 挂载期间修改 lower 是未定义行为；用户主动回撤 |
| D39 从 workspace shell 文件取 Nix 环境 | D45 只用 profile 固定环境 | 可预测性、与精简/沙箱隔离一致 |
| D43/D51 commit 基线与覆盖策略 | D50/D54 无 commit 工具、提示词约束 | 用户要求模型用 shell 自己管理文件搬运 |
| D73 systemd 中等硬化 | D79/D81 取消文件系统硬化 | 为让 local host 执行任意命令并使用 sudo；安全交给 auto-review |
| D72 "独立 workspace 不碰宿主"的强隔离预期 | D80 workspace 只是默认目录 | 用户要求 local host 全主机能力；宿主隔离由用户/权限边界决定 |
| D11 v1 仅消息闭环+工具+持久会话 | D125 六阶段扩展范围 | 后续讨论加入了 sandbox、auto-review、memory、schedule、goal、部署 |
| D64/D83 "主模型/便宜模型"命名与全局分层 | D85 只给 reviewer 两个 tier | 用户澄清：tier 仅用于 review model，不是所有模型分层 |
| 中间提案：goal 短 id 用 `g1/g2` | D102 sessionId 前缀 | 用户选择 |
| 中间提案：只允许一个活跃 goal | D93/D96 多个并行、无上限 | 用户选择 |
| 中间提案：专用 `start_goal` 工具 | D97 通用 `subagent` + 监控 → **D136 专用 `start_goal` + 宿主创建** | rc.3 `create_goal` 仅允许根 agent 直接人类输入；D97 被 D136 取代 |
| 中间提案：`archive_goal` 工具 | D100 主 agent 提示 + 用户命令 | 用户选择 |
| 中间提案：test token 随机生成 | D106/D119 固定 token、Nix 明文 | 用户选择 |
| 中间提案：升级前快照 | D110 直接升级 | 用户选择 |
| 早期 auto-review 接法 B/C | D31 A 全局 Auto | 用户选择 |
| 早期 `local-sandbox` host 概念（DSH Landlock 权限沙箱） | D44 干净 sandbox host | 用户澄清沙箱语义是"可回收/不保证持久"，不是权限沙箱 |
| D149 “M9 = SSH host” | D165：M9 = QQ 按钮审批、M10 = host-aware 持久终端 + Web；SSH host 顺延（不占编号） | 两项日常可用性缺口优先；SSH 仍可只新增 provider，暂不排期 |
| M8 的“按钮审批后置” | D166/D167：M9 在 C2C 审批落地按钮（契约 D163 不变；2026-10-29 代码完成，真实门禁待执行） | 平台内联键盘 + interaction 回调已具备，core 补生产者/解释器即可 |
| D143 M5 不做 memory 自动注入 | D172–D174：M16 增加 pinned 快照自动注入（runtime context、每轮最多刷新一次、仅主会话） | 单主会话长期存在，需要跨会话记住用户偏好；快照机制不影响静态 system prompt/缓存；主动检索与“不做每轮自动检索”保留 |
| D172 本地记忆不引入外部 provider | D175：OpenViking 作为可选后端（默认关闭；启用即停用本地 memory 组件；只保留连接配置，server 不打包；前置 M12 Skill + M13 MCP） | 用户确认可单独接入、单独配置；本地仍是默认实现，外部后端在 M17 排期 |

## 16.2 被否决的方案（未采用，但讨论过）

### 精简/装配

- 完整 fork DSH 仓库并裁包（维护成本高、DSH 仍 rc）。
- 另写一个精简 harness（工作量大）。
- 继续使用官方 `dsh` 启动器（安装闭包 250–300 包，不满足安装物精简）。
- 多 git 仓库拆分（依赖/版本管理复杂）。
- semver 范围/自动跟随最新 rc（rc 变动风险）。
- 保留 Web UI / Web 调试 profile（最终不做）。
- GitHub Actions CI（最终只做 flake checks）。
- NixOS VM 测试（最终不做）。

### 接入/通信

- 独立 gateway 进程 + 自定义 IPC。
- 独立 gateway + DSH SDK JSON-RPC（只有排队 prompt，无 steer/inject，无法满足不打断注入）。
- 独立 gateway + Web API（prompt 支持 steer，但要保留 Web 服务/鉴权栈，与精简冲突）。
- ACP 作为 IM 桥接（面向编辑器/自动化，不适合）。
- 把 IM 通道建模为一个常驻 teammate agent（每跳多一次模型调用，桥接逻辑别扭）。
- 出站 reporter/summarizer subagent（改为 main 直接回复）。
- 控制台/fake 作为产品渠道（最终只做本地测试通道用于验收）。
- 流式输出/编辑消息（用户未选；v1 不做）。
- M9 用平台卡片模板/自定义 Markdown 卡片替代内联键盘按钮（只用通用 `OutboundAction` + 内联键盘；卡片模板不复用）。
- M9 群聊按钮与 `ask_user_question` 选项按钮（M9 只做 C2C 审批按钮；其余后置）。
- M9 的“始终允许”按钮（DSH `ApprovalOutcome` 无持久 grant，不做）。
- M10 直接 vendoring `dsh-terminal-bash`（默认用公开导出 `BashTerminalBackend` 注入；仅失败时回退 vendoring）。
- M10 用 DSH 权限沙箱（`ctx.sandbox`/workspace-write）承载持久终端（与 M2/M3 的“不使用 DSH 权限沙箱”冲突，不采用）。
- M10 持久终端跨 daemon 重启恢复（需要 tmux/screen 等外部机制，未纳入）。
- M10 自研 PTY 会话机制（优先复用上游 `LocalPtySession` 机制）。
- 多用户/群聊支持（后置，未设计）。
- 真实 IM 适配器进 v1（后置到 M8；M7 core 与 M8 QQ 官方 Bot 代码已实现，真实平台验收待执行）。
- 直接挂官方 `@tencent-connect/dsh-qqbot` 作为 QQ 适配层（端到端 agent 插件、绕过 `ctx.channels`/审批/outbox；硬依赖 UNLICENSED `qqbot-connector`，peer semver 与 `0.2.1-rc.3` 不匹配）→ M8 自研 driver（D154）。
- M8 用 WebHook 接入 QQ（需要公网回调/TLS 终止，与当前无入站端口部署冲突）→ 先 WebSocket，WebHook 后置（D150）。
- heartbeat/定时主动唤醒（不做）。

### shell / sandbox

- 多个 host 插件各自注册 `ctx.shell`（单 provider，会冲突）。
- 复合 `ShellExecutor` 把所有 host 塞进 `ctx.shell`（私货扩展，污染 seam）。
- 让模型直接指定 SSH 目标（只允许 host id + 配置映射）。
- 使用 DSH 的权限沙箱（Landlock）作为 host 语义（Auto 下 full access；且用户要的是临时环境）。
- overlayfs 写时复制沙箱（撤销）。
- `copy_in`/`commit` 工具（撤销，改 shell 搬运）。
- commit 强制基线冲突检查（撤销，改提示词）。
- `sandbox_permissions` 升权字段（去掉）。
- sandbox 内允许 sudo（禁止提权）。
- 强制 bwrap/容器隔离（约定隔离即可；未来可加）。
- 远程文件工具 read/write/edit（未设计；后置）。
- 远程持久 shell/端口转发等（未设计）。

### goal / memory / prompt

- 主会话持有 goal（禁止；goal 由子代理跑）。
- 单 goal/单活跃 goal（改为多 goal 并行）。
- 专用 goal 创建/归档工具（改为通用 subagent + 命令）。
- goal 完成后自动归档（改为询问用户）。
- 删除 goal 子代理会话（DSH 无删除 API；保留 session + 索引）。
- 归档用 web-debug 查看（不做 web-debug；看文件）。
- memory 按项目作用域/多作用域（只全局）。
- memory 全量注入/每轮自动检索（只做 pinned 快照 + 主动检索；D143 → D172–D174）。
- 向量检索/嵌入（v1 不做）。
- 用 session search 做记忆（会话检索另立里程碑；memory 仍以 entries 快照/工具检索为主）。
- 每条记忆一个文件改为单 MEMORY.md / JSONL（用户选每文件）。
- SOUL.md 运行时热重载（启动加载）。
- persona complete 模式（会丢工具引导）。
- 外部视觉模型转述图片（无多模态模型时直接不支持）。

### 安全/运维

- 高危命令模式硬确认（不做，完全信任 auto-review）。
- 备份/自动回滚（不做）。
- sudo log_output（不做，避免敏感输出进日志）。
- 运行时配置 override（纯 Nix 只读）。
- web-debug（不做）。
- token 随机生成（固定 token，Nix 明文）。
- 以用户账户运行服务（专用用户）。
- systemd 文件系统硬化（为 sudo/local 取消）。
- 限制 sudo 白名单（选择 ALL）。
- token 预算守卫（不做）。
- 升级前快照（不做）。
- 集中式日志/OTel/metrics（不做）。

## 16.3 讨论中形成但最终未采用的细节

- goal 汇报里加入结构化 JSON schema（最终用纯文本格式）。
- 审批提示使用按钮/交互卡片：v1 纯文本渠道；M9 起 C2C 审批改用内联键盘按钮（D166），群聊/提问仍为文本。
- 渠道消息合并/防抖（v1 逐条 steer）。
- outbox 至多一次/不持久化（选至少一次持久化）。
- 测试通道 SSE（选长轮询）。
- 测试通道 explicit interaction reply endpoint（用 inbound 文本回复即可）。
- memory frontmatter 之外单独的 index 文件（可选，实现决定）。
- 主 agent `/model` 切换命令（未暴露）。
- compaction 图像 offload（未纳入 v1）。
- MCP 客户端工具（未纳入 v1）。
- skills 作为 v1 重点（能力保留，但不重点）。
- 远程/容器 sandbox（后置）。

## 16.4 术语表

| 术语 | 含义 |
|---|---|
| DSH | DeepSeek Harness，本项目的基础框架 |
| profile | DSH 的运行配置档，位于 `$DSH_HOME/profiles/<name>` |
| bundle | 发布包，携带 patch 层，组合多个插件行 |
| patch | loader patch 条目数组（插入/覆盖/禁用行） |
| Cordis | DSH 使用的插件/服务内核；`ctx` 为服务上下文 |
| seam | 能力 seam：服务定义 + provider 实现 + consumer |
| Agent Loop | 驱动模型请求、工具执行、会话写入的循环 |
| turn / step | 一轮交互 / 轮内的一次模型请求+工具步骤 |
| steer | 把消息提交到下一步输入（最近 step 边界），不打断当前 step |
| followup | 排到下一轮，空闲时唤醒 |
| inject | 只加模型面向上下文，不唤醒 |
| cancel | 中止当前活动（可保留 inbox） |
| inbox | Agent 的待处理 nextStep/nextTurn 消息队列；持久投影 |
| session | 事件溯源的会话日志；JSONL 持久化 |
| projection | 从会话日志折叠出的状态（如 inbox、goal、schedule） |
| compaction | 接近上下文上限时摘要旧历史（多一次模型请求） |
| goal | 每会话一个的持久完成目标；含 phase/rounds/activation |
| round | goal 的一次自动续跑轮次 |
| armed / disarmed | 进程本地的 goal 自动续行开关；session-start 必 disarm |
| continuable subagent | 持久会话、可继续消息/中断的子代理 |
| cold resume | 用父级 `sendMessage` 让不驻留的子代理从持久化会话恢复 |
| goal report | M4 用 `send_message` 发给直接父代理；`subagent/end` 另有自动结算通知 |
| auto-review | 实验性逐工具调用 LLM 审查，属于 Auto 权限预设 |
| Auto preset | permission preset 的一种：full access + ask，工具调用经 reviewer |
| reviewer fast/strong | 本项目的两档 review 模型；fast 全审、strong 复审 |
| approval | 一次性人工/机器审批 seam；`ask`/`never` 策略 |
| userQuestions | 用户问答服务（`ask_user_question` 的底层） |
| host | 命令执行位置，id 形如 `<kind>:<instance>` |
| shell router | 提供 `ctx.shellHosts` 并作为唯一 `ctx.shell` provider 的插件 |
| local host | 主机环境 + 持久 workspace；部署后可 sudo |
| sandbox host | profile 固定 Nix 环境 + 独立临时目录；默认 host |
| TTL | sandbox 空闲回收时间（默认 30 分钟可配） |
| buildEnv | Nix 预构建的包集合，作为 sandbox 基础 PATH |
| sandbox_packages | 沙箱级临时加包工具，状态保留到 reset/回收 |
| ChannelDriver | IM/测试通道的适配器接口 |
| QQ Bot | QQ 开放平台的官方机器人（M8 首个真实 IM 渠道） |
| openid | QQ 官方 Bot 的伪匿名用户/群标识；按 AppID/群作用域不同 |
| msg_id | 被动回复引用的入站事件 id；QQ 单聊/群聊各有窗口与次数限制 |
| msg_seq | 与 `msg_id` 联合的 1 基被动槽位（driver 复用 core `replySeq`）；相同 `msg_id+msg_seq` 重试由平台去重 |
| chatId 命名空间（QQ） | `c2c:<user_openid>` / `group:<group_openid>`；无状态重启后仍能判断发送端点 |
| activeMessageFallback | 被动不可用时是否尝试主动消息；`auto` 失败后标记不可用 1h，`off` 直接由 core defer/fail |
| QQ fact gate | M8 真实接入前的 14 项平台事实实测清单；记录见 `.spec/notes/qq-fact-gate.md` |
| 被动消息 | 携带事件 `msg_id`（或 `event_id`）的回复；受窗口与次数限制 |
| 主动消息 | 不携带 `msg_id` 的主动发送；配额受限，且官方已于 2025-04-21 下线 |
| replySeq | channel-core 为同一被动上下文分配的 `msg_seq`（1..N，持久、重试稳定） |
| turnChat | 当前轮的来源 chat；回复优先路由到它，避免多 driver 串渠道 |
| deferred notice | active 不可投时暂存的 per-chat 通知；下一次该 chat 入站以“⚠️ 补发”被动回复补投 |
| OutboundAction | 平台无关的消息动作按钮描述（D163）；M9 起审批提示生产 `callback` action，只在支持 `outboundActions` 的驱动渲染 |
| InboundAction | driver 归一化的按钮/菜单回调元数据；必须同时提供 text fallback；M9 起 core 以 action 为权威路由 broker |
| action token（M9） | broker 为一次审批生成的短 token，绑定 interactionId 与 outcome；只在内存、随 settle/超时清理 |
| keyboard（QQ） | QQ 消息内联键盘（`keyboard.content.rows[].buttons[]`）；M9 只用于 C2C 审批 |
| INTERACTION_CREATE | QQ 按钮/菜单回调节点事件（intent `1<<26`）；type=11 为消息按钮回调，需 `PUT /interactions/{id}` ack |
| host-aware 持久终端（M10） | 复用 DSH `ctx.terminals`/`terminal_*` 工具，但 PTY 启动经 shell host provider；`terminal_open.type` 即 host id |
| terminal launch（M10） | host provider 新增的 PTY 启动规格（argv/cwd/env/release）；registry 暴露 `terminalLaunch()` |
| terminal pin（M10） | sandbox 内有持久终端时阻止 TTL 回收/reset/dispose 的引用计数；PTY 退出/关闭释放 |
| exemptTools（M10） | vendored auto-review 的工具名豁免列表；默认 `web_search`/`web_fetch`（D170） |
| defaultChatId（driver） | driver 在无入站上下文时可寻址的 chat，用于通知的 active-capable 回退 |
| trusted channel | channel-core 跳过静态 allowlist、由 driver 自行保证准入的渠道（M8：`qq-bot`） |
| ingress | 入站处理管线（allowlist/去重/命令/注入） |
| outbox | 持久化出站队列，at-least-once |
| interaction broker | 审批/提问的串行应答 broker |
| system notice | ⚠️ 前缀的直接通知（不经过模型） |
| test channel | loopback HTTP + token 的本地验收渠道 |
| DSH_HOME | DSH 的状态根目录；本部署为 `/var/lib/nokoribi-agent` |
| SOUL.md | 用户提供的人设文本；源码仓库打包、启动时加载 |
| AGENTS.md | 全局/项目工作区指令文件；首次 seed，不覆盖 |
| memory entry | `$DSH_HOME/memory/entries/<id>.md` 的一条持久事实 |
| archive index | `$DSH_HOME/archive/goals.jsonl`，归档 goal 的索引 |
| watchdog | systemd `WatchdogSec` + sd_notify，卡死自动重启 |
| agenix | 用户 NixOS 使用的 age 密钥管理工具 |
| NUR | Nix User Repository；本项目的包由 nur-packages 转发 |
| thin launcher | 自建薄启动器，vendor profile-boot，不依赖官方 dsh 包 |

## 16.5 M4 实现记录

- 采用 D136/D137/D138：`start_goal` + 宿主 `ctx.goals.create`；`send_message` 汇报；goal child 模型固定配置。
- 增加 `session-query-sqlite`（`openAt:"never"`）供 `ctx.subagents.listChildren` 使用；`tool-goal` / `goal-round-driver` / `subagent` / `tool-subagent` / `tool-subagent-control` 已挂载。
- 已验证 goal child 在 goal round 期间保持 Activation 到 completion/轮次上限；冷恢复、失败保留、`/clear` 归档与 sandbox 删除均有进程级测试。

## 16.6 文档维护规则

- 新增/修改决定：更新 [03 决策记录](03-decision-log.md)，必要时在本文登记被取代项。
- 修改任何规格：同步修改对应专题文档与 README 索引。
- 实现期若发现与 DSH 锁定版本行为不符：先更新 [15 待验证项与风险](15-verification-and-risks.md)，再调整设计并回写。
- 不删除历史决策；用"取代/撤销"标注保留可追溯性。
