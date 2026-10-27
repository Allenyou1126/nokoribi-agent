# QQ 官方 Bot 平台事实门禁记录

> 状态：**待真实 Bot 实测（2026-10-27 创建）**。M8 代码与 fake 自动化已完成；本文件的 14 项门禁需要 AppID/ClientSecret、开发体验用户与自己的群，由用户配合执行。执行后把结果写回本表，并同步 [.spec/17](../17-qq-official-bot.md) 17.10 与 [事实表](qq-official-bot-api-facts.md) §13。

## 探针

```bash
# 凭据只放到环境变量；生产走 systemd EnvironmentFile/agenix
export NOKORIBI_QQ_BOT_APP_ID=...
export NOKORIBI_QQ_BOT_CLIENT_SECRET=...

# token 域名（api.bot.qq.com vs bots.qq.com）
node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --token

# WebSocket 连接/READY（只打印事件摘要，不打印 token）
node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --gateway
node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --watch

# 被动回复（用 --watch 拿到事件 id 与 openid）
node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --passive \
  --chat c2c:<user_openid> --message-id <event-id> --seq 1 --text "probe"

# 主动消息（最高优先级冲突）
node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --active \
  --chat group:<group_openid> --text "probe"
```

## 14 项门禁

| # | 事实 | 验证方式 | 结果/日期 | 结论 |
|---|---|---|---|---|
| 1 | 主动消息可用性（官方 2025-04-21 下线 vs 配额表） | `--active`；记录 HTTP/bizCode（`40034105`/`40054013`/`40034100`/社区 `40034102`） | 待实测 | 决定 `activeMessageFallback` 默认与验收口径 |
| 2 | WebSocket vs webhook | `--gateway`/`--watch` 真实连接与收发 | 待实测 | 若 WS 不可用，升级 D150 |
| 3 | token/API 域名与鉴权 | `--token` 两域名；`--gateway`/`--passive` 验证 `Authorization: QQBot` 与 Identify token | 待实测 | 决定默认 base URL |
| 4 | 被动窗口/次数 | 单聊 60min/4 次、群 5min/5 次；超窗/超次数错误码 `40034128`/`304103`/`40034005` | 待实测 | 校准窗口与安全余量 |
| 5 | `msg_seq` 语义 | 同 `msg_id`+同 seq 重试；`40054005` 行为；seq 递增边界 | 待实测 | 校准 at-least-once |
| 6 | 文本/Markdown 上限 | 2000/3000/4500/5000/6000 逐档；代码块/表格渲染 | 待实测 | 校准 `maxTextLength`/`markdown` |
| 7 | URL/内容限制 | 含 URL 发送；`40054010`；违规 `40034006` | 待实测 | 决定是否 strip URL |
| 8 | 发送是否要求 WS 在线 | 断 WS 后只走 REST 发送 | 待实测 | 决定离线发送策略 |
| 9 | 事件字段 | 群 @ 去 @、`group_openid`、`msg_idx/ref_msg_idx`、重复推送间隔 | 待实测 | 校准 normalize/去重 |
| 10 | intents 权限 | 仅 `1<<25` 是否 READY；是否 4014 | 待实测 | 若需申请，记录申请路径 |
| 11 | 频控/错误码全集 | 逐类构造 100001/40034100/50055001/2/40054007/10/13 | 待实测 | 校准错误映射 |
| 12 | 准入/沙箱 | 开发体验用户数量、个人主体不可公开、群三项权限、封禁不可解封 | 待实测 | 部署边界确认 |
| 13 | 目标机网络 | 目标机 TLS/DNS 直连 `api.bot.qq.com`/`api.sgroup.qq.com`；代理 | 待实测 | 部署前置 |
| 14 | 附件 URL（V8 门禁） | URL 有效期/鉴权/大小/rkey 绑定 | 待实测 | V8 范围，M8 只忽略 |

## 已知实现口径（非门禁结论）

- SDK 把 `4009` 视为 `SESSION_TIMEOUT` 并重新 Identify（不是 Resume）；其它可恢复断线（如 1000/4008）走 SDK 的 Resume。这是 SDK 1.0.5 行为，与规格“4009 可 resume”的事实描述不同，已记录在 D164。
- 业务错误可能是 HTTP 200 + body `code`；driver 在 REST 层显式检查，不依赖 SDK `ApiClient` 的非 2xx 判断。
- `msg_seq` 只随 `msg_id` 发送；active 消息不发送 `msg_seq`（driver 直接走 `ApiClient`，不经过 SDK 的自动注入）。
