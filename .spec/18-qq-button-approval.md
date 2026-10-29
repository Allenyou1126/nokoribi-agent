# 18 QQ 官方 Bot 按钮审批（M9）

> 状态：**代码完成（2026-10-29，D165–D167）**；真实平台门禁 #15–#20 与 NixOS 12.14 待执行。需求口径 D166、实现口径 D167；完整平台事实门禁见 18.7。
> M8 的 14 项平台事实门禁尚未执行；M9 的真实平台验收沿用并扩展该门禁，通过前只能标“代码完成”。
> 相关：[17 QQ 官方 Bot](17-qq-official-bot.md)（M8 事实/消息策略/17.8 验收）、[06 渠道与交互](06-channel-and-interaction.md) 6.4/6.5/6.6/6.11、[03 决策记录](03-decision-log.md)、[14 路线图](14-roadmap.md) 14.8/14.9/14.10、[12 NixOS 部署](12-nixos-deployment.md) 12.13/12.14、[13 测试与运维](13-testing-and-ops.md)。
> 调研：[平台事实表](notes/qq-official-bot-api-facts.md) §5.6/§6.5、[事实门禁记录](notes/qq-fact-gate.md)、[官方 SDK/DSH 插件评估](notes/qq-official-sdk-and-dsh-plugin.md)（官方插件两按钮审批仅作 UX 参考）。

## 18.1 需求与范围

M2 的审批/提问目前只能文本完成；M7 已预留通用动作按钮契约与 outbox 持久化（D163），M8 未实现渲染/回调。M9 在 **QQ 单聊**把审批提示改为两个按钮，同时保留文本应答。

### 18.1.1 已确认需求（D166）

| # | 需求 | 口径 |
|---|---|---|
| R1 | 仅“审批”改按钮 | 提问按钮（`ask_user_question`）登记后续（18.9），M9 不做 |
| R2 | 两个按钮 | 「允许一次」→`allowed-once`；「拒绝」→`rejected`；中文固定 |
| R3 | 点击后不补发确认消息 | 不加“已允许/已拒绝”回执；结果依赖 ack 与 agent 正常回复 |
| R4 | 仅单聊启用按钮 | C2C 渲染 keyboard；群聊保持文本审批（群内审批主体/权限不明确） |
| R5 | 保留文本 fallback | `允许`/`拒绝`/`1`/`2` 仍有效；按钮是附加层，不替代文本路径 |
| R6 | 超时仍视为拒绝 | 沿用 M2：approval 超时→`rejected` 并通知 |
| R7 | 不做“始终允许” | DSH `ApprovalOutcome` 仅 `allowed-once`/`rejected`/`cancelled`/`unavailable`，无持久授权语义 |

### 18.1.2 范围

**做**：core 生成/解释 callback actions 并把入站 action 作为审批权威路径；QQ driver 渲染 `keyboard`、订阅互动 intent、应答 `PUT /interactions/{id}`、归一化 `INTERACTION_CREATE`、intent 不可用时降级；local-test 注入点击；env/Nix/bundle 配置；事实门禁 #15–#20。

**不做（非目标）**：提问按钮、群聊按钮、始终允许/持久授权、modal 二次确认、互动类型 12+（快捷菜单/授权等）、消息编辑或撤回按钮、C2C 流式、WebHook、按钮权限（指定用户）、多用户审批、内容审核。均见 18.9。

**里程碑（D165）**：M9 = QQ 按钮审批（本规格）；M10 = host-aware 持久终端 + Web（规格 19）；原 D149 的 M9 = SSH host 顺延、不占 M9/M10 编号。

## 18.2 现状与差距

### 18.2.1 已有基础

| 能力 | 现状 | 位置 |
|---|---|---|
| 按钮契约 | `OutboundAction{id,label,kind,payload?,url?,style?,disabled?}`、`InboundAction{id,payload?,messageId?}`、`InboundMessage.action`、能力位 `outboundActions`/`inboundActions`（缺省 false） | `packages/channel-core/src/contract.ts`、`packages/shared/src/schemas.ts` |
| outbox | `actions` 随条目持久化/重试/重启保留；只附最后一段；deferred 通知/回复丢弃 actions | `packages/channel-core/src/{service,outbox}.ts`（D162/D163） |
| 文本审批 | broker 串行提示、文本解析、超时拒绝、`/stop`/`/clear` 中止、发送失败 fail closed | `packages/channel-core/src/{broker,interaction-format,service}.ts` |
| QQ driver | C2C/群 @ 入站、被动优先、`c2c:`/`group:`、错误分类、频控、health；能力位 `outboundActions:false`/`inboundActions:false` | `packages/channel-qq-bot/src/{driver,normalize}.ts` |
| QQ 传输 | SDK `./protocol`；`intents=1<<25`；`onInteraction` 仅 debug 忽略 | `packages/channel-qq-bot/src/{gateway,rest,transport}.ts` |
| local-test | `POST /v1/inbound` 仅文本；能力位 false；无 action 注入 | `packages/channel-local-test/src/channel.ts` |

平台事实（详见[事实表](notes/qq-official-bot-api-facts.md) §5.6/§6.5）：`INTERACTION_CREATE` 由 `1<<26` 订阅，`d.id` 为互动事件 id；`type=11` 是消息按钮回调；`data.resolved.button_data` 回传按钮 `action.data`；`PUT /interactions/{id}` 以 `{code}` 应答（0 成功/1 失败/4 无权限，同一 id 只能应答一次、超时失效）；`keyboard` 自定义布局、`render_data.label` ≤10 字符、`action.type=1` 回调、`action.permission.type=2` 所有人。真实渲染形态仍 🧪（18.7）。

### 18.2.2 差距

1. **core 无生产者**：broker 不生成 actions；`sendPrompt` 只传 `{text, interactionId}`。
2. **core 不解释 action**：`process()` 忽略 `InboundMessage.action`，无文本回调按 `empty` 丢弃，且会把 fallback 文本当普通消息/命令投给模型。
3. **QQ 不渲染/不应答**：不发 `keyboard`、不订阅 `1<<26`、`onInteraction` 忽略、无 `PUT /interactions/{id}`。
4. **无失效语义**：无 token 映射/清理/“按钮已失效”提示；旧按钮 fallback 可能误批新审批（必须杜绝）。
5. **不可测试/未装配**：local-test 无法注入 action，fake QQ server 无互动事件与 ack；无 `approvalButtons` 配置、Nix 选项、bundle/env 行与门禁。

## 18.3 设计

### 18.3.1 契约与端到端数据流

M9 **不修改 `contract.ts`/`outbox.ts`/`schemas.ts` 的动作字段**（D163 预留足够）；改动在 broker、service、QQ driver/local-test 与配置。

```
approval/request → broker 生成 2 个 callback action（短 token + payload）
→ sendPrompt{text, interactionId, actions} → enqueueInteractionPrompt → outbox(actions 持久化)
→ QQ driver.send(c2c) → POST /v2/users/{openid}/messages {msg_type, keyboard}
→ 用户点击 → WS INTERACTION_CREATE(type=11) → driver 先 PUT /interactions/{id} ack
→ normalize → onInbound → service.process → broker.handleAction（权威，不解释 fallback 文本）
→ allow: allowed-once / deny: rejected / 未知 token: 提示一次“按钮已失效”
```

**callback payload**：`JSON.stringify({k,t})`（约 40 字节 ASCII）。

| 字段 | 值 | 用途 |
|---|---|---|
| `k` | 短 token：`randomBytes(16).toString("base64url")`（22 字符） | broker 内存映射键；不透明、不可猜、一次性 |
| `t` | 文本 fallback：`允许一次`/`拒绝` | 仅日志/归一化文本；**不作审批依据** |

`OutboundAction` 映射：`id=k`、`label=t`、`kind="callback"`、`payload=<JSON>`、`style` 允许=`primary`/拒绝=`danger`；不使用 `url`/`disabled`。token/payload 远小于未知平台上限（门禁 #19）。

### 18.3.2 broker：token、actions 与 action 权威

`InteractionBroker`（`broker.ts`）扩展：`sendPrompt(input:{text, interactionId, actions?})`、`handleAction(action): Promise<boolean>`（true=已消费）。

- **生成**：交互展示（`present()`）时仅 approval 生成 2 个 action 并注册 `token → {interactionId, outcome}`；question 不生成；展示失败按既有 `unavailable` 结算并清理。
- **解析**：`token = JSON.parse(action.payload).k`（payload 缺失/非法时回退 `action.id`，便于 local-test 只传 id）；`t` 不参与决策。
- **结算**：token 命中且目标 interaction 仍是 active approval → `settleApproval` 对应 outcome；两个 token 同时失效。
- **清理**：`finish()` 删除该 `interactionId` 的全部 token（settle/timeout/abort/`/stop`/`/clear`/shutdown 全覆盖）；进程重启后映射为空。
- **幂等**：同 token 二次点击、超时后再点、另一个按钮再点 → `false`；文本 `handleReply` 路径完全不变。
- **authority**：action 存在时只走 `handleAction`，**绝不**把 `t` 当作文本审批答复（防旧按钮误批新审批）。

### 18.3.3 service：ingress 路由与失效处理

`ChannelService.process()`（`service.ts`）顺序：allowlist、持久去重不变（action 消息同样受限/去重，key=`channelId+messageId`）→ runtime 未就绪时与普通消息一样进启动缓冲 → **action 分支（在纯文本空串检查之前）**：

1. 更新 `lastActiveChat`/`onChatActive` → `broker.handleAction(message.action)`。
2. `true`：返回 `{accepted:true}`；不进命令解析、不进模型。
3. `false`：best-effort 向该 chat 发 **“⚠️ 该按钮已失效（审批已处理、已超时或进程重启），请以最新提示为准。”**（沿用 core notice 语义：有被动上下文用被动，否则 active/defer；失败仅 warn）；返回 `{accepted:true}`。
4. **不**调用 `rememberInbound`（保留最近文本入站的被动上下文，避免依赖未实测的 `event_id`）；**不**释放 deferred 通知（补投仍由下一条文本入站触发）。

纯文本路径（空串检查、命令解析、`broker.handleReply`、注入模型）**一行不改**。local-test 通道的 action 注入（18.4.3）走同一分支，供进程测试模拟点击。`enqueueInteractionPrompt(text, interactionId, actions)` 透传 actions；不支持 `outboundActions` 的 driver 由 M7 既有 `selectActions` 丢弃并 warn。core 不感知 `c2c:`/`group:`，因此“仅单聊渲染按钮”由 QQ driver 决定（18.3.4）。

### 18.3.4 QQ driver：intents、ack、归一化与 keyboard

**配置与能力位**：`QqBotConfig.approvalButtons: boolean`（默认 true）；`capabilities.outboundActions = capabilities.inboundActions = approvalButtons && gateway.interactionAvailable()`；其余不变，降级后能力位立即 false。

**intents 与降级**：

| 场景 | 行为 |
|---|---|
| `approvalButtons=false` | `intents=1<<25`；无降级；不订阅互动事件 |
| `approvalButtons=true` | `intents=1<<25 \| 1<<26`；首次 READY 前 `interactionAvailable()=true` |
| 首次 READY 前 `4014`（intent 无权限，SDK 未特判）或 `4914/4915`（SDK `FATAL_CLOSE`；文档语义=下架/封禁 vs SDK 常量名=intent ⚡） | 降级一次：用 `1<<25` 新建 `GatewayConnection` 重连（SDK 实例单次使用）；warn；`health.detail` 追加 `interaction-intent-unavailable`；降级后仍失败走 M8 既有 fatal/重连/告警路径 |
| READY 之后 `4914/4915` | 不降级（READY 已证明 intent 可用，更可能是下架/封禁），按 M8 既有 fatal 行为 |
| 降级后 | 本进程不再恢复 `1<<26`；health detail 可见；文本审批继续 |

实现：`QqGateway` 记录 `everReady`；用 `onDisconnected{code}` 观察 4014，用 `start()` reject 的 `GatewayError{code:"GATEWAY_FATAL_CLOSE",closeCode}` 观察 4914/4915；两阶段各建一个 `GatewayConnection`。`transport.ts` 的 `QqGatewayClient` 增加 `interactionAvailable(): boolean` 与 `start(handler:{onInbound,onInteraction})`。

**ack（先应答，再进 core）**：`QqRestClient` 增加 `ackInteraction(interactionId, code)`（SDK `interactionPath(id)` + `ApiClient.request(token,"PUT",path,{code})`）。driver 收到互动事件先 ack 再交 core ingress；ack 失败只 warn（脱敏），不阻塞合法入站。平台 code 语义为 0 成功/1 无效/4 无权限（🧪 门禁 #18）；M9 只应答 0/1，4 在本链路不使用。

| 事件情况 | ack | 后续 |
|---|---|---|
| `type !== 11`（含 12 快捷菜单等）；或 `type=11` 但 `chat_type !== 2`/`user_openid` 为空 | 1 | 忽略（M9 只支持 C2C，其他类型本不需应答） |
| `type=11`、C2C，`data.resolved.button_data` 缺失/非含 `k` 的 JSON | 1 | 忽略（“未知 payload”在 driver 层截断） |
| `type=11`、C2C、payload 合法 | 0 | 归一化交 core；token 过期由 broker 判定（失效提示在 core 层） |

**`INTERACTION_CREATE` 归一化**（`normalize.ts` 新增 `normalizeInteraction`）：仅 `type=11`+`chat_type=2` 产生入站；`messageId=id`（去重键，`action.messageId` 同值）、`chatId="c2c:"+user_openid`、`senderId=user_openid`、`receivedAt` 沿用 `parseTimestamp`（缺省 now）；`action.payload=data.resolved.button_data`（原样）、`action.id=payload.k`、`text=payload.t`（可空串，action 分支不校验文本）；`data.resolved.button_id`/`message_id` 仅日志，不参与决策。

**keyboard 映射**（driver `buildBody`，仅当 `content.actions` 存在且可渲染）：

| QQ 字段 | 值 |
|---|---|
| `keyboard.content.rows` | 固定 1 行；buttons 按 actions 顺序（允许在前、拒绝在后） |
| `button.id` | `action.id`（token） |
| `render_data.label` / `visited_label` | `action.label`；>10 字符截断并 warn（M9 文案 4/2 字符） |
| `render_data.style` | `primary→4`（蓝底白字）、`danger→3`（白底红字）、其它→`0`；呈现 🧪 门禁 #16 |
| `action.type` / `action.permission.type` | `1`（回调后台） / `2`（所有人；C2C 单用户边界，D167） |
| `action.data` | `action.payload`（JSON 字符串） |

规则：1 行 × 2 按钮（低于未知上限；超限错误 `40034029`）；只渲染 `kind==="callback"`（`link`/`command`/`disabled` 跳过并 debug）；**仅 `c2c:` 附加 keyboard**，`group:` 即使收到 actions 也丢弃（debug）；`msg_type=0`（文本）与 `2`（Markdown）两种 body 都保留 keyboard；Markdown 回退文本（`toTextBody`）与长度截断重试（`truncateBody`）时必须保留 keyboard（现 `toTextBody` 重建 body，需显式带上）。

### 18.3.5 边界与异常

| 情况 | 行为 |
|---|---|
| 点击时无待审批（已拒绝/超时/重启/stop/clear） | token 未命中 → 提示一次“按钮已失效”，不改状态；不做任何 fallback |
| 同一审批两个按钮都点/重复点 | 第一次结算；后续 false → 失效提示（可能紧跟正常结果，可接受噪声） |
| 点击后 ack 失败 | 仅日志；审批仍结算；用户端可能 loading 到平台超时（🧪 门禁 #18） |
| 按钮已发出但 intent 降级/断线 | 点击不产生事件；approval 超时→`rejected`；文本 fallback 可用（键盘无法撤回） |
| prompt outbox 重试/重启 | actions 随条目持久化，重试重发同一 keyboard/token；重启后 prompt 按 M7 `failPendingInteractions` 失效，旧键盘点击→失效提示 |
| 平台拒绝 keyboard（如 `40034029`） | M9 不自动去按钮重发（避免静默降级）；进 outbox 重试/失败；运维用 `approvalButtons=false`（18.9 后置评估） |
| 群聊审批 / deferred 通知 | 群聊不渲染 keyboard、文本审批与 M8 一致；deferred 丢弃 actions（D163 既有），补投不带按钮 |
| `/stop`、`/clear`、shutdown、超长 prompt | broker abort 清理 token，之后点击均失效提示；文本分段不变，actions 只附最后一段（M7 既有） |

## 18.4 配置与装配

### 18.4.1 配置项

| 层 | 键 | 默认 | 说明 |
|---|---|---|---|
| driver config | `approvalButtons: boolean` | `true` | 仅控制按钮渲染/订阅/ack；文本审批始终可用 |
| env（bundle/开发） | `NOKORIBI_QQ_BOT_APPROVAL_BUTTONS` | `true` | `(env ?? 'true') === 'true'`，非法值按关闭（保守） |
| NixOS | `channel.qqBot.approvalButtons` | `true` | overlay 写入该行 config |
| local-test | `POST /v1/inbound` 的 `action` | 无 | 仅测试通道，见 18.4.3 |

默认开启理由：平台已对所有机器人开放消息按钮（✅ FAQ S32），intent 不可用可自动降级文本；失败面是“按钮不出现/点击无效”，不是审批不可用。真实门禁通过前可随时关闭。

### 18.4.2 bundle / launcher / NixOS

- `packages/bundle/cordis.patch.yml` 的 `nokoribi-channel-qq-bot` 行新增 `approvalButtons: !!js (process.env.NOKORIBI_QQ_BOT_APPROVAL_BUTTONS ?? 'true') === 'true'`（放 `activeMessageFallback` 后）；`.env.example` QQ 段增加同名注释项；`packages/launcher/src/index.ts` helpText 增加一行。
- `nix/module.nix` 的 `channel.qqBot` 增加 `approvalButtons = mkOption { type = types.bool; default = true; description = "..."; }`（无新 assertion）；`qqBot.enable && approvalButtons` 增加 warning：“按钮仅单聊；INTERACTION intent 可用性未真实门禁，不可用时自动降级文本（channel health detail）”。
- `nix/overlay.nix` 的 `channelQqBot` 增加 `approvalButtons = cfg.channel.qqBot.approvalButtons;`；`nix/check-module.py` 的 `expected_qq_bot` 增加 `"approvalButtons": True`（行顺序断言不变）；`nix/tests.nix` 无需改动。
- **不新增 npm 依赖**：SDK 1.0.5 已导出 `interactionPath`、`InteractionEvent`、`KeyboardButton`、`InlineKeyboard`；`pnpm-lock.yaml`/`nix/deps.nix` 不变。
- 文档回写：`12` 选项表/12.14、`13` 测试矩阵与 M9 落点、`14` M9 记录、`17` 后置/17.10、`06` 6.11、`15.3/15.4`、`16` 索引、README（实现阶段提交，不在本规格文件内）。

### 18.4.3 local-test 注入

`packages/channel-local-test/src/channel.ts`：能力位改为 `outboundActions:true`、`inboundActions:true`（代码注释写明测试通道允许 action-only 注入，生产 driver 仍要求 text fallback）；`POST /v1/inbound` 增加可选 `action:{id,payload?,messageId?}`（`id` 非空、`text` 可缺省，无 action 时仍要求非空 `text`，action 非法→400）；`GET /v1/outbound` 投影新增可选 `actions`（仅存在时返回）供测试断言“提示带按钮”，既有字段不变。

## 18.5 安全与风险

- 互动事件只能由平台 WebSocket 投递（无公网 HTTP 入口），与消息事件同一信任边界；准入仍由平台 + `trustedChannels` + Auto review 承担（D152），M9 不新增身份/授权模型。
- 按钮只在 C2C 渲染：可见范围是单个 `user_openid` 对话；群成员看不到按钮，也不会因点击驱动审批。payload 只含 token 与中文 label，不含工具名/命令等敏感信息。
- token 128-bit 随机、一次性、仅存 broker 内存；settle/timeout/abort/重启即失效。**旧按钮不能批准新审批**：action 路径不解释 fallback 文本，未命中 token 只提示失效，堵住“点历史按钮→旧 fallback 被当当前答复”的误批路径。
- ack 不改变授权结论（只结束客户端 loading）；`cancelled`/`unavailable` 不可能由按钮产生（只有 `allowed-once`/`rejected`）。

| 风险 | 等级 | 缓解 |
|---|---|---|
| INTERACTION intent 需权限/不可用（4014/4914/4915 语义冲突 ⚡） | 中高 | 自动降级文本 + health detail + 日志；门禁 #15；真封禁降级后仍失败会告警，不静默 |
| keyboard 渲染/intent 订阅未实测 | 中高 | 门禁 #15/#16/#19；`approvalButtons` 开关；文本 fallback 兜底 |
| ack 语义与超时窗口未实测 | 中 | 门禁 #18；ack 失败仅日志，不阻塞审批结算 |
| 按钮发出后 intent 降级/断线，点击无响应 | 中 | 60s 超时拒绝 + 文本 fallback；观察 health |
| 重复点击产生失效提示噪声 | 低 | 每次事件最多一条；不影响状态 |
| keyboard 被拒导致审批提示发送失败 | 低中 | 门禁 #19；运维关闭开关；18.9 评估“去按钮重发” |
| 群聊无按钮 / fallback 文本仍可误答（用户主动发送） | 低 / 已接受 | 产品已确认（D166）；M2 既有语义，串行 + 超时兜底，无新增面 |

实现阶段把上述条目追加到 [15.3/15.4](15-verification-and-risks.md)（“M9 按钮审批”一组），真实门禁后更新结论。

## 18.6 测试与验收

### 18.6.1 单元

- **broker**（`packages/channel-core/test/broker.test.ts`）：approval 生成 2 个 callback action（question 不生成）、payload/id/style 正确；`handleAction` 命中→`allowed-once`/`rejected`；未知 token/非法 payload/重复点击→false；timeout/abort/`abortAll`/prompt 失败后 token 清理；文本 `handleReply` 回归。
- **service action 路由**（新增 `packages/channel-core/test/service-action.test.ts` 或集成层）：action 在空串检查前路由、不解释 `t`、不更新被动上下文、不释放 deferred、失效提示一条、返回 `accepted`。
- **QQ**（`packages/channel-qq-bot/test/`）：`normalizeInteraction`（type/chat_type/payload 缺失/字段映射/时间解析）；keyboard body（C2C 附加、群聊不附加、Markdown/文本都保留、`toTextBody`/截断保留、非 callback/disabled 跳过、label 截断）；ack 调用与失败容错；intent 降级（4014 与 4914/4915、READY 后不降级、capabilities/health）；config 默认值与 schema。
- **local-test**（`packages/channel-local-test/test/http.test.ts`）：action 注入（含 action-only）、非法 action 400、能力位、`/v1/outbound` actions 投影。

### 18.6.2 集成与进程级

- 新增 `tests/integration/m9-qq-buttons.test.ts`（`dsh-agent-loop-testkit` + `ChannelService` + 真实 `QqBotDriver` + fake transport）：C2C 审批提示带 actions；模拟 interaction（走 driver `onInteraction`）→ ack 0 → 允许/拒绝结算；未知 token→失效提示且不执行；群聊提示无 keyboard 但文本可审批；intent 降级后不渲染；文本 fallback 回归。若既有断言精确匹配 outbox actions，同步更新 `tests/integration/m7-channel-routing.test.ts`、M2 child 审批签名。
- 扩展 `tests/process/support/fake-qq-bot.ts`（WS 推送 `INTERACTION_CREATE`、记录 `PUT /interactions/{id}` 的 method/path/body、`pushInteraction()`）；新增 `tests/process/m9-qq-buttons.test.ts`：① C2C 触发 Auto review deny → QQ 收到带 `keyboard` 的 prompt → 注入 interaction（payload 取自 prompt actions）→ `PUT ... {code:0}` → 工具执行一次（拒绝分支失败），且**没有**“已允许”确认消息；② 文本 fallback（直接发 `允许`）→ 执行；③ daemon 重启后点旧按钮 → ack 0 + 一条“按钮已失效”、工具不执行；④ 群聊审批 prompt 无 keyboard、文本 `1` 完成审批；⑤ fake gateway 在 READY 前用 4014 关闭 → 第二次 Identify 不含 `1<<26` → 服务 ready、health detail 可见、文本审批可用；⑥ M8 的 10 个进程场景不退化。

### 18.6.3 门禁命令与验收边界

| 命令 | 范围 |
|---|---|
| `pnpm check` | 每个提交：格式化/lint/类型 |
| `pnpm test` | 全量单元 + 集成 |
| `pnpm test:unit` | flake `unit` 的 package-only 入口（新增单测须通过） |
| `pnpm test:process` | 进程级（新增 m9 + M8 回归） |
| `nix flake check` | package/unit/package-smoke/module-eval（Nix 选项/overlay 断言） |

- 自动化（fake WS/REST + fake LLM + fake reviewer）通过只代表 **“代码完成”**。
- M8 的 14 项平台事实门禁尚未执行；M9 真实平台验收 = 14 项 + 18.7 的 #15–#20，需 AppID/ClientSecret/开发体验用户/自己的群，由用户执行并记录到 [notes/qq-fact-gate.md](notes/qq-fact-gate.md)；目标机 NixOS 12.14 验收同样待执行，当前 Arch 开发机不能替代。

## 18.7 平台事实门禁

以下 **候选 #15–#20** 已由 Lead 在落盘时追加到 [notes/qq-fact-gate.md](notes/qq-fact-gate.md)（本规格给出口径；实测后回填结果），全部标“待真实 Bot 实测”。

| # | 待验证事实 | 验证方式 | 影响 |
|---|---|---|---|
| 15 | `INTERACTION (1<<26)`：`1<<25\|1<<26` 能否 READY；未授权时是 4014 还是 4914/4915；降级后 `1<<25` 是否正常 | 探针用两种 intents 连接，记录 READY/关闭码/重试 | intent 降级与默认配置（🧪） |
| 16 | C2C 文本（msg_type=0）与 Markdown（2）上的 keyboard 渲染：是否显示、label/style/permission 是否生效、Markdown 是否吞按钮 | 真实单聊两种 body + 客户端观察 | keyboard body/style（🧪） |
| 17 | `INTERACTION_CREATE` 真实字段：type=11、chat_type、scene、`user_openid`、`button_data` 是否原样回传、`button_id`/`message_id`；重复/多次点击推送形态 | 探针订阅并记录事件（脱敏） | 归一化/payload 解析（🧪） |
| 18 | `PUT /interactions/{id}` 语义：code 0/1/4、HTTP/业务码、应答超时窗口、同一 id 重复应答、ack 与发消息先后；`event_id` 被动回复是否需 `INTERACTION_CREATE:` 前缀 | 真实点击 + 手工构造 ack 顺序 | ack 顺序、18.9 的 event_id 方案（🧪） |
| 19 | button data 长度/行数/按钮数上限：`action.data` 字符/字节上限、label >10 字符行为、行/按钮上限、`40034029` 触发条件、`visited_label` 是否必填 | 逐级构造 2/多按钮、超长 label/data | token/payload 长度与截断（🧪） |
| 20 | 群聊按钮关闭行为：不渲染 keyboard 时群聊发送是否完全等同 M8；若发送 keyboard 平台是否接受（仅记录，不启用） | 群聊发文本+keyboard 观察事件/渲染 | 群聊保持文本的确认（🧪） |

**门禁失败时的降级**：#15 intent 不可用→自动降级文本（已设计），能力位 false + health detail；#16 keyboard 不渲染→关闭 `approvalButtons` 默认值或实测通过后开启，文本审批不受影响；#17 payload 未回传→评估 `button_id` 兜底（token 作 button id）或关闭按钮，不回退文本解释；#18 ack 语义不同→调整 ack 顺序/码值，ack 失败仍不阻塞结算；#19 长度/数量限制→收紧 token/payload/按钮数，超限直接不发 keyboard；#20 群聊行为异常→保持不渲染（不影响）。

**探针扩展（候选）**：`packages/channel-qq-bot/scripts/qq-fact-gate.mjs` 增加 `--interaction-connect`（两种 intents 对比）、`--keyboard`（单聊文本/Markdown + 按钮）、`--watch-interaction`（记录事件摘要）、`--ack <id> <code>`（验证 PUT 语义）；只打印摘要，不打印 token/secret/正文。

## 18.8 实现阶段与文件级清单

**阶段**：**P9a（core）** broker token/actions/`handleAction`/清理 + service action 分支/`sendPrompt` 传 actions/失效提示 + 单测（纯文本路径行为不变，独立提交）；**P9b（QQ driver）** `config.approvalButtons`、gateway intents/降级/`interactionAvailable`、`rest.ackInteraction`、transport 接口、`normalizeInteraction`、driver keyboard/C2C 过滤/ack 顺序 + 单测；**P9c（local-test + 测试）** 能力位/action 注入/outbound 投影、集成/进程测试、fake QQ server 扩展、M8 回归；**P9d（配置/Nix/文档）** bundle、`.env.example`、launcher helpText、NixOS option/overlay/check-module/warning、`03/06/12/13/14/15/16/17/README` 与门禁记录回写。

| 阶段 | 文件 | 变更 |
|---|---|---|
| P9a | `packages/channel-core/src/broker.ts`、`service.ts` | token 映射/actions 生成/`handleAction`/清理；action ingress 分支/失效提示/传 actions |
| P9a | `packages/channel-core/test/broker.test.ts`、`packages/channel-core/test/service-action.test.ts`（新） | 单测 |
| P9b | `packages/channel-qq-bot/src/{config,index}.ts`、`{gateway,rest,transport}.ts`、`{normalize,driver}.ts` | `approvalButtons`；intents/降级/health；ack；接口；归一化；keyboard/C2C 过滤/ack 顺序 |
| P9b | `packages/channel-qq-bot/test/{config,gateway,rest,normalize,driver}.test.ts` | 单测（fake transport） |
| P9c | `packages/channel-local-test/src/channel.ts`、`packages/channel-local-test/test/http.test.ts` | 能力位、action 注入、outbound actions |
| P9c | `tests/integration/m9-qq-buttons.test.ts`（新）、`tests/process/support/fake-qq-bot.ts`、`tests/process/m9-qq-buttons.test.ts`（新）、`tests/integration/m7-channel-routing.test.ts`（如需） | 集成/进程级 |
| P9d | `packages/bundle/cordis.patch.yml`、`.env.example`、`packages/launcher/src/index.ts`、`nix/{module.nix,overlay.nix,check-module.py}`、`packages/channel-qq-bot/scripts/qq-fact-gate.mjs` | 配置/装配/探针 |
| P9d | `.spec/{03,06,12,13,14,15,16,17}.md`、`README.md`、`.spec/notes/qq-fact-gate.md` | 回写（实现阶段） |

**依赖、提交与完成定义**：不新增 npm 依赖，不改 `pnpm-lock.yaml`/`nix/deps.nix`；提交拆分（Conventional Commits，末尾 `Assisted-By:`）建议 ① `feat(channel): route approval actions through the broker` ② `feat(channel-qq-bot): render and acknowledge C2C approval buttons` ③ `test(channel): cover QQ button approval end to end` ④ `chore(nix,docs): wire approval buttons and record M9`；每个提交 `pnpm check`，P9c 后 `pnpm test`/`pnpm test:process`，P9d 后 `nix flake check`。完成定义：自动化门禁通过 + 未偏离本规格 + **真实平台门禁 #15–#20 / 12.14 记录后**才可称 M9 验收完成；未执行前只能称“代码完成”，不得宣称按钮在真实 QQ 可用。实现偏离（ack 顺序、降级条件、payload 形态等）必须回写本规格与 D167。

## 18.9 未决与后置

| 项 | 状态 | 说明 |
|---|---|---|
| 提问按钮 | 后置（D166 登记） | 多步/多选/自定义文本的状态机需单独设计 |
| 群聊按钮 | 后置 | 群内审批主体/权限不明确（D152）；M9 只做 C2C |
| “始终允许”/持久授权 / modal 二次确认 | 不做 / 后置 | DSH `ApprovalOutcome` 无持久授权语义；高危操作二次确认（≤40 字符）未纳入 |
| 消息编辑/按钮 visited 状态/点击后改原消息 | 未确认 | 平台是否支持编辑机器人消息未验证；M9 不依赖 |
| `event_id` 被动回复（INTERACTION_CREATE） | 门禁 #18 后评估 | 若可用，可替代 M9“点击不覆盖被动上下文”的保守方案 |
| keyboard 被拒时自动去按钮重发 | 门禁 #19 后评估 | M9 选择显式失败 + 配置关闭，避免静默降级 |
| 互动类型 12+（快捷菜单/授权/反馈） | 不做 | 只处理 type=11 |
| 按钮文案 i18n / 通知消息带按钮 / 多待审批并行展示 | 不做 | 固定中文；M9 只服务审批且 deferred 补投不带按钮（D163）；沿用 broker 串行 |
| C2C 流式 | 后置 | 与按钮审批无耦合 |

## 18.10 决策映射（D165/D166/D167）

| 决策 | 内容 | 落地章节 |
|---|---|---|
| D165 | 里程碑插入/排期：M9 = QQ 按钮审批（规格 18）；M10 = host-aware 持久终端 + Web（规格 19）；原 D149 的 M9 = SSH host 顺延、不占 M9/M10 编号（后置，未分配新编号） | 18.1.2、18.8 |
| D166 | 按钮范围/UX：仅审批改按钮（提问后置）；两按钮「允许一次」「拒绝」；点击后不补发确认；仅单聊；保留文本 fallback（允许/拒绝/1/2）；超时=拒绝；不做“始终允许” | 18.1.1、18.3、18.9 |
| D167 | 动作回调实现口径：core 生成 actions（短 token、payload `{k,t}`、broker 映射与清理）；入站 action 权威、未知/过期只提示失效不回退；QQ driver 先 ack 再 ingress；C2C-only keyboard + `action.type=1/data/permission`；`INTERACTION_CREATE` 归一化（type=11、chat_type=2、`c2c:`）；intents `1<<25\|1<<26` + 降级；local-test 注入；outbox actions 保留、deferred 丢弃；配置/装配；门禁 #15–#20；测试与验收；P9a–P9d；真实平台边界 | 18.3–18.8 |

**被取代/关联**：D163 的“M7/M8 不实现按钮渲染/回调/审批”由 D166/D167 在 M9 范围取代（契约与 outbox 字段继续有效）；D149 的“M9 = SSH host”由 D165 顺延；两项均已由 Lead 登记到 `03`/`16`。**开放项**（18.9）不阻塞 M9 自动化实现；真实平台门禁与目标机部署仍按 18.6.3 执行。

## 18.11 实现记录（2026-10-29）

- 已落地 P9a–P9d：broker 为审批生成 2 个 callback action（`randomBytes(16).toString("base64url")`，payload `{"k","t"}`）并维护 token→outcome 内存映射；`handleAction` 以 payload token 为唯一权威，settle/timeout/abort/prompt 失败统一清理；reprompt 复用同一对 token，不生成第二批。
- service 在 runtime 就绪后、空文本检查前处理 action：action-only 消息被接受；不调用 `rememberInbound`、不释放 deferred、不进入命令/模型；未知 token 通过“被动优先→active→defer”发送一条失效提示，绝不回退 fallback 文本。
- QQ driver：`approvalButtons`（默认 true）；`outboundActions`/`inboundActions` 动态为 `approvalButtons && gateway.interactionAvailable()`；C2C 1 行最多 2 个 callback 按钮（label 截断 10 字符、primary→4/danger→3、`action.type=1`、`permission.type=2`）；群聊剥离 actions；markdown 回退与长度截断保留 keyboard。
- gateway：默认 intents `1<<25|1<<26`；首次 READY 前 4014/4914/4915 降级一次为 `1<<25` 新建连接，`health.detail` 持久标记 `interaction-intent-unavailable`，之后不再恢复；READY 后关闭不降级。
- interaction：`normalize.ts` 新增 `parseInteractionButtonData`/`interactionAckCode`/`normalizeInteraction`；driver 先 `PUT /interactions/{id}`（0/1）再 ingress，ack 失败仅 warn；仅 type=11、chat_type=2、有效 token 产生 `InboundMessage.action`，`messageId=event.id`。
- local-test：能力位打开、`POST /v1/inbound` 支持 action/action-only、`GET /v1/outbound` 投影 actions；bundle/env/launcher/NixOS 增加 `approvalButtons`；探针增加 interaction/keyboard/ack 模式。
- 验证：`pnpm check`；`pnpm test` 54 文件/403 测试；`pnpm test:unit` 50 文件/383 测试；`pnpm test:process` 8 文件/58 场景（M9 6 场景 + M8 10 场景回归）；`nix flake check` 通过。真实平台 #15–#20 与 12.14 尚未执行，因此只标“代码完成”。
- 实现澄清（不改变 D166/D167 语义）：审批提示只在首次展示时生成 token，reprompt 复用；keyboard 最多 2 个按钮；action 失效提示定向到 action 所在 chat，不按 turn/lastActive 重路由。
