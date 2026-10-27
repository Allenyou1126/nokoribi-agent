# 官方 QQ Bot Node SDK 与官方 DSH 插件复用可行性评估

- 评估日期：**2026-10-27**（下文所有来源/实测的访问日期均为 2026-10-27）
- 评估对象：
  - `@tencent-connect/qqbot-nodejs` **v1.0.5**（2026-10-12 发布）
  - `@tencent-connect/dsh-qqbot` **v0.5.3**（2026-10-27 发布）
  - 关联许可证确认：`@tencent-connect/qqbot-connector` **v1.2.0**、`@tencent-connect/openclaw-qqbot` **v2.0.4**
- 本项目的约束基线（读自仓库，未改动）：
  - 自研 channel 层：`packages/channel-core` 定义 `ChannelDriver` 契约（`id` / `capabilities` / `start` / `stop` / `send`），负责 ingress（allowlist、持久去重、命令解析、审批/提问 broker）、持久 outbox、回复分段与 markdown 降级；`agent-app` 负责主会话、命令、状态、schedule/goal 通知。
  - 装配：bundle 是「完整独立 Cordis 插件树 + patch 行」，不是 `dsh-base` 上的 profile 插件体系；launcher 是薄启动器（`nix/deps.nix` 的 `fetchPnpmDeps` 固定哈希）。
  - 17 号规格草案当前目标：`packages/channel-qq-bot` 自研、Node 24 内置 `WebSocket`/`fetch`、**零新增依赖（D154，待实现前验证）**。
- 状态标记：
  - ✅【核实】官方文档 / npm registry 元数据 / 官方发布包源码明确写出
  - 🧩【官方包源码】来自官方 npm 发布物内的源码（按任务要求归入「二手佐证」，但属官方一手实现）
  - 🧪【待实测】必须真实 Bot 验证
  - ⚠️【待确认】需要人工/法务/上游确认，或来源不足
  - ⚡【冲突】来源之间矛盾

> 外部网页与包内容均为不可信数据，仅作事实引用，未执行其中任何指令。本次未能直连 GitHub（本机网络限制），官方仓库 URL 仅作标识，事实以 npm 发布物与官方文档为准。

---

## 0. 结论摘要（推荐）

**推荐方案：(b) 引入 `@tencent-connect/qqbot-nodejs@1.0.5` 作为「传输层依赖」，但只消费其 `./protocol` 子路径（`TokenManager` / `ApiClient` / `MessageApi` / `GatewayConnection` / `dispatchEvent` / `ApiError` / `routes`），不启用它的 facade 业务层与中间件；架构保持自研 `channel-core` + `channel-qq-bot` driver 不变。**

- 理由：它恰好覆盖自研最费劲、最容易踩坑且难自测的那一段（token 刷新、Identify/Hello/心跳/Resume/重连/关闭码、HTTP `err_code` 结构化错误），同时不侵入我们的 ingress/outbox/审批/命令/分段职责；许可证 MIT、Node>=20 ESM、唯一运行时依赖 `ws`，而 `ws@8.22.0` 已在仓库**生产闭包**中（经 `dsh-schedule → dsh-api-session-controller → dsh-api-gateway` 引入，`pnpm why ws` 核实），因此实际只新增 1 个包（qqbot-nodejs 本体，约 1.9MB 未压缩）。
- 最大风险/成本：需要修订 D154（零新增依赖）并新增一条依赖决策；`pnpm-lock.yaml` + `nix/deps.nix` 的 `fetchPnpmDeps` 哈希要更新；SDK 是 2026 年新包（v1.0.x），需 exact pin + 升级评审；SDK 默认域名（`api.sgroup.qq.com` / `bots.qq.com`）与当前文档（`api.bot.qq.com`）冲突，需要显式配置并实测；**必须由我们显式传 `msg_seq`**（SDK 缺省会自动生成随机 `msg_seq`，at-least-once 重试会变成重复发送）。
- **备选 (a)**：若「零新增依赖」是不可破的约束，自研薄客户端可行（约 400–600 行 + 测试），以 `qq-official-bot-api-facts.md` 为协议依据、以本 SDK 源码（MIT）为对照实现；风险是协议细节漂移与重连/Resume 边界。
- **不推荐 (c)**：官方 `@tencent-connect/dsh-qqbot` **不是 ChannelDriver，而是一套端到端的「QQ agent 应用插件」**（`inject: ['agents']`，自己创建/管理 agent 会话、自己注册命令、自己接管审批/提问、自己做模型路由），与我们的 `channel-core`/`agent-app` 职责重叠而非互补；它不能无损「挂成一行」进现有架构（见 §3）。若用户真正想要的是它的按钮审批/流式/图片理解/文件收发能力，那是一次**架构方向变更**，应另立决策，不应作为 M7 的装配方式。

---

## 1. 评估对象与事实总表

### 1.1 版本 / 许可证 / 平台要求（✅ npm registry 元数据）

| 包 | 最新版本 | 发布时间 | 许可证 | Node | 运行时依赖 | peerDependencies |
|---|---|---|---|---|---|---|
| `@tencent-connect/qqbot-nodejs` | **1.0.5** | 2026-10-12 | **MIT** | `>=20` | `ws ^8.21.0`（+ 可选 peer `mpg123-decoder` / `silk-wasm`，仅语音用） | 无 |
| `@tencent-connect/dsh-qqbot` | **0.5.3** | 2026-10-27 | **MIT** | `>=20.3.0` | `@tencent-connect/qqbot-connector` **1.2.0**、`@tencent-connect/qqbot-nodejs` ^1.0.5、`js-yaml` ^4.1.0、`qrcode` ^1.5.4 | `@deepseek-ai/cordis >=4.0.1`、`dsh-agent`/`dsh-llm`/`dsh-session`/`dsh-user-approval` `>=0.1.0-rc.6`、`schemastery >=3.18.1`、`qqbot-connector 1.2.0` |
| `@tencent-connect/qqbot-connector` | **1.2.0** | 2026-07-07 | **UNLICENSED** ⚠️ | `>=18` | `qrcode-terminal` | 无 |
| `@tencent-connect/openclaw-qqbot` | **2.0.4** | 2026-09-23 | npm 元数据**缺省**；tarball 内 **MIT** | — | — | — |

来源：P1、P3、P5、P6（见 §7）。

### 1.2 许可证澄清（lead 特别要求确认「哪个包 UNLICENSED」）

| 结论 | 证据 |
|---|---|
| **`@tencent-connect/qqbot-connector@1.2.0` 的 license 字段是 `UNLICENSED`，且 tarball 内没有 LICENSE 文件**；它是扫码绑定 SDK（控制台二维码 → 返回 `{appId, appSecret}`）。 | ✅ P5（npm metadata `license: "UNLICENSED"`；包内仅 `dist/ package.json README.md`，无 LICENSE） |
| `@tencent-connect/dsh-qqbot` 自身 **MIT**（npm 字段 + 包内 `LICENSE` 为 "MIT License Copyright (c) 2026 Tencent Connect"），但**硬依赖 UNLICENSED 的 connector**（`dependencies` 与 `peerDependencies` 都写了 1.2.0，且 `dist/setup/binding-service.js` 静态 `import { startQrConnect } from '@tencent-connect/qqbot-connector'`）→ **用 dsh-qqbot 会把 UNLICENSED 包带进安装闭包**。 | ✅ P3、P4 |
| `@tencent-connect/qqbot-nodejs` **MIT**（LICENSE 文件 "MIT License Copyright (c) 2026 Tencent"）。 | ✅ P1、P2 |
| `@tencent-connect/openclaw-qqbot@2.0.4` 的 npm 元数据没有 license 字段，但 tarball 内有 MIT LICENSE（Copyright 2026 sliverp / Tencent Connect）——**元数据与包内容不一致，若复用需向上游确认**。 | 🧩 P6 |
| 结论：**只有选 (c) 才引入 UNLICENSED 依赖**；选 (b)（只用 qqbot-nodejs）不涉及 connector，许可证干净。 | ✅ 由 1.1/1.2 推出 |

### 1.3 维护状态（✅ 发布记录 + CHANGELOG）

| 包 | 观察 |
|---|---|
| qqbot-nodejs | 2026 年新包，CHANGELOG 显示 1.0.0→1.0.5 的持续修复（gateway 快速失败/重连预算、token 刷新、媒体分片、webhook、中间件）；v1.0.5 发布于 2026-10-12。**活跃但年轻**，API 仍在演进（例如 1.0.5 才新增 `disconnected` 事件）。 |
| dsh-qqbot | 发布节奏密集（0.5.0 2026-09-08 → 0.5.3 2026-10-27），功能迭代快；`dsh.compatibility.dshReleases` 只声明验证过 `0.1.0-rc.8`（CLI）与 `0.2.0-rc.2`（Desktop），未包含本仓库 pin 的 `0.2.1-rc.3`。 |

来源：P1、P3、P4（包内 CHANGELOG/README）。

---

## 2. `@tencent-connect/qqbot-nodejs` 评估

### 2.1 包的公开结构（✅ P1/P2）

- `exports` 只有两个入口：
  - `"."`：高层 facade（`QQBot` 类、中间件集合、存储、流式、媒体）——**大而全，含 13 层中间件生态**；
  - **`"./protocol"`**：低层协议原语，注释明确「Most users should consume the high-level QQBot facade… introduced for advanced users who need to compose primitives directly.」
- 包内随 `src/` 发布源码（1.9MB 未压缩 / 301 文件），便于审计与对照实现。
- `./protocol` 实际导出（P2）：`TokenManager`、`ApiClient`、`MessageApi`、`MediaApi`、`ChunkedMediaApi`、`withRetry`/重试策略、`routes`（`messagePath`/`mediaUploadPath`/`gatewayPath`/`interactionPath`…）、`FULL_INTENTS`/`GatewayOp`/`GatewayCloseCode`/`GatewayEvent`/`InteractionType`、`decodeGatewayMessageData`/`dispatchEvent`、`GatewayConnection`（含完整 `GatewayConnectionOptions` 事件回调）、`ReplyLimiter`、`ApiError`、`InboundMessage` 类型、`FileSessionStore`/`JsonlRefIndexStore` 等可选存储。
- `GatewayConnectionOptions`（P2）含 `getAccessToken`、`getGatewayUrl`、`onReady/onResumed/onError/onDisconnected/onMessage/onInteraction/onRawEvent`、`intents`、`reconnect`、`session`（可选持久化）、`handshakeTimeoutMs` —— **可以只把 WS 生命周期交出去、事件仍进我们的回调**，这正是「传输层」边界。
- 实测验证（L1，Node **v24.21.0**）：
  - `npm install @tencent-connect/qqbot-nodejs@1.0.5` 只装 **2 个包**（qqbot-nodejs + ws），`node_modules` 共 **2.1MB**；ESM 导入成功。
  - `FULL_INTENTS = 1174409219`，包含 `1<<25`（GROUP_AND_C2C）与 `1<<26`（INTERACTION）。
  - `dispatchEvent('C2C_MESSAGE_CREATE', d)` → `{action:'message', msg:{kind:'c2c', senderId: d.author.user_openid, messageId: d.id, content, msgIdx, msgType, messageScene, raw}}`。
  - `dispatchEvent('GROUP_AT_MESSAGE_CREATE', d)` → `{kind:'group', senderId: d.author.member_openid, messageId: d.id, groupOpenid: d.group_openid, …}`。
  - `new QQBot({appId, appSecret, baseUrl, tokenBaseUrl})` 可离线构造（不 `start()` 不发网络请求）；`sendText`/`send`/`api.post`/`openStream`/`sendMedia` 等方法存在。
  - `ReplyLimiter` 默认 `{limit:4, ttlMs:3600000}`（**单场景假设，不是群聊 5 次/5 分钟**）。
  - `ApiError` 有 `httpStatus` / `path` / **`bizCode`**（从响应体 `code ?? err_code` 解析）/ `bizMessage` —— 我们的 outbox 错误分类可直接用 `bizCode`。
  - `start()` 语义：`async start()` 一直运行到 transport 结束（`stop()` 同步触发 abort，start 的 Promise 随后 resolve/reject）；所以 driver 里要 `void bot.start().catch(...)` 后台运行，不能 await 阻塞 daemon ready。
  - `messages.ts`：`sendRaw` 若未提供 `msg_seq` 会自动生成 `getNextMsgSeq(msg_id)`（时间+随机，0..65535）；`sendMessage()` 同样自动注入 —— **重试会换 seq → 平台不会再判重复 → 可能重复发消息**。需显式传 `msg_seq`。

### 2.2 与我们 ChannelDriver 职责的映射（重点：只借传输，不借业务）

| channel-core 职责（现状） | 实现位置 | 若选 (b)：谁做 | SDK 是否提供 |
|---|---|---|---|
| 长连接/心跳/Resume/重连/关闭码 | driver | **SDK `GatewayConnection`** | ✅ 完整（含 4004/4008/4009/4913/4914/4915 分类与退避） |
| access_token 获取/缓存/过期前刷新 | driver | **SDK `TokenManager`** | ✅（单飞、后台刷新、5 分钟内提前刷新；地址可配） |
| REST 发送 + `err_code` 解析 | driver | **SDK `ApiClient`/`MessageApi`**（或我们自己的 fetch + SDK 错误解析） | ✅（`ApiError.bizCode`） |
| 入站原始事件 → 归一化字段 | driver | **SDK `dispatchEvent`** 或我们自写（字段已在事实表确认） | ✅（`InboundMessage`/`replyTarget`） |
| allowlist / 持久去重 / 命令 / 审批-提问 broker | channel-core | **仍由 channel-core** | ❌ 不提供（facade 的 `accessPolicy` 等中间件是另一套语义，不要混用） |
| 持久 outbox / at-least-once / 重试退避 / 分段 | channel-core | **仍由 channel-core** | ❌ 不提供（SDK 的 `ReplyLimiter` 只是简单计数） |
| 逐场景被动策略（单聊 60min/4 次、群聊 5min/5 次）、超窗回退主动、`msg_seq` 幂等 | driver | **我们自己实现**（17.5.2 已有设计） | ❌ 不提供（**且缺省自动随机 seq 是坑**） |
| markdown 能力/长度上限/降级 | channel-core + capabilities | **仍由 channel-core**（我们声明 capabilities） | ❌ 不提供（SDK 的 chunker 是 5000 字符朴素切分，不适用） |
| 状态/可观测 | agent-app/channel-core | **仍由我们**（SDK 只给 `disconnected`/`error` 事件） | 部分（连接状态事件） |

### 2.3 集成要点与坑（实现前必须知道的细节）

1. **`msg_seq` 必须显式传**：`send()` 支持 `extra: Record<string, unknown>` 透传（`Object.assign(body, opts.extra)`，在自动注入之前），所以用 `bot.send({target:{scope,targetId,msgId}, msgType:0, content, extra:{msg_seq: n}})`；同一 outbox 条目重试必须复用同一 `msg_seq`，否则平台去重失效（P2 `messages.ts`/`QQBot.ts`，L1）。
2. **facade 的 `custom EventTransport` 选项目前无法把事件交回 facade**：`startCustomTransport()` 只 `await transport.start()`，而 `EventTransport` 接口只有 `start()/stop()`、**不接收任何回调**（回调类型 `EventTransportCallbacks` 由内置 WebSocket/Webhook transport 在构造时接收）→ 不能把它当测试注入点。🧩 需按「fake WS 服务器」或「直接用 protocol 原语」做测试（见 §2.5）。
3. **默认域名与当前文档冲突**：SDK 默认 API base `https://api.sgroup.qq.com`、token base `https://bots.qq.com`；当前官方文档是 `https://api.bot.qq.com`（token 与 REST 都是），而官方 dsh-qqbot 0.5.3 在 bootstrap 里**显式覆盖** `baseUrl`/`tokenBaseUrl` 为 `https://api.bot.qq.com`（可用 `QQBOT_BASE_URL`/`QQBOT_TOKEN_BASE_URL` 环境变量覆盖）。我们应**显式配置**（默认按文档 `api.bot.qq.com`），并🧪实测两个域名。
4. **`intents` 要显式收窄**：默认 `FULL_INTENTS` 含频道/私信/互动等事件；17 号草案只需要 `GROUP_AND_C2C_EVENT (1<<25)`，应显式传 `intents: 1<<25`，避免要求不必要的事件权限（事实表记录：无权限 intent 会导致 WS 4014 断开；`GROUP_AND_C2C` 是否为默认可用权限🧪待实测）。
5. **`markdownSupport` 只影响 `sendText` 自动选 msg_type**；我们如果用 `send()` 显式 `msgType: 2` 则不受影响。
6. **识别/发送字段细节**：facade 的 `SendMessageOptions` 没类型化 `event_id`（`sendRaw` 支持透传），17 号草案只用 `msg_id` 即可；`msg_seq` 同类问题用 `extra` 透传。
7. **版本策略**：仓库现有风格是 exact pin（如 `@deepseek-ai/*` 全部 `0.2.1-rc.3`）。建议 `"@tencent-connect/qqbot-nodejs": "1.0.5"`，升级需 diff CHANGELOG（该包 1.0.x 仍有行为变更）。

### 2.4 依赖 / 构建 / Nix 影响（✅ 仓库事实）

| 事项 | 现状 | 选 (b) 后 |
|---|---|---|
| `ws` | **已在生产闭包**：`pnpm why ws` → `@deepseek-ai/dsh-api-gateway@0.2.1-rc.3 → dsh-api-session-controller → dsh-schedule → … → @nokoribi/bundle`；`pnpm-lock.yaml` 中 `ws@8.22.0` | SDK 声明 `ws ^8.21.0`，现有 8.22.0 已满足；**新增只有 qqbot-nodejs 本体** |
| pnpm-lock | 已提交 | 需更新（新增 importer/package） |
| Nix `pnpmDeps` | `nix/deps.nix` 的 `hash = "sha256-by7QhSQpgQ02KvCC+ZWJgUPkXtkFEn3OzQDxlEUWRiM="` | **必须更新该哈希**（`fetchPnpmDeps` 固定输出）；构建要能访问 npm registry 做 FOD 抓取 |
| 包体积 | 包内 `src`+`dist` 共 1.9MB / 301 文件 | 发行版新增 ~1.9MB（对 Nix 闭包可接受；比 dsh-qqbot 的 8.2MB 小一个量级） |
| 依赖方向 | `channel-qq-bot` 仅依赖 `channel-core` 契约 + 平台 SDK；`bundle` 只装配 | 外部依赖落在新包 `packages/channel-qq-bot` 的 `dependencies`；同时需按现有模式加入 `packages/bundle/package.json`（行解析）与 `packages/launcher/package.json`（安装锚点）⚠️（launcher 目前显式列出所有 runtime 包，新增包是否必须加需实现时验证） |
| 兼容性 | Node 24 ESM、TS strict、`isolatedDeclarations` | SDK 为 ESM + 自带 `.d.ts`，Node>=20；打字面量/导出类型兼容（**实装时验证** `tsc --noEmit`） |

### 2.5 测试可行性（评估结论：可行，且比自研更省测试架）

| 层 | 方案 | 备注 |
|---|---|---|
| 单元 | 直接测我们的映射/策略函数（事件→`InboundMessage`、chatId/scope 解析、被动窗口、错误分类） | 不依赖 SDK |
| 集成（进程内） | 用 `./protocol` 的 `GatewayConnection` 直接注入 `getGatewayUrl`/`getAccessToken`，指向本地 fake **WS 服务器**（`ws` 已是仓库锁内包，可作 devDependency 显式声明）+ fake REST（token/发送）。`GatewayConnectionOptions` 明确提供全部事件回调（P2），无需真 QQ。 | ⚠️ facade 的 custom `EventTransport` 不收回调（§2.3.2），**不要**拿它做注入 |
| 进程级 | 与现有 `test:process` 模式一致：daemon + fake REST/WS 服务器；断言 outbox 字段（`msg_id`/`msg_seq`）、重试、超窗回退 | fake WS 服务器需自己写 identify 握手/事件帧（测试资产） |
| 真实 Bot | 验收清单见 §6 | 需要 AppID/AppSecret + 开发体验用户/自己的群 |

风险：SDK 内部 `GatewayConnection` 直接 `import ws`，测试 WS 服务器必须用 `ws`（或手写 WS server）；在「零新增依赖」约束下，测试专用 devDependency 是否也算破例需要 lead 决策（devDependency 不进发行闭包，但会进 lock 与 Nix 的 pnpm deps 哈希计算范围）。

### 2.6 判定

**技术上完全可以作为传输层依赖**，且边界清晰（`./protocol` 子路径；facade 可不用）。代价是：1 个新运行时依赖 + 1 条决策修订 + lock/Nix 哈希 + 版本维护；收益是省掉约 400–600 行协议实现与对应测试资产，并把「token/WS/Resume/关闭码」的正确性交给官方维护者。**推荐的消费方式是 `./protocol` 原语而不是 facade**（见 §0）。

---

## 3. `@tencent-connect/dsh-qqbot` 评估

### 3.1 它是什么（✅ P3/P4）

- Cordis 插件：`dist/index.js` 导出 `export const name = 'im-qqbot'; export const inject = ['agents']; export const Config = ConfigSchema; export async function apply(ctx, config)`。
- **`package.json` 的 `dsh` 元数据**：`{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"},"compatibility":{"dshReleases":{"0.1.0-rc.8":"compatible","0.2.0-rc.2":"compatible"},…}}` —— 即：它按「DSH 插件」设计：通过 `dsh plugin --profile <name> add` 安装，用 `cordis.patch.yml` 往 **dsh-base** 上插一行，并带一个 **Web/Desktop 客户端半边**（扫码/设置页/侧栏）。
- 它的 `cordis.yml` 是完整「spine 示例」（sessions/agent/agent-loop/system-prompt/approval/tools/agent-presets/attachment-local/llm…），说明它是**自成一体的一套宿主组合**，不是挂在别人 channel 层的 driver。
- README 架构：`QQ 用户 → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM`，`session/event` 回流发送。

### 3.2 它注册/消费哪些 Cordis/DSH 服务（✅ 源码核实 + 🧩 官方包源码）

| 方向 | 服务/事件 | 证据 |
|---|---|---|
| **注册的服务** | **无**（未发现 `ctx.set(`/`ctx.provide`/`Service` 子类；它只作为插件行存在，不对外暴露服务） | 🧩 P4（dist 全量 grep） |
| 必需注入 | `agents`（`inject = ['agents']`） | ✅ P4 dist/index.js |
| 消费（可选/运行时） | `tools`（工具结果展示）、`sessions`、`agentPresets`、`sessionPersistence`（会话持久化）、`compaction`、`llm`（模型发现/视觉）、`webServer`（**可选注入**，用于端内绑定页/设置路由）、`userQuestions`（**直接改写 `uq.ask`**）、`approval/request`（waterfall 全局监听并 prepend） | 🧩 P4 `gateway/bootstrap.js`、`session/session-manager.js`、`features/approval-channel.js`、`features/question-channel.js`、`setup/index.js` |
| 消费事件 | `session/event`（按自己的 sessionId 过滤后出站）、`agent/assistant-stream`（global，流式帧）、`system-prompt/assemble`（注入群历史/引用/附件等上下文） | 🧩 P4 |
| 自建的整套业务 | `SessionManager`：每个 QQ peer 一个 agent session（`agents.create(...)` / `agents.resume(...)` / fork 重建）；`ModelResolver`：per-peer 模型偏好 + `settings.yaml` + host 服务；`commands/`：`/new` `/compact` `/model` `/preset` `/status` `/bot-ping` `/bot-version` `/bot-help` `/stop` 等（走 SDK `slashCommand` 中间件，不走 DSH `ctx.commands`）；`transport/outbound*.js`：turn 结束/流式/交付文件 发送；`transport/reply-limiter.js` + `msgid-cache.js`：被动回复计数与 msgid 缓存（群 5min、单聊 30min）；`features/approval-channel.js`：把 `approval/request` 渲染成 QQ 两按钮审批；`features/question-channel.js`：**monkey-patch `ctx.userQuestions.ask`**，QQ 会话走 QQ 提问；`media/`：图片/视频/文件发送、视觉工具；`setup/`：扫码绑定、凭据持久化到 profile。 | 🧩 P4 |

**关键结论：它没有、也不会去消费 `ctx.channels`**（全量 grep 无 `channels`/`ChannelDriver`/`channel-core` 字样）——它不是我们 channel 架构里的 driver，而是与我们 `channel-core + agent-app` 平级甚至互相替代的另一套「QQ 端到端应用」。

### 3.3 与 Nokoribi 现有架构的冲突/重复（逐项）

| 维度 | Nokoribi 现状 | dsh-qqbot | 冲突后果 |
|---|---|---|---|
| 入口/会话 | `agent-app` 持有唯一主会话（`mainSessionId`），`channel-core.attachRuntime` 把入站喂给主 agent | 自建 `SessionManager`，每个 QQ peer 用 `ctx.agents.create()` 创建**独立 agent session** | QQ 消息进的是「另一个 brain」，与主会话、`/clear`、goal、memory、schedule 语义割裂 |
| 命令 | `channel-core` 注册 `/stop` `/status` `/steer` `/queue` 等，经 `ctx.commands` 执行 | 自带一套 slash 命令（SDK 中间件层），不注册 `ctx.commands` | QQ 上 `/status` 语义不同；主 agent 的命令在 QQ 不可用 |
| 审批/提问 | `channel-core` 的 `InteractionBroker`：文本提示（🔐/❓）、编号应答、FIFO、超时；监听 `approval/request` 与 `user-questions/request` | `ApprovalChannel`：`ctx.on('approval/request', …, {global:true, prepend:true})` → QQ 按钮审批；`QuestionChannel`：**直接改写 `ctx.userQuestions.ask`** | 两套交互链并存：审批可能被两条路径抢答/重复提示；`ask` 被全局 patch 影响所有 agent（非 QQ 会话委托原实现，但这是全局副作用） |
| outbox/重试/去重 | 持久 outbox（`$DSH_HOME/state/outbox.json`）、`ingress-seen.json`、`(1/n)` 分段、markdown 降级 | 自带 `OutboundBuffer`/`chunker`/`msgid-cache`/`reply-limiter`，无我们语义的持久 outbox/allowlist | 双份实现、行为不一致；我们的 schedule/goal 通知仍走 channel-core（QQ 无法收到） |
| 模型路由 | bundle 配置 `provider/model`，agent-app 管理 | `ModelResolver` 读 `settings.yaml`/per-peer 偏好/host `agentDefaultModel` | 两套模型配置入口 |
| Web/客户端 | 无 `webServer` bundle 行（launcher 是 daemon，无 Web UI bundle） | 依赖 DSH Web/Desktop 的插件席位（settings.section/sidebar），扫码绑定/设置页需要 `webServer` | 在 Nokoribi 部署形态下「端内扫码/配置面板」不可用，只剩 env 凭据路径 |
| 准入 | channel-core allowlist（静态 senderId+chatId） | 自带 `accessPolicy`（c2c/group open/allowlist/disabled） | 两套准入，需二选一 |

### 3.4 能否作为「bundle 行」直接挂进本项目？

**技术上可能，但官方支持路径与工程约束都不成立。**

| 检查项 | 结论 | 证据 |
|---|---|---|
| Cordis 行形状 | ✅ 可以写成 `- id: im-qqbot name: '@tencent-connect/dsh-qqbot' config: {...}`（插件导出 name/inject/apply/Config） | P4 |
| DSH 版本兼容 | ⚠️ **不兼容声明**：`peerDependencies` 是 `@deepseek-ai/dsh-agent >=0.1.0-rc.6` 等；本仓库 pin `0.2.1-rc.3`。按 node-semver 规则（prerelease 必须与 comparator 同 `[major,minor,patch]` 才算满足），**实测 `0.2.1-rc.3` 不满足 `>=0.1.0-rc.6`（false）**，也不满足 `>=0.2.0-rc.2`（false）；插件自身 `dsh.compatibility.dshReleases` 只列 `0.1.0-rc.8`/`0.2.0-rc.2` | ✅ L1（semver 7.8.5 实测）；P3 |
| 安装方式 | ⚠️ 它的预期路径是 `dsh plugin --profile qqbot add …`（写 profile 的 `dsh.profile.bundles` + `dsh.bundle.patch` 层）。本仓库 launcher **每次启动原子重写** `$DSH_HOME/run/profile/package.json`（只含 `@nokoribi/bundle`），且安装物里没有 `dsh` CLI；正确挂载需改 launcher/bundle 装配逻辑 | ✅ R4（`packages/launcher/src/index.ts`）、R5（根/launcher package.json 无 `@deepseek-ai/dsh`） |
| 宿主服务 | ⚠️ 需要 `webServer` 才启用端内绑定页/设置路由（`ctx.inject(['webServer'], …)` 可选注入，缺失时不崩）；还需要 `userQuestions`（我们 bundle 有）、`sessions`/`agentPresets`/`sessionPersistence`/`compaction`/`tools`（部分有；`agentPresets` 行**不在**我们 bundle 中 → `/preset` 等能力会降级/失败） | ✅ R3（行清单）、P4 |
| 配置方式 | 凭据可用 env `QQBOT_APPID`/`QQBOT_SECRET`（无 profile 时走 env 分支），但扫码绑定/持久化依赖 profile/客户端 | P4 |
| 装配语义 | ❌ 它不是 driver；挂上后 QQ 流量完全绕过 `channel-core`/`agent-app` 主会话（见 §3.3） | P4 |

### 3.5 若选 (c)：需要改什么、失去什么、得到什么

**要改的规格/决策（粗估）**
- 决策：D150（平台/传输选择）、D151（被动优先+回退）、D152（准入策略）、D154（依赖策略）都要重写/撤销；17 号规格 §17.3（总体设计/状态机）、§17.4（入站映射）、§17.5（出站/消息策略/频控/错误分类）、§17.6（Nix 配置）、§17.7（白名单/安全）、§17.8（测试验收）大部分重写；launcher/bundle 装配需支持「DSH profile 插件」路径（当前是完整独立 bundle 树，不含 dsh-base 与 plugin 管理）。
- Nix：需为 dsh-qqbot 增加配置项/凭据注入/客户端资产，且要携带其依赖闭包（含 UNLICENSED connector）；「纯 Nix 只读配置」语义被插件写 profile 凭据的行为破坏（或需要禁用其绑定/持久化路径）。
- 安全/审批：QQ 侧的审批从「channel-core 文本 broker」变成「dsh-qqbot 自带按钮 + 全局 `approval/request` 监听」，需要重新定义与主 agent/子代理审批的关系；`userQuestions.ask` 被全局 patch 也需要审计。
- 目标可观测性：`/status full`、outbox、schedule 通知、goal 报告在 QQ 侧不可用（除非再写桥接）。

**会失去（相对 17 号草案）**
- 统一 ingress/allowlist/持久去重/outbox/分段/命令/状态；
- 主会话的 `/stop` `/status` `/steer` `/queue`、`/clear` 语义在 QQ 上的一致性；
- 纯 Nix 只读配置 + 单一 `channel-core` 通知出口（schedule/goal/系统通知自动到 QQ）；
- 与本地测试通道同构的测试/验收模式（channel-core 的 fake 驱动/进程测试）；
- 最小依赖与许可证干净（UNLICENSED connector；8.2MB/36 包闭包，见 §3.6）。

**会得到**
- 官方实现的按钮审批/提问（比文本审批体验好）、C2C 流式回复、图片理解/视觉、文件发送、交付物投递、扫码绑定/端内设置面板（需要 DSH Web/Desktop 宿主，本仓库当前没有）；
- 官方持续维护的 QQ 端到端行为（代价是版本/兼容性跟随官方插件的 DSH 版本节奏）。

**结论：选 (c) 不是「挂一行」，而是「用官方插件替换掉为本项目设计的 channel/agent IM 集成」。** 若用户的核心诉求是「最快在 QQ 用上 Nokoribi 的 agent」，它有吸引力；但会推翻 17 号规格与 D150–D154 的大部分设计。建议作为**独立的产品方向决策**，而不是 M7 的实现选择。

### 3.6 许可证与依赖闭包（实测 L1）

- `@tencent-connect/dsh-qqbot@0.5.3` 自身 MIT，但闭包内：
  - `@tencent-connect/qqbot-connector@1.2.0` **UNLICENSED**（§1.2）；
  - `@tencent-connect/qqbot-nodejs@1.0.5` MIT；
  - `js-yaml`（1.0MB）、`qrcode`（232KB）及其依赖链（yargs/y18n/cliui 等）。
- 实测 `npm install --legacy-peer-deps @tencent-connect/dsh-qqbot@0.5.3`：**36 个包、node_modules 8.2MB**（不含 DSH peer 包）；其中 qqbot-nodejs 2.1MB。
- 若走官方安装路径，还要额外安装 DSH 宿主相关包；发行闭包远大于 (b)。

### 3.7 判定

**不推荐作为 M7 的装配方式。** 它能提供的价值主要是「QQ 端到端应用」而非「channel driver」；与本项目架构不可无损组合，且许可证与兼容性有硬伤。最多可考虑：
1. 作为**功能对照/参考实现**（MIT 代码可参考其 chunker/reply-limiter/msgid-cache/按钮审批实现）；
2. 若用户决定「放弃自研 channel 层、改用官方插件」——另立决策重写规格（见 §3.5）。

---

## 4. 三方案对照表（对照本项目约束）

| 维度 | (a) 纯自研零依赖薄客户端（17 号当前计划） | (b) 引入 qqbot-nodejs 作为传输层依赖（**推荐**） | (c) 直接挂 dsh-qqbot |
|---|---|---|---|
| 新增运行时依赖 | **0** | **+1**（qqbot-nodejs；ws 已在闭包） | +36 包 / 8.2MB，含 **UNLICENSED** connector |
| 许可证 | 干净 | MIT 干净 | MIT + UNLICENSED 依赖 ⚠️ |
| Nix 影响 | 无（不必改 `deps.nix` 哈希） | `pnpm-lock` + `nix/deps.nix` 哈希更新 | 同上且闭包更大；需加客户端/配置资产 |
| 与 `ChannelDriver` 契约 | ✅ 原生实现 | ✅ 原生实现（SDK 只在 driver 内） | ❌ 不是 driver，绕过 channel-core |
| 审批/提问/命令/outbox/status | ✅ 全复用 channel-core/agent-app | ✅ 全复用 | ❌ 各自一套，割裂 |
| allowlist/去重/分段 | ✅ channel-core | ✅ channel-core | ❌ 自带另一套语义 |
| 连接/token/重连正确性 | 自己实现（约 400–600 LOC） | 官方实现（成熟度中上） | 官方实现 |
| 协议漂移风险 | 我们追赶 | 官方追赶 + 我们升级 | 官方追赶 + DSH 版本绑定 |
| 可测试性 | 需自建 fake WS/REST；可注入自研 transport | 用 `./protocol` 注入 `getGatewayUrl`/`getAccessToken` + fake WS/REST；**facade custom transport 不可注入** | 官方插件自带流程，难以做我们的单元/进程测试 |
| DSH 版本耦合 | 无 | 无（SDK 与 DSH 无关） | **peer semver 不匹配（实测 false）**，仅声明兼容 rc.8/rc.2 |
| 客户端/Web 依赖 | 无 | 无 | 需要 `webServer`/DSH Web/Desktop 席位 |
| 「M7 做得到」的把握 | 中（工作量大但范围可控） | **高** | 低（等于换架构） |
| 与 17 号规格改动量 | 无（按原计划） | D154 修订 + 依赖/装配清单 | D150–D154 + 17.3–17.8 大改 |
| 最大风险 | Resume/重连/关闭码/权限等边界（可测但费时） | 新依赖治理 + 域名/`msg_seq` 等集成细节 | 架构分裂、UNLICENSED、版本不兼容 |

---

## 5. 推荐与落地要点

### 5.1 推荐：(b) 传输层依赖（`./protocol` 消费），保持自研 channel 架构

落地要点（给 M7 规格/实现的输入，不是实现本身）：

1. 新增决策：**修订 D154** —— 允许新增一个运行时依赖 `@tencent-connect/qqbot-nodejs`（exact pin `1.0.5`），理由、消费边界（只 `./protocol`）、升级策略（diff CHANGELOG + 真实 Bot 回归）写入 03-decision-log；`ws` 说明为「已在生产闭包、由 SDK 带入」。
2. 依赖声明：`packages/channel-qq-bot/package.json` 增加 `@tencent-connect/qqbot-nodejs: "1.0.5"`；同步 `packages/bundle`、`packages/launcher` 的装配清单（按现有模式）；更新 `pnpm-lock.yaml`、`nix/deps.nix` 哈希。
3. driver 内部边界：
   - `QqGatewayClient`（薄封装）持有 `TokenManager` + `ApiClient` + `GatewayConnection`；`GatewayConnection` 的 `onMessage/onInteraction/onReady/onDisconnected` 直接映射到 channel-core 的 `onInbound` 与日志；
   - 发送走 `MessageApi`/`ApiClient`（显式 `msg_seq`；错误读 `ApiError.bizCode` 分类）；
   - **不启用** facade 的中间件/accessPolicy/slashCommand/outbox 语义，避免与 channel-core 重复。
4. 被动策略仍按 17.5.2 自研：单聊 60min/4 次、群聊 5min/5 次（事实表 §6.2），超窗/超次回退主动；`msg_seq` 由我们按 outbox 条目固定。
5. 域名显式配置：默认 `https://api.bot.qq.com`（文档 + 官方 dsh-qqbot 实践），`tokenBaseUrl` 同域；🧪实测 `bots.qq.com`/`api.sgroup.qq.com` 作为备选。
6. 测试：fake REST + fake WS 服务器（`ws` 作为 devDependency 显式声明——它已在锁内；需 lead 确认 devDependency 是否算破 D154 的「零新增依赖」；若不允许，可手写最小 WS server 或用 `node:net` 实现握手/帧，成本更高）。进程级测试保持现有模式。
7. 真实 Bot 验收清单见 §6。

### 5.2 若改为 (a)：自研薄客户端的最小范围

- 组件：`TokenManager`（fetch + 缓存 + 60s 提前刷新 + 单飞）、`GatewayClient`（Node 24 内置 `WebSocket`：Hello/Identify/心跳/ACK 超时/Resume/重连/关闭码）、`RestClient`（fetch + `Authorization: QQBot …` + `err_code` 解析）、事件映射（字段按事实表）、`msg_seq`/被动窗口策略。
- 规模估计：约 400–600 行 + 单测 + fake WS/REST；收益是 0 依赖、无 lock/Nix 哈希改动；风险是 Resume/关闭码/权限等边界要靠真实 Bot 反复验证，且协议变更需自己追。
- 可对照官方 SDK 源码实现（MIT，允许参考/复制，需保留版权声明并记录来源）。

### 5.3 若选 (c)：先回答「是否要换架构」

- 见 §3.5 的改动面/得失；**不建议**在 M7 内做。若要做，建议作为一个独立里程碑（例如 M9「官方插件模式」）并先做一次 spike（真实环境跑通 dsh-qqbot + DSH Web/Desktop，评估与 Nokoribi 主 agent 的关系）。

---

## 6. 必须实测 / 待确认清单

### 6.1 选 (b)/(a) 都必须实测的平台项（来自 `qq-official-bot-api-facts.md` 的重点）

| # | 事项 | 说明 |
|---|---|---|
| 1 | token 端点 & REST base 域名 | `api.bot.qq.com`（文档/官方插件）vs `bots.qq.com`（SDK 默认 token）vs `api.sgroup.qq.com`（SDK 默认 REST）；四个组合实测 |
| 2 | Identify token 与 intents | `token = "QQBot {AccessToken}"`；`intents: 1<<25` 是否需要申请（文档基础事件列表未含 `GROUP_AND_C2C_EVENT`）；无权限时 4014 |
| 3 | 被动回复真实边界 | 单聊 60min/4 次、群聊 5min/5 次；C2C 发送页又写「msg_id 5 分钟内有效」的冲突；超窗错误码（`304103`/`40034005`/`40034128`） |
| 4 | `msg_id + msg_seq` 幂等 | 同 `msg_id`+同 `msg_seq` 重复 → `40054005`；换 seq 是否重复发；outbox at-least-once 重试语义 |
| 5 | 主动消息回退映射 | `40034100`（频控）/`40034105`（无权限）/`40054013`（用户拒收）/`40034101`/`40054003`（非群成员）/`304103` 的实际触发场景 |
| 6 | 文本/markdown 长度上限 | 官方文档无数字；SDK 注释 ~5000、官方 dsh 插件默认 4500；实测逐档（2000/3000/4500/5000/6000） |
| 7 | Markdown 语法范围 | 官方列出的支持格式不含代码块/表格；实测 AI 输出 fenced code/表格是否渲染（影响 capabilities 与降级） |
| 8 | 群事件字段 | `group_openid` 顶层、`content` 去 @ 前缀、`GROUP_MESSAGE_CREATE` 全量模式（本里程碑不做但需记录）；`author.member_openid`/`member_role` |
| 9 | 发送是否要求 WS 在线 | 频道文档明确要求；C2C/群 v2 未写；断 WS 只走 HTTP 实测 |
| 10 | `event_id` 支持 | 17 号只做 `msg_id`；若未来做 `INTERACTION_CREATE`/`GROUP_ADD_ROBOT` 被动回复需实测 `event_id` 是否带前缀 |
| 11 | 入站附件 URL | 鉴权头/有效期（本里程碑丢弃图片但需确认「哪些消息会被判 unsupported-images」） |
| 12 | 连接恢复 | 断线重连是否补发、`RESUMED` 后 seq 语义、关闭码 4004/4008/4009/4913/4914/4915 的 SDK 行为 |
| 13 | token 刷新 | 7200s、临近 60s 换新、旧 token 60s 重叠、刷新失败重试 |
| 14 | 真实 SDK 版本回归 | 用真实 Bot 跑 `qqbot-nodejs` 的 `GatewayConnection` + `dispatchEvent` + `send`，确认与官方文档一致；确认 `1.0.5` 的 `disconnected` 等新行为 |

### 6.2 仅 (b) 需要确认

| # | 事项 |
|---|---|
| B1 | `pnpm install` + `nix build` 在 Nix FOD 环境下能抓取新依赖（本机 npmjs 直连被网络限制，需按仓库/CI 正常 registry 验证） |
| B2 | `packages/channel-qq-bot` 的 TS 编译（TS7 + `isolatedDeclarations`）与 SDK `.d.ts` 兼容 |
| B3 | 「devDependency `ws` 做 fake WS 服务器」是否违反 D154；若违反，改用 `./protocol` + 自写最小 WS server（成本上升） |
| B4 | `launcher`/`bundle` 是否必须显式加新包（安装锚点解析）；按现有模式加后 `nix build` 的 profile 解析通过 |
| B5 | SDK 关闭码/重连策略与我们 outbox 的协同（连接断开时 outbox 应退避而非快速失败） |

### 6.3 仅 (c) 需要确认

| # | 事项 |
|---|---|
| C1 | 与 DSH `0.2.1-rc.3` 的**真实运行**兼容性（peer semver 已实测 false；需实际安装（--legacy-peer-deps / overrides）跑通） |
| C2 | 无 `webServer` 的 Nokoribi daemon 下插件能否仅靠 env 凭据工作（扫码/设置面板功能丧失） |
| C3 | 与现有 `channel-core` 的审批/问答冲突（`approval/request` global prepend、`userQuestions.ask` patch）能否在共享 DSH 树中共存 |
| C4 | UNLICENSED connector 的合规可用性（法务确认；或用 `overrides`/fork 去掉扫码依赖，需评估） |
| C5 | 与 launcher「每次重写 profile package.json」的装配方式如何兼容（需要改 launcher/bundle） |

---

## 7. 证据与来源（访问/实测日期均为 2026-10-27）

### 7.1 npm 包元数据与发布物（官方包；npmjs 直连被本机网络限制，使用 npmmirror 镜像读取同一 npm 元数据）

| ID | 来源 | 用途 |
|---|---|---|
| P1 | <https://registry.npmmirror.com/@tencent-connect/qqbot-nodejs>（v1.0.5，2026-10-12；MIT；engines node>=20；deps ws ^8.21.0） | 版本/许可证/依赖/engines/peer |
| P2 | 同上 `dist.tarball`（`qqbot-nodejs-1.0.5.tgz`）内 `src/`、`README.md`、`USAGE.md`、`CHANGELOG.md`、`LICENSE` | API 面、`./protocol`、`GatewayConnectionOptions`、`ApiError`、`msg_seq` 自动生成、facade/custom transport 行为、`ReplyLimiter`、默认域名 |
| P3 | <https://registry.npmmirror.com/@tencent-connect/dsh-qqbot>（v0.5.3，2026-10-27；MIT；deps/peers；`dsh` 元数据） | 版本/许可证/依赖/peer/`dsh.compatibility` |
| P4 | 同上 tarball（`dsh-qqbot-0.5.3.tgz`）内 `dist/index.js`、`dist/gateway/bootstrap.js`、`dist/gateway/middleware-setup.js`、`dist/features/{approval-channel,question-channel}.js`、`dist/session/session-manager.js`、`dist/config.js`、`cordis.yml`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE` | 插件形状（`name`/`inject`/`apply`）、消费/注册服务、审批/提问实现、会话/命令/模型路由、配置项、安装方式 |
| P5 | <https://registry.npmmirror.com/@tencent-connect/qqbot-connector>（v1.2.0，2026-07-07，license `UNLICENSED`，包内无 LICENSE） | 许可证确认 |
| P6 | <https://registry.npmmirror.com/@tencent-connect/openclaw-qqbot>（v2.0.4，2026-09-23；npm license 缺省；tarball 内 MIT LICENSE） | 许可证一致性备注（非本次选型对象） |

> 官方 GitHub 仓库地址（`https://github.com/tencent-connect/qqbot-nodejs`、`…/dsh-qqbot`）因本机网络无法直连、未直接读取；上述事实均来自官方 npm 发布物。

### 7.2 官方文档（与 `qq-official-bot-api-facts.md` 相同的 wiki 页面，2026-10-27）

- 获取访问凭证：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>
- WebSocket 方式：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html>
- 通用数据结构/opcode/intents：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html>
- 发送单聊/群聊消息：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>、<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- 消息收发概述（被动窗口/主动频控）：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- Markdown：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html>
- 错误码：<https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html>
- Agent 接入（官方插件生态）：<https://bot.q.qq.com/wiki/agent-qqbot/>

### 7.3 仓库内证据（只读，未修改）

| ID | 路径 | 用途 |
|---|---|---|
| R1 | `packages/channel-core/src/{contract,service,broker,outbox,format}.ts` | `ChannelDriver` 契约、ingress/allowlist/去重/命令/broker/outbox/分段/markdown 降级现状；`ChannelService.inject = [agents, commands, approval, userQuestions]` |
| R2 | `packages/agent-app/src/daemon.ts`、`session-bridge.ts` | 主会话、`attachRuntime`、`session/event` 镜像、通知走 `channels` |
| R3 | `packages/bundle/cordis.patch.yml`、`packages/bundle/package.json` | 现有行 id 清单（无 `webServer`/`agentPresets` 行；有 `user-approval`/`user-questions`/`tools`/`sessions` 等） |
| R4 | `packages/launcher/src/index.ts`、`vendor/profile-boot/profile-boot.js` | launcher 用 `loadProfileDirectory` + install anchor；每次启动**原子重写** profile `package.json`（仅 `@nokoribi/bundle`）与空 `cordis.patch.yml`；bundle 层由 `dsh.profile.bundles` 组合 |
| R5 | `package.json`、`packages/*/package.json`、`pnpm-lock.yaml`、`nix/deps.nix`、`nix/package.nix` | DSH 版本 pin（0.2.1-rc.3）、`ws@8.22.0` 在生产闭包（`pnpm why ws`）、`fetchPnpmDeps` 哈希、`pnpm install --prod --offline --frozen-lockfile` |
| R6 | `.spec/04-architecture-and-build.md`、`.spec/06-channel-and-interaction.md`、`.spec/17-qq-official-bot.md`（草案）、`AGENTS.md` | 依赖方向/最小依赖原则、channel 设计、M7 目标与 D149–D156 草案 |

### 7.4 本机实测记录（L1，Node v24.21.0，2026-10-27）

| 实测 | 结果 |
|---|---|
| `npm install --registry=https://registry.npmmirror.com @tencent-connect/qqbot-nodejs@1.0.5` | 成功；安装 2 个包；`node_modules` 2.1MB；ESM 导入成功 |
| `import … from '@tencent-connect/qqbot-nodejs'` / `…/protocol` | 成功；`QQBot`、`FULL_INTENTS`、`GatewayOp`、`GatewayCloseCode`、`ReplyLimiter`、`dispatchEvent`、`TokenManager`、`ApiClient` 均可用 |
| `FULL_INTENTS` | `1174409219`；包含 `1<<25`（GROUP_AND_C2C）与 `1<<26`（INTERACTION） |
| `dispatchEvent('C2C_MESSAGE_CREATE', d)` | `{action:'message', msg:{kind:'c2c', senderId:'uid'(=author.user_openid), messageId:'ROBOT1.0_MSG1', msgIdx:'REF_X==', …}}` |
| `dispatchEvent('GROUP_AT_MESSAGE_CREATE', d)` | `{kind:'group', senderId:'mid'(=author.member_openid), groupOpenid:'gid', messageId:'ROBOT1.0_MSG2', …}` |
| `new QQBot({appId, appSecret, baseUrl, tokenBaseUrl})` | 可离线构造；`messageApi.sendMessage`/`api.post`/`start`/`stop` 均存在；`start()` 运行至 transport 停止，`stop()` 同步 |
| `ReplyLimiter` 默认 | `{limit:4, ttlMs:3600000, ttlHours:1}`（**非**群聊 5 次/5 分钟语义） |
| `ApiError` | 字段 `httpStatus`/`path`/`bizCode`（`code ?? err_code`）/`bizMessage` |
| semver（node-semver 7.8.5） | `satisfies('0.2.1-rc.3','>=0.1.0-rc.6') = false`；`satisfies('0.2.1-rc.3','>=0.2.0-rc.2') = false`；`satisfies('4.0.5','>=4.0.1') = true`；`satisfies('3.18.5','>=3.18.1') = true` |
| `npm install --legacy-peer-deps @tencent-connect/dsh-qqbot@0.5.3` | 成功；**36 个包 / 8.2MB**；闭包含 `qqbot-connector@1.2.0`（UNLICENSED）、`qqbot-nodejs@1.0.5`（MIT）、`js-yaml`、`qrcode` |
| `pnpm why ws`（仓库） | `ws@8.22.0` 经 `@deepseek-ai/dsh-api-gateway → dsh-api-session-controller → dsh-schedule` 进入 `@nokoribi/bundle` 生产闭包 |

---

## 8. 状态标记与本文件的限制

- 本文件只做可行性事实评估与建议，**不含实现代码、未改源码/既有 spec、未提交 git**。
- 「已核实」= 官方文档/npm 元数据/官方发布包源码/仓库代码/本机实测可直接引用的内容；「官方包源码」按任务要求归为二手佐证；「待实测」= 必须真实 QQ Bot 才能确认；「待确认」= 需要 lead/用户/法务决策。
- 未直接抓取 GitHub 仓库（本机网络限制）；npm 镜像读取的是官方发布物内容，若发布物与仓库 main 有差异，以发布物为准（并记录在这里）。
- 所有 URL/版本/时间见 §7；与 `qq-official-bot-api-facts.md` 的平台事实（S1–S41）一致，冲突处已在该文件 §14 记录。
