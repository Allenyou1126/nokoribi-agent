# 24 提问按钮（M15）

> 状态：**代码完成（2026-10-30）；真实平台门禁待执行**（M15 只可标“代码完成”）。M15 已实现 `ask_user_question` 单选选项按钮（core action/token + QQ C2C keyboard + 文本 fallback）。实现口径见 [D181](03-decision-log.md)；测试记录见 [13.1](13-testing-and-ops.md)。

## 24.1 目标

把 `ask_user_question` 的选项从“纯文本编号回复”升级为可点击按钮（M9 审批按钮的复用），同时保留完整文本 fallback。范围：

- broker 为符合条件的提问生成 callback actions，点击走 M9 的 action 权威路由，结算该提问；
- QQ 只在 C2C 渲染提问键盘，由独立配置 `questionButtons` 门禁；群聊保持文本；
- local-test 沿用既有的 action 注入能力，用于进程测试。

不在范围：多选按钮（`multiSelect=true` 仍为文本编号）、自由文本按钮、超过 10 个选项的分页按钮、按钮点击后的额外确认消息（沿用 M9：不补发确认，依赖平台 ack 反馈）。

## 24.2 契约

M14 已在 `OutboundContent`/outbox 增加 `actionKind?: "approval" | "question"`（M15 使用）；`OutboundAction` 复用 D163 的定义，无新字段。

- `actionKind` 随 actions 一起只附在最后一段/交互提示条目上并持久化（旧 outbox 条目无该字段按 `approval` 处理，M9 行为不变）。
- action token 仍是内存态短 token，payload `{"k":"<token>","t":"<label>"}`；token→目标的映射在 settle/abort/timeout 或换题时清理，重启后失效。
- 提问按钮规则（broker 展示时判定，逐题）：
  - 单选（`multiSelect !== true`）且 `options` 非空、`options.length <= 10` → 生成每个选项一个 callback button；
  - 多选、无 options、options > 10 → 不生成 actions，文本 fallback 完全不变；
  - label 截断到 ≤10 字符（超出保留 9 字符 + `…`）；token 的 `t` 与显示 label 一致。
- token 作用域为 `(interactionId, questionIndex)`：旧题/旧批次的 token 不再匹配当前题，点击返回“已失效”提示，不会被当作文本答案。

## 24.3 channel-core / broker 行为

1. `presentQuestion()` 为当前题调用 `questionActions()`：
   - 命中按钮规则且当前题已有缓存 actions → 复用（重发帮助文本/reprompt 时 token 不变）；
   - 否则清理旧 token，为每个选项生成新 token 与 actions，缓存 `(actions, actionIndex)`。
2. `sendPrompt` 携带 `actionKind: "question"`；无 actions 时不携带，driver 不会收到键盘相关字段。
3. `handleAction()`：
   - token 查表 → 校验 `active` 展示中、未结算、interactionId 匹配；
   - `approval` 分支维持 M9（结算审批）；`question` 分支额外校验 `questionIndex === active.index`；
   - 命中后构造 `{id: question.id, selected: [option.label]}` 并复用 `applyAnswer()`：记录答案 → 还有下一题则展示下一题（重新生成该题按钮）→ 否则 `resolveQuestion()` 结算整个批次；
   - 点击成功不发送确认消息；未知/过期 token 返回 false，由 channel-core 发一次“按钮已失效”（M9 语义）。
4. 文本回复路径不变：编号/选项 label/多选编号/自定义文本仍由 `parseQuestionReply()` 处理并调用同一个 `applyAnswer()`。
5. 超时/abort/`/stop`/`/clear`/shutdown 清理 token 的行为与 M9 一致；提问超时仍以 `ASK_ABORTED` 让工具报错。

## 24.4 QQ driver

- 能力位：`outboundActions`/`inboundActions` = `(approvalButtons || questionButtons) && gateway.interactionAvailable()`；`INTERACTION_CREATE` intent 也随两者任一开启而订阅（4014/4914/4915 自动降级为纯文本，沿用 M9）。
- 发送时按 `content.actionKind` 选择门禁：`question` → `questionButtons`；其余（含旧条目无 actionKind）→ `approvalButtons`。
- 渲染与 ack：与 M9 完全相同的 `buildKeyboard()`（label 截断、最多 2 按钮/行）与「先 `PUT /interactions/{id}` ack 再 ingress」顺序；`type=11` 回调统一 ack code 0。
- 群聊：不渲染任何键盘（提问与审批一致），action 被剥离，文本 fallback 保留。
- 点击后 agent 的正常输出仍按常规回复镜像。

## 24.5 配置

| 位置 | 键 | 默认 | 说明 |
|---|---|---|---|
| QQ driver | `questionButtons` | `true` | C2C 提问按钮 + interaction intent；false 时提问只有文本 |
| QQ driver | `approvalButtons` | `true` | M9 审批按钮，保持独立 |
| Nix | `channel.qqBot.questionButtons` | `true` | 映射到 bundle 行 `questionButtons` |

能力位与 intent 订阅是两者 OR；单独关闭一个不会影响另一个。local-test 无新配置。

## 24.6 安全与边界

- 按钮 payload 只有短 token 与 fallback 文案，不含提问正文/答案；日志不记录正文。
- action 权威路由：错误/过期/跨题 token 不会被解析为文本答案，避免旧按钮误答新提问；一次提示只结算一次。
- 文本 fallback 永远保留：即使按钮发送失败或平台拒绝 intent，用户仍可编号作答（M9 降级路径复用）。
- 平台限制：QQ 群聊无键盘；问答按钮的渲染样式/ack 行为待真实平台门禁验证。

## 24.7 测试与验收

自动测试（M15 已实现）：

- `packages/channel-core/test/broker.test.ts`：单选生成按钮、点击结算、双击/旧题 token 失效、多选/无选项/超 10 选项文本 fallback、label 截断 ≤10、超时后 token 清理、审批按钮行为回归。
- `packages/channel-core/test/service-action.test.ts`：问题提示 outbox 携带 `actionKind:"question"` + actions；action 入站结算；编号文本 fallback。
- `packages/channel-qq-bot/test/driver.test.ts`：C2C 提问键盘渲染、`questionButtons=false` 时剥离/审批仍渲染、`approvalButtons=false` 时提问仍渲染、群聊剥离、question 回调 ack code 0。
- `packages/channel-qq-bot/test/gateway.test.ts`：两者都关时只订阅消息 intent；其余组合订阅 interaction intent。
- `tests/integration/m15-question-buttons.test.ts`：真实 ChannelService+QQ driver（fake REST/WS）：C2C 键盘按钮点击结算、编号文本 fallback、群聊文本 fallback。
- `tests/process/m15-question-buttons.test.ts`：真实 daemon + scripted LLM + local-test：`ask_user_question` 工具 → outbound 出现 action 按钮 → action 注入结算 → 工具结果含所选 label；编号文本 fallback 同样通过。

真实平台门禁（未执行）：

1. QQ C2C 提问键盘在真实客户端的渲染（label 宽度、按钮行数、`action.permission` 权限）。
2. 点击提问按钮的 `INTERACTION_CREATE` ack 行为与 M9 审批一致（`PUT /interactions/{id}` 只可回应一次）。
3. 长 label/多选项下的平台截断表现（本地已截断，仍需实测）。
4. 群聊确认无键盘渲染（预期仅文本）。

## 24.8 实现记录

- 2026-10-30 完成 broker/服务路由/QQ 门禁与自动测试；真实平台门禁未执行，M15 不能标“完整验收通过”。
- 与 M14 共用 `actionKind` 持久化实现（shared schema 不改，channel-core `outboxEntry()` 类型化视图）。
