# 12 NixOS 部署

## 12.1 形态

- `nokoribi-agent` 仓库**内置 flake**：输出发行版 package 与 NixOS module。
- `nur-packages` 仓库通过 flake input 引用并转发（保持源码与 Nix 同仓，nur 只做聚合）。
- 用户的 NixOS flake 增加 input 并 import module；`agenix` 提供密钥；服务由 systemd 常驻。
- 部署目标：NixOS 主机，专用系统用户，`/var/lib/nokoribi-agent` 作为 `DSH_HOME`。

## 12.2 flake 结构

```
flake.nix
flake.lock
nix/
├─ package.nix          # 构建发行版（官方 Node 运行时 + 生产依赖）
├─ module.nix           # services.nokoribi-agent
├─ overlay.nix          # 根据选项渲染完整 Cordis patch
├─ source.nix           # 源过滤与版本
├─ deps.nix             # fetchPnpmDeps 固定哈希
├─ tests.nix            # flake unit check
└─ check-module.py      # module-eval / overlay 断言
templates/
├─ AGENTS.global.md
└─ AGENTS.workspace.md
SOUL.md
```

flake outputs：

- `packages.<system>.default` / `.nokoribi-agent` = `nokoribi-agent`
- `overlays.default`
- `nixosModules.default`
- `checks.<system>.{package,package-smoke,unit,module-eval}`

`nix flake check` 只检查当前系统；不支持的系统会提示 omitted（当前支持 x86_64-linux/aarch64-linux）。

## 12.3 Package 构建

- Node.js 24；pnpm 版本由 `packageManager` 固定（开发 12.4.1）。
- `nix/package.nix` 使用 `fetchPnpmDeps`（`fetcherVersion = 4`、nixpkgs `pnpm_12`）拉取固定依赖，构建阶段用 nixpkgs Node 24 + pnpm 执行 `pnpm build`。
- 构建后删除 node_modules，重新执行 `pnpm install --prod --offline --frozen-lockfile --trust-lockfile --ignore-scripts`，只保留生产依赖；`vitest`/`oxlint`/mock server 不进入发行版。
- **运行时 Node 使用官方 24.21.0 二进制**（x86_64/aarch64），不是 nixpkgs Node。原因：DSH `node-addon-require-builtin` 对 Node 二进制代码布局有要求，nixpkgs 构建的 Node 与 patchelf 改写后的官方二进制都不能通过其检查（D145）。
- 官方 Node 保留原始二进制；启动 wrapper 用 Nix glibc loader + `lib.makeLibraryPath`（libstdc++/libgcc/glibc）执行它，避免 patchelf 改写导致 segfault，同时不依赖 NixOS 的 `/lib64`。
- 原生 addon 用 `autoPatchelfHook`；`koffi` 的 musl 预编译文件不用于 NixOS，显式忽略其 musl interpreter 依赖。
- wrapper 设置 `NODE_ENV=production`，不包含 pnpm/构建工具。
- store 布局见 04.6；`packages/*/dist`、`SOUL.md`、`templates/`、`vendor/profile-boot/` 与 `node_modules/` 都在发行版内，状态只写 `DSH_HOME`。
- 任何 native addon（若有）需在 Nix 构建中显式处理；v1 计划不依赖 DSH 的 Landlock/PTY addon（verify）。

## 12.4 NixOS module 选项（M6 实际）

```nix
services.nokoribi-agent = {
  enable = false;
  package = inputs.nokoribi-agent.packages.${system}.default;
  user = "nokoribi";
  group = "nokoribi";
  dshHome = "/var/lib/nokoribi-agent";
  workspace = null;                  # 默认 ${dshHome}/workspace
  environmentFile = null;            # agenix；enable 时必填

  models.main = {
    provider = "deepseek-official";
    model = "deepseek-flash";
    reasoningEffort = "";
  };

  review = {
    fast = { provider = null; model = null; reasoningEffort = ""; };
    strong = { provider = null; model = null; reasoningEffort = ""; };
    timeoutMs = 30000;
  };

  goal = {
    provider = null;                 # 默认 main
    model = null;
    reasoningEffort = "";
    allowedModels = [];              # "provider/model" 精确列表
    maxRounds = 256;                 # 省略 max_goal_rounds 时的上限
    recoveryTimeoutMs = 30000;
  };

  memory = {
    provider = null;                 # 默认 goal
    model = null;
    reasoningEffort = "";
    curator = {
      enable = true;
      timeoutMs = 60000;
    };
  };

  approval = {
    approvalTimeoutSeconds = 60;
    questionTimeoutSeconds = 300;
  };

  hosts = {
    default = "sandbox:default";     # 或 "local:workspace"
    local = {
      enable = true;
      extraPackages = [];            # 目录加入 local PATH
    };
    sandbox = {
      enable = true;
      packages = [];                 # baseEnv 始终加入 bash/coreutils
      shellHook = "";
      idleTtlMinutes = 30;
      allowRuntimePackages = true;
    };
  };

  channel.localTest = {
    enable = false;                  # 验收期显式开启
    bind = "127.0.0.1";
    port = 8787;
    token = "";                      # 明文进 store（D119）
  };

  prompt = {
    soulFile = null;                 # 默认 ${package}/share/SOUL.md
    templatesDir = null;             # 默认 ${package}/share/templates
    seedAgentsMd = true;
  };

  time = {
    zone = null;                     # null 用系统时区
    contextRefreshSeconds = 60;
  };

  log.level = "info";
  sudo.enable = false;               # true -> NOPASSWD: ALL
  watchdog.intervalSeconds = 120;

  shutdown = {
    graceSeconds = 20;
    stopTimeoutSeconds = 45;
    startTimeoutSeconds = 300;       # cold goal 恢复上限
  };
};
```

说明：

- **纯 Nix 只读配置**（D118）：module 将选项渲染为完整 `cordis.patch.yml`，由 `NOKORIBI_PATCH` 叠加在 bundle 之后；没有运行时 override 文件。改参数必须 `nixos-rebuild switch`。
- `sudo.enable` 默认 false（D120）；开启时写 `NOPASSWD: ALL`，唯一闸是 Auto review。
- 测试 token 明文（D119），store 中本地用户可读；只建议验收期开启。
- `models.main` 由用户填写；图片仍 501，不要求当前模型支持图片（V8）。
- `review.fast`/`strong` 为 null 时分别回退 main/fast；`goal` 回退 main；`memory` 回退 goal。
- `goal.allowedModels` 是精确 `provider/model` allowlist；默认 goal 路由始终允许（D141）。
- `goal.maxRounds` 映射到 daemon 的 `goalDefaultMaxRounds`，`start_goal`/`/goal new` 省略轮次时使用。
- `hosts.local.extraPackages` 是包列表，module 映射为 `extraPackages = ["${pkg}/bin", ...]`；`hosts.sandbox.packages` 列表会加入 buildEnv。
- `hosts.sandbox` 自动生成 `buildEnv`（bash/coreutils + 用户包），并注入 `setpriv`、`nix` 绝对路径；运行时包仍可用 `sandbox_packages add nixpkgs#hello`。
- `hosts.local.enable`/`sandbox.enable` 会真正跳过 host 注册；默认 host 必须启用，否则 eval 断言失败。
- `channel.localTest.enable = false` 时服务没有用户消息入口（headless）；验收必须显式开启。
- memory/schedule 行始终挂载；`memory.curator.enable` 只关闭 goal 终态提炼。`schedule.enable`、`models.subagents`、`hosts.ssh.enable` 不是 M6 选项（D146）。
- `time.zone = null` 时使用系统时区；非 null 时同时写 time-context overlay 与 systemd `TZ`。
- 没有 token 预算、没有 heartbeat、没有 web-debug 选项。

## 12.5 生成的运行时配置

module 根据选项生成完整的 `cordis.patch.yml`（store 路径）：

- 覆盖 bundle 中 `nokoribi-agent-app`、`nokoribi-reviewer`、`nokoribi-channel-core`、`nokoribi-channel-local-test`、`nokoribi-prompt`、`nokoribi-shell-*`、`nokoribi-memory` 与（时区非 null 时）`time-context` 的完整 config。
- Cordis patch 是行 config 的替换而非深合并，因此 overlay 生成器必须写全该行字段。
- 启动器启动时按 bundle patch → `NOKORIBI_PATCH` overlay 组合；没有运行时 override 文件。
- 环境变量由 systemd 注入：
  - `DSH_HOME=/var/lib/nokoribi-agent`
  - `HOME=/var/lib/nokoribi-agent/home`
  - `PATH=<bash/coreutils/util-linux/nix/systemd>:/run/wrappers/bin:/run/current-system/sw/bin`
  - `NOKORIBI_PATCH=/nix/store/.../cordis.patch.yml`
  - `NOKORIBI_SYSTEMD_NOTIFY=/nix/store/.../systemd-notify`
  - `NOKORIBI_READY_TIMEOUT_MS=0`（systemd 拥有启动上限）
  - `NOKORIBI_LOG_LEVEL=...`
  - `DEEPSEEK_API_KEY`（来自 EnvironmentFile）
- 测试通道 token 写在 overlay 的 row config，不通过环境变量；明文进 store（D119）。

## 12.6 systemd service

实际 unit 关键字段：

```ini
[Unit]
Description=Nokoribi Agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
User=nokoribi
Group=nokoribi
EnvironmentFile=/run/agenix/nokoribi-agent-env
Environment=DSH_HOME=/var/lib/nokoribi-agent
Environment=HOME=/var/lib/nokoribi-agent/home
Environment=NOKORIBI_PATCH=/nix/store/.../cordis.patch.yml
Environment=NOKORIBI_SYSTEMD_NOTIFY=/nix/store/.../systemd-notify
Environment=NOKORIBI_READY_TIMEOUT_MS=0
StateDirectory=nokoribi-agent
StateDirectoryMode=0750
WorkingDirectory=/var/lib/nokoribi-agent
UMask=0077
ExecStart=/nix/store/.../bin/nokoribi-agent
Restart=on-failure
RestartSec=5
WatchdogSec=120
TimeoutStartSec=300
TimeoutStopSec=45
KillMode=mixed
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nokoribi-agent

# 不做文件系统硬化（sudo/local host 需要）
NoNewPrivileges=false
ProtectSystem=false
ProtectHome=false
PrivateTmp=false
```

- 专用用户/组由 module `users.users`/`users.groups` 创建（isSystemUser）；默认 `dshHome` 用 `StateDirectory`，自定义路径用 `systemd.tmpfiles.rules` 创建。
- `home`、`workspace`、`state` 等子目录由 app 首次启动创建（`ensureHomeDirs` 已包含 `home`）。
- 日志进 journald；不做独立日志文件。
- **READY 时序**：daemon 完成主会话恢复、goal 恢复、outbox 重发、缓冲入站放行与 ready 文件写入后，才通过 `systemd-notify --ready` 报告 ready；失败则删除 ready 文件并以 startup-error 退出。
- **watchdog**：`SystemdNotifier` 读取 `WATCHDOG_USEC`，约为其 1/3 周期发送 `WATCHDOG=1`；事件循环卡死时不发送，systemd 超时重启。它通过子进程 `systemd-notify` 实现，因此 unit 必须 `NotifyAccess=all`；`NOTIFY_SOCKET` 缺失时 no-op（开发/测试）。
- 优雅关闭时先发送 `STOPPING=1`，停止 watchdog，再执行现有关闭流程；`TimeoutStopSec=45` 大于 app grace 20s + profile-boot 30s。
- `KillMode=mixed`：主进程收到 SIGTERM，残留子进程在超时后由 systemd 清理。
- 不在 systemd 层限制网络（需要 Nix 下载/API/未来 IM）。
- 测试通道只绑 127.0.0.1，不开放防火墙端口。
- `NOKORIBI_READY_TIMEOUT_MS=0` 避免 launcher 在 cold goal 恢复较慢时先退出；`TimeoutStartSec=300` 是唯一启动上限。

## 12.7 sudo

`sudo.enable = true` 时 module 写入：

```nix
security.sudo.extraRules = [{
  users = [ "nokoribi" ];
  commands = [{ command = "ALL"; options = [ "NOPASSWD" ]; }];
}];
```

- 这等价于 `nokoribi ALL=(ALL) NOPASSWD: ALL`（D81）。
- 因为 sudo 需要 setuid，systemd 必须保持 `NoNewPrivileges=false`。
- 审计：sudo 命令/结果进 journald；不开启 `log_output`（D104）。
- sandbox 内命令设置 `no_new_privs` 并从 PATH 移除 sudo，因此不能提权（D86）。

## 12.8 密钥（agenix）

- 用户现有 `nixos-secret` 仓库使用 agenix（`.age` 文件）；新增一个 secrets 文件，例如 `nokoribi-agent-env.age`，内容：

```
DEEPSEEK_API_KEY=sk-...
```

- NixOS 配置：

```nix
age.secrets.nokoribi-agent-env = {
  file = "${inputs.allenyou-secrets}/nokoribi-agent-env.age";
  owner = "nokoribi";
  mode = "0400";
};
```

- module 的 `environmentFile` 指向 `config.age.secrets.nokoribi-agent-env.path`。
- 注意：agent 有 root，可读该文件；这是已接受的风险。子进程环境会被 DSH 的 subprocess 凭据 scrub 清理（bash 命令默认看不到 `DEEPSEEK_API_KEY`），但 root 仍可主动读取。
- 测试 token 不放 agenix（D119 明文 Nix option），只用于验收。

## 12.9 状态目录

```
/var/lib/nokoribi-agent/
├─ home/                 # nix/vendor 缓存、HOME
├─ sessions/             # DSH 会话 JSONL
├─ state/
│  ├─ agent-state.json
│  └─ ingress-seen.json
├─ memory/
│  ├─ entries/
│  └─ archive/
├─ storage/
│  └─ schedule.json       # dsh-schedule 的 JSON backend
├─ archive/goals.jsonl
├─ sandboxes/<sessionId>/
└─ run/
   ├─ agent.lock
   ├─ ready.json          # dev/进程测试握手；NixOS 也写
   ├─ startup-error.json  # 启动失败时
   └─ test-channel.json   # 测试通道启用时
```

- workspace 默认 `/var/lib/nokoribi-agent/workspace`（可配置）。
- 不做备份（D105）。
- 升级前不做快照（D110）；回滚 NixOS generation 不保证 session format 兼容。
- 磁盘增长：会话不可删除，归档只隐藏；需要人工清理。

## 12.10 SOUL.md 与模板

- `SOUL.md` 源码仓库 → package `share/SOUL.md` → 启动时读取（D115/D116）。
- `templates/AGENTS.global.md`、`templates/AGENTS.workspace.md` 由 app 首次启动 seed 到 `$DSH_HOME/AGENTS.md` 与 `$workspace/AGENTS.md`（D114）；存在不覆盖。
- 修改 SOUL/AGENTS 模板需要重新构建/部署（AGENTS 已存在时不会被覆盖）。

## 12.11 升级与回滚

- 升级：更新 flake input/包版本 → 更新 `pnpmDeps.hash`（lockfile 变化时）→ `nix flake check` → `nixos-rebuild switch` → systemd 重启服务 → 启动恢复。
- 官方 Node 版本固定在 `nix/package.nix`（24.21.0）；升级 Node 时同时更新 x86_64/aarch64 tarball hash，并复测 DSH native addon。
- DSH 版本升级时整批更新 `@deepseek-ai/*`、同步 vendored reviewer 与 VERSION/PATCHES，并跑全部测试。
- 不做升级前快照（D110）；DSH session format 可能迁移，回滚二进制后旧版本可能读不了新 format。
- 回滚：`nixos-rebuild --rollback` 只回系统配置/包，不回数据；需要自行承担 session 兼容风险。
- 不自动迁移/不自动备份。
- M6 当前没有更新的 DSH 版本可 bump；升级演练只做同版本重构建、重启恢复与回滚路径检查。真正的 DSH bump 留待后续升级提交（D147）。

## 12.12 部署验收清单（手工）

1. `nixos-rebuild switch` 成功，`systemctl status nokoribi-agent` 为 active，并显示 notify ready。
2. `journalctl -u nokoribi-agent` 有启动日志、单实例锁、主会话 resume/create；检查 `/var/lib/nokoribi-agent` 与 `home` 权限。
3. 测试通道（`channel.localTest.enable = true`）`curl /v1/status` 返回 running/idle；`POST /v1/inbound` 发消息，`GET /v1/outbound` 收到回复。
4. 忙碌时发消息验证 steer（工具执行不中断）；`/stop`、`/status`、`/steer`、`/queue` 行为正确。
5. 审批：触发 Auto review deny，IM 收到 🔐 提示；回复允许后执行；回复拒绝后失败。
6. sandbox：默认 host 生效；workspace 与 sandbox 文件边界符合规格；`cp` 搬运可用；TTL/reset/status；`sandbox_packages add nixpkgs#hello`；sandbox 内 sudo 失败。
7. local：系统工具可用；`sudo -n true` 成功（仅 `sudo.enable = true`）。
8. goal：`/goal new` 与自然语言各创建一个；报告、重启恢复、归档。
9. memory：自然语言写入；跨会话 search；确认不会自动注入（D143）。
10. schedule：创建提醒，到期后收到主动消息；SIGKILL 后逾期重启仍交付；`/clear` 删除旧会话任务。
11. `/status full` 与 `GET /v1/status?full=1` 返回 goals/sandbox、schedule、memory、reviewer、recent errors。
12. `systemctl restart nokoribi-agent`：恢复会话、inbox、goal、outbox。
13. `kill -9` 主进程：systemd 拉起，恢复并通知；待应答失效提示。
14. watchdog：对主 PID 执行 `kill -STOP`，等待超过 `WatchdogSec`，确认 systemd 杀死并重启；检查 journald。不要使用应用内测试钩子。
15. 重启系统：服务自启、状态恢复。
16. 升级演练：更新 flake input（或同版本重构建），跑 `nix flake check`，`nixos-rebuild switch`，检查恢复与回滚风险；记录未执行真实 DSH bump 的原因。

> 没有 NixOS VM 测试（D130）；以上为手工验收。`nix flake check` 只覆盖 package/unit/module eval 静态门禁，不能替代本清单。当前开发机为 Arch，无法执行本清单；结果需在目标 NixOS 主机记录到 `.spec/14` 的 M6 记录。
