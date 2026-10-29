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
- **DSH subprocess runner 兼容（D148）**：wrapper 通过 `--require` 预加载 `nix/exec-path-preload.cjs`，并把 `NOKORIBI_NODE_SHIM` 指向包内 `bin/node-shim`（loader + 官方 Node）。`dsh-subprocess-local` 在 Linux 上用 `systemd-run --user --scope` 启动私有 runner，命令取自 `process.execPath`；若该值保持为 loader，runner.js 会被 loader 当作二进制执行并立即失败，所有 `bash(host)` 调用都会报 `subprocess scope exited before its bootstrap consumed the launch request`。修改 wrapper 时必须保留 `--require`、`NOKORIBI_NODE_SHIM` 和 `node-shim`；`nix flake check` 的 package-smoke 有对应断言。
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
    # M10（已实现）：Auto review 豁免的工具名；空列表=全量审查
    exemptTools = [ "web_search" "web_fetch" ];
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

  # M8 真实 IM（QQ 官方 Bot，规格见 17；实现口径见 D164）
  channel.qqBot = {
    enable = false;
    appId = "";                      # 非秘密，可进 store
    clientSecretEnv = "NOKORIBI_QQ_BOT_CLIENT_SECRET";  # 值走 EnvironmentFile/agenix
    markdown = "basic";              # none | basic | full
    maxTextLength = 4500;
    maxRepliesPerReply = 4;
    c2cReplyWindowSeconds = 3600;
    groupReplyWindowSeconds = 300;
    requestTimeoutSeconds = 10;
    connectTimeoutSeconds = 30;
    activeMessageFallback = "auto";  # auto | off
    # C2C 审批按钮（false 时纯文本审批，且不订阅 interaction intent）
    approvalButtons = true;
    reconnectBaseMs = 1000;
    reconnectMaxMs = 60000;
  };

  # M10（已实现）：host-aware 持久终端（复用 DSH ctx.terminals + dsh-tool-terminal）
  terminal = {
    enable = true;
    bashPath = "bash";               # NixOS 包装层 PATH 中的 bash，或绝对路径
    maxResultBytes = 262144;
    sendTimeoutSeconds = 30;
    rows = 40;
    cols = 160;
    scrollbackLines = 10000;
  };

  # M10（已实现）：Web Search/Fetch（默认 Messages 搜索 + 匿名 HTTP 抓取）
  web = {
    enable = true;
    searchProvider = "deepseek-official";  # deepseek-official | deepseek-search-api
    fetchProvider = "http";                # http | deepseek-fetch-api
    searchMaxResults = 8;
    searchMaxQueries = 4;
    searchTimeoutSeconds = 30;
    fetchTimeoutSeconds = 30;
    fetchMaxOutputChars = 200000;
    deepseekSearchBaseUrl = null;    # 非 null -> systemd DEEPSEEK_SEARCH_BASE_URL；null 不设置
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
- `channel.localTest.enable = false` 且 `channel.qqBot.enable = false` 时服务没有用户消息入口（headless）；验收必须显式开启至少一个渠道。
- `channel.qqBot.*` 是 M8 选项（见 [17](17-qq-official-bot.md) 17.6）：ClientSecret 只以环境变量名出现，值由 `environmentFile`/agenix 注入，不写入 store/overlay；启用时 module 给 channel-core 生成 `trustedChannels=["qq-bot"]` 与显式 `defaultChannelId`（localTest 启用时 `local-test`，否则空串回退首个 driver）。M8 不暴露 `sandbox`/`platformLimitsOnly`/driver 白名单；测试域名覆盖只放 bundle env（D164）。**M9 已实现**增加 `approvalButtons`（默认 true）：false 时按钮关闭且 driver 不订阅 `INTERACTION_CREATE` intent，文本审批照常；intent 不可用时 driver 自动降级并在 health detail 标记。
- `terminal.*`（M10 已实现）映射到 bundle 的 `terminal`/`tool-terminal`/`nokoribi-terminal-host` 行与上游 `BashTerminalBackend` 配置；`bashPath` 同时写入 `nokoribi-terminal-host.bashPath` 与 `nokoribi-shell-host-local.terminalBashPath`（NixOS 上建议用 buildEnv 内的 bash，`/bin/bash` 不存在）；`sendTimeoutSeconds` 渲染为 `terminal-host.sendTimeoutMs`，`maxResultBytes` 落在 `tool-terminal` 行；`sandbox` 终端受 `hosts.sandbox` 的 buildEnv/TTL 约束。`terminal.enable=false` 时 overlay 停用 `sandbox-policy`/`terminal`/`nokoribi-terminal-host`/`nokoribi-tool-terminal` 四行，`bash(host)` 与 shell host 行保持启用，`module-eval-disabled` 断言。
- `web.*`（M10 已实现）映射到 `web`/`web-search-deepseek`/`web-fetch-http`/`web-deepseek-api`/`tool-web` 行；复用 `DEEPSEEK_API_KEY`（provider `apiKeyEnv` 默认），不新增密钥；`searchProvider`/`fetchProvider` 显式 pin（多 provider 挂载时会歧义）；`deepseekSearchBaseUrl` 非 null 时注入 systemd `DEEPSEEK_SEARCH_BASE_URL`（仅 `deepseek-official` 搜索 provider；null 时不设置该 env）。**M10 没有 `web.deepseekApiBaseUrl` 选项**（`deepseek-search-api`/`deepseek-fetch-api` 使用上游默认基址）。`review.exemptTools` 控制 Auto review 豁免（默认 `web_search`/`web_fetch`；空列表恢复全量审查）。`web.enable=false` 时 overlay 停用上述 5 行。
- `channel.qqBot` 引入官方 `@tencent-connect/qqbot-nodejs` 依赖（D154）：lockfile 变化后必须更新 `nix/deps.nix` 的 `fetchPnpmDeps` 哈希，否则 `nix build` 失败；`package-smoke` 需断言运行时 `WebSocket`/`fetch` 全局存在。
- **M9/M10 依赖变化**（D171）：M9 不新增外部包；M10 新增 `dsh-web*`/`dsh-terminal*`/`dsh-sandbox-policy`/`dsh-tool-web` 等 `0.2.1-rc.3` 包，lock 与 `nix/deps.nix` FOD 哈希已随实现更新（本次 `deps.nix` hash 已变）；`dsh-terminal-bash` 只作为类导入，不加载为独立行。
- M8 不实现 driver 级 `allowedUsers/allowedGroups`（D152）；`platformLimitsOnly` 这个假选项已从 module 移除。
- memory/schedule 行始终挂载；`memory.curator.enable` 只关闭 goal 终态提炼。`schedule.enable`、`models.subagents`、`hosts.ssh.enable` 不是 M6 选项（D146）。
- `time.zone = null` 时使用系统时区；非 null 时同时写 time-context overlay 与 systemd `TZ`。
- 没有 token 预算、没有 heartbeat、没有 web-debug 选项。

## 12.5 生成的运行时配置

module 根据选项生成完整的 `cordis.patch.yml`（store 路径）：

- 覆盖 bundle 中 `nokoribi-agent-app`、`nokoribi-reviewer`、`nokoribi-channel-core`、`nokoribi-channel-local-test`、`nokoribi-channel-qq-bot`（M8）、`nokoribi-prompt`、`nokoribi-shell-*`、`nokoribi-memory`、`nokoribi-terminal-host`（M10）与（时区非 null 时）`time-context` 的完整 config；M10 另覆盖 `web`/`tool-web` 与（停用时）`web-*`/`terminal`/`tool-terminal`/`sandbox-policy` 行。
- channel-core 行由 overlay 生成：`trustedChannels = lib.optional qqBot.enable "qq-bot"`；`defaultChannelId` 在 localTest 启用时为 `local-test`，否则空串（回退首个 driver）。
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
  - `NOKORIBI_QQ_BOT_CLIENT_SECRET`（M8；来自 EnvironmentFile/agenix；overlay 只出现变量名）
- 测试通道 token 写在 overlay 的 row config，不通过环境变量；明文进 store（D119）。QQ appId 写在 overlay row config（非秘密）；QQ ClientSecret 不进 store/overlay。

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

## 12.13 M8 真实 IM（QQ 官方 Bot）验收

部署前置：

- QQ 开放平台已创建个人主体机器人，已配置开发体验用户（本人 QQ），已把机器人加入自己的群。M8 代码与 `nix flake check` 已完成（2026-10-27）；14 项平台事实门禁尚未执行，见 `.spec/notes/qq-fact-gate.md`。
- NixOS module 中 `channel.qqBot.enable = true`、`channel.qqBot.appId = "<APPID>"`；`environmentFile`（agenix）包含 `NOKORIBI_QQ_BOT_CLIENT_SECRET`；`channel.localTest` 可按需保留用于验收注入。
- SDK 依赖加入后已更新 `nix/deps.nix` 哈希，`nix flake check` 通过。

验收：按 [17](17-qq-official-bot.md) 17.8.2 的 10 项执行（私聊/群 @、命令、审批、被动窗口、**主动消息可用性实测**、重启恢复、token 刷新、断网重连、目标机部署）。结果记录到 `.spec/14` 的 M8 记录与 README 状态。

> 主动推送能力官方已于 2025-04-21 下线；若是实测确认不可用，提醒/系统通知的降级行为按 D161 的记录验收（不得宣称“提醒可主动送达”）。

## 12.14 M9/M10 验收（代码完成，真实验收待执行）

> 状态：**M9/M10 代码完成（2026-10-29），真实平台/目标机验收待执行**；验收细节见 [18.6](18-qq-button-approval.md)/[19.5](19-persistent-terminal-and-web.md)；M10 门禁记录见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)。M10 的 G1/G7 已由本地自动化通过，其余 G2–G6 与下列目标机清单未执行。
>
> 当前开发机为 Arch Linux，不能执行本节的 NixOS 目标机部分；结果需在目标 NixOS 主机执行并回写 [14.11](14-roadmap.md) 的 M10 记录与本文件。

### M9（QQ 按钮审批）

- 目标机前置同 12.13（真实 QQ Bot + 开发体验用户）；`channel.qqBot.approvalButtons = true`。
- 手工：C2C 触发 Auto review deny → 收到带「允许一次/拒绝」按钮的审批消息；点击允许执行、拒绝失败；文本回复仍可用；超时/重启后旧按钮点击给出失效提示；群聊仍为文本审批。
- 平台事实门禁：notes `qq-fact-gate.md` #15–#20（INTERACTION intent、keyboard 渲染、事件字段、ack、button 限制、群聊关闭）。
- 通过前只能标“代码完成”。

### M10（持久终端 + Web）

- 终端（目标机）：`terminal.enable = true`；在 `local:workspace` 打开终端 → `cd`/导出变量跨调用保留 → 关闭后进程树清理；在 `sandbox:default` 打开终端 → 运行 `pwd`/`bash --version` 验证 buildEnv PATH，sudo 失败；`sandbox reset` 在终端打开时被拒绝；`/clear`、goal 归档、`systemctl restart` 后无残留终端进程。
- 终端（本地，已自动化）：真实 PTY 由 `pnpm test:process` 的 `tests/process/m10-terminal.test.ts` 覆盖（4 场景：状态持久、`/clear`、disabled、SIGTERM；本次施工观察通过，无需 NixOS）。
- Web（本地，已自动化）：`tests/process/m10-web.test.ts` 用 fake DeepSeek 搜索 HTTP + fake LLM 覆盖 web 工具不触发 reviewer、`bash` 仍审查、非公网 fetch blocked、空豁免列表恢复全审（本次施工观察通过）；真实搜索/API 见下方门禁。
- Web（目标机/真实凭据）：设置 `DEEPSEEK_API_KEY` 后 `web_search`/`web_fetch` 各成功一次；`web_fetch` 对非公网 URL 返回 blocked；切换 `searchProvider = "deepseek-search-api"`/`fetchProvider = "deepseek-fetch-api"` 前先确认 Search/Fetch API 可用性（G5）；`/status full` 只显示 reviewer 两档，不显示 `exemptTools`，豁免行为以 fake/reviewer 测试与配置审计为准。
- 网络出口：目标机可直连 `api.deepseek.com`（以及搜索 API 基址）；无代理时按环境变量代理策略处理。
- 门禁对照：G2（目标机 local PTY）、G3（sandbox 终端）、G4（真实搜索）、G5（API provider）、G6（真实公网抓取）见 [notes/m10-fact-gate.md](notes/m10-fact-gate.md)；通过前 12.14 只算“代码完成”。

## 12.15 规划中的选项（M16/M17，未实现）

> 状态：**规划口径（D174/D175），代码未实现**；启动对应里程碑时再补实现与 module-eval 断言。里程碑总览见 [14.15](14-roadmap.md)。

- **M16 `memory.inject.*`**（本地记忆自动注入）：`enable`（默认 `true`）、`maxChars`（默认 3000）、`maxEntries`（默认 20）、`mainOnly`（默认 `true`）、`autoTags`（默认 `["type:person","type:preference"]`）；overlay 接到 `nokoribi-memory` 行，bundle 侧用 `NOKORIBI_MEMORY_INJECT_*` 默认值。
- **M17 记忆后端开关**：`memory.openviking.enable`（默认 `false`）。启用后 OpenViking 接管，`nokoribi-memory` 行 disabled、`nokoribi-prompt` 不注册 memory 提示词段。
- **M17 OpenViking 连接配置（仅连接，不打包 server）**：其他跟 OpenViking 连接相关的配置全部放在 `memory.openviking.*`，包括 `endpoint`、`apiKeyEnv`（指向 EnvironmentFile/agenix 变量，不写入 store）、可选 `peerId`/`workspacePeer`/`recallMaxTokens` 等。
- **M17 前置**：`@openviking/dsh-memory-plugin`（Apache-2.0，pin 版本）作为额外 profile bundle；peer 依赖 `dsh-mcp-client`（M13）与 `dsh-skill-filesystem`（M12），`dsh-skill` 服务需由 M12 挂载。
- **不做**：不在 NixOS module 中提供 openviking-server 的 package/systemd unit/模型服务；server 由用户外部部署，本仓库只读取连接配置。
