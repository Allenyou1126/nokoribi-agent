# 08 Auto-review 与安全模型

## 8.1 为什么用 Auto review

最终安全模型（用户确认）：

- 专用系统用户 `nokoribi`，`NOPASSWD: ALL` sudo；
- systemd 不做文件系统硬化；
- 所有工具调用默认经过 LLM reviewer（M10 规划的唯一例外是 `web_search`/`web_fetch`，见 8.9/D170）；
- 只有 reviewer 拒绝/不确定时才向 IM 用户请求单次授权；
- 不做高危命令硬确认、不做备份、不做自动回滚、只保留日志。

这套设计的**唯一有效安全边界是"模型 + reviewer 的可靠性"**；sudo 全开之后没有第二道硬边界。以下记录机制、补丁与已接受的残余风险。

## 8.2 Auto 预设的实际机制（上游 0.2.1-rc.3）

`@deepseek-ai/dsh-experimental-auto-review`：

- 只在会话 permission preset == Auto（`permissionPresets.registerAuto()`）时生效。
- 在 `tools/pre-execute` 拦截**每次**原生工具调用（以及已开始的 PTC inner call），用当前 agent 的 provider/model 审一次。
- allow → 以 Full access（danger-full-access）执行；deny → 在 `ask` 审批策略下走 approval seam 询问用户；`never` 下拒绝终局。
- 固定 REVIEW_POLICY：low/medium allow、high deny；medium allow 需要"当前人类或直接父级明确授权动作、目标与范围"；不明确/冲突 → deny；严格 JSON 输出；非法输出 fail closed。
- **进程内 child 固定 `never`**：child 的 reviewer 拒绝是最终结果，不会问用户。
- 包内评审函数未导出；要改 reviewer 路由/child 行为必须 vendor 源码并维护补丁。
- 实验性：可能误放行/误拒绝；无持久 grant、无确定性豁免、无重试层。

## 8.3 本项目采用的接法（D31：A 全局 Auto）

三个候选：

- **A. 全局 Auto 预设**（选中）：主会话默认 Auto；所有工具调用过 reviewer；沙箱退役为执行位置/干净环境。
- B. 裁剪成 host gate：只对非沙箱 host 调用复用 auto-review 的策略。未采用（需要 fork 评审逻辑且覆盖面小）。
- C. 混合：默认 workspace-write，按需 `/permission auto`。未采用（与"默认 Auto"冲突）。

最终行为：

- 主会话创建后，程序化把 permission preset 设为 Auto；`/clear` 后的新会话同样。
- 配置了 `permission-presets` 与 `working-directory`、`agent-instructions` 等依赖。
- 我们的 shell router 需要报告 `sandboxMode`，满足 permission-presets 的挂载前置条件；Auto 预设会设置 danger-full-access 与 approval=ask。
- `/permission` 只建议用于查看当前预设；v1 没有 DSH 权限沙箱可回退，切走 Auto 会让调用不经审查且仍然 full access，**不支持**作为安全模式（提示词与文档中说明）。
- M2 已验证：IM-only bundle 能挂载 permission-presets，主会话创建/恢复后程序化设为 auto；agent 作用域 `/permission` 遮蔽上游命令，只报告、不允许切换。

## 8.4 Reviewer 双档设计（D64/D83/D85/D87）

不叫"主模型/便宜模型"，只给 reviewer 配置两个 tier：

```nix
services.nokoribi-agent.review = {
  fast   = { provider; model; reasoningEffort; };  # 日常工具审阅
  strong = { provider; model; reasoningEffort; };  # deny/不确定/sudo 复审
  timeoutMs = 30000;                                # 单次 reviewer 调用上限
};
```

- **fast**：所有工具调用先过 fast。
- **strong**：当 fast 返回 deny/不确定（或动作被识别为 sudo/root）时，交给 strong 复审。
- strong 也 denied → 走 IM 单次授权（approval ask）；用户批准则执行，拒绝/超时则失败。
- 该策略由 vendored 版 auto-review 实现（上游是按当前 agent 模型、无分档）。
- reviewer 模型必须能稳定输出严格 JSON；非法输出 = 调用失败（fail closed）。
- 两档模型是否与主 agent 相同由配置决定；主 agent 模型另有配置。

### sudo/root 动作识别（M2 实现）

- 依据工具名 + 参数（主要是 `bash` 的 command、host，以及写文件的 path/content）做启发式识别：shell 边界的 `sudo`/`doas`/`pkexec`/`su -`、`nixos-rebuild`、修改 systemd/sudoers/passwd/ssh 等、`chmod` setuid、`dd`/`mkfs`/分区、强制删除系统目录等。
- 所有调用先过 fast；识别为 sudo/root 时即使 fast allow 也继续 strong 复审。识别不是拒绝/放行；最终决定仍由 strong reviewer。
- 启发式可被绕开（脚本内间接提权），这是已接受的残余风险；真正的兜底是 strong reviewer 对动作整体效果的判断。实现中误报只增加一次 strong 调用。

### fail closed

- reviewer 技术失败（模型请求失败、输出不合法、超时）→ 工具调用失败、不执行。
- 没有"reviewer 不可用就放行"的降级路径。
- 如果用户要关闭审查，只能改配置/版本（v1 不支持运行时关闭）。

## 8.5 子代理审批桥接（D131，M2 实现）

上游 auto-review 对进程内 child 固定 `never`，child 被拒的动作不会问用户。M2 的 vendored 补丁：

1. child 的 reviewer deny 且当前策略为 `never` 时，先 `setApprovalPolicy(child.session, "ask")`，再让 tools pipeline 解析 `ask`；主会话仍保持上游终局 deny。
2. 该请求由 `channel-core` 的 interaction broker 统一处理（串行、带 goal 短 id、走 IM 文本）。
3. 用户批准 → 单次执行；拒绝/超时 → 失败，child 通过 report 告知主 agent。
4. 多个 child 同时请求时全局串行，避免文本歧义。
5. child 的 `subagent:delegation` 文案由 prompt 的 `system-prompt/assemble` 监听替换，避免继续声称“审批一律自动拒绝”。

验证结果：

- DSH rc.3 的 subagent 会为 child 种子 `permission/preset: auto` + `approval/policy: never`，因此 auto-review 对 child 仍生效；补丁点在 auto-review 的 deny 分支可行。
- 进程内集成测试（testkit + fake channel）覆盖 goal child → broker → IM 允许 → 工具执行；child policy 最终为 `ask`。
- 回退方案仍保留：若未来 DSH 改变 child 种子或补丁不可行，child 保持 `never`，失败后 report 给主 agent。

## 8.6 vendor 与维护

- `packages/reviewer/` 内保存上游 0.2.1-rc.3 的 vendor 文件（MIT LICENSE + 版本/来源标识/SHA）。
- 补丁点集中：
  1. reviewer 路由从"当前 agent 模型"改为配置的 fast/strong；
  2. 双阶段复审逻辑；
  3. sudo 启发式识别；
  4. child 审批桥接（若可行）；
  5. M10 规划：`exemptTools`（默认 `web_search`/`web_fetch`）在 `tools/pre-execute` hook 开头直接放行（D170）。
- 补丁尽量小；升级 DSH 时重新对照上游，记录 diff。
- 若上游未来支持这些能力，可退回直接依赖上游包。

## 8.7 安全边界分工

| 边界 | 机制 | 保护什么 | 不保护什么 |
|---|---|---|---|
| 宿主/服务隔离 | 专用用户 + systemd | 与用户个人账户分离；服务崩溃不影响系统 | 无法阻止 `sudo`（用户显式开启）；不是安全沙箱 |
| sandbox host | Nix 环境 + 临时目录 + `no_new_privs` + PATH 去 sudo | 干净/可重置环境；阻止 sandbox 内提权；减少误操作污染 | 不隔离文件读（同用户可访问宿主可读路径）；不是安全边界 |
| local host | 真实主机 + NOPASSWD sudo | 完整主机操作能力 | 没有任何隔离；一切靠 reviewer |
| Auto review | fast→strong reviewer | 拦截高风险动作、要求单次授权 | 误判、prompt injection、reviewer 技术失败（后者 fail closed）；Web 工具按 D170 豁免 |
| 持久终端（M10 规划） | `terminal_send` 等工具调用逐次过 reviewer；owner 隔离；sandbox 内 no_new_privs | 交互式工作有地方可跑、状态可保留 | reviewer 只看到输入文本/工具参数，难以跟踪交互式前台状态；终端输出可能含敏感内容 |
| IM 渠道 | 单用户白名单/allowlist + 测试 token | 只接受授权用户消息 | 真实 IM 适配器未实现；token 明文在 store；无多用户模型 |
| 审计 | journald + 会话 JSONL + sudo 日志 | 事后追溯 | 不能预防；无自动回滚；无备份 |

## 8.8 威胁与残余风险

| 威胁 | 当前控制 | 残余风险 |
|---|---|---|
| 外部内容（网页/工具结果/文件）注入模型 | reviewer 把历史/工具结果视为 fact；系统提示词约束；web 工具结果带“外部不可信内容”标记 | reviewer 是实验性 LLM，可能被绕过；root 下后果是整机级；Web 工具自身豁免审查（D170）放大注入面 |
| reviewer 误放行危险动作 | fast→strong；fail closed | 无自动回滚、无备份；可能误放行 |
| Web 工具豁免审查（M10 规划） | fetch provider 自带公网地址/SSRF/同源重定向/大小上限；只读、不执行本地命令；默认只挂可信 provider | 无 LLM 审查；恶意页面内容仍可注入模型上下文；DeepSeek 搜索请求会携带查询/触发问题 |
| sandbox 提权 | no_new_privs + PATH 去 sudo | sandbox 仍可读宿主可读文件；不是安全隔离 |
| local host 滥用 | NOPASSWD ALL + reviewer | 一旦获准，可改 sudoers/systemd/自身 unit，持久化控制 |
| IM 身份伪造 | v1 只有 loopback + token；未来 adapter 白名单 | token 明文在 Nix store；测试通道仅验收期建议开启 |
| 密钥/秘密泄露 | API key 走 EnvironmentFile；子进程凭据 scrub | root 能力下可读本机秘密；日志/会话可能包含敏感内容 |
| 供应链 | 锁版本、vendor reviewer、Nix 固定哈希 | DSH rc 阶段变动；补丁需持续 diff |
| 持久数据 | 会话/记忆/日志在 `/var/lib` | 主机 root 可读；无备份；升级回滚可能不兼容 format |
| 可用性 | 单实例锁、systemd restart、watchdog | root agent 可停服务、改配置；日志是唯一审计 |

## 8.9 Web 工具审查豁免（M10 规划，D170）

> 状态：**规划已确认（2026-10-27），代码未实现**；完整规格见 [19](19-persistent-terminal-and-web.md)。

- 用户确认：`web_search`/`web_fetch` **豁免 Auto review**；其余工具（`bash`、文件、`terminal_*` 等）保持逐次审查。
- 实现：vendored auto-review 的 `tools/pre-execute` hook 开头按 `exemptTools`（reviewer 配置，默认 `["web_search","web_fetch"]`）直接 `next()`，不调用 fast/strong；仅 Auto preset 下进入该 hook 的行为不变。
- 理由：Web 工具只读外部内容、不执行本地命令；`dsh-web-fetch-http` 自带公网地址解析、SSRF 防护、同源重定向、字节/字符上限；搜索/抓取调用频繁，逐次 reviewer 会显著增加延迟与成本。
- 补偿控制：fetch provider 的安全限制；结果在模型上下文中带“外部不可信内容”提示；可配置豁免列表（部署方可收紧为只豁免搜索或完全关闭）。
- 残余风险：外部页面内容注入、绕过 LLM 审查；登记在 8.8 与 [15](15-verification-and-risks.md)。该豁免**不**扩展到 `bash`、文件写入或终端工具。

## 8.10 已明确接受的风险

- 无高危命令硬确认（D103）。
- 无备份（D105）。
- 无自动回滚（D84）。
- sudo `NOPASSWD: ALL`（D81）。
- systemd 不做文件系统硬化（为 sudo/local）。
- 测试 token 明文 Nix option（D119）。
- 真实 IM 适配器延后，v1 只有本地测试通道。
- 不做 NixOS VM 安全测试。
- 不做 web-debug，归档只能通过 session 文件查看。
- Web 工具豁免 Auto review（M10 规划，D170）；无 LLM 审查兜底，依赖 provider 自身限制与提示词。

## 8.11 审计与可观测

- sudo 命令与结果进 journald（`log_output` 不开启，避免敏感输出进日志；D104）。
- 会话 JSONL 保存所有模型可见的 user/assistant/tool 事实（DSH 原生）。
- 桥接日志记录：消息 id、命令、注入模式、审批决策、outbox 重试、恢复事件。
- 不做集中式日志/OTel/告警；journald 保留由系统配置决定。

## 8.12 安全相关配置（详见 12）

- `sudo.enable`：默认 false；开启写 `NOPASSWD: ALL`。
- `review.fast` / `review.strong`：reviewer 两档模型。
- `review.timeoutMs`：单次 reviewer 调用超时（默认 30s）。
- `review.exemptTools`（M10 规划）：Auto review 豁免的工具名列表，默认 `["web_search","web_fetch"]`；设为空数组即恢复全量审查。
- `approval.approvalTimeoutSeconds` / `questionTimeoutSeconds`。
- `hosts.sandbox.enable`、`hosts.local.enable`、`hosts.default`。
- `channel.localTest.enable` / token；`channel.qqBot.approvalButtons`（M9 已实现，默认 true）。
- `terminal.*`（M10 规划）：持久终端开关、bash 路径、结果上限与超时；`web.*`：Web 工具开关与 provider 选择。
- `log.level`。
- 没有任何运行时安全降级/关闭开关（除上述按部署配置的豁免列表）。
