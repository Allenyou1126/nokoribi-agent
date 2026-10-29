# 19 持久终端与 Web（M10）

> 状态：**代码完成（2026-10-29），G2/G3/G4/G6 目标机用户态通过，G5 与 systemd 12.14 验收待执行**。本文是 M10 的实施规格：host-aware 持久终端（`terminal_*`）与 Web Search/Fetch。排期见 D165，终端/Web/豁免/依赖决策见 D168–D171（[03](03-decision-log.md)）；M9（QQ 按钮审批）不在本文范围。实现记录与偏差见 19.11；G1–G7 门禁记录见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)。标“已核实”的是对照 rc.3 包元数据/源码/本次实现确认的事实；标“设计选择”的是本规格取舍。实现前标注 🧪 的项已按 rc.3 实际签名/默认值复核，结论回写在 19.2.2 与 19.10；目标机用户态验证见 19.6 与 fact-gate。

## 19.1 需求与范围

1. **持久交互终端**：模型需要跨工具调用保留 shell 状态的交互能力（REPL、长会话调试、需 cd/env 持续生效的场景），而不是每次 `bash(host)` 都新起进程（[07.3](07-shell-hosts-and-sandbox.md)）。
2. **host-aware**：终端必须可选 `local:workspace` 或 `sandbox:default`，与 `bash(host)` 的 host 语义一致（D168）；不做主机级单例终端。
3. **Web 能力**：模型可 `web_search`/`web_fetch`；默认启用、不新增密钥（复用 `DEEPSEEK_API_KEY`，D169）。
4. **不放大审批噪声**：只读外部内容不逐次进 LLM reviewer（D170）；终端与其余工具保持逐次审查。
5. **进程内持久**：终端状态在 daemon 生命周期内保留，重启即丢失（D168）。

交付：DSH `ctx.terminals` + 6 个 `terminal_*` 工具；每个 host 一个 `BashTerminalBackend`；host 协议 `terminalLaunch`；local/sandbox 两种 launch；sandbox terminal pin 与生命周期；Web 显式行 + 双 provider pin；reviewer `exemptTools`；清理顺序；`nokoribi:pty` 提示词；`terminal.*`/`web.*`/`review.exemptTools` 配置；单元/PTY/进程测试与门禁。

**非目标**：跨 daemon 重启的终端持久（不引 tmux/screen/dtach，不做 attach/detach）；默认 vendoring `dsh-terminal-bash`（优先注入 `spawnTerminal`，失败才回退，19.8）；DSH 权限沙箱（`dsh-sandbox-policy` 只作解析前置，`mode=danger-full-access`，D31/D34/[07.11](07-shell-hosts-and-sandbox.md)）；SSH host 终端（D149→D165 顺延）；终端 UI/Web 前端/浏览器渲染/登录态抓取；不改变 `bash(host)` “每次新进程”语义。

**完成定义**：`pnpm check`/`pnpm test`/`pnpm test:process`/`nix flake check` 通过；19.5 自动化场景与 19.6 可执行门禁通过，其余门禁（真实 API/sandbox/NixOS PTY）记录在 [.spec/notes/m10-fact-gate.md](notes/m10-fact-gate.md)。**当前状态**：应用测试层（`pnpm test:unit`/`pnpm test`/`pnpm test:process`）、`pnpm check`、`nix flake check`、`nix build .#default` 与 `nix run --version` 均已通过（2026-10-29 最终门禁，19.11），G1/G7 自动化门禁通过；G2/G3/G4/G6 已在 hkg-dog-darell 用户态临时环境通过，G5 与 systemd 12.14 完整目标机验收仍未执行——因此 M10 只能标“代码完成/目标机用户态已验证”，不能标“完整验收通过”。

## 19.2 现状与差距

### 19.2.1 实现前现状（已核实，2026-10-27）

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

### 19.2.2 上游事实（已核实，2026-10-29 实现期复核）

**终端族**：

| 包 | 事实 |
|---|---|
| `@deepseek-ai/dsh-terminal` | `ctx.terminals`（`TerminalSessionService`）：`registerBackend/listBackends/spawn/hasOwnerActivity/startSend/read/signal/kill/list`；owner-scoped（每个 Agent 精确隔离）；owner 释放时 `owner.ctx.effect` 自动清理；与 `ctx.agents` 做 live-owner 校验。registry 铸造 `sessionId` 后才把 `TerminalBackendSpawnSpec{sessionId, owner, signal, type, name?, cwd?}` 交给 backend `spawn()`（见下，这正是 owner 在注入 seam 中被遮蔽的原因） |
| `@deepseek-ai/dsh-tool-terminal` | 6 工具 `terminal_open/send/read/signal/close/list`；`inject ["terminals","tools","systemPrompt","workingDirectory"]`；后台 send 复用 `ctx.jobs`；config `enableRunInBackground`（默认 **true**）/`maxResultBytes`（默认 **262144**）；**自身注册 `tool:pty` 提示段**（`order = ctx.systemPrompt.getSectionOrder("TOOL_PTY")`，M10 保留不覆盖） |
| `@deepseek-ai/dsh-terminal-bash` | **公开导出 `BashTerminalBackend`，ctor 精确签名**：`(ctx, config: ResolvedConfig, spawnTerminal?: (spec: SubprocessTerminalSpawnSpec) => Promise<SubprocessTerminalHandle>, createSession?)`。运行时**只导出** `BashTerminalBackend/Config/PWSH_PROMPT_SETUP/apply/inject/name`；`resolveConfig`/`validateConfig` 只在 `.d.ts` 声明、**运行时不可用**（实现用 `Config({...})` 解析默认值，见 19.3.2）。`Config` 字段：`backendType`（默认 `shell`；`BashTerminalBackend.type = config.backendType`）、`shellDialect`（默认 `bash`）、`shellPath`（bash 默认 `/bin/bash`）、`shellArgs`（bash 默认 `["--noprofile","--norc","-i"]`）、`rows/cols/scrollbackLines/scrollbackMaxBytes/maxReadBytes/pollIntervalMs/.../timeoutMs/disposeGraceMs`。`spawn()` 顺序：`ensureSandboxModeFence` → `ctx.sandboxPolicy.resolve({session})` → `spawnArgv` → 注入的 `spawnTerminal`（cwd 缺省用 `ctx.workingDirectory.ensure`）→ `createSession`（`LocalPtySession` 负责就绪/scrollback/信号/清理）。`inject ["terminals","sandboxPolicy","sessionProjections","subprocess","workingDirectory"]` |
| `@deepseek-ai/dsh-tool-bash-persistent` | **不可用**：工具名固定 `bash`，与现有 `bash(host)` 冲突 |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 不直接插 group：需要显式行 id 让 Nix overlay 覆盖并控制 `sandboxPolicy`/`subprocess` 顺序 |

**前置与 PTY 原语**：`@deepseek-ai/dsh-sandbox-policy` 提供 `ctx.sandboxPolicy`（static `inject ["sessionProjections"]`；config `mode` 默认 `read-only`、`workspaceRoot`；`resolve() -> {mode, workspaceRoot(,sessionId)}`）。本项目固定 `mode="danger-full-access"`：非 danger 模式 `spawnArgv` 需要 `ctx.sandbox` provider，而本仓库不采用 DSH 权限沙箱；注入 `spawnTerminal` 后上游 argv 会被替换，但 backend 仍会计算/校验 argv，故前置不可省。挂载它会附带一个 `sandbox:policy` runtime context 段（缓存安全，文案为“file sandbox 不限制修改”，与 [08](08-autoreview-and-security.md) 边界一致）。

PTY 原语（精确签名已核实）：`ctx.subprocess.spawnTerminal(spec: SubprocessTerminalSpawnSpec) -> Promise<SubprocessTerminalHandle>`；`SubprocessTerminalSpawnSpec = {argv, cwd, env?, rows, cols, terminalType, shellActivity?, graceMs, signal?}`；handle = `{pid?, output, done, write, resize, inspectForeground, inspectActivity, signalForeground, terminate}`。**spec 中没有 owner/sessionId**（owner 只存在于 backend 收到的 `TerminalBackendSpawnSpec`），因此注入闭包不能直接从参数取 session；`dsh-subprocess-local` 已在组合中。

**Web 族**：

| 包 | provider id / 事实（已核实） |
|---|---|
| `@deepseek-ai/dsh-web` | `ctx.web`（`WebRuntime`）；config `searchProvider`/`fetchProvider`（均可选，`$DSH_WEB_SEARCH_PROVIDER`/`$DSH_WEB_FETCH_PROVIDER` 等价，不是隐藏优先链）；每次调用解析 provider；未配置且多个可用 → `WEB_PROVIDER_AMBIGUOUS`，配置未注册/不可用 → `WEB_PROVIDER_CONFIGURED_MISSING`/`WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official`；Anthropic-compatible Messages API + 原生 `web_search_20250305`；默认 baseURL `https://api.deepseek.com/anthropic/v1`（追加 `/messages`），`DEEPSEEK_SEARCH_BASE_URL` 覆盖（provider config `baseURL`）；默认 model `deepseek-v4-flash`、`maxUses=5`；**一次搜索=一次辅助模型轮次**；凭据 `apiKeyEnv` 默认 `DEEPSEEK_API_KEY`（credentials 服务或 launch env 解析） |
| `@deepseek-ai/dsh-web-fetch-http` | `http`；匿名公网 fetch；config `maxResponseBytes/maxBodyChars/timeoutMs/maxRedirects/userAgent`；SSRF/公网地址/同源重定向/字节字符上限（`WEB_FETCH_TIMEOUT`/`WEB_FETCH_TOO_LARGE`/`WEB_REDIRECT_BLOCKED` 等结构化错误）；模块依赖 `dsh-timeout`、`dsh-http-proxy` |
| `@deepseek-ai/dsh-web-deepseek-api` | `deepseek-search-api`/`deepseek-fetch-api`；直连 API，**不耗辅助模型轮次**；默认 baseURL `https://api.deepseek.com/v1/tools`；config `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）/`baseURL`/`count`（默认 10）/`sendOriginalQuestion` |
| `@deepseek-ai/dsh-tool-web` | `web_search`/`web_fetch`；config `search/fetch/searchMaxResults/searchMaxQueries/fetchTimeoutMs/searchTimeoutMs/fetchMaxOutputChars`（本次 bundle/Nix 显式写 8/4/30000/30000/200000）；`inject ["tools","web","systemPrompt"]`；结果带“外部不可信内容”提示；自注册 `tool:web_search`/`tool:web_fetch` 提示段 |

**bundle patch 语义（已核实）**：`@deepseek-ai/dsh-app-boot` 的 YAML 方言支持 `!!js` 表达式，`disabled` 接受布尔或 `!!js` 表达式；`disabled === true`（或 js 表达式）且无 `config` 的行不加载 → Nix overlay/dev env 可按行 id 停用终端/Web 行。M10 bundle 已用 `disabled: !!js (process.env.NOKORIBI_*_ENABLED ?? 'true') === 'false'` 实现 dev 开关（19.4.1/19.3.9）。

模块级库依赖（模块导入，非独立行）：`dsh-credentials`、`dsh-launch-environment`、`dsh-timeout`、`dsh-http-proxy`，另有上游传递依赖（D171 另登记 `dsh-output-retention`）；精确集合以 `pnpm-lock.yaml` 解析为准。

### 19.2.3 差距

| 差距 | 目标 | 归属 |
|---|---|---|
| 无持久 shell | `ctx.terminals` + 6 工具 + 每 host backend | 19.3 |
| 无 host 选路 | `type`=host id；discovery 增 `terminal` 能力位 | 19.3.4 |
| sandbox 只统计命令 | 增加 terminal pin，与 TTL/reset/dispose 互锁 | 19.3.6 |
| 清理顺序 | 先杀终端再 `disposeSession`；shutdown 也显式清 | 19.3.7 |
| 无 Web | 双 provider + 工具 + pin | 19.4.1–19.4.2 |
| reviewer 无豁免 | `exemptTools` + vendor patch + 配置 | 19.4.3 |

> 上述差距均已在实现中关闭（代码完成，2026-10-29）：见 19.3–19.5 与 19.11；目标机用户态 G2/G3/G4/G6 已通过，G5 与 systemd 12.14 仍待执行（19.6）。

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

### 19.3.2 Backend 注册（已实现）

- 新包 `packages/terminal-host`（plugin name `terminal-host`），`inject ["terminals","shellHosts","subprocess","sandboxPolicy","sessionProjections","workingDirectory","systemPrompt"]`；`apply()` 总是注册 `nokoribi:pty` 提示段，`enabled=false` 时只注册“持久终端在本部署禁用。”且不注册任何 backend。
- 对当前已注册的每个 `capabilities.terminal=true` host 建一个 `BashTerminalBackend`：`backendType = host.id`（如 `local:workspace`、`sandbox:default`），再注册到 `ctx.terminals.registerBackend()`；`BashTerminalBackend.type = config.backendType`，模型用 `terminal_open({type:"<host id>"})` 选 host（上游 schema 中 `type` 必填，无省略默认 host 的路径）。
- **ResolvedConfig 构造**：rc.3 运行时只导出 `Config` 而不导出 `resolveConfig`/`validateConfig`，因此用 `BashTerminalConfig({backendType, shellPath, shellArgs, rows, cols, scrollbackLines, timeoutMs})` 解析 schema 默认值，再显式补 `shellDialect ?? "bash"`、`shellPath ?? terminal.bashPath`、空 `shellArgs` 回退 `["--noprofile","--norc","-i"]`；`sendTimeoutMs` 映射上游 `timeoutMs`。真实 argv 仍由注入替换，`shellPath` 只是满足上游校验的非空占位。
- **动态注册/释放**：`ShellHostRegistry.onChange(listener)`；controller 用串行 promise 链把变更串行化：新 host → 建 backend；host 消失或失去 terminal 能力 → 先关闭该 `type` 下已知 owner 的终端，再注销 backend；注册失败/清理失败只 warn，不破坏注册表原子性。插件卸载（`ctx.effect`）先解除监听、等待链、关闭全部终端并注销全部 backend。
- bundle 实际行顺序：`sandbox-policy`（session-projection 之后）→ … → `terminal`（`tools` 之后）→ … → `nokoribi-shell-host-*`/`nokoribi-tool-bash-hosted` → `nokoribi-terminal-host` → `nokoribi-tool-terminal`；动态监听保证 host 注册顺序变化不丢 host。

### 19.3.3 `spawnTerminal` 注入与 handle 包装（已实现）

注入 seam 的难点：registry 交给 backend 的 `TerminalBackendSpawnSpec` 携带 `{owner, sessionId}`，但 `BashTerminalBackend` 转调注入的 `spawnTerminal(spec)` 时只传 `SubprocessTerminalSpawnSpec`（**没有 owner/sessionId**）。实现方式：

1. 每个 host 的 backend 内建一个 `AsyncLocalStorage<TerminalBackendSpawnSpec>`；注册给 `ctx.terminals` 的 backend 是包装对象 `{type: hostId, spawn: (spec) => storage.run(spec, () => inner.spawn(spec))}`，`storage.run` 覆盖整个异步 `inner.spawn()` 生命周期。
2. 注入闭包从 `storage.getStore()` 取当前 spawn 规格（取不到立即抛错，fail closed），用 `store.owner.id` 作为 sessionId。
3. `ctx.shellHosts.terminalLaunch(hostId, {sessionId, cwd, signal})` 取 host launch；校验 argv[0] 与 cwd 非空（否则明确报错）。
4. `ctx.subprocess.spawnTerminal({...上游 spec, argv: launch.argv, cwd: launch.cwd, env: launch.env ? {...spec.env, ...launch.env} : spec.env})`：上游 env（`PS1`、`PROMPT_COMMAND`、`TERM`、`DSH_*` 等）保留，host env 只覆盖 PATH/sandbox 键；`rows/cols/terminalType/graceMs/shellActivity/signal` 透传。
5. 返回包装 handle：`done` 原样透传（不改变结算/拒绝语义），另挂 `handle.done.then(release, release)`；`terminate()` 在 finally 中 `release()`；release 用共享 promise 实现幂等（并发 teardown 只执行一次），失败只 warn；`spawnTerminal` 抛错时先 release 再 rethrow。

约束：不复制 `LocalPtySession`/就绪逻辑；argv 用数组，不拼 shell 字符串；上游 `spawnArgv` 仍会被调用（我们只覆盖结果），故 `sandboxPolicy.mode=danger-full-access` 是硬前置。

### 19.3.4 host 协议扩展（`@nokoribi/shell-bash`，已实现）

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

实现细节（已核实）：

- `TERMINAL_BASH_ARGS = ["--noprofile","--norc","-i"]` 由 `@nokoribi/shell-bash` 导出，local/sandbox/backend 三处共用，避免漂移。
- registry 双向校验：`capabilities.terminal=true` 必须有 `terminal()`；有 `terminal()` 必须声明 `terminal: true`；`capabilities.terminal` 必须是 boolean。
- `terminalLaunch(hostId, request)` 对未知 host 报错并列出已注册 host；对无终端能力的 host 报错并列出 terminal-capable host；不绕过 host provider 直接起进程。
- `get_available_shell_host` 的 `terminal` 字段**不是**只看 provider 能力位：`apply()` 通过 `ctx.terminals.listBackends()` 判断该 host id 是否真有已注册 backend（`terminal.enable=false`/行未加载时即使 provider 声明 `terminal:true` 也显示 `false`）。
- `nokoribi:hosts` 段仅在有 terminal backend 注册时追加“持久交互终端用 `terminal_*`，`terminal_open.type` 填 host id”一句；`terminal.enable=false` 时不输出该指引（19.3.8/19.11 进程测试覆盖）。

### 19.3.5 `local:workspace` 的 launch（已实现）

| 项 | 值（实现） |
|---|---|
| 配置 | local host provider 的 `terminalBashPath`（默认 `"bash"`；bundle 读 `NOKORIBI_TERMINAL_BASH_PATH`，Nix overlay 写入 `terminal.bashPath`）；**只影响终端**，`bash(host)` 不受影响 |
| argv | `[terminalBashPath, "--noprofile", "--norc", "-i"]`（`TERMINAL_BASH_ARGS` 共享常量） |
| cwd | `request.cwd` 绝对路径原样使用；相对路径 `resolve(workspace, request.cwd)`；省略时 workspace（配置的 workspace，缺省 `process.cwd()` 兜底） |
| env | `PATH = extraPackages(:) + ambient PATH`（与 local `bash(host)` 同一 `localPath` 规则）；其余 env 由上游/PTY 提供 |
| release | 无 pin，省略 |
| 安全 | 真实主机、可 sudo；每个 `terminal_send` 仍是工具调用、仍过 Auto review |

### 19.3.6 `sandbox:default` 的 launch（已实现）

- **session 必填**：provider `terminal(request)` 要求 `request.sessionId` 非空（否则明确报错）；内部调 `terminalLaunch(sessionId, request)` 并先 `signal.throwIfAborted()`。
- **复用实例创建**：`terminalLaunch` 走既有 `withLock` + `ensureLocked`（复用目录/generation/包状态），并要求 `baseEnvironment`/`hostBash`/`setpriv`（有临时包时 `nix`）都已解析，否则 fail closed。
- **pin 计数**：`Instance` 增 `pins`；launch 成功后 `pins += 1` 并返回幂等 `release`（首次执行在锁内 `pins = max(0, pins-1)` 并 touch `lastUsedAt`；实例已被回收则 no-op）；`spawnTerminal` 失败由 19.3.3 的包装立即 release。
- **argv**（`buildSandboxTerminalArgv`）：无临时包 `[setpriv,"--no-new-privs","--",hostBash,"--noprofile","--norc","-i"]`；有临时包 `[nix,"shell", <baseEnvironment>, ...packages,"--command",setpriv,"--no-new-privs","--",hostBash,"--noprofile","--norc","-i"]`。`hostBash`/`setpriv`/`nix`/`baseEnvironment` 由 sandbox 现有解析逻辑提供，不读 `terminal.bashPath`；argv 用数组，不拼 shell 字符串。
- **env**：`PATH = <instance.dir>/.path-guard:<baseEnvironment>/bin`（不拼 ambient PATH）；注入 `DSH_SANDBOX_DIR`（实例目录）/`DSH_WORKSPACE_DIR`；`TERM/COLORTERM` 等来自上游 spec。
- **cwd**：固定 sandbox 实例目录；请求的 `cwd`（通常映射到 workspace）**忽略**，由 `nokoribi:pty` 提示词说明“sandbox 终端固定在 `$DSH_SANDBOX_DIR`，workspace 文件用 cp/rsync”，不做 cwd 映射（V15/19.10 已定）。

| 事件 | 实现规则 |
|---|---|
| TTL sweep | `active>0` **或** `pins>0` 时跳过回收，下轮再查 |
| `sandbox reset` | `active>0` **或** `pins>0` 时拒绝，提示先停止命令/关闭终端 |
| `disposeSession` | `pins>0` 时**报错拒绝**（调用方必须先杀终端；正常路径见 19.3.7） |
| `sandbox_packages add/remove` | 允许；只影响之后新开的终端与命令，已打开 PTY 环境不变 |
| `status` | 增 `terminalSessions: pins`，`sandbox status` 输出 `terminalSessions`，`/status full` 展示 `terminals=N` |

### 19.3.7 生命周期与清理顺序（已实现，重要）

`ctx.terminals` 的 owner scope 在 agent 释放时自动清理，但 Cordis 插件 effect dispose 顺序**不可依赖**；sandbox 目录必须在 PTY 关闭后再删。因此显式“先杀终端、再 disposeSession”：

| 触发 | 顺序 |
|---|---|
| `/clear`（`clearSession`） | `abortInteractions` → `old.agent.cancel` → flush → `killTerminals(old.agent)` → `old.dispose()` → `shellHosts.disposeSession(previousId)`（现有 try/catch 保留） |
| goal 归档/清理（`GoalsManager`） | `killTerminalsForSession(sessionId)` → `disposeSession(sessionId)` → 归档；清理失败只 warn，不阻塞归档 |
| daemon shutdown | 现有 cancel/flush 之后、写 `cleanShutdown` 与释放锁之前 `killTerminalsForAgent(mainAgent)`（总 5s 上限）；失败 log |
| host 注销 / 插件卸载 | 关闭该 host type 下所有终端 → 注销 backend |
| daemon 崩溃 | 进程退出即 PTY 消失，内存 pin 一并消失，无需恢复 |

落点（已实现）：新文件 `packages/agent-app/src/terminal-cleanup.ts` 导出 `killTerminalsForAgent(ctx, agent, {timeoutMs?, logger?})`/`killTerminalsForSession(ctx, sessionId, ...)`：`ctx.get("terminals")?.list(agent)` + 逐个 `kill`，**总等待上限 5s**（`TERMINAL_CLEANUP_TIMEOUT_MS=5000`，超出 warn 后返回，不阻塞调用方）；单次 kill 失败 warn 继续；成功 `debug`。`ctx.terminals` 未挂载或 `ctx.agents` 无 live owner 时 no-op，清理路径不依赖终端行存在。调用点：

- `daemon.ts` `shutdown()`：现有 cancel → final flush 之后、`writeState(cleanShutdown)` 与释放单实例锁之前调用 `killTerminalsForAgent(mainAgent)`。
- `daemon.ts` `clearSession()`：abortInteractions → cancel → flush → `killTerminalsForAgent(old.agent)` → `goals.clearAll()` → 创建新 agent → `old.dispose()` → `shellHosts.disposeSession(previousId)`。
- `goals/manager.ts` `disposeSandbox()`：先 `killTerminalsForSession(sessionId)` 再 `shellHosts.disposeSession(sessionId)`；清理失败只 warn，归档继续。
- host 注销/插件卸载：`terminal-host` controller 关闭该 host type 下已知 owner 的终端后注销 backend（见 19.3.2）。

### 19.3.8 提示词段 `nokoribi:pty`（已实现）

- 由 `@nokoribi/terminal-host` 的 `registerPtyPrompt` 注册，`order=3100`（`PTY_SECTION_ORDER`，紧跟 `nokoribi:hosts` 3000，[09.3](09-prompt-and-memory.md)）；`interpolate:false`、内容静态、不含 per-turn 动态值（host 列表仍由 hosts 段渲染）。
- 要点：`terminal_*` 用于**需跨调用保留状态**的交互（REPL、长任务、需 cd/env 持续、交互式 stdin），有界一次性工作优先 `bash(host)`；`type` 是 host id（先 `get_available_shell_host`，只选 `terminal: true`；默认 host 不会自动套用）；local 终端真实主机可 sudo 但每次 send 仍过 review，sandbox 终端固定 sandbox 目录、不能 sudo、TTL/reset 受“有终端打开”保护；输出有界（`maxResultBytes`），大输出写文件；进程内持久，daemon 重启/`/clear`/归档会关闭全部终端；需要后台继续跑时用上游 `run_in_background`（走 `ctx.jobs`），不要反复 send 轮询。
- **与上游 `tool:pty` 段的关系（已核实）**：`dsh-tool-terminal` 自身注册 `tool:pty` 引导段（`order = ctx.systemPrompt.getSectionOrder("TOOL_PTY")`，内容为“仅在有持久状态/交互 stdin 需求时用终端”）。实现**保留该段不覆盖**，`nokoribi:pty` 只追加 host 路由/sandbox/清理口径；两段职责不同：上游讲“何时用终端”，我们讲“选哪个 host、安全边界与生命周期”。
- `nokoribi:hosts` 段仅在存在 terminal backend 时追加一句终端指引（19.3.4）。plugin 级 `enabled=false` 时 `nokoribi:pty` 输出 `PTY_DISABLED_PROMPT` = **“持久终端在本部署禁用。”**（单测覆盖）；但 bundle/Nix 部署在 `NOKORIBI_TERMINAL_ENABLED=false`/`terminal.enable=false` 时直接停用 `nokoribi-terminal-host`/`tool-terminal` 行，插件与工具都不加载、该句不出现（进程测试断言的正是“无工具、无终端引导段、hosts 发现工具保留”）。

### 19.3.9 配置（已实现）

| 配置 | 默认 | 落点（实现） |
|---|---|---|
| `terminal.enable` | `true` | `nokoribi-terminal-host.enabled`，同时决定 bundle terminal 行是否 `disabled`；false 时只注册禁用提示段 |
| `terminal.bashPath` | `"bash"` | 写两处：`nokoribi-terminal-host.bashPath`（上游 `shellPath` 占位）与 `nokoribi-shell-host-local.terminalBashPath`（真实 local 终端 argv）；sandbox 不用 |
| `terminal.maxResultBytes` | `262144` | **`nokoribi-tool-terminal.maxResultBytes`**（不是 terminal-host 配置；对齐上游默认 256 KiB） |
| `terminal.sendTimeoutSeconds` | `30` | Nix 秒 → bundle/overlay `nokoribi-terminal-host.sendTimeoutMs = 秒 × 1000`（上游 `timeoutMs`） |
| `terminal.rows`/`cols` | `40`/`160` | `nokoribi-terminal-host.rows/cols`（PTY 初始尺寸，对齐上游默认） |
| `terminal.scrollbackLines` | `10000` | `nokoribi-terminal-host.scrollbackLines`（scrollback 行数，对齐上游默认） |

环境变量（bundle 行 `!!js` 读取、dev 用；launcher `--help` 已列出）：`NOKORIBI_TERMINAL_ENABLED`、`NOKORIBI_TERMINAL_BASH_PATH`、`NOKORIBI_TERMINAL_MAX_RESULT_BYTES`、`NOKORIBI_TERMINAL_SEND_TIMEOUT_MS`、`NOKORIBI_TERMINAL_ROWS`、`NOKORIBI_TERMINAL_COLS`、`NOKORIBI_TERMINAL_SCROLLBACK_LINES`。

NixOS `services.nokoribi-agent.terminal`（[12.4](12-nixos-deployment.md)）：`enable`、`bashPath`、`maxResultBytes`、`sendTimeoutSeconds`、`rows`、`cols`、`scrollbackLines`，默认同上；`enable=false` 时 overlay 用 `disabled = true` 停用 `sandbox-policy`/`terminal`/`nokoribi-terminal-host`/`nokoribi-tool-terminal` 四行（`bash(host)` 与 shell host 行不受影响，module-eval-disabled 断言）。dev 侧同样可用 `NOKORIBI_TERMINAL_ENABLED=false` 让这四行不加载。

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

### 19.4.1 装配行（已实现）

全部用**显式 bundle 行**（不插 experimental group），行 id 稳定以便 Nix overlay 覆盖：

| 行 id | name | 说明 |
|---|---|---|
| `web` | `@deepseek-ai/dsh-web` | `ctx.web`；pin `searchProvider`/`fetchProvider`（bundle 从 `NOKORIBI_WEB_SEARCH_PROVIDER`/`NOKORIBI_WEB_FETCH_PROVIDER` 读，默认 `deepseek-official`/`http`） |
| `web-search-deepseek` | `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official`；`apiKeyEnv: DEEPSEEK_API_KEY`；`DEEPSEEK_SEARCH_BASE_URL` 覆盖 baseURL |
| `web-fetch-http` | `@deepseek-ai/dsh-web-fetch-http` | `http`；匿名公网抓取（默认 limits） |
| `web-deepseek-api` | `@deepseek-ai/dsh-web-deepseek-api` | `deepseek-search-api`/`deepseek-fetch-api`；`apiKeyEnv: DEEPSEEK_API_KEY`；默认挂载不选中 |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `web_search`/`web_fetch`；bundle/Nix 显式 8/4/30000/30000/200000 |

顺序（已实现）：`web` 在 provider 前、`tool-web` 最后，整体位于 `tool-fs-search` 之后、`subprocess` 之前（tool 相关行之后、`nokoribi-agent-app` 之前）；全部行受 `NOKORIBI_WEB_ENABLED`/Nix `web.enable` 的 `disabled` 控制。新增 `@deepseek-ai/dsh-web*`/`dsh-terminal*`/`dsh-sandbox-policy`/`dsh-tool-*` 依赖后 `pnpm-lock.yaml` 与 `nix/deps.nix` FOD 哈希已同步更新（D171）。

### 19.4.2 provider pin 与切换（已实现）

多 provider 可用且未 pin 时 `ctx.web` 报 `WEB_PROVIDER_AMBIGUOUS`（已核实），本项目**显式 pin**。默认 `searchProvider="deepseek-official"`（Anthropic-compatible Messages API 搜索，复用 `DEEPSEEK_API_KEY`，一次搜索=一次辅助模型轮次、计入主模型预算）、`fetchProvider="http"`（匿名抓取，不耗模型轮次）。可配置切换为 `deepseek-search-api`/`deepseek-fetch-api`（直连、不耗辅助轮次；凭据默认同样复用 `DEEPSEEK_API_KEY`，基址 `https://api.deepseek.com/v1/tools`，已按 rc.3 核实；真实账号可用性见 G5 门禁）。选择只在 bundle/Nix 配置层（dev 可 `NOKORIBI_WEB_SEARCH_PROVIDER`/`NOKORIBI_WEB_FETCH_PROVIDER`），不做运行时切换命令（纯 Nix 只读配置，D118）；上游 `$DSH_WEB_*` 环境等价机制未被本部署暴露。

凭据解析口径（已核实）：`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，provider 每次操作通过 `dsh-credentials` 或 launch environment 解析；无 key 时报 `WEB_PROVIDER_CREDENTIAL_MISSING`。`DEEPSEEK_SEARCH_BASE_URL` 只影响搜索 provider 的 baseURL（Nix `web.deepseekSearchBaseUrl` → systemd env），不影响 `deepseek-search-api`/`deepseek-fetch-api` 的 baseURL（M10 不给后者加 Nix 选项，使用上游默认）。

### 19.4.3 Reviewer 豁免（已实现，D170）

**机制**（补丁点与实现已核实）：

1. `packages/reviewer/vendor/auto-review.js` 的 `createAutoReview(ctx, config, policy)` 内 `ctx.on("tools/pre-execute", ...)` 是拦截点；补丁在 hook 通过 preset/accepting 门槛之后、快照/审查之前加 `if (config.exemptTools.includes(exec.name)) return next();`，其余工具保持原两档逻辑。该 hook 只在 Auto preset 下进入，豁免因此只作用于 Auto；`run_code` 等父级特殊分支在此之前。
2. `packages/reviewer/src/config.ts` 增 `exemptTools`（`Schema.array(Schema.string()).default([])`）——**reviewer 包默认空列表**，由宿主配置注入。
3. `packages/reviewer/PATCHES.md` 增第 6 条；`VERSION.md` 不动（仍是 rc.3，只加补丁项）。
4. bundle `nokoribi-reviewer` 行增 `exemptTools: !!js (process.env.NOKORIBI_REVIEW_EXEMPT_TOOLS ?? 'web_search,web_fetch').split(',').map(trim).filter(Boolean)`（dev 默认豁免两个 web 工具；设为空串即 `[]`）。
5. NixOS `review.exemptTools` 默认 `["web_search","web_fetch"]`；overlay 的 reviewer 行写全 `fast/strong/timeoutMs/exemptTools`（字段替换语义，必须写全）；`module-eval` 断言该默认值与字段。
6. 列表可配置为空（恢复全量审查）或加其他只读工具；不提供运行时关闭审查。

**理由与残余风险**：两个工具只读外部内容，fetch provider 自带公网/SSRF/同源重定向/大小限制；搜索/抓取高频，每次多一轮 reviewer 成本与延迟明显。但**绕过 LLM 审查本身是新残余风险**：外部内容注入/prompt injection 不再经 reviewer 判读，入参（query/url）也不被审查。登记 [15](15-verification-and-risks.md) 与 [08.8](08-autoreview-and-security.md)。`terminal_*`、`bash`、文件、memory 等**不豁免**（G7 回归：`bash` 仍产生 reviewer 请求）。

### 19.4.4 配置（已实现）

NixOS `services.nokoribi-agent.web`（[12.4](12-nixos-deployment.md)）：`enable=true`；`searchProvider="deepseek-official"`（enum：可 `deepseek-search-api`）；`fetchProvider="http"`（enum：可 `deepseek-fetch-api`）；`deepseekSearchBaseUrl=null`（非 null → systemd `DEEPSEEK_SEARCH_BASE_URL`，null 时不设置该 env）；`searchMaxResults=8`；`searchMaxQueries=4`；`fetchTimeoutSeconds=30`；`searchTimeoutSeconds=30`；`fetchMaxOutputChars=200000`（均对齐 `dsh-tool-web` 默认）。**M10 未提供 `deepseekApiBaseUrl` 选项**（`deepseek-search-api`/`deepseek-fetch-api` 使用上游默认基址），规划期的该字段已移除。

`web` 行 config 由 overlay 写 `searchProvider`/`fetchProvider`；`tool-web` 行写 `search/fetch` 开关与全部上限（`fetchTimeoutSeconds`/`searchTimeoutSeconds` 秒 → 毫秒）；`web-search-deepseek`/`web-deepseek-api` 行沿用 bundle 的 `apiKeyEnv: DEEPSEEK_API_KEY`（Nix 不重写 provider 行）。`DEEPSEEK_API_KEY` 复用现有 `environmentFile`，不新增密钥、不进 store。`enable=false` 时 overlay 用 `disabled: true` 停用 `web`/`web-search-deepseek`/`web-fetch-http`/`web-deepseek-api`/`tool-web` 5 行（`module-eval-disabled` 断言）。dev bundle 默认启用，`NOKORIBI_WEB_ENABLED=false` 可关闭；`.env.example` 与 launcher `--help` 已列 `NOKORIBI_WEB_ENABLED`/`NOKORIBI_WEB_SEARCH_PROVIDER`/`NOKORIBI_WEB_FETCH_PROVIDER`/`DEEPSEEK_SEARCH_BASE_URL` 与“真实搜索需 API key+网络”。

### 19.4.5 安全与成本

| 项 | 控制 | 残余风险 |
|---|---|---|
| 外部内容注入 | 工具结果自带“外部不可信”提示；`nokoribi:safety` 要求当数据 | 少一层 reviewer 判读（D170 接受） |
| SSRF/内网 | `http` fetch 只允许公网、同源重定向、大小上限 | provider 实现缺陷；不另做域名 allowlist |
| 凭据 | fetch 不带 key；搜索只向 DeepSeek 发 query | query 离开本机（用户已知） |
| 成本 | 默认 Messages API 搜索=一次模型轮次；可切 `deepseek-search-api` | 高频误用，用 `searchMaxQueries`/提示词约束 |
| 输入回显 | `fetchMaxOutputChars` 截断 | 大页面信息丢失 |

## 19.5 测试与验收

### 19.5.1 分层测试（D127–D130 口径，已实现）

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单元 | `packages/shell-bash/test/hosts.test.ts`、`tool.test.ts` | `terminal` 能力位双向校验、`terminalLaunch` 路由/未知 host/未实现、`onChange`；发现工具 `terminal` 字段按实际注册 backend 隐藏；hosts 提示词终端指引条件输出 |
| 单元 | `packages/terminal-host/test/*`（5 文件 33 测试） | **注入 fake `spawnTerminal`**：per-host backend 注册/注销/串行、argv/cwd/env 替换、上游 env 透传、`done`→release、`terminate`→release、spawn 失败→release、缺 owner 上下文报错、`enabled=false` 只注册禁用提示、配置默认值 |
| 单元 | `packages/shell-host-local/test/*` | local launch 的 argv/cwd/PATH、相对 cwd 解析、`terminalBashPath` |
| 单元 | `packages/shell-host-sandbox/test/*` | `buildSandboxTerminalArgv`、pin 增减/幂等 release、TTL 跳过 pin、reset/dispose 拒绝、`terminalSessions`、nix/setpriv 缺失 |
| 单元 | `packages/reviewer/test/*` | `exemptTools` schema 默认 `[]` 与自定义列表解析（运行时放行行为由进程测试覆盖） |
| 单元 | `packages/agent-app/test/terminal-cleanup.test.ts` | `killTerminalsForAgent`/`ForSession` 的 5s 有界等待、失败 warn、无 terminals/无 live owner no-op |
| 进程 | `tests/process/m10-terminal.test.ts`（4 场景） | **真实 PTY（local）**：open → send `cd`/`export` → 后续 send/list 验证状态持久 → close；`/clear` 清理；`terminal.enable=false` 不暴露工具/提示；SIGTERM 退出 |
| 进程 | `tests/process/m10-web.test.ts`（2 场景） | fake LLM + 本地 fake search HTTP（`DEEPSEEK_SEARCH_BASE_URL`）；`web_search`/`web_fetch` 不触发 reviewer、`bash` 仍触发；`web_fetch` 非公网 URL 返回 non-public；`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 恢复全审查 |
| 门禁 | 手工/gated | sandbox 终端（Nix buildEnv）、真实搜索/API provider、真实公网抓取、NixOS 目标机 PTY（[notes/m10-fact-gate.md](notes/m10-fact-gate.md)） |

flake unit（`pnpm test:unit`，只跑 `packages/*/test`）**不放真实 PTY 测试**（[13.5](13-testing-and-ops.md)）；PTY 只在本地 `pnpm test:process`。本次施工观察：`pnpm test:unit` 56 文件/438 测试、`pnpm test` 60 文件/458 测试、`pnpm test:process` 10 文件/64 场景全部通过（2026-10-29；见 19.11 与门禁记录）。

### 19.5.2 关键场景（覆盖状态）

1. local 终端 `cd /tmp && export A=1` 后新 send 仍保留状态，`terminal_list` 可见。**（进程测试已覆盖）**
2. main 与 goal child 终端互不可见；child 归档/`/clear` 时被清理。**（`/clear`/SIGTERM 路径进程覆盖；owner 隔离由上游 `ctx.terminals` 精确 owner 校验；goal 归档路径已接入 `killTerminalsForSession`，未单列进程场景）**
3. sandbox 终端打开时 TTL 不回收、`reset` 被拒；关闭全部终端后 reset 成功且 generation+1。**（单测覆盖 pin/TTL/reset 逻辑；G3 目标机基础 sandbox PTY 已通过，reset/packages 互锁未在目标机重复）**
4. `/clear`：旧终端关闭 → `disposeSession` 成功，不出现 `pins>0` 错误。**（进程测试已覆盖）**
5. `terminal.enable=false`（Nix overlay/dev env）：`bash(host)` 正常、终端工具不存在、提示词不误导。**（进程测试覆盖模型侧；Nix module-eval-disabled 断言行 disabled；目标机默认启用，未在目标机重复 disabled 场景）**
6. Web 默认 pin 命中 `deepseek-official`/`http`；切换 `deepseek-search-api` 生效；缺 provider/未 pin 报明确错误。**（默认 pin 由 bundle/Nix module-eval 断言；切换与真实 API 待 G5；歧义/缺 provider 错误由上游行为，未专门构造本地用例）**
7. `web_search` 不产生 reviewer 请求（fake LLM 记录），`bash` 仍产生；`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 恢复全审查。**（进程测试已覆盖，G7）**
8. `terminal_send` 被 reviewer 拒绝时终端不执行（send 返回拒绝）。**（未单列自动化；`terminal_send` 与其他工具走同一 `tools/pre-execute` 审查路径，待补一个 fake reviewer 用例）**

### 19.5.3 验收命令

`pnpm check`、`pnpm test`、`pnpm test:unit`、`pnpm test:process`、`nix flake check`；Nix module-eval 新增断言（terminal/web 行存在、enable=false 时 `disabled`、reviewer `exemptTools` 默认值、`DEEPSEEK_SEARCH_BASE_URL`）；`.spec/notes/m10-fact-gate.md` 记录真实门禁。**当前**：`pnpm test*`、`pnpm check`、`nix flake check`、`nix build` 已通过；G2/G3/G4/G6 已在目标机用户态通过，G5 与 systemd 12.14 仍待执行，不能据此宣称完整 M10 验收完成。

## 19.6 平台与环境门禁

> 记录与命令见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)。M10 标“代码完成 + 目标机用户态 G2/G3/G4/G6 通过”；G5 与 systemd 12.14 未执行前不得写“完整验收通过”。

| # | 门禁 | 为什么 | 状态（2026-10-29） |
|---|---|---|---|
| G1 | 开发机 bash PTY（open/send/read/close） | 真实 `spawnTerminal` 路径 | **自动化通过**：`pnpm test:process` 的 `tests/process/m10-terminal.test.ts` 4/4 通过（本次观察） |
| G2 | NixOS 目标机 PTY（systemd 用户会话、`/proc`、信号） | 部署环境不同；D148 后 subprocess scope 敏感 | **用户态通过（2026-10-29 hkg-dog-darell）**：local PTY 回复 `PTY:/tmp:ok`，`/clear` 无 cleanup 错误；setsid 用户进程，systemd unit/重启未测 |
| G3 | sandbox 终端（Nix buildEnv+setpriv+临时包） | `nix shell` 下 PTY 的 argv/env 与 no_new_privs | **基础通过（2026-10-29）**：sandbox PTY 输出 `SB:<sandbox dir>`、uid 1001、sudo 被 guard 拒绝；reset/packages 互锁仍由单测覆盖 |
| G4 | 真实 DeepSeek 搜索（默认 provider） | Messages API 搜索行为与计费 | **通过（2026-10-29）**：真实搜索返回 nixos.org/distrowatch.com source |
| G5 | `deepseek-search-api`/`deepseek-fetch-api` 真实调用 | 切换路径的凭据/响应 | ⏳ **待执行**（本次未切换 provider；provider id/基址已核实） |
| G6 | `http` fetch 真实公网抓取与 SSRF 拒绝 | 网络出口与 provider 限制 | **基础通过（2026-10-29）**：example.com HTTP 200；localhost 返回 non-public 错误；重定向/大小上限未独立构造 |
| G7 | 豁免后的 reviewer 回归 | 防止误豁免非 web 工具 | **自动化通过**：`tests/process/m10-web.test.ts` 2/2（web 不审、bash 仍审、空列表恢复全审） |

## 19.7 实现阶段与文件级清单

### 19.7.1 阶段

> 五个阶段均已施工（2026-10-29）；P10a/P10c/P10d 的自动化测试与 P10e 的文档回写已完成；P10a/P10e 的 `nix build`/`nix flake check` 已通过；P10b/P10d 的真实 API/Nix 门禁仍待目标机执行（见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)）。

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

- `packages/shell-bash/src/{hosts,tool,prompt,index}.ts`（launch 协议/能力位/registry/onChange/discovery/hosts 段终端指引/`TERMINAL_BASH_ARGS`）
- `packages/shell-host-local/src/index.ts`（`terminalBashPath` + local launch）；`packages/shell-host-sandbox/src/{host,command,index,tools}.ts`（`pins`/`terminalLaunch`/`buildSandboxTerminalArgv`/互锁/status `terminalSessions`）
- `packages/terminal-host/*`（新包：config/backends/spawn/prompt/index + 测试）
- `packages/agent-app/src/{daemon,status}.ts`、`packages/agent-app/src/goals/manager.ts`、`packages/agent-app/src/terminal-cleanup.ts`（`/clear`/shutdown/goal 归档/`/status full` `terminals=N`）
- `packages/reviewer/src/{config,types}.ts`、`packages/reviewer/vendor/auto-review.js`、`packages/reviewer/PATCHES.md`（第 6 条）
- `packages/bundle/cordis.patch.yml`、`packages/bundle/package.json`、`packages/launcher/{package.json,src/index.ts}`（依赖/行/`--help`）
- `nix/{module,overlay,deps}.nix`、`nix/check-module.py`、`flake.nix`（module-eval + module-eval-disabled + package-smoke 新依赖断言）、`pnpm-lock.yaml`
- `.env.example`、`README.md`、`AGENTS.md`；文档回写 `.spec/04`（包与行）、`.spec/05`（清理顺序）、`.spec/07`（host 协议与实现）、`.spec/08`（豁免风险）、`.spec/09`（`nokoribi:pty`）、`.spec/10`（goal 归档清理）、`.spec/11`（成本）、`.spec/12`（选项）、`.spec/13`（测试）、`.spec/14`（M10 记录）、`.spec/15`（风险/门禁）、`.spec/19`（本文）、`.spec/notes/m10-fact-gate.md`（新）。`.spec/03` 未新增决策：实现遵循 D168–D171（未触发 vendoring 回退），故不新增 D172；`.spec/16` 无术语变化。

## 19.8 风险与回退

| 风险 | 影响 | 缓解 | 回退 |
|---|---|---|---|
| `BashTerminalBackend` 注入点不足（签名/行为不符） | 无法复用，终端无法按设计启动 | P10c 先做注入可行性 spike | **实现结果：未触发**（G1 自动化 4/4 通过，注入点够用）。若未来升级破坏：**vendoring `dsh-terminal-bash`**：源码进 `packages/terminal-host/vendor/`，保留 LICENSE/版本/SHA 并记 `PATCHES.md`；新增决策记录（编号顺延） |
| `spawnTerminal` 字段名/必填项不一致 | 注入实现返工 | 已按 rc.3 类型核对（19.2.2） | 以 rc.3 类型为准调整，规格回写 |
| `terminal_open` 的 `type` 不生效 | host-aware 不满足 | 每 host 一个 backend + 显式 type（已实现并进程验证） | 注册单 backend，在注入内按 request 选 host（降级记录） |
| sandbox terminal 与 TTL/reset 竞态 | 目录被删而 PTY 仍开 | pin 互锁 + dispose 顺序 + 单测（已实现） | 拒绝操作并提示关闭终端 |
| 清理顺序在 dispose 竞态下失败 | 残留 PTY/目录 | 显式顺序 + 有界 5s + 失败 warn + 进程退出兜底（已实现） | 依赖进程退出，不持久化终端 |
| Web 多 provider `AMBIGUOUS` | 工具不可用 | 默认显式 pin + module-eval 断言（已实现） | overlay 停用一个 provider 行 |
| 豁免被滥用/误配 | 安全边界削弱 | 默认只含两个 web 工具（bundle/Nix 默认；reviewer 包默认 `[]`）；可配置为空；G7 回归覆盖 | `exemptTools=[]` 恢复全审查 |
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

## 19.10 未决与后置（2026-10-29 回写）

1. ✅ **已解决**：`BashTerminalBackend` 的配置字段是 `backendType`（不是 `type`），`spawnTerminal` 只收 `SubprocessTerminalSpawnSpec`（无 owner/session）→ 用 `AsyncLocalStorage` 传 owner；`resolveConfig`/`validateConfig` 运行时未导出 → 用 `Config({...})` 物化。见 19.2.2/19.3.2/19.3.3。
2. ✅ **已解决**：`terminal_open` 的 `type` 在 rc.3 schema 中必填，**不支持省略默认 backend**；提示词要求先 `get_available_shell_host` 并显式选 `terminal: true` 的 host。
3. ✅ **已解决**：`dsh-tool-terminal` 注册了 `tool:pty` 段（order 来自 `getSectionOrder("TOOL_PTY")`），保留不覆盖；`nokoribi:pty` 追加 host 路由/安全口径（19.3.8）。
4. ✅ **已解决**：字段名是 `ctx.web` 的 `searchProvider`/`fetchProvider`（不是 `search`/`fetch`）、`dsh-tool-web` 的 `search`/`fetch`/上限字段；bundle/Nix 已按实际字段写入（19.2.2/19.4.1）。
5. ✅ **已解决**：`deepseek-search-api`/`deepseek-fetch-api` 同样 `apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，经 `dsh-credentials`/launch env 解析；真实调用仍待 G5。
6. ✅ **已解决**：bundle 行可直接 `disabled: !!js`（app-boot YAML 方言支持）；dev 已用 `NOKORIBI_*_ENABLED` 控制整组行（19.2.2）。
7. ✅ **已解决**：上游 `enableRunInBackground` 默认 **true**；bundle/Nix 显式 `true`，`maxResultBytes` 由 `NOKORIBI_TERMINAL_MAX_RESULT_BYTES`/Nix `terminal.maxResultBytes` 配置。
8. ✅ **已解决（范围不变）**：豁免不扩大到 `sandbox`/文件等只读工具；`/status full` 只在 sandbox 行展示 `terminals=N`，**不展示 `exemptTools`**（M10 未扩展 reviewer 状态输出，后续需要时再加）。
9. ⏳ **后置**：跨重启终端（tmux/dtach attach）不在 v1+ 承诺；`terminal_send` 被 reviewer 拒绝的专用进程用例待补（19.5.2 #8）。

## 19.11 实现记录（2026-10-29）

> 状态：**代码完成（2026-10-29），G2/G3/G4/G6 目标机用户态通过，G5 与 systemd 12.14 待执行**。自动化应用测试、`pnpm check`、`nix flake check`、`nix build` 已通过；G1/G7 门禁通过。不得写“完整 M10 验收通过”。

### 交付

- 新包 `@nokoribi/terminal-host`：`config.ts`（`enabled/bashPath/sendTimeoutMs/rows/cols/scrollbackLines`，默认对齐上游）、`backends.ts`（`TerminalHostController`：每 terminal host 一个 `BashTerminalBackend` + 包装 backend 注入 `spawnTerminal`；`onChange` 串行同步；host 消失先杀终端再注销；插件卸载清理全部）、`spawn.ts`（`createHostTerminalSpawner`：host launch、上游 env 合并、幂等 release、handle 包装；owner 由 `backends.ts` 的 `AsyncLocalStorage` 在包装 `spawn()` 时注入）、`prompt.ts`（`nokoribi:pty` order 3100 + 禁用提示）、`index.ts`（插件契约 `inject` 7 项）。
- `@nokoribi/shell-bash`：`TERMINAL_BASH_ARGS`；`ShellTerminalLaunchRequest/ShellTerminalLaunch`；`ShellHostCapabilities.terminal`（双向校验）；`ShellHostProvider.terminal?`；`ShellHostRegistry.terminalLaunch/onChange`；发现工具 `terminal` 按实际注册 backend 隐藏；hosts 提示词终端指引条件输出。
- `local:workspace`：`terminalBashPath`（默认 `bash`，只影响终端）+ launch（argv/cwd/PATH）。`sandbox:default`：`Instance.pins`、`terminal()`/`terminalLaunch()`、幂等 release、`buildSandboxTerminalArgv`（setpriv / nix shell 两层）、固定 cwd、受限 PATH + sandbox env、TTL/reset/dispose 互锁、`terminalSessions`。
- `agent-app`：`terminal-cleanup.ts`（5s 有界、失败 warn）；`/clear`、daemon shutdown、goal 归档接入；`/status full` sandbox 行 `terminals=N`。
- Web：bundle 5 行 + 默认 pin（`deepseek-official`/`http`）+ `tool-web` 上限；`NOKORIBI_WEB_*`/`DEEPSEEK_SEARCH_BASE_URL`；Nix `web.*` 选项与停用行。
- Reviewer：`exemptTools` 配置 + vendor 第 6 条补丁；bundle 默认 `web_search,web_fetch`、Nix `review.exemptTools` 默认同；空列表恢复全审查。
- Nix：`terminal.*`/`web.*`/`review.exemptTools` 选项、overlay 行渲染/停用、`check-module.py` 新断言、`module-eval` + `module-eval-disabled`、package-smoke 新依赖 import 断言、`nix/deps.nix` 哈希更新。
- 文档：04/05/07/08/09/10/11/12/13/14/15/19 回写，新增 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)；README/AGENTS 状态更新。

### 实现口径/偏差

- **未触发 vendoring 回退**（D168 的“若注入点不足”未发生）：`BashTerminalBackend` 构造注入可用。也没有新决策，故无 D172。
- `AsyncLocalStorage` 是 owner→session 传递的必需手段（`spawnTerminal` spec 无 owner）；无 owner 上下文时 fail closed 抛错。plugin 级 `enabled=false` 只注册禁用提示；部署层 `terminal.enable=false` 直接停用整组行（插件不加载），两者路径不同。
- rc.3 运行时只导出 `Config` 而非 `resolveConfig/validateConfig`，实现自行物化 schema 默认值（19.3.2）。
- `maxResultBytes` 落在 `dsh-tool-terminal` 行而非 terminal-host 插件（19.3.9）；`sendTimeoutSeconds`（Nix）→ `sendTimeoutMs`（bundle）→ 上游 `timeoutMs`。
- sandbox 终端忽略请求 cwd（固定实例目录），由提示词说明；未做 cwd 映射。
- Nix 未提供 `deepseekApiBaseUrl` 选项（规划草案删除），API provider 使用上游默认基址；`DEEPSEEK_SEARCH_BASE_URL` 仅作用于 `deepseek-official`。
- `/status full` 不展示 `exemptTools`（只显示 reviewer 两档/超时），与规划草案的“可见”不同，风险改由配置/日志/门禁覆盖。
- 上游 `tool:pty` 段保留，`nokoribi:pty` 不覆盖；plugin 级 `enabled=false` 只输出禁用提示（单测），bundle/Nix 的 `terminal.enable=false` 则直接停用整组行（插件不加载）。

### 自动化测试（本次施工观察，2026-10-29 21:42–21:44 +08:00）

- `pnpm test:unit`：**56 文件 / 438 测试**通过（flake unit 使用；不含 `tests/integration`，不含真实 PTY）。
- `pnpm test`：**60 文件 / 458 测试**通过（单元 + `tests/integration`）。
- `pnpm test:process`：**10 文件 / 64 场景**通过；M10 新增 2 文件/6 场景（`m10-terminal` 4 + `m10-web` 2，真实 local PTY / fake 搜索 HTTP）。
- `pnpm check`、`nix flake check`、`nix build .#default`、`nix run .#default -- --version`：**2026-10-29 最终门禁通过**（flake check 含 package/unit/package-smoke/module-eval/module-eval-disabled）。
- flake unit 不含真实 PTY；真实 PTY 只在本地 `pnpm test:process`（[13.5](13-testing-and-ops.md)）。

### 门禁与未完成

- G1（开发机真实 PTY）、G7（reviewer 豁免回归）由自动化通过；G2（NixOS 用户态 PTY）、G3（sandbox 终端）、G4（真实搜索）、G6（真实公网抓取 + SSRF 负例）已在 hkg-dog-darell 用户态通过；G5（DeepSeek Search/Fetch API 切换）与 systemd 12.14 完整目标机验收**待执行**，记录见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)。
- `pnpm check`/`nix flake check`/`nix build` 已通过（2026-10-29 最终门禁）；本记录仍不宣称真实平台验收完成。
- 已知待补：`terminal_send` 被 reviewer 拒绝的专用进程用例；goal 归档终端清理的进程级用例；真实 Nix buildEnv 下 sandbox PTY。
