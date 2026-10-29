# Nokoribi Agent 与 Hermes Agent 的功能对比与缺口

> 快照日期：2026-10-27；**更新：2026-10-29（M9/M10 代码落地与目标机用户态门禁后）**。
> 口径：**Nokoribi = M1–M10 代码已实现**（M9/M10 于 2026-10-29 落地）；M6 目标机清单、M8 QQ 真实平台 14 项门禁、M9 门禁 #15–#20、M10 的 G5 与 systemd 12.14 仍未执行（README、[.spec/14](../14-roadmap.md) 14.7/14.9/14.10/14.11）。**Hermes Agent = `NousResearch/hermes-agent` 官方文档与仓库 `main` 在 2026-10-27 的公开能力**（部分 QQ 细节来自插件源码）。Hermes 文档更新极快、少量数字前后不一致，下文以“文档口径/约”标注。
> 只比较“Hermes 有、Nokoribi 没有或明显更弱”的功能；第 7 节列出非缺口与我方更强项。外部项目仅作事实参考，不复制代码。
> 来源标记：`H:/docs/...` = `https://hermes-agent.nousresearch.com` + 该路径；本地事实引用 `.spec/` 章节与包。

## 1. 结论摘要

1. **定位不同**：Hermes 是“多平台、多 profile、可插拔、自改进的全能个人/团队 Agent 平台”；Nokoribi 是“单用户、单主会话、IM 优先、NixOS 自托管、DSH 精简发行版”。多数缺口属于**广度与生态**，而不是消息闭环这类核心机制。
2. 把 M9/M10 计入后，Nokoribi 已覆盖：IM 对话闭环、审批（含 C2C 按钮）、host 执行与 sandbox、goal 子代理、memory、schedule、持久终端、web search/fetch、NixOS 部署。与 Hermes 相比仍有约 **10 个高优先级方向、15+ 个中优先级方向**的差距，见第 3/4 节。
3. M9/M10 只关闭两个点：**QQ C2C 审批按钮**与**进程内持久终端 + 基础 Web**；它们不改变“渠道/媒体/技能/记忆/扩展性/模型面”的整体差距结构（第 5 节）。
4. **我方并非全面落后**：全工具调用的双档 LLM 审查（fail-closed）、子代理审批桥接、goal 子代理冷恢复、QQ 被动回复 + defer 补投，是 Hermes 对应机制没有或更弱的（第 7 节）。

## 2. 能力总览对比

| 能力域 | Nokoribi（含 M9/M10） | Hermes Agent | 差距 |
|---|---|---|---|
| 运行形态 | 单 systemd daemon、单主会话、IM 为唯一交互面；崩溃恢复/outbox/调度/watchdog | Python 单 agent core + gateway；CLI/TUI/Desktop/Web/API/ACP 多前端共享会话；多 profile/多 gateway | 大 |
| IM 渠道 | QQ 官方 Bot（C2C、群 @）+ 本地测试通道 | 20+ 平台（Telegram/Discord/Slack/WhatsApp/Signal/Matrix/Feishu/WeCom/QQ/Teams/…）+ webhook/A2A/relay | 大 |
| IM 交互能力 | 文本/Markdown；M9 起 C2C 审批按钮；无图片、文件、语音、流式、编辑、reactions、线程、群权限 | 图片/语音/文件/视频进出、流式编辑、按钮/审批、线程、reactions、语音通话；按平台能力不同 | 大 |
| 群组/多用户 | 单用户；QQ 群仅 @ 提及；准入只依赖平台边界 | 多用户/团队、DM 配对/allowlist/admin 分层、Bot Mode 多 bot 群聊与互发、组内按用户隔离 | 大 |
| 记忆 | `memory` 工具主动检索 + goal 终态提炼子代理；**不自动注入**；无 agent 侧会话检索 | MEMORY.md/USER.md 冻结快照注入、FTS5 `session_search`、后台自改进 review、外部 memory provider | 大 |
| 技能/学习 | 技能行未挂载（[.spec/04](../04-architecture-and-build.md) 只列为“保留”）；无技能创建/生命周期 | SKILL.md 渐进披露、bundled/optional hub、agent 创建技能 + curator 生命周期 | 大 |
| 审批/安全 | Auto 预设下**每次工具调用**过 fast/strong LLM reviewer，fail-closed；IM 单次授权；无确定性命令规则、容器隔离、egress、回滚 | 危险命令规则 + hardline blocklist + smart/manual/off 审批 + 用户 deny glob + 容器隔离 + egress + checkpoint/rollback + secrets 源 | 中（安全哲学不同，各有强弱） |
| 执行环境 | `local:workspace` + Nix `sandbox:default`（非安全边界、no_new_privs）+ M10 进程内持久终端；无 SSH/容器/远程 | local/Docker/SSH/Daytona/Modal/Vercel Sandbox/Singularity 插件；PTY + 后台进程管理；git worktree；checkpoint/rollback | 大 |
| 长程任务 | DSH goal 子代理（多并行、重启冷恢复、归档）；generic subagent；无 per-task schema/model/worktree | `delegate_task` 并行子代理（默认 10 并发）+ output_schema + worktree 隔离 + live steer/stop + stall monitor；persistent goals/judge/gates；kanban | 中 |
| 自动化 | 4 个 schedule 工具，提醒进入主会话；无 heartbeat/loop；无 hooks/batch | cron 深度（自然语言、script-only 无 LLM、挂技能、catch-up、chaining、投递任意平台、doctor）+ loops/heartbeat + hooks + batch/RL | 大 |
| 模型 | DeepSeek 单 provider；主/子/reviewer 路由；无 `/model`、无 fallback、无本地模型 | 40+ provider、多模型目录、OAuth/本地/自定义、fallback、11 个辅助模型槽位、MoA、`/model` 热切换 | 大 |
| Web/媒体 | M10 = `web_search`/`web_fetch`，2 个 provider；无浏览器、视觉、图像/语音生成、文档抽取 | 11 个 web 后端 + `browser_exec`/CDP + vision + image gen + TTS/STT/voice + document extraction + deliverable | 大 |
| 扩展性 | 固定 bundle + Nix 配置；无 MCP/插件/hooks/A2A | MCP（stdio/HTTP/OAuth/过滤/sampling）+ 插件系统（catalog、隔离、hooks）+ A2A + skills hub | 大 |
| 前端/部署/运维 | 无 Web UI/Desktop/交互 CLI；NixOS module + systemd + agenix；journald + `/status` | CLI/TUI/Desktop/Web dashboard/OpenAI-compatible API/ACP/Python lib；macOS/Windows/Linux/WSL/Docker/Nix/Termux；监控/分析/导入迁移 | 大 |

## 3. 高优先级缺口（影响日常使用或能力上限）

### 3.1 多 IM 平台与失败冗余
- **Hermes**：一个 gateway 接 20+ 平台（文档口径“21+：19 native + IRC/Teams 插件”，另有 webhook/A2A/relay 等非聊天面），各平台共享会话路由与投递；`/platform list|pause|resume` 可不停机启停（H:/docs/user-guide/messaging/）。
- **Nokoribi**：只有 QQ 官方 Bot（C2C + 群 @）与本地测试通道（[.spec/17](../17-qq-official-bot.md)）。QQ 主动推送已于 2025-04-21 下线，提醒只能 active 尝试 + 下次入站补投（D161）；平台准入/封禁风险由用户承担（D152）。
- **影响**：单平台 = 单点故障；QQ-only 部署一旦平台收紧/封禁/主动推送不可用，提醒与系统通知无法可靠触达。这是相对 Hermes 最影响“可用性”的缺口。

### 3.2 富媒体双向链路
- **Hermes**：主流平台支持图片/语音/文件/视频的入站与出站，产物按平台原生附件投递（deliverable mode）；QQ（按插件源码）也支持图片、语音、视频、文件上传下载与两段式 ASR（H:/docs/user-guide/messaging/、H:/docs/user-guide/features/deliverable-mode、H:/docs/user-guide/features/document-extraction）。
- **Nokoribi**：入站图片仍返回 501、`inboundImages=false`；无出站附件/语音；QQ 附件被忽略（[.spec/11](../11-models-and-cost.md) 11.2、[.spec/17](../17-qq-official-bot.md) 17.4/17.5；D155/V8 后置）。M9/M10 不涉及媒体链路。
- **影响**：截图、文件、语音消息这些 IM 高频输入完全不可用；交付物只能以文本返回。

### 3.3 技能系统（SKILL.md / 自创建 / hub）
- **Hermes**：agentskills.io 兼容的 SKILL.md，三级渐进披露；`skill_manage` 创建/修改/删除；`/learn` 从会话/目录/URL/书稿生成技能；hub 多源安装 + 4 档信任 + 安全扫描；curator 做陈旧/归档/审计/回滚；文档口径约 90 个 bundled、约 60 个 optional（目录页数字不一致）。技能也是 slash command（H:/docs/user-guide/features/skills、H:/docs/reference/skills-catalog）。
- **Nokoribi**：`dsh-skill` 能力包未进实际 bundle（[.spec/04](../04-architecture-and-build.md) 4.4 仅列为“保留，v1 不重点使用”）；无技能工具、无 hub、无技能生命周期。
- **影响**：Hermes 的核心“能力增长”机制缺失；复杂操作经验只能靠 AGENTS.md/memory 或改代码。

### 3.4 MCP 与插件扩展
- **Hermes**：MCP 客户端支持 stdio、HTTP、OAuth/DCR/CIMD、mTLS；按 server 用 fnmatch glob 过滤 tools/prompts/resources；sampling、elicitation、每 chat spend limit、`optional-mcps` 目录（H:/docs/user-guide/features/mcp）。插件系统含 ~25 个 `ctx` 注册 API、约 35 个生命周期 hook、plugin catalog（文档称 348 条，其中 299 条可 out-of-process 隔离）、安装前安全扫描（H:/docs/user-guide/features/plugins、H:/docs/user-guide/features/hooks）。
- **Nokoribi**：固定 bundle，新增能力要改代码 + `nixos-rebuild`；MCP 在 [.spec/16](../16-superseded-and-glossary.md) 明确“未纳入 v1”；无插件/hook 面。
- **影响**：无法接入现成 MCP 生态，扩展成本高；Hermes 的大量能力（Home Assistant、Spotify、内存后端等）本身就是插件/MCP。

### 3.5 记忆自动注入与会话检索
- **Hermes**：`MEMORY.md`（2,200 字符）与 `USER.md`（1,375 字符）作为**会话开始时的冻结快照**注入系统提示（保持前缀缓存）；`memory` 工具 add/patch/remove；`session_search` 基于 SQLite FTS5 的 discovery/scroll/read/browse 四种形态，无 LLM 调用；回合后后台自改进 review 写记忆/技能；可选 6 个外部 memory provider（H:/docs/user-guide/features/memory、H:/docs/user-guide/features/memory-providers、H:/docs/user-guide/sessions）。
- **Nokoribi**：只有主动检索的 `memory` 工具（search/read/write/forget）+ goal 终态一次性提炼子代理；**不自动注入**（D143）；`/clear` 后没有记忆预热；无 agent 侧 session search（`dsh-session-query-sqlite` 仅供 `listChildren`）；无向量/embedding/外部 provider（[.spec/09](../09-prompt-and-memory.md) 9.5）。
- **影响**：模型会“忘记”用户偏好；跨会话回忆依赖模型主动 search，实际回忆率明显低于 Hermes。

### 3.6 浏览器、多模态与文档处理
- **Hermes**：`browser_exec`（模型写 Python 驱动 CDP，浏览器状态跨调用保留）+ `browser_cdp`/`browser_dialog`/`browser_vault`；本地 Chromium/云浏览器/Lightpanda/自带 Chrome/真实 profile；vision（原生像素或 aux 视觉模型）、image generation（11 个模型，FAL 默认 + 多 provider）、TTS（11 个 provider）、STT（8 个）、voice mode、document extraction（PDF/Office/notebook/SQLite）、computer_use、deliverable mode（H:/docs/user-guide/features/browser、web-search、vision、image-generation、tts、document-extraction）。
- **Nokoribi**：M10 只提供 `web_search`/`web_fetch` 两个工具、2 个 provider（`deepseek-official` + `http`）；无浏览器自动化、无视觉/图像/语音、无文档抽取；图片入站本身未实现（[.spec/19](../19-persistent-terminal-and-web.md)）。
- **影响**：研究型任务（动态网页、截图、PDF 汇报、语音）能力差距最大；M10 只是“能搜/能抓”。

### 3.7 多 provider / 模型热切换
- **Hermes**：40+ provider（Nous Portal、OpenRouter、OpenAI、Anthropic、Gemini、Bedrock、DeepSeek、本地 Ollama/LM Studio、自定义 endpoint 等）、OAuth/API key/credential pool、fallback 链、11 个辅助模型槽位、MoA、`/model` 热切换、模型目录与上下文窗口解析（H:/docs/integrations/providers、H:/docs/user-guide/configuring-models）。
- **Nokoribi**：DeepSeek API key 单 provider；主模型/goal/reviewer 路由在 Nix 配置里固定；无 `/model`、无 provider fallback、无本地模型、无模型目录（[.spec/11](../11-models-and-cost.md) 11.1/11.6，D10/D141）。
- **影响**：模型故障/限流时无法切换；成本/质量/本地化选择受限；每换模型都要重新部署。

### 3.8 自动化深度（cron / 脚本任务 / hooks）
- **Hermes**：gateway 内置 cron（60s tick），支持相对/自然语言/cron 表达式；script-only 无 LLM 任务、`wakeAgent` 预检、可挂 0..N 技能、`context_from` 任务链、catch-up/misfire、per-job 模型、投递到任意平台、preflight 与 `hermes cron doctor`；另有 `/loop`、heartbeat、gateway/plugin/shell/outbound-webhook 四类 hooks、batch 轨迹生成（H:/docs/user-guide/features/cron、loops、heartbeat、hooks、batch-processing）。
- **Nokoribi**：`schedule_create/list/update/delete` 四工具，任务以 follow-up 进入主会话；最小间隔 60s；只有主会话能用；无脚本任务、无技能挂载、无链式上下文、无多平台投递、无 hooks/heartbeat（[.spec/10](../10-goals-and-schedule.md) 10.10，D62/D139）。
- **影响**：定时任务只能“提醒主 agent 再说一遍”，不能做无模型的监控/脚本投递、任务链、跨平台通知。

### 3.9 子代理委派深度
- **Hermes**：`delegate_task` 单任务或并行批次（默认 10 并发），每个子代理有独立会话/终端/toolset；支持 `output_schema`（JSON Schema 校验 + 一次纠错）、`images`、worktree 隔离、live `list/steer/stop`、stall monitor、nested orchestrator、live transcript、完成事件持久化；persistent goals 有 judge/子目标/quality gates（H:/docs/user-guide/features/delegation、goals）。
- **Nokoribi**：DSH goal 子代理可并行、可冷恢复、可归档（这是优势）；generic subagent 可用，但无 per-task schema/worktree、无 stall monitor/嵌套 orchestrator，子代理模型选择后移（D141）；无 goal judge/质量门禁（[.spec/10](../10-goals-and-schedule.md) 10.2–10.8，D136/D138/D141）。
- **影响**：大规模并行任务的结构化汇总、隔离与干预能力弱；不过单纯“长任务持续跑”我们更强（见第 7 节）。

### 3.10 远程/容器执行与回滚
- **Hermes**：终端后端 local/Docker/SSH/Daytona/Modal/Vercel Sandbox/Singularity 插件；容器默认只读 rootfs、drop caps、PID limit、namespace 隔离；可选 iron-proxy egress 与 Docker 网络隔离；checkpoint/rollback 用 shadow git；git worktree；LSP 诊断（H:/docs/user-guide/features/tools、checkpoints-and-rollback、egress、git-worktrees）。
- **Nokoribi**：只有 `local:workspace` 与 Nix `sandbox:default`；**sandbox 不是安全边界**（同用户、不挂 workspace 但可读宿主可读文件）；SSH host 未排期（D149/D165）；无 Docker/远程/容器硬化；无 checkpoint/回滚、无备份、无 worktree 隔离（[.spec/07](../07-shell-hosts-and-sandbox.md) 7.9/7.11，D44/D84/D105）。
- **影响**：不能把执行放到远端/容器；高危操作没有确定性回滚；对“在服务器上跑常驻 agent”的 Hermes 典型用法覆盖不足。

## 4. 中优先级缺口

**前端与接口**
- 无交互式 CLI/TUI、Desktop、Web dashboard、OpenAI-compatible API server、ACP 编辑器集成、Python library；Nokoribi 只有 IM + loopback 测试通道（[.spec/01](../01-background-and-requirements.md) 1.6；H:/docs/user-guide/cli、desktop、features/web-dashboard）。
- 无多 profile / 多 gateway / 多实例隔离；Hermes 每个 profile 有独立 config/memory/skills/sessions，并可多路复用同一 gateway（H:/docs/user-guide/profiles、multi-profile-gateways）。

**渠道与通知增强**
- 无 DM/群组配对与 allowlist、admin/user 命令分层（Hermes 5 层授权：平台 allow-all → allowlist → pairing → global allow-all → default deny；H:/docs/user-guide/messaging/）。Nokoribi 只有平台边界 + `trustedChannels`（D152）。
- 无跨平台 home channel/`deliver:` 投递、`[SILENT]`/`NO_REPLY` 静默 token、typing 指示、消息编辑/线程/reactions（H:/docs/user-guide/messaging/、features/cron）。
- 无 webhook 事件触发、A2A、Relay、邮箱/SMS/Open WebUI 等非聊天入口（H:/docs/user-guide/messaging/）。
- 语音：无 STT/TTS/voice mode/Discord 语音频道（H:/docs/user-guide/features/voice-mode）。

**安全与审批增强**
- 无确定性 hardline blocklist（rm -rf /、fork bomb、mkfs 等永远拒绝）与用户 deny glob（含 shell launcher 反混淆）；无 `approvals.mode = smart|manual|off`、YOLO、headless 默认 deny、审批历史挖掘（H:/docs/user-guide/security）。
- 无容器隔离、egress proxy/网络白名单、credential vault、Bitwarden/1Password/command 三类 secret source、MCP 凭据过滤与 spend limit（H:/docs/user-guide/security、secrets、egress、features/credential-vault）。
- 无 checkpoint/rollback、无 upgrade 前快照/自动回滚（D84/D105/D110）。

**扩展性与自动化**
- 无 MCP、插件系统、hooks（gateway/plugin/shell/outbound）、`execute_code` 程序化工具调用、Tool Search 渐进披露、批处理/轨迹/RL、kanban 多 agent 看板、Bot Mode（H:/docs/user-guide/features/code-execution、tool-search、batch-processing、kanban、plugins）。
- 无 A2A、Relay、从 OpenClaw/Claude Code/Codex/Cursor 导入迁移（H:/docs/user-guide/import-from-other-agents）。

**上下文/会话/可观测**
- 有 `dsh-compaction-basic` + tool-result pruner + token meter，但无 Hermes 式 4 阶段压缩（prune→边界→结构化摘要→拼装）、50%/85% 双层阈值、in-place compaction、prompt caching、context engine 插件；`/compact` 文档写了但实际未挂载（[.spec/11](../11-models-and-cost.md) 11.4、[.spec/14](../14-roadmap.md) 14.2）。
- 无会话搜索/回溯/编辑重生成/分支/replay；无 dashboard analytics、metrics/OTel、doctor/state DB recovery/transactional update、managed scope、语言包/主题（H:/docs/user-guide/sessions、features/web-dashboard、reference/faq；[.spec/13](../13-testing-and-ops.md) 13.9 明确接受可观测缺口）。

**工具与媒体长尾**
- 无 LSP 语义诊断、Google Workspace/邮件助手、Home Assistant、Spotify、X/Twitter search、视频生成、computer use、image/video 附件、文档抽取、`present` 交付物模式（Hermes 为内建或 official skill/plugin）。
- 无 `send_to_user` 工具（[.spec/06](../06-channel-and-interaction.md) 6.7 仅为草案，未注册），M10 也无出站文件。

## 5. M9/M10 关闭了什么、还剩什么（代码已实现）

> M9/M10 代码已于 2026-10-29 落地；M10 的 G2/G3/G4/G6 已在目标机用户态通过，G5 与 systemd 12.14 待执行；M9 门禁 #15–#20 待真实 Bot 执行（[m10-fact-gate.md](m10-fact-gate.md)、[qq-fact-gate.md](qq-fact-gate.md)）。

| Hermes 能力 | M9/M10 已实现（2026-10-29） | 仍然存在的缺口 |
|---|---|---|
| QQ C2C 审批按钮 | M9：核心 broker 生成 2 个 callback action（允许一次/拒绝）、C2C 内联键盘、`INTERACTION_CREATE` + `PUT /interactions/{id}` ack、intent 降级、文本 fallback（[.spec/18](../18-qq-button-approval.md)） | Hermes QQ 是 3 按钮（允许一次/始终允许/拒绝）+ update-prompt 按钮，审批可覆盖群/guild；Nokoribi 的群聊/提问仍无按钮；“始终允许”按 D166 明确不做（DSH 无持久授权语义）；真实平台门禁 #15–#20 未执行 |
| 持久终端 | M10：`terminal_*` 6 工具、host-aware（`local:*`/`sandbox:*`）、进程内持久、sandbox pin/TTL/reset 互锁（[.spec/19](../19-persistent-terminal-and-web.md)） | 跨 daemon 重启恢复（tmux/screen attach）不做；SSH/容器/远程后端终端不做；sandbox 终端仍需 Nix buildEnv；Hermes 还有 process manager、background handoff、worktree |
| Web 搜索/抓取 | M10：`web_search`/`web_fetch`，默认 `deepseek-official`+`http`，可切 API provider，reviewer 豁免（D169/D170） | 无 `web_extract`、无浏览器自动化、无 11 个搜索后端、无缓存/网站 blocklist、无 vision/image/TTS/STT、无文档抽取 |
| 审批噪声控制 | M10：`exemptTools` 仅豁免两个 web 工具 | 只读 web 豁免后少一层 LLM 审查（D170 已接受）；无确定性 hardline 规则/容器隔离/egress 兜底 |

**结论**：M9/M10 更像“补齐单点能力”，让 Nokoribi 在 QQ 场景下更接近 Hermes 的 QQ 适配器（按钮）与基础 web/终端工具；但 Hermes 的差距核心在**平台广度、富媒体、技能/记忆、扩展生态、模型面与执行后端**，这些与 M9/M10 基本正交。

## 6. 明确非目标 / 后置（有意取舍，不是“漏做”）

以下项在 Hermes 有、Nokoribi 明确不做或后置；按用户决策保留，但与 Hermes 对标时仍是能力差：

- Web UI / web-debug（D108）；heartbeat / 主动唤醒（D62）；多用户/群聊权限模型（D152）；token 预算/每日配额（D70）。
- SSH host（原 M7/M9，D149→D165 顺延，未排期）；跨重启终端持久（D168）；远程文件工具（未设计）。
- 自动备份、自动回滚、升级前快照（D84/D105/D110）；NixOS VM 测试与 GitHub CI（D129/D130）。
- 图片/附件入站链路（V8 后置，D16/D69/D155）；QQ 群全量消息、guild、WebHook、第二 IM 平台（[.spec/14](../14-roadmap.md) 14.12）。
- C2C 流式、消息编辑/撤回、提问按钮、群聊按钮、“始终允许”持久授权、多待审批并行展示（[.spec/18](../18-qq-button-approval.md) 18.9）。
- DSH 权限沙箱作为执行边界（D31/D34）、sandbox 强制隔离（容器/bwrap，D48）。

## 7. 非缺口 / 我方更强项

1. **全工具调用的 LLM 审查**：Auto 预设下每个工具调用都过 fast/strong 两档 reviewer，技术失败 fail-closed，拒绝后才走 IM 单次授权；child 的审批还被桥接到 IM（D131）。Hermes 是“危险命令规则 + 可选 aux-LLM smart approval”，并非每个工具调用都审查；两者哲学不同，但 Nokoribi 的审查覆盖面更广（代价是延迟/成本，[.spec/08](../08-autoreview-and-security.md) 8.2–8.5）。
2. **子代理审批桥接**：Hermes 文档明确 leaf subagent 禁用 `clarify`、subagent 不能交互输入 sudo 密码；Nokoribi 能把 child 的 reviewer deny 转成 IM 审批（D131；[.spec/08](../08-autoreview-and-security.md) 8.5）。
3. **Goal 子代理冷恢复**：Nokoribi 的 goal child 在 daemon 重启后 `sendMessage` 冷恢复 → live → `ctx.goals.resume` re-arm，继续跑（D90/[.spec/10](../10-goals-and-schedule.md) 10.6）。Hermes 的 delegation child 在 owner 死亡后只记为 unknown，不会 resume 子代理执行（H:/docs/user-guide/features/delegation）。
4. **QQ 被动回复 + defer 补投**：Nokoribi 在 QQ 上做 passive-first（msg_id/msg_seq）、主动失败后按 chat defer 到下一次入站补投（D151/D153/D161/D162，[.spec/17](../17-qq-official-bot.md) 17.5）。Hermes 的 QQ cron/通知是不带 `reply_to` 的主动消息，未针对 2025-04-21 主动推送下线做 defer；其 docs 也未覆盖该降级。
5. **单用户精简 + 纯 Nix 只读配置**：更小的运行时面、固定 DSH/Node 版本、单一 systemd 服务与 watchdog；这是定位差异（Hermes 走通用平台与多前端），不必然“更强”，但换来了更小的攻击面与更简单的部署模型（[.spec/01](../01-background-and-requirements.md) 1.7、[.spec/12](../12-nixos-deployment.md)）。

## 8. 若要对齐 Hermes，建议的优先级

1. **先做真实平台门禁**：M8 的 14 项 + M9 的 #15–#20；Hermes 已在真实平台运行，我们连“QQ 的被动窗口/主动可用性”都还没实测，这会让所有渠道结论悬空。（2026-10-29 状态：探针脚本与门禁表已就绪；M10 的 G2/G3/G4/G6 已在目标机用户态通过，M8/M9 的 QQ 门禁仍需真实凭据执行。）
2. **第二 IM 通道**（Telegram 或飞书优先）：解决单平台风险；这也是 Hermes 20+ 渠道里收益最高的一步。随后补富媒体（图片/文件）与语音。
3. **记忆自动注入 + 会话搜索**：不需要外部 provider，先把 MEMORY/USER 快照与 FTS5 式 session search 补上，日常“记得住”的收益远大于更多工具。
4. **技能系统**（至少挂载 `dsh-skill` 并支持 agent 创建/复用）：这是 Hermes 的能力增长引擎；可先做本地 skills 目录，不做 hub。
5. **MCP 客户端 + 插件面**：接入现成生态比自研每个工具更划算；先支持 stdio/HTTP + tools 过滤，再考虑 hooks。
6. **多 provider / `/model` / fallback**：去掉 DeepSeek 单点依赖；再补浏览器与多模态。
7. **明确不追**：Web UI、heartbeat、多用户、SSH（按现有决策），避免范围失控；若要追，单独立项。

## 9. 来源

**Hermes Agent（2026-10-27 快照）** — 全部页面根为 `https://hermes-agent.nousresearch.com`，下文只列路径：
- 入口：`/docs/llms.txt`（全站索引）、`/docs/getting-started/platform-support`、`/docs/getting-started/nix-setup`。
- 核心：`/docs/developer-guide/architecture`、`/docs/developer-guide/agent-loop`、`/docs/user-guide/features/tools`、`/docs/reference/tools-reference`、`/docs/reference/toolsets-reference`、`/docs/user-guide/features/delegation`、`/docs/user-guide/features/goals`、`/docs/user-guide/features/cron`、`/docs/user-guide/features/code-execution`、`/docs/user-guide/features/kanban`、`/docs/user-guide/features/hooks`、`/docs/user-guide/features/batch-processing`。
- 记忆/技能/上下文：`/docs/user-guide/features/memory`、`/docs/user-guide/features/memory-providers`、`/docs/user-guide/sessions`、`/docs/user-guide/features/skills`、`/docs/user-guide/features/curator`、`/docs/user-guide/features/context-files`、`/docs/user-guide/features/personality`。
- 安全/扩展：`/docs/user-guide/security`、`/docs/user-guide/checkpoints-and-rollback`、`/docs/user-guide/secrets`、`/docs/user-guide/egress`、`/docs/user-guide/features/mcp`、`/docs/user-guide/features/plugins`。
- Web/媒体：`/docs/user-guide/features/web-search`、`/docs/user-guide/features/browser`、`/docs/user-guide/features/vision`、`/docs/user-guide/features/image-generation`、`/docs/user-guide/features/tts`、`/docs/user-guide/features/voice-mode`、`/docs/user-guide/features/document-extraction`、`/docs/user-guide/features/deliverable-mode`。
- 渠道/前端/模型：`/docs/user-guide/messaging/`、`/docs/user-guide/messaging/qqbot`、`/docs/user-guide/messaging/webhooks`、`/docs/user-guide/messaging/a2a`、`/docs/user-guide/bot-mode`、`/docs/user-guide/cli`、`/docs/user-guide/desktop`、`/docs/user-guide/features/web-dashboard`、`/docs/integrations/providers`、`/docs/user-guide/configuring-models`。
- QQ 细节（源码级）：`NousResearch/hermes-agent` 的 `plugins/platforms/qqbot/{adapter,keyboards,constants}.py`（按钮/富媒体/ASR/4000 字符上限/无流式）；本仓库既有调研 [hermes-agent-qqbot-notes.md](hermes-agent-qqbot-notes.md) 也可交叉核对。
- 已知不确定：skills 数量（索引 ~90/~60 vs 目录页 58/~150）、hook 数量（27 vs ~35）、工具数（70+ vs ~85）、`delegation.max_iterations`（50 vs 250）、并发子代理数（10 vs 3）、平台数（21+/19 vs 25+）、RetainDB/ByteRover 是否仍在 core、QQ 主动消息配额/媒体大小上限、“native vs plugin”分类。这些不影响本对比的结构性结论。

**Nokoribi Agent（本地）**
- 规格索引：[README.md](../../README.md)、[.spec/14 路线图](../14-roadmap.md)、[.spec/18 M9](../18-qq-button-approval.md)、[.spec/19 M10](../19-persistent-terminal-and-web.md)。
- 实现现状：[.spec/04](../04-architecture-and-build.md)、[.spec/05](../05-daemon-and-session-lifecycle.md)、[.spec/06](../06-channel-and-interaction.md)、[.spec/07](../07-shell-hosts-and-sandbox.md)、[.spec/08](../08-autoreview-and-security.md)、[.spec/09](../09-prompt-and-memory.md)、[.spec/10](../10-goals-and-schedule.md)、[.spec/11](../11-models-and-cost.md)、[.spec/12](../12-nixos-deployment.md)、[.spec/13](../13-testing-and-ops.md)、[.spec/17](../17-qq-official-bot.md)。
- 实际 bundle：[packages/bundle/cordis.patch.yml](../../packages/bundle/cordis.patch.yml)；M9/M10 已于 2026-10-29 实现，M10 目标机用户态 G2/G3/G4/G6 通过（见 [m10-fact-gate.md](m10-fact-gate.md)）。

## 10. 更新记录

- 2026-10-27：初版快照（M1–M8 代码实现；M9/M10 仅有已确认规格）。
- 2026-10-29：M9/M10 代码实现（M10 目标机用户态 G2/G3/G4/G6 通过；M9 #15–#20、M10 G5 与 systemd 12.14 待执行）。同步更新口径、第 5/8/9 节的状态表述；Hermes 事实仍为 2026-10-27 快照，未重新拉取。
