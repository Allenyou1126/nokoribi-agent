# 11 模型与成本

## 11.1 模型角色

最终配置（D10/D63/D64/D83/D85/D87/D112）：

| 角色 | 配置方式 | 默认/约束 |
|---|---|---|
| 主 agent | NixOS module `models.main`（provider/model/reasoningEffort） | **必须支持图像输入**（入站图片直接给模型）；由配置选择 |
| 子代理（goal/任务） | M4：goal child 固定 `NOKORIBI_GOAL_MODEL`（D138）；M5 再接 `models.subagents` 白名单与主 agent 选择 | 默认 secondary/低成本档；主 agent 决定具体条目 |
| 记忆提炼子代理 | 配置的 secondary/低成本档 | 一次性、任务结束触发 |
| reviewer fast | `review.fast` | 日常所有工具调用先过这一档 |
| reviewer strong | `review.strong` | fast deny/不确定/sudo 动作时复审 |
| reviewer 超时 | `review.timeoutMs` | 默认 30s；超时 fail closed |

- 不再使用"主模型/便宜模型"的全局分层表述；**两个 tier 只属于 reviewer**（D85）。
- 主模型与 reviewer 模型相互独立；reviewer 不跟主模型绑定（由 vendored auto-review 补丁实现）。
- M4 的 goal child 通过宿主 `start_goal`/`/goal new` 启动，`agentOptions` 固定为 `NOKORIBI_GOAL_PROVIDER`/`NOKORIBI_GOAL_MODEL`；generic `subagent` 仍可继承主 agent 路由。per-goal 选择与 Nix allowlist 后移 M5（D138）。
- 主 agent 的模型切换（DSH 的 session model selection）在 v1 不作为主要交互；IM 未暴露 `/model` 命令。

## 11.2 图像输入

- 主模型必须支持图像输入（D16）。**M2 尚未实现图片附件链路，入站图片仍返回 501；能力位暂为关闭。**
- 实现前用用户的 API key 查 `dsh-llm-deepseek` 的模型目录，确认可用多模态模型；Nix 配置 `models.main` 指向该模型。
- 若没有可用多模态模型：**入站图片直接告知用户"当前模型不支持图片"**（D69），不落盘、不 OCR、不外接视觉模型。渠道能力 `inboundImages` 可先声明为 false。
- 子代理模型是否支持图像由主 agent 选择；goal child 一般不需要图片。

## 11.3 Auto review 的成本

- 上游 auto-review 对**每次工具调用**都发一次 reviewer 模型请求；本项目的 sandbox 工作流会产生大量 `cp`/`rsync`/构建命令，工具调用次数高（尤其 goal 子代理）。
- 两阶段策略控制成本：
  - 所有调用先过 fast（低成本档）；
  - 只有 fast 返回 deny/不确定或动作含 sudo/root 时，才追加 strong 请求；
  - strong allow 则执行，strong deny 则走 IM 单次授权。
- 最坏情况（大量 sudo/复杂动作）会同时消耗 fast + strong；这是安全换成本的显式取舍。
- reviewer 请求不缓存、不重试、不压缩；超时/超窗会失败（fail closed）。
- 成本/延迟直接与工具调用数相关：系统提示词要求模型合并命令、减少无意义工具调用。

## 11.4 上下文与压缩

- 主会话是长期单会话，上下文会持续增长。
- 挂载 `dsh-compaction-basic` + `dsh-compaction-tool-result-pruner`：
  - 接近上下文上限时自动摘要旧历史；
  - 工具结果先修剪再压缩；
  - `/compact` 可手动触发；
  - 压缩本身消耗一次模型请求。
- 可调参数（按模型/路由覆盖）：阈值、保留近期消息数等；在 M5/M6 用真实数据调。
- `dsh-token-meter` 可用于估算上下文压力/展示用量；不改变模型可见内容。
- v1 不做图像 offload、不做独立 session 搜索/记忆注入。
- 提示词稳定性：静态段保持稳定，动态值走 runtime context（时间），减少 KV cache 失效。
- SOUL.md 控制在 ≤4KB；AGENTS.md 预算 64KB（但实际应保持小）。
- `dsh-time-context` 用 `refreshIntervalMs` 控制注入频率（草案 30–60 秒；具体实现调）。

## 11.5 预算与守卫

- **不做 token 预算插件**（D70）：没有每日/每会话 token 上限、没有超限自动暂停。
- goal 的成本守卫：
  - `maxGoalRounds`（DSH goal 自带；创建时指定）；
  - `/stop`（只停主 agent）、`/goal pause`、`/goal clear`；
  - 轮次耗尽会由 round-driver block。
- 子代理数量不受限（D96）；长期数量靠归档控制。
- 若未来需要预算，可从 `agent/turn-stopping`/`token-meter` 做插件，但不属于 v1。

## 11.6 模型选择的实现注意

- `dsh-tool-subagent` 的 `modelSelectionSettings: true` 会向模型暴露允许的子级模型；`agentOptions` 提供默认 provider/model/reasoningEffort。
- 主 agent 在 spawn 时选择模型；goal child 的模型会记录在 subagent descriptor 中，冷恢复使用同一路由。
- reviewer 模型由我们的补丁直接解析配置，不依赖当前 agent 模型。
- 若 API 模型目录变化/模型下线：启动时解析路由会失败；需要 `nixos-rebuild` 更新配置。
- 不同模型 context window 不同：compaction 的按模型覆盖要随主模型配置。

## 11.7 未知与待验证

- 用户 API key 下实际可用的模型 ID 与是否支持图像（实现前查目录）。
- 各模型 JSON 输出稳定性（尤其 strong reviewer 的风险分类）。
- 两档 reviewer 的价格/延迟取舍（需要实测）。
- 主模型是否支持 1M 上下文（DSH 的 `defaultContextWindow` 配置在 sdk-minimal 里用环境变量设置；本项目的模型 context 需按适配器信息配置）。
- compaction 阈值与长会话实际增长速率需要在 M5/M6 实测。

## 11.8 成本相关已接受项

- Auto review 每工具调用一次的额外开销（D31/D64）。
- 无 token 预算、无自动停止（D70）。
- goal 自动续跑会消耗模型调用直到轮次上限/手动停止（D22/D70）。
- 记忆提炼子代理按里程碑触发，有额外模型调用（D68）。
- schedule 提醒本身不消耗模型调用，但主 agent 被唤醒后回复会消耗。
