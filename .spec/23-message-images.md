# 23 消息图片与出站文件（M14）

> 状态：**代码完成（2026-10-30）；真实平台门禁待执行**（M14 只可标“代码完成”）。M14 已实现入站图片（driver 下载/解码 → channel-core attachment store → 模型 image block）与出站文件（`send_to_user` + `OutboundContent.files` + QQ C2C 富媒体/local-test 字节端点）。实现口径见 [D180](03-decision-log.md)；测试记录见 [13.1](13-testing-and-ops.md)。

## 23.1 目标与范围

M14 打通渠道的媒体链路，分两个阶段：

- **入站图片（phase A）**：用户发给 QQ Bot 或本地测试通道的图片，经 driver 下载/解码后由 channel-core 存入 DSH attachment store，再作为 `image` content block 注入主会话（模型侧由 DSH llm 层按路由投影）。
- **出站文件（phase B）**：agent 通过 `send_to_user` 工具把工作区文件交给渠道；channel-core 持久化 attachment ref 并进入 outbox，QQ 走富媒体上传 + `msg_type=7`，local-test 暴露元数据与字节下载端点，供进程测试验收。

不在范围：入站语音/视频/文件、出站图片/视频/语音、markdown 图片外链、群聊富媒体、图片 OCR/视觉模型选择（模型侧投影完全交给 DSH llm）。

> 附：未知斜杠命令透传（M12 前置依赖，随 M14 一并落地）——`channel-core` 的 `process()` 在 `ctx.commands.execute()` 返回 `undefined` 时**不再回复“未知命令”**，而是把该文本当作普通用户消息继续走注入管线（待应答检查 + steer/followup）。这样 `/skill-name` 这类用户显式调用能到达 agent 的 skill pre-step。已注册命令行为不变，不新增配置开关。

## 23.2 契约

`packages/channel-core/src/contract.ts`：

```ts
interface InboundMessage {
  // ...既有字段
  images?: { mime: string; data: Uint8Array }[]; // 已由 driver 下载/解码的原始字节
}

interface OutboundContent {
  // ...既有字段
  actionKind?: "approval" | "question"; // 产生 actions 的交互类型（driver 据此按配置门禁键盘）
  files?: readonly FileAttachmentRef[]; // 本次投递携带的持久文件引用
}
```

- `FileAttachmentRef`/`ImageAttachmentRef` 直接复用 `@deepseek-ai/dsh-attachment` 的类型（package 依赖已加入 channel-core / channel-qq-bot / channel-local-test / agent-app）。
- 能力位含义（M14 起）：`inboundImages: true` = driver 会把图片字节放入 `InboundMessage.images`；`outboundFiles: true` = driver 能处理 `OutboundContent.files`。QQ 与 local-test 均为 true；核心只在能力位为 false 时拒绝/剥离。
- channel-core 静态 inject 增加 `attachments`（`ctx.attachments`）；QQ/local-test/agent-app 插件同样 require 该服务。

## 23.3 channel-core 行为

### 入站

1. `ingress()`：带 `images` 的消息只在目标 driver `inboundImages !== true` 时返回 `{accepted:false, reason:"unsupported-images"}`；否则进入正常管线（启动缓冲同样保留图片）。
2. `process()`：`ctx.attachments.saveImages([{data, mediaType: mime}])` 保存图片，得到 `ImageAttachmentRef[]`；随后构造 `createUserMessage({content:[{type:"text",text}?, ...{type:"image",attachment}], source:{kind:"user"}})`，按既有 delivery 语义 steer/followup。
3. 降级：attachments 服务缺失或 `saveImages` 抛错时记 warn、丢弃图片按纯文本投递；若文本也为空则返回 `accepted:false, reason:"empty"`（不崩溃）。图片保存成功但文本为空是合法消息（图片-only）。
4. 不重复 DSH llm 的图片→文本投影逻辑：text-only 模型由 llm 层负责占位投影。

### 出站

1. `OutboundOptions` 增加 `files`/`actionKind`；`ChannelService.sendReply(text, {files})` 保留原签名，新增 `sendFiles(files, text?, options)` 返回入队 seq（供 `send_to_user` 回执）。
2. outbox 条目持久化 `files`（`FileAttachmentRef[]`）与 `actionKind`。shared 包的 `OutboxItem` schema 是 passthrough，**M14 不修改 `packages/shared`**：channel-core 用 `outboxEntry()` 提供类型化视图，旧 outbox 文件缺字段按“无文件/无交互类型”解析，重试/重启保留引用。
3. 实现偏差（相对计划“files 只附在最后一段文本”）：`files` 以**独立空文本 outbox 条目**排在文本分段之后入队，每个文件一条。理由：一个 outbox 条目对应一次平台发送，独立条目才能让 QQ 的每个富媒体消息拥有自己的 `replySeq`/重试身份；避免在一个条目内多次平台发送破坏被动回复槽位计数与 at-least-once 语义。文本分段行为不变，文件永远只出现在最后（文件条目），中间分段不携带 files。
4. 被动槽位：`maxRepliesPerReply` 有限时先为文件预留槽位；`sendFiles()` 要求全部可投（`requireFiles`），槽位不足抛 `NonRetryableDeliveryError` 让工具报错，不静默丢文件；普通回复路径（无文件）完全保持原行为。
5. defer/降级：通知、补发、被动过期降级等 deferred 路径只保存文本，**文件被丢弃并 warn**；能力位不支持时 enqueue 阶段剥离文件并 warn（文件-only 条目在 pump 时直接标 failed，避免空文本重试循环）。
6. 文件读取通过 driver 注入的 reader 完成（QQ 插件 `apply()` 用 `ctx.attachments.readFileStream`；pump 只传 ref，不传字节）。

## 23.4 QQ driver

### 入站图片

- `normalizeInbound()` 从 `attachments[]` 收集 `content_type` 以 `image/` 开头且 `url` 非空的条目为 `imageSources`（其余附件继续忽略）；纯附件消息不再被丢弃，文本为空时按图片-only 投递。
- driver 在 `start()` 的 `onInbound` 中异步下载（无图片时保持同步转发，M8 行为不变）：
  - `QqRest.downloadImage(url, {maxBytes, timeoutMs})`：仅接受 `http(s)`；AbortController 硬超时；优先检查 `content-length`，流式累计超限即 abort；返回 bytes+content-type。
  - mime 以响应 `content-type` 优先，回退附件声明；只接受 `image/png|jpeg|webp|gif`（`image/jpg` 归一化），不支持的图片忽略并 debug。
  - 任一图片下载失败：在文本后追加 `[图片下载失败，已忽略]`；无文本时该 note 作为文本投递；成功下载的其它图片仍保留。
  - `inboundImages=false`：不下载，纯图片消息忽略，带文本消息只投文本（能力位同时为 false，core 侧也会拒绝带图消息）。
- 入站顺序/去重不变：先下载再交给 core，core 负责 allowlist/去重。

### 出站文件

- C2C：先发文本消息（非空时），然后每个文件一条：
  1. `POST /v2/users/{openid}/files`，body `{file_type, srv_send_msg:false, file_data:<base64>, file_name?}`；`file_type` 按扩展名映射（图片 1/视频 2/语音 3/其它 4，4 附带 `file_name`）。
  2. 上传返回 `file_info` 后发 `POST /v2/users/{openid}/messages`，body `{msg_type:7, media:{file_info}, msg_id?, msg_seq?}`（被动上下文可用时带稳定 `msg_id/msg_seq`）。
- 失败分类复用 M8 的 `classifySendError()`：网络/5xx/限流可重试；平台 4xx/永久码 → `NonRetryableDeliveryError`；被动过期 → `PassiveReplyExpiredError` 由 core 清 reply 重试一次；上传与发送都走该分类。
- **群聊限制**：群富媒体被动回复未在真实平台验证（见 17.4/17.5 的待实测项），M14 只在 C2C 实现。群聊带文本的文件条目降级为纯文本并 warn；文件-only 条目抛 `group-rich-media-unsupported`（non-retryable）。后续平台实测通过后再放开。
- 附件读取：`QqBotDriverOptions.readFile` 由插件 `apply()` 注入 `ctx.attachments.readFileStream`；driver 校验累计字节数等于 ref.bytes，不符按普通可重试错误处理。

## 23.5 local-test 通道

- `POST /v1/inbound`：接受 `images: [{mime, data(base64)}]`；逐条校验（mime 白名单、canonical base64、非空、<= `inboundImageMaxBytes` 默认 10MiB），非法 → 400；`text` 与 `images` 至少一个；图片-only 合法。响应仍为 `202 {messageId}`。
- `GET /v1/outbound`：每个 item 增加 `files` 元数据 `{attachmentId, name, bytes, mime}`（mime 由扩展名推断，仅用于测试展示）。
- 新增 `GET /v1/attachments/<attachmentId>`：从 driver 在 `send()` 时记录的文件引用读取 `ctx.attachments.readFileStream` 并流式返回字节；`content-type` 按扩展名，`content-length=ref.bytes`；未知 id → 404；未配置 reader → 501。仅供本地验收，沿用既有 Bearer token 认证。

## 23.6 agent 工具 `send_to_user`

- 位置：`packages/agent-app/src/files.ts`，`daemon.start()` 中 `ctx.tools.register(...)` 注册（全局工具，主 agent 与 goal 子代理都可调用）。
- 参数：`{ text?: string, path?: string }`，至少一个；`path` 为工作区相对路径或绝对路径（进程可读即可），`stat` 先查普通文件与大小上限，再 `readFile`，然后 `ctx.attachments.saveFile({data, name: basename})`，最后 `ctx.channels.sendFiles([ref], text)`。
- 返回：`{seq, name, bytes}` 对象；渲染文本“已发送给用户（seq N）：name（N 字节）”。入队失败或无可投槽位作为工具错误返回（模型可见）。
- 自动审查：`send_to_user` 与其他工具一样经 Auto review（不在 `review.exemptTools` 内）；文件大小上限默认 32MiB，可配。
- 不等待 turn 结束，直接进入 outbox；仍按渠道能力分段/markdown 降级；不用于绕过审批/提问。

## 23.7 配置

| 渠道 | 配置键 | 默认 | 说明 |
|---|---|---|---|
| QQ | `inboundImages` | `true` | 下载/转发入站图片 |
| QQ | `inboundImageMaxBytes` | `10485760` | 单张图片下载字节上限 |
| QQ | `inboundImageTimeoutMs` | `15000` | 单张图片下载超时 |
| QQ | `questionButtons` | `true` | M15 用：C2C 提问按钮（与本文件共用安装） |
| local-test | `inboundImageMaxBytes` | `10485760` | 测试图片解码上限（代码默认，无 Nix 键） |
| agent-app | `sendFileMaxBytes` | `33554432` | `send_to_user` 单文件上限 |

Nix/bundle 对应键（M14 部分）：`channel.qqBot.inboundImages`、`channel.qqBot.inboundImageMaxBytes`、`channel.qqBot.inboundImageTimeoutSeconds`（overlay x1000 → `inboundImageTimeoutMs`）、`channel.qqBot.questionButtons`（M15）、`channel.sendFileMaxBytes` → agent-app `sendFileMaxBytes`（env `NOKORIBI_SEND_FILE_MAX_BYTES`）。local-test 无新增 Nix 键。

## 23.8 安全与边界

- driver 只从平台推送的附件 URL 下载（不是用户可控任意 URL 的代理）；仍限定 http(s)、有超时/字节上限，错误只记安全字段（不含 URL/正文）。
- 图片/文件永远经 `ctx.attachments` 内容寻址存储，session/outbox 只保存 opaque `attachmentId`，不保存平台 bearer URL。
- `send_to_user` 的路径解析遵循“工作区相对或绝对（进程可读）”；不做额外目录沙箱（与 fs 工具一致，Auto review 是最后闸门）。
- 不记录正文、图片字节、文件内容到日志。
- 平台限制（明确接受）：QQ 群聊不支持出站文件；被动富媒体是否受 `msg_id/msg_seq` 槽位限制待实测；附件 URL 有效期/rkey 鉴权待真实平台验证。

## 23.9 测试与验收

自动测试（M14 已实现）：

- `packages/channel-core/test/service-media.test.ts`：图片保存→content blocks、图片-only、保存失败降级、能力位拒绝、`sendFiles` 文本+逐文件顺序、文件能力位拒绝。
- `packages/channel-core/test/outbox.test.ts`：files/actionKind 跨 reload 持久化。
- `packages/channel-qq-bot/test/{driver,rest}.test.ts`：入站图片下载/失败 note/禁用配置；C2C 文件上传 body（file_type/srv_send_msg/file_data/file_name）与 `msg_type=7`、群聊文本降级、文件-only 群聊拒绝、上传错误分类；REST 下载字节上限/非 http 拒绝/上传响应。
- `packages/channel-local-test/test/http.test.ts`：图片 base64 验证/400、图片-only、outbound files 元数据、`/v1/attachments/<id>` 字节与 404/401。
- `packages/agent-app/test/files.test.ts`：路径解析/大小上限/保存入队/失败返回。
- `tests/integration/m14-message-media.test.ts`：local-test HTTP 图片→fake agent content；`sendFiles`→outbound 元数据+字节端点。
- `tests/process/m14-message-media.test.ts`：真实 daemon + scripted LLM：入站图片写入 session JSONL（`image` block + `mediaType`）并投影进模型请求；存储失败降级纯文本；QQ 入站图片经 fake WS + 真实下载→模型；`send_to_user` 工作区文件→local-test outbound files + `/v1/attachments` 字节一致。

手工/真实平台门禁（未执行）：

1. QQ C2C 真实入站图片：附件 URL 无鉴权头可下载、大小/超时行为、图片在真实模型路由的投影。
2. QQ C2C 出站文件：`file_type` 映射、`msg_type=7` 是否可带被动 `msg_id/msg_seq`、`file_data` 上限（文档 100MB 级，实际以平台为准）。
3. QQ 群聊富媒体：验证后再决定是否解除 C2C-only 限制。
4. attachments 存储目录与 NixOS 部署（`DSH_HOME/storage/attachments`）在目标机的持久化/清理策略。

## 23.10 实现记录

- 2026-10-30 完成 phase A + phase B 代码与自动测试；上述全部门禁未执行，真实平台验证前 M14 不能标“完整验收通过”。
- 已知偏差：files 以独立 outbox 条目入队（见 23.3 第 3 点）；QQ 群聊出站文件仅文本降级。
