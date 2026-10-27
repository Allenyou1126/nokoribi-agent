# 参考实现：Hermes Agent 的 QQ Bot 通道

> 调研日期 2026-10-27；来源：`NousResearch/hermes-agent` 仓库 `main` 分支源码（raw.githubusercontent.com 抓取）与官方文档。
> 用途：为 D161（提醒/通知降级）与 M8 QQ driver 设计提供参考；外部项目仅作事实参考，不复制代码。

## 1. 结构

- 源码位置：`plugins/platforms/qqbot/`（`adapter.py` 1670 行、`send.py` 249 行、`register.py` 158 行、`gateway_env.py`、`constants.py`、`keyboards.py`、`onboard.py` 等）。
- 官方文档：<https://hermes-agent.nousresearch.com/docs/user-guide/messaging/qqbot>
- 能力：WebSocket 网关收事件、REST v2 发文本/Markdown、图片/语音/文件、语音 ASR、guild/C2C/group、C2C 流式、按钮审批。

## 2. 入站

- `_on_message`：按事件类型分发到 `_handle_c2c_message` / `_handle_group_message` / `_handle_guild_message` / `_handle_dm_message`；`msg_id` 去重（`MessageDeduplicator`，有 TTL/上限）。
- 群 @ 消息：`_strip_at_mention(content)` 去除 @ 前缀。
- 每个 chat 缓存最近一条入站 `msg_id`：`self._last_msg_id[chat_id] = event.message_id`（`handle_message` 覆盖），用于：
  - 审批提示 `send_approval_request(..., reply_to=self._last_msg_id.get(chat_id))`
  - 更新确认提示、`send_typing`、C2C 流式（`passive_msg_id`）
- 访问控制：`dm_policy` / `group_policy` = `open | allowlist | disabled | pairing`，`allow_from` / `group_allow_from`；配置或环境变量。

## 3. 出站 / 被动回复

- `send(chat_id, content, reply_to=None)`：`truncate_message` 分段（`MAX_MESSAGE_LENGTH = 4000`），首段可带 `reply_to`，后续段不再带；失败重试 3 次（指数退避），`_PERMANENT_SEND_ERRORS = ("invalid","forbidden","not found")` + `"bad request"` 视为永久。
- `_send_text_to(...)`：若 `reply_to` 存在则请求体带 `msg_id`；`msg_seq` 用 `_next_msg_seq()` **随机/时间派生**（0..65535），不保证重试幂等。
- Markdown：配置 `markdown_support: true` 时用 `msg_type=2` + `markdown.content`；否则 `msg_type=0`。支持 `message_reference`（当有 reply_to 且非 markdown 时）。
- 富媒体：先 `/v2/{users|groups}/{id}/files` 上传拿 `file_info`，再 `msg_type=7` 发送；分片上传、SSRF 防护（openclaw 插件侧）。

## 4. 主动消息 / cron / 提醒（与 D161 直接相关）

- 配置：`QQBOT_HOME_CHANNEL`（OpenID，用于 cron/通知投递；`QQBOT_HOME_CHANNEL_NAME` 显示名）；注册流程 `hermes gateway setup` 会询问并写入。
- cron 投递路径：`cron/scheduler_delivery.py` → 目标解析（origin/home/explicit/bot-chat）→ 活适配器 lane（`adapter.send(chat_id, content)`）或 standalone lane（`tools/send_message_tool._send_to_platform` → `qqbot/register.py::standalone_send` → `qqbot/send.py::send_qqbot`）。
- **`adapter.send` 在 cron 路径不带 `reply_to`**（`_send_via_adapter` 只传 `metadata`），因此请求体**没有 `msg_id`** → 属于平台定义的“主动消息”。
- `qqbot/send.py::_qqbot_send_text_message`：依次尝试 `channels/{id}/messages` → `v2/users/{id}/messages` → `v2/groups/{id}/messages`，payload `{content[:4000], msg_type:0}`，**无 msg_id**；失败时返回 `QQBot send failed: channel=… c2c=… group=…`，由 cron delivery ledger 记录/重试。
- 没有发现：等待下一次入站再补投（defer）、`is_wakeup` 互动召回、主动失败转被动、按被动窗口调度。也没有针对 2025-04-21 “主动推送下线”的专门处理；文档仍把 `QQBOT_HOME_CHANNEL` 描述为 cron/notification 投递目标。
- 结论：**Hermes 的方案 = 主动消息尝试 + 有限重试 + 失败记录**（还带 home channel 路由概念）。若平台确实不再允许主动推送，Hermes 的 QQ 定时提醒同样会失败；它没有提供“被动窗口外仍能送达”的机制。

## 5. 其他可借鉴点

- `QQBOT_HOME_CHANNEL`：显式配置 cron/通知的投递目标（对应我们“通知目标 chat”问题；但没有解决无 msg_id 时无法送达）。
- `dm_policy` / `group_policy` + allowlist：比“只靠平台限制”更强，可作为未来 D152 的升级路径。
- 按钮审批：内联键盘 + `INTERACTION_CREATE` + `PUT /interactions/{id}`，用 `_last_msg_id` 作被动回复 `msg_id`（我们后置）。
- 流式（C2C）：`stream_messages` + `passive_msg_id` + `msg_seq`，要求“新全文必须以前一全文为前缀”；我们后置。
- 文本上限使用 4000（比官方 SDK 的 5000 更保守），Markdown 开关配置化。
- 与我们的差异：Hermes 没有 channel-core 式的持久 outbox/去重/审批 broker；它的“主动消息失败记录”依赖 cron ledger。我们可在 outbox 层做得更强（稳定 replySeq、错误分类、D161 降级策略）。

## 6. 对 D161 的候选（供决策）

- **A. Hermes 同款**：active 尝试 + 退避重试 + 失败记录/告警；不做 defer。最简单、与成熟实现对齐；平台下线时提醒丢失。
- **B. Hermes 同款 + defer**：active 失败后把通知留在 outbox，等该 chat 下一次入站时以被动回复补投；用户下次对话能看到补发提醒（我们已有 core+outbox 回复上下文，实现增量可控）。
- **C. defer 为主**：不尝试 active（避免无意义失败日志），直接等下次入站补投/或依赖其他推送渠道。
- 推荐：**B**（先尝试 active，失败可解释；defer 保底不丢提醒），在规格中记为 D161；若平台实测仍有可用主动消息则 B 的 defer 几乎不触发。
