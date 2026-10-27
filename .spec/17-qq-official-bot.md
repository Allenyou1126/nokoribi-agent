# 17 真实 IM 适配器：QQ 官方 Bot

> 状态：**P1 规格已评审通过（2026-10-27）**。按 D149 修订，实现拆分为：**M7 = channel-core IM 基础设施扩展（已实现，2026-10-27）**、**M8 = QQ 官方 Bot 适配器（代码已实现，2026-10-27；真实平台门禁/验收待执行）**、M9 = SSH host。
> 用户已确认：协议层采用官方 SDK（D154）；channel-core 扩展拆成独立里程碑先做（D158）。M7 实现口径见 D162；M8 实现口径见 D164；动作按钮扩展空间见 D163（仅契约/持久化，未实现）。
> 调研材料（工作稿，评审后决定是否入库）：
> - 平台事实表：[.spec/notes/qq-official-bot-api-facts.md](notes/qq-official-bot-api-facts.md)（807 行，S1–S41 来源）
> - 代码接口映射：[.spec/notes/channel-qq-mapping.md](notes/channel-qq-mapping.md)（893 行，含 A2 契约草案与文件清单）
> - 官方 SDK/插件评估：[.spec/notes/qq-official-sdk-and-dsh-plugin.md](notes/qq-official-sdk-and-dsh-plugin.md)（378 行）
> - Hermes Agent 参考实现：[.spec/notes/hermes-agent-qqbot-notes.md](notes/hermes-agent-qqbot-notes.md)

## 17.1 范围与目标

目标：接入 **QQ 官方 Bot**（QQ 开放平台，`bot.q.qq.com`）作为首个真实 IM 渠道，使 Nokoribi Agent 可通过 QQ 单聊与群内 @ 提及接收消息、回复、审批/提问、命令与（受限的）主动通知。

本里程碑做：

- 新建 `packages/channel-qq-bot`，实现 `ChannelDriver` 契约；不修改 `bash`/host/tool/schema。
- channel-core 最小扩展（D158）：被动回复上下文（core+outbox 承载）、多 driver 路由、`trustedChannels`、非重试错误。
- WebSocket 网关接入（事件接收）+ OpenAPI v2（token、发送消息）。
- 单聊（C2C）与群聊 @ 提及两类入站；文本与 Markdown 出站。
- 被动优先发送策略：`msg_id + msg_seq` 被动回复；超窗/超次数按能力尝试主动消息（`auto` 门禁）；错误分类与频控。
- NixOS module 选项、bundle 行、overlay 渲染、密钥走 EnvironmentFile。
- 自动化测试（fake 网关/REST）+ 真实 Bot 手工验收清单。

本里程碑不做（后置）：

- 公开使用/上架、企业主体功能；只按个人主体 + 开发体验用户/自己的群验收。
- 群全量消息（`GROUP_MESSAGE_CREATE`，需群主单独授权）；只接 `GROUP_AT_MESSAGE_CREATE`。
- 频道（guild）/文字子频道、频道私信；多 Bot/多账号；WebHook 接入方式。
- 入站图片/附件、出站富媒体、Markdown 图片转存（图片链路属 V8，另立里程碑）。
- 流式消息、消息按钮/内联键盘、指令面板、互动回调（`INTERACTION_CREATE`）。M8 不实现；M7 已预留通用动作按钮契约与 outbox 持久化（D163），按钮审批/回调应答留待后续增强。
- 驱动级白名单/配对（D152，用户已决策）。
- C2C `is_wakeup` 互动召回（作为后续提醒降级通道评估）。

里程碑编号（D149 修订）：**M7 = channel-core IM 基础设施扩展**（被动回复上下文、多 driver 路由、`trustedChannels`、非重试错误；独立里程碑先做）；**M8 = 本适配器（QQ 官方 Bot）**；**M9 = SSH host**。M7 的规格要点见 17.6.2 与映射文档 §3/§6.2；M8 在本规格实现计划中展开。

## 17.2 平台事实

摘要如下；逐条来源、核对状态（✅已核实 / 🧩官方 SDK 佐证 / ⚡冲突 / 🧪待实测）见事实表。

### 17.2.1 鉴权与连接

| 事实 | 状态 |
|---|---|
| `access_token`：`POST /app/getAppAccessToken`（`appId` + `clientSecret`），有效期约 7200 秒，临近过期 60 秒内可换新；请求头 `Authorization: QQBot <access_token>`；业务错误走响应体 `code`（HTTP 仍 200） | ✅ |
| 网关地址：`GET /gateway`（通用）或 `GET /gateway/bot`（带分片/会话创建限制）；返回 WSS URL，不硬编码 | ✅ |
| payload `{id, op, d, s, t}`；opcode 0/1/2/6/7/9/10/11（webhook 另有 12/13） | ✅ |
| **Identify token 为 `QQBot {AccessToken}`**（旧文档 `Bot {appid}.{app_token}` 属废弃 Bot Token 体系，不采用） | ✅⚡ |
| intents：`GROUP_AND_C2C_EVENT = 1 << 25`；互动事件 `1 << 26`（本轮不订阅）；无权限的 intent 会导致 WS `4014` | ✅ |
| 分片：单 Bot 无分片需求，`shard: [0, 1]`；`/gateway/bot` 返回 24h 会话创建上限 | ✅ |
| 心跳按 Hello 的 `heartbeat_interval` 发送，带最新 `s`；`Op 11` ACK | ✅ |
| 断线优先 `Resume`（`session_id` + `seq` 补发），`Op 9` 重新 Identify | ✅ |
| 关闭码：`4009` 可 resume；`4006/4007/4900–4913` 重新 identify；**`4914`（下架/仅沙箱）、`4915`（封禁）不可重连** | ✅⚡ |
| 域名冲突：文档 `https://api.bot.qq.com`（token 与 REST）；官方 SDK 默认 `api.sgroup.qq.com` + `bots.qq.com`；官方 dsh 插件显式覆盖为 `api.bot.qq.com` | ⚡🧪 |
| 发送是否要求 WebSocket 在线：仅频道文档明确要求；C2C/群 v2 未写 | 🧪 |
| WebSocket 退役提示：仅出现在 GitHub 旧文档副本；live 文档仍以 WS 为接入方式 | ⚡🧪 |

### 17.2.2 入站事件

| 事件 | 关键字段 |
|---|---|
| `C2C_MESSAGE_CREATE` | `id`、`author.user_openid`、`content`、`timestamp`、`message_type`（0 文本/3 卡片/101/102/103 引用）、`message_scene.ext`（`msg_idx`/`ref_msg_idx`/`auth_token`）、`attachments[]`、`msg_elements[]` |
| `GROUP_AT_MESSAGE_CREATE` | `id`、**顶层 `group_openid`**、`author.member_openid`/`member_role`、`content`（**已去除 @ 机器人前缀**）、`mentions[]`（不含机器人自身）、`message_scene.ext`、`attachments[]` |
| `GROUP_MESSAGE_CREATE` | 群全量消息，与 @ 事件同构；本轮**不处理**（群主另行授权才产生） |

- 去重：官方文案同时提到 `msg_seq` 与 `message_scene.ext.msg_idx`，但入站事件无 `msg_seq`（⚡）。采用事件 `id` 为主 key（channel-core 现状），`msg_idx` 仅用于日志/辅助；真实重复推送边界待实测。
- 附件：`attachments[].url` 自带 `rkey`，官方文档未要求额外鉴权头；URL 有效期未公开（🧪）。本轮不做图片链路，driver 忽略附件、不放入 `images`。

### 17.2.3 出站发送

| 事实 | 内容 |
|---|---|
| 单聊接口 | `POST /v2/users/{user_openid}/messages` |
| 群聊接口 | `POST /v2/groups/{group_openid}/messages` |
| 请求字段 | `msg_type`（0 文本 / 2 Markdown / 7 富媒体；单聊另有 6 输入中）、`content`（与 markdown 互斥）、`markdown.content`、`msg_id`、`msg_seq`、`event_id`、`is_wakeup`（单聊召回）、`media`、`message_reference` |
| 被动回复 | 单聊 60 分钟 / 每条消息最多 4 次；群聊 5 分钟 / 最多 5 次（官方“消息收发概述”规范表）；C2C 发送页 `msg_id` 字段另写“5 分钟内有效”（⚡，待实测） |
| `msg_seq` | 与 `msg_id` 联合；相同 `msg_id + msg_seq` 重复发送失败（`40054005`）；同一条目重试必须复用同一 `msg_seq` |
| 主动消息 | **官方发送页横幅：主动推送能力于 2025-04-21 起不再提供，调用会收到错误（社区实测 `40034102`）**；但文档仍保留主动消息频控/配额表（⚡ 最高优先级冲突/待实测）。群聊/单聊主动推送均受影响；用户可关闭主动消息 |
| 接口级频控 | 发送接口 100 QPS（含主被动）；上传 50 QPS；预上传 10 QPS |
| 文本长度 | 官方文档无数字；官方 SDK 约 5000，官方 DSH 插件默认 4500，第三方多称 2000（⚡） |
| Markdown | 2026-04-23 起单聊/群聊自定义 Markdown 对所有机器人开放、无需模板；官方支持语法清单**不含代码块/表格**（🧪） |
| 富媒体 | 需先上传（单聊/群聊隔离），`file_info` 有 TTL；本轮不做 |

### 17.2.4 准入与权限

- 个人主体机器人**不能公开使用**；企业主体可公开。
- 单聊测试：管理端「开发设置」添加**开发体验用户**（本人 QQ）。
- 群聊测试：机器人创建者只能加入自己为群主/管理员的群；群主可设置是否允许全量消息/主动发言/撤回成员消息。
- 管理员账号可直接测试；旧版沙箱群配置已停止支持。
- AI 输出须符合平台运营规范，违规可能导致机器人/账号封禁且**不支持解封**。
- 官方个人认证开发者可创建 5 个机器人。

## 17.3 总体设计

- 新包 `packages/channel-qq-bot`，注册为 `ctx.channels` 的一个 driver（`id = "qq-bot"`），不占用 `ctx.shell`，不改 host/router/工具。
- 行装配：`packages/bundle/cordis.patch.yml` 新增 `nokoribi-channel-qq-bot` 行；NixOS module 生成同名 patch。
- 连接形态：进程内 driver 持有 WebSocket 网关连接；出站走 HTTPS API。**M8 使用 WebSocket**；transport 在 driver 内部抽象（`gateway.ts`），WebHook 后置（D150）。
- **协议层采用官方 Node SDK** `@tencent-connect/qqbot-nodejs`（MIT，exact pin `1.0.5`），只消费 `./protocol` 子路径（`TokenManager`、`ApiClient`、`MessageApi`、`GatewayConnection`、`dispatchEvent`、`ApiError`、`routes`），**不启用** facade 中间件/业务层（D154，待评审确认）。
  - 理由：SDK 覆盖 token 刷新、WS 生命周期/Resume/关闭码/重连等最难自测部分；不侵入 channel-core 的去重/allowlist/审批/outbox/分段/命令语义。
  - `ws@8.22.0` 已在本仓库生产闭包中（dsh 依赖链），SDK 只新增 1 个包；需更新 `pnpm-lock.yaml` 与 `nix/deps.nix` 的 FOD 哈希。
  - 备选：完全自研薄客户端（约 400–600 行，零新增依赖）；官方 DSH 插件 `@tencent-connect/dsh-qqbot` 是端到端 agent 插件、绕过 `ctx.channels`，不采用（评估见 notes）。
- 密钥：`appId` 为非秘密配置可入 Nix store；`clientSecret` 只从环境变量读取（systemd `EnvironmentFile`/agenix），`access_token` 仅内存缓存，不落盘、不打印（D156）。
- 域名/路径集中配置并允许测试覆盖（fake server）：默认按文档 `https://api.bot.qq.com`，保留 SDK 默认域名为备选（🧪）。

### 17.3.1 连接状态机

```
stopped → starting(token+gateway) → connecting(ws) → identify → online
                    ↑                    │                        │
                    └──── reconnecting ←─┴──── disconnect/error ←─┘
online → stopping(close ws) → stopped
```

- `GatewayConnection` 在 driver 内以后台 Promise 运行；`start()` 最多等待首个 READY `connectTimeoutMs`，超时记录 warn 并继续后台重连，**不阻塞 daemon ready**。
- 重连退避 1s→2s→5s→10s→30s→60s（可配）；`Op 9` 重新 Identify；`4914/4915` 停止重试并告警。
- 心跳由 SDK 按 Hello 周期维护；driver 只记录连接状态事件。
- shutdown：停止心跳/重连定时器、`abort`/关闭 WS（有界等待）、拒绝后续发送（返回可重试错误让条目留在 outbox）；`stop()` 幂等。
- gateway 会话**不跨进程持久化**：重启后重新 Identify（D153）；未发 outbox 条目按到期规则退化/失败。

### 17.3.2 发送前置条件

- 文档仅在频道场景明确“发送需 WebSocket 在线”；C2C/群 v2 未要求（🧪）。规格不把“WS 在线”作为硬前置；若实测返回相关错误，按可重试处理。
- token 由 SDK `TokenManager` 维护（提前刷新/单飞）；发送遇鉴权类错误由 driver 刷新一次后重试。
- **必须显式传 `msg_seq`**：SDK 在缺省时会自动生成随机 `msg_seq`，导致 outbox 重试被平台视为新消息（重复发送）。driver 使用 core 下发的稳定 `replySeq`。

## 17.4 入站

### 17.4.1 事件映射

| QQ 事件 | `InboundMessage` 字段 |
|---|---|
| `C2C_MESSAGE_CREATE` | `channelId="qq-bot"`、`chatId="c2c:" + author.user_openid`、`senderId=author.user_openid`、`messageId=id`、`text=content`、`receivedAt=timestamp`、`replyTo=msg_idx 引用目标`（若有） |
| `GROUP_AT_MESSAGE_CREATE` | `channelId="qq-bot"`、`chatId="group:" + d.group_openid`、`senderId=author.member_openid`、`messageId=id`、`text=content`、`receivedAt=timestamp` |

- **chatId 使用命名空间**（`c2c:` / `group:`）：driver 需要在无状态重启后从 outbox 条目判断发送端点；裸 openid 无法区分单聊/群聊（D160）。
- `content` 在群 @ 事件已由平台去除 @ 前缀（✅）；做防御性 trim，清理可能的 `<@!botid>` 残留。
- `delivery` 不设置：由 channel-core 按忙碌/空闲选择 steer/followup。
- 忽略：机器人自身消息、`GROUP_MESSAGE_CREATE`（记录 debug）、lifecycle/互动事件；纯非文本消息不转发（无文本 → 不产生入站）；带附件但含文本的消息只转发文本（不设置 `images`）。
- `message_type=103` 引用消息：提取 `msg_elements` 中被引用文本作为上下文（可选，v1 可仅用 `content`）。

### 17.4.2 去重

- channel-core 以 `channelId + messageId` 持久去重；平台重复推送由 core 承担。
- 若实测同一逻辑消息使用不同 `id`，driver 以 `message_scene.ext.msg_idx` 做二次去重后再转发。

## 17.5 出站与消息策略

### 17.5.1 能力位

| 能力 | 取值 | 依据 |
|---|---|---|
| `markdown` | `basic`（默认，可配 `none`/`full`） | `basic` 去表格/HTML；QQ 文档未列代码块/表格（🧪）；若实测 fenced code 显示异常，可切 `none` |
| `maxTextLength` | `4500`（默认，可配；实测上限约 5000） | 官方文档无数字；SDK 约 5000、官方 DSH 插件默认 4500（D160） |
| `inboundImages` | `false` | V8 前不做图片链路 |
| `outboundFiles` | `false` | 不做富媒体/附件 |
| `activeMessages` | `false`（M8；`auto` 探测失败后更新） | 主动推送官方已宣告下线（🧪） |
| `maxRepliesPerReply` | `4`（保守值，可配） | 单聊上限 4，群聊 5；core 预截断避免必然失败的第 5 段 |

### 17.5.2 被动回复上下文（D153：core + outbox 承载）

被动回复上下文**不能放 driver 内存**：回复在 turn 结束才进入 outbox，可能跨秒/分钟与重启；driver 的 `send(chatId, text)` 拿不到“这条出站回复的是哪条入站”。规格采用 A2：

- `channel-core` 维护 `lastInboundByChat`（key=`channelId\0chatId`）与 per-turn 来源 `turnChat`。
- `OutboundContent` 增加 `{kind, deliveryId, attempt, reply?: {messageId, receivedAt, seq}}`。
- outbox 条目持久化 `replyTo`、`replyReceivedAt`、`replySeq`（可选字段，兼容旧文件）；同一条目重试/重启复用同一 `replySeq`。
- `replySeq` 从 1 开始按 `(channelId, chatId, replyTo)` 递增，**不使用 outbox 全局 seq**（平台 `msg_seq` 为有界序号）。
- 分段长回复：各 chunk 共享同一 `msg_id`、`replySeq` 递增；超过 `maxRepliesPerReply` 时 core 截断最后一段并加省略标记（策略可配）。

`send(chatId, content)` 决策（driver）：

1. `content.reply` 存在、未超窗、`seq <= maxReplies`：发送被动回复（`msg_id=reply.messageId`，`msg_seq=reply.seq`）。
2. 否则：若 `activeMessageFallback="auto"` 且该 chat 的主动消息未被标记不可用 → 发送主动消息（无 `msg_id`）；失败按 17.5.4 处理并标记 `activeMessages=false`（TTL，可配）。
3. 被动失效类错误：driver 返回可识别的失败，由 core 决定是否以无 reply 的条目重试（一次）→ 主动。
4. `40054005`：视为已发送成功（稳定 `msg_seq` 下重试收敛）。
5. 永久错误：`NonRetryableDeliveryError`，core 立即置 failed，不重试。

失败边界（明确接受）：

- 重启后 outbox 待发条目的被动上下文可能已超窗 → 条目失败或退化为主动；QQ-only 下主动可能不可用。
- 长任务（群聊 >5 分钟 / 单聊 >60 分钟）后的审批提示/回复可能无法被动送达；交互提示在 `canDeliver=false` 时立即 fail closed（审批 `unavailable`、提问 `NO_PROVIDER`），不再静默等超时。
- 同 chat 多用户并发 @：回复挂在“最近一条入站”的 msg_id 上；语义上仍是群消息。

### 17.5.3 通知与提醒的降级（D161 已确认：active + defer）

主动推送下线意味着 **QQ-only 部署下，没有入站上下文的出站（schedule 提醒、系统通知、重启/待应答失效通知）不能保证送达用户**。

Hermes Agent（NousResearch/hermes-agent）的参考实现（详见 [notes](notes/hermes-agent-qqbot-notes.md)）：

- 用 `QQBOT_HOME_CHANNEL`（用户 openid）作为 cron/通知投递目标；
- cron 路径直接 `adapter.send(chat_id, content)`，**不带 `msg_id`**（主动消息），依次尝试 channel/C2C/group 端点，有限重试后记录失败；
- 没有 defer（等下次入站补投）、没有 `is_wakeup` 召回、也没有针对主动推送下线的专门兜底。
- 结论：Hermes 的方案等价于我们选项 A（active 尝试 + 重试 + 日志），**不能解决窗口外送达**。

**已确认（D161，2026-10-27）：B = active 尝试 + 失败后 `defer`。**

- 先按 `activeMessageFallback=auto` 尝试主动消息；成功即正常发送。
- 若主动失败（或 `activeMessages=false`），把通知保留为 per-chat pending notice，等该 chat 下一次入站时作为被动回复补投（正文加“⚠️ 补发”标记），不丢弃提醒。
- 主动可用时 defer 不触发；QQ-only 且长期无入站时提醒仍会延迟（平台限制，文档写明）。
- 实现归属：core 的 notice defer 等待语义放在 M7（D158 扩展的一部分）；QQ driver 的 `activeMessages` 能力门禁放在 M8。
- 不采用：A（失败即丢失）、C（放弃 active 尝试或换渠道）。

### 17.5.4 频控与错误分类

- 接口级：发送 100 QPS（含主被动）；driver 按 Bot 维度（单聊默认 10 QPS、群聊 60 QPM）与单关系 20 条/分钟做令牌桶/等待；每日 1000 条（主动）best-effort 计数。
- 被动窗口：单聊 60 分钟 / 4 次；群聊 5 分钟 / 5 次；实现加 30–60 秒余量，可配。
- 错误分类：

| 类别 | 错误码 | 行为 |
|---|---|---|
| 可重试 | `100001`、`50055001`、`50055002`、`40034004`、`40054006`、429/5xx/网络 | outbox 退避重试 |
| 被动失效 → 主动回退 | `304103`、`40034005`、`40034026`、`40034128` | 清被动上下文，改为主动消息重试一次 |
| 去重 | `40054005` | 视为发送成功 |
| 长度 | `40054007`、`40054018` | 重新分段/截断后重发一次 |
| 主动不可用/拒收 | `40034100`（退避）、`40034105`、`40054013`、`40034101`、`40054003`、`40054016` | 主动标记不可用/永久失败；告知路径见 17.5.3 |
| 永久失败 | `22006`、`50059`、`304061`、`304080`、`40034006`、`40034008`–`40034011`、`40034024`、`40034025`、`40034027`、`40034106`、`40034108`、`40034109`、`40034124`、`40034127`、`40054002`、`40054004`、`40054010` | 不重试，记录 error/告警 |
| 鉴权失败 | token 无效/过期相关码 | 刷新 token 重试一次，仍失败则重连/告警 |

> 错误码表以事实表 §8.2 为准；实现集中为映射表并加单测。

## 17.6 配置（NixOS module）

### 17.6.1 新增选项（草案）

```nix
channel.qqBot = {
  enable = false;
  appId = "";                            # 非秘密，入 store/overlay
  clientSecretEnv = "NOKORIBI_QQ_BOT_CLIENT_SECRET";  # 只写变量名，值来自 EnvironmentFile
  markdown = "basic";                    # none | basic | full
  maxTextLength = 4500;
  maxRepliesPerReply = 4;                # core 预截断
  c2cReplyWindowSeconds = 3600;
  groupReplyWindowSeconds = 300;
  requestTimeoutSeconds = 10;
  connectTimeoutSeconds = 30;
  activeMessageFallback = "auto";        # auto | off
  reconnectBaseMs = 1000;
  reconnectMaxMs = 60000;
};
```

- 与 2026-10-27 初稿的差异（D164）：**不暴露** `sandbox`、`platformLimitsOnly`、`allowedUsers/allowedGroups`。QQ 已不支持沙箱群；D152 不做 driver 白名单，假选项只会误导。测试/联调需要的域名覆盖只放 bundle env（`NOKORIBI_QQ_BOT_API_BASE` / `TOKEN_BASE` / `GATEWAY_URL`），不进 Nix option。选项名用 `maxRepliesPerReply`，窗口/超时用扁平字段；overlay 把秒转成 driver 的毫秒字段。
- 断言（`enable = true` 时）：`appId != ""`；`clientSecretEnv != ""`；`reconnectMaxMs >= reconnectBaseMs`；`environmentFile != null`（全局断言已有，显式加一条更清晰）。运行期检查 `clientSecretEnv` 指向的环境变量非空（fail loud，不打印值）。
- warnings：QQ 平台限制即准入边界（高残余风险）；主动推送争议（2025-04-21 横幅 vs 配额表）；Markdown 代码块/表格未实测；QQ-only 无本地回退时通知 defer/drop；`localTest.enable` 与 `qqBot.enable` 同时启用时使用 per-turn 路由；secret 只走 EnvironmentFile/agenix。
- overlay：新增 `nokoribi-channel-qq-bot` patch（写全字段，不含 secret/测试 URL）；`nokoribi-channel-core` patch 增加 `trustedChannels = lib.optional qqBot.enable "qq-bot"` 与 `defaultChannelId`（localTest 启用时 `local-test`，否则空串回退首个 driver）。
- 行顺序：`channel-core` → `channel-local-test` → `channel-qq-bot` → `agent-app`（默认渠道由显式配置决定，不依赖行序）。
- systemd：`clientSecret` 由 `environmentFile` 注入；不写入 store/overlay。`appId` 写入 overlay 行 config。
- 本地开发：`.env.example` 增加 QQ 变量（enabled/appId/clientSecret/markdown/上限/窗口/超时/activeFallback/reconnect/测试域名覆盖）。

### 17.6.2 channel-core 最小扩展（D158，M7 已实现）

按映射文档 §3/§6.2 落地，单独提交并配单测：

1. `contract.ts`：`ReplyContext`、`OutboundContent` 扩展、`NonRetryableDeliveryError`、`ChannelCapabilities.activeMessages/maxRepliesPerReply`、`ChannelDriver.canDeliver?()`。
2. `service.ts`：`trustedChannels`/`defaultChannelId` 配置；`lastInboundByChat`/`turnChat`；`enqueueText/sendReply/notify/broker sendPrompt` 路由；pump 传 `deliveryId/attempt/reply/kind`；错误分类；缺 driver 短路失败；可选 `channels` health。
3. `outbox.ts` + `shared/src/schemas.ts`：持久化 `replyTo/replyReceivedAt/replySeq`（可选字段，旧文件兼容）。
4. `format.ts`：分段前缀预留（保证 chunk+前缀不超过平台上限）。
5. 多 driver 路由（D159）：per-turn 来源路由、notice 的 active-capable 回退/丢弃、显式默认渠道、恢复 `lastActiveChat`。
6. `channel-local-test` 的 `send()` 签名适配；集成测试 FakeDriver 适配。
7. **notice defer 等待语义（D161）**：无 reply 上下文的 notice/提醒在 active 不可用时保留为 per-chat pending，下一次该 chat 入站时以被动回复补投（带“⚠️ 补发”标记）；提供上限/清理策略，避免无限堆积。

## 17.7 白名单、安全与合规

- **准入（D152）**：不做驱动级配对/白名单；依赖平台限制：单聊仅开发体验用户可发起，群聊仅自己的群且群内只有 @ 提及进入。channel-core 用 `trustedChannels:["qq-bot"]` 跳过静态全局 allowlist，并在启动日志 warn。
- **残余风险（接受，写入 15.3）**：
  - 任何能私聊机器人或在群里 @ 机器人的 QQ 用户都能驱动 agent；若 `sudo.enable=true`，等价于远程 root 命令入口。建议部署保持 `sudo.enable=false`、只加可信群、保留 local-test 作为验收/通知通道。
  - 群内其他成员 @ 机器人会触发 agent，回复对群可见；不要把机器人放进有不可信成员的群。
  - 平台侧违规内容可能导致机器人/账号封禁（不可解封）；AI 输出不可完全可控。
  - 无 per-user 配额；群友可无限 @ 触发模型调用与成本。
  - openid 是平台伪匿名标识，不作为授权身份。
- **最小防护**（不违背 D152）：只订阅 `1<<25`、只处理两类消息事件、显式忽略 `GROUP_MESSAGE_CREATE`/机器人自身消息/附件/空文本；记录丢弃原因（不含正文）；预留白名单配置入口。
- **密钥与日志**：`clientSecret` 只读环境变量；`access_token` 不写入状态文件/日志；发送错误日志脱敏（不回显 token、不含消息正文，只记 messageId/chatId 摘要与 bizCode）。
- **注入风险**：外部消息进入 agent 后仍经过 Auto review；渠道本身不构成信任边界。

## 17.8 测试与验收

### 17.8.1 自动化

- **单元**
  - 事件归一化（C2C/群 @、chatId 命名空间、忽略全量/机器人/附件/空文本、引用提取）。
  - driver 发送策略（被动/主动回退/窗口/次数/`replySeq`/`40054005`/错误分类/长度重分段）。
  - 频控与 token 刷新（SDK 层只做薄封装验证；错误映射单测）。
  - 配置 schema/断言、secret 缺失 fail loud。
- **channel-core 单测**
  - outbox 新字段持久化/旧文件兼容；`trustedChannels`；`NonRetryableDeliveryError`；缺 driver 短路；per-turn 路由；notice 回退/丢弃；`canDeliver` fail closed。
- **集成（fake WS + fake REST + channel-core + fake LLM）**
  - 单聊事件 → 回复 → `msg_id/msg_seq` 正确；群 @ → `group:` 端点；审批/提问/命令；重复事件去重；图片入站拒绝；被动超窗 → 主动尝试/失败；`40054005` 视为成功。
- **进程级**（复用 `tests/process` 模式）
  - 临时 `DSH_HOME` + 零依赖 fake QQ server（HTTP token/send + WS 握手/帧），daemon 启动、消息闭环、重启恢复、outbox 重发、网关断线重连、SIGTERM 干净退出。
- **Nix**
  - `module-eval` 断言新选项/overlay 行/`trustedChannels`；`unit` 覆盖新测试；`package` 构建包含新包；`package-smoke` 增加 `WebSocket`/`fetch` 全局断言。

### 17.8.2 真实 Bot 手工验收

前置：用户已有 QQ 官方机器人（个人主体），已配置开发体验用户（本人 QQ），已把机器人拉入自己的群。

1. 私聊发送普通消息，收到回复；journald 无 secret/token 泄露。
2. 群内 @ 机器人，收到回复；不 @ 时机器人不响应；若群主开启全量模式，确认全量事件被忽略。
3. `/status`、`/stop`、`/steer`、`/queue` 行为与本地通道一致。
4. 触发 Auto review deny → QQ 收到 🔐 审批提示 → 允许后执行 / 拒绝后失败。
5. 被动回复：单条消息内多次发送 `msg_seq` 递增、无 `40054005`；记录单聊/群聊真实窗口。
6. **主动消息可用性实测**（最高优先级）：无 `msg_id` 发送，记录 HTTP/err_code（`40034102`/`40034105`/`40054013`），据此校准 `activeMessageFallback` 默认（D161 已确认为 active + defer）。
7. 重启 daemon：会话/outbox 恢复，网关重连成功。
8. 长时间运行：token 自动刷新（约 2 小时）后仍可发送。
9. 断网/恢复：网关重连并继续收发（若平台补发）。
10. 目标机部署：NixOS module 配置 + EnvironmentFile 密钥，systemd 服务自启与 notify ready。

## 17.9 风险与未决项

| 风险/未决 | 等级 | 缓解 |
|---|---|---|
| **主动推送已下线**（2025-04-21），提醒/系统通知无法送达 | 高 | `activeMessageFallback=auto` + 可观测；D161 已确认 B（active + defer）；文档明确限制；后续评估 `is_wakeup`/其他渠道 |
| 平台准入/权限（开发体验用户、群关联、公开限制） | 高 | 只用个人主体自测场景；文档写清限制 |
| 白名单只有平台边界（可被任意群成员/测试用户驱动全权限 agent） | 高 | `sudo.enable=false`、可信群、local-test 验收；残余风险接受 |
| 协议/文档变动、域名与错误码冲突 | 中高 | 官方 SDK protocol 层 + 集中常量 + fake 集成测试；待实测清单；升级时重跑 |
| 被动窗口/次数与 outbox 异步发送不匹配 | 中高 | A2 持久上下文 + 保守窗口 + 主动回退 + fail closed |
| 多 driver 路由（串渠道/缺 driver 永久 pending） | 中高 | D159 修复（per-turn 路由、notice 回退/丢弃、短路失败） |
| SDK 新依赖/升级维护 | 中 | exact pin 1.0.5；升级 diff CHANGELOG + 真实 Bot 回归；Nix 哈希更新 |
| 文本/Markdown 精确限制未知 | 中 | 4500 保守默认；`basic`/`none` 可配；实测后定稿 |
| WS 被封禁/下架（4914/4915） | 中 | 停止重连并告警 |
| 账号封禁/内容合规 | 中 | 遵守平台规范；不做公开服务；接受风险 |
| 图片链路缺失（V8） | 低中 | 能力位关闭，入站拒绝/忽略并记录 |

## 17.10 实现计划（暂不启动）

### 17.10.1 里程碑拆分与顺序

**M7（独立里程碑，先做）：channel-core IM 基础设施扩展**
1. P7a：contract/outbox/service/format/schemas 扩展（reply context、`replySeq`、`NonRetryableDeliveryError`、`canDeliver`、capabilities、actions 扩展空间）；
2. P7b：`trustedChannels`/`defaultChannelId`、per-turn 多 driver 路由、notice 降级/defer、缺 driver 短路、可选 channel health；
3. P7c：`channel-local-test` 适配 + channel-core 单测/集成回归；不引入 QQ 代码，不新增外部依赖。
4. P7d：`pnpm check`、`pnpm test`、`pnpm test:process`、`nix flake check`；文档回写（03/05/06/13/14/15/16）。
> **状态：M7 已完成（2026-10-27）**。`local-test` 行为保持兼容，多 driver 路由、outbox 新字段、通知 defer 与 actions 契约可用；实现记录见 [14.8](14-roadmap.md)。

> **状态：M8 代码已实现（2026-10-27）**。`channel-qq-bot`、bundle/launcher/NixOS 装配、fake WS/REST 单元/集成/进程测试与自动化门禁已完成；真实平台 14 项门禁与 17.8.2 待执行。实现记录见 17.10.4 与 [14.9](14-roadmap.md)。

**M8（本规格，M7 之后）：QQ 官方 Bot 适配器**
1. P8a：`channel-qq-bot` 基础：config + 官方 SDK `./protocol` 薄封装（token/REST/WS）+ 单测。
2. P8b：driver 语义：入站映射/过滤、被动优先/replySeq、错误分类/频控 + 单测。
3. P8c：集成与装配：fake WS/REST 集成测试、bundle 行、Nix module/overlay/eval、`.env.example`、launcher/bundle 依赖清单、`nix/deps.nix` 哈希。
4. P8d：进程级与文档：fake QQ server 进程测试、`pnpm check`、`nix flake check`、README/spec 回写。
5. P8e：真实 Bot 验收：17.8.2 清单 + 目标机部署；记录结果。

### 17.10.2 文件级清单

**M7 修改**：`packages/channel-core/src/{contract,service,outbox,format}.ts`、新增 `packages/channel-core/src/routing.ts`、`packages/shared/src/schemas.ts`、`packages/channel-local-test/src/channel.ts`、`packages/agent-app/src/daemon.ts`、相关测试（`packages/channel-core/test/*`、`tests/integration/m7-channel-routing.test.ts`、m2 FakeDriver 签名）；`packages/bundle/cordis.patch.yml`（channel-core 行配置）、`nix/overlay.nix`（channel-core patch）；`vitest.unit.config.ts`/`nix/tests.nix`（flake unit 入口）。

**M8 新增**：`packages/channel-qq-bot/`（index/config/logger/errors/normalize/transport/rest/gateway/driver/limiter + test）、`packages/channel-qq-bot/scripts/qq-fact-gate.mjs`；`tests/support/fake-ws.ts`、`tests/process/support/fake-qq-bot.ts`、`tests/process/m8-qq.test.ts`、`tests/integration/m8-qq.test.ts`；`.spec/notes/qq-fact-gate.md`。

**M8 修改（已实现）**：`packages/bundle/cordis.patch.yml`、`packages/bundle/package.json`、`packages/launcher/package.json`（装配锚点）；`nix/module.nix`、`nix/overlay.nix`、`nix/check-module.py`、`flake.nix`、`nix/deps.nix`（FOD 哈希）、`pnpm-lock.yaml`；`.env.example`、`packages/launcher/src/index.ts`（helpText）；`.spec/03/04/05/06/12/13/14/15/16` 与 `README.md` 已回写。

**建议**：channel-core `status()` 增加 `channels` health；`format.ts` 前缀预留；daemon 恢复 `lastActiveChat`；outbox 耗尽通知收口。

### 17.10.3 门禁

- 每个提交：`pnpm check`；行为变更需测试。
- M7 完成：`pnpm test`、`pnpm test:unit`、`pnpm test:process`、`nix flake check`，local-test 回归通过（2026-10-27 已通过）。
- M8 代码完成（2026-10-27 已通过）：`pnpm check`；`pnpm test` 52 文件/374 测试；`pnpm test:unit`（flake unit）通过；`pnpm test:process` 7 文件/52 场景；`nix flake check`（package/unit/package-smoke/module-eval）通过；`nix build .#default` 通过。
- M8 验收完成（待执行）：真实 Bot 14 项平台事实门禁 + 17.8.2 全清单 + 目标机部署通过并记录。未执行前只能称“代码完成”。

### 17.10.4 M8 实现记录（2026-10-27）

- 新增 `packages/channel-qq-bot`：`QqRest` 直接使用 SDK `ApiClient`/`TokenManager`/`MessageApi`（`./protocol`），显式控制 `msg_id`/`msg_seq`（active 不带 `msg_seq`，避免 SDK 自动随机 seq）；`QqGateway` 包装 `GatewayConnection`（`intents=1<<25`、README/事件回调、`connectTimeoutMs` 内等待 READY 后后台重连）；`QqBotDriver` 实现被动优先、窗口/槽位、`activeMessageFallback` 标记、错误映射、长度/Markdown 回退、频控与 health。
- 入站：仅 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`；chatId `c2c:<openid>`/`group:<group_openid>`；忽略机器人自身、群全量、附件-only、空文本与互动事件；`receivedAt` 用平台 timestamp。
- **HTTP 200 业务错误**：SDK `ApiClient` 只在非 2xx 抛错；driver 在 REST 层检查响应体 `code`/`err_code` 并转成 `ApiError`，否则被动过期/主动不可用等错误会被误判为成功。
- **4009 行为**：SDK 1.0.5 将 4009 视为 `SESSION_TIMEOUT`，清会话并重新 Identify；其它可恢复关闭（如 1000/4008）走 Resume。该偏差记录在事实门禁 notes，真实平台若依赖 4009 resume 需后续评估自研。
- 测试：`packages/channel-qq-bot/test/` 7 文件/44 测试；`tests/integration/m8-qq.test.ts` 2 测试；`tests/process/m8-qq.test.ts` 10 场景（C2C/群、去重、超窗 active、active 失败 defer+补投、被动过期重试、token 刷新、断线 Resume、SIGTERM、双渠道路由）；fake WS/REST 零新增依赖（`node:http`/`node:crypto`）。
- 装配：bundle 行默认 disabled；Nix module `channel.qqBot.*`（13 选项）、assertions/warnings、overlay row、`nix/check-module.py`、flake sample/package-smoke、`.env.example`、launcher helpText；`nix/deps.nix` FOD hash 已更新。
- 已知边界：QQ-only 且无入站上下文时 `defaultTarget` 可能回退到 `qq-bot:local`（core 未改），但该路径只在人工命令/默认目标回退时出现；通知按 D161 defer/drop。真实平台门禁可能要求校准窗口/长度/域名/Markdown。

## 17.11 决策与待评审项

| ID | 主题 | 决议/建议 | 状态 |
|---|---|---|---|
| D149 | 里程碑重排 | **M7 = channel-core IM 基础设施扩展（先做）；M8 = QQ 官方 Bot；M9 = SSH host** | 用户已确认（2026-10-27） |
| D150 | 平台/传输 | QQ 官方 Bot；M8 用 WebSocket；transport seam 保留，WebHook 后置 | M8 已实现（2026-10-27）；WS 真实连接待门禁 |
| D151 | 发送策略 | 被动优先（core reply context + `replySeq`）+ `activeMessageFallback=auto`（能力门禁、失败可观测） | M8 已实现；主动可用性待实测 |
| D152 | 准入策略 | 只靠平台限制；core `trustedChannels:["qq-bot"]`；不做驱动级白名单 | 已确认（残余风险接受） |
| D153 | 回复上下文/会话持久化 | 上下文放 core+outbox（A2）；gateway 会话不跨进程持久化 | M8 已实现 |
| D154 | 协议层依赖 | 官方 `@tencent-connect/qqbot-nodejs@1.0.5`（MIT，exact pin），只消费 `./protocol` | 用户已确认 |
| D155 | 图片链路 | 后置 V8；M8 只忽略附件 | M8 已实现（只忽略） |
| D156 | 密钥与配置 | AppID 入 store；ClientSecret 走 EnvironmentFile/agenix；token 仅内存 | M8 已实现 |
| D157 | 验收边界 | fake 自动化 + 真实个人 Bot 手工 + 目标机部署；不做公开/群全量；14 项平台事实门禁 | fake 已通过；真实验收待执行 |
| D158 | channel-core 最小扩展 | 拆成**独立里程碑 M7** 先做（contract/outbox/错误分类/allowlist/多 driver），独立提交 | 用户已确认（2026-10-27） |
| D159 | 多 driver 路由与通知降级 | per-turn 路由 + notice active-capable 回退/丢弃 + 缺 driver 短路 + 显式默认渠道 | M7 已实现；M8 双渠道进程测试通过 |
| D160 | 能力位/窗口默认 | `markdown=basic`、`maxTextLength=4500`、`maxRepliesPerReply=4`、chatId 命名空间 `c2c:`/`group:`、`replySeq` 1..N | M8 已接入；真实平台校准待门禁 |
| D161 | 提醒/系统通知降级 | **B：active 尝试 + 失败后 defer（下次入站被动补投）**；A/C 不采用 | 用户已确认（2026-10-27）；M7 core + M8 driver 已实现 |
