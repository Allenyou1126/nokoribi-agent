# 12 NixOS 部署

## 12.1 形态

- `nokoribi-agent` 仓库**内置 flake**：输出发行版 package 与 NixOS module。
- `nur-packages` 仓库通过 flake input 引用并转发（保持源码与 Nix 同仓，nur 只做聚合）。
- 用户的 NixOS flake 增加 input 并 import module；`agenix` 提供密钥；服务由 systemd 常驻。
- 部署目标：NixOS 主机，专用系统用户，`/var/lib/nokoribi-agent` 作为 `DSH_HOME`。

## 12.2 flake 结构（草案）

```
flake.nix
nix/
├─ package.nix          # 构建发行版
├─ module.nix           # services.nokoribi-agent
└─ overlay-config.nix   # 根据选项渲染 cordis patch overlay
templates/
├─ AGENTS.global.md
└─ AGENTS.workspace.md
SOUL.md
```

flake outputs（草案）：

- `packages.<system>.default` = `nokoribi-agent`
- `nixosModules.default` = `nix/module.nix`
- `checks.<system>.*`：单元/集成测试、package 构建、module eval（flake checks，D129）

## 12.3 Package 构建

- Node.js 24；pnpm 版本由 `packageManager` 固定；依赖用固定输出方式拉取（`pnpmDeps`/`fetchPnpmDeps` 或等价）。
- 步骤：安装依赖 → `pnpm build` → 生成 bundle/profile → 安装 store 布局。
- store 布局见 04.6。
- 生产依赖只包含选定 DSH 包与自研包；不安装 Web/UI 客户端栈。
- 启动器 wrapper 设置必要环境（Node、DSH_HOME 由 systemd 注入）。
- 任何 native addon（若有）需在 Nix 构建中显式处理；v1 计划不依赖 DSH 的 Landlock/PTY addon（verify）。

## 12.4 NixOS module 选项（草案终版）

```nix
services.nokoribi-agent = {
  enable = true;
  package = inputs.nokoribi-agent.packages.${system}.default;

  user = "nokoribi";
  group = "nokoribi";
  dshHome = "/var/lib/nokoribi-agent";
  workspace = "/var/lib/nokoribi-agent/workspace";

  environmentFile = config.age.secrets.nokoribi-agent-env.path;

  models = {
    main = { provider; model; reasoningEffort; };        # 需支持图像
    subagents = [
      { label = "secondary"; provider; model; reasoningEffort; }
    ];
  };

  review = {
    fast   = { provider; model; reasoningEffort; };
    strong = { provider; model; reasoningEffort; };
    timeoutMs = 30000;
  };

  approval = {
    approvalTimeoutSeconds = 60;
    questionTimeoutSeconds = 300;
  };

  hosts = {
    default = "sandbox:default";
    local = {
      enable = true;
      extraPackages = with pkgs; [ ... ];   # 追加到 local PATH
    };
    sandbox = {
      enable = true;
      packages = with pkgs; [ ... ];         # 预构建 buildEnv
      shellHook = "";
      idleTtlMinutes = 30;
      allowRuntimePackages = true;           # sandbox_packages 运行时 nix shell
    };
    ssh.enable = false;                      # M7
  };

  channel.localTest = {
    enable = false;
    bind = "127.0.0.1";
    port = 8787;
    token = "...";                           # 明文，仅验收期启用
  };

  memory = {
    enable = true;
    extraction = { enable = true; tier = "secondary"; };
  };

  goal = { defaultMaxRounds = 256; };

  schedule = { enable = true; };

  prompt = {
    soulFile = "${self.packages.${system}.default}/share/SOUL.md";
    seedAgentsMd = true;
  };

  sudo.enable = false;                       # 开启即 NOPASSWD: ALL
  log.level = "info";
};
```

说明：

- **纯 Nix 只读配置**（D118）：所有选项在 build 时渲染成 overlay patch；运行时没有 override 文件，改参数必须 `nixos-rebuild`。
- `sudo.enable` 默认 false（D120）；用户在主机配置里显式设 true。
- 测试 token 明文（D119），在 store 中本地所有用户可读；只建议验收期开启。
- 模型 ID 由用户填写；实现前用 API key 查目录确认图像支持（D16/D69）。
- `models.subagents` 是主 agent 可选的模型白名单；主 agent 自行选择。
- reviewer 两档只配 `review.fast`/`review.strong`（D85）。
- 没有 token 预算、没有 heartbeat、没有 web-debug 选项。

## 12.5 生成的运行时配置

module 根据选项生成 `overlay.cordis.patch.yml`（store 路径）：

- 覆盖 bundle 中行的 config（models/review/hosts/goal/schedule/prompt/channel/approval/memory/log）。
- 覆盖 DSH 行的 config（如 `agent-default-model`、`system-prompt`、`compaction-basic` 等按需要）。
- 启动器启动时按 bundle patch → overlay 顺序组合。
- 环境变量由 systemd 注入：
  - `DSH_HOME=/var/lib/nokoribi-agent`
  - `HOME=/var/lib/nokoribi-agent/home`
  - `DEEPSEEK_API_KEY`（来自 EnvironmentFile）
  - `NOKORIBI_PATCH=/nix/store/.../overlay.cordis.patch.yml`（或等价参数）
  - `NOKORIBI_TEST_TOKEN`（若测试通道启用；也可直接写 overlay）

## 12.6 systemd service

草案：

```ini
[Unit]
Description=Nokoribi Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify                      # sd_notify watchdog（D109）
User=nokoribi
Group=nokoribi
EnvironmentFile=/run/agenix/nokoribi-agent-env
Environment=DSH_HOME=/var/lib/nokoribi-agent
Environment=HOME=/var/lib/nokoribi-agent/home
StateDirectory=nokoribi-agent
StateDirectoryMode=0750
WorkingDirectory=/var/lib/nokoribi-agent
ExecStart=/nix/store/.../bin/nokoribi-agent --profile agent --patch ${overlay}
Restart=on-failure
RestartSec=5
WatchdogSec=120
TimeoutStopSec=45
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

# 不做文件系统硬化（sudo/local host 需要）
NoNewPrivileges=false
ProtectSystem=false
ProtectHome=false
PrivateTmp=false
```

- 专用用户/组由 module `users.users`/`users.groups` 创建（isSystemUser）。
- `StateDirectory` 创建 `/var/lib/nokoribi-agent` 并设 owner；`home`、`workspace`、`state` 等子目录由 app 首次启动创建。
- 日志进 journald；不做独立日志文件。
- watchdog：daemon 需实现 sd_notify（`READY=1`、定期 `WATCHDOG=1`）；超时 systemd 重启。Node 侧可用 `sd-notify` 类实现（实现时选型）。
- 不在 systemd 层限制网络（需要 Nix 下载/API/未来 IM）。
- 测试通道只绑 127.0.0.1，不开放防火墙端口。

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
├─ archive/goals.jsonl
├─ sandboxes/<sessionId>/
└─ run/agent.lock
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

- 升级：更新 flake input/包版本 → `nixos-rebuild switch` → systemd 重启服务 → 启动恢复。
- 不做升级前快照（D110）；DSH session format 可能迁移，回滚二进制后旧版本可能读不了新 format。
- 回滚：`nixos-rebuild --rollback` 只回系统配置/包，不回数据；需要自行承担 session 兼容风险。
- DSH 版本升级时同步更新 vendored reviewer，并跑全部测试。
- 不自动迁移/不自动备份。

## 12.12 部署验收清单（手工）

1. `nixos-rebuild switch` 成功，`systemctl status nokoribi-agent` active。
2. `journalctl -u nokoribi-agent` 有启动日志、单实例锁、主会话 resume/create。
3. 测试通道 `curl /v1/status` 返回 running/idle；`POST /v1/inbound` 发消息，`GET /v1/outbound` 收到回复。
4. 忙碌时发消息验证 steer（工具执行不中断）；`/stop`、`/status`、`/steer`、`/queue` 行为正确。
5. 审批：触发 Auto review deny，IM 收到 🔐 提示；回复允许后执行；回复拒绝后失败。
6. sandbox：默认 host 生效；workspace 不挂载；`cp` 搬运可用；TTL/reset/status；sandbox 内 sudo 失败。
7. local：系统工具可用；`sudo -n true` 成功（若开启）。
8. goal：`/goal new` 与自然语言各创建一个；报告、重启恢复、归档。
9. memory：`/remember` 类交互（自然语言）写入；跨会话 search。
10. schedule：创建提醒，到期后收到主动消息。
11. `systemctl restart nokoribi-agent`：恢复会话、inbox、goal、outbox。
12. `kill -9` 进程：systemd 拉起，恢复并通知；待应答失效提示。
13. watchdog：模拟卡死（实现期测试钩子）后被 systemd 重启。
14. 重启系统：服务自启、状态恢复。

> 没有 NixOS VM 测试（D130）；以上为手工验收。可在实现期加一个 `nix flake check` 的 module eval 检查作为静态门禁。
