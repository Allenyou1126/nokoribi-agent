# 06 渠道与交互

## 6.1 设计目标

- v1 不接真实 IM，但把渠道契约定义清楚，并用本地测试通道完成端到端验收。
- 所有入站消息统一走一条 ingress 管线；所有出站消息统一走 outbox。
- 默认"不打断"注入：忙碌 steer、空闲 followup；只有显式命令才 cancel。
- 审批/提问在纯文本渠道上可完成；待应答期间消息优先给应答者。

## 6.2 ChannelDriver 契约

```ts
type OutboxKind = 'reply' | 'notice' | 'interaction';
type OutboundActionKind = 'callback' | 'link' | 'command';

interface OutboundAction {        // D163 预留；M7 不渲染
  id: string;
  label: string;
  kind: OutboundActionKind;
  payload?: string;
  url?: string;
  style?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}

interface ReplyContext { messageId: string; receivedAt: number; seq: number; }

interface OutboundContent {
  kind: OutboxKind;
  text: string;
  deliveryId: number;             // outbox seq，跨重试/重启稳定
  attempt: number;
  reply?: ReplyContext;
  actions?: OutboundAction[];
}

interface ChannelCapabilities {
  markdown: 'none' | 'basic' | 'full';
  maxTextLength: number;          // 0 表示不限
  inboundImages: boolean;
  outboundFiles: boolean;
  activeMessages?: boolean;       // 缺省 true
  maxRepliesPerReply?: number;    // 缺省/0 不限
  outboundActions?: boolean;      // 缺省 false（D163）
  inboundActions?: boolean;       // 缺省 false（D163）
}

interface ChannelDriver {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  readonly defaultChatId?: string; // 无入站上下文时可寻址的 chat
  start(ctx: { onInbound(msg: InboundMessage): void }): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, content: OutboundContent): Promise<SentRef>;
  canDeliver?(chatId: string, content: Pick<OutboundContent, 'kind' | 'reply'>): boolean;
  health?(): { state: 'online' | 'connecting' | 'offline'; detail?: string };
}

interface InboundAction { id: string; payload?: string; messageId?: string; }

interface InboundMessage {
  channelId: string;
  chatId: string;
  senderId: string;
  messageId: string;            // channel 级唯一幂等键
  text?: string;
  images?: { mime: string; data: Uint8Array }[];
  replyTo?: string;
  action?: InboundAction;       // 按钮/菜单回调（D163 预留）
  receivedAt: number;
  delivery?: 'steer' | 'followup' | 'interrupt';  // 代码层参数
}

interface SentRef { channelId: string; chatId: string; messageId: string; }
```

设计要点：

- driver 负责平台差异（连接、签名、消息 id、媒体下载、重连）；core 不感知平台。
- `capabilities` 用于降级：`markdown: 'none'` 时 core 去格式化；`inboundImages: false` 时拒绝/忽略图片并告知；`maxTextLength` 用于分段；`outboundActions` 决定 core 是否下发 `actions`。
- v1 的 driver 只需要文本；`outboundFiles` 预留。
- 真实 IM 适配器：M8 先接 QQ 官方 Bot（见 [17](17-qq-official-bot.md)）；其他平台后置。
- **M7 已实现（D153/D158/D159/D161/D163）**：`OutboundContent` 扩展、`ReplyContext`、`NonRetryableDeliveryError`/`PassiveReplyExpiredError`、capabilities、`canDeliver()`/`health()`/`defaultChatId?`；channel-core 增加 `trustedChannels`/`defaultChannelId`、`turnChat` 路由、通知 defer 与 outbox 持久字段 `replyTo/replyReceivedAt/replySeq`/`actions`/`deferredNotices`。
- 动作按钮只是扩展空间（6.11）：`actions` 只附在最后一段；不支持 `outboundActions` 的 driver 不会收到；入站 `action` 必须同时带 `text` fallback，M7 不解释 `action`。

## 6.3 入站处理顺序

严格按以下顺序：

1. **driver 回调**：标准化为 `InboundMessage`。
2. **allowlist**：单用户白名单（senderId + chatId）；不在白名单的消息只记日志、丢弃。`trustedChannels` 中的渠道跳过该检查（由 driver 依赖平台准入，M7/D152），启动时逐条 warn。
3. **幂等去重**：以 `channelId + messageId` 为键，持久记录（`$DSH_HOME/state/ingress-seen.json` 或等价有界存储）；重复消息直接忽略。
   - 先记录再注入（避免崩溃后重复处理）；极小窗口内崩溃可能丢弃一条消息，用户可重发。
4. **命令解析**：以 `/` 开头进入命令分发（见 6.5）。未知命令直接回错误，不进入模型。
5. **待应答检查**：存在审批/提问时，普通文本作为应答交给 broker（除非是 `/steer` 等命令旁路）。
6. **默认注入**：
   - 若本消息带代码层 `delivery` 或上一条裸 `/steer`/`/queue` 设置的一次性模式，按该语义；
   - 否则 `agent.status === 'running' ? agent.steer(userMessage) : agent.followup(userMessage)`。
7. 用户消息的 `source` 使用 `{ kind: 'user' }`（这是人类，不是 agent-to-agent 消息）。
8. 更新 `lastActiveChat`。

补充：

- ingress 串行处理（单主会话），保证命令与消息顺序。
- 启动恢复期间 driver 收到的消息进入内存缓冲，恢复完成后再按序处理。
- `/clear` 期间到达的消息缓冲到新主会话 ready 之后。

## 6.4 注入语义与参数

默认（D05）：

| 场景 | 行为 |
|---|---|
| 主 agent running | `steer()`：最近 step 边界注入，不打断工具执行 |
| 主 agent idle | `followup()`：开始新一轮 |
| 显式 `/steer <文本>` | 强制 steer；不当作待应答答案 |
| 显式 `/queue <文本>` | 强制 followup |
| 待应答中普通文本 | 作为审批/提问答案；`/steer` 只旁路解析，不打断待应答 |
| `/stop` | 取消主 agent 当前轮并清空中断前排队；只有显式命令才中断 |

- 裸 `/steer` / `/queue`（不带文本）设置"下一条消息"的一次性投递模式；该状态只存内存，重启即失效。
- 代码层 `delivery` 字段优先级最高；未知值报错给调用方（测试通道/内部 API），不进模型。
- v1 不做连续消息合并/防抖（未来可加）。

## 6.5 命令

命令通过 DSH commands seam 执行（不产生模型消息），桥接注册自己的命令；`ctx.commands.execute(agent, line, attachments, signal)` 的结果回给 IM 用户。

| 命令 | 语义 |
|---|---|
| `/stop` | 取消主 agent 当前轮；中止待审批/提问；清空主 agent 排队注入。**不影响 goal 子代理** |
| `/status` | 摘要：运行状态、主会话 id、模型、活跃 goal 数、待应答数、outbox 长度、uptime、版本 |
| `/status full` | 每个 goal 的短 id/phase/rounds/model、sandbox 实例与 TTL、active schedule、memory 计数、最近错误、reviewer、last restart reason；不展示敏感信息 |
| `/steer [文本]` | 带文本：强制 steer 这条文本；不带文本：下一条强制 steer |
| `/queue [文本]` | 带文本：强制 followup；不带文本：下一条强制 followup |
| `/clear` / `/new` | 新建主会话，旧会话归档；停止并归档 goal 子代理，删除旧主会话的 schedule 任务（见 05/10） |
| `/compact` | 透传 DSH `/compact`（压缩主会话上下文） |
| `/goal ...` | 桥接自有语义：`new <目标> [--rounds N] [--model provider/model] [--effort ID]`（宿主创建 continuable child + goal）、`list`、`status <前缀>`、`pause <前缀>`、`resume <前缀>`、`clear <前缀>`（停止+自动归档）、`archive <前缀>`（归档已完成 goal） |
| `/permission` | 只报告当前 permission preset（Auto）；任何切换参数返回错误。v1 没有 DSH 沙箱回退，切走会绕过审查（见 08） |
| 其他已注册 DSH 命令 | 透传 `ctx.commands.execute`；未知命令回错误，不进入模型 |

命令输出会按渠道上限分段；命令不进入模型历史（DSH commands 自带记录到会话日志）。

## 6.6 审批/提问 broker

### 来源

- approval：`dsh-user-approval` 的 `approval/request` waterfall；Auto review 拒绝后的 ask、以及未来其他敏感操作。
- question：`ctx.userQuestions.ask` 背后的 `user-questions/request` waterfall（M2 挂载 `tool-ask-user`）。
- 子代理审批：vendored auto-review 在 child 的 `never` 下先用 `setApprovalPolicy(...,"ask")`，再走 approval seam；broker 统一处理（D131）。
- broker 实现：`channel-core/src/broker.ts`；approval 与 question 共用一个 FIFO，`pendingInteractions` 计数包含排队项。

### 提示与应答

- 审批提示（🔐）：说明是谁（主 agent / goal 短 id）、工具、原因、命令摘要；回复 `允许` / `拒绝` 或 `1` / `2`。
- 提问提示（❓）：按问题列出标题、detail、编号选项、是否多选；多问题批次逐题提问；支持编号、多选编号（`1,3`）、自定义文本。
- 提示带 `interactionId`（outbox 字段；正文不展示）；用户回复先交给当前待应答（串行，只有一个）。
- 不合法的回复不进入模型，重新提示帮助文本；不消耗应答超时重新计时（实现使用总超时）。
- `approval` 超时 → 拒绝；`question` 超时 → 工具报错（`ASK_ABORTED`）；可配（默认 60s/300s）。超时发 ⚠️ 通知并展示下一项。
- 待应答期间 `/steer` 不打断待应答：只把文本投递为 steer，审批/提问继续等；真正注入要等轮次恢复（D59）。
- `/stop`、`/clear`、shutdown 取消轮次时，所有待应答中止并通知；`/clear` 同时尽量抑制未发送的旧提示。
- 实现补充：非法回复重发帮助文本，但不重置总超时；审批发送失败返回 `unavailable`，提问发送失败返回 `NO_PROVIDER`，都 fail closed。
- **M7 可投递性预检**：`sendPrompt` 先解析目标 chat，调用 driver `canDeliver(chatId,{kind:'interaction',reply})`；无 driver、不可投或被动槽位耗尽时立即抛错，broker 按上述 fail-closed 路径结算，不再静默等 60s/300s 超时。

### 子代理审批

- patched auto-review 在 hold child 审批时使用同一 broker；提示带 goal 短 id。
- 全局串行：多个 goal 同时请求审批时排队展示，避免文本回复歧义。
- 实现结果（M2）：child deny 时写 `approval/policy: ask`，随后 approval 走 broker；prompt 带 goal 短 id（child sessionId 前 8 位）。进程内集成测试覆盖 child → fake channel。
- prompt 同时修正 DSH 的 `subagent:delegation` 文案，避免继续声称“审批一律自动拒绝”。

### 提示去重与并发

- 每个待应答只展示一次；outbox 是 at-least-once，仍可能重复。broker 记录已终止的 interactionId，outbox pump 对同 id 的未发送项直接丢弃/标记失败；已发送后的重复展示接受。

## 6.7 出站投递

### 触发

1. **每轮回复**：主 agent 每轮结束（turn/end）取该轮最后一条非空 assistant 文本，作为一条 IM 消息。
   - 空文本不发。
   - 工具调用过程不发（无流式、无过程播报）。
   - 若该轮由 goal 子代理 report 唤醒，主 agent 的回复同样镜像到 IM（主 agent 被提示词要求转述）。
2. **系统通知**：error、非用户触发的 abort、goal blocked、重启、待应答失效、恢复失败（见 05.9）。
3. **主动补发**：`send_to_user` 工具（主 agent / 子代理可调用）用于里程碑补充、未来附件；v1 常规回复不依赖它。

### 分片与格式

- 按 driver `maxTextLength` 分段；优先段落边界，其次代码块边界，避免拆开代码围栏；多段加 `(1/n)` 前缀。
- markdown 能力：
  - `full`：原样；
  - `basic`：保留代码块/列表/粗体，去掉复杂表格/HTML；
  - `none`：降级为纯文本（代码用缩进，去掉标记）。
- 系统通知加 ⚠️ 前缀；审批/提问分别加 🔐 / ❓。

### `send_to_user` 工具（草案）

- 全局注册，主 agent 与子代理可调用；参数 `{ text }`（v1 不支持附件；未来可扩展）。
- 用途：主 agent 在自动镜像之外主动补发消息（进度、补充说明、未来附件）；goal 子代理默认不用它，通过 report 回流主 agent。
- 调用后的消息直接进入 outbox（kind=reply），不等待 turn 结束；仍然会按渠道上限分段、markdown 降级。
- Auto review 会审查该工具调用；不用于绕过审批/提问。

### outbox

- 持久化条目：`{seq, channelId, chatId, kind, text, interactionId?, state, attempts, nextAttemptAt, createdAt, sentAt}`，落盘在 `$DSH_HOME/state/outbox.json`（M1）；`nextSeq` 单调，历史保留最近 `outboxHistoryLimit` 条终态记录，pending 不裁剪。
- **M7 已实现（D153/D158/D162/D163）**：条目增加可选 `replyTo/replyReceivedAt/replySeq`、`actions`，outbox 文档增加 `deferredNotices[]`；旧 outbox 文件缺字段时视为“无被动上下文/无动作/无延迟通知”。`replySeq` 由 retained items 的 `(channelId,chatId,replyTo)` max+1 推导，重试/重启复用同一值。
- **actions（D163）**：动作只附在最后一段；`outboundActions !== true` 的 driver 在 enqueue 时剥离并 warn；deferred 通知/回复不保存 actions（回调已过期）；M7 没有生产者。
- 按 seq 全局有序投递；失败指数退避重试；超过最大尝试次数记录错误并丢弃（同时 journald 告警，并在存在 active-capable 渠道时发系统通知；M7 已收口“只 log”的偏差：reply 耗尽合并发一条通知，notice 失败转 defer 或记录 error）。
- **at-least-once**（D132）：发送成功后落盘标记；崩溃可能造成重复发送，接受。被动回复以稳定 `(msg_id, msg_seq)` 重试由平台去重（QQ `40054005` 视为成功）。`PassiveReplyExpiredError` 由 driver 抛出时，core 清掉 reply 字段后按主动消息重试一次。
- 重启后从持久 outbox 继续；已解决/中止交互的提示跳过：pump 检查 broker terminal 集合，未发送项标记失败；启动时残留 pending interaction 统一标记失败并通知。
- 多 chat 路由（M7 已实现，D159/D162）：回复回本轮来源 chat（`turnChat`，运行中显式 followup 由 daemon `turn/start` 提升）；通知/提醒按“同 chat 可投 → 其他有 `defaultChatId` 的 active-capable driver → 同 chat defer → drop”选择；无可用入站上下文的 reply 在 active 失败时也按 D161 defer；交互提示不 defer。
- 缺 driver 的条目不再无限 pending：目标渠道未注册时立即标记 failed 并记录 error。

## 6.8 本地测试通道 HTTP

绑定 `127.0.0.1`，固定 token（Nix option，D106/D119），仅验收期启用。

### 认证

所有请求带 `Authorization: Bearer <token>`；常量时间比较；无 token 或错误 → 401。

### `POST /v1/inbound`

```json
{
  "text": "帮我看看磁盘占用",
  "images": [{ "mime": "image/png", "dataBase64": "..." }],
  "messageId": "optional-client-id",
  "chatId": "optional-chat-id"
}
```

响应：`202 { "messageId": "..." }`；同 messageId 重复请求幂等返回已接受。`delivery` 可选，用于测试代码层参数（`steer`/`followup`/`interrupt`）。

### `GET /v1/outbound?after=<seq>&timeout=<sec>`

长轮询：有新条目立即返回；无新条目在 timeout（默认 25s）后返回空列表。

```json
{
  "items": [
    { "seq": 41, "kind": "reply", "chatId": "local", "text": "..." },
    { "seq": 42, "kind": "interaction", "interactionId": "i-3", "text": "🔐 ..." },
    { "seq": 43, "kind": "notice", "text": "⚠️ ..." }
  ],
  "nextSeq": 44
}
```

`seq` 持久化、有界（默认保留最近 1000 条终态记录，pending 不裁剪）；重启后仍可按 seq 取到未过期条目。`nextSeq` 必须与本次返回的 items 对齐（最后一条 seq + 1；无新条目时为请求的 `after`），避免并发 enqueue 导致客户端跳过未读条目。M1 启动后写 `$DSH_HOME/run/test-channel.json`（host/port/pid），进程测试据此发现端口。

### `GET /v1/status`

```json
{
  "version": "0.1.0",
  "uptimeSec": 1234,
  "mainSessionId": "...",
  "agentStatus": "idle",
  "goals": [{ "shortId": "a1b2c3d4", "phase": "active", "rounds": 3 }],
  "pendingInteractions": 0,
  "outboxLength": 0,
  "permission": "auto",
  "lastRestartReason": "clean",
  "ready": true
}
```

`ready` 在 `run/ready.json` 与主会话恢复完成后置 true；启动中返回 `agentStatus:"starting"`。`images` 入站当前未实现（V8 后置；测试通道返回 501）。

### 其他

- 不做 SSE（D133 选长轮询）。
- 不做 CORS；仅本机。
- 不做附件上传接口（v1 只支持入站图片以 base64 放进 inbound；测试足够）。
- 测试通道实现为 `channel-local-test` 包，不进入真实 IM 的 driver 列表。

## 6.9 真实 IM 适配器（M8：QQ 官方 Bot）

M8 先接 QQ 官方 Bot，完整规格（平台事实、被动回复策略、配置、安全与验收）见 [17](17-qq-official-bot.md)。通用要求：

- 平台连接与重连（driver 内）；M8 使用 WebSocket 网关（D150）。
- 入站身份与白名单（channelId/chatId/senderId）；M8 按 D152 只依赖平台准入边界。
- 平台 messageId 作为幂等键；重复投递由 core 去重；chatId 使用 `c2c:`/`group:` 命名空间（D160）。
- 被动回复：`msg_id + msg_seq` 由 core 的 outbox 上下文承载（D153），超窗按能力回退主动消息（D151）。
- 图片下载为 bytes；大小限制与 mime 校验——M8 不做，V8 后置（D155）。
- `maxTextLength`、markdown 能力、发送重试/限速由 driver 能力位与错误分类承担。
- 长消息切分由 core 做，driver 不切；消息按钮/流式/互动回调后置。
- 私聊单用户 + 群内 @ 提及；群全量消息与多人权限不在 M8 范围。

**M8 实现口径（2026-10-27，D164）**：`packages/channel-qq-bot` 已实现；driver 直接使用 SDK `ApiClient` 发送以精确控制 `msg_id`/`msg_seq`（active 不带 `msg_seq`），REST 层把 HTTP 200 + body `code` 显式转 `ApiError`；`GatewayConnection` 只订阅 `1<<25`，首个 READY 有界等待，后台重连；能力位 `markdown=basic`、`maxTextLength=4500`、`maxRepliesPerReply=4`、`activeMessages` 动态；chatId 为 `c2c:<user_openid>`/`group:<group_openid>`；无 `defaultChatId`（无入站上下文时通知 defer/drop）；`outboundActions/inboundActions=false`，不订阅 `INTERACTION_CREATE`。SDK 1.0.5 对 4009 重新 Identify（不是 Resume），记录在 D164/15.4。

## 6.10 错误与边界情况

| 情况 | 行为 |
|---|---|
| 白名单外消息 | 丢弃 + 日志 |
| 重复 messageId | 忽略 |
| 未知 `/` 命令 | 回错误，不进模型 |
| 命令执行失败 | 回错误文本，不进模型 |
| agent 不存在/正在 `/clear` | 消息缓冲，新会话 ready 后处理 |
| driver 断开 | outbox 保留，重连后继续；入站由平台侧重投/driver 处理；QQ 场景按 17.3 重连/失败分类 |
| 被动回复窗口过期（M8） | driver 抛 `PassiveReplyExpiredError`；core 清 reply 后按主动重试一次。仍失败且无上下文时按 D161 defer（notice/reply），有上下文时记 failed（17.5.2 的接受边界） |
| outbox 发送失败超上限 | 日志记录；reply 耗尽在存在 active-capable 渠道时合并发一条系统通知；可 defer 的 notice/无上下文 reply 转 deferred 队列并在下次入站补投；其余置 failed |
| 平台拒绝（永久错误，M8） | driver 抛 `NonRetryableDeliveryError`，core 立即 failed，不重试；可 defer 的无上下文 notice/reply 先转 deferred |
| 按钮/回调入站（D163） | driver 归一化为 `InboundMessage.action` + 必需的 `text` fallback；M7 不解释 action，纯回调无文本仍按 `empty` 丢弃 |
| 空 assistant 回复 | 不发消息 |
| 超长回复 | 分段；每段独立进入 outbox；有被动上下文时按 `maxRepliesPerReply` 截断并加省略标记 |
| 审批/提问超时 | 拒绝/工具报错 |
| 多个待应答 | 串行展示 |

## 6.11 动作按钮扩展（D163，M7 只预留）

- 背景：QQ 官方 Bot 支持消息内联键盘（`keyboard`）与 `INTERACTION_CREATE` 回调；其他平台也有 inline button/component。为避免未来接入时迁移 core 契约与 outbox，M7 只定义通用模型与持久化。
- 出站：`OutboundAction{id,label,kind:'callback'|'link'|'command',payload?,url?,style?,disabled?}`；`OutboundContent.actions` 只下发给 `capabilities.outboundActions===true` 的 driver；同一消息分段时只附在最后一段；无正文时 actions 不单独成消息；`sendReply`/`notify` 预留可选 `actions` 参数（M7 无生产者）。
- 入站：`InboundAction{id,payload?,messageId?}`；driver 必须同时提供 `text` fallback（按钮 label、命令或“允许/拒绝”），core 的文本管线照常工作；M7 不把 action 路由给 broker，按钮审批属后续增强。
- 持久化：outbox 条目保存 `actions`（重试/重启保留）；deferred 通知/回复丢弃 actions，补投不带按钮。
- 平台映射（M8+，不实现）：QQ `keyboard.content.rows[].buttons[]`；`action.type` 0=link、1=callback、2=command；`label` ≤10 字符、`style`、`permission`、`modal`、`event_id` 与 `PUT /interactions/{id}` ack 由 QQ driver/后续里程碑处理；事实见 `.spec/notes/qq-official-bot-api-facts.md` §5.6/§6.5。
- 明确不做：按钮渲染、`INTERACTION_CREATE` 订阅（intent `1<<26`）、互动回调应答、按钮审批 UX。
