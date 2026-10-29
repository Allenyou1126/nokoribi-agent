# 03 决策记录

本文件是全部讨论结论的权威来源。按讨论时间顺序记录每个问题的背景、选项与用户选择；末尾列出"未逐条确认但默认采纳的提案"与"被取代/撤销"的索引。

约定：

- **最终**：当前有效。
- **取代**：被后续决策替换，括号注明新决策。
- **撤销**：明确回撤，不再实施。
- **提问**：用户提出的问题/澄清，本身不是决策。
- 用户选择以讨论中的原始答案为准；本文件在保留原意的前提下做了精简表述。

---

## 3.1 最终决策索引（按主题）

| ID | 主题 | 最终选择 |
|---|---|---|
| D01 | 精简层次 | 运行时精简 + 薄启动器（不 fork、不用官方 `dsh` 启动器） |
| D03 | IM 渠道 | v1 先只留抽象渠道接口（后补本地测试通道，见 D75） |
| D04 | 接入形态 | 进程内 Cordis host 插件 |
| D05 | 默认注入 | 忙碌 steer、空闲 followup；仅显式参数才 cancel |
| D06 | 参数形式 | IM 命令前缀 + 代码层投递参数 |
| D07 | SSH 形态 | `bash` 工具加可选 `host`，本地/远程统一入口（实现后置） |
| D08 | 会话与权限 | 单用户、单常驻主会话 |
| D09 | 部署 | NixOS + 声明式 systemd |
| D10 | 模型接入 | DeepSeek 官方 API Key |
| D12 | SSH 首轮 | v1 不做 SSH（后置） |
| D13 | 渠道能力 | 纯文本、审批/提问文本应答、图片/附件 |
| D14 | 控制命令 | `/stop` `/status` `/compact` `/goal` `/clear`/`/new` `/steer` `/queue` |
| D16 | 媒体 | 入站图片直接给模型（无多模态模型时明确不支持） |
| D17 | `/clear` | 新建主会话，旧会话归档保留 |
| D19 | Nix 集成 | nur-packages 包 + NixOS 模块；专用用户 + `/var/lib/nokoribi-agent`；agenix |
| D20 | 出站结构 | 主 agent 直接回复：每轮最后一条非空 assistant 文本镜像到 IM |
| D21 | 播报时机 | 每轮结果一条；长任务按里程碑；错误/阻塞立即 |
| D22 | goal 形态 | 主 agent spawn continuable 子代理；子代理自持 goal，round-driver 续跑 |
| D23 | 发送工具名 | `send_to_user` |
| D24 | host 路由 | router 提供 `ctx.shellHosts` 且是唯一 `ctx.shell` provider；host 插件注册到 router |
| D25 | host v1 范围 | v1 做 router + local + sandbox + 发现工具 |
| D26 | host 发现 | 独立模型工具 + service API |
| D27 | SSH 寻址 | 模型只选 host id；host id 带路由前缀 |
| D29 | host id 前缀 | `local:` / `sandbox:` / `ssh:` / `client:` |
| D31 | auto-review 接法 | 全局 Auto 预设（A 方案） |
| D34 | 升级参数 | 去掉 `sandbox_permissions` / `justification` |
| D35 | sandbox 运行时 | profile 固定 Nix shell + 独立临时目录 |
| D37 | v1 默认 host | 默认 sandbox，local 用于持久化操作 |
| D44 | 沙箱语义 | 干净、与 workspace 隔离的执行环境（撤销 overlay） |
| D45 | Nix 环境来源 | 只用 profile 固定环境（不读 workspace shell 文件） |
| D46 | TTL | 可配置，默认 30 分钟空闲回收 |
| D47 | workspace 可见性 | sandbox 不挂载 workspace |
| D48 | 隔离强度 | 约定隔离（轻量），不做强制 namespace/容器 |
| D49 | 默认 host | 仍为 `sandbox:*` |
| D50 | 沙箱工具面 | `sandbox`（reset/status）+ `sandbox_packages`；copy_in/commit 不做工具 |
| D52 | Nix 环境配置 | `sandbox.packages` + `shellHook` |
| D53 | 可见性语义 | 不挂载、不作为 cwd，但同用户绝对路径可访问 |
| D54 | 冲突安全 | 不做强制，靠提示词 |
| D55 | 待应答路由 | 应答优先；命令可用；`/steer` 旁路 |
| D56 | 并发待应答 | 串行排队 |
| D57 | 交互超时 | 分级：approval 1 分钟、question 5 分钟（可配） |
| D58 | `/steer` 语法 | 内联参数；无文本时设下一条的投递模式 |
| D59 | 待应答期间的 `/steer` | 只旁路解析，不打断待应答 |
| D60 | 记忆方案 | AGENTS.md 分层 + memory 工具 |
| D61 | 记忆写入触发 | 用户显式、模型自主、里程碑/任务结束提炼 |
| D62 | v1 主动行为 | schedule 提醒 + goal 自动续跑（无 heartbeat） |
| D63 | 模型分配 | 主 agent 用配置选择的多模态模型；子代理模型由主 agent 选 |
| D64 | reviewer 成本 | vendor/patch 成独立 reviewer 模型 |
| D65 | 阶段推进 | 分阶段，每阶段可运行（最终 6 阶段，见 D125） |
| D66 | memory 工具面 | 单工具 + action |
| D67 | memory 作用域 | 只全局 |
| D68 | 记忆提炼 | 便宜子代理执行 |
| D69 | 图像回退 | 无多模态模型时直接不支持 |
| D70 | goal 守卫 | 轮次上限 + 手动停止；无 token 预算 |
| D71 | Nix 代码位置 | 内置于 nokoribi-agent 的 flake |
| D74 | sandbox 环境构建 | Nix 预构建 `buildEnv` 作为基础 PATH |
| D75 | 部署验收 | 本地测试通道（loopback HTTP） |
| D77 | local PATH | 系统 PATH + `extraPackages` |
| D78 | 测试通道形态 | loopback HTTP + token |
| D79 | local 权限 | 专用用户 + `NOPASSWD: ALL` sudo，Auto review 兜底 |
| D80 | workspace 语义 | 默认目录，不强制禁止访问宿主路径 |
| D81 | sudo 范围 | `NOPASSWD: ALL` |
| D82 | sudo 审批 | 全部 auto-review 自动判定（仅 reviewer 拒绝才问用户） |
| D83 | reviewer 模型 | 只给 reviewer 配置两个 tier，不是全局模型分层 |
| D84 | 审计/回滚 | 只做日志；不做自动回滚 |
| D86 | sandbox 提权 | 禁止提权（`no_new_privs` + PATH 去 sudo） |
| D87 | reviewer 策略 | 双阶段：fast 全审 → deny/不确定/sudo → strong 复审 |
| D88 | goal 创建路径 | 两种都支持（主 agent 工具 / `/goal` 命令） |
| D89 | `/goal` 职责 | 包含创建 |
| D90 | 重启后 goal | 自动冷恢复 + re-arm |
| D91 | `/stop` 范围 | 只停主 agent |
| D92 | sandbox 作用域 | 每个 session 独立 |
| D93 | goal 数量 | 允许多个并行 |
| D94 | goal 结束 | 归档保留会话；主 agent 询问用户；用户命令归档 |
| D95 | 恢复失败 | 通知用户、保持 tracked、等重试 |
| D96 | goal 并发上限 | 不限制 |
| D97 | 模型创建路径 | **被 D136 取代**：rc.3 下改用专用 `start_goal` + 宿主创建 goal |
| D98 | 归档实现 | 保留 session 文件 + 归档索引（JSONL） |
| D99 | `/goal clear` | 停止 + 自动归档 |
| D100 | 归档触发 | 主 agent 提示，用户回复 `/goal archive <前缀>` |
| D101 | 主会话 goal | 禁止；隐藏 main 的 goal 工具，误建则清除并提示 |
| D102 | goal 短 id | sessionId 前缀 |
| D103 | 高危硬确认 | 不需要（完全信任 auto-review） |
| D104 | sudo 审计 | 命令与结果进 journald，不记录输出 |
| D105 | 备份 | 不做 |
| D106 | 测试 token | 固定 token |
| D107 | `/status` | 摘要 + `/status full` |
| D108 | web-debug | 不做（取代 D02） |
| D109 | 看门狗 | sd_notify + systemd `WatchdogSec` |
| D110 | 升级 | 直接升级，不做快照 |
| D111 | persona | 用户提供 SOUL.md |
| D112 | 身份 | 完全自定义身份 |
| D113 | memory 存储 | 每条一个 Markdown 文件 |
| D114 | AGENTS.md | 首次 seed 全局 + 工作区两处 |
| D115 | SOUL.md 位置 | 源码仓库、Nix 打包（运行时不可变） |
| D116 | SOUL 生效 | 启动时加载 |
| D117 | 身份范围 | 只替换身份句，保留其他提示词段 |
| D118 | 配置可变性 | 纯 Nix 只读 |
| D119 | 测试 token 来源 | Nix option 明文 |
| D120 | sudo 默认 | 模块默认关闭，显式开启 |
| D121 | 仓库结构 | pnpm monorepo `packages/*` |
| D122 | DSH 版本 | 固定 `0.2.1-rc.3`，手动整批升级 |
| D123 | reviewer 维护 | vendor 源码 + LICENSE + 上游版本标识 |
| D124 | 构建规范 | tsdown + oxlint + oxfmt + tsc |
| D125 | 阶段数 | 6 阶段（M1–M6） |
| D126 | 部署时机 | M6 才部署 |
| D127 | 验收方式 | 自动化为主 |
| D128 | 测试框架 | Vitest |
| D129 | CI | 只 flake checks |
| D130 | NixOS VM 测试 | 不做 |
| D131 | 子代理审批 | 也桥接到 IM 问用户（需补丁） |
| D132 | outbox 语义 | at-least-once |
| D133 | 测试通道协议 | 长轮询 |
| D134 | `ctx.shell` 角色 | sessionless façade 仅 local；sandbox default fail closed |
| D135 | 前台命令超时 | 只返回超时结果，不自动转后台 job |
| D136 | goal 创建路径（M4） | 专用 `start_goal` 工具 + `/goal new`；宿主 `ctx.goals.create`；取代 D97 |
| D137 | goal 汇报机制（M4） | `send_message` + `subagent/end` 结算通知；rc.3 无独立 report 包 |
| D138 | goal 模型选择（M4/M5） | M4 固定 `NOKORIBI_GOAL_MODEL`；M5 用 `NOKORIBI_GOAL_MODELS` allowlist + `start_goal`/`/goal new` 选择；generic `subagent` 选择后移 |
| D139 | schedule 宿主桥（M5） | rc.3 `dsh-schedule` 是 Host-wide + storage-domain；新增最小 `sessionController` 桥、storage 行；`/clear` 删除旧主会话任务 |
| D140 | 记忆提炼触发（M5） | goal `complete`/`blocked` 时一次性提炼；输入 objective + 最后 report；失败静默 |
| D141 | goal 模型 allowlist（M5） | `NOKORIBI_GOAL_MODELS` 精确路由；默认路由始终允许；generic `subagent` 仍继承主模型 |
| D142 | `/status full`（M5） | 文本 + `GET /v1/status?full=1`；含 goals/sandbox、schedule、memory、recent errors、reviewer、版本 |
| D143 | memory 自动注入（M5 后移） | M5 只做主动检索；会话启动/每轮注入留后续版本 |
| D144 | systemd 通知（M6） | 通过 `systemd-notify` 子进程发送 READY/WATCHDOG/STOPPING；`Type=notify` + `NotifyAccess=all`；Node 无 Unix datagram，不引入 native addon |
| D145 | Nix 运行时（M6） | DSH 的 `node-addon-require-builtin` 只匹配官方 Node；包内保留官方 Node 24.21.0，wrapper 经 Nix glibc loader 启动；构建仍用 nixpkgs Node/pnpm |
| D146 | NixOS 配置映射（M6） | 纯 Nix 生成完整 Cordis overlay；`goal.allowedModels`/显式 memory 路由；不提供 `models.subagents`、`memory.enable`、`schedule.enable`、SSH 开关 |
| D147 | M6 验收边界（M6） | 本地 `nix build`/`nix flake check` + NixOS 12.12 手工；不伪造 DSH bump；watchdog 用手工 SIGSTOP 验证 |
| D148 | Nix subprocess runner（M6 修正） | DSH runner 用 `process.execPath`；loader wrapper 下该值是 loader，目标机 `bash` 全失败；wrapper 换用 `bin/node-shim` + `--require` preload 覆盖 execPath，保留 native containment |
| D149 | 里程碑重排（P1） | M7 = channel-core IM 基础设施扩展（先做）；M8 = QQ 官方 Bot；M9 = SSH host |
| D150 | IM 平台与传输（P1） | QQ 官方 Bot；M8 用 WebSocket 网关，WebHook 后置 |
| D151 | IM 发送策略（P1） | 被动优先（core reply context）+ `activeMessageFallback=auto`；主动推送官方已下线，不作可靠兜底 |
| D152 | IM 准入（P1，用户已确认） | 只靠平台限制；`trustedChannels:["qq-bot"]`；不做驱动级白名单/配对 |
| D153 | 回复上下文/会话（P1） | core+outbox A2 承载被动上下文；gateway 会话不跨进程持久化 |
| D154 | 协议层依赖（P1，用户已确认） | 官方 `qqbot-nodejs@1.0.5` 的 `./protocol` |
| D155 | 图片链路（P1） | 后置 V8；M8 只忽略附件 |
| D156 | IM 密钥与配置（P1） | AppID 入 store；ClientSecret 走 EnvironmentFile；token 仅内存 |
| D157 | IM 验收边界（P1） | 规格已通过；fake 自动化 + 真实个人 Bot + 目标机；14 项平台事实门禁 |
| D158 | channel-core 扩展（P1，用户已确认） | 拆成独立里程碑 M7 先做（回复上下文/非重试错误/allowlist/多 driver） |
| D159 | 多 driver 路由（P1） | per-turn 路由、notice active-capable 降级、缺 driver 短路、显式默认渠道 |
| D160 | IM 能力位/窗口（P1） | markdown basic、maxTextLength 4500、maxReplies 4、`c2c:`/`group:`、replySeq |
| D161 | 提醒/通知降级（用户已确认） | **B：active 尝试 + 失败后 defer（下次入站以被动回复补投）**；A 丢失风险 / C 换渠道不采用 |
| D164 | M8 实现口径（P1） | SDK protocol 薄封装；显式 msg_seq/HTTP 200 body code；4009 由 SDK re-identify；flat Nix 选项、无 sandbox/白名单；零依赖 fake；不改 core |
| D165 | 后续里程碑排期（P1，用户已确认） | **M9 = QQ 按钮审批；M10 = host-aware 持久终端 + Web 能力**；原“M9 = SSH host”顺延 |
| D166 | QQ 按钮审批范围与 UX（P1，用户已确认） | 仅审批；2 按钮「允许一次/拒绝」；不补发确认消息；**仅 C2C**；群聊/提问保持文本；文本 fallback 保留；超时=拒绝 |
| D167 | 动作回调实现口径（P1） | core 产出/解释 action；action 权威、失效不回退文本；ack `PUT /interactions/{id}`；intents `1<<26` + 降级；local-test 可注入；群聊剥离 |
| D168 | 持久终端 host-aware（P1，用户已确认） | 复用 `dsh-terminal` + `dsh-tool-terminal` + `BashTerminalBackend` 注入 `spawnTerminal`；type=host id；host 协议 `terminalLaunch` + sandbox pin；进程内持久；失败回退 vendoring |
| D169 | Web provider 默认（P1，用户已确认） | 双 provider 挂载；默认 `deepseek-official` 搜索 + `http` 抓取；可切 `deepseek-search-api`/`deepseek-fetch-api`；复用 `DEEPSEEK_API_KEY` |
| D170 | Web 工具豁免 Auto review（P1，用户已确认） | `exemptTools` 默认 `["web_search","web_fetch"]`；其余工具仍逐次审查；残余风险登记 15 |
| D171 | 新增 DSH 依赖与升级回归（P1） | 依赖固定 `0.2.1-rc.3`；升级回归 `BashTerminalBackend` 注入签名、reviewer patch、web provider id、sandboxPolicy 行为 |

---

## 3.2 详细决策记录（按讨论顺序）

### 第一轮：总体方向（8 问）

- **D01 精简层次** — 选项：运行时精简 + 薄启动器 / 只做运行时精简 / 完整 fork / 另写 harness。选择：**运行时精简 + 薄启动器**。备注：安装物也精简；启动器只依赖所选包与 vendored profile-boot。
- **D02 Web 界面** — 选项：生产纯 IM + 按需 Web 调试 profile / 完全不要 / 保留完整 Web。选择：**生产纯 IM + 按需 Web 调试 profile**。状态：**被 D108 取代**（最终不做 web-debug）。
- **D03 IM 渠道** — 选项：QQ/Milky、AstrBot、Telegram、Discord、飞书、先留抽象接口。选择：**先只留抽象渠道接口**。备注：真实适配器后置；本地测试通道后来作为验收手段（D75/D78）。
- **D04 接入形态** — 选项：进程内插件 / 独立 gateway + 自定义 IPC / 独立 gateway + SDK / 独立 gateway + Web API。选择：**进程内 Cordis host 插件**。备注：能直接 `steer`/`followup`、订阅事件、注册审批/Prompt 应答者；SDK 不暴露 steer。
- **D05 默认注入** — 选项：默认 steer / 默认 steer + 合并 / 默认 followup / 可配置。选择：**默认 steer 到最近 step 边界；仅显式参数才取消当前轮**。备注：等价于 teammate `send_message` 的语义；工具执行不被打断。
- **D06 参数形式** — 多选。选择：**IM 命令前缀 + 代码层调用参数**。
- **D07 SSH 形态** — 选项：`bash` 加 `host` / 独立 ssh 工具 / 全走远程 / 其他。选择：**`bash` 工具加可选 `host`，本地/远程统一入口**。备注：实现后置（D12）。
- **D08 会话与权限** — 选项：单用户单主会话 / 按 IM 会话建 session / 主+子会话 / 多人。选择：**单用户、单常驻主会话**。

### 第二轮：v1 边界（6 问）

- **D09 部署** — 选项：NixOS + systemd / 现有 Linux + systemd / 容器 / 本机前台。选择：**NixOS 主机 + 声明式 systemd 服务**。
- **D10 模型** — 选项：API Key / 复用账号登录态 / 两者 / 其他。选择：**DeepSeek 官方 API Key（`DEEPSEEK_API_KEY`）**。
- **D11 v1 长程能力** — 多选。选择：**先只做消息闭环 + 工具 + 持久会话**。状态：后续讨论扩展了 v1（加入 sandbox、auto-review、memory、schedule、goal、NixOS 等）；以最终 6 阶段（D125）为准。
- **D12 SSH 首轮** — 自定义：**第一轮先不做 SSH 远程执行**。状态：最终有效；SSH 后置。
- **D13 渠道能力** — 多选。选择：**纯文本进出、审批与提问（文本回复）、图片/附件**。备注：最终仍不做流式；图片最终入站直接给模型（D16），无流式。
- **D14 控制命令** — 多选。选择：`/stop`、`/status`、`/compact`、`/goal ...`、`/clear` 或 `/new`、`/steer`、`/queue`。备注：`/compact` 与 `/goal` 后续改为桥接自有语义（见 D89 等）。

### 第三轮：出站/goal/Nix 初版

- **D15 出站结构（初版）** — 自定义：**由一个 subagent 进行总结，接受主 agent 的输入，调用 `send_message` TOOL Call**。状态：**被 D20 取代**（主 agent 直接回复）。
- **D16 媒体** — 选择：**入站图片直接给模型看**。备注：需多模态模型；没有时按 D69 不支持。
- **D17 `/clear`** — 选择：**新建主会话，旧会话归档保留**。
- **D18 goal 形态（初版）** — 自定义：**goal 由子代理跑，主代理随时处理新的消息**。备注：后续细化为 D22、D88–D102。
- **D19 Nix 集成** — 选择：**nur-packages 加包 + NixOS 模块；专用用户 + `/var/lib/nokoribi-agent`；agenix 管密钥**。

### 第四轮：出站细化与 goal 形态

- **D20 出站结构（最终）** — 选择：**主 agent 直接回复**：每轮结束把该轮最后一条非空 assistant 文本镜像为一条 IM 消息；goal 子代理通过 report 回流主 agent，主 agent 汇总转述。
- **D21 播报时机** — 多选：每轮结束回一条结果、长任务按里程碑、错误/阻塞立即播报。选择：**全部三项**。
- **D22 goal 子代理形态** — 选择：**主 agent spawn continuable 子代理，子代理自持 goal 并被 round-driver 续跑**；需要 daemon 启动时恢复 cold goal 子代理。
- **D23 发送工具名** — 选择：**`send_to_user`**（避免与内置 `send_message` 冲突）。备注：v1 主要用于主动补发/未来附件，常规回复走自动镜像。

### 第五轮：shell host 与 sandbox（大量迭代）

- **D24 host 路由架构** — 用户提案：shell 工具带 `host`；host 由 local/local-sandbox/ssh/client 等插件注册并按 host 路由；新增 `get_available_shell_host`。设计确认：**可以，但 DSH 的 `ctx.shell` 是单 provider**，因此 host 插件不能各自注册 `ctx.shell`；改为 **一个 `shell-router` 提供 `ctx.shellHosts` 并作为唯一 `ctx.shell` provider**，host provider 注册到 router，`bash` 工具走 `ctx.shellHosts` 并带 `host` 参数。
- **D25 host 落地范围** — 选择：**v1 就做 router + `local` + `sandbox` + 发现工具**；SSH 后续只加 provider。
- **D26 发现工具** — 选择：**独立模型工具 + service API**（`get_available_shell_host`）。
- **D27 SSH 寻址** — 自定义：**模型只选 host id，但 host id 携带路由前缀**（可看出执行来源）。
- **D28 默认 host（初版）** — 选择：`sandbox:workspace`。最终默认仍是 sandbox（D49），但命名/语义按 D29、D44 修正。
- **D29 host id 前缀** — 选择：`local:` / `sandbox:` / `ssh:` / `client:`。
- **D30 非沙箱 host 授权（初版）** — 自定义：**审批复用 experimental-auto-review，非置信时再向用户要求单次授权**。状态：被 D31/D79/D82 的全局 Auto 方案覆盖（不再有 per-host 授权）。
- **D31 auto-review 接法** — 选项：A 全局 Auto 预设 / B 裁剪成 host gate / C 混合。选择：**A. 全局 Auto 预设**。备注：从此 host 选择本身不再单独授权；所有工具调用都过 reviewer。
- **D32 host 授权粒度** — 用户选择"其他"（无补充）。在 A 方案下该问题失效。
- **D33 sandbox 语义（初版）** — 自定义：**沙箱随时可能被回收重置，不保证持久化（也不保证一定重置，必要时可手动 reset）**。
- **D34 升级参数** — 选择：**bash 工具去掉 `sandbox_permissions` / `justification`**。
- **D35 sandbox 运行时** — 选择：**独立的 nix shell + 临时目录**（后来明确为 profile 固定环境，D45）。
- **D36 sandbox 持久化（初版）** — 选择：**临时 overlay + 手动提交**。状态：**撤销**（D44）。
- **D37 v1 默认 host** — 选择：**v1 默认 sandbox，local 用于持久化操作**。
- **D38 sandbox 文件模型（初版）** — 选择：**overlayfs：workspace 为 lower，temp 为 upper**。状态：**撤销**（D44）。
- **D39 Nix 环境来源（初版）** — 自定义：**从工作区里的 shell 文件开始，允许模型在不修改 shell 文件的情况下临时新增包**。状态：来源部分被 D45 取代；"临时加包"由 D41 承接。
- **D40 sandbox 控制面** — 选择：**只给模型工具**。
- **D41 临时加包** — 选择：**`sandbox_packages` 工具，状态保留到 reset**。
- **D42 生命周期（初版）** — 选择：**落盘 + 空闲自动回收**。最终有效（D46）。
- **D43 commit 冲突（初版）** — 选择：**对比基线，冲突时拒绝**。状态：因 D50 取消 commit 工具而失效；最终只靠提示词（D54）。
- **D44 overlay 撤销** — 自定义：**回撤关于沙箱 overlay 的决定，沙箱就是一个干净的执行环境，跟 workspace 隔离**。影响：取代 D36、D38；沙箱不再与 workspace 共享文件视图。
- **D45 Nix 环境来源（最终）** — 选择：**只用 profile 固定环境**（不读 workspace shell 文件）。
- **D46 TTL** — 选择：**可配置，默认 30 分钟空闲回收**。
- **D47 workspace 可见性** — 选择：**完全不可见，显式拷入拷出**。随后 D53 澄清"不可见"= 不挂载/不作为 cwd，但同用户路径可访问。
- **D48 隔离强度** — 选择：**约定隔离（轻量）**。
- **D49 默认 host（最终）** — 选择：**sandbox 仍为默认**。
- **D50 沙箱工具面（最终）** — 自定义：**`sandbox` 多 action + `sandbox_packages`；但 copy_in 和 commit 不做工具，让模型通过 shell 命令自己管理**。
- **D51 commit 覆盖策略** — 选择：**默认拒绝，需显式 overwrite**。状态：在无 commit 工具后失效，最终仅提示词约束（D54）。
- **D52 Nix 环境配置** — 选择：**`sandbox.packages` + `shellHook`**。
- **D53 可见性语义** — 选择：**不挂载但路径可访问**（`DSH_SANDBOX_DIR` / `DSH_WORKSPACE_DIR` 暴露给模型，用 cp/rsync）。
- **D54 冲突安全落点** — 选择：**不做强制，靠提示词**。

### 第六轮：渠道交互语义

- **D55 待应答路由** — 选择：**应答优先 + 命令可用 + `/steer` 旁路**。
- **D56 并发待应答** — 选择：**串行排队，一次一个提示**。
- **D57 超时** — 选择：**分级短超时：approval 1 分钟、question 5 分钟**（可配）。
- **D58 `/steer` 语法** — 选择：**内联参数 ` /steer <文本>`；无文本时设下一条的投递模式**。
- **D59 待应答期间的 `/steer`** — 选择：**只旁路解析，不打断待应答**；真正注入要等应答解决、轮次恢复。

### 第七轮：记忆、主动行为、模型成本

- **D60 记忆方案** — 选择：**AGENTS.md 分层 + memory 工具**。
- **D61 记忆写入触发** — 多选：用户显式要求、模型自主判断、里程碑/任务结束提炼。选择：**三项全部**。
- **D62 主动行为 v1** — 多选：schedule 提醒、heartbeat、goal 自动续跑、都后置。选择：**schedule 提醒 + goal 自动续跑**；不做 heartbeat。
- **D63 模型分配** — 自定义：**主代理用支持图像输入的模型，由配置选择；其他 subagent 的模型让主代理选择**。
- **D64 reviewer 成本** — 选择：**改成独立便宜 reviewer**（后来细化为 reviewer-only 双 tier，D83/D85/D87）。
- **D65 阶段推进** — 选择：**分阶段推进，每阶段可运行**（最终 6 阶段 D125）。
- **D66 memory 工具面** — 选择：**单工具 + action**。
- **D67 memory 作用域** — 选择：**只全局**。
- **D68 记忆提炼执行者** — 选择：**便宜子代理提炼**。
- **D69 图像回退** — 选择：**无多模态模型时直接不支持**（明确告知用户）。
- **D70 goal 成本守卫** — 选择：**轮次上限 + 手动停止**（`maxGoalRounds`、`/stop`、`/goal pause`）；无 token 预算。

### 第八轮：NixOS 与安全

- **D71 Nix 代码位置** — 选择：**nokoribi-agent 内置 flake**，nur-packages 引用/转发。
- **D72 workspace 权限（提问）** — 自定义提问：**独立 workspace、不碰宿主目录，但这样隔离后 shell 工具怎么工作？** 状态：讨论澄清（见 05/07/12）；最终 D79 选择专用用户 + sudo。
- **D73 systemd 硬化（初版）** — 选择：**中等硬化**。状态：**被 D79 实质取代**（为让 local host 执行任意命令并允许 sudo，不再做文件系统硬化）。
- **D74 sandbox 环境构建** — 选择：**Nix 预构建 `buildEnv` 基础 PATH**；临时加包才运行时 `nix shell`。
- **D75 部署验收** — 选择：**本地测试通道**（不是 web-debug）。
- **D76 local host 目标** — 自定义：**希望 shell 的 local host 可以在主机上执行任何命令**。最终通过 D79/D81 实现（专用用户 + NOPASSWD ALL）。
- **D77 local PATH** — 选择：**系统 PATH + `extraPackages`**。
- **D78 测试通道** — 选择：**loopback HTTP + token**。
- **D79 local 权限模型** — 自定义：**专用用户，允许 sudo（NOPASSWD），通过 auto-review 兜底**。
- **D80 workspace 语义** — 选择：**默认目录，不强制禁止访问宿主路径**。
- **D81 sudo 范围** — 选择：**`NOPASSWD: ALL`**（`nokoribi ALL=(ALL) NOPASSWD: ALL`）。
- **D82 sudo 审批** — 选择：**全部 auto-review 自动判定**；reviewer 拒绝时才问用户。
- **D83 reviewer 模型命名** — 自定义：**不要叫主模型/便宜模型，可以配置两个 Tier**。
- **D84 审计与回滚** — 选择：**只做日志**；不做自动回滚。
- **D85 Tier 范围澄清** — 自定义：**两个 tier 只给 review model 可选，不是所有模型都只分两个 tier**。
- **D86 sandbox 提权** — 选择：**sandbox 禁提权**（`no_new_privs` + PATH 去 sudo）；local 保留 sudo。
- **D87 reviewer 策略** — 选择：**双阶段：fast 全审 → deny/不确定/sudo → strong 复审 → 仍拒绝才问用户**。

### 第九轮：goal 生命周期（多 goal）

- **D88 goal 创建路径** — 选择：**两种都支持**（主 agent 工具 / `/goal` 命令）。
- **D89 `/goal` 职责** — 选择：**包含创建**。
- **D90 重启后 goal** — 选择：**自动冷恢复 + re-arm**（接受额外一轮）。
- **D91 `/stop` 范围** — 选择：**只停主 agent**；goal 用 `/goal pause`/`clear`。
- **D92 sandbox 作用域** — 选择：**每个 session 独立**。
- **D93 goal 数量** — 选择：**允许多个并行**。
- **D94 goal 结束处理** — 自定义：**保留，但要控制 subagent 数量，转成归档形式仅在 debug 查看；主 agent 在 goal 完成后询问用户是否归档；归档则删除 subagent、保留记录存档**。最终落点见 D98/D100。
- **D95 恢复失败** — 选择：**通知用户、保持 tracked、等 `/goal resume` 或新消息重试**。
- **D96 goal 并发上限** — 选择：**不限制**。
- **D97 模型创建路径** — 选择：**通用 `subagent` 工具 + 桥接监控 `goal/changed`**（不注册专用 `start_goal` 工具）。状态：**被 D136 取代**；rc.3 的 `create_goal` 只允许根 agent 的直接人类输入，delegated child 无法自行创建 goal。
- **D98 归档实现** — 选择：**保留会话文件 + 归档索引**（DSH 无删除会话 API；debug profile 不存在，归档按 session id 查文件）。
- **D99 `/goal clear`** — 选择：**停止 + 自动归档**。
- **D100 归档触发** — 选择：**主 agent 提示 + 用户命令**（`/goal archive <前缀>`；不注册 `archive_goal` 工具）。
- **D101 主会话 goal** — 选择：**禁止**；隐藏主 agent 的 goal 工具；若出现则桥接清除并提示。
- **D102 goal 短 id** — 选择：**sessionId 前缀**。

### 第十轮：最终安全/运维/提示词/配置/构建/测试

- **D103 高危硬确认** — 选择：**不需要**；完全信任 auto-review，不加模式拦截。
- **D104 sudo 审计** — 选择：**默认命令审计**（命令与结果进 journald，不记录输出）。
- **D105 备份** — 选择：**不做**。
- **D106 测试 token** — 选择：**固定 token**。
- **D107 `/status`** — 选择：**摘要 + `/status full`**。
- **D108 web-debug** — 选择：**不做**。状态：取代 D02。
- **D109 看门狗** — 选择：**sd_notify + `WatchdogSec`**。
- **D110 升级** — 选择：**直接升级，不做快照**。
- **D111 persona** — 自定义：**我提供 SOUL.md**。
- **D112 身份** — 选择：**完全自定义身份**。
- **D113 memory 存储** — 选择：**每条一个 Markdown 文件**。
- **D114 AGENTS.md** — 选择：**首次 seed 全局 + 工作区两处模板**。
- **D115 SOUL.md 位置（澄清后）** — 自定义最初"项目里的文件"；确认选择：**源码仓库、Nix 打包（运行时不可变）**。
- **D116 SOUL 生效** — 选择：**启动时加载**。
- **D117 身份范围** — 选择：**只替换身份句**（`includeHarnessIdentity=false`，其他提示词段保留）。
- **D118 配置可变性** — 选择：**纯 Nix 只读**（改配置需 `nixos-rebuild`）。
- **D119 测试 token 来源** — 选择：**Nix option 明文**。
- **D120 sudo 默认** — 选择：**模块默认关闭，显式开启**。
- **D121 仓库结构** — 选择：**pnpm monorepo `packages/*`**。
- **D122 DSH 版本** — 选择：**固定版本，手动升级**（`0.2.1-rc.3`）。
- **D123 reviewer 维护** — 选择：**vendor 源码**。
- **D124 构建规范** — 选择：**tsdown + oxlint + oxfmt + tsc --noEmit**。
- **D125 阶段数** — 选择：**6 阶段（M1–M6）**。
- **D126 部署时机** — 选择：**M6 才部署**。
- **D127 验收方式** — 选择：**自动化为主**。
- **D128 测试框架** — 选择：**Vitest**。
- **D129 CI** — 选择：**只 flake checks**。
- **D130 NixOS VM 测试** — 选择：**不做**。
- **D131 子代理审批** — 选择：**也桥接到 IM 问用户**（需要 patch auto-review 的 child `never` 行为；全局串行提示，标明 goal 短 id）。M2 已验证：child deny 先转 `ask`，prompt 带 goal 短 id。
- **D132 outbox 语义** — 选择：**at-least-once**（重启重发，极端可能重复）。
- **D133 测试通道协议** — 选择：**长轮询**（`GET /v1/outbound?after=seq`）。
- **D134 `ctx.shell` 角色（M3）** — 自定义：DSH 的 `ctx.shell` 是 sessionless seam，而 sandbox 执行需要 sessionId。选择：`shell-router` 仍是唯一 `ctx.shell` provider；default host 为 `local` 时委托 local provider，default 为 `sandbox` 时 `ctx.shell.execute` 明确 fail closed；模型工具始终走 `ctx.shellHosts`。依据：rc.3 没有第一方执行消费者依赖 `ctx.shell.execute`。
- **D135 前台超时（M3）** — 选择：只有显式 `run_in_background: true` 才注册 `ctx.jobs`；前台命令超时按 `[timed out]` 返回并结束，不采用上游 `dsh-tool-bash` 的自动转后台。理由：减少 job 生命周期复杂度；需要后台时由模型显式选择。
- **D136 goal 创建路径（M4）** — 自定义：rc.3 `dsh-tool-goal` 的 `create_goal` 要求根 agent 当前轮的直接人类输入；goal child 是 delegated child，无法自行创建。选择：新增专用 `start_goal` 工具（主 agent 可用）与 `/goal new` 命令，由宿主预留 `goal-*` child id、启动 continuable child 并调用 `ctx.goals.create()`；`subagent` 工具保留给普通委托。状态：取代 D97；D101 不变。
- **D137 goal 汇报机制（M4）** — 自定义：rc.3 没有可用的独立 `dsh-tool-subagent-report` 包；选择 `send_message`（child → direct parent）+ `subagent/end` 自动结算消息，主 agent 负责转述。
- **D138 goal 模型选择（M4/M5）** — 自定义：M4 的 goal child 模型由 `NOKORIBI_GOAL_MODEL` 固定（默认跟随主模型）。M5 已实现 per-goal allowlist：`NOKORIBI_GOAL_MODELS` + `start_goal.model` / `/goal new --model`；默认路由始终允许。generic `subagent` 的 DSH `modelSelectionSettings` 因全局 bundle 行缺少 scoped preset Context 而暂不启用，继续继承主模型。
- **D139 schedule 宿主桥（M5）** — 自定义：rc.3 `dsh-schedule` 是 Host-wide 服务，任务存于 storage-domain/JSON，交付依赖 `ctx.sessionController.resolveAgent()`。本项目不挂 Web 控制器，改在 `@nokoribi/agent-app/session-bridge` 提供最小 `sessionController`：只解析当前主会话，在 daemon ready 前等待，旧会话任务由 `/clear` 通过 catalog/delete 删除。新增 storage/storage-json/storage-domain 行。
- **D140 记忆提炼触发（M5）** — 自定义：goal 进入 `complete`/`blocked` 时，按 `goalId:phase` 去重，启动一次性 `memory-*` continuable child（`delivery:"caller"`），输入 objective、阶段、轮次和最后一份 `[goal:…]` 报告；超时/失败只记日志，不阻塞主流程，不向用户发完成通知。
- **D141 goal 模型 allowlist（M5）** — 自定义：`NOKORIBI_GOAL_MODELS` 是逗号分隔的精确 `provider/model` 路由；`start_goal` 的 `model`/`reasoning_effort` 与 `/goal new --model/--effort` 必须命中 allowlist 或默认路由；state/archive/status 记录 route 与 effort。
- **D142 `/status full`（M5）** — 自定义：新增详细状态文本与 `GET /v1/status?full=1`；包含 goal 与 sandbox、active schedule、memory 计数、recent warn/error 环形缓冲、reviewer 两档、DSH/app 版本与路径；不输出消息正文或密钥。
- **D143 memory 自动注入后移（M5）** — 自定义：M5 保持“主动检索”而非自动注入；不做会话启动摘要、每轮 pre-step 检索或把 entries 塞进 system prompt。`/clear` 后不会自动带上旧记忆，模型必须调用 `memory search`。后续版本再评估。**状态（2026-10-29）：部分被 D172–D174 取代**——M16 增加 pinned 快照自动注入（runtime context，每轮最多刷新一次）；“主动检索、不做每轮自动检索、不塞全量 entries”的其余口径保留。
- **D144 systemd 通知（M6）** — 自定义：daemon 在恢复完成、写 ready 文件后，通过 `systemd-notify` 子进程发送 `READY=1`；按 `WATCHDOG_USEC` 的 1/3 周期发送 `WATCHDOG=1`；关闭时发送 `STOPPING=1`。unit 使用 `Type=notify` + `NotifyAccess=all`（helper 是子进程）。Node 24 `dgram` 没有 Unix datagram，故选 helper 而不引入 native addon；`NOTIFY_SOCKET` 缺失时 no-op。
- **D145 Nix 运行时（M6）** — 自定义：`@deepseek-ai/dsh-app-boot` 依赖的 `node-addon-require-builtin` 会检查官方 Node 的代码布局；nixpkgs 构建的 Node 和 patchelf 改写后的官方 Node 都会失败。发行版包保留官方 Node 24.21.0 二进制（x86_64/aarch64），wrapper 用 Nix glibc loader + Nix libstdc++ 启动；构建阶段仍使用 nixpkgs Node/pnpm。这样 native addon、NixOS 运行时和 Nix store 都自洽。
- **D146 NixOS 配置映射（M6）** — 自定义：module 生成完整 `cordis.patch.yml` overlay，不依赖运行时环境变量覆盖。选项按实现口径：`models.main`、`review.fast/strong`、`goal.{provider,model,allowedModels,maxRounds}`、`memory.{provider,model,curator}`、`hosts.*`、`channel.localTest.*`、`prompt.*`。不提供 `models.subagents`、`memory.enable`、`schedule.enable` 或可启用的 SSH host；memory/schedule 始终挂载，memory 只关闭提炼，SSH 留给 M7（现因 D149 顺延为 M8）。
- **D147 M6 验收边界（M6）** — 自定义：本地门禁为 `nix build`、`nix run --version`、`nix flake check`；NixOS 12.12 清单必须在目标机执行并记录。watchdog 手工用 `kill -STOP` 验证，不引入应用内测试钩子。当前 DSH 固定 0.2.1-rc.3，无新版本可 bump；真正的 DSH bump + reviewer vendor 更新留待后续升级提交，M6 只演练同版本重构建/重启恢复。
- **D148 Nix subprocess runner（M6 修正 D145）** — 自定义（2026-10-27 目标机实测）：DSH `dsh-subprocess-local` 在 Linux 上用 `systemd-run --user --scope` 启动私有 runner，命令是 `[process.execPath, runner.js]`。D145 的 loader wrapper 使 `process.execPath` 等于 Nix glibc loader，systemd-run 拿 loader 执行 `runner.js` 报 invalid ELF header，runner 在消费 launch request 前退出，因此所有 `bash(host)` 调用 100% 失败（`subprocess scope exited before its bootstrap consumed the launch request`；hkg-dog-darell 会话日志与用户 journal 可复现）。修复：发行版新增 `bin/node-shim`（loader + 官方 Node 的可执行 shim）与 `nix/exec-path-preload.cjs`；wrapper 通过 `--require` 预加载，并把 `NOKORIBI_NODE_SHIM` 指向 shim，preload 仅在该变量存在时覆盖 `process.execPath`。不把 `--require` 放进 `NODE_OPTIONS`，避免泄漏进用户 shell 环境。已验证：目标机 subprocess 层 native scope 启动成功、daemon 启动与 native addon 检查正常；不再需要“去掉 XDG_RUNTIME_DIR/DBUS 强制 fallback”的临时方案。`nix flake check` 的 package-smoke 增加 shim/preload 断言。

---

### 第十一轮：真实 IM 适配器（QQ 官方 Bot，P1 规格评审中）

> 本节为 **P1 规格决策**：2026-10-27 用户评审通过（实现暂不启动，按 D149 拆分 M7/M8）。完整规格见 [17](17-qq-official-bot.md)，调研证据见 `.spec/notes/`。

- **D149 里程碑重排（P1，用户已确认 2026-10-27）** — 用户选择先做真实 IM 适配器，并要求把 channel-core 扩展拆成独立里程碑先做。最终：**M7 = channel-core IM 基础设施扩展**（被动回复上下文 A2、`trustedChannels`、多 driver 路由、非重试错误；独立提交，不引入 QQ 代码）；**M8 = QQ 官方 Bot 适配器**；**M9 = SSH host**（原 M7 顺延）。理由：v1 已有本地测试通道与 NixOS 部署，真实 IM 是“日常可用”的最大缺口；core 扩展是 QQ 适配的可靠前置，SSH host 只是新增 provider。规格已通过；M7 已实现（2026-10-27），M8 代码已实现（2026-10-27），真实平台验收待执行。
- **D150 平台与传输（P1）** — 平台：**QQ 官方 Bot**（用户指定；非 Milky/fraq、非 Telegram）。传输：**WebSocket 网关**（`GET /gateway` → WSS；Identify token `QQBot {AccessToken}`；intents `1<<25`），driver 内保留 transport seam，WebHook 后置（需公网回调/TLS 终止，与当前部署姿态冲突）。备注：GitHub 旧文档副本称 WS 将下线，live 文档仍维护 WS；实现前用真实 Bot 复核。状态：M8 已实现（2026-10-27）；WS 真实连接/域名待门禁。
- **D151 发送策略（P1，用户已选方向 + 事实修正）** — 用户选择“被动优先 + 超窗回退主动”。补充：官方发送页横幅称主动推送能力于 2025-04-21 起下线（社区实测 `40034102`），主动回退可能不可用；因此 `activeMessageFallback` 实现为 `auto` 能力门禁（尝试一次，失败标记不可用、可观测），**不作为可靠兜底**。被动基线：单聊 60 分钟/4 次、群聊 5 分钟/5 次。提醒/通知降级见 D161。状态：M8 已实现（2026-10-27）；主动可用性待真实门禁。
- **D152 准入策略（P1，用户已确认）** — 只靠平台自身限制（开发体验用户/自己的群/群内 @ 提及），不做驱动级配对/白名单；channel-core 用 `trustedChannels:["qq-bot"]` 跳过静态全局 allowlist；driver 只做平台级最小过滤。残余风险接受：能触达机器人者可驱动全权限 agent，若 `sudo.enable=true` 等价远程 root；建议部署 `sudo.enable=false`、只加可信群。写入 15.3/15.4。
- **D153 回复上下文与 gateway 会话持久化（P1）** — 被动回复上下文必须放 **channel-core + outbox（A2）**：`OutboundContent.reply{messageId,receivedAt,seq}`、outbox 持久化 `replyTo/replyReceivedAt/replySeq`、`replySeq` 从 1 按 reply 递增；driver 不保存私有回复状态。gateway `session_id/seq` 不跨进程持久化（重启重新 Identify），未发条目按窗口退化/失败。理由：回复在 turn 结束才入 outbox，可能跨秒/分钟、重启、分段与重试；只有 core 知道出站归属哪条入站。状态：M7 已实现（2026-10-27）。
- **D154 协议层依赖（P1，用户已确认 2026-10-27）** — 采用官方 `@tencent-connect/qqbot-nodejs@1.0.5`（MIT，exact pin），只消费 `./protocol` 子路径（`TokenManager`/`ApiClient`/`MessageApi`/`GatewayConnection`/`dispatchEvent`/`ApiError`/`routes`），不启用 facade 中间件/业务层；通道语义（去重/审批/outbox/分段/命令）仍由 channel-core + 自研 driver 承担。集成坑：必须显式传 `msg_seq`（SDK 缺省随机生成）、显式配置域名（默认按文档 `api.bot.qq.com`）。依赖成本：`ws@8.22.0` 已在生产闭包，实际新增 1 个包；需更新 lock 与 `nix/deps.nix` FOD 哈希。官方 DSH 插件 `@tencent-connect/dsh-qqbot` 不采用：它是端到端 agent 插件、绕过 `ctx.channels`，且依赖 UNLICENSED connector、peer semver 与 `0.2.1-rc.3` 不匹配。状态：M8 已按此实现（2026-10-27）。
- **D155 图片链路后置（P1）** — M7 不做入站图片/附件、出站富媒体/Markdown 图片；能力位 `inboundImages=false`、`outboundFiles=false`；driver 忽略 attachments、只转发文本。V8 单独里程碑。状态：M8 已实现（只忽略，2026-10-27）。
- **D156 密钥与配置（P1）** — AppID 为非秘密可入 Nix store/overlay；ClientSecret 只从 EnvironmentFile/agenix 注入的环境变量读取（配置只写变量名）；access_token 仅内存（SDK TokenManager）、不落盘/不上日志；错误日志脱敏（不含 token/正文，只记 bizCode/messageId/chatId）。状态：M8 已实现（2026-10-27）。
- **D157 验收边界（P1）** — 自动化 fake WS/REST + channel-core + fake LLM 的单元/集成/进程级；真实个人主体 Bot（开发体验用户 + 自己的群）手工清单（17.8.2）；目标机 NixOS 部署验收；不做公开服务/群全量/频道。实现前 14 项平台事实门禁（token 域名、intents 权限、被动窗口、`msg_seq` 幂等、主动可用性、文本/Markdown 上限、群字段、WS 在线要求、附件 URL、重连/关闭码、token 刷新、SDK 版本回归等）。状态：fake 自动化已通过；真实验收待执行。
- **D158 channel-core 最小扩展（P1，用户已确认 2026-10-27）** — 用户要求拆成**独立里程碑 M7** 先做，作为 M8 的前置：`ReplyContext`/`OutboundContent` 扩展、`NonRetryableDeliveryError`、capabilities `activeMessages`/`maxRepliesPerReply`、`canDeliver?`、outbox 新字段、`trustedChannels`/`defaultChannelId`、错误分类接入、缺 driver 短路、可选 channel health。理由：不改 core 则回复上下文只能放 driver 内存，存在重启失效/错挂消息/seq 不可靠/静默丢回复等问题。M7 不引入 QQ 代码与外部依赖；完成后 local-test 行为保持兼容。状态：M7 已实现（2026-10-27）。
- **D159 多 driver 路由与通知降级（P1）** — 修复全局 `lastActiveChat`/`defaultChannelId` 串渠道问题：per-turn 来源路由（`turnChat`）、notice 的 active-capable 回退/无渠道丢弃并 warn、交互 `canDeliver` fail closed、缺 driver 条目立即 failed、显式 `defaultChannelId`、允许 local-test + QQ 并存（module warning）。现状在不修复时不应同时启用两渠道。状态：M7 已实现（2026-10-27）。
- **D160 能力位/窗口默认值（P1）** — `markdown="basic"`、`maxTextLength=4500`（实测上限约 5000）、`maxRepliesPerReply=4`、被动窗口单聊 3600s/群聊 300s（可减余量）、chatId 命名空间 `c2c:`/`group:`、`replySeq` 1..N；均可配置，真实 Bot 实测后校准。状态：M8 已接入（2026-10-27）；真实平台校准待门禁。
- **D161 提醒/系统通知降级（P1，用户已确认 2026-10-27）** — 主动推送下线后，无入站上下文的出站（schedule 提醒、系统通知、重启/待应答失效通知）在 QQ-only 部署下无法可靠送达。已调研 Hermes Agent（`NousResearch/hermes-agent`）：其 `QQBOT_HOME_CHANNEL` 只用于选定 cron/通知目标，实际发送仍是不带 `msg_id` 的主动消息（channel/C2C/group 端点 + 有限重试 + 失败记录），**没有 defer/is_wakeup/窗口外兜底**；等价于候选 A。用户选择 **B = active 尝试 + 失败后 `defer`**：通知留在 outbox（或 core 的 per-chat pending notice 队列），等该 chat 下一次入站时以被动回复补投（带“⚠️ 补发”标记）；active 可用时 defer 不触发。实现放在 M7 channel-core 扩展（notice defer 等待语义）与 M8 QQ driver 的能力门禁。参考：[notes/hermes-agent-qqbot-notes.md](notes/hermes-agent-qqbot-notes.md)。状态：M7 core + M8 driver 已实现（2026-10-27）。
- **D162 M7 实现口径（P1，2026-10-27 已实现）** — 按 D158/D159/D161 落地时的实现选择：① deferred notices 与 outbox 共用 `state/outbox.json` 的 `deferredNotices[]`（不新增状态文件），TTL/每 chat/总数上限可配，补投每条默认 1 个被动槽位、正文加“⚠️ 补发”；② 通知目标顺序：`turnChat ?? lastActiveChat` 可投 → 其他有 `defaultChatId` 的 active-capable driver → 同 chat defer → drop；③ `lastActiveChat` 恢复不检查 active 能力（defer 需要 chat 身份），即时投递仍按能力；④ reply 的被动上下文由 driver `canDeliver` 预检，不可投时丢弃 reply 按 active 尝试；无上下文或被动过期后 active 失败时按 D161 defer；交互提示不 defer；⑤ `turnChat` 对运行中显式 followup 先入 pending 队列，由 daemon `turn/start` 提升；⑥ `replySeq` 由 retained outbox items 的 `(channelId,chatId,replyTo)` max+1 推导；⑦ 新增 `ChannelDriver.defaultChatId?` 作为通知回退目标。M7 不引入 QQ 代码。
- **D163 动作按钮扩展空间（P1，用户要求 2026-10-27，已预留）** — QQ 等平台支持消息内带 Action 的按钮；Channel 契约预留 `OutboundAction{id,label,kind:callback|link|command,payload?,url?,style?,disabled?}`、`InboundAction{id,payload?,messageId?}`、能力位 `outboundActions`/`inboundActions`、`OutboundContent.actions` 与 outbox `actions` 持久化；actions 只附在最后一段，deferred 通知/回复丢弃 actions；入站 driver 必须同时提供 `text` fallback，M7 不解释 action。M7/M8 不实现按钮渲染、`INTERACTION_CREATE` 订阅、`PUT /interactions/{id}` 应答或按钮审批；QQ 映射（keyboard、action.type、label≤10、permission/modal）记录在 notes，留给 M8 后置增强。理由：避免按钮/交互回调接入时再次迁移 core 契约与 outbox 文档。
- **D164 M8 实现口径（P1，2026-10-27 代码已实现）** — ① 只消费官方 SDK `./protocol` 的 `TokenManager`/`ApiClient`/`GatewayConnection`；发送直接走 `ApiClient`，不经过 `MessageApi.sendRaw` 的自动 `msg_seq`，active 消息不带 `msg_seq`。② HTTP 200 + body `code`/`err_code` 由 REST 层显式转 `ApiError`（SDK 只在非 2xx 抛错）。③ SDK 1.0.5 把 4009 当 `SESSION_TIMEOUT` 并重新 Identify；1000/4008 等走 Resume；该偏差接受并记录。④ NixOS 选项扁平化（`maxRepliesPerReply`、`c2c/groupReplyWindowSeconds`、`request/connectTimeoutSeconds`），不暴露 `sandbox`/`platformLimitsOnly`/driver 白名单；测试域名覆盖只走 bundle env。⑤ fake WS/REST 零新增依赖；不新增 devDependency。⑥ 不改 channel-core；QQ driver 不设 `defaultChatId`，无入站上下文时通知按 D161 defer/drop。⑦ MD/长度回退、频控、active 1h 标记与 health 按 17.5 实现。代码门禁见 17.10.4 / 14.9；14 项平台门禁与 17.8.2 待真实 Bot 执行。

---

### 第十二轮：后续改进（M9/M10，P1，用户已确认 2026-10-27）

> 本节为 **P1 规格决策**：2026-10-27 用户确认需求后完成规划并落盘。完整规格见 [18](18-qq-button-approval.md)（M9）与 [19](19-persistent-terminal-and-web.md)（M10）。

- **D165 后续里程碑排期（P1，用户已确认 2026-10-27）** — 在 M8 代码完成、真实门禁待执行的基础上，新增两个 v1 后增强里程碑：**M9 = QQ 按钮审批（审批 UX）**、**M10 = host-aware 持久终端 + Web Search/Fetch 能力补齐**。原 D149 中“M9 = SSH host”顺延、不再占用 M9/M10 编号（见 16）。理由：两项都是日常可用性的直接缺口；终端/Web 可本地完整验收，按钮真实平台验收沿用 M8 门禁并新增交互事实门禁。规格见 18/19 与 14.10/14.11。
- **D166 QQ 按钮审批范围与 UX（P1，用户已确认 2026-10-27）** — ① 只有 approval（🔐）使用按钮卡片；`ask_user_question`（❓）暂不改按钮，登记为后续增强。② 两个 callback 按钮：「允许一次」「拒绝」；不提供“始终允许”（DSH `ApprovalOutcome` 只有 `allowed-once`/`rejected`/`cancelled`/`unavailable`，reviewer 也无持久 grant）。③ 点击后**不补发**确认消息，依赖 `PUT /interactions/{id}` 的 ack 反馈。④ **仅 C2C 单聊**启用按钮；群聊保持文本审批（避免群成员可点击与权限指定不确定性）。⑤ 文本回复通道完全保留（允许/拒绝/1/2、超时=拒绝、`/stop`/`/clear` 中止语义不变）。⑥ 规格见 18。
- **D167 动作回调实现口径（P1）** — ① channel-core 产出/解释 `OutboundAction`：broker 为每个待审批交互生成 2 个 `callback` action（短 token，payload 为小 JSON `{"k":"<token>","t":"<fallback>"}`），维护 token→{interactionId,outcome} 映射并在 settle/abort/timeout 清理。② **action 权威**：`process()` 先 `broker.handleAction()`；未知/过期 action 只提示一次“按钮已失效”，不回退把 fallback 文本当审批（防止旧按钮误批新交互）；无 action 的文本路径不变。③ QQ driver 收到 `INTERACTION_CREATE` 先 ack（`PUT /interactions/{id}`，code 0/1/4），再交 ingress；仅 type=11；`messageId=event.id` 用于去重；intents 增加 `1<<26` 并在 Identify 受限时降级重连（health 标记）。④ actions 仅当 driver 能力位为 true 时下发（D163 已有），且 QQ driver 只在 C2C 渲染；群聊剥离。⑤ local-test 通道支持注入 action 供进程测试。⑥ 规格与门禁见 18 / notes/qq-fact-gate.md。
- **D168 持久终端 host-aware 复用方案（P1，用户已确认 2026-10-27）** — 持久终端**必须 host-aware**（模型可选择 `local:*`/`sandbox:*`），**进程内**持久（跨工具调用保留 shell 状态；daemon 重启/`/clear`/agent 释放即关闭），优先复用 DSH。实现：原样复用 `@deepseek-ai/dsh-terminal`（服务）与 `@deepseek-ai/dsh-tool-terminal`（6 工具），利用 `@deepseek-ai/dsh-terminal-bash` 公开导出的 `BashTerminalBackend` 构造函数注入 `spawnTerminal`：按已注册 host 各注册一个 backend（`type`=host id），注入实现经新 host 协议 `terminalLaunch()` 拿 argv/cwd/env，再由 `ctx.subprocess.spawnTerminal` 起真 PTY；PTY 会话机制（就绪检测/scrollback/信号/清理）留在上游。需挂载 `@deepseek-ai/dsh-sandbox-policy`（`mode: danger-full-access`，仅策略解析，无强制）作为 backend 前置。若施工证明注入点不足，回退为 vendoring `dsh-terminal-bash` 并记录新决策。规格见 19。
- **D169 Web 能力与 provider 默认（P1，用户已确认 2026-10-27）** — 同时挂载 `dsh-web` + 双搜索/抓取 provider（`deepseek-official` 搜索 + `http` 抓取为默认；`deepseek-search-api`/`deepseek-fetch-api` 可配置切换），显式 pin provider 以避免多 provider 歧义；`web_search`/`web_fetch` 默认启用；复用 `DEEPSEEK_API_KEY`（`apiKeyEnv` 默认），不新增密钥。真实搜索/API 可用性列为部署门禁。规格见 19。
- **D170 Web 工具豁免 Auto review（P1，用户已确认 2026-10-27）** — `web_search`/`web_fetch` 不进入 vendored auto-review（在 `tools/pre-execute` hook 开头按 `exemptTools` 放行）；`terminal_*`/`bash`/文件等其余工具保持逐次审查。理由：只读外部内容、fetch provider 自带公网地址/SSRF/大小/重定向限制、搜索/抓取高频调用不宜每次多一轮 reviewer；残余风险（外部内容注入、绕过审查）登记 15。豁免列表可配置（默认 `["web_search","web_fetch"]`）。
- **D171 新增 DSH 依赖与升级回归（P1）** — 新增依赖固定 `0.2.1-rc.3`：`dsh-terminal`、`dsh-terminal-bash`（类导入）、`dsh-tool-terminal`、`dsh-sandbox-policy`、`dsh-web`、`dsh-web-search-deepseek`、`dsh-web-fetch-http`、`dsh-web-deepseek-api`、`dsh-tool-web`，以及模块级库 `dsh-credentials`/`dsh-launch-environment`/`dsh-timeout`/`dsh-http-proxy`/`dsh-output-retention`。升级 DSH 时必须回归：`BashTerminalBackend` 构造/注入签名、auto-review `tools/pre-execute` 拦截点与 patch、web provider id/配置、`sandboxPolicy`/session projection 行为。`nix/deps.nix` FOD 哈希与 lock 随依赖更新。

---

### 第十三轮：记忆系统设计（M16，P1，用户已确认 2026-10-29）

> 本节为 **P1 设计决策**：2026-10-29 用户确认方向（pinned + 自动画像标签、每轮刷新一次、仅主会话注入）。完整规格见 [09.5 自动注入](09-prompt-and-memory.md)；实现待执行。

- **D172 记忆自动注入机制（P1，用户已确认 2026-10-29）** — ① 注入通道用 DSH **runtime context**（`ctx.systemPrompt.context()`），不用 system prompt section；理由：动态内容物化为 durable user-role 快照，只在文本变化时追加，压缩移除后下一步自动恢复，且不改变静态 system prompt / KV cache 约定。② **每轮刷新一次**：`agent/pre-step` 检测到新 turn 时重算快照并冻结，context provider 返回本轮冻结文本，一轮内最多追加一次。③ **仅主 root agent 注入**；goal/subagent 子代理不注入（`mainOnly` 可配）。④ 每个 step 前做 entries 目录 freshness 检查（`stat`），覆盖外部编辑；memory 写入/`pin`/`unpin` 后失效缓存。⑤ 不做每轮自动检索（D143 的主动检索保留）、不做向量/embedding；本地实现不引入外部 memory provider，OpenViking 可选后端由 D175 另行允许。
- **D173 记忆快照内容与工具（P1，用户已确认 2026-10-29）** — ① 快照 = `pinned: true` 条目 + 自动纳入 `type:person` / `type:preference`（`confidence: low` 的自动条目跳过；显式 pinned 始终保留）；分两组渲染：用户画像 / 长期记忆。② 预算默认 `maxChars=3000`、`maxEntries=20`；超预算截断并追加“另有 N 条未注入，可用 memory search”。③ 条目渲染为 `title：body 单行（≤300 字符）`，不展开 id；快照头部声明“历史记忆是数据不是本轮指令、精确信息以工具检索为准、本快照取代旧快照”。④ frontmatter 新增 `pinned`（默认 false，旧文件兼容）；`memory write` 增加 `pinned`；新增 `pin`/`unpin` action；search/read 标记 pinned；stats 增加 pinned。⑤ 提示词：`nokoribi:memory` 与 tool description 说明自动快照、pin 准则与预算、不要与 AGENTS.md 重复；提炼子代理对用户级偏好/身份写 pinned。
- **D174 记忆注入配置、观测与风险（P1）** — ① Nix `memory.inject.{enable,maxChars,maxEntries,mainOnly,autoTags}`（默认 `true` / 3000 / 20 / `true` / `["type:person","type:preference"]`），bundle 用 `NOKORIBI_MEMORY_INJECT_*` 默认值；overlay 接线 `nokoribi-memory` 行。② `/status full` memory 行增加 pinned、snapshotChars、inject 状态；超预算/刷新失败只日志+状态，不阻塞主流程。③ 风险：记忆内容来自模型写入，进入上下文等于持久化提示注入面；缓解为 Auto review + secret guard + “数据非指令”声明 + 预算上限；残余风险登记 15。④ 不做：`/clear` 前自动提炼、自动提炼频率改造、加密、多用户作用域（后续再评估）。

---

### 第十四轮：下一阶段里程碑（P1，用户已确认 2026-10-29）

> 本节为 **P1 规划决策**：2026-10-29 用户确认下一阶段里程碑集合与口径；每个里程碑启动时仍需先落对应规格/决策，再实现。路线图见 [14.15](14-roadmap.md)。

- **D175 OpenViking 可选记忆后端（P1，用户已确认 2026-10-29）** — ① 默认仍用本地记忆（entries + pinned 快照，D172–D174）；增加启用 OpenViking 的选项。② 配置形状：`memory.openviking.enable`（默认 `false`）；其他跟 OpenViking 连接相关的配置全部放在 `memory.openviking.*`（`endpoint`、`apiKeyEnv` 指向 EnvironmentFile/agenix 变量且不写入 store、可选 `peerId`/`workspacePeer`/`recallMaxTokens` 等）。③ **启用后 OpenViking 接管**：停用本地 `nokoribi-memory` 组件（存储/工具/快照），不做双写/双读；两者互斥。④ **不打包 openviking-server**：server 由用户外部部署（uv/Docker/云），需自带 embedding + VLM provider。⑤ 接入组件为 `@openviking/dsh-memory-plugin`（Apache-2.0，pin 版本，作为 profile bundle）；前置为 M12 Skill（`dsh-skill`/`dsh-skill-filesystem`）与 M13 MCP 客户端（`dsh-mcp-client`），插件已验证兼容 DSH `0.2.1-rc.3`；启用时 `nokoribi-memory` 行 disabled、memory 提示词段不注册。⑥ 风险：额外 embedding/VLM provider 与密钥面、数据出界、AGPL server 的部署责任、离线/故障降级、MCP 工具审查策略；门禁见 [14.15](14-roadmap.md) 的 M17。
- **D176 下一阶段里程碑集合与顺序（P1，用户已确认 2026-10-29）** — ① 已确认目标（按当前顺序）：**M11 会话检索、M12 Skill、M13 MCP 客户端、M14 消息图片（入站→出站）、M15 提问按钮、M16 记忆本地自动注入、M17 OpenViking 可选后端**。② 当前顺序 **M11 → M12 → M13 → M14 → M15 → M16 → M17**；**记忆与 OpenViking 放在最后**，M17 固定晚于 M12/M13，其余顺序可在启动前按优先级调整。③ 每个里程碑启动时先写决策/规格，再实现并按 AGENTS.md 回写文档；M11/M12 可并行但合并需串行；M15 真实验收沿用 M9 门禁 #15–#20。④ 本阶段不改变 v1 完成定义（14.14）；M11–M17 均为 v1 后增强。

---

## 3.3 未逐条确认、默认采纳的设计提案

以下内容在讨论中提出、用户未反对，作为实现默认方案；若实施时改变需回写文档。

1. **ChannelDriver 契约**：`start/stop/send`、capabilities（markdown、maxTextLength、inboundImages、outboundFiles）、标准 `InboundMessage`（channelId/chatId/senderId/messageId/text/images/receivedAt/delivery）。见 06。
2. **入站幂等**：持久去重 `channelId+messageId`；先记后注入（接受"崩溃丢失极小窗口"以换取不重复处理）。见 05/06。
3. **出站投递**：每轮最后一条非空 assistant 文本；长文本按渠道上限分段、尽量不拆代码块；按 markdown 能力降级；⚠️ 系统通知只覆盖 error/aborted（非用户触发）/goal blocked/daemon 重启。见 06。
4. **交互 broker**：提示前缀 🔐（审批）/ ❓（提问）/ ⚠️（通知）；回复解析编号/允许/拒绝/自定义文本；超时拒绝/报错；全局串行。见 06。
5. **启动/恢复顺序**：单实例锁 → 加载 state → resume main → 挂 channel 并缓冲 → 恢复 goal 子代理 → 清空待应答并通知 → 重发 outbox → 放行缓冲 → `sessionController.markReady()` → schedule 逾期交付。见 05。
6. **状态文件**：`agent-state.json` 保存 mainSessionId、goals[]、lastActiveChat、cleanShutdown、outbox 游标等；原子写。见 05。
7. **提示词分段**：环境/hosts、IM 交互、memory、goal、schedule、safety 六段静态 section；动态值走 runtime context（time-context）。见 09。
8. **memory 规范**：全局 `$DSH_HOME/memory/entries/<id>.md` + frontmatter；单工具多 action；只存持久事实；提炼子代理去重写入；**按需检索 + M16 pinned 快照自动注入**（D172–D174），不做每轮自动检索；M17 可切换 OpenViking 可选后端（D175）。见 09。
9. **AGENTS.md**：首次启动 seed 全局与工作区模板，存在不覆盖；SOUL.md 不进 AGENTS。见 09。
10. **NixOS module 选项表**（models/hosts/review/approval/channel/memory/goal/schedule/prompt/sudo/log 等）。见 12。
11. **构建/装配**：bundle patch 行 id 稳定；Nix 生成 overlay；launcher 读打包 profile；store 目录布局。见 04。
12. **测试策略分层**：Vitest 单元/集成、进程级恢复场景、flake checks；无 VM/CI。见 13。
13. **阶段验收标准**：M1–M6 的交付物与验收（见 14）。

## 3.4 被取代 / 撤销索引

详细说明见 [16 被取代/否决与术语](16-superseded-and-glossary.md)。摘要：

- D02（Web 调试 profile）→ D108 不做。
- D15（summarizer subagent 出站）→ D20 主 agent 直接回复。
- D28（默认 sandbox:workspace 命名）→ D29/D44/D49 语义修正。
- D30（per-host 授权）→ D31/D82 全局 Auto。
- D36/D38（overlay 沙箱）→ D44 撤销。
- D39（workspace shell 文件）→ D45 profile 固定环境。
- D43/D51（commit 基线/覆盖策略）→ D50/D54 无 commit 工具、提示词约束。
- D73（中等 systemd 硬化）→ D79/D81 为 sudo/local 全权限取消。
- D11（v1 仅消息闭环）→ D125 六阶段扩展。
- D97（通用 `subagent` 创建 goal）→ D136（专用 `start_goal` + 宿主创建）。
- D146 的“SSH 留给 M7” → D149 里程碑重排（M7 = channel-core 扩展；M8 = QQ 官方 Bot；M9 = SSH host）。
- D149 的“M9 = SSH host” → D165 后续里程碑重排（M9 = QQ 按钮审批；M10 = host-aware 持久终端 + Web；SSH host 顺延，不再占用 M9/M10 编号）。
- D163 的“M7/M8 不实现按钮渲染/回调” → D166/D167 在 M9 落地审批按钮（群聊按钮、提问按钮仍后置）。
- D143（M5 不做自动注入）→ D172–D174：M16 增加 pinned 快照自动注入（runtime context、每轮最多一次、仅主会话）；主动检索与“不做每轮自动检索”保留。
- D172 的“不做外部 memory provider” → D175：OpenViking 作为可选后端（默认关闭；启用即停用本地记忆；server 不打包，仅连接配置）。
