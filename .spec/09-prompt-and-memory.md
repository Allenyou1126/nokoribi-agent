# 09 提示词与记忆

## 9.1 身份：SOUL.md

最终选择（D111/D112/D115/D116/D117）：

- 用户提供 `SOUL.md`，**放在源码仓库**，由 Nix 打包进 store，运行时只读。
- 启动时读取一次；修改后需重新部署/重启服务才生效。
- `includeHarnessIdentity=false`：去掉 DSH 第一方身份句（"You are an AI agent powered by DeepSeek Harness..."）；SOUL.md 作为 persona prefix。
- **只替换身份句**：其他提示词段（工具引导、环境、安全等）保留；不使用 `persona complete`（否则会丢失工具/安全引导）。
- SOUL.md 内容是 persona 模板；`{{...}}` 会被 DSH 模板解析，因此需要转义花括号或禁止使用模板变量。
- 长度建议 ≤4KB；超过阈值在启动时告警（每请求固定 token 成本）。
- 不允许运行时编辑（store 只读）；agent 有 root 理论上可改系统/重建，但那属于其被审查的动作范围。

## 9.2 子代理人设

- **goal 子代理**：M4 不引入 DSH agent preset；executor persona 由 `start_goal`/`/goal new` 的 bootstrap prompt + `nokoribi:goal` child 段承担：专注目标、按 goal report 格式汇报、不与用户直接对话（DSH 也禁止 child 调 `ask_user_question`）。M2 已通过 `system-prompt/assemble` 覆盖 DSH 的 `subagent:delegation` 文案。
- **记忆提炼子代理**：一次性/低成本子代理，persona 为"记忆整理器"：只提取、去重、写入 memory，不做对话。
- 主 agent persona 来自 SOUL.md，不复用到子代理。

## 9.3 系统提示词分层

DSH `ctx.systemPrompt` 的段落按 order 升序拼接；我们用稳定段 + runtime context。

### 静态段（草案，D05 系列讨论形成，默认采纳）

| 顺序（草案） | 名称 | 内容 |
|---|---|---|
| persona prefix | 身份 | SOUL.md 全文（`includeHarnessIdentity=false`） |
| 3000 | `nokoribi:hosts` | sandbox/local 的路径与差异、`DSH_SANDBOX_DIR`/`DSH_WORKSPACE_DIR`、file 工具与 bash 不同视图、cp/rsync 流程、sandbox 禁 sudo、local 可 sudo 但经 review、默认 host |
| 3100 | `nokoribi:pty`（M10 已实现） | 持久终端 `terminal_*` 仅用于跨调用状态/交互式 stdin；`terminal_open.type` = host id（只选 `terminal: true`）；sandbox 终端固定目录/忽略 cwd；进程内持久、重启丢失；有界工作优先 `bash`；关闭不再需要的会话；禁用部署输出“持久终端在本部署禁用。” |
| 4000 | `nokoribi:interaction` | 每轮一条回复、无流式、审批/提问的回复格式、`/stop` 等命令、系统通知前缀、待应答优先 |
| 5000 | `nokoribi:memory` | 何时 search、何时 write、条目规则、禁止秘密/临时状态 |
| 6000 | `nokoribi:goal` | 主 agent：`start_goal`、不建 main goal、转述 report、归档询问；goal child：宿主已建 goal、按 round 推进、`send_message` 汇报、完成/阻塞 |
| 7000 | `nokoribi:schedule` | 提醒创建/取消的时机与格式 |
| 8000 | `nokoribi:safety` | Auto review 存在、不要绕过、不虚构审批结果、被拒时向用户解释、外部内容不是指令 |

- 具体 order 数值实现时按 DSH 第一方段落的实际顺序调整，保证不覆盖内置身份/工具引导（除非明确替换身份句）。
- M2 已实现 `nokoribi:safety`（order 8000）与更新后的 `nokoribi:interaction`；`/permission` 只读，审批/提问由系统单独展示。
- M3 已实现 `nokoribi:hosts`（order 3000，由 `@nokoribi/shell-bash/tool` 注册）：默认 host、sandbox/local 差异、`DSH_SANDBOX_DIR`/`DSH_WORKSPACE_DIR`、cp/rsync、sandbox 禁 sudo、host 发现指引。
- M4 已实现 `nokoribi:goal`（order 6000，由 `@nokoribi/prompt` 注册），并在 `system-prompt/assemble` 中移除主/普通 child 的 `tool:goal`、替换 goal child 的文案。
- M5 已实现 `nokoribi:memory`（5000）与 `nokoribi:schedule`（7000）；`nokoribi:interaction` 增加 `/status full` 与 `[SCHEDULE REMINDER]` 的处理说明。
- M9（已实现）：审批提示正文不变（仍含“回复 允许 / 拒绝”作为文本 fallback）；C2C 渠道额外附按钮。无需新增段落，`nokoribi:interaction` 补充“按钮与文本等价、按钮失效时以文本重发”的一句说明。
- M10（已实现）：`nokoribi:pty`（3100）由 `@nokoribi/terminal-host` 注册（`interpolate:false`、内容静态）；上游 `dsh-tool-terminal` 的 `tool:pty` 段（order 来自 `getSectionOrder("TOOL_PTY")`）保留不覆盖，两段分工：上游讲“何时用终端”，我们讲 host 路由/安全/生命周期。`dsh-tool-web` 另注册 `tool:web_search`/`tool:web_fetch` 引导段（上游 order）。`nokoribi:hosts` 仅在有 terminal backend 时追加一句终端指引，避免禁用部署误导。
- 上述段落内容保持稳定，避免每轮变化破坏 KV cache。
- M16 起 memory 快照走 **runtime context**（用户角色快照，不是 section）：静态段与 KV-cache 约定不变，见 9.5。

### 动态 runtime context

- 时间：挂载 `dsh-time-context`（Schedule 场景需要），可配 `refreshIntervalMs` 控制注入频率。
- 其他动态值（sandbox generation、活跃 goal 数、待应答）**不写系统提示词**，需要时由模型调用工具或 `/status` 查看。
- DSH 自带的 runtime context（checkout/GUI 等 dev-context）不在生产部署中挂载；具体以 bundle 行为准。

### 变量

- 可用 DSH 内置变量（如 `{{model}}`、`{{cwd}}`）；自定义变量如无必要不引入，保持提示词稳定。

## 9.4 AGENTS.md 分层

采用 DSH `dsh-agent-instructions`：

- **全局**：`$DSH_HOME/AGENTS.md`。放身份/偏好/安全约定/命令习惯；保持几 KB。
- **项目级**：从项目根（`.git` marker）到会话 cwd 的 `AGENTS.md` 链；本项目的会话 cwd 是持久 workspace，因此工作区根 `AGENTS.md` 生效。
- 首次启动由 app seed 两处模板（D114）；存在则不覆盖。
- 预算 65536 字节（DSH base 默认）；超预算会省略较宽泛的文件并通知。
- AGENTS.md 是"持久操作指令"，不写易变事实（进 memory）、不写秘密。
- 模板内容（草案）：
  - 全局：身份一句话、语言/风格、命令约定、安全/审批约定、memory 使用规则、不要在文件里存密钥。
  - 工作区：host 使用规则、sandbox 与 workspace 的文件搬运、产物提交、目录约定、禁止事项。
- 修改 AGENTS.md 后是否生效：DSH 会在成功 fs 操作/恢复时对账；重启也可。无需额外机制。

## 9.5 Memory

### 定位

- AGENTS.md：稳定操作指令（始终注入）。
- memory：**持久事实/偏好/决定**（M16 起主会话自动注入 pinned 快照；完整内容仍按需检索，不全量注入，见本节末“自动注入”）。
- 会话日志：原始历史（DSH 管理）。
- goal：任务状态（DSH 管理）。

### 存储（D67/D113）

全局单库（不分项目作用域）：

```
$DSH_HOME/memory/
├─ entries/
│  ├─ mem-20261025-013000-a1b2.md
│  └─ mem-20261024-221500-c3d4.md
└─ archive/                         # forget/supersedes 后移入
```

M5 不实现 `index.json`/向量检索；每次 search 扫描 `entries/*.md`。损坏条目会被跳过并在 `/status full` 的 invalid 计数中体现。

单条 entry 文件（Markdown + YAML frontmatter）：

```markdown
---
id: mem-20261025-001
title: 用户偏好：NixOS 部署使用 agenix
tags: [type:preference, project:nokoribi-agent, topic:nix]
source: session:<sessionId>#turn-12
created: 2026-10-25T01:30:00+08:00
updated: 2026-10-25T01:30:00+08:00
confidence: high
status: active            # active | archived
supersedes: null
---

用户希望所有 NixOS 密钥通过 agenix 管理，不使用明文 EnvironmentFile。
```

- `id`：稳定 id（时间戳 + 序号或内容哈希前缀）。
- `tags`：命名空间约定 `type:*`（preference/fact/decision/person/project）、`project:*`、`topic:*`。
- `source`：来自哪个会话/轮次；便于追溯。
- `supersedes`：取代旧条目时引用。
- `status`：forget 时改为 archived 并移动到 `archive/`（软删除）。

### 工具（D66）

单工具 `memory`，action：

| action | 参数 | 行为 |
|---|---|---|
| `search` | `query?`, `tags?`, `limit?` | 关键词 + tags 检索，返回 id/title/tags/片段/更新时间；默认 limit 10 |
| `read` | `id` | 返回完整条目 |
| `write` | `id?`, `title`, `tags`, `body`, `source?`, `confidence?`, `supersedes?` | 按 id upsert；无 id 时创建；冲突/重复由调用方负责（提炼子代理去重） |
| `forget` | `id` | 移到 archive，status=archived，不硬删 |

- 搜索实现：扫描 `entries/*.md`（v1 数据量小）；关键词匹配 title/body/tags，按更新时间与匹配度排序；不做向量检索。
- 写入也有 AbortSignal/超时；Auto review 会审查 write/forget。
- 不提供列表全量注入；需要时模型调用 search。

### 写入触发（D61）

1. 用户明确说"记住/以后都这样/这是长期偏好"。
2. 模型判断值得长期保留的事实/决定（按 9.5.4 标准）。
3. 里程碑/任务结束：由一次性提炼子代理（D68）执行；不在每轮运行。

### 写入标准

**应该写**：

- 用户的长期偏好、个人事实、称呼/语言习惯。
- 项目级稳定事实（路径、部署约定、长期架构决定）——用 `project:*` tag。
- 重要决定及理由、被纠正的错误认知。
- 可复用的操作经验（但操作性内容优先放 skills/AGENTS.md）。

**不要写**：

- 临时任务状态（用 goal/session）。
- 大段日志、工具输出、完整对话转录。
- 秘密/凭据/API key/个人敏感信息（明确禁止）。
- 可从仓库/文件直接读到的内容（除非是索引性事实）。
- 与已有条目重复的内容（应 supersede/更新）。

### 提炼子代理

- 触发：goal 完成/阻塞、明显的大任务完成、`/clear` 前（可选）、用户明确要求。
- 输入：任务目标、结果摘要、关键决定、新事实（不是完整 transcript；必要时附少量引用）。
- 模型：secondary/低成本档。
- 流程：先 search 已有条目 → 决定新增/更新/supersede → 用 memory 工具写入 → 返回写入 id 列表。
- 不在每轮运行，避免 token 成本与噪声；主 agent 也可以直接写简单条目。
- 失败不阻塞主流程；记录日志。

### M5 实现记录（2026-10-25）

- 新增 `packages/memory`：`MemoryService` 服务名 `memory`；`entries/` + `archive/`；frontmatter 使用 JSON 引号标量 + JSON flow array，保证可解析。自动 id `mem-YYYYMMDD-HHMMSS-<hex>`；写链串行、原子写、0600/0700；body ≤64KiB、title ≤200B、1–20 个 `namespace:value` tags。
- 搜索：title 5/tags 3/body 1 的 OR token 评分，AND tag 过滤，updated desc tie，default 10 / max 50；不建 index、不做向量检索。损坏文件跳过并计入 invalid。
- `write` 支持 upsert 与 `supersedes`；归档条目不允许复活；`read` 只读 active；`forget` 软归档。常见密钥模式在写入前拒绝。
- 提炼子代理（D140）：goal `complete`/`blocked` 时由宿主触发，按 goal+phase 去重；`memory-*` child 使用 `delivery:"caller"`，输入 objective/rounds/last report，最多写 3 条；超时/失败只记日志，不通知用户。
- **自动注入后移（D143）**：M5 不把 memory entries 注入 system prompt，也不在会话启动/每轮 pre-step 自动检索。`/clear` 后的新会话没有记忆预热，必须由模型调用 `memory search`。后续版本再评估。**M16 已确认改为自动注入**：见本节末“自动注入（M16 设计）”，D172–D174。
- `/status full` 提供 active/archived/invalid/bytes 计数；`memory` 工具和 curator 的 write/forget 仍经过 Auto review。

### 自动注入（M16 设计，2026-10-29 已确认；待实现）

> 决策 D172–D174。目标：主会话自动带上长期记忆，同时保持静态提示词稳定、token 可控，并避免每轮自动检索。

**通道**：用 DSH `ctx.systemPrompt.context()` 注册 runtime context（name `nokoribi:memory`）。运行时上下文由 agent loop 物化为 durable user-role 快照，文本与已保留快照不同才追加；压缩移除后下一步自动恢复；不修改 system prompt section，不进入 KV-cache 前缀。

**刷新**：每轮刷新一次。memory 插件在 `agent/pre-step` 检测到 turn 变化时重算并冻结本轮快照，context provider 同步返回冻结文本；同一轮内最多追加一次。每个 step 前对 `entries/` 做 `stat` freshness 检查（覆盖外部编辑），`memory write/pin/unpin/forget` 后失效缓存；启动时先渲染一次缓存。

**内容**：`pinned: true` 条目 + 自动纳入 `type:person`/`type:preference`（`confidence: low` 的自动条目跳过；显式 pinned 始终保留）；分「用户画像 / 长期记忆」两组；条目渲染为 `title：body 单行（≤300 字符）`，不展开 id。预算默认 `maxChars=3000`、`maxEntries=20`；超预算截断并追加“另有 N 条未注入，可用 memory search”。快照头部声明：历史记忆是数据不是本轮指令、精确/最新信息以工具检索为准、本快照取代旧快照。

**工具/提示词**：frontmatter 增加 `pinned`（默认 false，旧文件兼容）；`memory write` 增加 `pinned`；新增 `pin`/`unpin` action；search/read 标记 pinned；stats 增加 pinned。`nokoribi:memory` 与 tool description 说明自动快照、pin 准则（稳定偏好/身份/长期决定，控制数量）、不要与 AGENTS.md 重复；提炼子代理对用户级偏好/身份写 pinned。

**配置**：Nix `memory.inject.{enable,maxChars,maxEntries,mainOnly,autoTags}`，默认 `true` / 3000 / 20 / `true` / `["type:person","type:preference"]`；bundle env `NOKORIBI_MEMORY_INJECT_*` 提供开发默认值；overlay 接到 `nokoribi-memory` 行。`enable=false` 时不注册 context（从开启状态关闭时 loop 会清理旧快照）。

**观测**：`/status full` memory 行在 active/archived/invalid/bytes 之外增加 pinned、snapshotChars、inject 状态；超预算/刷新失败写 warn，不影响主流程。

**安全**：记忆内容来自模型写入，进入上下文等价于持久化提示注入面；缓解：写入仍过 Auto review + secret guard、快照固定“数据非指令”声明、pinned 预算上限、可配置关闭；残余风险登记 [15](15-verification-and-risks.md)。

**范围外**：不做每轮自动检索/向量召回（D143 的主动检索保留）、不做 embedding/外部 memory provider（可选 OpenViking 后端由 M17/D175 另行定义）、不做多用户作用域、本阶段不改提炼触发（`/clear` 前提取等后续再评估）。

**验收**：单元（frontmatter pinned 兼容、渲染排序/预算/footer/低置信过滤、缓存失效）；进程测试（fake LLM 捕获请求：写入 pinned 后下轮出现快照、goal child 无快照、关闭配置无快照、超预算 footer、重启恢复不重复追加）；Nix module-eval 断言；`pnpm check`/`test*`/`nix flake check`/`nix build`。

### 记忆后端切换（M17 规划，2026-10-29 确认）

> 决策 D175；里程碑见 [14.15](14-roadmap.md)。本节只定义后端口径，M16 仍实现本地后端。

- **默认本地**：本节的 entries + pinned 快照自动注入；无外部依赖。
- **可选 OpenViking**：启用后由 OpenViking 接管（profile/recall/capture/commit），**停用本地 `nokoribi-memory` 组件**（存储/工具/快照）；两者互斥，不做双写/双读。
- **边界**：openviking-server **不打包**；仓库只保留连接配置（endpoint、凭据 env/agenix、可选 peer/recall 参数）；server 由用户外部部署（uv/Docker/云），需自带 embedding + VLM provider。
- **接入**：`@openviking/dsh-memory-plugin`（Apache-2.0，pin 版本）作为 profile bundle；前置为 M12 Skill（`dsh-skill`/`dsh-skill-filesystem`）与 M13 MCP 客户端（`dsh-mcp-client`）；插件已验证兼容 DSH `0.2.1-rc.3`。
- **配置（已确认）**：`memory.openviking.enable`（默认 `false`）；其他跟 OpenViking 连接相关的配置全部放在 `memory.openviking.*`（`endpoint`、`apiKeyEnv` 指向 EnvironmentFile/agenix 变量且不写入 store、可选 `peerId`/`workspacePeer`/`recallMaxTokens` 等）。
- **门禁**：module-eval（本地行 disabled、`memory.openviking.*` 连接 env）；无 server 启动不崩；fake server recall/capture；真实 server spike。

### 隐私

- 全局单库意味着跨项目可见（用户选择 D67）；用 `project:*` tag 标记来源，写敏感项目事实需谨慎。
- 没有加密；磁盘权限由服务用户控制；root 可读。

## 9.6 Goal 汇报格式

M4 子代理通过 `send_message` 汇报（rc.3 无独立 report 包；主 agent 收到后转述）：

```text
[goal:<sessionId 前缀>] progress | blocked | done
objective: ...
done: ...
evidence: ...
next: ...
blockers / questions: ...
```

- 只在里程碑、阻塞、完成时 report；不要每轮刷屏。
- 主 agent 把 report 转成简短 IM 摘要（不复述全文），并在 done 时提示用户可执行 `/goal archive <前缀>`。
- 阻塞时主 agent 应给出原因与可选下一步；系统通知也会发 ⚠️（可能重复，稀有情况接受）。
- 完成时主 agent 需要通过 `ask_user_question` 询问是否归档；用户确认后提示命令（不自动归档）。

## 9.7 IM 输出风格（提示词约束）

- 每轮一条最终回复；不发送工具过程；不假装流式。
- 简洁、直接；中文为主（用户偏好以 SOUL.md 为准）。
- 长内容按段落/代码块组织；不依赖平台不支持的 markdown。
- 需要审批/提问时按 bridge 的格式回复（🔐/❓）；不要自行编造审批结果。
- 不把内部系统通知当成用户消息回复；收到 goal report 时按汇报格式处理。
