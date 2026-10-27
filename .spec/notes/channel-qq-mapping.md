# channel-core ↔ QQ 官方 Bot 接口映射与改动清单

> 对应共享任务：`task-2`（映射 QQ 渠道到现有 channel 架构并产出改动清单）。
> 状态：**规格分析草案（2026-10-27）**，供 [.spec/17](../17-qq-official-bot.md) 与实现评审；本文件**不改**任何源码、现有规格或决策记录。
> 代码基线：当前工作区 HEAD（M1–M6 已实现）。平台事实以 [`.spec/notes/qq-official-bot-api-facts.md`](qq-official-bot-api-facts.md)（task-1，进行中）与官方文档为准；本文中凡未在真实 Bot 上验证过的行为均标 **【待实测】**，两处来源互相矛盾标 **【冲突】**。
> 改动分类约定：**【必须改】** = M7 正确性依赖；**【建议改】** = 可延后但建议同批做；**【仅记录】** = 本轮不改、实现/后续版本再处理。

---

> **2026-10-27 修订（与 task-1 事实表对齐）**：本文件初稿完成后，[`qq-official-bot-api-facts.md`](qq-official-bot-api-facts.md) 已完成（807 行，含来源与冲突清单）。据此修正了初稿的以下判断：文本上限按 **~5000 / 默认切 4500**（非 2000）；单聊/群聊 **Markdown 已对所有机器人开放**（默认 `basic`，非 `none`）；被动窗口/次数按 **单聊 60min/4 次、群聊 5min/5 次**；token/API 和 Identify 格式以事实表为准（`Authorization: QQBot`、Identify `QQBot {AccessToken}`）；错误码分类改用事实表 §8.2；官方 MIT Node SDK `@tencent-connect/qqbot-nodejs` 与 DSH 插件 `@tencent-connect/dsh-qqbot` 存在，零依赖自研不再是唯一选项（D154 待 task-3 结论）。仍保留两个**未决冲突**并升级为实测门禁：① 主动推送“2025-04-21 起不再提供”的官方横幅 vs 事实表“主动消息仍有配额”；② WebSocket 将迁移 webhook 的旧公告 vs 当前事件文档仍写 WS。详见 §2.6、§9。

## 0. 结论摘要（TL;DR）

1. **被动回复上下文必须由 channel-core + outbox 承载，而不是 driver 内存/私有状态**（§3.1）。outbox 是异步、持久、可重试的；只有 core 在 enqueue 时知道“这条出站是回复哪条入站”，driver 的 `send(chatId, content)` 拿不到这个信息。推荐方案 A2：给 core/outbox 增加最小 `reply` 上下文与投递元数据，`msg_seq` 用 outbox 的持久 `seq` 派生（幂等重试）。
2. **channel-core 最小扩展面**（§3.1、§3.3、§3.4）：`OutboundContent` 增加 `kind/deliveryId/attempt/reply`；新增 `NonRetryableDeliveryError`；`ChannelCapabilities` 增加可选 `activeMessages`/`maxRepliesPerReply`；`ChannelDriver` 增加可选 `canDeliver()`；outbox item 持久化 `replyTo/replyReceivedAt/replySeq`；新增 `trustedChannels` 配置。**这些是 QQ 适配的前置项，不建议全部塞进 driver。**
3. **allowlist 采用 `.spec/17` 6.2 的候选 A：`trustedChannels: ["qq-bot"]` 跳过全局静态 allowlist**（§3.2）。不使用全局通配符 `*`（会顺带放开 local-test 的配置边界）；QQ driver 只做平台级最小过滤（只订阅 `1<<25`、只处理两类消息事件、忽略附件/空文本）。**残余风险很高**：任何能私聊机器人或在群里 @ 机器人的 QQ 用户都能驱动一个拥有 `NOPASSWD: ALL` 可能性的 agent；最小防护见 §3.2.4。
4. **多 driver 语义必须修**（§3.3）：`lastActiveChat` 是全局的、`defaultChannelId` 取第一个注册 driver、通知/审批/回复全部走该全局值；local-test 与 QQ 同时启用会串渠道。推荐 per-turn 来源路由 + notice 的 active-capable 回退 + 缺失 driver 短路失败；否则 M7 只能断言两渠道互斥。
5. **“超窗/超次数回退主动消息”策略可行，但必须 capability-gated**（§2.6、§3.4、§9）：task-1 事实表确认主动消息仍有配额/频控/用户开关与完整错误码（§6.3、§8.2、§9.2），但官方 hand-written 发送页顶部同时有“主动推送能力于 2025-04-21 起不再提供”的横幅（本次核对在 bot-docs 仓库与页面均看到），社区也有 `40034102` 失败记录；两者矛盾未解。因此 D151 按用户决策实现“被动优先 + 主动回退”，但以 `activeMessageFallback: auto` 能力门禁实现，失败必须可观测；schedule/提醒/系统通知在 QQ-only 部署下可能无法送达用户（C2C 的 `is_wakeup` 召回是后置候选）。
6. **协议层可以零新增依赖自研，但官方已有 MIT Node SDK**（§5.2、§6.1）：Node 24 内置 `WebSocket`/`fetch` 可覆盖生产，`tests/process` 仍需要一个基于 `node:http` + 手写帧编解码的 fake QQ server；同时 task-1 发现官方 `@tencent-connect/qqbot-nodejs`（MIT，仅依赖 `ws`）与 `@tencent-connect/dsh-qqbot`（MIT）可用，是否引入由 task-3 决策（D154）。部署风险：Node fetch 不读 `HTTP(S)_PROXY`；官方 Node 运行时需 smoke 验证 `WebSocket` 全局存在。

---

## 1. 现有 channel 架构基线（代码事实）

### 1.1 端到端数据流

```
platform → ChannelDriver.start({onInbound})
  → ChannelService.ingress()        service.ts:436
    → (图片直接 unsupported-images) service.ts:437-443
    → [未 attachRuntime] 启动缓冲    service.ts:444-452
    → process() 串行链             service.ts:571-622
        → allowlist                 service.ts:572-581
        → 持久去重 (channelId+messageId) dedupe.ts:30-52
        → 空文本丢弃                service.ts:587-590
        → lastActiveChat 更新       service.ts:601-608
        → /command                 service.ts:610-613
        → 待应答 broker            service.ts:615-617
        → steer/followup/interrupt  service.ts:619-620, 637-654
  → agent turn end（daemon 监听 session/event）
    → channels.sendReply()          daemon.ts:540-563, service.ts:416-423
    → enqueueText() → formatOutbound → outbox.enqueue()
  → outbox pump（按 seq 串行）       service.ts:756-826
    → driver.send(chatId, {kind:"text", text})  service.ts:789-795
    → markSent / markAttemptFailed  outbox.ts:101-130
```

### 1.2 契约与能力位（`packages/channel-core/src/contract.ts`）

| 元素 | 位置 | 现状要点 |
|---|---|---|
| `ChannelCapabilities` | `contract.ts:4-11` | `markdown: none/basic/full`、`maxTextLength`（0=不限）、`inboundImages`、`outboundFiles` |
| `InboundMessage` | `contract.ts:13-29` | `channelId/chatId/senderId/messageId/text?/images?/replyTo?/receivedAt/delivery?` |
| `OutboundContent` | `contract.ts:34-38` | **只有** `kind:"text"` + `text`；没有 kind、msg id、重试次数 |
| `SentRef` | `contract.ts:40-45` | `channelId/chatId/messageId`；core 目前**忽略**返回值（`service.ts:789-795`） |
| `ChannelDriver` | `contract.ts:47-54` | `id/capabilities/start/stop/send(chatId, content)` |
| `IngressResult.reason` | `contract.ts:69-78` | `not-allowed/buffered/unsupported-images/paused/empty`；driver 的 `onInbound` 是 `void`，**driver 无法感知 core 丢弃原因** |

能力位消费点：`formatOutbound()`（`format.ts:56-67`）做 markdown 降级与分段；`enqueueText()` 在 driver 不存在时用兜底能力位（`service.ts:472-477`）。新增能力位应保持**可选**，避免破坏现有 fake driver（`tests/integration/m2-child-approval.test.ts:38-61`）。

### 1.3 outbox（`packages/channel-core/src/outbox.ts` + `packages/shared/src/schemas.ts`）

| 事实 | 位置 |
|---|---|
| `OutboxItem` 字段：`seq/channelId/chatId/kind/text/interactionId/state/attempts/nextAttemptAt/createdAt/sentAt` | `shared/src/schemas.ts:10-23` |
| 文档 `version:1` + `nextSeq` + `items`；zod `.passthrough()`，旧文件缺新字段也兼容 | `schemas.ts:25-64` |
| `enqueue()` 先持久化再返回；条目 `state:"pending"`、`attempts:0` | `outbox.ts:76-99` |
| 投递成功 `markSent`、失败 `markAttemptFailed(nextAttemptAt, exhausted)`；耗尽置 `failed` | `outbox.ts:101-130` |
| 终态历史有界裁剪、pending 不裁剪 | `outbox.ts:220-236` |
| **没有** `replyTo`/`replyReceivedAt`/`delivery kind` 之外的平台投递元数据 | 全局 |

### 1.4 allowlist / 去重 / 命令 / 交互 broker

- allowlist 是**全局静态数组**：`allowedSenders`、`allowedChats`（`service.ts:181-193`），默认 `["local-user"]`/`["local"]`（`service.ts:182-183`）。QQ 的 openid 无法预知，若不改代码，**所有 QQ 入站都会在 `process()` 被 `not-allowed` 丢弃**（`service.ts:572-581`）。
- 去重键 `channelId + "\0" + messageId`，持久在 `$DSH_HOME/state/ingress-seen.json`（`service.ts:582-586`、`dedupe.ts:30-52`）。QQ 事件重复推送由 core 承担，driver 不需要去重。
- 命令与 broker 完全复用：`/` 命令（`service.ts:610-613, 656-680`）、待应答优先（`service.ts:615-617`）。QQ 侧无需感知。
- broker 的提示发送**只 enqueue，不等平台结果**：`sendPrompt` 取 `lastActiveChat` 并 `enqueueText`（`service.ts:236-247`）。因此 QQ 窗口过期/发送失败时，broker 仍会等超时（或在超时后发通知，而通知也会失败），**不会 fail closed**——这是 §3.1/§3.3 需要修的点。

### 1.5 多 driver 与路由现状

| 语义 | 现状 | 位置 |
|---|---|---|
| 活跃 chat | `lastActiveChat` 是 ChannelService 的**全局**字段，任渠道一条被接受的消息都会覆盖 | `service.ts:213-216, 601-608` |
| 出站 channel | `enqueueText()` 一律取 `lastActiveChat.channelId ?? defaultChannelId()` | `service.ts:469-471` |
| 回复/通知/交互 | `sendReply()`、`notify()`、broker `sendPrompt` 全部复用 `lastActiveChat` 或默认 chat | `service.ts:416-423, 491-499, 236-247` |
| 默认渠道 | `defaultChannelId()` = **第一个注册的 driver**（Map 迭代序）；无 driver 时固定字符串 `"local-test"` | `service.ts:566-569` |
| 默认 chat | 全局 `defaultChatId`，bundle 固定 `"local"`（`bundle/cordis.patch.yml:290`） | `service.ts:184` |
| driver 缺失 | pump 只按 `outboxBaseDelayMs` 重排 pump，**条目永远 pending**（无日志、无耗尽） | `service.ts:781-788` |
| lastActiveChat 持久化 | daemon 落盘 `state.lastActiveChat`（`daemon.ts:945-965`），但恢复时**没有**写回 channel-core（`daemon.ts:308-394` 无 setter 调用）；重启后 service 内为 `null` | `daemon.ts:318-334, 474-489` |
| driver 健康 | `status()` 不包含 driver/连接状态；`ready` 只表示 runtime attached/daemon ready | `service.ts:530-550`、`daemon.ts:491-513` |

### 1.6 启动/关闭/看门狗

- 启动：插件树加载 → channel driver `start()`（local-test 先 listen）→ agent-app 取锁/recover/attachRuntime → `resumeOutbox()` → `drainBuffered()` → 写 `run/ready.json` → `systemd-notify READY=1` 并启动 watchdog（`.spec/05` 5.3；`daemon.ts:308-394`）。
- 关闭：`channels.pause()` → `abortInteractions("shutdown")` → 等轮次 grace → flush → Cordis `fiber.dispose()`；channel-core 的 dispose 与 daemon 的 shutdown effect **并发**执行，`ChannelService.dispose()` 里 `Promise.allSettled(driver.stop())`（`service.ts:836-853`）。
- 看门狗：`SystemdNotifier` 用约 `WATCHDOG_USEC/3` 的 `setTimeout` 周期 spawn `systemd-notify WATCHDOG=1`（`shared/src/systemd.ts:30-52, 140-210`）。QQ driver 的重连/心跳必须是**定时器驱动**，不能阻塞事件循环。
- 启动缓冲：`attachRuntime` 之前入站进内存（`service.ts:444-452`），恢复后按到达序放行（`service.ts:396-409`）；QQ 网关在启动期收到的事件可安全缓冲，但**不持久**，进程崩溃即丢（用户可重发）。

---

## 2. 驱动器映射表（任务 1）

### 2.1 channelId / chatId / senderId 设计（推荐）

QQ 同一消息事件在不同场景使用不同 openid，且**发送端点取决于 chat 类型**（群 vs 单聊），而 outbox 会在重启后重放只含 `chatId` 的条目。因此 **chatId 必须自描述类型**，否则 driver 必须持久化额外映射（与“零 driver 状态”目标冲突）：

| 场景 | `chatId`（推荐） | `senderId`（推荐） | 说明 |
|---|---|---|---|
| 单聊 C2C | `c2c:<author.user_openid>` | `c2c-user:<author.user_openid>` | 同一 user_openid 仅对当前 bot 稳定（官方“唯一身份机制”：不同 AppID 的 openid 不同） |
| 群 @ | `group:<d.group_openid>` | `group-member:<author.member_openid>` | member_openid **仅在同一 bot 的同一群内**稳定；跨群不同，不能当全局用户身份 |
| `channelId` | 固定 `"qq-bot"`（与 driver.id 一致） | — | outbox 行、去重键、trustedChannels 都使用它 |
| `messageId` | 事件 `d.id` | — | 官方示例形如 `ROBOT1.0_...`；直接作为去重键与被动 `msg_id` |
| `replyTo` | **不设置** | — | 官方群/单聊事件字段中**没有**被引用消息 id；出站 `message_reference` 标注“暂未支持”；不要伪造 |

> 与 `.spec/17` 4.1 的差异：17 草案把 `chatId` 直接写成裸 openid。裸 openid 无法在 `send()` 中区分群/单聊（两者都是 hex 串），且 17.5.2 把上下文放在 driver 内存——两者叠加后重启即失效。**建议 17 采纳 `c2c:`/`group:` 命名空间**；core 对 chatId 保持 opaque，无需理解前缀。
>
> 去重补充（事实表 §5.8、§12#5）：事件 `id` 是主 key；`message_scene.ext.msg_idx` 可作为辅助幂等键（平台文档建议结合，core 仍以 `id` 永久去重；若实测发现同一逻辑消息可能换 `id`，driver 可在归一化时把 `msg_idx` 混入 messageId，但会改变被动 `msg_id` 语义，**不建议**默认做）。群 @ 事件 `content` 已被平台去掉 @ 前缀（事实表 §12#5），清洗函数只做防御性处理。


### 2.2 事件字段 → `InboundMessage`

| `InboundMessage` 字段 | `C2C_MESSAGE_CREATE` | `GROUP_AT_MESSAGE_CREATE` | 备注 |
|---|---|---|---|
| `channelId` | `"qq-bot"` | `"qq-bot"` | |
| `chatId` | `c2c:<d.author.user_openid>` | `group:<d.group_openid>` | 群 openid 字段名官方事件字段表为 `group_openid`（示例在 `d` 顶层） |
| `senderId` | `c2c-user:<d.author.user_openid>` | `group-member:<d.author.member_openid>` | |
| `messageId` | `d.id` | `d.id` | 平台会重复推送同一 id（官方事件说明），由 core 去重 |
| `text` | `d.content`（`trim()`） | `d.content`（`trim()`，防御性去前导 `<@!botid>`） | 事实表 §12#5：群 @ 事件的 `content` **已由平台去掉 @ 前缀**，示例带前导空格；清洗仅为防御。 |
| `images` | **不设置** | **不设置** | `capabilities.inboundImages=false`；`attachments` 忽略并记录，理由见 §3.6 |
| `replyTo` | 不设置 | 不设置 | 见 2.1 |
| `receivedAt` | `Date.parse(d.timestamp)`（RFC3339），非法时 `Date.now()` | 同左 | 被动窗口判定基准**必须**用平台时间而非接收时间（但两者差通常很小；待实测时钟偏差） |
| `delivery` | 不设置 | 不设置 | 交给 core 按 agent 忙碌/空闲选择 steer/followup |
| 鉴权/intents | `1 << 25`（`GROUP_AND_C2C_EVENT`，同时含 C2C/群 @/好友/群增删等事件） | 同左 | driver 只处理两类 message 事件；`GROUP_MESSAGE_CREATE`（群全量，事实表 §5.4）与 lifecycle 事件显式忽略并 debug 日志（用户决策：群聊只接 @）。 |

群 @ 清洗建议：`content.replace(/^<@!?\d+>\s*/,"").trim()`（正则待按真实样例修正）；不要删除正文中的 `/` 命令前缀。

### 2.3 能力位

| 能力 | 推荐值 | 依据/影响 |
|---|---|---|
| `markdown` | **`"basic"`（默认，可配 `none`/`full`）** | task-1 事实表 S25（2026-04-23 更新）：单聊/群聊自定义 Markdown **已对所有机器人开放、无需模板**（频道仍需内邀）。`basic` 保留代码块/列表/粗体并去掉 HTML/表格（`format.ts:10-28`），匹配 QQ 文档列出的标题/强调/列表/引用/分割线语法；但 QQ 文档**未列出代码块与 GFM 表格**，AI 输出可能显示不佳 → 实测后可在 `none`/`basic` 间调整。GitHub 上的旧文档副本仍写“需内邀/被动 MD 申请”，属过期文案【冲突，见 §2.6#6】。 |
| `maxTextLength` | **4500（配置项；平台上限约 5000）** | 官方文档未写数字；事实表 §7.1：官方 Node SDK 常量 ~5000、官方 dsh-qqbot 默认切 4500，第三方多称 2000 → **【冲突/待实测】**。取 4500 保守值，由 core 分段；实测 `40054007`/`40054018` 后校准。 |
| `inboundImages` | `false` | core 对带 `images` 的入站直接返回 `unsupported-images`（`service.ts:437-443`），**发生在 allowlist/缓冲之前**；若 driver 把附件塞进 `images`，带文字+图片的消息会整条被拒。 |
| `outboundFiles` | `false` | 本里程碑不做富媒体；V8 预留见 §3.6。 |
| `activeMessages`（新增，可选） | 由 `activeMessageFallback` 配置推导（`auto` → true，`off` → false） | core 用它做 notice 路由（§3.3）与交互 fail-fast（§3.1）。 |
| `maxRepliesPerReply`（新增，可选） | **`4`（保守值；群聊平台允许 5，单聊 4）** | 事实表 §6.2：单聊被动 **60 分钟 / 每条消息 4 次**；群聊 **5 分钟 / 5 次**（C2C 发送页另有“5 分钟有效”字段说明、DSH 插件用 30min 缓存，均属保守实现差异）。core 单个能力位只能取最小值 4 做预截断；群聊第 5 条会被截断，属安全侧偏差（后续可按 chat 类型扩展能力）。 |

补充：`formatOutbound()` 先按 `maxTextLength` 分段、再给每段加 `(i/n) ` 前缀（`format.ts:63-66`），**分段后每条实际长度会超过 `maxTextLength` 若干字节**。QQ 若确有 ~5000 硬上限（事实表建议按 4500 切分），必须修 core：按 `maxTextLength - 前缀预留` 切分，或切分后校验并重切。**【必须改】**（对 local-test `maxTextLength=0` 无影响，但 QQ 会直接触发）。

### 2.4 `send()` → QQ OpenAPI v2 映射

| core 调用 | QQ 请求 | 说明 |
|---|---|---|
| 鉴权头 | `Authorization: QQBot <access_token>` | 官方《接口调用与鉴权》写明 `QQBot ACCESS_TOKEN`；`Authorization` 值随所有 OpenAPI 调用。 |
| token | `POST https://api.bot.qq.com/app/getAppAccessToken`（文档）或 SDK 默认 `https://bots.qq.com/app/getAppAccessToken`；body `{appId, clientSecret}` | 事实表 §2/§14：token/API base 均存在文档（`api.bot.qq.com`）与官方 SDK（`api.sgroup.qq.com`/`bots.qq.com`）两套来源**【冲突，必须配置化并实测】**。返回 `access_token` + `expires_in`（约 7200s；失败时可能 HTTP 200 + body code）；到期前 60s 内再取会换新、旧 token 再有效 60s → driver 在 `expiresAt - 60s` 刷新，单飞。 |
| 统一 base / Identify | REST `https://api.bot.qq.com`（文档）或 `https://api.sgroup.qq.com`（SDK）；WS 用 `GET /gateway` 动态取地址；Identify token `QQBot {AccessToken}` | 事实表 §2–§4：REST 头 `Authorization: QQBot <access_token>`；WS Identify/Resume token 同为 `QQBot {AccessToken}`（旧文档 `Bot appid.token` 是已废弃 Bot Token 体系）。`/gateway` 返回的 URL 文档示例为 `wss://api.bot.qq.com/websocket/`，SDK/历史域名 `api.sgroup.qq.com`。 |
| 群聊发送 | `POST /v2/groups/{group_openid}/messages` | body：`content`、`msg_type:0`、可选 `msg_id`、`msg_seq`。 |
| 单聊发送 | `POST /v2/users/{user_openid}/messages` | 同上。 |
| 被动回复 | 带 `msg_id`（入站事件 `d.id`）+ `msg_seq`（同一 msg_id 下唯一、递增；不填默认 1；相同 msg_id+msg_seq 重复发送失败 `40054005`） | 事实表 §6.2：单聊 **60 分钟/4 次**；群聊 **5 分钟/5 次**（规范表；字段说明/插件实现更保守）。配置 `c2cReplyWindowSeconds=3600`、`groupReplyWindowSeconds=300`，driver 每次尝试前检查窗口。 |
| 主动消息 | 不带 `msg_id`；单聊可选 `is_wakeup=true`（互动召回） | 事实表 §6.3/§9.2：主动消息受配额/频控/用户开关限制（每个关系每日 1000 条；单聊企业/个人 10 QPS、未认证 5 QPS+30 QPM；群聊 60 QPM/未认证 30 QPM）；用户/群管理员可关闭。**另**：官方 hand-written 发送页顶部横幅称 2025-04-21 起主动推送不再提供（与配额描述矛盾），社区有 `40034102` 失败记录 → **【冲突/待实测，见 §9】**。 |
| 响应 | `{id, timestamp}` | `id` 作为 `SentRef.messageId`；`timestamp` 可记录。 |
| 错误 | HTTP 状态 + body `{err_code, message, trace_id}`（`err_code=0` 成功；响应头 `X-Tps-trace-ID`） | 事实表 §8.2 的分类见 §3.4；不要日志打印 token/secret，`message` 可只记摘要。 |
| HTTP 超时 | 官方建议**最低 5 秒**（避免实际已发送但没收到结果） | driver 用 `AbortSignal.timeout(requestTimeoutMs)`（默认 10s，可配）。 |
| URL 限制 | 内容含 URL 可能被拒绝；`40054010` 明确“不允许发送 URL”（群） | 事实表 §8.2；提示词可要求少输出裸链接，driver 可选 `stripUrls`（后置）。 |
| 发送频控 | 发送接口 **100 QPS（含主动/被动）**；主动消息另有关系/每日配额；限频错误码 `100001`、`50002`、`40034100` 等 | 事实表 §9；outbox 串行发送即远低于 QPS，只需对频控错误退避。 |

`send()` 需要的信息与 core 现状的差距：QQ 需要 `msg_id`（=入站事件 id）+ `msg_seq`（同一入站消息的回复序号）+ `chat` 类型；core 的 `OutboundContent` 只有 `{kind:"text", text}`（`contract.ts:34-38`）。这是 §3.1 方案对比的核心。

### 2.5 token / 日志

- token 只放内存；不写状态文件、不进 outbox、不进 `agent-state.json`。
- 日志字段建议：`channel=qq-bot`、`event=t`、`messageId`、`chatKind=group|c2c`、`attempt`、`httpStatus`、`errCode`、`traceId`、`latencyMs`；**绝不**记录 `content`、`access_token`、`client_secret`、`message_scene.ext.auth_token`、附件 URL/rkey、完整 webhook/签名材料。项目日志约定见 `.spec/13` 13.6 与 `shared/src/log.ts:66-125`（warn/error 自动进 recent ring）。
- 发送失败日志是 QQ 用户侧唯一可观测线索（因为 QQ 无法再发“失败通知”），必须包含 `errCode` 与 `deliveryId`。

### 2.6 与 `.spec/17` 草案、官方文档的冲突/待核实项

| # | 项 | 本文结论（对齐 task-1 事实表） |
|---|---|---|
| 1 | 主动推送可用性 | 事实表 §6.3/§8.2/§9.2 给出主动消息配额、频控、用户开关与错误码；但官方 hand-written 发送页顶部横幅称 2025-04-21 起主动推送不再提供，社区有 `40034102` 失败记录。**【冲突，最高优先级实测】** D151 保留主动回退，但按 `auto` capability gate 实现，失败可观测；C2C `is_wakeup` 召回（事实表 §6.3，30 天/4 周期/每周期 1 条）列为后置降级候选。 |
| 2 | WebSocket 是否仍被官方维护 | 本次在 GitHub bot-docs master 的 event-emit 页看到“WS 将逐步下线、迁移 webhook”，但 live 事实表 §4 未复现该提示、群/单聊事件仍写 WebSocket，17.3 也称 WS 为推荐方式。**【冲突降级为“旧公告/文档副本可能过期”】** D150 保留 transport seam，M7 实现 WS；实现前按 live 文档/连通性复核（§3.5.5）。 |
| 3 | token/API 域名 | 事实表 §2/§14：文档 `api.bot.qq.com` vs 官方 SDK `api.sgroup.qq.com`/`bots.qq.com`。**【冲突】** 代码必须把 `apiBaseUrl/gatewayUrl/tokenUrl` 配置化，默认取文档域名并保留 SDK 域名备选；实现前实测两者可用性。 |
| 4 | Identify token 格式 | 事实表 §12#2 已核实：`QQBot {AccessToken}`（当前文档 + 官方 SDK 一致）；旧文档 `Bot {appid}.{app_token}` 属废弃 Bot Token 体系。17.2.1 的旧猜测应更新。 |
| 5 | 单聊被动窗口/次数 | 事实表 §6.2 规范表：单聊 **60 分钟/4 次**；群聊 **5 分钟/5 次**。C2C 发送页字段说明写“5 分钟有效”、官方 DSH 插件缓存 30 分钟 → 实现取保守 TTL，配置化。 |
| 6 | Markdown 默认能力 | 事实表 §7.2（S25，2026-04-23 更新）：单聊/群聊自定义 Markdown 已对所有机器人开放、无需模板；GitHub 旧文档副本仍写内邀（版本陈旧）**【冲突，取事实表】**。默认 `basic`；代码块/GFM 表格是否渲染【待实测】。 |
| 7 | 单聊/群聊发送是否要求 WebSocket 在线 | 仅“文字子频道”段落明确要求；C2C/群 v2 未写。**【待实测】** 断 WS 后发 REST；若返回旧码 `304018` 或新码，按可重试处理（§3.5.2）。 |
| 8 | `chatId` 命名空间 | 17.4.1 用裸 openid；本文建议 `c2c:`/`group:` 前缀（§2.1），否则重启重放时 driver 无法区分发送端点。 |
| 9 | 回复上下文位置 | 17.5.2 放 driver 内存；本文推荐 core+outbox 扩展（§3.1），这是需要评审的最大分歧点。 |
| 10 | `is_wakeup`/`message_scene.ext` 等字段 | 事实表 §5/§6.3 已核实存在（`is_wakeup` 仅单聊；`message_scene.ext` 含 `msg_idx/ref_msg_idx/auth_token`）。实现以事实表为准；`auth_token` 不得进日志。 |

---

## 3. 关键缺口与方案（任务 2）

### 3.1 被动回复上下文（`msg_id`/`msg_seq`）跨 outbox 异步与重启

#### 3.1.1 现状为什么不够

- outbox 条目只有 `channelId/chatId/kind/text`（`shared/src/schemas.ts:10-23`）；driver 的 `send()` 也只拿到 `chatId + text`（`contract.ts:53`）。**driver 无法知道这条出站消息回复的是哪条入站事件**。
- 回复在 turn 结束时产生（`daemon.ts:540-563`），可能距入站数秒到数分钟；outbox 重试又可能再延迟 ~2 分钟（默认 8 次、指数退避，`service.ts:796-823`），期间用户可能又发了消息，`lastActiveChat` 已变（`service.ts:601-608`）。
- 重启后 outbox pending 条目继续发送（`service.ts:384-393`），但进程内的“最后入站”信息已丢失；若上下文只存在 driver 内存，重启后全部退化为主动消息（而主动消息是否可用存在冲突，见 §2.6#1）。
- 分段长回复会拆成多条 outbox 条目（`service.ts:478-486`），每条都需要不同的 `msg_seq` 且共享同一 `msg_id`；哪个 chunk 用第几个 seq 必须可持久推导。

#### 3.1.2 候选 A：扩展 channel-core 契约 + outbox 条目（推荐）

**最小字段草案（A2 完整版）**

```ts
// contract.ts
export interface ReplyContext {
    /** 平台消息 id，被动回复的 msg_id。 */
    readonly messageId: string;
    /** 平台消息时间（ms），用于窗口判定。 */
    readonly receivedAt: number;
    /** 同一 msg_id 的第几条回复（1..N），即 QQ 的 msg_seq。 */
    readonly seq: number;
}

export type OutboundKind = "reply" | "notice" | "interaction";

export interface OutboundContent {
    readonly kind: OutboundKind;
    readonly text: string;
    /** outbox 持久 seq；跨重试/重启稳定，用于日志与幂等追踪。 */
    readonly deliveryId: number;
    /** 该条此前失败次数（0 表示首次）。 */
    readonly attempt: number;
    /** 存在时表示可走被动回复。 */
    readonly reply?: ReplyContext;
}

export class NonRetryableDeliveryError extends Error {
    readonly reason: string;
    constructor(reason: string, message?: string) { /* ... */ }
}

export interface ChannelCapabilities {
    // 现有 4 个字段保持不变
    /** 能否在没有被动上下文时投递（QQ 当前为 false/auto）。缺省视为 true。 */
    readonly activeMessages?: boolean;
    /** 单条被动上下文最多允许的回复条数；0/缺省不限。 */
    readonly maxRepliesPerReply?: number;
}

export interface ChannelDriver {
    // ...
    /** 可选：core 在 enqueue 交互/通知前做可投递性预检。 */
    canDeliver?(
        chatId: string,
        content: Pick<OutboundContent, "kind" | "reply">
    ): boolean;
}
```

**outbox 条目新增字段**（`shared/src/schemas.ts`，保持 `version:1` + 字段可选，旧文件可读）：

```ts
readonly replyTo?: string | null;          // 平台消息 id（msg_id）
readonly replyReceivedAt?: number | null;  // 平台消息时间（ms）
readonly replySeq?: number | null;         // 1..N，QQ msg_seq；重试/重启保持不变
```

zod schema 加 `.optional().nullable()`；`OutboxStore.enqueue` 写入。新增字段随 `.passthrough()` 保留，旧 outbox 升级后缺省视为“无被动上下文”。

**core 侧改动**（`packages/channel-core/src/service.ts`）：

1. 新增 `lastInboundByChat: Map<string, ReplyContext & {channelId, chatId}>`（key `channelId\0chatId`），在 `process()` 去重/空文本检查之后设置（`service.ts:582-590` 之后）。
2. 新增 `turnChat`：当一次投递以 `followup` 开始时记录来源 chat（`service.ts:619-620, 648-653`）；`steer` 不覆盖（同轮多消息归属该轮起点）；无用户消息触发的轮次（goal report/schedule）沿用最近 turn。
3. `sendReply()`/broker `sendPrompt` 的目标由 `turnChat ?? lastActiveChat ?? defaultChannelId()` 决定；回复上下文取该 chat 的 `lastInboundByChat`。
4. `enqueueText()` 改为接收显式 chat + 可选 `reply`；分段时每条 chunk 共享同一 `msg_id`，`replySeq` 从该 reply 上下文已有 outbox 条目的最大 `replySeq` 递增（或由调用方传入起算值），并把 `replyTo/replyReceivedAt/replySeq` 持久化到 `outbox.enqueue`。
5. pump 构造 `OutboundContent{kind, deliveryId:item.seq, attempt:item.attempts, reply:{messageId:item.replyTo, receivedAt:item.replyReceivedAt, seq:item.replySeq}}`；`replySeq` 跨重试/重启稳定 → 同一条目重试仍用同一 (msg_id,msg_seq)，平台会以 `40054005` 拒绝重复而非产生重复消息（见 3.4.3）。
6. 错误分类：`NonRetryableDeliveryError` 立即 `markAttemptFailed(seq, null, true)`；其余走现有退避（§3.4）。

**改动面**：`contract.ts`、`service.ts`、`outbox.ts`、`shared/src/schemas.ts`、`channel-local-test/src/channel.ts`（send 签名放宽为 `OutboundContent`，忽略 reply）、`tests/integration` 的 FakeDriver 签名、`bundle`/`nix` overlay 的 channel-core 行 config、测试。**复杂度中等**，但全部是纯增量、可独立评审与测试。

**失败边界（明确接受）**：

- 重启后 outbox 待发条目的被动上下文可能已超窗（群 5 分钟）→ driver 抛非重试错误、条目记 `failed`；用户收不到该条回复。这是“重启耗时 > 窗口”的固有损失，只能日志/告警。
- 通知/提醒这类没有入站上下文的条目不适用被动；QQ active 不可用时只能失败/路由到其他 active-capable 渠道（§3.3）。
- 交互提示：若当前 turn 的入站已超窗（长任务），`canDeliver=false` → broker 立即 fail closed（审批 `unavailable`、提问 `NO_PROVIDER`），而不是静默等超时（改进，但用户可能收不到提示；日志留痕）。
- 同一 chat 多用户并发 @：回复挂在“最近一条入站”的 msg_id 上，平台语义上仍是群消息；不保证视觉上引用原问题。窗口/次数判断以该 msg_id 为准。
- 分段超过 `maxRepliesPerReply`（保守 4）：core 在 enqueue 时截断最后一段并加省略标记（建议策略），避免第 5 段在单聊必然失败。若选择不截断，失败边界是“超出部分丢弃 + 日志”。

#### 3.1.3 候选 B：driver 内部状态（= .spec/17 5.2 的内存 map，或再加私有持久化文件）

**无持久化版（17.5.2）**：driver 维护 `chatId → {messageId, receivedAt, replyCount, windowMs}`；`send()` 若上下文有效则被动，否则主动；收到窗口类错误清上下文并主动重试。

**持久化版（B'）**：driver 另写 `$DSH_HOME/state/qq-bot.json`（chatId → 上下文 + count），启动加载，按窗口清理。

**问题清单（按危害排序）**：

1. **重启即失效**：outbox 的回复在入站之后生成、可能跨重启；内存版全部退化为 active（当前不可用）；B' 能补，但引入了 core 与 driver 两份持久状态的**事务不一致**（outbox pending 但 driver 状态被清理/损坏；或反过来）。
2. **异步错配**：回复在 turn 结束才入 outbox；如果同 chat 在轮内有新 @（有人 @ 了机器人或用户补发消息），driver 的“最近一条”会指向新消息，旧回复挂到新 msg_id 上；B 无法区分“这条 outbox 条目属于哪次入站”。core 在 enqueue 时恰好知道。
3. **segments 与 `msg_seq`**：driver 必须自己维护 per-msg 计数；重启/重试后计数丢失 → 同 seq 重复（平台拒绝）或跳号；core 的 outbox seq 天然稳定且全局唯一。
4. **多 driver/多 chat 语义一致**：B 让每个 driver 重新发明“回复归属”，而 core 已有 `kind`/`interactionId`/seq 等语义；评审与测试面扩大。
5. **交互 fail-closed**：B 的 `send()` 在出错时才失败，broker 仍会等超时；无法在 enqueue 前 fail closed（除非 core 加 `canDeliver`，那已经接近 A）。
6. **隐私/状态目录**：B' 新增持久文件、schema 版本、清理与恢复逻辑（`shared/src/paths.ts:6-26` 要加路径），与“零新增状态”目标冲突。

**唯一优势**：不改 core/shared 契约、改动局限在新包；如果 M7 明确只做“单用户、短回复、无重启保证”，B 可快速跑通。但 QQ 的核心价值是稳定 IM，B 的失败模式（静默丢回复/错挂消息）恰好最难排查。

#### 3.1.4 `msg_seq` 的具体取法（A 方案下的两档）

- **推荐：persist 化的 per-reply 序号（`replySeq`）**。事实表 §13#18 提示官方 SDK 生成的 `msg_seq` 在 0..65535 范围内，outbox 全局 `seq` 会无限增长，**不能直接当 msg_seq**。因此 core 在 enqueue 时给同一 `(channelId, chatId, replyTo)` 的条目从 1 编号（同批次 chunk = 1..N；该 reply 上下文已有条目时取 max+1），写入 outbox 条目并随重试/重启保持不变。同一 `msg_id` 下最多 4/5 条，序号天然落在安全范围内。
- **为什么不放 driver**：driver 若自己计数，重启/重试后无法知道已发过几条（outbox 的 pending/sent 状态才是事实源）；core 在 enqueue 时能看到该 reply 上下文的全部条目。
- **幂等性**：稳定 `(msg_id, msg_seq)` 使重试安全（平台返回 `40054005` 即视为已发送，见 §3.4.3）；即使 at-least-once 窗口重发，也不会产生第二条相同 seq 的消息。

#### 3.1.5 结论

**推荐 A2**（reply context + `replySeq` + deliveryId/attempt + NonRetryableDeliveryError + canDeliver + maxRepliesPerReply）。理由：单一事实源、重启可解释、与现有 outbox at-least-once 语义一致、可对 local-test 做回归；改动面虽跨 3 个包，但每处都很小。B 只作为“如果评审要求 M7 零 core 改动”的降级方案，并需明确接受“重启丢被动上下文 + 可能错挂消息 + msg_seq 计数不可靠”。

### 3.2 白名单与最小过滤（用户决策：只靠平台限制）

#### 3.2.1 现状与必须改的点

- 全局静态 allowlist 会丢弃所有 QQ 入站（§1.4）。**必须改**：`ChannelCoreConfig` 增加 `trustedChannels: string[]`（默认 `[]`，schemastery 默认 `[]` 以兼容现有 overlay？注意 Cordis patch 是**行替换**，Nix overlay 的 channel-core 行必须写全字段，见 §4.3）；`process()` 里：

```ts
const trusted = this.config.trustedChannels.includes(message.channelId);
if (!trusted && (!allows(allowedSenders, senderId) || !allows(allowedChats, chatId))) {
    this.logger.warn("dropped inbound outside allowlist", {
        channel, chatId, senderId, messageId, reason: "not-allowed",
    });
    return { accepted: false, duplicate: false, reason: "not-allowed" };
}
```

- 比全局 `"*"` 更好的理由：local-test 仍保留 `local-user/local` 精确校验（token 之外的第二道），QQ 仅对 driver id 放行；未来若给 QQ 加白名单，可在 driver 配置层扩展，不影响 core 语义。
- `trustedChannels` 必须在启动日志里显式打印（warn 级别）：`trusted channel enabled: qq-bot (platform limits only)`。

#### 3.2.2 driver 的最小过滤（不是配对/白名单）

| 过滤 | 行为 | 必要性 |
|---|---|---|
| Intents 只订阅 `1<<25`，并只处理 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE` | 其余 `t` 忽略（debug 日志）；**显式忽略 `GROUP_MESSAGE_CREATE`**（群全量，事实表 §5.4：群主授权后平台可推送，与用户决策冲突，绝不能处理） | 必须 |
| 忽略无文本/纯附件消息 | core 的 `empty` 分支会返回 `empty`；driver 可直接跳过并记 debug（避免产生无意义入站与去重记录） | 必须 |
| 忽略附件（图片/语音/文件） | 不设置 `images`；记 `attachments` 数量与 `messageId`；文本仍处理 | 必须（否则 core 整条 `unsupported-images`） |
| 忽略机器人自身消息 | 平台通常不向 bot 投递 bot 消息；防御性检查 `author` 是否等于 READY 中的 bot id（群事件无 bot 标志，需实测） | 建议 |
| 忽略 lifecycle/审批事件 | `GROUP_ADD_ROBOT`/`GROUP_DEL_ROBOT`/`FRIEND_ADD`/`INTERACTION_CREATE` 等只 debug 记录；M7 不做按钮审批（事实表 §6.5 是后置候选） | 必须 |
| 前导 @ 清洗 | 去 `<@!botid>`/前导空白；不删正文中的 `/` | 必须 |
| 不实现 sender/chat 白名单 | 按 D152 决策；预留配置入口但不启用 | 记录 |
| 发送端限速 | outbox 串行 + 429 退避；无需自建桶（若实测平台 QPS 很低再加） | 建议 |

日志字段（core 丢弃 + driver 过滤都要可观测）：`channel`、`chatId`（命名空间 openid，伪匿名）、`senderId`、`messageId`、`reason`（`not-@`/`attachment-only`/`empty`/`not-allowed`/`bot-self`）、`event`。**不记录** `content`。

#### 3.2.3 残余风险（必须写进 `.spec/15`）

1. **远程驱动全权限 agent**：平台限制只保证“能私聊开发体验用户/能在自己群里 @ 机器人的人”可触达；一旦触达，agent 有 `bash`/`local`/`sandbox`、Auto review 是唯一闸。若 `sudo.enable=true`，等价于远程 root 命令执行入口。用户决策已接受，但部署建议默认 `sudo.enable=false`、只放自己的群、只配开发体验用户。
2. **群内其他成员**：群内任意成员 @ 机器人都会触发 agent，回复对整个群可见；可能被诱导执行危险操作/泄露 memory/会话内容（memory 全局）。
3. **成本滥用**：无 per-user 配额，群友可无限 @ 触发模型调用/工具调用；建议至少观察日志与 token 成本，后续版本再考虑限速（不违背 D152 的“不做配对”也可做频率限制）。
4. **prompt injection**：群消息/附件文件名/URL 内容都是不可信输入；Auto review 仍是唯一边界（与本地通道一致，但暴露面从本机变成 QQ 网络）。
5. **平台封禁/合规**：AI 输出不可完全可控，违规可能导致 bot/账号封禁；不要把 bot 用于公开群/公开服务。
6. **openid 不是安全身份**：不同 AppID 不同、member_openid 按群不同；日志可记但不要当作用户身份做授权。

#### 3.2.4 最小防护建议（不违反“只靠平台限制”）

- 部署：`sudo.enable=false`；QQ bot 只加入自己的可信群；C2C 只开放给“开发体验用户”（平台控制台配置本身就是一层白名单）。
- 运行：保留 `channel.localTest=true` 的验收通道以便在 QQ 发不出去时人工注入消息（token 必须保密；若不需要则关闭）。
- 观测：把 `not-allowed`/driver 过滤日志保留在 journald；`/status full` 的 recentErrors 会在发送失败时出现。
- 预留（后续版本）：driver 级 `allowedUsers/allowedGroups`（openid 列表）可作为配置预留但**本里程碑不实现**；实现时也要说明 openid 的群/单聊作用域。

### 3.3 多 driver 语义（lastActiveChat / defaultChannelId / 通知与审批路由）

#### 3.3.1 现状行为表

| 场景 | 当前行为（含行号） | 问题 |
|---|---|---|
| 仅 local-test | `lastActiveChat` 由 local 消息设置；回复/通知/审批都去 local；正常 | 无 |
| 仅 QQ | 首条 QQ 消息前 `lastActiveChat=null`；`defaultChannelId()="qq-bot"`（QQ 是第一个 driver），但 `defaultChatId="local"` → 启动通知/重启通知会入 outbox 发往 `qq-bot` 的 chat `"local"`（非法 openid） | 发送失败/重试耗尽；重启通知丢失 |
| local-test + QQ | 两条渠道共享一个 `lastActiveChat`；回复/turn end 可能发到最近说话的渠道；审批提示也可能跨渠道 | 串渠道；用户可能在 QQ 提问却收到 local-test；审批回复可能落到另一渠道 |
| 重启后 | state 文件保存了 `lastActiveChat`，但 recover 不写回 service；启动通知走默认渠道+默认 chat | 通知错投/丢失；pending outbox 的 `chatId` 仍正确（outbox 自含） |
| driver 缺失 | pump 每 `outboxBaseDelayMs` 重排，pending 永不耗尽 | 定时器泄漏、日志噪声、`outboxLength` 永不为 0 |

#### 3.3.2 推荐方案

1. **per-turn 来源路由（必须）**：`turnChat` 记录“开启当前轮的入站 chat”（首次 `followup` 时设置；`steer` 不覆盖）。`sendReply()` 与 broker `sendPrompt()` 用 `turnChat ?? lastActiveChat ?? default`；没有用户入站触发的轮（goal report/schedule）沿用最近 turn/lastActiveChat。这样 QQ 提问的回复/审批不会因为 local-test 同期活动而串到 local-test。
2. **notice 的 deliverability 路由（必须）**：`notify()` 按顺序选目标：
   - 首选 `turnChat ?? lastActiveChat` 的 driver，若其 `capabilities.activeMessages !== false` **或**该 chat 有未超窗的 reply 上下文（问 driver `canDeliver("notice", reply)`）→ enqueue；
   - 否则选第一个 `capabilities.activeMessages !== false` 的 driver（local-test 若注册在前，会优先），用它的 `defaultChatId`；若它没有有效 chat（QQ 单聊未建立会话）→ 跳过；
   - 都没有 → `logger.warn("no active-capable channel for notice", { length, previewKind: kind })` 并**丢弃**（不要入 outbox 造成“永远 pending/反复失败”）。
   - 这会让 QQ-only 部署下的重启/待应答失效/提醒通知只能进 journald，属平台限制下的可接受降级，但必须写进文档与 `/status` 观测。
3. **交互 fail-closed（必须）**：broker `sendPrompt` 前调用目标 driver 的 `canDeliver(chatId,{kind:"interaction", reply})`；false 则抛出 → broker 在 `showNext()` 的 catch 里按 approval=`unavailable`、question=`NO_PROVIDER` 结算（`broker.ts:295-311` 已有该失败路径）；用户侧没有提示，但工具调用立即失败而不是等 60s/300s 超时。
4. **默认渠道（建议）**：`ChannelCoreConfig` 增加可选 `defaultChannelId`（缺省保持“第一个 driver”）；Nix overlay 显式设置（推荐 `"local-test"` 若启用，否则 `"qq-bot"`？QQ 没有有效默认 chat，建议 rollout 时保持 local-test 为默认通知渠道；QQ-only 时靠 notice 丢弃逻辑）。**不**把 `"local"` 发往 QQ。
5. **缺失 driver 短路（必须）**：pump 中 `driver===undefined` 时不再无限重排；区分：
   - outbox 条目 `channelId` 从没注册过（配置错误/被禁用）→ `markAttemptFailed(seq, null, true)` + log error（终态 failed，历史保留）；
   - 若只是“暂时未注册”（启动期 driver 尚未 ready）→ 当前 pump 只在 attachRuntime 后启动，实际不会遇到；按未知处理即可。
6. **恢复 lastActiveChat（建议）**：daemon 在 `attachRuntime` 前把 state 中的 `lastActiveChat` 通过新 `channels.restoreActiveChat()` 写回 **仅当**该 channel 的 driver 存在且能力允许 active；否则忽略（QQ active 不可用）。这主要修复 local-test 的重启通知投递。
7. **注册顺序（必须明确）**：bundle 行顺序保持 local-test 在 QQ 之前 → 同时启用时 `defaultChannelId="local-test"`，通知优先走验收通道；文档写明。若产品希望 QQ 为默认，必须显式配置 `defaultChannelId`，不能靠行序。
8. **M7 是否允许同时启用**：如果 §3.3.2 的 1–5 都实现，建议允许 + module warning；如果实现期决定延期，则 NixOS module 必须 assertion 二选一（避免静默串渠道），并在文档记录为临时限制。

#### 3.3.3 改动点

- `service.ts`：`notify/enqueueText/sendReply/process/pumpOnce/defaultChannelId`（上述行号）；新增字段与路由 helper。
- `daemon.ts`：`attachRuntime` 传入/恢复 activeChat（可选）；turn end 不需要改（若 core 自己维护 turnChat）。若把 turn 来源放在 daemon，需要 `onChatActive`/turn 事件扩展——不推荐，保持 core 内聚。
- `contract.ts`：`canDeliver`、`activeMessages`。
- `bundle/cordis.patch.yml`：channel-core 行加 `trustedChannels`/`defaultChannelId`；channel-local-test 不动；新增 QQ 行（顺序很重要）。
- `nix/overlay.nix`：channel-core patch 写全字段（含 trustedChannels/defaultChannelId）；新增 QQ row。
- 测试：集成测试用两个 fake driver + fake 入站验证“QQ 提问 → QQ 回复”“local-test 通知 → local-test”，以及无 active 渠道的 notice 丢弃日志。

### 3.4 发送失败语义与 QQ 错误分类

#### 3.4.1 现状

- `pumpOnce` 对任何 `driver.send()` 异常都按同一策略重试：`attempts+1`、指数退避（1s 起，最大 60s）、达到 `outboxMaxAttempts`（默认 8）置 `failed` 并**只 log error**（`service.ts:796-823`）。
- 没有“永久错误”概念：400 校验错误也会重试 8 次；被动窗口过期也会重试，浪费 ~2 分钟并占用 pump 周期。
- `.spec/06` 6.10/`6.7` 声称“outbox 发送失败超上限…发系统通知”，但当前代码**没有** notify 调用（pump catch 只有 logger）——这是既有实现与规格的偏差，M7 建议一并收口（或在文档明确接受“只 log”）。
- outbox at-least-once（D132）：已发送但未及 markSent 的条目会重发。QQ 被动回复可用 `(msg_id, msg_seq)` 做平台侧去重，因此**稳定 `replySeq`** 能把重试变成安全操作（见 3.4.3）。

#### 3.4.2 分类表（driver 责任）

| 类别 | 事实表错误码/HTTP（§8.2） | driver 行为 | core 结果 |
|---|---|---|---|
| 可重试-网络 | 连接超时/TLS/DNS/`fetch` AbortError/HTTP 5xx；`50055001`/`50055002`（发送异常） | throw 可重试错误 | 现有退避重试 |
| 可重试-限频 | HTTP 429；`100001`（Too many requests）；`40034100`（主动消息频控）；`50002`（流式频率） | throw 可重试，记录 retryAfter（若有）；每次尝试前检查被动窗口 | 退避；接近窗口则 driver 下次转非重试/回退 |
| 鉴权 | HTTP 401；`11241`/`11243`（旧公共 token 码）；token 业务码 `100007`/`100016`/`10004`（凭据/机器人无效） | 先刷新 token 一次并重试；凭据类业务码 → `NonRetryableDeliveryError("auth-invalid")` 并 fail loud（启动期直接失败） | 退避重试 / 立即 failed |
| 被动失效（→主动回退） | `40034005`（msg_id 过期）、`304103`（消息 ID 过期）、`40034128`（被动时间/次数超限）、`40034026`（event_id 过期） | 若 `activeMessageFallback="auto"` → 尝试一次主动消息；否则/主动失败 → `NonRetryableDeliveryError("passive-expired")` | 立即 failed（不重试） |
| 主动不可用/拒收 | `40034105`（主动消息无权限）、`40054013`（用户拒收）、`40034101`/`40054003`（非群成员）、`40054016`（机器人下线） | `NonRetryableDeliveryError(reason)`；内存标记 active 不可用（TTL 如 1h），避免刷日志；非群成员/下线属配置错误，fail loud 提示 | 立即 failed；日志 error + recent ring |
| 去重/幂等 | `40054005`（消息被去重，同 msg_id+msg_seq 已发送过） | **视为已发送成功**，返回合成 `SentRef`；记 warn（含 deliveryId） | `markSent`；避免重试风暴 |
| 长度 | `40054007`（消息长度超限）、`40054018`（单聊消息过长/异常） | 按能力位重新分段/截断后重发一次；仍失败则非重试 | 首次重试一次（可定点处理） |
| URL/内容永久 | `40054010`（不允许 URL，群）、`40034006`（内容违规）、`304061`（内容无效）、`40034008`~`40034011`（markdown 参数）、`40034024`/`40034025`/`40034027`（msg_id/event_id 无效）、`40054004`（无好友） | `NonRetryableDeliveryError(reason)`；日志 errCode | 立即 failed |
| 未知 | 未归类 4xx/5xx | 4xx 默认非重试；5xx/网络默认重试；均记日志 | 与 driver 一致 |

#### 3.4.3 “哪些抛出、哪些吞掉”

- **抛出**：所有无法确认送达且值得重试的错误（网络/限频/5xx/鉴权刷新后仍失败）；所有永久错误（用 `NonRetryableDeliveryError` 包装，core 立即失败）。
- **吞掉（返回成功）**：仅 `40054005`（同 `(msg_id,msg_seq)` 已发送过）。该码说明平台已记录这次回复，稳定 `replySeq` 的 at-least-once 重试由此收敛为 at-most-once；**必须先实测确认**（若实测发现“未送达也会 40054005”，则改为递增 seq 重发并接受重复）。事实表 §9.3 的“需递增 msg_seq”针对**正常的多次回复**，不适用于同一条目的重试。
- **降级**：markdown 语法不支持（代码块/表格）→ 用能力位 `basic`/`none` 切换；`40054010` 不允许 URL → 非重试，后续可加 `stripUrls` 配置或提示词约束。
- **主动回退失败告知路径**：用户侧不可达（QQ 无法主动发消息）。可观测链：driver `logger.error("qq send failed", {errCode, reason, deliveryId, chatKind, attempts})` → shared `recordRecentLog`（warn/error 自动）→ `/status full` 的 `recentErrors`（`daemon.ts:648-815` 引用 `recentLogs(10)`）→ journald。若同时启用 local-test，可在 outbox 失败耗尽时向 active-capable 渠道发一条 ⚠️ 摘要（**建议**，注意避免递归失败）。在 QQ-only 部署下，唯一告知用户的方式是“用户主动发消息时模型/日志可见”，需在 README/规格中写明该限制。C2C 的 `is_wakeup` 召回（事实表 §6.3）可作为未来提醒降级通道，但受限 30 天/4 周期，且不属于被动回复语义。
- 建议 core 在耗尽时补一次 `notify`（best-effort，带计数），对齐 `.spec/06` 6.7/6.10 的描述；但仅当存在 active-capable 渠道时。

#### 3.4.4 重试参数与窗口

默认 8 次退避约 1+2+4+8+16+32+60+60 ≈ 183 秒 < 群 5 分钟窗口，尚可；但若首条发送在 turn 结束后数十秒才发生，仍可能压线。driver 必须在每次尝试前检查窗口（基于持久 `replyReceivedAt` 与 `replySeq`），超窗直接非重试，避免无意义重试。单聊官方窗口 60 分钟但事实表建议保守 TTL（DSH 插件用 30 分钟），可配置。`outboxMaxAttempts`/退避 base/max 已是 core 配置（`service.ts:185-187`），QQ 部署可保持默认。

### 3.5 Gateway 在线要求/重连对启动、关闭与看门狗的影响

#### 3.5.1 平台事实（官方文档）

- 获取网关：`GET /gateway`（或 `/gateway/bot` 带分片信息）；事实表 §4：文档返回 `wss://api.bot.qq.com/websocket/`，历史/SDK 为 `wss://api.sgroup.qq.com/websocket/`，沙箱示例 `sandbox.api.sgroup.qq.com` → **地址必须动态获取或可配置，不硬编码单个域名**。
- 连接后收 `Op 10 Hello {heartbeat_interval}` → 发 `Op 2 Identify {token: "QQBot {AccessToken}", intents: 1<<25, shard:[0,1], properties}` → 收 `READY {session_id, user}`；心跳 `Op 1 {d: 最新 s}`，`Op 11 ACK`；断线后 `Op 6 Resume {token, session_id, seq}` 补发；`Op 7 Reconnect`、`Op 9 Invalid Session`；`/gateway/bot` 返回 `session_start_limit`（24h total 1000、`max_concurrency=1`/5s）。
- WS 关闭码（事实表 §8.4）：`4006`（session id 无效→Identify）、`4007`（seq 错→Identify）、`4008`（发送过快→可 resume）、`4009`（连接过期→resume）、`4013/4014`（intent 无效/无权限，通常配置问题，不要无脑重连）、`4914/4915`（下架/封禁，停止重连）；`4004` 仅官方 SDK 有 AUTH_FAILED 命名（防御性处理）。
- 官方 SDK 重连退避参考 `[1,2,5,10,30,60]s`、QUICK_DISCONNECT 5s/最多 3 次（事实表 §4.4，二手佐证），driver 按其精神实现并全部配置化。
- 官方仅在“文字子频道”段落要求发送时保持 WebSocket 在线；**C2C/群 v2 未写** → **【待实测】**，旧公共码 `304018`（机器人没连上 gateway）可作参考（事实表 §8.3，v2 是否复用待核实）。
- GitHub 旧文档副本在 WebSocket 段写“逐步下线、迁移 webhook”，但 live 事实表 §4 未复现、群/单聊事件仍写 WebSocket，17.3 也称 WS 为推荐方式 **【冲突，降级为“旧公告/副本可能过期”】**（见 2.6#2）。

#### 3.5.2 启动策略

- `driver.start()` **不得阻塞 daemon ready**：发起连接、等待首个 Hello/READY 至多 `connectTimeoutMs`（默认 10–30s），超时后记录 warn 并继续后台重连；`registerDriver()` 已 await `start()`（`service.ts:341-355`），因此不能让 start 无限等待网络。理由：daemon 还有 local-test/其他渠道与恢复工作；启动被网络拖死会触发 systemd `StartLimitBurst`/`TimeoutStartSec` 重启循环（`.spec/12` 12.6）。
- 启动期入站缓冲（`service.ts:444-452`）可安全接纳 QQ 事件；但**QQ 网关未连上时不会有事件**，用户看到的是“没反应”，只能靠日志/status 观测。建议在 status 增加 channel health（见 3.5.4）。
- 不建议“连接失败即启动失败”：网络抖动时 systemd 重启无益；除非验收明确要求 QQ-only 且 gateway 必须在线。规格应记录该选择。

#### 3.5.3 关闭策略

- 现有顺序（`daemon.ts:253-306`、`service.ts:836-853`、`.spec/05` 5.4）：`channels.pause()` 停止接受入站 → abort interactions → 等 turn grace → flush → Cordis dispose（并发）→ channel-core dispose 里 `Promise.allSettled(driver.stop())` → outbox/seen flush。
- QQ `stop()` 必须：置 stopped → clear heartbeat/reconnect/connect timers → `ws.close(1000)` 并 **最多等待 2–5s**（若 close 事件不来就放弃；不要悬挂）→ 拒绝后续 send（返回可重试错误，让条目留在 outbox）→ 幂等（可重复调用）。
- 在发送中收到 SIGTERM：REST 请求可能已到达平台但响应未回；条目保持 pending → 下次启动重试；若平台已接受，被动重复会被去重错误拦截（§3.4.3），可安全收敛。这个 at-least-once 窗口与现有设计一致。
- 关闭时不要尝试 `NOTIFY_SOCKET` 之外的网络清理（会拖慢 shutdown）；`KillMode=mixed`/`TimeoutStopSec=45` 已有余量。

#### 3.5.4 ready / status / 看门狗

- `run/ready.json` 与 systemd `READY=1` 的语义保持不变：daemon 恢复完成即 ready，**不要求** QQ 网关在线（否则网络抖动会拖垮启动）。需要在文档明确“ready ≠ QQ 在线”。
- 建议 `ChannelDriver` 增加可选 `health?(): {state:"online"|"connecting"|"offline"; detail?:string}`；`ChannelService.status()` 增加可选 `channels` 字段（`service.ts:530-550`，`DaemonStatus` 类型在 `service.ts:40-52` 同步），local-test 的 `/v1/status` 自动透出（`channel.ts:238-248`）。这是**建议改**：没有它，运维只能 grep journald。
- 看门狗心跳由 `SystemdNotifier` 的定时器 + `systemd-notify` 子进程完成（`shared/src/systemd.ts`），与 WS 无关；只要重连退避是定时器而非忙循环，watchdog 不受影响。禁止在 close/error 回调里同步重连（会阻塞事件循环并影响心跳/其他插件）。

#### 3.5.5 Webhook 备选（仅记录，M7 不做）

事实表 §4 已核实平台支持 webhook（回调端口 80/443/8080/8443、Ed25519 签名校验，官方 Node SDK 双传输）。它与当前部署姿态冲突：NixOS unit 不硬化/不开入站端口（`.spec/12` 12.6 明确测试通道只绑 loopback、不做反向代理），需要新增暴露面与 TLS 终止方案。**建议 D150 把 transport 抽象成 driver 内部接口**（`gateway.ts` vs 未来 `webhook.ts`），M7 只实现 WS；若 WS 不可用再评估 webhook（需要公网入口）。

### 3.6 图片与 V8 预留

- core 对 `images` 的处理：`ingress()` 在 allowlist/缓冲**之前**就返回 `unsupported-images`（`service.ts:436-443`），即带图片的入站整条不进入模型；测试通道的 `/v1/inbound` 对 images 返回 501（`channel.ts:272-292`）。因此 QQ driver **必须**忽略 `attachments`，不要把附件放进 `InboundMessage.images`，否则“文字+图片”消息会被整条拒绝。
- `inboundImages=false` 与 `outboundFiles=false` 的能力位本身不改；V8 预留点：
  1. 入站：事件 `attachments[]` 有 `content_type/filename/size/url`（事实表 §5.7）；URL 自带 `rkey`，官方文档未要求额外鉴权头，官方 DSH 插件用裸 HTTPS GET 下载，有效期未公开 **【待实测】**。V8 需做 SSRF 防护、大小/mime 校验、超时；core 还要新增图片注入路径（当前没有任何图片进入 agent 的路径，是 V8 的核心工作，不只是 driver）。
  2. 出站：`msg_type=7` + 先调富媒体上传接口（群 `/v2/groups/{group_openid}/files`、单聊 `/v2/users/{openid}/files`，两场景文件不互通）拿 `file_info`；`srv_send_msg=true` 占用主动消息配额，`msg_type=7` 时 `content` 需占位空格；被动富媒体是否支持需实测（事实表 §7.3）。
  3. Markdown 图片：自定义 Markdown 已对单聊/群聊开放（事实表 §7.2），图片可用公网 URL 或素材管理 `qqbot-media://`（≤10MB、100 张/机器人、90 天滑动过期，事实表 §7.4）；平台会代理下载/缓存，URL 不持久；V8 再评估。
- 本里程碑结论：**不做图片，只保证忽略策略正确且日志留痕**（记录 `attachmentsCount`，不记录 URL/内容）。

---

## 4. 配置设计（任务 3）

### 4.1 NixOS module 新增 `channel.qqBot.*`

与 `nix/module.nix:308-329`（`channel.localTest`）风格一致（`mkOption` + `types` + enable + assertion/warning）。建议选项：

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `channel.qqBot.enable` | `bool` | `false` | 是否注册 QQ driver。 |
| `channel.qqBot.appId` | `str` | `""` | 非秘密，写入 overlay（Nix store 可读）；enable 时必须非空。 |
| `channel.qqBot.clientSecretEnv` | `str` | `"NOKORIBI_QQ_BOT_CLIENT_SECRET"` | **只写环境变量名**；真实 secret 由 `environmentFile`/agenix 注入；driver 运行期读取，不写入 overlay/store。 |
| `channel.qqBot.sandbox` | `bool` | `false` | 使用 QQ 沙箱环境网关/API（事实表 §4：沙箱示例 `sandbox.api.sgroup.qq.com`；旧版管理端已不支持添加沙箱群，管理员账号可免沙箱测试——该选项主要留给联调/未来能力）。 |
| `channel.qqBot.markdown` | `enum ["none" "basic" "full"]` | `"basic"` | 单聊/群聊自定义 Markdown 已开放（事实表 §7.2）；QQ 文档未列代码块/表格 → 实测后再决定是否降到 `none`。 |
| `channel.qqBot.maxTextLength` | `ints.positive` | `4500` | core 分段上限（平台约 5000；官方插件默认 4500）；【待实测】`40054007/40054018` 校准。 |
| `channel.qqBot.maxRepliesPerMessage` | `ints.positive` | `4` | 单条被动上下文最多回复条数（单聊 4/群聊 5，取保守 4）；core 预截断。 |
| `channel.qqBot.groupReplyWindowSeconds` | `ints.positive` | `300` | 群被动窗口（平台 5 分钟）；driver 留少量安全余量。 |
| `channel.qqBot.c2cReplyWindowSeconds` | `ints.positive` | `3600` | 单聊被动窗口（平台 60 分钟；事实表建议实现可更保守，如 1800）。 |
| `channel.qqBot.requestTimeoutSeconds` | `ints.positive` | `10` | REST 超时（官方建议 ≥5s）。 |
| `channel.qqBot.connectTimeoutSeconds` | `ints.positive` | `30` | 首次 Hello/READY 等待；超时后台重连。 |
| `channel.qqBot.activeMessageFallback` | `enum ["auto" "off"]` | `"auto"` | 被动不可用时是否尝试主动消息；`auto` = 尝试一次，按平台错误码（40034105/40054013 等）内存禁用（TTL 1h）并记 error。官方公告与事实表对“主动是否可用”矛盾，默认 auto 便于实测/平台恢复后生效。 |
| `channel.qqBot.reconnectBaseMs` / `reconnectMaxMs` | `ints.positive` | `1000` / `60000` | 重连退避。 |
| `channel.qqBot.platformLimitsOnly` | `bool` | `true` | 对应 D152：true 时 module 给 channel-core 设置 `trustedChannels=["qq-bot"]`，不暴露 driver 白名单；false 时要求 `allowedUsers/allowedGroups`（**后置**，本里程碑不实现，写 assertion 提示）。 |

**不要**把 `clientSecret` 本身做成 option（避免进入 store）；token 只内存。`appId` 可入 store（用户已确认）。

### 4.2 module assertions / warnings（对齐 `module.nix:400-470` 风格）

新增 assertion（全部 `!cfg.enable || ...` 前缀，保持“服务未启用时宽松”）：

1. `!enable || !channel.qqBot.enable || channel.qqBot.appId != ""` → “channel.qqBot.appId is required.”
2. `!enable || !channel.qqBot.enable || channel.qqBot.clientSecretEnv != ""` → “channel.qqBot.clientSecretEnv must name the EnvironmentFile variable.”
3. `!enable || !channel.qqBot.enable || cfg.environmentFile != null`（现有全局断言已保证 enable 需 environmentFile，可不再重复；显式加一条更清晰）。
4. `!enable || !channel.qqBot.enable || channel.localTest.enable || cfg.channel.default != "local-test"`（若引入显式默认渠道选项；否则用 warning）。
5. 若本里程碑选择“两渠道互斥”（推迟 §3.3 路由修复）：`!enable || !(channel.qqBot.enable && channel.localTest.enable)` → 明确提示“需先实现 per-turn 路由或只启用一个”。
6. `platformLimitsOnly=true` 时无需断言（由 module 生成 trustedChannels）；若 false，断言 `allowedUsers/allowedGroups` 非空（后置实现时不加，避免假选项）。

warnings（对齐 `module.nix:465-470` 的 `lib.optional`）：

- “channel.qqBot is enabled: any QQ user who can message the bot can drive the agent; Auto review is the only boundary.”（D152 残余风险）
- “QQ active push availability is disputed (official send page banner says removed 2025-04-21; API tables still list quotas; community sees 40034102/40034105). Proactive notices/reminders may fail or be undeliverable.”（`activeMessageFallback="auto"` 时提示）
- “QQ custom Markdown is open for C2C/group since 2026-04-23, but code blocks/GFM tables are undocumented; channel.qqBot.markdown defaults to basic.”
- “channel.localTest and channel.qqBot are both enabled; ensure per-turn routing is implemented.”
- “No active-capable non-QQ channel: proactive notices will be logged and dropped.”（QQ-only 且 localTest 关闭）
- “The client secret must be provided by environmentFile/agenix; it is never written to the Nix store.”

### 4.3 overlay（`nix/overlay.nix`）

- 新增 `channelQqBot` 配置对象（风格同 `channelLocalTest`，`overlay.nix:68-79`），全部字段写全（Cordis patch 是**行替换**，不能依赖 bundle 默认值合并）：`enabled/appId/clientSecretEnv/sandbox/markdown/maxTextLength/...`；**不含 secret 值**。
- 新增 patch row：

```yaml
- id: nokoribi-channel-qq-bot
  config:
    enabled: true
    appId: "123456"
    clientSecretEnv: "NOKORIBI_QQ_BOT_CLIENT_SECRET"
    sandbox: false
    markdown: basic
    maxTextLength: 4500
    maxRepliesPerMessage: 4
    groupReplyWindowSeconds: 300
    c2cReplyWindowSeconds: 3600
    requestTimeoutSeconds: 10
    connectTimeoutSeconds: 30
    activeMessageFallback: auto
    reconnectBaseMs: 1000
    reconnectMaxMs: 60000
```

- `nokoribi-channel-core` patch（`overlay.nix:94-103`）补 `trustedChannels = ["qq-bot"]`（当 qqBot 启用且 platformLimitsOnly）与可选 `defaultChannelId`；现有 `allowedSenders/allowedChats/defaultChatId` 保持 local-test 语义。
- `nokoribi-channel-local-test` patch 不变（仍由 `channel.localTest.enable` 控制）。
- 行顺序：`nokoribi-channel-core` → `nokoribi-channel-local-test` → `nokoribi-channel-qq-bot` → `nokoribi-agent-app`；**不要**把 QQ 行插到 local-test 之前（默认渠道会变，通知走 QQ 的非法 chat）。

### 4.4 `packages/bundle/cordis.patch.yml` 新行与 env 映射

在 `nokoribi-channel-local-test` 行（`bundle/cordis.patch.yml:294-302`）之后、`nokoribi-agent-app` 之前插入：

```yaml
      - id: nokoribi-channel-qq-bot
        name: "@nokoribi/channel-qq-bot"
        config:
            enabled: !!js (process.env.NOKORIBI_QQ_BOT_ENABLED ?? 'false') === 'true'
            appId: !!js process.env.NOKORIBI_QQ_BOT_APP_ID ?? ''
            clientSecretEnv: NOKORIBI_QQ_BOT_CLIENT_SECRET
            sandbox: !!js (process.env.NOKORIBI_QQ_BOT_SANDBOX ?? 'false') === 'true'
            markdown: !!js process.env.NOKORIBI_QQ_BOT_MARKDOWN ?? 'basic'
            maxTextLength: !!js Number(process.env.NOKORIBI_QQ_BOT_MAX_TEXT_LENGTH ?? 4500)
            maxRepliesPerMessage: !!js Number(process.env.NOKORIBI_QQ_BOT_MAX_REPLIES ?? 4)
            groupReplyWindowSeconds: 300
            c2cReplyWindowSeconds: 3600
            requestTimeoutSeconds: 10
            connectTimeoutSeconds: 30
            activeMessageFallback: !!js process.env.NOKORIBI_QQ_BOT_ACTIVE_FALLBACK ?? 'auto'
            reconnectBaseMs: 1000
            reconnectMaxMs: 60000
            # 测试/本地调试用（Nix overlay 不生成）：
            # 域名两套来源（文档 api.bot.qq.com / SDK api.sgroup.qq.com、bots.qq.com），
            # 见事实表 §2/§14；默认取文档域名，测试/联调可覆盖。
            apiBaseUrl: !!js process.env.NOKORIBI_QQ_BOT_API_BASE ?? 'https://api.bot.qq.com'
            gatewayUrl: !!js process.env.NOKORIBI_QQ_BOT_GATEWAY_URL ?? 'wss://api.bot.qq.com/websocket/'
            tokenUrl: !!js process.env.NOKORIBI_QQ_BOT_TOKEN_URL ?? 'https://api.bot.qq.com/app/getAppAccessToken'
```

- bundle 行的 `enabled` 默认 false，避免本地无配置时启动失败；Nix overlay 会把 `enabled` 覆盖为 `true`。
- `apiBaseUrl/gatewayUrl/tokenUrl` 只用于测试替身与沙箱联调；**Nix option 不暴露**（避免误配），测试用 `.env`/进程环境覆盖即可。
- `packages/bundle/package.json` 依赖列表（`:71-73` 一带有 workspace 依赖）加入 `"@nokoribi/channel-qq-bot": "workspace:*"`。

### 4.5 `.env.example` / README / launcher

- `.env.example`（当前 1-72 行）新增段落：

```
# QQ official bot (M7). Enable only after reviewing platform constraints:
# no driver-level allowlist is implemented; platform limits are the boundary.
# NOKORIBI_QQ_BOT_ENABLED=false
# NOKORIBI_QQ_BOT_APP_ID=
# Only via EnvironmentFile/agenix in production; never commit this value.
# NOKORIBI_QQ_BOT_CLIENT_SECRET=
# NOKORIBI_QQ_BOT_SANDBOX=false
# NOKORIBI_QQ_BOT_MARKDOWN=basic
# NOKORIBI_QQ_BOT_MAX_TEXT_LENGTH=4500
# NOKORIBI_QQ_BOT_ACTIVE_FALLBACK=auto
# Test-only overrides:
# NOKORIBI_QQ_BOT_API_BASE=
# NOKORIBI_QQ_BOT_GATEWAY_URL=
# NOKORIBI_QQ_BOT_TOKEN_URL=
```

- `packages/launcher/src/index.ts:52-100` 的 helpText 硬编码环境变量说明，新增 QQ 变量行（**建议**，便于 `--help` 发现；非功能）。
- `README.md` 状态/渠道段落（`:5`、`:11`、`:125`、`:158`）在实现后更新，本轮仅记录。

### 4.6 密钥与日志

- AppID：非秘密，可进 Nix store/overlay（用户确认）。
- ClientSecret：只来自 `EnvironmentFile`（NixOS module 已有 `environmentFile` 必填断言与 systemd `EnvironmentFile=`，`module.nix:401-405, 527`）；overlay/bundle 中只出现**变量名**；不写 `.env` 提交、不写 state、不上日志。
- access_token：内存缓存（约 7200s，提前 60s 刷新）；不落盘；不打印；错误日志只记 `errCode/traceId`。
- 日志脱敏：`Logger` 会把这些字段原样输出（`shared/src/log.ts:58-107`），因此调用点必须自己保证不含 secret/content。
- 若 `clientSecretEnv` 指向的环境变量缺失/为空：driver 在 `apply()` 或首次取 token 时 **fail loud**（启动失败写 startup-error），不要把“缺 secret”变成运行时静默失败。

### 4.7 module eval 检查（`nix/check-module.py` + `flake.nix`）

- `flake.nix:38-59` 的 `sample` 增加：`channel.qqBot = { enable = true; appId = "123456"; };`（并保持 localTest enable，以覆盖双渠道生成；若最后选择互斥断言则需调整 sample）。
- `nix/check-module.py:51-57` 增加对 `nokoribi-channel-qq-bot` 行的断言：`enabled=true`、`appId`、`clientSecretEnv`、`markdown="basic"`、`maxTextLength=4500`、`maxRepliesPerMessage=4`、窗口字段；对 `nokoribi-channel-core` 行断言 `trustedChannels=["qq-bot"]`（若 module 采用该方案）。
- 断言 service/environment 不含 secret 值；`EnvironmentFile` 仍存在（`:80-104`）。
- `nix/deps.nix:10` 的 `hash` 在新增 workspace 包/锁文件变化后必须更新（见 §6.3）。

---

## 5. 测试计划（任务 4）

### 5.1 单元测试（新包 `packages/channel-qq-bot/test/`）

| 文件/对象 | 用例 |
|---|---|
| `normalize.test.ts` | C2C/群 @ 事件 → InboundMessage 字段；chatId 命名空间；senderId；`timestamp` 解析/非法回退；前导 @ 清洗；空 content；attachments 忽略；未知事件忽略；重复事件交给 core。 |
| `gateway.test.ts` | 用注入的 `FakeWebSocket` + fake clock：Hello→Identify 参数（token 格式/intents/shard）、READY、心跳周期与 `d=last s`、ACK 超时重连、Op7 重连、Op9 清 session 后重新 Identify、Resume 参数与 RESUMED、`stop()` 清理定时器/幂等。 |
| `rest.test.ts` | token 获取/缓存/提前 60s 刷新/单飞；401 刷新一次；发送请求 URL/body（group vs c2c、msg_id/msg_seq、active 无 msg_id）；超时（AbortSignal）；错误码分类；日志不含 secret/content。 |
| `send-policy.test.ts` | 有有效 reply → 被动；超窗/次数用尽 → active fallback（auto/off）；被动过期码 → 回退一次；active 不可用 → 非重试；重复码 → 视为成功（gate 在实测标志后）；`msg_seq=deliveryId` 稳定；`maxReplies` 预截断后不超发。 |
| `config.test.ts` | Config schema 校验；`clientSecretEnv` 缺失 fail loud；enabled=false 不建连接。 |

channel-core 侧新增/调整单元测试：

- `outbox.test.ts`：新增 `replyTo/replyReceivedAt/replySeq` 持久化/旧文件兼容/`enqueue` 默认 null。
- `format.test.ts`：QQ 4500 上限下“前缀不会导致超长”的回归（若采用预留方案）；`basic` Markdown 降级不产生表格/HTML。
- `service.test.ts`（新建，或集成）：`trustedChannels` 跳过 allowlist、非 trusted 仍丢弃并带 `chatId/senderId/reason` 日志字段；`NonRetryableDeliveryError` 立即 failed；缺 driver 条目立即 failed；notice 在无 active 渠道时丢弃并 warn。
- `tests/integration/`：两个 fake driver + 假入站验证 per-turn 路由（QQ 提问 → QQ 回复；local-test 通知 → local-test）；可用 `dsh-agent-loop-testkit` 模式（参考 `tests/integration/m2-child-approval.test.ts:144-282`），或纯 service + stub runtime。

### 5.2 fake WebSocket / REST 替身

- **单元级**：`FakeWebSocket` 实现 driver 依赖的最小接口（`addEventListener/removeEventListener/send/close/readyState` + 测试侧 `emitMessage(string)/emitClose(code)`）；配合 `vi.useFakeTimers()` 驱动 heartbeat/backoff。driver 构造函数注入：

```ts
interface QqDriverOptions {
    readonly now?: () => number;
    readonly webSocketFactory?: (url: string) => WebSocketLike;
    readonly fetchImpl?: typeof fetch;
    readonly sleep?: (ms: number) => Promise<void>;
}
```

- **REST 替身**：注入 `fetchImpl`（单元）或在进程测试里用真实 `http.Server`；不要 mock 全局 `fetch` 之外再引依赖。
- **进程级 fake QQ server**（`tests/process/support/fake-qq-bot.ts`，零依赖）：
  - `http.Server`：`POST /app/getAppAccessToken`（可配置 token/invalid 流程）；`POST /v2/groups/:id/messages` 与 `/v2/users/:id/messages`（记录 body、可脚本化 `err_code`/延迟）；可选 `GET /gateway`。
  - `upgrade` 处理 WebSocket：校验 `Sec-WebSocket-Key`、回 `101` + `Sec-WebSocket-Accept`（`SHA1(key + GUID)` 内联实现）；服务端→客户端帧不掩码、客户端→服务端帧掩码解析；支持 text/close/ping；测试控制方法：
    - `pushEvent(t, d)` / `pushC2C()` / `pushGroupAt()`
    - `sendHello(intervalMs)` / `expectIdentify()` / `sendReady()` / `dropConnection()` / `sendOp9()`
    - `requests: SentRequest[]`、`waitForSend(predicate, timeout)`
  - 失败注入：`failNextRequest(errCode/status)`、`delayNextRequest(ms)`、`expireToken()`。
- **接入方式**：复用 `tests/process/harness.ts:79-124` 的 `startDaemon` + 临时 `DSH_HOME` + `NOKORIBI_TEST_TOKEN/PORT` 模式；新增 `extraEnv` 打开 QQ 并覆盖 `NOKORIBI_QQ_BOT_API_BASE/GATEWAY_URL/TOKEN_URL`（bundle 行读取）。fake LLM 复用 `tests/process/support/scripted-llm.ts` 或 `dsh-llm-mock-server`（`m1.test.ts:23-38`）。
- 进程测试不依赖 Nix overlay；Nix 下 `nix/tests.nix:31-36` 的 `pnpm test` 会跑单元（不含集成/进程），`pnpm test:process` 仍是手工/本地门禁。

### 5.3 进程级场景（建议至少 8 个）

1. 启动 → fake 网关 READY → 推 C2C 事件 → scripted LLM 回复 → 断言 REST 收到 `msg_id`/`msg_seq=...` 的被动请求；daemon `/v1/status` ready 正常。
2. 群 @ 事件 → `chatId=group:<openid>`、`senderId=group-member:<openid>` → 回复走 `/v2/groups/...`；非 @ 不产生 REST（平台不会推，但 fake 可推未知事件验证忽略）。
3. 重复 push 同一事件 id → 只产生一条回复（core 去重跨重启）。
4. 被动窗口过期：fake 事件 timestamp 设为 > 窗口前 → REST 不收到带 msg_id 的请求，而是 active 尝试（`auto`）或直接失败；日志含 `errCode/reason`；outbox 条目变 failed（可通过日志或最终不重试断言）。
5. 平台被动失效码（`40034005`/`40034128`/`304103`）→ active fallback 一次；主动不可用码（`40034105`/`40054013`；社区 `40034102`）→ 非重试、不无限重试（用 fake 计数断言）。
6. 网关断线：`dropConnection()` → 重连（Resume 或 Identify）→ 推新事件 → 正常回复；心跳/重连均不阻塞 daemon（status 仍可访问）。
7. token 过期：fake token 首次有效、REST 返回 401 → driver 刷新后发送成功；断言 token 端点只调用 1 次（单飞）。
8. SIGTERM：daemon 退出码 0、WS 收到 close、无悬挂；重启后 outbox pending 重发（若条目为 local-test 则走 local 通道，避免 QQ 窗口干扰）。
9. （可选）`channel.localTest` + QQ 同时启用：local-test 注入消息时回复去 local-test；QQ 事件回复去 QQ（验证 per-turn 路由）。

### 5.4 Nix module eval 与 flake

- `nix flake check`（目标机/有 Nix 的开发机）：`unit` 跑包单元；`module-eval` 解析新 overlay row 与 service/env（check-module.py 扩展）；`package`/`package-smoke` 构建包含新包（`nix/package.nix` 复制整个 `packages/`，无需显式加包）。
- 手工清单（`.spec/12` 12.12 增补）：真实 Bot 私聊/群 @ 收发、被动窗口/分段、审批提示、命令、重启恢复、token 刷新、主动消息可用性实测（记录 err_code）、user-facing 通知降级观察。

### 5.5 测试矩阵（对照任务项）

| 任务项 | 单元 | 集成 | 进程 |
|---|---|---|---|
| 事件映射/能力位 | normalize | fake driver | QQ fake server |
| 被动上下文/outbox | outbox/format/core | service+两个 fake driver | 重启/超窗 |
| 多 driver 路由 | service | 两 driver | local+QQ 场景 |
| 错误分类 | rest/send-policy | service | fake err_code |
| gateway | gateway（FakeWS） | — | fake WS server |
| allowlist/trustedChannels | service | — | 启动配置 |
| Nix 配置 | — | — | module-eval |

---

## 6. 文件级实现清单（任务 5）

### 6.1 新包 `packages/channel-qq-bot/`

```
packages/channel-qq-bot/
├─ package.json          # @nokoribi/channel-qq-bot；deps: channel-core/shared/cordis/schemastery
├─ tsconfig.json         # extends ../../tsconfig.json；include src/test
├─ tsdown.config.ts      # 同 channel-local-test：entry src/index.ts, esm, node, dts, external
├─ src/
│  ├─ index.ts           # name/inject/Config/apply（enabled 守卫、secret 缺失 fail loud、registerDriver、effect dispose）
│  ├─ config.ts          # 配置类型 + env 解析/校验（secret 只存 env 名）
│  ├─ driver.ts          # ChannelDriver 实现：start/stop/send/canDeliver/health
│  ├─ gateway.ts         # WS 状态机：连接/Identify/Resume/心跳/重连/事件分发
│  ├─ rest.ts            # token 缓存/单飞/刷新 + 发送 + 错误码映射
│  ├─ normalize.ts       # QQ 事件 → InboundMessage + 文本清洗
│  └─ errors.ts          # 错误分类/包装 NonRetryableDeliveryError
└─ test/
   ├─ normalize.test.ts
   ├─ gateway.test.ts
   ├─ rest.test.ts
   ├─ send-policy.test.ts
   └─ config.test.ts
```

依赖检查：

- `@nokoribi/channel-core`（契约 + `Contact` 错误类）、`@nokoribi/shared`（logger、paths，若需要）、`@deepseek-ai/cordis`（plugin Context 类型）、`@deepseek-ai/schemastery`（Config schema）。
- 运行期 Node 内置：`WebSocket`（全局）、`fetch`（全局）、`node:crypto`（如需要）、`AbortSignal.timeout`。**若纯自研则零新增依赖**。
- **备选（task-3 评估中）**：官方 `@tencent-connect/qqbot-nodejs`（MIT，v1.0.5，依赖 `ws`）可作为 transport 依赖，driver 只保留 channel 语义；若选它则新增 `ws`（及其传递依赖），需按 D154 重新评审“零依赖”目标。官方 `@tencent-connect/dsh-qqbot`（MIT）是同级替代方案，见 task-3 文档。
- 风险：Node 官方 24.21.0 的 `WebSocket` 是否稳定/可用需 smoke（Nix 运行时是官方 Node，`nix/package.nix`）；Node `fetch` 不读 `HTTP(S)_PROXY`，部署需直连；无内置 WS server（测试自写）；如未来必须 webhook，Node `crypto` 可做 ed25519 签名，仍无依赖。

### 6.2 需修改文件清单（分类）

**必须改：**

| 文件 | 改动 | 关联 |
|---|---|---|
| `packages/channel-core/src/contract.ts` | `ReplyContext`/`OutboundContent` 扩展、`NonRetryableDeliveryError`、capabilities 可选项、`canDeliver` 可选方法 | §3.1/§3.3/§3.4 |
| `packages/channel-core/src/service.ts` | `trustedChannels`/`defaultChannelId` 配置；`lastInboundByChat`/`turnChat`；路由 helper；`enqueueText/sendReply/notify/broker sendPrompt` 改造；pump 传 `deliveryId/attempt/reply/kind`；错误分类；缺 driver 短路；可选 `channels` health | 行号见 §1 |
| `packages/channel-core/src/outbox.ts` | `EnqueueInput` + `enqueue` 写入 `replyTo/replyReceivedAt/replySeq` | `outbox.ts:11-18, 76-99` |
| `packages/shared/src/schemas.ts` | `OutboxItem` 可选字段（`replyTo/replyReceivedAt/replySeq`）+ zod schema | `schemas.ts:10-64` |
| `packages/channel-local-test/src/channel.ts` | `send()` 参数放宽为 `OutboundContent`（忽略 reply/kind） | `channel.ts:204-216` |
| `packages/bundle/cordis.patch.yml` | 新增 `nokoribi-channel-qq-bot` 行；`nokoribi-channel-core` 行加 `trustedChannels`/`defaultChannelId` | `:285-302` |
| `packages/bundle/package.json` | 加 `@nokoribi/channel-qq-bot` workspace 依赖 | `:71-73` |
| `nix/module.nix` | `channel.qqBot.*` 选项、assertion、warning | `:308-329, 400-470` |
| `nix/overlay.nix` | 新增 QQ row + channel-core `trustedChannels`/`defaultChannelId` | `:68-107` |
| `nix/check-module.py` | 新 overlay row/service/env 断言 | `:51-104` |
| `flake.nix` | sample 增加 QQ 配置（若做 module-eval） | `:38-59` |
| `nix/deps.nix` | 更新 `hash`（workspace 包/锁文件变化后） | `:10` |
| `pnpm-lock.yaml` | `pnpm install` 生成（新增 workspace importer） | — |
| `packages/channel-core/test/*`、`tests/integration/*` 的 FakeDriver | 契约变更回归 | — |
| `tests/process/support/fake-qq-bot.ts` + `tests/process/m7-qq.test.ts` | 新进程级测试 | §5.3 |
| `.env.example` | QQ 变量段 | `:1-72` |

**建议改：**

| 文件 | 改动 |
|---|---|
| `packages/channel-core/src/format.ts` | 分段预留 `(i/n)` 前缀空间，保证 chunk+prefix ≤ `maxTextLength`（QQ 约 5000/默认 4500） |
| `packages/channel-core/src/service.ts` `status()` / `DaemonStatus` | 增加可选 `channels` health；local-test `/v1/status` 自动透出 |
| `packages/agent-app/src/daemon.ts` | 可选：恢复 `lastActiveChat` 到 channel-core（§3.3.6）；outbox 耗尽通知（若做） |
| `packages/launcher/src/index.ts` | helpText 增加 QQ env（`:52-100`） |
| `README.md`、`AGENTS.md` | 状态/命令/渠道说明（实现后） |
| `.spec/03`、`.spec/04`、`.spec/05`、`.spec/06`、`.spec/12`、`.spec/13`、`.spec/14`、`.spec/15`、`.spec/16` | 实现/评审后回写（本轮不改） |

**仅记录（本轮不动，后续版本）：**

| 项 | 说明 |
|---|---|
| V8 图片链路（入站下载/出站富媒体/markdown 图片） | §3.6 |
| Webhook transport | §3.5.5，D150 保留 seam |
| driver 级 `allowedUsers/allowedGroups` | D152 用户决策不做；预留配置入口（§3.2.4） |
| gateway session 跨重启持久化 | 建议 M7 不做；D153 可后续加 `$DSH_HOME/state/qq-bot-gateway.json` |
| 主动消息模板/审核、msg_seq 大值优化 | 待实测后 |

### 6.3 构建/依赖检查

- 根 `package.json` `build` filter `./packages/*` 自动包含新包；新包要有 `build`/`typecheck` script（参考 `packages/channel-local-test/package.json`）。
- `pnpm install` 更新 `pnpm-lock.yaml`（workspace importer）；`fetchPnpmDeps` 的 `nix/deps.nix` hash 随之变化 → 必须更新，否则 `nix build`/`flake check` 失败。
- `nix/package.nix:82-112` `pnpm build` + `cp -a packages` 自动打包新包，无需显式列表；但 `pnpm install --prod --offline` 依赖锁文件完整。
- `nix/tests.nix:31-36` 的 `pnpm build && pnpm test --exclude 'tests/integration/**'` 会跑新包单元测试（process 测试不在 flake 内）。
- 新包 `tsdown.config.ts` 复制 `channel-local-test/tsdown.config.ts`：`external: [/^@deepseek-ai\//, /^@nokoribi\//]`。
- 纯自研方案无新增 external 依赖 → 不需要 `pnpm.allowBuilds`/overrides 变更；若 task-3 选择官方 SDK，则要新增 `ws` 依赖（及 lock/deps.nix hash 变化），按 D154 重新评审。
- `WebSocket` 全局 smoke：在 `nix/package-smoke` 加 `node -e 'typeof WebSocket === "function" && typeof fetch === "function"'` 类断言（**建议**，防止官方 Node 构建缺 WebSocket）；本地可用单元测试 `expect(typeof WebSocket).toBe("function")`。

---

## 7. 决策候选（任务 6，编号沿用 `.spec/17` 11 的临时分配，仅建议不写 `.spec/03`）

> `.spec/17-qq-official-bot.md` 是并行草案，已在 17.11 临时使用 D149–D157。为避免编号冲突，本文沿用其编号并标注**建议修正**；新增项从 D158 起。

| ID | 主题 | 推荐选项 | 说明/与 17 草案差异 |
|---|---|---|---|
| D149 | 里程碑重排 | M7 = QQ 真实 IM；M8 = SSH host | 无异议 |
| D150 | 平台/传输 | QQ 官方 Bot；M7 先 WebSocket；driver 内部保留 transport seam；webhook 是平台支持但需公网入口，后置 | WS 退役提示只出现在旧文档副本、live 事实表未复现；实现前用真实 Bot 验证连通性。若 WS 不可用，再评估 webhook + 反向代理方案 |
| D151 | 发送策略 | 被动优先（`msg_id`+`replySeq`）；主动回退实现为 `activeMessageFallback: auto`（capability-gated、失败可观测），**不作为可靠兜底**；验收增加“主动可用性实测”门禁 | 事实表有主动配额/错误码，但官方发送页横幅称已下线；两者矛盾。无论哪边成立，auto 策略都能工作：可用则回退，不可用则记 error 并降级（C2C 可后置用 `is_wakeup`）。 |
| D152 | 准入策略 | 只靠平台限制；core 用 `trustedChannels:["qq-bot"]` 跳过静态 allowlist；driver 只做平台级最小过滤；不实现配对/白名单；残余风险接受并写入 `.spec/15` | 与 17.6.2 方案 A 一致；不采用全局 `*` |
| D153 | 回复上下文与 gateway 会话持久化 | **回复上下文放 core+outbox（A2）**，不用 driver 私有状态；gateway session 不跨重启持久化（重启重新 Identify，靠 core 去重） | **与 17.5.2 相反**：17 把上下文放 driver 内存。建议评审此条为 M7 前置 |
| D154 | 依赖策略 | 优先零新增依赖：Node 24 `WebSocket`/`fetch` + 自写 fake WS server；**若 task-3 认为官方 MIT SDK 更稳，可选 `@tencent-connect/qqbot-nodejs`（新增 `ws` 依赖）** | 三选一待 task-3 结论：纯自研 / 官方 SDK 作 transport / 官方 dsh-qqbot 替代。风险：Node fetch 无 proxy、WS 全局需 smoke；`ws` 会打破“零依赖”目标 |
| D155 | 图片链路 | 后置 V8；M7 只忽略附件 | 无异议 |
| D156 | 密钥/配置 | AppID 入 store；ClientSecret 走 EnvironmentFile/agenix；token 仅内存；日志脱敏；Markdown 默认 `basic`（2026-04-23 起开放；代码块/表格待实测） | **更正初稿**：默认 `basic`（事实表 §7.2） |
| D157 | 验收边界 | mock/fake 自动化 + 真实个人 Bot 手工 + 目标机 NixOS；不做公开服务/群全量；增加“平台事实核对”门禁（token 格式、主动可用性、窗口/上限、MD、URL 限制） | 建议把 §9 清单纳入 D157 的验收前置 |
| D158（新增） | channel-core 最小扩展 | 按 §3.1/§3.3/§3.4 的 contract/outbox/error/routing 扩展作为 M7 前置，单独提交 + 单测，不和新包混在一个提交 | 若评审拒绝改 core，则接受降级方案（driver 状态），但需显式记录失败边界 |
| D159（新增） | 多 driver 路由与通知降级 | per-turn 来源路由 + notice 的 active-capable 回退/丢弃 + 缺 driver 短路；允许 local-test+QQ 同时启用（带 warning）；显式默认渠道 | 若 M7 想砍范围，可改为 module assertion 互斥 + 文档限制（不推荐） |
| D160（新增） | QQ 能力位默认值 | `markdown:"basic"`、`maxTextLength:4500`、`maxRepliesPerReply:4`（保守）、群/单聊窗口 300/3600s、`replySeq` 1..N（均可配） | 数值以事实表 + 实测校准；`msg_seq` 用 `replySeq` 而非 outbox 全局 seq（事实表 §13#18 提示 0..65535） |

---

## 8. 与现有代码/测试风格的对齐点（任务 7）

- **包形态**：`private:true`、`"type":"module"`、`files:["dist"]`、`main/types` 指向 `dist/index.js|d.ts`、`exports` 子路径（参考 `packages/channel-local-test/package.json`）；`scripts.build=tsdown`、`scripts.typecheck=tsc --noEmit`。
- **tsdown**：`entry:["src/index.ts"]`、ESM、node、`dts:true`、`fixedExtension:false`、`clean:true`、external 正则排除 `@deepseek-ai/*` 与 `@nokoribi/*`（`packages/channel-local-test/tsdown.config.ts:5-13`）。
- **tsconfig**：`extends:"../../tsconfig.json"` + `include:["src/**/*.ts","test/**/*.ts"]`；继承 strict、`verbatimModuleSyntax`、`isolatedModules`、`isolatedDeclarations`；类型导入必须 `import type`。
- **Cordis 插件**：导出 `name`、`inject:["channels"]`、`Config`（schemastery）、`apply(ctx, config)`；`enabled===false` 直接 return；`ctx.effect(() => () => disposeDriver())`（参考 `packages/channel-local-test/src/index.ts:9-43`）。
- **配置**：schemastery `z.object({...default(...)})`；所有超时/窗口/上限从配置读取，不写死部署参数（AGENTS.md 约束）；secret 只存 env 名。
- **日志**：`createLogger("channel-qq-bot")`；字段值仅 `string|number|boolean|undefined`（`shared/src/log.ts:6-11`）；不传消息正文/token；warn/error 自动进 recent 环（`log.ts:94-108`）。
- **错误类型**：可重试错误用普通 `Error`/自定义 `DeliveryError`；永久错误用 `NonRetryableDeliveryError`（从 channel-core 导出）；错误消息可读、不含敏感信息。
- **测试**：Vitest，包内 `test/*.test.ts`（根 `vitest.config.ts:5-15` 自动包含 `packages/*/test/**`）；进程级放 `tests/process/*.test.ts`（`vitest.process.config.ts` 单文件串行、60s 超时）；临时 `DSH_HOME` + fake LLM（`tests/process/harness.ts`、`support/scripted-llm.ts`）。
- **格式/lint**：oxfmt 4 空格/双引号/分号/80 列；oxlint correctness warn、`no-unused-vars` error；`pnpm check` 必须通过；不直接跑 `node_modules/.bin/*`。
- **提交**：实现时拆分为 core 契约、QQ 包、bundle/nix、文档等独立提交；每个 agent 提交带 `Assisted-By:` 尾注（当前轮为规格分析，不提交 git）。

---

## 9. 实现前置“待实测”清单（建议作为 D157 门禁）

> 这些点若假设错误，会直接改变 M7 设计；实现前用个人主体 Bot + 自己的群/开发体验用户实测，记录到 [`qq-official-bot-api-facts.md`](qq-official-bot-api-facts.md) 的 §13/§14 与 `.spec/14`。

1. **主动消息可用性（最高优先级冲突）**：无 `msg_id` 发送群/单聊 → 记录 HTTP/err_code（官方码 `40034105`/`40054013`/`40034100`；社区 `40034102`）；若群聊主动推送“部分恢复”，记录可用范围/配额/审核要求。结果决定 `activeMessageFallback` 的默认与验收口径。
2. **WebSocket vs webhook**：真实 Bot 连接/收发是否正常；live 文档是否仍维护 WS；官方 SDK 的双传输是否都可作为备选；若 WS 不可用，D150 复议（webhook 需公网入口）。
3. **token/API 域名与鉴权**：`api.bot.qq.com` vs `api.sgroup.qq.com`；token `api.bot.qq.com` vs `bots.qq.com`；REST `Authorization: QQBot <token>`；Identify `QQBot {AccessToken}`；`expires_in` 实际值；失败时是否 HTTP 200 + body code。
4. **被动窗口/次数边界**：单聊 60min/4 次 vs 5min 字段说明 vs 官方插件 30min 缓存；群聊 5min/5 次；超限/过期错误码（`40034128`/`40034005`/`304103`/`40034026`）与重试语义。
5. **`msg_seq` 语义**：官方 SDK 的 0..65535 范围是否真实；`replySeq` 从 1 递增是否接受；`40054005` 是否只表示“已发送过”；同一 `(msg_id,msg_seq)` 重试的行为（决定 at-least-once 收敛策略）。
6. **文本/Markdown 上限**：2000（第三方）/4500（官方插件）/5000（SDK 常量）哪个是平台真实值；超过时 `40054007`/`40054018` 还是截断；Markdown 代码块/GFM 表格是否渲染；`basic` 降级观感。
7. **URL/内容限制**：含 URL 是否必须后台预配置；`40054010` 的触发条件；是否需要 `stripUrls` 策略；内容违规（`40034006`）与审核行为。
8. **发送是否要求 WS 在线**：断开 WS 后只走 REST 发送的行为；错误码是否 `304018` 或新码；决定 driver 是否在离线时直接抛可重试错误。
9. **事件字段**：群 @ `content` 是否已去 @（事实表称已去）；`attachments[].url` 的 TTL/rkey 绑定/是否需要额外鉴权；`message_scene.ext.msg_idx/ref_msg_idx/auth_token`；同一事件重复推送的概率与间隔；`timestamp` 精度。
10. **intents 权限**：新 Bot 仅订阅 `1<<25` 是否能 READY（4014 权限？）；`GROUP_MESSAGE_CREATE` 在群主授权后是否也会推送（driver 必须忽略）；`INTERACTION_CREATE`（按钮审批）是否后置启用。
11. **频控/错误码全集**：`100001`、`40034100`、`50055001/2`、`40054007`、`40054010`、`40054013`、`40034105` 等实测归类（可重试/永久/回退/去重/长度）。
12. **准入/沙箱**：开发体验用户数量上限与配置流程；个人主体不能公开使用；管理员免沙箱测试；群内三项权限（全量消息/主动发言/撤回成员消息）；机器人封禁不可解封。
13. **网络**：目标机直连 `api.bot.qq.com`/`api.sgroup.qq.com` 的 TLS/DNS；是否需要代理（Node fetch 不读 `HTTP_PROXY`）。
14. **附件（V8 门禁）**：附件 URL 的有效期/鉴权/大小限制；`rkey` 是否与 appid 绑定；下载是否需要 SSRF 防护与重试策略。

## 10. 参考

### 本次分析依赖的本仓库产物

- 平台事实表（task-1，807 行，含来源/冲突/待实测）：[`qq-official-bot-api-facts.md`](qq-official-bot-api-facts.md)
- 并行规格草案：`.spec/17-qq-official-bot.md`（本文件与其 17.11 的 D149–D157 临时编号对齐）
- SDK/DSH 插件评估（task-3，进行中）：`.spec/notes/qq-official-sdk-and-dsh-plugin.md`（产出后以它为准）

### 代码（当前 HEAD）

- 契约：`packages/channel-core/src/contract.ts:4-94`
- ingress/broker/outbox 投递/路由：`packages/channel-core/src/service.ts:181-193, 232-267, 333-381, 416-499, 530-569, 571-622, 748-826, 836-853`
- outbox：`packages/channel-core/src/outbox.ts:11-18, 76-130, 220-244`
- 格式：`packages/channel-core/src/format.ts:10-67`
- 去重：`packages/channel-core/src/dedupe.ts:30-52`
- broker：`packages/channel-core/src/broker.ts:295-311, 401-413`
- shared schema：`packages/shared/src/schemas.ts:10-64`；路径 `shared/src/paths.ts:6-58`；日志 `shared/src/log.ts:66-125`；systemd `shared/src/systemd.ts:30-52, 140-210`
- local-test：`packages/channel-local-test/src/index.ts:9-43`、`src/channel.ts:112-131, 204-216, 268-363`
- daemon：`packages/agent-app/src/daemon.ts:220-306, 308-394, 474-489, 491-513, 540-563, 648-815, 945-965`
- 装配：`packages/bundle/cordis.patch.yml:285-302`；`packages/bundle/package.json:71-73`
- Nix：`nix/module.nix:82-93, 308-329, 400-470, 506-542`；`nix/overlay.nix:68-107`；`nix/check-module.py:51-104`；`flake.nix:38-92`；`nix/package.nix:82-112`；`nix/deps.nix:10`；`nix/tests.nix:31-36`
- 测试：`tests/process/harness.ts:79-237`；`tests/process/support/scripted-llm.ts:199-297`；`tests/integration/m2-child-approval.test.ts:144-282`；`vitest.config.ts`/`vitest.process.config.ts`；`tests/process/m6.test.ts:54-97`

### 规格

- 渠道契约/入站/出站/本地通道/错误：`.spec/06` 6.2–6.10
- 启动/关闭/恢复/通知：`.spec/05` 5.3–5.9
- NixOS 选项/overlay/systemd/密钥：`.spec/12` 12.4–12.8
- 测试分层/矩阵/日志/flake：`.spec/13` 13.2–13.5
- 后置项/风险：`.spec/14` 14.8；`.spec/15` 15.3–15.4
- 并行草案：`.spec/17-qq-official-bot.md`（D149–D157 临时编号）

### 官方/外部平台文档

- 发送消息 hand-written 页（主动横幅/配额/字段/错误码）：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html>
- 单聊发送接口 schema（事实表 S18）：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>
- 群聊发送接口 schema（事实表 S19）：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- 消息收发概述（被动窗口/次数规范表，事实表 S23）：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- 事件订阅与通知（Payload/OpCode/Identify/Resume/intents）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html>
- WebSocket 接入页（事实表 S4，页面更新 2026-07-29）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html>
- Webhook 接入页（事实表 S36）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html>
- 接口调用与鉴权（`api.bot.qq.com`、`Authorization: QQBot`；事实表 S3）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html>
- 获取访问凭证（事实表 S2，文档写 `api.bot.qq.com/app/getAppAccessToken`）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>
- 唯一身份机制（openid 按 AppID/群不同）：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/unique-id.html>
- 消息类型/Markdown（2026-04-23 起单聊/群聊自定义 MD 开放；事实表 S25）：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html>
- 错误与调试（err_code/trace_id、40034005/40034105 等示例）：<https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html>
- 网关接入点：<https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html>、<https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html>
- 官方 Node SDK `@tencent-connect/qqbot-nodejs`（MIT，v1.0.5，依赖 `ws`）：<https://github.com/tencent-connect/qqbot-nodejs>
- 官方 DSH QQ 插件 `@tencent-connect/dsh-qqbot`（MIT，v0.5.3）：<https://www.npmjs.com/package/@tencent-connect/dsh-qqbot>
- 机器人 FAQ / 准入（事实表 S32）：<https://bot.q.qq.com/wiki/bot_FAQ/>
- 官方文档源码（版本/冲突可追溯；注意 GitHub master 副本可能落后于 live 页面）：<https://github.com/tencent-connect/bot-docs>
