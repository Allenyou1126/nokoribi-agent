# 07 Shell Hosts 与 Sandbox

## 7.1 背景与结论

DSH 的 `ctx.shell` 是**单 provider** 能力 seam：一个组合只能挂载一个 `ShellExecutor`（同时挂 `dsh-bash-local` 与 `dsh-bash-sandbox` 会 duplicate service 失败）。因此"本地 + 沙箱 + SSH + 未来 client"不能各自注册 `ctx.shell`。

最终方案：

- 新增 `ctx.shellHosts` 注册表（我们的 seam）；host 由插件注册为 **provider**，按 `<kind>:<instance>` 路由。
- `shell-router` 只承担一个角色：提供 `ctx.shellHosts`，并作为**唯一的 `ctx.shell` provider**（默认 host 的 façade，供未来其他 DSH 消费方使用）。
- 模型侧 `bash` 工具由我们实现（fork/替代 `dsh-tool-bash`），增加可选 `host` 参数，执行时走 `ctx.shellHosts`；另提供 `get_available_shell_host` 工具。
- host 插件只依赖 `ctx.subprocess` 等底层能力，不注册 `ctx.shell`。

## 7.2 host 标识与注册

### id 语法

`<kind>:<instance>`：

| kind | 含义 | v1 |
|---|---|---|
| `local` | 主机环境（系统 PATH + extraPackages），持久 workspace | 是 |
| `sandbox` | profile 固定 Nix 环境 + 独立临时目录 | 是（默认） |
| `ssh` | 远程主机（后置） | 否（M7） |
| `client` | 未来客户端执行（预留） | 否 |

实例命名（草案）：`local:workspace`、`sandbox:default`；SSH 未来用 `ssh:devbox` 等逻辑名（不是任意 ssh 目标，见 7.9）。

### 注册

每个 host 插件在加载时向 `ctx.shellHosts.register(provider)` 注册；provider 声明：

```ts
interface ShellHostProvider {
  readonly id: string;                 // 完整 id
  readonly kind: 'local' | 'sandbox' | 'ssh' | 'client';
  readonly title: string;
  readonly description: string;        // 给模型看（简短）
  readonly capabilities: {
    background: boolean;
    sandbox: false;                    // DSH 权限沙箱语义；v1 host 均 false
    workdir: 'local' | 'remote';
  };
  resolve(request: HostExecRequest): HostExecSpec;   // 默认 cwd/timeout/输出上限
  run(spec: HostExecSpec, signal?: AbortSignal): Promise<ShellRunResult>;
  start?(spec: HostExecSpec): ShellProcess;          // background
  reset?(): Promise<void>;                           // sandbox 专用
  status?(): Promise<unknown>;
}
```

- router 校验 id 唯一、kind 合法、默认 host 存在；重复注册失败。
- 启动顺序：host provider 插件先加载，router 后加载或延迟解析；`bash` 工具调用时按 id 查找。
- 默认 host 由 profile 配置（`sandbox:default`）。

## 7.3 `bash` 工具

模型面向的工具（替代上游 `dsh-tool-bash`）：

```
bash(
  command: string,
  description: string,
  host?: string,              // 省略用 defaultHost
  workdir?: string,
  timeoutMs?: number,
  run_in_background?: boolean
)
```

- **无 `sandbox_permissions` / `justification`**（D34）：安全由 Auto review 承担；沙箱不是权限沙箱。
- 输出约定沿用 DSH：`[exit code: N]`、`[killed by signal: X]`、`[timed out after ...]`、spill/截断提示；使用 `dsh-shell` 的 `parseExitStatus` 等共享约定。
- 每次 call 新进程/新 shell；状态不跨调用（sandbox 的临时目录内容保留，但 shell cwd/env 不保留）。
- `run_in_background` 走 `ctx.jobs`：返回 job id，用 `job_output` / `job_kill` 管理；host 必须声明 `background: true`，否则报错。
- 未知 host：返回错误并列出可用 host（帮助模型纠正）。
- 错误渲染：host 执行失败、不可用、超出能力都作为普通工具结果错误返回，模型可自行处理。

### 工作目录语义

- `local:*`：`workdir` 相对 session workspace（`/var/lib/nokoribi-agent/workspace`）；绝对路径按主机路径解释。
- `sandbox:*`：默认 cwd 是该 session 的 sandbox 临时目录；`workdir` 相对 sandbox cwd，绝对路径按主机路径解释（sandbox 未挂载 workspace，但同用户路径可访问，见 7.6）。
- `ssh:*`（后置）：相对 host 配置的远程默认目录；绝对路径按远程解释。

## 7.4 `get_available_shell_host`

- 独立模型工具（D26）：无参数，返回启用 host 的简短列表：

```json
{
  "default": "sandbox:default",
  "hosts": [
    { "id": "sandbox:default", "kind": "sandbox", "description": "干净 Nix 环境与临时目录；与 workspace 隔离", "background": true, "workdir": "local" },
    { "id": "local:workspace", "kind": "local", "description": "主机环境，持久 workspace，可 sudo", "background": true, "workdir": "local" }
  ]
}
```

- 同时提供 service API（`ctx.shellHosts.list()`），便于其他插件/测试使用。
- 输出保持短小，避免每轮注入大段说明；工具描述由系统提示词的 hosts 段补充。

## 7.5 local host

- 运行位置：NixOS 主机，服务用户 `nokoribi`。
- 环境：系统 PATH + NixOS module 的 `extraPackages`（D77）；不额外套 Nix shell。
- cwd：`/var/lib/nokoribi-agent/workspace`（持久工作区）；可写整个 `DSH_HOME`（systemd `StateDirectory`）。
- 权限：部署开启 `sudo.enable` 后，用户拥有 `NOPASSWD: ALL`（D79/D81），命令可通过 `sudo` 获得 root；systemd 不做文件系统硬化（否则 sudo/local 无法工作）。
- 用途：持久化操作、主机管理、git、构建、跑服务、访问宿主路径（按 Unix 权限）。
- 注意：local host 不是"隔离环境"；它是真实主机环境。安全完全依赖 Auto review（见 08）。

## 7.6 sandbox host

### 定义（D35/D44/D49）

一个**干净、与 workspace 隔离的执行环境**：

- profile 固定 Nix 环境（`sandbox.packages` + `shellHook`，D52）；
- 每个 session 独立一个 sandbox 实例与临时目录（D92）；
- 不挂载 workspace、不作为 workspace 的视图；临时目录默认在 `$DSH_HOME/sandboxes/<sessionId>/`（落盘，D42）；
- 默认 host（D49）。

> **持久化语义**：sandbox 不保证持久化——它可能被空闲 TTL 回收、被手动 reset，或在未来清理策略下丢失（不保证一定重置，也不保证一定保留）。重要产物必须及时写回 workspace；模型不能把 sandbox 当成存储。当前 v1 只实现"空闲 TTL 自动回收 + 手动 reset"，没有额外清理任务。

### 文件与 workspace 边界

- sandbox **不完全隔离文件访问**：同用户、同主机，命令可以用绝对路径访问 `/var/lib/nokoribi-agent/workspace` 或其他可读路径（约定隔离，D48）。
- "workspace 不可见"的准确含义（D53）：不挂载、不作为 cwd、不提供同步/overlay；模型需要文件时用 shell 自己 `cp`/`rsync`。
- 暴露 managed env：
  - `DSH_SANDBOX_DIR`：当前 sandbox 临时目录；
  - `DSH_WORKSPACE_DIR`：持久工作区路径；
  - 其余 `DSH_*` 由 `dsh-shell-env` 提供。
- 没有 `copy_in` / `commit` 工具（D50）；模型通过 shell 命令搬运文件。
- 没有 commit 冲突强制检查（D54）；提示词要求模型在写回 workspace 前自行检查冲突/覆盖。

### 环境

- 由 NixOS 预构建的 `buildEnv` 提供基础 PATH；`shellHook` 在每条命令的 shell 中执行（类似 devShell 初始化）。
- **临时加包**：模型通过 `sandbox_packages` 工具 add/remove/list；状态保留到 reset/回收（D41）；实现上用运行时 `nix shell` 把这些包叠加到基础环境（Nix daemon 可用、需要网络/缓存）。
- 每条命令启动成本需在 M3 实测；必要时缓存环境或引入 sandbox 内持久 shell（当前不要求）。

### 提权

- sandbox 命令必须**禁止提权**（D86）：
  - 进程设置 `no_new_privs`；
  - PATH 中去掉 `sudo`/包装器；
  - 即使用户有 `NOPASSWD: ALL`，sandbox 内的命令也不能通过 sudo 获得 root。
- 代价：sandbox 内的 setuid 工具/部分特权操作不可用；需要在工具描述中说明。

### 生命周期与控制

- 首次使用时惰性创建；`sandbox` 工具：
  - `status`：generation、临时目录、已加包、创建/最近使用时间、TTL；
  - `reset`：销毁临时目录并重建，清空临时包；有后台任务时拒绝 reset。
- TTL：空闲 30 分钟（可配，D46）自动回收（回收 upper/临时目录、清空包、generation+1）；回收前若有后台任务则跳过并在下一轮检查。
- 进程重启：sandbox 目录落盘；TTL 按 lastUsed 恢复；重启后仍在 TTL 内则复用，否则回收。
- `/clear`、goal 归档：删除对应 session 的 sandbox 目录（见 05/10）。
- 磁盘占用：不额外做配额；依赖 TTL 与手动 reset。

### 工具面（D50）

- `sandbox` 单工具 + action：
  - `status`
  - `reset`
- `sandbox_packages` 单工具 + action：
  - `add <packages...>`
  - `remove <packages...>`
  - `list`
- 不提供 `copy_in` / `commit` action；文件搬运靠 `local` 或 sandbox 内的 `cp`/`rsync`。
- 工具描述要明确：
  - sandbox 与 workspace 是不同视图；
  - 用 `DSH_SANDBOX_DIR`/`DSH_WORKSPACE_DIR` 搬运；
  - 重要产物要及时写回 workspace（sandbox 可能被回收）；
  - sandbox 内不能 sudo。

### 安全定位

sandbox 是"干净/可重置环境"，**不是安全隔离边界**：同用户、同内核，命令可访问宿主可读路径；真正防止破坏的是 Auto review 与 no_new_privs（阻止提权）。强制隔离（bwrap/容器）未采用，未来可在同一 host 接口下加。

## 7.7 后台任务

- 支持 `run_in_background` 的 host：local、sandbox（SSH 后置）。
- sandbox 的后台任务在 sandbox 存活期内有效；reset/TTL 回收需拒绝或先终止（草案：拒绝 reset；TTL 回收跳过有活跃 job 的 sandbox，并在 status 中显示）。
- job 与 shell process 的映射由 `ctx.jobs` 管理；输出/取消遵循 DSH jobs 语义。
- daemon 重启后，未完成的进程不会存活（进程随 daemon 退出）；对应 job 标记失败；用户可重跑。

## 7.8 输出与错误约定

- 复用 DSH 的退出标记与 spill 约定，避免模型/渲染漂移。
- 模型可见内容：stdout、stderr、退出标记、超时/取消标记、sandbox 拒权提示（无 DSH 沙箱，故主要是 no_new_privs 失败）。
- 错误分类：host 不存在、host 不支持 background、sandbox 已回收并重建（提示 generation）、命令超时/取消。

## 7.9 SSH host（后置，v1 不实现）

设计草案：

- id：`ssh:<逻辑名>`；逻辑名到真实目标的映射由插件配置（主机白名单），模型不能传任意 ssh 目标（D27）。
- 执行：本地用系统 `ssh` 二进制 spawn（支持 `~/.ssh/config`、ssh-agent、ProxyJump、known_hosts、BatchMode），命令经 stdin/argv 安全传递；输出/退出/超时沿用约定。
- 环境：远程 PATH 由登录 shell/配置决定；不套本地 sandbox；`no_new_privs` 不适用于远程。
- 后台：持有本地 ssh 进程句柄；kill 先杀 ssh；远程进程可能残留（已知限制，未来可用 tmux/远端 kill 改进）。
- 权限：主机级 allowlist + 可选审批；不把远程当安全沙箱。
- 文件：read/write/edit 仍是本地；远程文件通过 ssh 命令操作（未来可考虑远程 fs，但不在 v1）。
- 实现时只新增 `shell-host-ssh` provider，不改 router、工具 schema 或提示词框架。

## 7.10 为什么不做复合 executor / 不改 DSH 契约

- 把多个 executor 塞进一个 `ctx.shell` provider 需要私有类型扩展或把 host 塞进 `workdir`，会污染 DSH seam。
- 我们的 `bash` 工具本来就是自研的，直接调用 `ctx.shellHosts` 更清晰；`ctx.shell` 保留为默认 host 的 façade，供其他 DSH 消费方（未来 hooks 等）使用。
- 这样本地执行器的沙箱/权限语义不会被"复合"破坏；我们也不再使用 DSH 的权限沙箱（Auto 下为 full access）。

## 7.11 已撤销/未采用的方案

- overlayfs（workspace lower + temp upper）与 commit/copy_in 工具：**撤销**（D44/D50）。
- `sandbox_permissions` 升权字段：**去掉**（D34）。
- DSH 原生 `/permission` 沙箱作为执行约束：**不使用**；Auto preset 下沙箱模式为 danger-full-access，权限判断在 reviewer。
- 多个 host 插件各自注册 `ctx.shell`：**不可行**（单 provider），改 router。
- 模型直接指定 SSH 目标：**不允许**；只选 host id。
