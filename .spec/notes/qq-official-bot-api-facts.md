# QQ 官方 Bot v2 API 事实表（Nokoribi Agent IM 适配调研）

- 调研日期：**2026-10-27**（下文所有来源的访问日期均为 2026-10-27）
- 调研范围：QQ 开放平台 Bot v2（单聊 C2C + 群聊，不覆盖频道/Guild 的完整能力，只在影响设计处提及）
- 用途：为下一阶段「真实 IM 适配器（QQ 官方 Bot）」的规格与决策提供可追溯事实；**不含实现决策**
- 方法：优先读官方文档（`bot.q.qq.com/wiki`，镜像 `bot.qq.com/wiki` 同构）；官方文档缺失处用**官方 npm SDK / 官方插件源码**交叉验证并标注；第三方来源单独标注「二手」
- 状态标记：
  - ✅【核实】官方文档明确写出
  - 🧩【SDK】来自官方 SDK / 官方插件源码（属实现依据，仍按任务要求标为「二手佐证」）
  - ⚠️【待核实】来源存在但不充分 / 仅单一来源 / 需管理端确认
  - ⚡【冲突】不同来源矛盾，已列矛盾点与暂时取舍
  - 🧪【待实测】必须用真实 Bot 实测，本轮无法定论

> 阅读提醒：本文件只记录事实与矛盾，**未写代码、未改其它文件、未提交 git**。文末 §16 为来源清单（S1–S41），§17 为访问失败与文档变更记录。

---

## 0. 一句话摘要（供 lead 快速判断）

QQ Bot v2 的协议面足够做一个「零框架依赖的轻客户端」，但**官方已经提供了 MIT 的 Node SDK `@tencent-connect/qqbot-nodejs`（v1.0.5，2026-10-12，运行时仅依赖 `ws`）**，并且官方还发布了 DSH 的 QQ 插件 `@tencent-connect/dsh-qqbot`（v0.5.3，2026-10-27，MIT）。因此「是否零依赖自研」更多是**集成方式选择**（复用 SDK / 自写 WS+HTTP / 借鉴官方插件模式），不是能力缺失问题。

协议层关键事实速览：

1. 凭证：`POST /app/getAppAccessToken`，`access_token` 生命周期 **7200s**，到期前 60s 内再次获取会换新（旧 token 仍有 60s 重叠有效）。鉴权头 `Authorization: QQBot {ACCESS_TOKEN}`。
2. WS Identify：`token = "QQBot {AccessToken}"`（**不是** 旧文档的 `Bot {appid}.{app_token}`，后者是已废弃 Token 体系）。
3. 单聊发送：`POST /v2/users/{user_openid}/messages`；群聊：`POST /v2/groups/{group_openid}/messages`；两者接口频控均为 **100 QPS**。
4. 被动回复窗口：单聊 **60 分钟 / 同一消息最多 4 次**；群聊 **5 分钟 / 最多 5 次**（但 C2C 发送页另写「5 分钟内有效」，⚡冲突，详见 §6.2）。
5. 入站事件：`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE`（全量群消息，需群主开权限），intent 均为 `GROUP_AND_C2C_EVENT (1<<25)`；群 `group_openid` 在**事件体顶层**。
6. 文本长度上限官方文档未写；官方 SDK 注释与常量取 **~5000 字符**，官方 dsh 插件默认切分 **4500**；第三方多称 2000。⚡冲突 + 🧪待实测。
7. Markdown：**2026-04-23 起单聊/群聊自定义 Markdown 对所有机器人开放，无需模板/无需申请**（频道仍需内邀）；`template_id` 在新发送接口 schema 中已标「已废弃」。
8. 主动消息：有配额与开关；错误码可区分「频控 / 无权限 / 用户拒收 / 被动超窗 / 去重 / 超长」，可据此实现被动→主动回退。
9. 附件：入站 `attachments[].url` 自带 `rkey`；官方文档未说需要额外鉴权头，官方 dsh 插件用**裸 HTTPS GET** 下载（URL 有效期未公开，🧪待实测）。
10. 准入：企业主体已可公开使用；个人主体**不支持公开使用**，只能加到自己任群主/管理员的群 + 配置「开发体验用户」私聊。

---

## 1. 账号与 ID 体系

| 事实 | 状态 | 来源 |
|---|---|---|
| 创建机器人后得到 **AppID / AppSecret**；另有旧的 **Bot Token** 字段，官方明确「Token 的鉴权方式已废弃，请使用 Access Token 鉴权」。 | ✅ | S1 |
| AppSecret 用途：换取 `access_token`（文档在启动接入页写「用于 oauth 场景请求签名」，实际换取 token 用；以 access-token 页面为准）。 | ✅ | S1, S2 |
| 用户/群在 v2 接口中以 **openid** 形式出现：单聊用 `user_openid`，群聊用 `member_openid`（群成员）+ `group_openid`（群）；另有 `union_openid`（跨应用统一用户 OpenID，可能为空，需邮件申请绑定）。 | ✅ | S9, S10, S32 |
| `union_openid` 绑定需邮件申请，且要求 QQ 互联 APPID 主体与机器人同一主体。 | ✅ | S32 |
| 不同 Bot（AppID）之间的 openid 体系不同（官方「唯一身份机制」章节，api-call-guide 有该节）。 | ✅ | S3 |

来源：
- S1 <https://bot.q.qq.com/wiki/develop/api-v2/>（2026-10-27）
- S2 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>（2026-10-27）
- S3 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html>（2026-10-27）
- S9 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html>（2026-10-27）
- S10 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html>（2026-10-27）
- S32 <https://bot.q.qq.com/wiki/bot_FAQ/>（2026-10-27）

---

## 2. access_token（获取 / 刷新 / 鉴权）

| 事实 | 状态 | 来源 |
|---|---|---|
| 换取接口：`POST https://api.bot.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`。 | ✅ | S2 |
| 返回：`access_token`（string）、`expires_in`（number，**目前是 7200 秒之内的值**）。 | ✅ | S2 |
| 失败时 **HTTP 仍返回 200**，业务错误在响应体 `code`；不要依赖 HTTP 状态码或 `message` 文案判断失败。 | ✅ | S2 |
| 业务错误码（token 接口）：`100001` Too many requests；`100007` appid invalid（含机器人被封禁/删除）；`100016` invalid appid or secret；`10004` 机器人不存在。 | ✅ | S2 |
| 生命周期默认 **7200s（2 小时）**，需自行刷新；有效期内重复获取返回**相同值**；**临近过期 60 秒内**再获取会得到新 token，旧 token 在这 60 秒内仍有效。 | ✅ | S2 |
| 建议服务端定时刷新凭证。 | ✅ | S2 |
| 请求头：`Authorization: QQBot ACCESS_TOKEN`（注意是 `QQBot ` 前缀 + 空格）。 | ✅ | S2, S3 |
| 官方 SDK 的 token 实现：token 端点默认 `https://bots.qq.com`（非文档写的 `api.bot.qq.com`），提前 5 分钟后台刷新、singleflight、失败重试。 | 🧩 | S38 |
| 接口错误返回结构：`{err_code, message, trace_id}`；成功 `err_code` 为 0；`X-Tps-trace-ID` 响应头同值。 | ✅ | S3, S31 |
| ⚡ token 端点域名冲突：官方文档 = `api.bot.qq.com/app/getAppAccessToken`；官方 SDK v1.0.5 源码默认 = `bots.qq.com/app/getAppAccessToken`。两者历史上都存在，需真实 Bot 验证当前应以哪个为准（推测两者均可，但**未验证**）。 | ⚡🧪 | S2, S38 |

来源：
- S2 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>（2026-10-27）
- S3 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html>（2026-10-27）
- S31 <https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html>（2026-10-27）
- S38 npm `@tencent-connect/qqbot-nodejs@1.0.5` 源码 `src/protocol/api/token.ts`（<https://registry.npmmirror.com/@tencent-connect/qqbot-nodejs>，2026-10-27；官方 SDK，按任务要求标二手佐证）

---

## 3. HTTP OpenAPI 通用约定

| 事实 | 状态 | 来源 |
|---|---|---|
| 统一请求地址：`https://api.bot.qq.com`（文档「API 调用指南」）；官方 SDK 默认 base URL 为 `https://api.sgroup.qq.com`（SDK 源码常量）。⚡ 域名冲突，见下。 | ✅ / 🧩 | S3, S38 |
| 鉴权：`Authorization: QQBot {ACCESS_TOKEN}`；`Content-Type: application/json; charset=utf-8`。 | ✅ | S2, S3 |
| 成功：响应体直接是业务数据；失败：`err_code` + `message` + `trace_id`，`err_code=0` 为成功。 | ✅ | S3 |
| HTTP 状态码含义：200 成功、204 成功无包体、201/202 异步成功但可能带 error body、401 认证失败、404 API 未找到、405 method 不允许、429 频率限制、500/504 处理失败。 | ✅ | S31 |
| 每个接口文档都带「接口频率限制」字段（见 §9）。 | ✅ | S18, S19, S22, S27, S29 |
| 撤回消息：单聊 `DELETE /v2/users/{user_openid}/messages/{message_id}`、群聊 `DELETE /v2/groups/{group_openid}/messages/{message_id}`；**发送超过 2 分钟不可撤回**；成功 HTTP 200 无 body。群管理员可撤回普通群成员消息（消息 ID 取自群消息事件 `d.id`），普通成员只能撤回自己机器人发的消息。 | ✅ | S20, S21 |
| 撤回错误码：`40061001` 参数无效、`40062003` 无操作权限、`40064004` 已超出撤回时限、`50065001`（页面被截断，需回查）。 | ✅ | S21 |
| ⚡ API base URL 冲突：文档统一 `api.bot.qq.com`；官方 SDK v1.0.5 `ApiClient` 默认 `api.sgroup.qq.com`（历史上 `api.sgroup.qq.com` 是主域名）。两者可能都可用；须实测（🧪）。 | ⚡🧪 | S3, S38 |
| ⚡ 网关地址（WS URL）也随之有两个来源：文档示例 `wss://api.bot.qq.com/websocket/`；经 `/gateway` 动态获取最稳妥。 | ⚡ | S4, S7 |

来源：
- S3 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html>（2026-10-27）
- S18/S19/S22/S27/S29 见 §6/§7 各接口小节
- S31 <https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html>（2026-10-27）
- S38 官方 SDK 源码（2026-10-27）

---

## 4. WebSocket 网关

### 4.1 接入点

| 事实 | 状态 | 来源 |
|---|---|---|
| `GET /gateway` 获取通用 WSS 接入点，返回 `{"url": "wss://api.bot.qq.com/websocket/"}`。 | ✅ | S7 |
| `GET /gateway/bot` 获取带分片 WSS 接入点，返回 `url`、`shards`、`session_start_limit`（`total` 每 24h 可创建 Session 数，`remaining`，`reset_after` 毫秒，`max_concurrency` 每 5s 可创建 Session 数）；文档示例 `total=1000`、`reset_after=14400000`、`max_concurrency=1`。 | ✅ | S8 |
| 每个机器人创建的连接数不能超过 `remaining`。 | ✅ | S4 |
| `/gateway` 系列接口需带 `Authorization`（与所有 OpenAPI 一致；`/gateway` 页面本身未重复写鉴权要求）。 | ⚠️ | S7, S8 |

### 4.2 opcode（payload 结构 `{id, op, d, s, t}`）

| op | 名称 | 方向 | 说明 | 状态/来源 |
|---|---|---|---|---|
| 0 | Dispatch | 收 | 服务端推送事件；`t` = 事件名，`s` = 序号 | ✅ S5 |
| 1 | Heartbeat | 发/收 | 客户端心跳；`d` = 客户端收到的最新 `s`，首连传 `null` | ✅ S5, S4 |
| 2 | Identify | 发 | 鉴权（见 §4.3） | ✅ S5 |
| 6 | Resume | 发 | 恢复会话（见 §4.4） | ✅ S5 |
| 7 | Reconnect | 收 | 服务端通知客户端重连 | ✅ S5 |
| 9 | Invalid Session | 收 | identify/resume 参数错误时返回 | ✅ S5 |
| 10 | Hello | 收 | 连接成功后第一条消息，`heartbeat_interval` 毫秒（示例 45000） | ✅ S5, S4 |
| 11 | Heartbeat ACK | 收 | 心跳成功回包 | ✅ S5, S4 |
| 12 | HTTP Callback ACK | 回 | 仅 webhook 模式的回包 | ✅ S5 |
| 13 | 回调地址验证 | 收 | 仅 webhook 模式 | ✅ S5 |

### 4.3 Identify（关键：token 格式）

| 事实 | 状态 | 来源 |
|---|---|---|
| Identify payload：`{"op":2,"d":{"token":"...","intents":513,"shard":[0,4],"properties":{"$os":"linux","$browser":"my_library","$device":"my_library"}}}`。 | ✅ | S4 |
| **当前文档：token 格式为 `QQBot {AccessToken}`**（AccessToken 即 `getAppAccessToken` 换取的值）。 | ✅ | S4 |
| 官方 SDK 源码 Identify 实为 `` `QQBot ${accessToken}` ``（与当前文档一致）；RESUME 也用同一 token 格式。 | 🧩 | S38 |
| ⚡ **旧文档仍在线**：`dev-prepare/interface-framework/reference.html` 写「token 格式为 `Bot {appid}.{app_token}`」。这是已废弃 Bot Token 体系的旧文案，与当前 AccessToken 文档冲突。**以 `QQBot {AccessToken}` 为准**；旧格式是否仍兼容未验证。 | ⚡ | S4 vs S6 |
| `intents`：位掩码；`GROUP_AND_C2C_EVENT` = `1<<25`（见 §5.1）；`INTERACTION` = `1<<26`。 | ✅ | S5 |
| `shard`：`[分片序号, 分片总数]`；无需分片用 `[0,1]`。分片按频道 guild id 哈希 `(guild_id >> 22) % num_shards`（对群/单聊场景不适用，取 `[0,1]` 即可）。 | ✅ | S4 |
| `properties` 目前无实际作用，可留空。 | ✅ | S4 |
| 鉴权成功后下发 `READY`（`op=0, t="READY"`，`d.session_id`、`d.user`、`d.shard`）。 | ✅ | S4 |

### 4.4 心跳 / Resume / 重连

| 事实 | 状态 | 来源 |
|---|---|---|
| 心跳：按 Hello 的 `heartbeat_interval` 周期发送 `{"op":1,"d":<最新 s 或 null>}`；收到 `{"op":11}` ACK。 | ✅ | S4 |
| 断线重连：**不需要重新 Identify**；连上 Gateway 后发 `{"op":6,"d":{"token":"...","session_id":"...","seq":1337}}`，网关自动补发 `seq` 之后的事件；补发完毕后下发 `RESUMED`（`op=0, t="RESUMED"`）。 | ✅ | S4 |
| 推荐开发者处理完事件后记录 `s`，resume 时作为 `seq` 传入。 | ✅ | S4 |
| WebSocket 错误码（关闭码）见 §8.5；官方给出的处理逻辑：`4009` 可重新 resume；`4914/4915` 不可连接需联系官方；其他错误重新 identify。 | ✅ | S4, S31 |
| 官方 SDK 重连策略：退避 `[1s,2s,5s,10s,30s,60s]`，QUICK_DISCONNECT 阈值 5s、最多 3 次；`INVALID_SESSION` 后 3s 再连；默认无限重试（可配 `reconnect.maxAttempts`）。 | 🧩 | S38 |

来源：
- S4 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html>（2026-10-27，页面标注更新 7/29/2026）
- S5 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html>（2026-10-27）
- S6 <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/reference.html>（2026-10-27；**旧文档，内容可能过期**）
- S7 <https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html>（2026-10-27，页面标注更新 7/30/2026）
- S8 <https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html>（2026-10-27）
- S38 官方 Node SDK 源码（2026-10-27）

---

## 5. 入站事件

### 5.1 事件总览与 intents

`GROUP_AND_C2C_EVENT (1<<25)` 覆盖（官方 payload 页 + 各事件页一致）：

| 事件名 | 触发 | 状态/来源 |
|---|---|---|
| `C2C_MESSAGE_CREATE` | 用户单聊发消息给机器人 | ✅ S5, S9 |
| `GROUP_AT_MESSAGE_CREATE` | 用户在群里 @ 机器人 | ✅ S5, S10 |
| `GROUP_MESSAGE_CREATE` | 群全量消息（需群主放开「接收全量消息」权限） | ✅ S11 |
| `FRIEND_ADD` / `FRIEND_DEL` | 用户添加/删除机器人（好友关系） | ✅ S5, S15 |
| `C2C_MSG_RECEIVE` / `C2C_MSG_REJECT` | 用户开启/关闭「主动消息」推送开关 | ✅ S5, S13 |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` | 机器人被加入/移出群 | ✅ S5, S12 |
| `GROUP_MSG_RECEIVE` / `GROUP_MSG_REJECT` | 群管理员开启/关闭通知 | ✅ S5, S14 |
| `GROUP_JOIN_REQUEST` | 入群申请（页面存在，字段未在本轮细读） | ⚠️ |
| `INTERACTION_CREATE` | 互动事件（按钮/菜单/授权等），intent `1<<26` | ✅ S16 |

> intents 权限：`GUILDS`、`PUBLIC_GUILD_MESSAGES`、`GUILD_MEMBERS` 是默认有权限的基础事件；其他特殊事件需申请，无权限的 intent 会导致 WS 报错并关闭连接。**`GROUP_AND_C2C_EVENT` 在文档示例中被使用（非基础事件）**，实际是否需要申请权限，需按 Bot 管理端确认（🧪/⚠️）。来源 S5、S37（旧 NodeSDK 页也重复该权限说明）。

### 5.2 `C2C_MESSAGE_CREATE`（单聊消息事件）

| 字段 | 类型 | 描述 | 状态/来源 |
|---|---|---|---|
| `id` | string | 消息 ID，用于被动回复与撤回 | ✅ S9 |
| `author` | User | 发送者；单聊场景有 `user_openid` | ✅ S9 |
| `content` | string | 文本内容 | ✅ S9 |
| `timestamp` | string | RFC3339 发送时间 | ✅ S9 |
| `message_type` | int | 接收类型：0=普通文本、3=结构化卡片、101=并行消息、102=聊天记录、103=引用消息 | ✅ S9, S24 |
| `message_scene` | MessageScene | `{source:"default", ext:[...]}`；`ext` 为 key=value 字符串数组：`msg_idx=`、`ref_msg_idx=`、`auth_token=` | ✅ S9 |
| `attachments` | []MessageAttachment | 图片/文件/语音等附件（结构见 §5.7） | ✅ S9 |
| `ark_data` | ARKData | `message_type=3` 时的卡片数据（`ark_type`/`ark_name`/`fields`/`prompt`） | ✅ S9 |
| `msg_elements` | []MsgElement | `message_type=103`（引用）时包含被引用消息内容，可递归 | ✅ S9 |

`User` 结构（两个消息事件共用）：`id`、`username`、`bot`、`union_openid`、`union_user_account`、`user_openid`（单聊）、`member_openid`（群成员）、`member_role`（`member`/`admin`/`owner`）。

- 单聊安全提醒：官方在页面注明「相同 msg_id 可能重复推送，需结合 **message_scene.ext 中的 msg_idx** 做去重」。

### 5.3 `GROUP_AT_MESSAGE_CREATE`（群 @ 机器人消息）

| 字段 | 类型 | 描述 | 状态/来源 |
|---|---|---|---|
| `id` | string | 消息 ID，用于被动回复与撤回 | ✅ S10 |
| `author` | User | 群成员；`member_openid` 有值，`member_role` 为群内角色 | ✅ S10 |
| `content` | string | 文本内容，**已自动去除 @ 机器人前缀** | ✅ S10 |
| **`group_openid`** | string | **群 OpenID，在事件体顶层**（不是嵌套在 author 里） | ✅ S10 |
| `timestamp` | string | RFC3339 | ✅ S10 |
| `message_type` | int | 同 C2C（0/3/101/102/103） | ✅ S10 |
| `message_scene` | MessageScene | 同 C2C；群场景示例里 `ext` 带 `msg_idx=` 与 `auth_token=` | ✅ S10 |
| `attachments` | []MessageAttachment | 附件 | ✅ S10 |
| `mentions` | []User | 消息中 @ 的其他用户（**不含 @ 机器人自身**） | ✅ S10 |
| `ark_data` / `msg_elements` | / | 同 C2C | ✅ S10 |

**关键点：`group_openid` 的位置 = 事件体顶层（`d.group_openid`）**，可直接拼接发送路径 `/v2/groups/{group_openid}/messages`；C2C 侧则用 `d.author.user_openid` 拼接 `/v2/users/{user_openid}/messages`。来源 S9/S10（✅）。

### 5.4 `GROUP_MESSAGE_CREATE`（群全量消息）

| 字段 | 状态/来源 |
|---|---|
| 事件名 `GROUP_MESSAGE_CREATE`，Intent `GROUP_AND_C2C_EVENT (1<<25)` | ✅ S11 |
| 事件体与 `GROUP_AT_MESSAGE_CREATE` 同构：`id`、`author`（`member_openid`/`member_role`）、`content`、**`group_openid`（顶层）**、`timestamp`、`message_type`、`message_scene.ext`（含 `msg_idx`/`auth_token`）、`attachments`、`msg_elements`、`mentions` | ✅ S11 |
| 触发条件：群主在群设置里把「机器人可获取的群聊消息范围」设为**获取群内全部消息**（并要求升级到最新版手机 QQ）。 | ✅ S33, S32 |
| 与 @ 事件区分：默认群里只有 @ 机器人才触发（`GROUP_AT_MESSAGE_CREATE`）；全量模式才会收到 `GROUP_MESSAGE_CREATE`。 | ✅ S33, S32 |
| content 是否去 @ 前缀：@ 事件页面明确「已去除」；全量事件页面示例为普通群聊内容，无明确说明。 | ⚠️ S11 |

### 5.5 生命周期 / 开关事件（字段较少，适合驱动白名单与会话状态）

| 事件 | 事件体字段 | 状态/来源 |
|---|---|---|
| `GROUP_ADD_ROBOT` | `timestamp`(Unix 秒)、`group_openid`、`op_member_openid`（操作添加的群成员） | ✅ S12 |
| `GROUP_DEL_ROBOT` | `timestamp`、`group_openid`、`op_member_openid` | ✅ S5, 页面存在 |
| `GROUP_MSG_RECEIVE` | `timestamp`、`group_openid`、`op_member_openid` | ✅ S14 |
| `GROUP_MSG_REJECT` | 同上（关闭通知） | ✅ S5 |
| `C2C_MSG_RECEIVE` | `timestamp`、`openid`（注意字段名是 `openid`） | ✅ S13 |
| `C2C_MSG_REJECT` | `timestamp`、`openid` | ✅ S5 |
| `FRIEND_ADD` | `timestamp`、`openid`、`scene`（1000-2004 场景值）、`scene_param`、`author.union_openid`、`short_code` | ✅ S15 |
| `FRIEND_DEL` | 字段未细读；官方有页面 | ⚠️ |

### 5.6 `INTERACTION_CREATE`（互动/按钮回调 —— 与 M2 审批 UX 直接相关）

| 事实 | 状态/来源 |
|---|---|
| 事件名 `INTERACTION_CREATE`，Intent `INTERACTION (1<<26)`；`d.id` 是互动事件 ID，用于后续「互动回调」与被动消息发送 | ✅ S16 |
| 事件体字段：`id`、`type`、`scene`（c2c/group/guild）、`chat_type`（0 频道/1 群聊/2 单聊）、`timestamp`、`user_openid`（单聊）、`group_openid`/`group_member_openid`（群聊）、`data`（InteractionData）、`version`、`application_id` | ✅ S16 |
| type：11=消息按钮回调（INLINE_KEYBOARD）；12=单聊快捷菜单回调；13=消息反馈；14=清空会话；15=进出故事集；16=切换模型；18=用户授权；19=群授权；20=群授权状态变更 | ✅ S16 |
| **仅 type=11/12 需要调用 `PUT /interactions/{interaction_id}` 回应**，否则客户端一直 loading 到超时；其他类型无需回应（调了也不报错）。`interaction_id` 取自事件 `d.id`，**不带 `INTERACTION_CREATE:` 前缀**。 | ✅ S16, S17 |
| 回应请求体：`{"code":0..5}`（0 成功/1 操作失败/2 操作频繁/3 重复操作/4 没有权限/5 仅管理员操作）；PUT 接口频控 50 QPS；同一 `interaction_id` 只能回应一次，超时失效。 | ✅ S17 |
| 发送消息时 `event_id` 可用于被动回复 `INTERACTION_CREATE`（单聊支持事件列表含 INTERACTION_CREATE；群聊支持 INTERACTION_CREATE/GROUP_ADD_ROBOT/GROUP_MSG_RECEIVE）。 | ✅ S18, S19 |
| 🧪 注意：官方 SDK 内部把互动事件的被动回复 key 记为 `INTERACTION_CREATE:` + id（`msgid-cache`），而发送接口文档说 event_id「从事件最外层的 id 获取」。**是否需要带前缀，待实测**。 | 🧩🧪 S38 |

### 5.7 入站附件（`attachments[]` / `MessageAttachment`）

| 字段 | 描述 | 状态/来源 |
|---|---|---|
| `url` | 附件下载 URL；示例 `https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=xxx&rkey=xxx&spec=0` | ✅ S10 |
| `filename` | 文件名 | ✅ S10 |
| `width` / `height` | 图片宽高（像素），非图片无此字段 | ✅ S10 |
| `size` | 字节数 | ✅ S10 |
| `content_type` | MIME：`voice`=语音、`image/jpeg`、`image/png`、`image/gif`、`video/mp4`、`file`=群文件 | ✅ S10 |
| `voice_wav_url` | 语音消息经 SILK 等转换后的 WAV URL | ✅ S10 |
| `asr_refer_text` | 语音消息 ASR 参考文本 | ✅ S10 |
| **下载鉴权**：官方文档未要求额外 Header；URL 自带 `rkey` 签名参数。官方 DSH 插件实现为**裸 HTTPS GET**（无 Authorization），并做 SSRF 防护、大小上限、超时。 | ⚠️🧩 S38, S39 |
| **URL 有效期**：官方未公开 `rkey` 的 TTL（🧪待实测；需实测「事件到达后多久内 URL 仍可下载」）。不要持久化 URL，收到即下载。 | 🧪 |
| 语音下载建议：优先用 `voice_wav_url`（平台已转 WAV）；`asr_refer_text` 可直接作为文本上下文。 | ⚠️ S10 |

### 5.8 去重 / 幂等（⚠️ 文档自相矛盾）

| 说法 | 来源 |
|---|---|
| 「相同 msg_id 可能重复推送，开发者需结合 **msg_seq** 做去重」 | ✅ S9 首段 / S19 首段 |
| 「相同 msg_id 可能重复推送，需结合 **message_scene.ext 中的 msg_idx** 做去重」 | ✅ S9 首段第二句 |
| 「相同 msg_id 可能多次推送，请结合 **msg_seq** 去重」（消息概述页） | ✅ S23 |
| ⚡ 冲突：入站事件体里**没有 `msg_seq` 字段**（`msg_seq` 是出站回复序号），因此「入站用 msg_seq 去重」无法执行。可行策略：以事件 `d.id` 为主 key 去重，`message_scene.ext.msg_idx` 作为辅助。**需实测重复推送时 id 是否稳定**。 | ⚡🧪 |

来源：
- S9–S17 见各行 URL（均为 `https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/...`，2026-10-27）
- S23 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>（2026-10-27）
- S24 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html>（2026-10-27）
- S33 <https://bot.q.qq.com/wiki/agent-qqbot/>（2026-10-27）
- S38/S39 见 §16（官方 SDK / 插件源码，二手佐证）

---

## 6. 出站发送

### 6.1 单聊 / 群聊发送接口

| 事实 | 单聊 | 群聊 | 状态/来源 |
|---|---|---|---|
| HTTP URL | `POST /v2/users/{user_openid}/messages` | `POST /v2/groups/{group_openid}/messages` | ✅ S18/S19 |
| 接口频控 | **100 QPS（含主动/被动等所有消息类型）** | **100 QPS** | ✅ S18/S19 |
| 被动回复有效期 | 60 分钟（页面开头）/「msg_id 5 分钟内有效」（字段说明）⚡ | 5 分钟 | ⚡ S18/S19/S23 |
| 每条消息可回复次数 | 4 次（页面开头） | 5 次 | ✅ S18/S19/S23 |
| 主动消息频控 | 企业认证/个人身份证认证 10/qps；未认证 5/qps 且 30/qpm；单关系 20/qpm；每好友每天最多 1000 条 | 企业/个人 60/qpm；未认证 30/qpm；单关系 20/qpm；每群每天最多 1000 条 | ✅ S18/S19/S23 |

请求体字段（两接口基本一致）：

| 字段 | 类型 | 说明 | 状态 |
|---|---|---|---|
| `msg_type` | int | 0=纯文本(content) 2=Markdown(markdown) 7=富媒体(media)；**单聊额外支持 6=输入中状态(input_notify)** | ✅ S18/S19 |
| `content` | string | `msg_type=0` 时为全文；**传了 markdown 后 content 必须为空** | ✅ S18/S19 |
| `markdown` | object | `{content?, template_id?, custom_template_id?, force_verify_image_resource?}`；`msg_type=2` 时必填；**传 markdown 后 content/ark 必须全为空** | ✅ S18/S19 |
| `keyboard` | object | 内联键盘：短形式 `{id}`，长形式 `{content:{rows:[{buttons:[...]}]}}` | ✅ S18/S19 |
| `msg_id` | string | 被动回复的消息 ID（来自事件 `d.id`）；与 `event_id` 二选一 | ✅ S18/S19 |
| `event_id` | string | 被动回复的事件 ID（事件最外层 `id`）；**单聊支持：INTERACTION_CREATE / C2C_MSG_RECEIVE / FRIEND_ADD；群聊支持：INTERACTION_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_RECEIVE** | ✅ S18/S19 |
| `msg_seq` | int | 与 `msg_id` 联合使用，避免同消息重复；**不填默认 1；相同 msg_id+msg_seq 重复发送会失败**；同一消息多次回复需递增 | ✅ S18/S19/S23 |
| `media` | object | `{file_info}`，`msg_type=7` 时必填；file_info 来自上传接口 | ✅ S18/S19 |
| `message_reference` | object | `{message_id}` 引用回复；message_id 取非机器人消息的 `message_scene.ext.msg_idx`，或机器人消息响应里的 `ext_info.ref_idx` | ✅ S18/S19 |
| `is_wakeup` | boolean | **仅单聊**：互动召回消息；与 msg_id/event_id 互斥；true 时不校验 msg_id/event_id 有效期 | ✅ S18（群聊请求体无此字段） |
| `input_notify` | object | **仅单聊**：`{input_type:1, input_second:1..60}` 输入中状态，`msg_type=6` | ✅ S18 |

响应体：`id`（消息 ID，可用于撤回）、`timestamp`（RFC3339 东八区）、`ext_info.ref_idx`（引用消息索引）。✅ S18/S19

### 6.2 被动回复窗口 / 次数（⚡ 冲突点，重点核对项）

| 场景 | 有效期 | 次数 | 来源 |
|---|---|---|---|
| 单聊 | **60 分钟** | **4 次** | ✅ S23「频率与时效规则」表 + S18 页面开头 |
| 群聊 | **5 分钟** | **5 次** | ✅ S23 + S19 页面开头 |
| 频道（对照） | 5 分钟 | — | ✅ S23 |
| ⚡ 冲突 1 | C2C 发送页 `msg_id` 字段说明写「从 C2C_MESSAGE_CREATE 等事件的 d.id 获取，**5 分钟内有效**」，与同页开头的「60 分钟」矛盾 | ⚡ S18 |
| ⚡ 冲突 2 | 官方 DSH 插件实现的 msgid 缓存 TTL 是**群 5 分钟 / 单聊 30 分钟**（既不是 60 也不是 5） | 🧩 S39 |
| 结论 | 60 分钟/4 次 与 5 分钟/5 次 是官方「消息收发概述」的规范性表格，优先级高；C2C 的 5 分钟与插件 30 分钟都视为保守实现。**仍需实测边界（60min 后的第一次回复失败码是否为 40034128/304103/40034005）** | ⚡🧪 |
| 相关错误码 | `40034128` 被动回复时间或次数超限；`304103` 消息 ID 已过期；`40034005` 回复消息 msg_id 已过期；`40034026` event_id 已过期；`40034024` msg_id 无效或越权；`40034025` event_id 无效；`40034027` 该事件不支持回复 | ✅ S18/S19 |

### 6.3 主动消息与互动召回

| 事实 | 状态/来源 |
|---|---|
| 主动消息：不带 `msg_id`/`event_id`；受频控/配额限制；用户可在客户端关闭「允许主动发送」，关闭后主动消息一律发送失败（可被 C2C_MSG_REJECT/GROUP_MSG_REJECT 事件感知）。 | ✅ S23, S13, S14 |
| 互动召回消息（仅单聊）：`is_wakeup=true`；用户主动对话后 **30 天内**可下发；分 4 个周期（当天、1–3 天、3–7 天、7–30 天），**每个周期 1 条**；消息类型与当前机器人拥有的权限一致；`is_wakeup=true` 时不校验 msg_id/event_id 有效期。 | ✅ S23, S18 |
| 召回相关错误码：`40034122` 召回消息已达区间上限、`40034123` 不支持召回消息。 | ✅ S18 |
| 主动消息频控（单聊/群聊）：见 §9.2 表。 | ✅ S23 |
| 未认证机器人的主动消息限制更严（单聊 5/qps 且 30/qpm；群聊 30/qpm）。 | ✅ S23 |

### 6.4 流式消息（仅 C2C；群聊不支持）

| 事实 | 状态/来源 |
|---|---|
| 接口：`POST /v2/users/{user_openid}/stream_messages`，频控 **50 QPS**；群消息**不支持**流式参数。 | ✅ S22, S19 |
| 请求字段：`input_mode`（append 默认 / replace）、`input_state`（1=生成中，10=生成结束）、`index`（从 0 递增）、`content_type`（text/markdown）、`content_raw`（当前全量正文，replace 模式必须以上游已下发前缀开头）、`event_id`/`msg_id`（二选一）、`stream_msg_id`（首片由服务端返回，后续必须携带）、`msg_seq`、`is_wakeup`。 | ✅ S22 |
| 响应：`id`（首片返回 stream_msg_id）、`timestamp`、`ext_info.ref_idx`、`remain_msg_len`（流式消息剩余长度，字符数）。 | ✅ S22 |
| 错误码：`40007` 已下发内容前缀不可修改（replace 模式必须保持前缀一致）；`50001` 服务内部错误；`50002` 频率限制。 | ✅ S22 |
| 平台约束：流式节流不能低于 **300ms**（官方 SDK USAGE 明确写「流式消息节流不能低于 300ms」）。 | 🧩 S38 |
| 一个流会话内所有帧共享同一 `msg_seq`（官方 SDK 用法说明）。 | 🧩 S38 |

### 6.5 内联键盘（消息按钮）——审批交互候选方案

| 字段 | 说明 | 状态 |
|---|---|---|
| `keyboard.id` | 平台预设模板 ID | ✅ S18 |
| `keyboard.content.rows[].buttons[]` | 自定义布局；每 button：`id`、`render_data`、`action`、`group_id` | ✅ S18 |
| `render_data.label` | 按钮文字，**最多 10 字符**；`visited_label`、`style`（0 灰线框/1 蓝线框/3 白底红字/4 蓝底白字） | ✅ S18 |
| `action.type` | 0=跳转（http/小程序）、1=回调后台接口（data 传给后台）、2=指令按钮（自动在输入框插入 @bot data） | ✅ S18 |
| `action.permission.type` | 0=指定用户、1=管理员、2=所有人；`specify_user_ids` | ✅ S18 |
| `action.enter`/`reply` | 指令按钮是否直接发送/带引用，需手机 QQ 8983+ | ✅ S18 |
| `action.modal` | 二次确认：content 最多 40 字符且不能有 URL；confirm/cancel 各最多 4 字符 | ✅ S18 |
| 可用性 | 单聊/群聊自定义 Markdown 与消息按钮**已开放所有机器人，无需单独申请模板**。 | ✅ S32, S25 |

来源：
- S18 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>（2026-10-27）
- S19 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>（2026-10-27）
- S20 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html>（2026-10-27）
- S21 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html>（2026-10-27）
- S22 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html>（2026-10-27，页面更新 7/22/2026）
- S23 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>（2026-10-27）
- S25 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html>（2026-10-27）
- S32 <https://bot.q.qq.com/wiki/bot_FAQ/>（2026-10-27）
- S38/S39 官方 SDK / DSH 插件源码（2026-10-27，二手佐证）

---

## 7. 内容与媒体限制

### 7.1 文本 / Markdown 长度（⚡ 官方文档未给数字，冲突）

| 来源 | 说法 | 性质 |
|---|---|---|
| 官方文档（消息概述、发送接口、Markdown、FAQ） | **没有**写出文本/markdown 的字符数上限；只有错误码 `40054007` 消息长度超限、`40054018` 消息过长或异常 | ✅ 官方「没写」 |
| 官方 Node SDK 源码注释 + 常量 | 「QQ Open Platform caps a single text message at **~5000 characters**」；`TEXT_CHUNK_LIMIT = 5000` | 🧩 二手佐证 |
| 官方 DSH 插件（`@tencent-connect/dsh-qqbot`） | `textChunkLimit` **默认 4500**，注释「QQ 限制约 5000 字符」；chunker 注释「约 5000」 | 🧩 二手佐证 |
| 官方 OpenClaw 插件 changelog | 2026-03-18：`textChunkLimit` 从 20000 调整为 **5000** | 🧩 二手佐证 |
| 第三方（Qwen Code 文档、nekobot 适配器文档、pushplus 文档） | 「单条消息上限 **2000** 字符，超出自动拆分/截断」 | 二手（第三方） |
| 结论 | 采用 **≤5000 字符** 的上限判断，并按 4500 左右保守切分；**必须以真实 Bot 实测确认（🧪）**：纯文本上限、markdown 上限是否同一个数、超限是报错（40054007/40054018）还是截断/自动拆分 | ⚡🧪 |

### 7.2 Markdown 能力

| 事实 | 状态/来源 |
|---|---|
| **2026/04/23 能力更新**：单聊、群聊自定义 Markdown 已开放到**所有机器人**，**无需单独申请 Markdown 模板**；频道场景仍需内邀开通。 | ✅ S25 |
| 发送方式：`{"msg_type":2,"markdown":{"content":"..."}}`；另有模板方式（`custom_template_id` + `params`），但发送接口 schema 中 `template_id` / `custom_template_id` 已标「**已废弃**」。 | ✅ S25, S18/S19 |
| 支持格式：标题（#/##）、加粗/下划线加粗/斜体/加粗斜体/删除线、链接（[]()与<>）、图片（`![text #208px #320px](url)`，平台会下载转存）、有序/无序/嵌套列表、块引用、水平分割线、换行。**文档未列出代码块、表格** → AI 输出的 fenced code / GFM 表格是否渲染，🧪待实测。 | ✅ S25, 🧪 |
| Markdown 图片：可用公网 URL（平台下载转存）或先用素材管理上传得到 `qqbot-media://` 引用。 | ✅ S25, S30 |
| `force_verify_image_resource: true` 时图片转存失败会直接报错不发送（默认 false）。 | ✅ S18 |
| 失败码：`40034008` markdown 参数有空值、`40034009` 参数含换行符、`40034010` 模板参数含 markdown 语法、`40034011` 无效 markdown、`40034124` markdown 参数错误、`40034127` 无 markdown 模板权限、`304036` 无 Markdown 模板权限。 | ✅ S18/S19 |
| ⚠️ 接收侧：消息类型矩阵写「群聊 Markdown 收发 ✅」，但入站 `message_type` 只有 0/3/101/102/103，没有 markdown 类型。推测「收」指平台能展示或转为文本，**群内收到用户 markdown 的实际事件形态待实测**。 | ⚡🧪 S24, S9 |

### 7.3 富媒体上传（发送侧）

| 事实 | 状态/来源 |
|---|---|
| 单聊上传 `POST /v2/users/{user_openid}/files`，群聊 `POST /v2/groups/{group_openid}/files`；**两场景接口不互通，文件不能跨场景使用**；对应预上传/分片接口也需同场景。 | ✅ S26, S27, S28 |
| `file_type`：1=图片（png/jpg，软限 20MB，硬限 200MB）；2=视频（mp4，软 30MB，硬 200MB）；3=语音（silk，软 20MB，硬 200MB）；4=文件（软/硬 200MB）。**超软限降级为文件类型上传，超硬限报错**。 | ✅ S26, S27 |
| 上传方式：URL 直传（`url` 以 http 开头，平台下载转存；接口 50 QPS）、二进制直传（≤5MB）、分片上传（预上传 `upload_prepare` 10 QPS → 分片 PUT → `upload_part_finish` → 上传接口合并）。 | ✅ S26, S27, S29 |
| `upload_prepare` 请求需 `file_type`、`file_size`、`file_name`、`md5`、`sha1`、`md5_10m`（前 10002432 字节 MD5）；响应 `upload_id`、`block_size`（默认 5MB）、`parts[]`（预签名 URL）、`upload_config`；分片 PUT 后 `part_finish`，最后合并拿 file_info。 | ✅ S29, S26 |
| 上传接口响应：`file_uuid`、`file_info`（不透明字符串，直接透传给发送接口）、`ttl`（file_info 有效期，秒；**0 表示可长期使用**）、`id`（仅 `srv_send_msg=true` 时返回）、`raw_url`（部分路径返回，COS 预签名 GET URL，有效期与 ttl 一致；URL 直传与 file_type=4 不返回）。 | ✅ S27 |
| `srv_send_msg=true`：上传同时直接发消息，**占用主动消息频次**；false 时仅返回 file_info 供后续发送。 | ✅ S27 |
| 发送富媒体：`{"msg_type":7,"media":{"file_info":"..."}}`。 | ✅ S26 |
| ⚡ 分片上传大小上限：官方文档文件类硬限 200MB；官方 SDK `CHUNKED_UPLOAD_MAX_SIZE = 100MB`（一次性上传 20MB）。实现口径不一致，按平台文档 200MB 但需实测。 | ⚡🧪 S26 vs S38 |
| `upload_prepare` 存在**日额度**，命中后官方 SDK 抛 `UploadDailyLimitExceededError`（具体数值未公开，🧪待实测）。 | 🧩 S38 |
| URL 上传注意：服务端下载资源可能因网络失败；失败时可改本地分片上传。 | ✅ S27 |

### 7.4 素材管理（Markdown 图片专用，`qqbot-media://`）

| 事实 | 状态/来源 |
|---|---|
| 预上传 `POST /v2/media-images/prepare`（file_name/file_size/content_type/md5/sha1）→ PUT 预签名 URL → `POST /v2/media-images/complete` 得到图片引用与 `image_id`；在 Markdown 中写 `![说明 #宽px #高px](qqbot-media://image/v1/...)`。 | ✅ S30 |
| 限制：单张 ≤10MB；png/jpeg/gif/webp；扩展名与 Content-Type 一致；**单机器人默认上限 100 张**；上传任务 `upload_id` **4 小时**有效；预签名 URL 有效期以 `expires_in` 为准。 | ✅ S30 |
| 图片有效期：**滑动过期**，自最后一次被消息引用起 **90 天（7776000 秒）** 内未使用则失效；连续 90 天未引用链接失效，错误码 `40035009`；超数量上限返回 `40035007`。 | ✅ S30 |

来源：
- S24 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html>（2026-10-27）
- S25 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html>（2026-10-27）
- S26 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>（2026-10-27）
- S27 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html>（2026-10-27）
- S28 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html>（2026-10-27）
- S29 <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html>（2026-10-27）
- S30 <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html>（2026-10-27）
- S38 官方 Node SDK 源码（2026-10-27）

---

## 8. 错误码

> 说明：官方错误码分散在 `openapi/error/error.html`（公共/旧频道）与各接口页「错误码」表（v2 单聊/群聊）。下列「分类」是**调研建议**，官方没有给「可重试/永久」分级表。

### 8.1 token / 鉴权

| 码 | 含义 | 建议处理 | 来源 |
|---|---|---|---|
| 100001 | Too many requests | 退避重试 | ✅ S2 |
| 100007 | appid invalid（或机器人封禁/删除） | 永久，人工排查 | ✅ S2 |
| 100016 | invalid appid or secret | 永久，检查凭据 | ✅ S2 |
| 10004 | 机器人不存在 | 永久 | ✅ S2 |
| 401（HTTP） | 认证失败 | 刷新 token 后重试一次 | ✅ S31 |
| 11241/11243 | 参数缺少 token / token 校验未通过（旧公共码） | 刷新 token | ✅ S31 |
| 11265 | 机器人已被封禁 | 永久 | ✅ S31 |

### 8.2 发送接口错误码（v2，重点；按场景）

| 码 | 含义 | 场景 | 建议分类 | 来源 |
|---|---|---|---|---|
| 22006 | 消息类型与内容不匹配 | 通用 | 永久（改请求） | ✅ S18 |
| 50059 | 输入类型错误 | 单聊 | 永久 | ✅ S18 |
| 304061 | 消息内容无效 | 通用 | 永久 | ✅ S18/S19 |
| 304080 | 文件信息无效（file_info 格式错） | 通用 | 永久（重新上传） | ✅ S18/S19 |
| 40034004 | 富媒体信息转存失败 | 通用 | **可重试** | ✅ S18 |
| **40034005** | 回复消息 msg_id 已过期 | 通用 | **回退主动消息** | ✅ S18/S19 |
| 40034006 | 消息内容违规 | 通用 | 永久（改内容） | ✅ S18 |
| 40034008 | markdown 参数有空值 | 通用 | 永久 | ✅ S18 |
| 40034009 | markdown 参数有换行符 | 通用 | 永久 | ✅ S18 |
| 40034010 | 模版参数含 markdown 语法 | 通用 | 永久 | ✅ S18 |
| 40034011 | 无效的 markdown 内容 | 通用 | 永久 | ✅ S18 |
| 40034024 | msg_id 无效或越权 | 通用 | 永久 | ✅ S18 |
| 40034025 | event_id 无效 | 通用 | 永久 | ✅ S18 |
| 40034026 | event_id 已过期 | 通用 | **回退主动消息** | ✅ S18 |
| 40034027 | 该事件不支持回复消息 | 通用 | 永久 | ✅ S18 |
| 40034029 | 内联键盘行/列超限 | 通用 | 永久（减按钮） | ✅ S18 |
| **40034100** | 主动消息发送超过频控限制 | 通用 | **退避/延后** | ✅ S18/S19 |
| 40034101 | 机器人非群成员 | 群 | 永久（先加群） | ✅ S19 |
| **40034105** | 主动消息发送失败，无权限 | 通用 | 保底告知用户/转被动 | ✅ S18/S19 |
| 40034106 | 消息不支持该指令类型 | 通用 | 永久 | ✅ S18 |
| 40034108 | 指令参数长度超限 | 通用 | 永久（截断） | ✅ S18 |
| 40034109 | 指令参数解析失败 | 通用 | 永久 | ✅ S18 |
| 40034122 | 召回消息已达区间上限 | 单聊 | 放弃召回 | ✅ S18 |
| 40034123 | 不支持召回消息 | 单聊 | 放弃召回 | ✅ S18 |
| 40034124 | markdown 消息参数错误 | 通用 | 永久 | ✅ S18 |
| 40034127 | 无 markdown 模板权限 | 通用 | 改用自定义 content | ✅ S18 |
| **40034128** | **被动回复时间或次数超限** | 通用 | **回退主动消息** | ✅ S18/S19 |
| 40054002 | 机器人被禁言 | 群 | 永久（等解禁） | ✅ S19 |
| 40054003 | 机器人不是群成员 | 群 | 永久 | ✅ S19 |
| **40054005** | 消息被去重 | 通用 | **换 msg_seq 重发** | ✅ S18/S19 |
| 40054004 | 无好友关系 | 单聊 | 永久（先加好友） | ✅ S18 |
| 40054006 | 验证好友关系失败 | 单聊 | 可重试 | ✅ S18 |
| **40054007** | **消息长度超限** | 通用 | **截断/分段后重发** | ✅ S18/S19 |
| 40054010 | 不允许发送 URL | 群 | 永久（去 URL） | ✅ S19 |
| **40054013** | 用户拒收消息 | 单聊 | 永久（用户关闭主动消息） | ✅ S18 |
| 40054016 | 机器人已下线 | 通用 | 永久（检查状态） | ✅ S18/S19 |
| 40054018 | 消息过长或异常 | 单聊 | 截断/分段 | ✅ S18 |
| 304103 | 消息 ID 已过期，不能回复 | 通用 | 回退主动消息 | ✅ S18/S19 |
| 304036 | 无 Markdown 模板权限 | 群 | 改用自定义 content | ✅ S19 |
| 304062 | 订阅按钮数量达到上限 | 通用 | 永久 | ✅ S18 |
| 304064 | 订阅消息未授权 | 通用 | 引导授权 | ✅ S18 |
| 50055001 / 50055002 | 消息发送异常，请稍后重试 | 群 / 单聊 | **可重试** | ✅ S18/S19 |
| 50055006 | ARK 消息发送异常 | 群 | 可重试 | ✅ S19 |

### 8.3 互动/撤回/上传相关

| 码 | 含义 | 来源 |
|---|---|---|
| 630001/630002/630003 | 互动回调参数无效 / 获取 AppID 失败 / AppID 不匹配 | ✅ S17 |
| 40061001 / 40062003 / 40064004 / 50065001 | 撤回参数无效 / 无操作权限 / 超出撤回时限 / （截断，需回查） | ✅ S21 |
| 40035007 / 40035009 | 素材图片数量超限 / 素材链接失效 | ✅ S30 |
| 40007 / 50001 / 50002 | 流式：已下发前缀不可修改 / 服务内部错误 / 频率限制 | ✅ S22 |
| 304018 | 机器人没连上 gateway（旧公共码，v2 场景是否复用待核实） | ⚠️ S31 |

### 8.4 WebSocket 关闭码

| 码 | 含义 | 可 RESUME | 可 IDENTIFY | 来源 |
|---|---|---|---|---|
| 4001 | 无效 opcode | 否 | 否 | ✅ S4/S31 |
| 4002 | 无效 payload | 否 | 否 | ✅ |
| 4006 | 无效 session id，需 identify | 否 | 是 | ✅ |
| 4007 | seq 错误 | 否 | 是 | ✅ |
| 4008 | 发送 payload 过快 | 是 | 是 | ✅ |
| 4009 | 连接过期，需重连并 resume | 是 | 是 | ✅ |
| 4010 | 无效 shard | 否 | 否 | ✅ |
| 4011 | 需处理的 guild 过多 | 否 | 否 | ✅ |
| 4012 | 无效 version | 否 | 否 | ✅ |
| 4013 | 无效 intent | 否 | 否 | ✅ |
| 4014 | intent 无权限 | 否 | 否 | ✅ |
| 4900–4913 | 内部错误，请重连 | 否 | 是 | ✅ |
| 4914 | 机器人已下架，只允许沙箱环境 | 否 | 否 | ✅ |
| 4915 | 机器人已封禁 | 否 | 否 | ✅ |
| ⚡ 4004 | 文档关闭码表**没有 4004**；官方 SDK 常量有 `AUTH_FAILED: 4004`（401 类鉴权失败） | — | — | ⚡ S38 vs S4 |
| ⚡ 语义冲突 | 官方文档：4914=已下架/沙箱限制，4915=已封禁；官方 SDK 常量命名：4914=`INSUFFICIENT_INTENTS`，4915=`DISALLOWED_INTENTS`（与文档不一致，SDK 命名疑似错误/沿用 Discord 语义） | — | — | ⚡ S38 vs S4 |

来源：
- S2/S4/S18/S19/S21/S22/S30/S31/S38 均见 §16

---

## 9. 频率限制

### 9.1 接口级（文档在每个 API 页的「接口频率限制」字段）

| 接口 | 限制 | 来源 |
|---|---|---|
| 单聊发送 `/v2/users/{user_openid}/messages` | 100 QPS（含主动、被动等所有消息类型） | ✅ S18 |
| 群聊发送 `/v2/groups/{group_openid}/messages` | 100 QPS | ✅ S19 |
| C2C 流式 `/v2/users/{user_openid}/stream_messages` | 50 QPS | ✅ S22 |
| 富媒体上传 `/v2/.../files` | 50 QPS | ✅ S27/S28 |
| 预上传 `/v2/.../upload_prepare` | 10 QPS | ✅ S29 |
| 撤回消息（单聊/群聊） | 10 QPS | ✅ S20/S21 |
| 互动回调 `PUT /interactions/{interaction_id}` | 50 QPS | ✅ S17 |
| 群信息 / 群机器人状态 | 30 QPM | ✅（autogen 群接口页） |
| 入群审批策略 | 60 QPM | ✅（autogen 群接口页） |
| 网关 `/gateway/bot` session 创建 | 每 24h total 1000 次、`max_concurrency=1`（每 5s 1 个） | ✅ S8 |

### 9.2 主动消息频控（HTTP 接口；按认证类型与场景）

**单聊：**

| 认证类型 | Bot 维度 | 单关系维度 | 每日上限 |
|---|---|---|---|
| 企业认证 | 10/qps | 20/qpm | 1000 条/用户 |
| 个人身份证认证 | 10/qps | 20/qpm | 1000 条/用户 |
| 未认证 | 5/qps **且** 30/qpm | 20/qpm | 1000 条/用户 |

**群聊：**

| 认证类型 | Bot 维度 | 单关系维度 | 每日上限 |
|---|---|---|---|
| 企业认证 | 60/qpm | 20/qpm | 1000 条/群 |
| 个人身份证认证 | 60/qpm | 20/qpm | 1000 条/群 |
| 未认证 | 30/qpm | 20/qpm | 1000 条/群 |

来源 S23（✅，消息收发概述页表格）。

### 9.3 其它频控事实

| 事实 | 状态/来源 |
|---|---|
| 频道（非本适配目标）：不论主动/被动，一个子频道每秒最多 5 条；主动消息默认每子频道每天 20 条、每频道每天最多 2 个子频道；频道私信每用户每天 2 条、每机器人每天累计 200 条。 | ✅ S23 |
| 官方文档**没有**提到限频响应头（如 `X-RateLimit-*`）；频控信息只通过错误码体现（100001、50002、40034100、610012/610013、1100308、304045 等）。🧪 实测确认是否有响应头。 | ✅（缺省） / 🧪 |
| 同一 `msg_id + msg_seq` 重复发送会失败（40054005），需递增 `msg_seq`。 | ✅ S23, S18/S19 |
| 相同 inbound `msg_id` 可能重复推送（去重见 §5.8）。 | ✅ S9/S10 |

来源：S8、S17–S23（见 §16）。

---

## 10. 准入与权限（运营侧事实）

| 事实 | 状态/来源 |
|---|---|
| 创建入口：QQ 开放平台 `q.qq.com/#/app/bot`，需主体认证 + 超级管理员账号；新版管理端取代旧版（旧版停止审核上架/功能配置）。 | ✅ S32 |
| 快捷创建入口（Agent 接入页）：浏览器/手机 QQ 打开快速注册链接 → 登录 → 「创建机器人」立即成功，随后机器人会给创建者 QQ 发一条消息；头像昵称可改。**未提认证要求**，但「如需体验更多服务需前往开放平台完善主体认证」。 | ✅ S33 |
| 机器人数量：个人认证开发者 **5 个**；企业认证开发者 **10 个**；同一企业主体下所有认证账号共用名额、**上限 50 个**。 | ✅ S32 |
| 快捷创建场景：**单个 QQ 账号可创建 5 只**（与个人认证数量一致）。 | ✅ S33 |
| 公开使用：**企业主体公开使用已开放；个人主体暂不支持公开使用**。 | ✅ S32 |
| 个人主体加群：机器人创建者可将机器人加到自己**是群主/管理员**的群聊（需最新版手机 QQ）。 | ✅ S32 |
| 个人主体私聊：可在新版管理端「开发设置」中**添加开发体验用户号码**。 | ✅ S32 |
| 沙箱：旧版管理端已不支持添加沙箱群/频道；**管理员账号可直接测试使用，无需沙箱环境**。 | ✅ S32 |
| 群内机器人权限（群主添加机器人时设置）：① 接收全量消息能力（允许后机器人可收到群内所有成员发言）；② 主动推送消息能力（允许机器人群内主动发言）；③ 撤回成员消息能力（需把机器人设为群管理员）。 | ✅ S32, S33 |
| 群消息模式：**默认只有 @ 机器人 才触发**；「群全量消息模式」需群主先在 QQ 侧开放「机器人可获取的群聊消息范围=全部消息」+「机器人主动在群聊内发言」，再由应用侧把 requireMention 设为 false。 | ✅ S33, S32 |
| 主动消息开关：用户 / 群管理员可在机器人资料页关闭「允许主动发送/通知」，关闭后主动消息失败；平台会下发 C2C_MSG_REJECT / GROUP_MSG_REJECT。 | ✅ S23, S13, S14 |
| 公开服务开通限制：账号状态异常、新注册审核中（约 3 天）、管理员账号异常、未完成 QQ 钱包实名认证 → 可能无法打开「公开服务」；打开失败有对应提示。 | ✅ S32 |
| 机器人被封禁：管理端「通知中心」查看，**封禁处罚暂不支持解封**。 | ✅ S32 |
| 运营规范：内容安全要求过滤违规内容；建议调用内容安全检测接口校验文本/图片；违规可导致封禁搜索/添加能力/下架/封号；禁止批量注册、刷量、网赚、外挂、多级分销、过度营销等。 | ✅ S34 |
| AI 合规：AI 模型与工具由开发者自选，需确保输出符合平台规范，违规会导致机器人/账号封禁；《运营规范》还要求对未成年人不宜内容提醒/处理、内容过滤机制、侵权投诉机制。 | ✅ S32, S34 |
| `union_openid`：需邮件申请（qq_bot_api@tencent.com），要求同一主体、仅支持绑定 QQBot/QQ 互联应用 APPID。 | ✅ S32 |
| 开放文档中的「内邀接口」暂未开放申请。 | ✅ S32 |

来源：
- S32 <https://bot.q.qq.com/wiki/bot_FAQ/>（2026-10-27）
- S33 <https://bot.q.qq.com/wiki/agent-qqbot/>（2026-10-27）
- S34 <https://bot.q.qq.com/wiki/business/>（2026-10-27）

---

## 11. SDK 与官方 Agent 接入方案（决定「零依赖自研」与否的关键）

### 11.1 官方 Node SDK（推荐协议层）

| 事实 | 状态/来源 |
|---|---|
| 包名 **`@tencent-connect/qqbot-nodejs`**，最新 **v1.0.5（2026-10-12）**，**MIT**，Node **>=20**，纯 ESM；运行时依赖**只有 `ws`**；仓库 <https://github.com/tencent-connect/qqbot-nodejs>。 | 🧩 S38 |
| 能力：HTTP REST、WebSocket / Webhook 双传输、Koa 风格中间件、消息收发、媒体上传（含大文件分片）、C2C 流式 `stream_messages`；源码 `src/` 随包发布。 | 🧩 S38 |
| 默认协议常量：Identify `token = "QQBot ${accessToken}"`；API base `https://api.sgroup.qq.com`；token base `https://bots.qq.com`；`FULL_INTENTS` 含 `GROUP_AND_C2C (1<<25)` 与 `INTERACTION (1<<26)`；含 `TEXT_CHUNK_LIMIT=5000`、`ReplyLimiter`（默认 4 次/1h）、`reconnect` 退避。 | 🧩 S38 |
| 有 `interaction` 回应、`msgid` 缓存（互动事件前缀）、SSRF 无关（下载辅助不在 SDK 内，属插件层）。 | 🧩 S38 |

### 11.2 其它官方包 / 官方插件

| 包 | 版本/时间 | 许可 | 用途 | 状态 |
|---|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 / 2026-07-07 | **UNLICENSED** | 控制台二维码扫码绑定，返回 `{appId, appSecret}`；Node >=18 | 🧩 S40 |
| `@tencent-connect/dsh-qqbot` | **0.5.3 / 2026-10-27** | **MIT** | **DeepSeek Harness 官方 QQ 插件**（本项目同生态！） | 🧩 S39 |
| `@tencent-connect/openclaw-qqbot` | 2.0.4 / 2026-09-23（文档页更新日志到 2.0.3） | npm metadata 未标 license；GitHub 官方开源 | OpenClaw 官方 QQ 插件：WS/Webhook、Ed25519、群 always 模式、C2C 流式、分片上传、SSRF 防护 | 🧩 S33 |
| `qq-guild-bot` | 2.9.5 / **2022-06-02** | MIT | 旧「QQ 频道机器人 NodeSDK」，文档 `develop/nodesdk` 仍指向它；**不覆盖 v2 群/单聊** | 🧩 S37, S41 |

### 11.3 官方 `@tencent-connect/dsh-qqbot` 的默认配置（对 Nokoribi 的直接参考）

| 配置 | 默认值 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 必填（或 env `QQBOT_APPID` / `QQBOT_SECRET`） | 扫码绑定 |
| `requireMention` | `true` | 群聊是否必须 @bot |
| `textChunkLimit` | **4500** | 单条消息最大字符数（注释称平台约 5000） |
| `streaming` | `true`（**群聊始终不启用**） | C2C 流式 |
| `sessionIdleTimeout` | 1800000ms（30 分钟） | 会话闲置回收 |
| `processingTimeoutMs` | 1800000ms（30 分钟） | 处理超时中断 |
| `maxQueue` | 20 | 并发队列最大长度 |
| `historyLimit` | 10 | 群历史缓冲条数 |
| `askTimeoutMs` | 300000ms | ask_user_question 待答超时 |
| `access.c2cMode` / `access.groupMode` | `open`（可选 `allowlist`/`disabled`） | 白名单基于 user/group openid |
| `media.maxMB` / `media.ttlHours` | 200 / 24 | 富媒体下载上限与本地存活 |
| 被动回复实现 | reply-limiter（4 次/1h 通用）+ msgid-cache（群 5min / 单聊 30min）+ chunker | 见 §6.2 |
| 依赖 | `@tencent-connect/qqbot-nodejs ^1.0.5`、`qqbot-connector 1.2.0` | 官方组合方式 |

来源 S39（npm metadata + 包内 README/dist 源码，2026-10-27，二手佐证）。

### 11.4 Agent 接入官方方案（文档）

- 官方「Agent 接入」文档覆盖：龙虾 Bot + 官方 OpenClaw 插件、Hermes Agent、**DeepSeek Harness（dsh）QQ Bot 插件 `@tencent-connect/dsh-qqbot`**、第三方扫码连接 SDK `@tencent-connect/qqbot-connector`（默认显示「第三方机器人」，需商务定制平台名）。
- 官方给出 dsh 插件的安装方式：`npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot` → `npx @deepseek-ai/dsh --profile qqbot`；群 always 模式可在 `cordis.patch.yaml` 写 `im-qqbot` 的 `requireMention: false`。
- 结论（事实层）：**官方已有 DSH 生态的 QQ 插件**，且协议层 SDK 为 MIT；「从零零依赖自研」在技术上可行但非必须。是否复用/借鉴/自研属于决策，需 lead 定。

来源 S33（✅，2026-10-27）。

---

## 12. 已核实清单（可直接进规格的硬事实）

1. ✅ token 接口 `/app/getAppAccessToken`、7200s、60s 刷新窗口、HTTP 200 + body code、鉴权头 `QQBot {ACCESS_TOKEN}`（S2/S3）。
2. ✅ Identify token 当前格式 `QQBot {AccessToken}`（S4），官方 SDK 一致（S38）。
3. ✅ intents：`GROUP_AND_C2C_EVENT = 1<<25`、`INTERACTION = 1<<26`（S5）。
4. ✅ WS：`/gateway`、`/gateway/bot`、Hello `heartbeat_interval`、opcode 0/1/2/6/7/9/10/11/12/13、Resume 补发、关闭码表（S4/S5/S7/S8）。
5. ✅ 入站事件字段：C2C / 群 @ / 群全量；`group_openid` 在事件体顶层；`author.user_openid`（C2C）/`author.member_openid`（群）；`content` 在群 @ 事件已去 @ 前缀；`message_scene.ext` 含 `msg_idx`/`ref_msg_idx`/`auth_token`（S9/S10/S11）。
6. ✅ 出站接口路径与字段（msg_type 0/2/7、单聊 6）、msg_id/event_id/msg_seq、响应 `id/timestamp/ext_info.ref_idx`（S18/S19）。
7. ✅ 被动回复：单聊 60min/4 次、群聊 5min/5 次（S23 规范性表格）。
8. ✅ 主动消息频控三张表 + 单聊/群聊每日 1000 条上限 + 未认证限制（S23）。
9. ✅ 互动召回：`is_wakeup`、30 天、4 周期每周期 1 条（S23/S18）。
10. ✅ 流式消息仅 C2C、50 QPS、`input_state`/`index`/`stream_msg_id`/`remain_msg_len`、`40007` 前缀不可改（S22）。
11. ✅ Markdown 自定义内容对单聊/群聊所有机器人开放、无需模板（S25）；模板字段已标废弃（S18/S19）。
12. ✅ 富媒体：file_type 1/2/3/4、软/硬限、URL 直传/二进制 5MB/分片、`file_info ttl`（0=长期）、`srv_send_msg` 占用主动频次、单聊/群聊隔离（S26/S27/S29）。
13. ✅ 素材管理：`qqbot-media://`、≤10MB、100 张/机器人、90 天滑动过期（S30）。
14. ✅ 撤回：2 分钟限制、路径与 10 QPS、群管理员可撤回成员消息（S20/S21）。
15. ✅ 准入：企业公开、个人不公开、个人加自己群、开发体验用户、数量 5/10/50、管理员免沙箱测试、群内三项权限（S32/S33）。
16. ✅ 官方 Node SDK `qqbot-nodejs` v1.0.5 MIT Node>=20 ESM、仅依赖 ws（S38）。
17. ✅ 官方 DSH 插件 `dsh-qqbot` v0.5.3 MIT 及其默认配置（S39）。

## 13. 待核实 / 待实测清单（交给实施阶段）

| # | 事项 | 为什么重要 | 建议验证方式 |
|---|---|---|---|
| 1 | 🧪 纯文本与 markdown 的**精确字符上限** | 决定切分策略与是否触发 40054007/40054018 | 真实 Bot 逐级发 2000/3000/4500/5000/6000 字符，记录错误码/是否截断；文本与 markdown 分开测 |
| 2 | 🧪 入站附件 URL 的**有效期与是否需要鉴权** | 决定「收到即下载」策略与重试窗口 | 真实消息拿到 url 后隔 1min/10min/1h/2h 再 GET，记录 200/403；对比带/不带 Header |
| 3 | 🧪 C2C 被动回复真实窗口：60 分钟还是 5 分钟？第 5 次回复的错误码？ | 被动→主动回退逻辑 | 用 msg_id 在 5min/10min/60min 后回复，超过 4 次后继续回复，记录错误码 |
| 4 | 🧪 发送是否要求机器人 WS 在线（v2 群/单聊是否复用旧频道规则） | 适配器启动/降级策略 | 断开 WS 只走 HTTP 发一条，看是否报错（旧码 304018 或新码） |
| 5 | 🧪 API base 域名（`api.bot.qq.com` vs `api.sgroup.qq.com`）与 token 域名（`api.bot.qq.com` vs `bots.qq.com`）是否都可用 | 客户端 base URL 配置 | 两个域名各测 token + 发消息 |
| 6 | 🧪 event_id 被动回复 `INTERACTION_CREATE` 是否需要/允许带 `INTERACTION_CREATE:` 前缀 | 按钮审批回复 | 分别在带/不带前缀时调发送接口 |
| 7 | 🧪 主动消息回退的失败码映射（40034100/40034105/40054013/40034128/40034005/304103/40034026） | 决定重试/回退/告知用户 | 逐个构造场景（关开关、超频、超窗）记录真实 err_code |
| 8 | 🧪 `rkey`/附件 URL 是否与 appid 绑定、是否有单链接下载次数限制 | 多实例/重试下载 | 同一 URL 多次/异地下载 |
| 9 | 🧪 markdown 是否支持代码块/表格（文档未列） | AI 输出渲染策略 | 发含 ``` 代码块与 GFM 表格的 markdown，手机/PC 端观察 |
| 10 | 🧪 群全量模式的事件行为：是否同时收到 @ 事件、content 是否去 @ 前缀、`GROUP_MESSAGE_CREATE` 是否含 bot 自己的消息 | 全量模式去重/回环 | 群主开启全量后观察事件流 |
| 11 | 🧪 `intents` 权限申请：`GROUP_AND_C2C_EVENT` 是否默认可用（文档基础事件列表未含它） | 未申请时 WS 会 4014 断开 | 新 Bot 仅传 `1<<25` 连接，观察 READY/关闭码 |
| 12 | ⚠️ 开发体验用户**数量上限**与可配置范围 | 测试期准入 | 管理端「开发设置」实测 |
| 13 | ⚠️ 未认证机器人主动消息是否真实可用（频控表有「未认证」列，但注册/公开流程有限制） | 快速验证路径 | 用未认证 quick bot 发主动消息 |
| 14 | ⚠️ `GROUP_JOIN_REQUEST`、`FRIEND_DEL`、`subscribe_message_status` 等事件完整字段 | 白名单事件驱动 | 触发后抓事件 |
| 15 | 🧪 `upload_prepare` 日额度具体数值 / 超限错误码 | 媒体发送降级 | 压测上传 |
| 16 | 🧪 消息审核（MESSAGE_AUDIT）是否只对频道生效，群/单聊违规是否只靠 40034006 | AI 内容合规兜底 | 发违规样本观察 |
| 17 | 🧪 限频是否有响应头/Retry-After | 自适应限流 | 压测 429/100001 场景抓响应头 |
| 18 | ⚠️ `msg_seq` 合法范围（官方 SDK 生成 0..65535） | 多次被动回复 | 观测超范围行为 |
| 19 | 🧪 同一 inbound `id` 重复推送的间隔与幂等边界 | 去重 | 模拟弱网/重连 |
| 20 | ⚠️ 官方 `openclaw-qqbot` 的 npm license 元数据为空（仓库开源），若考虑复用需确认 LICENSE 文件 | 合规 | 查看 GitHub LICENSE |

## 14. 冲突清单（不同来源矛盾及矛盾点）

| # | 冲突点 | 甲方 | 乙方 | 当前取舍 |
|---|---|---|---|---|
| 1 | Identify token 格式 | 当前文档 + 官方 SDK：`QQBot {AccessToken}` | 旧文档 reference.html：`Bot {appid}.{app_token}` | 取 `QQBot {AccessToken}`；旧格式视为废弃 BotToken 体系（S1 明确 Token 鉴权已废弃） |
| 2 | API base / token base 域名 | 文档：`https://api.bot.qq.com`、`/app/getAppAccessToken` | 官方 SDK：`https://api.sgroup.qq.com`、`https://bots.qq.com` | 配置化 base URL，默认文档域名，备 SDK 域名（🧪） |
| 3 | 被动回复 C2C 窗口 | 概述/发送页开头：60 分钟 | 发送页 msg_id 字段：5 分钟；官方 DSH 插件：30 分钟 | 规格按 60min/4 次，实现按更保守 TTL（可配置），🧪 |
| 4 | 文本长度上限 | 官方 SDK/插件：~5000（默认切 4500） | 第三方：2000 | 按 5000 上限、4500 默认切分，🧪 |
| 5 | 入站去重 key | 文档「结合 msg_seq 去重」 | 事件体无 msg_seq；另有「结合 msg_idx 去重」 | 事件 `id` 主 key + `msg_idx` 辅助，🧪 |
| 6 | 群聊 Markdown 能力 | 消息类型矩阵：群聊「收发 ✅」 | 入站 message_type 无 markdown 类型 | 发送侧确定支持；接收侧按文本/引用处理，🧪 |
| 7 | 分片上传上限 | 文档：硬限 200MB | 官方 SDK：`CHUNKED_UPLOAD_MAX_SIZE=100MB`、一次性 20MB | 按平台文档 200MB 设计，保留 SDK 限额校验，🧪 |
| 8 | WS 关闭码语义 | 文档：4914=已下架沙箱、4915=封禁 | 官方 SDK 常量：4914=INSUFFICIENT_INTENTS、4915=DISALLOWED_INTENTS | 以文档语义实现（下架/封禁终止重连），SDK 命名不采信 |
| 9 | 4004 关闭码 | 文档关闭码表无 4004 | 官方 SDK：4004=AUTH_FAILED | 实现时按「鉴权失败→清 token 重连」处理（防御性），文档未列不影响 |
| 10 | Markdown 模板 | 发送 schema：template_id/custom_template_id「已废弃」 | Markdown 文档仍提供模板示例、错误码仍有「无模板权限」 | 规格采用自定义 `content`；模板路径视为兼容保留 |
| 11 | msg_id 有效期 vs msg_seq 去重 | 发送页：msg_id 5 分钟内有效 | 概述：被动 60 分钟 | 同冲突 3 |
| 12 | openclaw-qqbot 版本 | 官方 agent 文档更新日志到 2.0.3 | npm 最新 2.0.4（2026-09-23） | 若引用以 npm 为准 |

## 15. 对 Nokoribi Agent 适配的含义（仅列事实性影响，不做决策）

1. **协议层可以直接复用** `@tencent-connect/qqbot-nodejs`（MIT、仅 ws 依赖、ESM、Node>=20，与本项目 Node24/ESM 匹配），也可以只借鉴其 token/WS/媒体实现自写轻客户端；两者都需要自己实现「入站→ChannelDriver」与「审批/会话/白名单」业务层。
2. **官方 `@tencent-connect/dsh-qqbot` 与本项目同属 DSH 生态**（peerDeps `@deepseek-ai/dsh-*`），其模式（中间件链、access 黑白名单、reply-limiter、msgid-cache、chunker、媒体下载 SSRF 防护）可作为规格参考；是否直接依赖它、还是自己实现 ChannelDriver，需要 lead 决策（涉及依赖方向与「不自研协议层」的取舍）。
3. **群聊默认仅 @ 触发**；收到全量群消息需要群主在 QQ 侧授权 + 应用侧把 requireMention 关掉；这影响 Nokoribi「群白名单/触发策略」的默认值设计。
4. **被动回复窗口/次数是核心约束**：流式（C2C）与长任务输出必须考虑 4 次/60min（或更保守）与 5000 字符切分；多条回复需递增 msg_seq；超窗后只能主动消息（受配额、用户开关、认证类型限制）。
5. **审批交互可选内联键盘**：`INTERACTION_CREATE` + `PUT /interactions/{id}` + 用 `event_id` 被动回复，能在 QQ 侧做出「允许一次/始终允许/拒绝」按钮（按钮文字 ≤10 字符、modal 确认 ≤40 字符）。是否需要申请按钮权限：官方 FAQ 称已开放所有机器人（S32），仍需实测不同场景。
6. **附件下载**：收到事件后立即下载（URL 带 rkey，有效期未知），做 SSRF 防护、大小上限、超时；语音可用 `voice_wav_url` 与 `asr_refer_text`。
7. **AI 内容合规**：运营规范要求内容过滤、违规可封禁且不解封；建议接内容安全检测接口（官方文档未给具体接口，⚠️）。
8. **准入风险**：个人主体不能公开使用；群/私聊测试依赖「自己的群 + 开发体验用户」；新账号公开服务有审核期（约 3 天）；未完成认证时主动消息/公开能力受限。

---

## 16. 来源清单（访问日期均为 2026-10-27）

### 官方文档（bot.q.qq.com/wiki）

| ID | URL | 说明 |
|---|---|---|
| S1 | <https://bot.q.qq.com/wiki/develop/api-v2/> | 启动接入（AppID/AppSecret/Token 废弃） |
| S2 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html> | 获取访问凭证 |
| S3 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html> | API 调用指南（base URL、err_code、trace_id） |
| S4 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html> | WebSocket 方式（Identify/Resume/关闭码） |
| S5 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html> | 通用数据结构 / opcode / intents |
| S6 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/reference.html> | **旧版** WebSocket 文档（`Bot {appid}.{app_token}` 出处，可能过期） |
| S7 | <https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html> | 获取通用 WSS 接入点 |
| S8 | <https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html> | 获取带分片 WSS 接入点 |
| S9 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html> | C2C_MESSAGE_CREATE |
| S10 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html> | GROUP_AT_MESSAGE_CREATE |
| S11 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html> | GROUP_MESSAGE_CREATE |
| S12 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_add_robot.html> | GROUP_ADD_ROBOT |
| S13 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_msg_receive.html> | C2C_MSG_RECEIVE |
| S14 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_msg_receive.html> | GROUP_MSG_RECEIVE |
| S15 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html> | FRIEND_ADD |
| S16 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html> | INTERACTION_CREATE |
| S17 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html> | 互动事件响应 |
| S18 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html> | 发送单聊消息 |
| S19 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html> | 发送群聊消息 |
| S20 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html> | 撤回单聊消息 |
| S21 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html> | 撤回群聊消息 |
| S22 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html> | 流式发送单聊消息 |
| S23 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html> | 消息收发概述（时效/频控/去重） |
| S24 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html> | 消息类型矩阵 |
| S25 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html> | Markdown 消息 |
| S26 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html> | 富媒体消息概述 |
| S27 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html> | 单聊富媒体上传 |
| S28 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html> | 群聊富媒体上传 |
| S29 | <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html> | 预上传 |
| S30 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html> | 素材管理（qqbot-media://） |
| S31 | <https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html> | 错误与调试（公共错误码、WS 码） |
| S32 | <https://bot.q.qq.com/wiki/bot_FAQ/> | QQ Bot 常见问题（准入/权限/封禁） |
| S33 | <https://bot.q.qq.com/wiki/agent-qqbot/> | Agent 接入（官方插件、群全量模式、快速创建） |
| S34 | <https://bot.q.qq.com/wiki/business/> | 运营规范（内容安全/处罚） |
| S35 | <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html> | （对照）频道发消息：WS 在线要求、5 分钟被动等 |
| S36 | <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html> | Webhook 方式（回调端口 80/443/8080/8443、签名校验） |
| S37 | <https://bot.q.qq.com/wiki/develop/nodesdk/> | 旧 NodeSDK 接入指南（qq-guild-bot，频道向） |

### 官方 SDK / 官方插件（npm 包与源码，**二手佐证**）

| ID | URL | 说明 |
|---|---|---|
| S38 | <https://registry.npmmirror.com/@tencent-connect/qqbot-nodejs>（包内 `src/`，v1.0.5，MIT） | 官方 Node SDK：token、Identify、API base、文本 5000、reply-limiter、WS 常量 |
| S39 | <https://registry.npmmirror.com/@tencent-connect/dsh-qqbot>（v0.5.3，MIT） | 官方 DSH QQ 插件：默认配置、chunker、msgid-cache、附件下载、SSRF |
| S40 | <https://registry.npmmirror.com/@tencent-connect/qqbot-connector>（v1.2.0，UNLICENSED） | 官方扫码绑定 SDK |
| S41 | <https://registry.npmmirror.com/qq-guild-bot>（v2.9.5，2022） | 旧频道 NodeSDK |

> 说明：S38–S41 通过 npmmirror 镜像读取 npm 元数据与 tarball 内文件（本机网络无法直连 registry.npmjs.org / GitHub，见 §17）。这些是官方发布物，但按任务约束仍归入「二手」而非官方 wiki。

---

## 17. 访问失败 / 文档变更记录

| 情况 | 详情 | 处理 |
|---|---|---|
| URL 变更（302） | 以下旧路径返回 302、内容已迁移/更名：`dev-prepare/interface-framework/api.html`、`.../websocket.html`、`.../event.html`、`.../intents.html`、`server-inter/message/send-receive/overview.html`、`.../send.html` 等 | 改用当前有效路径：`dev-prepare/event-emit/*`、`dev-prepare/access-token.html`、`autogen/*`、`server-inter/message/*` |
| 环境网络限制 | 本机 `curl` 访问 `raw.githubusercontent.com`、`api.github.com`、`registry.npmjs.org` 均 TLS 失败；`web_fetch` 对 `raw.githubusercontent.com/.../README.md` 返回代理 404 | 改用 `registry.npmmirror.com` 读取官方 npm 包元数据与 tarball 内源码（S38–S41）；GitHub 仓库内容未直接读取，引用时以 npm 发布物为准 |
| 官方仓库链接 | <https://github.com/tencent-connect/qqbot-nodejs>、<https://github.com/tencent-connect/dsh-qqbot> 为官方仓库地址，本轮**未能直接抓取**（网络限制），内容依据 npm tarball | 标记为二手来源 |
| 文档双域名 | `bot.q.qq.com/wiki` 与 `bot.qq.com/wiki` 同时可访问，sitemap 结构一致；部分页面（如 `bot_new_product-intro`）仅作为入口页 | 以 `bot.q.qq.com` 为准，镜像用于补链 |
| 文档“上次更新”时间 | 网关页 2026-07-30、流式页 2026-07-22、群消息事件页 2026-10-21、Markdown 能力更新 2026-04-23 等 | 在对应事实处引用时保留 |
| 页面渲染截断 | 撤回群聊消息页，错误码表最后一行 `50065001` 的说明在本轮抓取内容中被截断（`openapi/error/error.html` 本身完整可读） | 标注「需回查」，未编造 |

---

*本文件仅包含调研事实与来源标注；数字/字段均来自上列来源，未在来源中出现的内容一律标注「待核实/待实测」，未做推测性补全。*
