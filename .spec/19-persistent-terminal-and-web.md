# 19 持久终端与 Web（M10）

> 状态：**规划已确认（2026-10-27），代码未实现**。本文是 M10 的实施规格：host-aware 持久终端（`terminal_*`）与 Web Search/Fetch。排期见 D165，终端/Web/豁免/依赖决策见 D168–D171（[03](03-decision-log.md)）；M9（QQ 按钮审批）不在本文范围。标“已核实”的是对照 rc.3 包元数据/源码确认的事实；标“设计选择”的是本规格取舍；标 🧪 的项施工时须对照上游实际签名/默认值复核并回写。

## 19.1 需求与范围

1. **持久交互终端**：模型需要跨工具调用保留 shell 状态的交互能力（REPL、长会话调试、需 cd/env 持续生效的场景），而不是每次 `bash(host)` 都新起进程（[07.3](07-shell-hosts-and-sandbox.md)）。
2. **host-aware**：终端必须可选 `local:workspace` 或 `sandbox:default`，与 `bash(host)` 的 host 语义一致（D168）；不做主机级单例终端。
3. **Web 能力**：模型可 `web_search`/`web_fetch`；默认启用、不新增密钥（复用 `DEEPSEEK_API_KEY`，D169）。
4. **不放大审批噪声**：只读外部内容不逐次进 LLM reviewer（D170）；终端与其余工具保持逐次审查。
5. **进程内持久**：终端状态在 daemon 生命周期内保留，重启即丢失（D168）。

交付：DSH `ctx.terminals` + 6 个 `terminal_*` 工具；每个 host 一个 `BashTerminalBackend`；host 协议 `terminalLaunch`；local/sandbox 两种 launch；sandbox terminal pin 与生命周期；Web 显式行 + 双 provider pin；reviewer `exemptTools`；清理顺序；`nokoribi:pty` 提示词；`terminal.*`/`web.*`/`review.exemptTools` 配置；单元/PTY/进程测试与门禁。

**非目标**：跨 daemon 重启的终端持久（不引 tmux/screen/dtach，不做 attach/detach）；默认 vendoring `dsh-terminal-bash`（优先注入 `spawnTerminal`，失败才回退，19.8）；DSH 权限沙箱（`dsh-sandbox-policy` 只作解析前置，`mode=danger-full-access`，D31/D34/[07.11](07-shell-hosts-and-sandbox.md)）；SSH host 终端（D149→D165 顺延）；终端 UI/Web 前端/浏览器渲染/登录态抓取；不改变 `bash(host)` “每次新进程”语义。

**完成定义**：`pnpm check`/`pnpm test`/`pnpm test:process`/`nix flake check` 通过；19.5 自动化场景与 19.6 可执行门禁通过，其余门禁（真实 API/sandbox/NixOS PTY）记录在 `.spec/notes/m10-fact-gate.md`。

## 19.2 现状与差距

### 19.2.1 现状（已核实）

| 现状 | 事实 |
|---|---|
| shell 执行 | `bash(host)` 每次新进程；`ShellHostProvider` 只有 `run/start/reset/status/disposeSession`，无持久会话概念（`packages/shell-bash/src/hosts.ts`、[07.12](07-shell-hosts-and-sandbox.md)） |
| sandbox 实例 | `Instance{meta,dir,active,background,handles}`；TTL sweep 跳过 `active>0`；`reset` 有活跃命令时拒绝；`disposeSession` 杀 handle 后删目录（`packages/shell-host-sandbox/src/host.ts`） |
| `/clear` | `clearSession()` 在 `old.dispose()` 后调 `ctx.shellHosts.disposeSession(previousId)`（`packages/agent-app/src/daemon.ts`） |
| goal 归档 | `GoalsManager.disposeSandbox()` 调 `disposeSession`，失败只 warn（`packages/agent-app/src/goals/manager.ts`） |
| 终端 | 组合未挂载 `dsh-terminal`/`dsh-tool-terminal`；仓库无 `ctx.terminals` 使用 |
| Web | 未挂载任何 `dsh-web-*`/`dsh-tool-web` 行（[04.4](04-architecture-and-build.md) 仅列为可选） |
| Reviewer | vendored auto-review 对 Auto preset 下每个工具调用都审查；`Config` 只有 `fast/strong/timeoutMs`（`packages/reviewer/src/config.ts`），无豁免 |
| patch 语义 | 同 id 行做**字段替换**（`target[key]=value`），支持 `disabled: true` 让行不加载（`@deepseek-ai/dsh-app-boot` 的 `applyEntryPatches`）→ Nix overlay 可按行 id 停用终端/Web 行 |

### 19.2.2 上游事实（已核实）

**终端族**：

| 包 | 事实 |
|---|---|
| `@deepseek-ai/dsh-terminal` | `ctx.terminals` 服务：`registerBackend/listBackends/spawn/startSend/read/signal/kill/list`；owner-scoped；owner 释放时 `owner.ctx.effect` 自动清理；与 `ctx.agents` 做 live-owner 校验 |
| `@deepseek-ai/dsh-tool-terminal` | 6 工具 `terminal_open/send/read/signal/close/list`；`inject ["terminals","tools","systemPrompt","workingDirectory"]`；后台 send 复用 `ctx.jobs`；config `enableRunInBackground`/`maxResultBytes` |
| `@deepseek-ai/dsh-terminal-bash` | **公开导出 `BashTerminalBackend`**：`ctor(ctx, ResolvedConfig, spawnTerminal?, createSession?)`；`Config` 是 schemastery，可 `Config({})` 取默认；默认 shellArgs `["--noprofile","--norc","-i"]`；`spawn()` 先 sandbox 模式围栏 + `ctx.sandboxPolicy.resolve()` + `spawnArgv`，再调注入的 `spawnTerminal`，用 `LocalPtySession` 做就绪/scrollback/信号/清理；`inject ["terminals","sandboxPolicy","sessionProjections","subprocess"]` |
| `@deepseek-ai/dsh-tool-bash-persistent` | **不可用**：工具名固定 `bash`，与现有 `bash(host)` 冲突 |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 不直接插 group：需要显式行 id 让 Nix overlay 覆盖并控制 `sandboxPolicy`/`subprocess` 顺序 |

**前置与 PTY 原语**：`@deepseek-ai/dsh-sandbox-policy` 提供 `ctx.sandboxPolicy`（static `inject ["sessionProjections"]`；config `mode` 默认 `read-only`、`workspaceRoot`；`resolve() -> {mode, workspaceRoot(,sessionId)}`）。本项目固定 `mode="danger-full-access"`：非 danger 模式 `spawnArgv` 需要 `ctx.sandbox` provider，而本仓库不采用 DSH 权限沙箱；注入 `spawnTerminal` 后上游 argv 会被替换，但 backend 仍会计算/校验 argv，故前置不可省。挂载它会附带一个 `sandbox:policy` runtime context 段（缓存安全，文案为“file sandbox 不限制修改”，与 [08](08-autoreview-and-security.md) 边界一致）。

PTY 原语：`ctx.subprocess.spawnTerminal(spec: {argv,cwd,env?,rows,cols,terminalType,graceMs,signal?,shellActivity?}) -> SubprocessTerminalHandle`（`pid/output/done/write/resize/inspectForeground/inspectActivity/signalForeground/terminate`）；`dsh-subprocess-local` 已在组合中。🧪 精确字段以 rc.3 类型为准。

**Web 族**：

| 包 | provider id / 事实 |
|---|---|
| `@deepseek-ai/dsh-web` | `ctx.web`；config `searchProvider`/`fetchProvider`；未 pin 且多 provider 可用时报 `AMBIGUOUS` |
| `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official`；Messages API；**一次搜索=一次模型轮次**；env `DEEPSEEK_SEARCH_BASE_URL` |
| `@deepseek-ai/dsh-web-fetch-http` | `http`；匿名公网 fetch；SSRF/公网地址/同源重定向/字节字符上限；模块依赖 `dsh-timeout`、`dsh-http-proxy` |
| `@deepseek-ai/dsh-web-deepseek-api` | `deepseek-search-api`/`deepseek-fetch-api`；直连 API，**不耗辅助模型轮次** |
| `@deepseek-ai/dsh-tool-web` | `web_search`/`web_fetch`；config `search/fetch/searchMaxResults/searchMaxQueries/fetchTimeoutMs/searchTimeoutMs/fetchMaxOutputChars`；`inject ["tools","web","systemPrompt"]`；结果带“外部不可信内容”提示 |

模块级库依赖（模块导入，非独立行）：`dsh-credentials`、`dsh-launch-environment`、`dsh-timeout`、`dsh-http-proxy`，另有上游传递依赖（D171 另登记 `dsh-output-retention`）；精确集合以 P10a 的 pnpm 解析/实际 import 为准。

### 19.2.3 差距

| 差距 | 目标 | 归属 |
|---|---|---|
| 无持久 shell | `ctx.terminals` + 6 工具 + 每 host backend | 19.3 |
| 无 host 选路 | `type`=host id；discovery 增 `terminal` 能力位 | 19.3.4 |
| sandbox 只统计命令 | 增加 terminal pin，与 TTL/reset/dispose 互锁 | 19.3.6 |
| 清理顺序 | 先杀终端再 `disposeSession`；shutdown 也显式清 | 19.3.7 |
| 无 Web | 双 provider + 工具 + pin | 19.4.1–19.4.2 |
| reviewer 无豁免 | `exemptTools` + vendor patch + 配置 | 19.4.3 |

## 19.3 终端设计

### 19.3.1 架构与数据流

```
模型 ─terminal_open({type:"sandbox:default"})─► ctx.terminals（owner=当前 agent）
                                    │ spawn；@nokoribi/terminal-host 注入 spawnTerminal
                                    ▼
            ctx.shellHosts.terminalLaunch(hostId,{sessionId?,cwd?,signal?})
        ┌───────────────────────────────┴─────────────────────────────┐
   local:workspace                                              sandbox:default
   argv=[bash,…] cwd=workspace                     pin++ / ensure 实例
   env PATH=extraPackages+ambient                  argv=setpriv / nix shell…
        └───────────────────────────────┬─────────────────────────────┘
                       │ ShellTerminalLaunch{argv,cwd,env,release}
          ctx.subprocess.spawnTerminal(...) ─► 真 PTY；包装 handle 在 done/terminate 时 release()
```

组件职责：`ctx.terminals`（终端生命周期/owner scope/读写/信号/后台 send 与 jobs）；新包 `@nokoribi/terminal-host`（per-host backend、`spawnTerminal` 注入、host 变更注册、`nokoribi:pty` 段）；`ShellHostRegistry`（`terminalLaunch`/能力位/`onChange`）；host provider（`terminal()` -> launch，sandbox 维护 pin）；`BashTerminalBackend`（就绪/scrollback/信号/清理，保留在依赖里）。

### 19.3.2 Backend 注册（设计选择）

- 新包 `packages/terminal-host`（plugin name `terminal-host`），`inject ["terminals","shellHosts","subprocess","sandboxPolicy","sessionProjections","workingDirectory","systemPrompt"]`；`enabled=false` 时不注册任何 backend。
- 对当前已注册的每个 host 建一个 `BashTerminalBackend`，`ResolvedConfig.type = host.id`（如 `local:workspace`、`sandbox:default`），再 `ctx.terminals.registerBackend(backend)`；模型用 `terminal_open({type:"<host id>"})` 选 host（🧪 字段名以 rc.3 为准）。
- `ResolvedConfig` 由 `Config({})` 默认 + 覆盖构造：`backendType=host.id`；`shellPath=terminal.bashPath`（默认 `"bash"`，仅满足上游校验的非空占位，真实 argv 由注入替换）；`shellArgs=["--noprofile","--norc","-i"]`；`rows/cols/scrollbackLines` 来自 `terminal.*`（字段名已核实；默认值对齐上游）。
- **动态注册/释放**：`ShellHostRegistry` 是本仓库自有代码，增加 `onChange(listener)`；新 host 注册则建 backend，host 注销则先关闭该 type 下终端再注销 backend；插件卸载由 `ctx.effect` 统一注销。
- bundle 行顺序：`dsh-sandbox-policy` → `nokoribi-shell-host-*` → `nokoribi-terminal-host` → `nokoribi-tool-terminal`；动态监听保证顺序变化不丢 host。

### 19.3.3 `spawnTerminal` 注入与 handle 包装（设计选择）

注入闭包捕获 `hostId`；每次调用：① 从上游 spec/owner 取 `sessionId`（`ctx.terminals` 已校验 live-owner；local 可无 session，sandbox 必须有，🧪 精确参数位置）；② `terminalLaunch(hostId, {sessionId, cwd, signal})`；③ `ctx.subprocess.spawnTerminal({...上游 spec, argv/cwd/env 用 launch 的值})`，尺寸/`terminalType`/`graceMs`/`signal`/`shellActivity` 透传，`env` 合并 `TERM`/`COLORTERM` 等；④ 返回包装 handle：透传全部字段，`done` 结算或 `terminate()` 后调用 `launch.release()`（幂等、只一次），`spawnTerminal` 抛错立即 release；⑤ release 失败只 warn，不阻塞结算。

约束：不复制 `LocalPtySession`/就绪逻辑；argv 用数组，不拼 shell 字符串；上游 `spawnArgv` 仍会被调用（我们只覆盖结果），故 `sandboxPolicy.mode=danger-full-access` 是硬前置。

### 19.3.4 host 协议扩展（`@nokoribi/shell-bash`）

```ts
export interface ShellTerminalLaunchRequest {
  readonly sessionId?: string;   // sandbox 必填；local 可省略
  readonly cwd?: string;         // 上游传入的目录请求（通常来自 workingDirectory）
  readonly signal?: AbortSignal;
}
export interface ShellTerminalLaunch {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly release?: () => void | Promise<void>;   // 退订 pin/租约，幂等
}
// ShellHostCapabilities 增 terminal: boolean（与 provider.terminal 存在性一致，registry 校验）
// ShellHostProvider 增 terminal?(request): Promise<ShellTerminalLaunch>
// ShellHostRegistry 增 terminalLaunch(hostId, request) 与 onChange(listener)
```

`get_available_shell_host` 输出增加 `terminal: true|false`（`packages/shell-bash/src/tool.ts`），`nokoribi:hosts` 段说明该标记；`terminalLaunch` 对未知 host / 未实现 `terminal()` 的 host 返回明确错误（列出可用 host）。

### 19.3.5 `local:workspace` 的 launch

| 项 | 值 |
|---|---|
| argv | `[bashPath ?? "bash", "--noprofile", "--norc", "-i"]` |
| cwd | `request.cwd`：相对路径相对 workspace，绝对路径按主机；省略时 workspace |
| env | `PATH = extraPackages(:) + ambient PATH`（同 local bash）；其余 env 由上游/PTY 提供 |
| release | 无 pin，可省略 |
| 安全 | 真实主机、可 sudo；每个 `terminal_send` 仍是工具调用、仍过 Auto review |

### 19.3.6 `sandbox:default` 的 launch

- **复用实例创建**：`SandboxHost` 增 `terminalLaunch(sessionId, request)`，内部走既有 `withLock` + `ensureLocked`（复用目录/gen/包状态），不新造沙箱。
- **pin 计数**：`Instance` 增 `pins`；launch 成功启动前 `pins += 1`，`release` 幂等减 1；`spawnTerminal` 失败立即减回。
- **argv**：无临时包 `[setpriv,"--no-new-privs","--",hostBash,"--noprofile","--norc","-i"]`；有临时包 `[nix,"shell", <baseEnvironment>, ...packages,"--command",setpriv,"--no-new-privs","--",hostBash,"--noprofile","--norc","-i"]`。`hostBash`/`setpriv`/`nix`/`baseEnvironment` 由 sandbox 现有解析逻辑提供，不读 `terminal.bashPath`。
- **env**：`PATH = guardDir:base/bin`（不拼 ambient PATH）；照旧注入 `DSH_SANDBOX_DIR`/`DSH_WORKSPACE_DIR`；`TERM/COLORTERM` 透传。
- **cwd**：固定 sandbox 实例目录。上游传入的 cwd（通常映射到 workspace）**默认忽略**：非空且不等于 sandbox 目录时，在 `terminal_open` 可见结果/提示词中说明“sandbox terminal 固定在 `$DSH_SANDBOX_DIR`，workspace 文件用 cp/rsync”；不做 cwd 映射。

| 事件 | 规则 |
|---|---|
| TTL sweep | `active>0` **或** `pins>0` 时跳过回收，下轮再查 |
| `sandbox reset` | `active>0` **或** `pins>0` 时拒绝，提示先关闭终端/命令 |
| `disposeSession` | `pins>0` 时**报错拒绝**（调用方必须先杀终端；正常路径见 19.3.7） |
| `sandbox_packages add/remove` | 允许；只影响之后新开的终端与命令，已打开 PTY 环境不变 |
| `status` | 增 `terminalSessions: pins`，`/status full` 展示 |

### 19.3.7 生命周期与清理顺序（设计选择，重要）

`ctx.terminals` 的 owner scope 在 agent 释放时自动清理，但 Cordis 插件 effect dispose 顺序**不可依赖**；sandbox 目录必须在 PTY 关闭后再删。因此显式“先杀终端、再 disposeSession”：

| 触发 | 顺序 |
|---|---|
| `/clear`（`clearSession`） | `abortInteractions` → `old.agent.cancel` → flush → `killTerminals(old.agent)` → `old.dispose()` → `shellHosts.disposeSession(previousId)`（现有 try/catch 保留） |
| goal 归档/清理（`GoalsManager`） | `killTerminalsForSession(sessionId)` → `disposeSession(sessionId)` → 归档；清理失败只 warn，不阻塞归档 |
| daemon shutdown | 现有 cancel/flush 之后、释放锁之前 `killTerminals(mainAgent)` 并等待 `done`（有界，如总 5s）；失败 log |
| host 注销 / 插件卸载 | 关闭该 host type 下所有终端 → 注销 backend |
| daemon 崩溃 | 进程退出即 PTY 消失，内存 pin 一并消失，无需恢复 |

落点：新文件 `packages/agent-app/src/terminal-cleanup.ts` 导出 `killTerminalsForAgent(ctx, agent)`/`killTerminalsForSession(ctx, sessionId)`（`ctx.terminals.list(...)` + `kill` + 有界等待 `done`，失败仅 log）；`daemon.ts` 与 `goals/manager.ts` 调用。`ctx.terminals` 未挂载时 no-op，不让清理路径依赖终端行存在。

### 19.3.8 提示词段 `nokoribi:pty`（设计选择）

- 由 `@nokoribi/terminal-host` 注册，`order=3100`（紧跟 `nokoribi:hosts` 3000，[09.3](09-prompt-and-memory.md)）；内容稳定、不含 per-turn 动态值（host 列表仍由 hosts 段渲染）。
- 要点：`terminal_*` 用于**需跨调用保留状态**的交互（REPL、长任务、需 cd/env 持续），有界一次性工作优先 `bash(host)`；`type` 是 host id（先 `get_available_shell_host`，只选 `terminal: true`）；local 终端真实主机可 sudo 但每次 send 仍过 review，sandbox 终端固定 sandbox 目录、不能 sudo、TTL/reset 受“有终端打开”保护；输出有界（`maxResultBytes`），大输出用文件；进程内持久，daemon 重启/`/clear`/归档会关闭全部终端；需要后台继续跑时用上游 `run_in_background`（走 `ctx.jobs`），不要反复 send 轮询。
- 与上游 `tool:pty` 段的关系：`dsh-tool-terminal` 若自注册引导段则**保留不覆盖**，我们只追加 host 路由/安全口径；若两段重复度高，P10a 记录并只保留上游段。`terminal.enable=false` 时输出“持久终端在本部署禁用”。

### 19.3.9 配置（设计选择）

| 字段 | 默认 | 说明 |
|---|---|---|
| `terminal.enable` | `true` | false 不注册 backend（Nix 部署用行 `disabled` 停用整组行） |
| `terminal.bashPath` | `"bash"` | local 终端 shell；sandbox 不用 |
| `terminal.maxResultBytes` | `262144` | 单次 read/send 结果上限（对齐上游 `dsh-tool-terminal` 默认 256 KiB） |
| `terminal.sendTimeoutSeconds` | `30` | 前台 send 等待上限（对齐上游 `timeoutMs` 默认 30000） |
| `terminal.rows`/`cols` | `40`/`160` | PTY 初始尺寸（对齐上游默认） |
| `terminal.scrollbackLines` | `10000` | scrollback 行数（对齐上游默认） |

环境变量（bundle 行 `!!js` 读取、dev 用）：`NOKORIBI_TERMINAL_ENABLED`、`NOKORIBI_TERMINAL_BASH_PATH`、`NOKORIBI_TERMINAL_MAX_RESULT_BYTES`、`NOKORIBI_TERMINAL_SEND_TIMEOUT_MS`、`NOKORIBI_TERMINAL_ROWS`、`NOKORIBI_TERMINAL_COLS`、`NOKORIBI_TERMINAL_SCROLLBACK_LINES`。

NixOS `services.nokoribi-agent.terminal`（P10e 回写 [12.4](12-nixos-deployment.md)）：`enable`、`bashPath`、`maxResultBytes`、`sendTimeoutSeconds`、`rows`、`cols`、`scrollbackLines`，默认同上；`enable=false` 时 overlay 用 `{ id = "nokoribi-terminal-host"; disabled = true; }` 等停用 `nokoribi-terminal-host`、`tool-terminal` 与（无其他消费方时）`sandbox-policy`。

### 19.3.10 错误与边界

| 情况 | 行为 |
|---|---|
| `terminal_open` 未知 `type` | 工具返回错误并列出可用 host（同 `bash` 未知 host 风格） |
| sandbox 未配 baseEnvironment / 无 Nix | `terminal_open` 返回配置错误，不影响 local 终端 |
| sandbox 终端打开时 `reset`/`disposeSession` | 明确拒绝，提示先关闭终端（pin 规则） |
| PTY spawn 或上游 `spawnArgv` 失败 | 释放 pin，返回错误（fail closed，不静默降级），不留半开实例 |
| owner 已释放后访问终端 | 由 `ctx.terminals` live-owner 校验拒绝（上游行为） |
| 终端输出超限 | 按 `maxResultBytes` 截断并提示（上游行为） |

## 19.4 Web 设计

### 19.4.1 装配行（设计选择）

全部用**显式 bundle 行**（不插 experimental group），行 id 稳定以便 Nix overlay 覆盖：

| 行 id | name | 说明 |
|---|---|---|
| `web` | `@deepseek-ai/dsh-web` | `ctx.web`；pin `searchProvider`/`fetchProvider` |
| `web-search-deepseek` | `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official`；`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`；`DEEPSEEK_SEARCH_BASE_URL` 覆盖 |
| `web-fetch-http` | `@deepseek-ai/dsh-web-fetch-http` | `http`；匿名公网抓取 |
| `web-deepseek-api` | `@deepseek-ai/dsh-web-deepseek-api` | `deepseek-search-api`/`deepseek-fetch-api`；默认挂载不选中 |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `web_search`/`web_fetch` |

顺序：`web` 在 provider 前，`tool-web` 最后；整体放在 `tools` 相关行之后、`nokoribi-agent-app` 之前。lock/Nix 哈希随 P10a 更新。

### 19.4.2 provider pin 与切换

多 provider 可用且未 pin 时 `ctx.web` 报 `AMBIGUOUS`（已核实），本项目**必须显式 pin**。默认 `searchProvider="deepseek-official"`（Messages API 搜索，复用 `DEEPSEEK_API_KEY`，一次搜索=一次模型轮次、计入主模型预算）、`fetchProvider="http"`（匿名抓取，不耗模型轮次）。可配置切换为 `deepseek-search-api`/`deepseek-fetch-api`（直连、不耗辅助轮次；凭据默认同样复用 `DEEPSEEK_API_KEY`，🧪 P10b 实测）。选择只在 bundle/Nix 配置层，不做运行时切换命令（纯 Nix 只读配置，D118）。

### 19.4.3 Reviewer 豁免（D170）

**机制**（补丁点已核实）：

1. `packages/reviewer/vendor/auto-review.js` 的 `createAutoReview(ctx, config, policy)` 内 `ctx.on("tools/pre-execute", ...)` 是拦截点；在 hook 进入后（已先判 preset）加 `if (config.exemptTools.includes(exec.name)) return next();`，其余工具保持原两档逻辑。该 hook 只在 Auto preset 下进入，豁免因此只作用于 Auto。
2. `packages/reviewer/src/config.ts` 增 `exemptTools: string[] default []`（`Schema.array(Schema.string()).default([])`）。
3. `packages/reviewer/PATCHES.md` 增第 6 条；`VERSION.md` 不动（仍是 rc.3，只加补丁项）。
4. bundle `nokoribi-reviewer` 行增 `exemptTools: !!js (process.env.NOKORIBI_REVIEW_EXEMPT_TOOLS ?? 'web_search,web_fetch').split(',').filter(Boolean)`。
5. NixOS `review.exemptTools` 默认 `["web_search","web_fetch"]`；overlay 的 reviewer 行写全 `fast/strong/timeoutMs/exemptTools`（字段替换语义，必须写全）。
6. 列表可配置为空（恢复全量审查）或加其他只读工具；不提供运行时关闭审查。

**理由与残余风险**：两个工具只读外部内容，fetch provider 自带公网/SSRF/同源重定向/大小限制；搜索/抓取高频，每次多一轮 reviewer 成本与延迟明显。但**绕过 LLM 审查本身是新残余风险**：外部内容注入/prompt injection 不再经 reviewer 判读，入参（query/url）也不被审查。登记 [15](15-verification-and-risks.md) 与 [08.8](08-autoreview-and-security.md)（P10e 回写）。`terminal_*`、`bash`、文件、memory 等**不豁免**。

### 19.4.4 配置

NixOS `services.nokoribi-agent.web`（P10e 回写 [12.4](12-nixos-deployment.md)）：`enable=true`；`searchProvider="deepseek-official"`（可 `deepseek-search-api`）；`fetchProvider="http"`（可 `deepseek-fetch-api`）；`deepseekSearchBaseUrl=null`（-> `DEEPSEEK_SEARCH_BASE_URL`）；`searchMaxResults=8`；`searchMaxQueries=4`；`fetchTimeoutSeconds=30`；`searchTimeoutSeconds=30`；`fetchMaxOutputChars=200000`（均对齐 `dsh-tool-web` 默认）。

`web` 行 config 由 overlay 写全（`searchProvider`/`fetchProvider` 是 `dsh-web` 的字段）；`tool-web` 行写 `search`/`fetch` 开关与上限（字段名以 P10b 核对为准）。`DEEPSEEK_API_KEY` 复用现有 `environmentFile`，不新增密钥、不进 store。`enable=false` 时 overlay 用 `disabled: true` 停用上述 5 行；dev bundle 默认启用。`.env.example` 增 `NOKORIBI_WEB_*` 注释与“真实搜索需 API key+网络”。

### 19.4.5 安全与成本

| 项 | 控制 | 残余风险 |
|---|---|---|
| 外部内容注入 | 工具结果自带“外部不可信”提示；`nokoribi:safety` 要求当数据 | 少一层 reviewer 判读（D170 接受） |
| SSRF/内网 | `http` fetch 只允许公网、同源重定向、大小上限 | provider 实现缺陷；不另做域名 allowlist |
| 凭据 | fetch 不带 key；搜索只向 DeepSeek 发 query | query 离开本机（用户已知） |
| 成本 | 默认 Messages API 搜索=一次模型轮次；可切 `deepseek-search-api` | 高频误用，用 `searchMaxQueries`/提示词约束 |
| 输入回显 | `fetchMaxOutputChars` 截断 | 大页面信息丢失 |

## 19.5 测试与验收

### 19.5.1 分层测试（D127–D130 口径）

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单元 | `packages/shell-bash/test/hosts.test.ts` | `terminal` 能力位校验、`terminalLaunch` 路由/未知 host/未实现、`onChange` |
| 单元 | `packages/terminal-host/test/*` | **注入 fake `spawnTerminal`**：backend 路由、argv/env/cwd 替换、尺寸透传、`done`→release、`terminate`→release、spawn 失败→release、缺注入报错、`enabled=false` 不注册 |
| 单元 | `packages/shell-host-local/test/*` | local launch 的 argv/cwd/env/release 缺省 |
| 单元 | `packages/shell-host-sandbox/test/*` | pin 增减、TTL 跳过 pin、reset/dispose 拒绝、status `terminalSessions`、nix/setpriv 缺失 |
| 单元 | `packages/reviewer/test/*` | `exemptTools` schema 默认；fake ctx 下 `web_search` 不调 reviewer、`bash` 仍审查、空列表全审查 |
| 单元 | Web fake provider | fake provider 注册 + pin 选择 + `AMBIGUOUS` + 缺 key 报错 + 输出截断（不起真实网络） |
| 进程 | `tests/process/m10-terminal.test.ts` | **真实 PTY（local）**：open → send `pwd`/`cd`/`export` → read 验证状态持久 → list → close；owner 隔离；`/clear` 清理；SIGTERM |
| 进程 | `tests/process/m10-web.test.ts` | fake LLM + 本地 fake search HTTP（`DEEPSEEK_SEARCH_BASE_URL`）；web_search 不触发 reviewer；fetch 失败/截断（不依赖公网） |
| 门禁 | 手工/gated | sandbox 终端（Nix buildEnv）、真实搜索、真实公网抓取 |

flake unit（`pnpm test:unit`，只跑 `packages/*/test`）**不放真实 PTY 测试**（[13.5](13-testing-and-ops.md)）；PTY 只在本地 `pnpm test`/`pnpm test:process`。

### 19.5.2 关键场景

1. local 终端 `cd /tmp && export A=1` 后新 send 仍保留状态，`terminal_list` 可见。
2. main 与 goal child 终端互不可见；child 归档/`/clear` 时被清理。
3. sandbox 终端打开时 TTL 不回收、`reset` 被拒；关闭全部终端后 reset 成功且 generation+1。
4. `/clear`：旧终端关闭 → `disposeSession` 成功，不出现 `pins>0` 错误。
5. `terminal.enable=false`（Nix 部署）：`bash(host)` 正常、终端工具不存在、提示词不误导。
6. Web 默认 pin 命中 `deepseek-official`/`http`；切换 `deepseek-search-api` 生效；缺 provider/未 pin 报明确错误。
7. `web_search` 不产生 reviewer 请求（fake LLM 记录），`bash` 仍产生；`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 恢复全审查。
8. `terminal_send` 被 reviewer 拒绝时终端不执行（send 返回拒绝）。

### 19.5.3 验收命令

`pnpm check`、`pnpm test`、`pnpm test:process`、`nix flake check`；Nix module-eval 新增断言（terminal/web 行存在、enable=false 时 `disabled`、reviewer `exemptTools` 默认值）；`.spec/notes/m10-fact-gate.md` 记录真实门禁。

## 19.6 平台与环境门禁

| # | 门禁 | 为什么 | 状态 |
|---|---|---|---|
| G1 | 开发机 bash PTY（open/send/read/close） | 真实 `spawnTerminal` 路径 | 可本地执行（Arch+bash） |
| G2 | NixOS 目标机 PTY（systemd 用户会话、`/proc`、信号） | 部署环境不同；D148 后 subprocess scope 敏感 | 🧪 待目标机 |
| G3 | sandbox 终端（Nix buildEnv+setpriv+临时包） | `nix shell` 下 PTY 的 argv/env 与 no_new_privs | 🧪 手工/gated（12.12 口径） |
| G4 | 真实 DeepSeek 搜索（默认 provider） | Messages API 搜索行为与计费 | 🧪 需 API key+网络 |
| G5 | `deepseek-search-api`/`deepseek-fetch-api` 真实调用 | 切换路径的凭据/响应 | 🧪 需 API key |
| G6 | `http` fetch 真实公网抓取与 SSRF 拒绝 | 网络出口与 provider 限制 | 🧪 有限本地验证 |
| G7 | 豁免后的 reviewer 回归 | 防止误豁免非 web 工具 | 自动化 fake LLM 覆盖 |

## 19.7 实现阶段与文件级清单

### 19.7.1 阶段

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P10a 依赖/装配/哈希 | 加 DSH 依赖与 lock；bundle 行（terminal/web/sandbox-policy/reviewer config）；bundle/launcher package.json；`nix/deps.nix` 哈希；`nix flake check` | 包可解析、空实现插件可加载、`nix build` 通过 |
| P10b Web | web 行配置 + pin；`tool-web` 配置；reviewer 豁免 patch + 测试；`.env.example` | fake provider 单测/进程测试通过；真实 API 门禁登记 |
| P10c 终端 local | `terminal-host` 包；host 协议/registry/能力位/onChange；local launch；提示词段；测试 | local 真实 PTY 进程测试通过；discovery 含 `terminal` |
| P10d 终端 sandbox | sandbox pin/TTL/reset/dispose/status；sandbox launch；清理顺序 helper | sandbox 单测 + 清理顺序测试通过；手工 Nix 门禁登记 |
| P10e 文档与门禁 | NixOS module/overlay/check-module/module-eval；README/AGENTS/03/04/07/08/09/12/13/14/15/16 回写；门禁记录 | `pnpm check`/`nix flake check` 通过；文档与实现一致 |

### 19.7.2 新增文件

`packages/terminal-host/{package.json,tsconfig.json,tsdown.config.ts}`；`packages/terminal-host/src/{index,config,backends,spawn,prompt}.ts`（按实现拆分）；`packages/terminal-host/test/*.test.ts`；`packages/agent-app/src/terminal-cleanup.ts`；`tests/process/m10-terminal.test.ts`、`tests/process/m10-web.test.ts`；施工时 `.spec/notes/m10-fact-gate.md`。

### 19.7.3 修改文件

- `packages/shell-bash/src/{hosts,tool,prompt}.ts`（launch 协议/能力位/registry/discovery/hosts 段一句话）
- `packages/shell-host-local/src/index.ts`（local launch）；`packages/shell-host-sandbox/src/{host,command,index}.ts`（`pins`/`terminalLaunch`/terminal argv 构造与测试/互锁/status）
- `packages/agent-app/src/daemon.ts`（`/clear` 顺序、shutdown 清理）、`packages/agent-app/src/goals/manager.ts`（归档先杀终端）
- `packages/reviewer/src/config.ts`、`packages/reviewer/vendor/auto-review.js`、`packages/reviewer/PATCHES.md`
- `packages/bundle/cordis.patch.yml`、`packages/bundle/package.json`、`packages/launcher/package.json`
- `nix/module.nix`（`terminal.*`/`web.*`/`review.exemptTools`）、`nix/overlay.nix`、`nix/check-module.py`、`nix/tests.nix`/`flake.nix`（module-eval 断言）、`nix/deps.nix`、`pnpm-lock.yaml`
- `.env.example`、`README.md`、`AGENTS.md`；文档回写 `.spec/03`（D165/D168–D171 已由 Lead 写入，实现时补“已实现”口径）、`.spec/04`（包与行）、`.spec/07`（host 协议）、`.spec/08`（豁免风险）、`.spec/09`（`nokoribi:pty`）、`.spec/12`（选项）、`.spec/13`（测试）、`.spec/14`（M10 记录）、`.spec/15`（风险/门禁）、`.spec/16`（若涉及术语）

## 19.8 风险与回退

| 风险 | 影响 | 缓解 | 回退 |
|---|---|---|---|
| `BashTerminalBackend` 注入点不足（签名/行为不符） | 无法复用，终端无法按设计启动 | P10c 先做注入可行性 spike | **vendoring `dsh-terminal-bash`**：源码进 `packages/terminal-host/vendor/`，保留 LICENSE/版本/SHA 并记 `PATCHES.md`；新增决策记录（编号顺延，预计 D172） |
| `spawnTerminal` 字段名/必填项不一致 | 注入实现返工 | 🧪 按 19.2.2 实现并小步验证 | 以 rc.3 类型为准调整，规格回写 |
| `terminal_open` 的 `type` 不生效 | host-aware 不满足 | 每 host 一个 backend + 显式 type；P10a 验证 | 注册单 backend，在注入内按 request 选 host（降级记录） |
| sandbox terminal 与 TTL/reset 竞态 | 目录被删而 PTY 仍开 | pin 互锁 + dispose 顺序 + 单测 | 拒绝操作并提示关闭终端 |
| 清理顺序在 dispose 竞态下失败 | 残留 PTY/目录 | 显式顺序 + 失败 log + 进程退出兜底 | 依赖进程退出，不持久化终端 |
| Web 多 provider `AMBIGUOUS` | 工具不可用 | 默认显式 pin + 配置校验 | overlay 停用一个 provider 行 |
| 豁免被滥用/误配 | 安全边界削弱 | 默认只含两个 web 工具；`/status full` 可见；风险登记 15 | `exemptTools=[]` 恢复全审查 |
| 新依赖改变 lock/FOD 哈希 | `nix build` 失败 | P10a 同批更新哈希 | 回退依赖变更，单独提交 |
| DSH 升级破坏注入点/补丁/provider id | 终端/Web/豁免失效 | D171 升级回归清单 + [04.7](04-architecture-and-build.md) 流程 | 固定 rc.3，不随 semver 升级 |

## 19.9 决策映射

| 决策 | 内容 | 本文落点 |
|---|---|---|
| D165 | M9=QQ 按钮审批；M10=持久终端+Web；SSH host 顺延 | 全文定位；M9 不在本文 |
| D168 | host-aware、进程内持久、优先复用 DSH、`BashTerminalBackend` 注入 `spawnTerminal`、失败回退 vendoring | 19.3.1–19.3.4、19.8 |
| D169 | 双 provider 挂载、默认 `deepseek-official`+`http`、可切 API provider、复用 `DEEPSEEK_API_KEY` | 19.4.1–19.4.2 |
| D170 | `web_search`/`web_fetch` 豁免 Auto review；`terminal_*`/`bash` 仍逐次审查 | 19.4.3、19.5.2 |
| D171 | DSH 固定 `0.2.1-rc.3`；升级回归 backend 注入签名、reviewer patch、provider id、`sandboxPolicy` | 19.2.2、19.7.1、19.8 |
| D31/D34 | 全局 Auto preset；无 `sandbox_permissions`；沙箱不是权限边界 | 终端/Web 不新增权限通道，policy 仅前置 |
| D44/D48/D49 | sandbox 语义、约定隔离、默认 host | 19.3.6 沿用 |
| D64 | reviewer 双档/独立模型 | 19.4.3 豁免不改双档逻辑 |
| D122/D145 | DSH/Node 版本固定 | 19.8 升级风险 |
| D149/D164 | 里程碑重排与 M8 口径 | 19.1 背景；M10 不改 M8 |
| D163 | 动作按钮契约预留 | 与 M10 无交互（M9 消费） |

## 19.10 未决与后置

1. 🧪 `BashTerminalBackend` 的 `ResolvedConfig` 字段名（`type/shellPath/rows/cols/scrollbackLines`）与 `spawnTerminal` 注入签名：P10c spike 后回写 19.3.2/19.3.3。
2. 🧪 `terminal_open` 是否支持省略 `type` 的默认 backend；支持则默认映射 `shellHosts.defaultHost`，否则提示词强制显式。
3. 🧪 `dsh-tool-terminal` 是否已注册 `tool:pty` 引导段；重复时保留上游段（19.3.8）。
4. 🧪 `dsh-web`/`dsh-tool-web` 的 config 字段名与默认值（`search`/`fetch` vs `searchProvider`/`fetchProvider`）；P10b 对齐。
5. 🧪 `deepseek-search-api`/`deepseek-fetch-api` 的凭据来源是否同样读 `DEEPSEEK_API_KEY`/`dsh-credentials`。
6. 🧪 bundle 行能否直接 `disabled: !!js`（dev 侧开关）；确认前 dev 只用插件 `enabled` 与 Nix overlay 控制。
7. 终端 `run_in_background` 是否暴露（上游 `enableRunInBackground` 默认值未知）；先按上游默认，默认关闭再决定显式打开。
8. 豁免范围是否应含未来只读 `sandbox status` 类工具；M10 不扩大。`/status full` 的终端展示当前只在 sandbox 行显示 `terminalSessions`，实现时可统一。
9. 跨重启终端（tmux/dtach attach）明确后置，不在 v1+ 承诺。
