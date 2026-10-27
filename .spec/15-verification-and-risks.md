# 15 待验证项与风险

## 15.1 实现前必须验证的 9 项（来自规划收尾）

| # | 验证项 | 为什么 | 验证方式 | 失败时的回退 |
|---|---|---|---|---|
| V1 | IM-only profile 里能否程序化设置 Auto 预设，且 permission-presets 正常挂载 | auto-review 依赖 Auto preset；README 按 Web profile 写 | 用锁定 0.2.1-rc.3 起一个无 Web 的测试 profile，检查 `permissionPresets.registerAuto()`、当前 preset、`/permission` 行为 | **已验证（M2）**：完整 bundle 启动，主会话 create/resume 后 `permissionPresets.set(session,"auto")` 成功；`/permission` 只读；进程测试覆盖。失败时仍按原回退，不降级为无审查 |
| V2 | patched auto-review 的双档 reviewer 与 child 审批桥接是否可行 | 上游未导出评审函数；child 固定 `never`；需求 D64/D131 | vendor 后做最小补丁，用 fake LLM 跑工具调用与子代理场景 | **已验证（M2）**：fast/strong 两阶段与 child deny→`ask` 补丁可用；testkit 集成测试覆盖 child → broker → IM 允许 → 工具执行。仍保留 report 回退 |
| V3 | goal 冷恢复时序：`sendMessage` → child live → `ctx.goals.resume` 重新 arm | goal 在 session-start 必 disarm；冷恢复只有 sendMessage 路径 | 进程级测试：kill daemon → 重启 → 观察 child live/阶段/arm 状态 | **已验证（M4）**：`tests/process/m4.test.ts` 覆盖 SIGKILL 后冷恢复、re-arm 与后续轮次；恢复失败场景保留 tracked 并通知。 |
| V4 | resume 后 inbox 是否自动处理 | 排队消息持久化，但 driver 是否自动唤醒未确认 | 进程级测试：消息入 inbox 后 kill → 重启 → 是否自动继续 | **已验证（M1）**：resume 会恢复 `next-turn` inbox，但不会自动开启新轮；M1 用“用户下一条消息/显式唤醒”消费，未加 bridge 重放。若 M2 需要立即处理，采用系统提示唤醒或入站队列重放。 |
| V5 | schedule 工具安装时序 vs 主会话创建 | rc.3 schedule 是 Host-wide；交付依赖 `sessionController`，启动时主会话可能尚未 ready | 启动恢复测试：创建短 remind → SIGKILL → 过期后重启 → 是否交付 | **已验证（M5）**：`tests/process/m5.test.ts` 覆盖到期与 SIGKILL 逾期；最小 `sessionController` 桥在 daemon ready 前阻塞交付。上游无自动重试定时器；失败需后续 wake/restart |
| V6 | Nix buildEnv + 运行时 `nix shell` 叠加的性能 | sandbox 默认 host，命令延迟影响体验 | 在开发机/目标机实测：首次/缓存后命令延迟；加包耗时 | **M3 已实测（开发机、Nix 缓存命中）**：base-only wrapper 约 4ms/命令，`nix shell nixpkgs#hello` 叠加约 28ms/命令；首次 fetch/realize 另计。M6 已生成更大 buildEnv，目标机复核仍待 12.12 手工。 |
| V7 | pnpm 依赖在 Nix 固定输出构建中的可行性 | 发行版要可复现、可离线 | 写 package.nix，跑 `nix build` | **M6 已验证**：`fetchPnpmDeps`（fetcherVersion 4）+ `nix build .#default` 成功；运行时使用官方 Node 24.21.0（D145）。升级/DSH bump 时需更新 hash 并复测 native addon。**2026-10-27 目标机复测补充**：D145 wrapper 使 `process.execPath` 指向 loader，DSH subprocess runner 因此无法启动（D148）；已用 `node-shim` + execPath preload 修复，并在目标机验证 native scope 与 daemon 启动。改 wrapper/Node 策略后必须重跑目标机 subprocess 冒烟。 |
| V8 | 主模型是否有支持图像输入的 API 模型 | 入站图片直接给模型（D16） | 用 API key 查 `dsh-llm-deepseek` 模型目录；实际发图测试 | **仍待验证**：M6 未接图片链路；图片仍 501。无模型则按 D69 明确告知不支持，能力位关闭。 |
| V9 | 主 agent 隐藏 goal 工具的实现方式 | D101 要求 main 不能建 goal | 阅读 `dsh-tools` 的 agent 限制 API；用 fake agent 测试可见工具 | **已验证（M4）**：main agent setup 用 `agentCtx.tools.restrict({deny:[create_goal,get_goal,update_goal]})`；进程测试确认工具 schema 不含 goal 工具，误建事件仍由 `goal/changed` 清理。 |

> V6 M3 补充：除性能数据外，已用真实 `buildEnv { bash coreutils }` 直连 `ShellRouter` + `SandboxHost` 验证 cwd、`DSH_SANDBOX_DIR`、workspace→sandbox `cp`、sudo shim、`nixpkgs#hello` 临时包与 reset 清包；`rsync` 未包含在该最小 baseEnv，未单独验证。

> V3 M4 补充：goal child 在自动 round 期间会保持 Activation 驻留到 complete/轮次上限；`startActivation` 预留 `goal-*` id + 宿主 `ctx.goals.create()` 可正常驱动。`dsh-session-query-sqlite` 以 `openAt:"never"` 提供 `listChildren` 所需的精确读取。

> V5 M5 补充：rc.3 `dsh-schedule` 不再给"插件加载后创建"的 agent 安装工具，而是 Host-wide 服务；交付依赖 `ctx.sessionController.resolveAgent()`。我们用最小 bridge 只解析当前 main，并在 `drainBuffered()` 后 markReady，进程测试覆盖了到期与 SIGKILL 逾期。

## 15.2 其他实现期需确认的点

1. `/clear` 时 outbox 中属于旧会话的未发送回复：M1 决定**保留并继续发送**（已写回 06/05）；后续里程碑如改变需再记录。
2. 消息分段算法的具体边界（代码块、编号、超长单行）与平台差异。
3. reviewer sudo/root 启发式的具体模式与误报处理。
4. 测试通道 `seq` 日志的保留条数与持久化格式。
5. 审批/提问多问题批次的逐题呈现与超时计算方式。
6. sandbox 后台任务与 reset/TTL 的具体交互（拒绝/终止策略）。**M3 已定**：有活跃命令时 `reset` 拒绝；TTL sweep 跳过活跃 sandbox；`disposeSession` 在 `/clear` 时终止 handle 并删除目录。
7. memory `index.json`：M5 明确不做，纯扫描 `entries/*.md`；后续数据量增长再评估。
8. 归档索引与 session 文件的清理策略（当前不清理）。
9. sd_notify 的 Node 实现选型与 watchdog 周期。**M6 已定**：`systemd-notify` 子进程 + `NotifyAccess=all`；间隔为 `WATCHDOG_USEC/3`，unit 默认 `WatchdogSec=120`（D144）。
10. systemd `KillMode`/`TimeoutStopSec` 与关闭等待时长的最终值。**M6 已定**：`KillMode=mixed`、`TimeoutStopSec=45`、`TimeoutStartSec=300`；`NOKORIBI_READY_TIMEOUT_MS=0` 由 systemd 兜底（D144/D147）。
11. `dsh-session-log-deepseek`、`dsh-deepseek-llm-api-extensions`、`dsh-plugin-package-inventory-deepseek` 等 DeepSeek 相关包是否必须随 `llm-deepseek` 挂载（sdk-minimal 里出现，需核对）。
12. `dsh-shell`/`dsh-bash-local` 的替代是否影响其他包（如 hooks、terminal、permission-presets 的 sandboxMode 要求）。
13. 真实 IM 适配器的消息长度/markdown 能力参数。
14. DSH 升级（0.2.1-rc.3 之后）对 session format 与包 API 的影响。
15. `dsh-tool-subagent` 的 `modelSelectionSettings`：rc.3 要求 scoped preset/composition Context；全局 bundle 行不可用，M5 后移（D141）。per-goal 选择由 `start_goal`/`NOKORIBI_GOAL_MODELS` 承担。
16. deferred notices 的 reply 边界：M7 对 notice 与“无可用入站上下文”的 reply 做 defer；有上下文但被动过期的长任务回复只做 active 重试，是否也 defer 留给 M8 真实平台实测后决定。
17. `replySeq` 由 retained outbox history 推导；极端历史裁剪下可能重复 slot，M8 已按 `40054005` 去重语义收口；真实平台边界待 14 项门禁。
18. 按钮审批 UX 与 `INTERACTION_CREATE` 的 `event_id` 前缀、`PUT /interactions/{id}` ack 仍在事实门禁中（D163 只预留契约；M8 不实现）。
19. M8 真实 Bot 14 项平台事实门禁与 17.8.2 尚未执行；代码只按保守默认与 fake 自动化验收。门禁记录见 `.spec/notes/qq-fact-gate.md`。
20. SDK 1.0.5 把 WS 关闭码 4009 当 `SESSION_TIMEOUT` 并重新 Identify（不是 Resume）；其它可恢复关闭走 Resume。真实平台若依赖 4009 resume，需后续评估。

## 15.3 风险登记

| 风险 | 等级 | 影响 | 缓解/接受 |
|---|---|---|---|
| DSH 仍在 rc，API/行为变化 | 高 | bundle 行/插件接口失效、升级成本 | 锁版本；只依赖稳定 seam；升级整批 bump + 测试 + 文档复核 |
| auto-review 实验性误判 | 高 | 误放行 root 危险操作 / 误拒绝 | 双档 reviewer、fail closed、IM 授权；残余风险已接受（D103） |
| sudo `NOPASSWD: ALL` + 无硬化 | 高 | 整机级破坏/持久化控制 | 唯一闸是 reviewer；无备份/回滚（已接受） |
| 无备份/无自动回滚 | 中高 | 数据/系统损失不可恢复 | 用户明确接受（D105/D84）；升级直接进行（D110） |
| session format 升级不兼容 | 中高 | 回滚后旧版本读不了会话 | 固定版本、手动升级；接受回滚风险；升级前可人工快照（未强制） |
| 冷恢复多一轮/时序不稳 | 中 | goal 重复执行/暂停 | M4 已进程级验证；失败保留 tracked + 通知 + `/goal resume` 重试；多一轮已接受 |
| nix shell 启动慢 | 中 | sandbox 命令延迟、体验差 | 预构建 buildEnv；临时包才 nix shell；实测调优 |
| sandbox 依赖缺失（setpriv/nix/baseEnvironment） | 中 | 默认 sandbox host 命令失败 | M3 返回明确错误；M6 部署检查 util-linux/nix/buildEnv；开发可切 local |
| DSH native addon 与 Node 构建不兼容 | 高 | profile 无法启动 | D145：固定官方 Node 24.21.0，wrapper 经 Nix loader；D148：execPath shim；升级 Node/DSH 时必须重跑 package runtime smoke 与目标机 subprocess 冒烟 |
| 官方 Node loader wrapper 改变 `process.execPath` 语义 | 中 | 依赖 execPath 的 DSH runner 静默失败（D148 已出现一次，bash 全挂） | D148 的 `node-shim` + `--require` preload；flake package-smoke 断言；包装/Node 变更时跑目标机 subprocess 冒烟 |
| NixOS 手工验收未执行 | 中 | 生产行为漏检 | 当前开发机非 NixOS；12.12 必须目标机执行，M6 不宣称完成 |
| 主模型无图像能力 | 中 | 入站图片不可用 | 查目录；无模型则明确不支持（D69） |
| prompt injection（网页/工具结果） | 高 | 诱导危险动作 | reviewer 把外部内容视为 fact；系统提示词；残余风险接受 |
| 子代理审批补丁复杂 | 中 | goal 工具被拒后无法请求用户 | V2 已验证；补丁写 child `ask` 并修正 delegation 文案；仍保留 report 回退 |
| 多 goal 汇报噪声/token 消耗 | 中 | 主 agent 被刷屏、成本上升 | 提示词约束里程碑汇报；无并发上限（D96）为用户选择 |
| memory 全局跨项目泄露 | 中 | 项目事实混在一起 | 只全局（D67）；tags 标记；不存秘密 |
| memory 主动检索的回忆缺口 | 中 | 模型不 search 就“忘记”；`/clear` 后无自动预热 | M5 接受（D143）；提示词要求先 search；后续版本评估自动注入 |
| schedule 存储/交付失败 | 中 | 存储损坏阻止启动；崩溃可能重复交付 | fail loud；at-least-once 已接受；`/clear` 删除旧任务；进程测试覆盖逾期 |
| curator 成本/噪声 | 低中 | 每个终态 goal 多一次模型调用 | 按 goal+phase 去重、超时、失败静默、最多 3 条；可 `NOKORIBI_MEMORY_CURATOR=false` |
| 测试覆盖不足（无 VM/CI） | 中 | 部署问题漏检 | 手工验收清单；flake checks；用户接受 |
| 无 web-debug | 低中 | 归档/排查只能看文件 | `/status` + journald + session 文件；用户选择不做 |
| 测试 token 明文在 store | 低中 | 本地用户可读 | 仅验收期开启；loopback；用户选择（D119） |
| QQ 主动推送已下线（2025-04-21） | 高 | schedule 提醒、系统通知在 QQ-only 部署无法送达 | M7 core + M8 driver 已实现 active 尝试 + 失败 defer（D161/D162/D164）；主动能力待真实门禁校准；文档明确“需下次入站才能补投” |
| QQ 平台准入/封禁 | 高 | 个人主体不可公开使用；AI 输出违规可致机器人/账号封禁且不可解封 | 只做个人自测场景、可信群；遵守运营规范；接受风险（D152/D157） |
| QQ 白名单只有平台边界 | 高 | 任何能私聊/群 @ 机器人者可驱动全权限 agent | `sudo.enable=false`、只加可信群、保留 local-test 验收；残余风险接受（D152） |
| QQ 协议/文档冲突与漂移 | 中高 | 域名、WS 退役传闻、Markdown、长度上限、错误码不一致 | M8 已配置化域名/窗口/长度/Markdown；14 项平台事实门禁待真实 Bot 执行；官方 SDK protocol 层 + fake 回归 |
| channel-core 扩展回归 | 中高 | outbox 合同/路由/错误语义变化影响本地通道与既有测试 | M7 单测/双 driver 集成 + M8 双渠道进程场景通过（7 文件/52 场景）；local-test 端点不变；后续改动继续跑全量门禁 |
| deferred 通知延迟/丢弃 | 中 | 长期无入站时提醒只能延迟；TTL/上限会丢最旧；崩溃窗口可能重复补投 | 上限/TTL 可配 + warn；`/status` 展示 deferred 计数；at-least-once 与平台限制写入文档 |
| reply defer 内容截断 | 低中 | 无上下文回复补投时只保留单段（超长加省略） | 长回复优先走被动；补投正文带“⚠️ 补发”可辨识；后续按 M8 实测调整 |
| 官方 SDK 新依赖与升级维护 | 中 | `qqbot-nodejs` 1.0.x 演进；Nix FOD 哈希变更 | exact pin 1.0.5；升级 diff CHANGELOG + 真实 Bot 回归；`nix/deps.nix` 同步更新 |
| 归档不可删除、磁盘增长 | 低 | 长期磁盘占用 | 用户接受；人工清理；memory/session 保留策略未设计 |
| 审批/提问在纯文本渠道歧义 | 低中 | 误答/超时 | 串行、编号、帮助重提示、超时兜底 |
| 本地测试通道不是真实 IM | 中 | 无法验证真实平台行为 | v1 明确后置；真实适配器需单独里程碑 |

## 15.4 已接受的残余风险（汇总）

- Auto review 是唯一硬边界；误放行可导致整机级后果。
- sudo 全开、systemd 不硬化、无高危硬确认。
- 无备份、无自动回滚、升级不回滚数据。
- 测试 token 明文、API key 在 root 可达的环境变量/文件中。
- sandbox 不是安全隔离；只是干净/可重置环境 + 禁提权。
- 无真实 IM、无 web UI、无 VM 测试、无 CI。
- 全局 memory、无加密、root 可读。
- memory 只做主动检索，不自动注入；`/clear` 后可能想不起旧信息（D143）。
- schedule 是 at-least-once，崩溃可能重复交付；存储损坏 fail loud。
- 发行版运行时依赖官方 Node 二进制（D145）；Node/DSH 升级时必须复测 native addon，且该二进制不受 nixpkgs 补丁覆盖。
- NixOS 12.12 手工验收尚未在当前 Arch 开发机执行；在目标机记录前不能把 M6 视为生产验收完成。
- QQ 官方 Bot 的准入边界就是平台限制：任何能被加入开发体验用户或在你群里 @ 机器人的人都能驱动全权限 agent；若 `sudo.enable=true` 等价于远程 root 入口（D152 已接受，建议保持 sudo 关闭、只加可信群）。
- QQ 官方主动推送已于 2025-04-21 下线：提醒/系统通知在 QQ-only 部署可能无法送达；D161/D162 已在 M7 core 实现 active 尝试 + 失败 defer 到下次入站补投，但仍不能承诺主动触达。
- M7 的 deferred 通知受 TTL/上限约束，长期无入站会丢失最旧项；补投依赖用户下一次发言（平台限制）。
- M7 的 actions 只是契约与持久化预留，未实现按钮渲染/回调；M8 也未订阅 `INTERACTION_CREATE`，按钮审批仍后置。
- M8 的代码与 fake 自动化已完成，但真实平台 14 项门禁、17.8.2 与目标机部署尚未执行；在记录前只能称“代码完成”，不能称 M8 验收通过。
- QQ 平台可封禁机器人或账号且不支持解封；AI 输出合规由用户与提示词承担，M8 不做内容审核服务。
- 官方 SDK 引入维护成本：`@tencent-connect/qqbot-nodejs` 版本与协议行为需随平台更新回归；升级时同步 lock 与 `nix/deps.nix` 哈希。

## 15.5 停止/回退条件（建议）

- 若 V1（Auto preset 在无 Web profile 不可用）无法解决：暂停实现，重新讨论安全模型（不能默认无审查运行）。
- 若 V2（child 审批桥接）不可行：采用回退方案并更新文档；goal 被拒动作只汇报主 agent。
- 若 V3（goal 冷恢复）不可行：重启后不自动恢复 goal，改为通知用户 `/goal resume`。
- 若 V7（Nix 固定输出构建）不可行：重新评估薄启动器打包方式（容器/venv 式），但保持版本锁定。
- 若 M8 真实 Bot 实测 WebSocket 已不可用（平台改为仅 WebHook）：暂停 QQ driver 实现，评估 WebHook + 公网回调/TLS 方案（与当前无入站端口部署冲突）或改选其他平台。
- 若 M8 实测主动推送完全不可用：按 D161 的 defer 方案补投，并在 README/规格中写明“提醒时效性受平台限制”；评估后续通知渠道（如第二 IM 适配器）。
