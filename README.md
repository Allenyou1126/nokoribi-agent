# Nokoribi Agent

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下文简称 DSH）的单用户、常驻、长程个人 Agent 的设计文档。

> **状态（2026-10-29）**：M1（骨架与消息闭环）、M2（安全闸与审批）、M3（shell hosts 与 sandbox）、M4（goal 子代理）、M5（memory、schedule、提示词与 `/status full`）、M6（NixOS 部署闭环）、**M7（channel-core IM 基础设施扩展）**、**M8（真实 IM：QQ 官方 Bot）**、**M9（QQ C2C 审批按钮）** 与 **M10（host-aware 持久终端 + Web Search/Fetch）** 的代码已实现；M6 的 NixOS 目标机手工验收、M8 的 14 项平台事实门禁/17.8.2、M9 的交互门禁 #15–#20、M10 的 G5（DeepSeek Search/Fetch API 切换）与 systemd 12.14 目标机验收仍需执行并记录；M10 的 G2/G3/G4/G6 已于 2026-10-29 在 hkg-dog-darell 用户态通过。2026-10-27 已在 hkg-dog-darell（NixOS 26.05）做用户态临时部署冒烟：拉取/构建/daemon 启动/测试通道/真实模型对话通过，并发现、修复了 D148（官方 Node wrapper 与 DSH subprocess runner 的兼容缺陷，曾导致 `bash(host)` 全部失败）。**M7 提供被动回复上下文、多 driver 路由、`trustedChannels`、通知 defer 补投（D161）与动作按钮契约预留（D163）；M8 新增 `packages/channel-qq-bot`（官方 SDK `./protocol`、C2C/群 @、被动优先 + active 门禁、错误分类/频控、NixOS `channel.qqBot.*`）**；**M10 新增 `packages/terminal-host` 与 `ctx.web`（`terminal_*` 可选 `local:*`/`sandbox:*` 且进程内持久、sandbox terminal pin；Web 双 provider 默认 `deepseek-official` 搜索 + `http` 抓取，`web_search`/`web_fetch` 按 D170 豁免 Auto review）**，见 [17](.spec/17-qq-official-bot.md)、[14.9/14.11](.spec/14-roadmap.md) 与 [D164–D171](.spec/03-decision-log.md)。可在本地用测试通道或真实 QQ Bot 运行，已启用 Auto review、IM 审批/提问、`bash(host)`、disposable sandbox、goal 子代理、memory、定时提醒、`/status full` 与 NixOS module；但 M5 的 memory 只支持主动检索（**不自动注入**），M6/M8/M9/M10 真实验收未完成，**不可用作生产服务**。QQ 官方平台已于 2025-04-21 下线主动消息推送，提醒/通知按 D161 降级（active 尝试 + 失败 defer 到下次入站）；准入只依赖平台边界（D152）。
>
> **目标 DSH 版本**：全部 `@deepseek-ai/*` 包固定 `0.2.1-rc.3`，手动整批升级。Nix 包额外保留官方 Node 24.21.0 运行时（D145），以匹配 DSH 的 native addon。
>
> **M9/M10 代码完成（2026-10-29），真实门禁与目标机验收待执行**：**M9 = QQ 按钮审批**（仅 C2C、审批提示「允许一次/拒绝」、保留文本 fallback，见 [18](.spec/18-qq-button-approval.md)）；**M10 = host-aware 持久终端 + Web Search/Fetch**（复用 DSH `ctx.terminals`/`dsh-tool-terminal` 与 `ctx.web`；`terminal_*` 按 host id 选路、sandbox terminal pin，Web 默认 pin `deepseek-official`+`http` 并豁免两个 web 工具的 Auto review，见 [19](.spec/19-persistent-terminal-and-web.md)）。本地开关：`NOKORIBI_TERMINAL_*`（`ENABLED`/`BASH_PATH`/`MAX_RESULT_BYTES`/`SEND_TIMEOUT_MS`/`ROWS`/`COLS`/`SCROLLBACK_LINES`）、`NOKORIBI_WEB_*`（`ENABLED`/`SEARCH_PROVIDER`/`FETCH_PROVIDER`）与 `NOKORIBI_REVIEW_EXEMPT_TOOLS`；真实门禁记录见 [notes/m10-fact-gate.md](.spec/notes/m10-fact-gate.md)（G1/G7 自动化通过；G2/G3/G4/G6 目标机用户态通过；G5 与 systemd 12.14 待执行）。决策 [D165–D171](.spec/03-decision-log.md)，路线图 [14.10/14.11](.spec/14-roadmap.md)。

## 一句话概述

通过 IM（v1 先做抽象渠道 + 本地测试通道）与一个常驻主 Agent 沟通；新消息默认以 steer 语义在最近 step 边界注入、不打断当前轮；命令执行按 host 路由（`sandbox:*` / `local:*`，SSH 后置）；安全闸是打过补丁的 `experimental-auto-review` 双档 LLM 审查；部署形态为 NixOS + systemd。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01 背景与需求](.spec/01-background-and-requirements.md) | 项目背景、原始需求、环境上下文、v1 范围与非目标、设计原则 |
| [02 DSH 调研](.spec/02-dsh-findings.md) | DSH 组合机制、Agent Loop 原语、子代理/goal/审批/提示词/host 等机制事实，以及 OpenClaw 对照 |
| [03 决策记录](.spec/03-decision-log.md) | 全部讨论问题的选项与最终选择、按时间线的决策日志、默认采纳的提案 |
| [04 架构与构建](.spec/04-architecture-and-build.md) | 仓库结构、包划分、依赖方向、bundle 装配、薄启动器、构建链、版本策略 |
| [05 Daemon 与会话生命周期](.spec/05-daemon-and-session-lifecycle.md) | 启动/恢复/关闭/崩溃、状态文件、主会话、`/clear`、outbox、待应答失效 |
| [06 渠道与交互](.spec/06-channel-and-interaction.md) | ChannelDriver 契约、入站路由、注入语义、审批/提问、命令、出站投递、本地测试通道 HTTP |
| [07 Shell Hosts 与 Sandbox](.spec/07-shell-hosts-and-sandbox.md) | host router、`bash(host)`、`local`/`sandbox` 规格、TTL、`sandbox_packages`、SSH 后置设计 |
| [08 Auto-review 与安全模型](.spec/08-autoreview-and-security.md) | Auto 预设机制、双档 reviewer 补丁、子代理审批桥接、sudo/审计/备份决策、威胁与残余风险 |
| [09 提示词与记忆](.spec/09-prompt-and-memory.md) | SOUL.md、系统提示词分段、AGENTS.md、memory 条目规范与提炼流程、goal 汇报格式 |
| [10 Goal 与主动行为](.spec/10-goals-and-schedule.md) | goal 子代理创建/跟踪/恢复/归档、`/goal` 命令、schedule 提醒、无 heartbeat |
| [11 模型与成本](.spec/11-models-and-cost.md) | 主/子代理/记忆提炼模型分配、reviewer 双档、图像输入约束、压缩与成本策略 |
| [12 NixOS 部署](.spec/12-nixos-deployment.md) | flake、NixOS module 选项表、systemd、agenix、sudo、看门狗、状态目录、升级 |
| [13 测试与运维](.spec/13-testing-and-ops.md) | Vitest 策略、fake driver/LLM、进程级恢复测试、flake checks、日志、`/status`、运维手册 |
| [14 路线图](.spec/14-roadmap.md) | M1–M10 交付物、依赖、验收标准、实现记录、后置项 |
| [15 待验证项与风险](.spec/15-verification-and-risks.md) | 实现前必须验证的 9 项、M9/M10 门禁项、风险登记、实现期开放问题、已接受的残余风险 |
| [16 被取代/否决与术语](.spec/16-superseded-and-glossary.md) | 被撤销或被取代的决策及原因、被否决的方案、术语表 |
| [17 QQ 官方 Bot（M8）](.spec/17-qq-official-bot.md) | 真实 IM 适配器：规格、平台事实、消息策略、配置、安全、测试与验收（M7 core 扩展为其前置；M8 代码已实现；M9 按钮审批见 18） |
| [18 QQ 按钮审批（M9，代码完成）](.spec/18-qq-button-approval.md) | C2C 审批按钮：action 回调、ack、C2C-only、文本 fallback、测试与平台门禁 |
| [19 持久终端与 Web（M10，代码完成）](.spec/19-persistent-terminal-and-web.md) | host-aware 持久终端（复用 DSH 终端 + shell hosts）、Web Search/Fetch provider、review 豁免、配置与门禁 |

## 阅读顺序

1. 先读 [01 背景与需求](.spec/01-background-and-requirements.md) 了解目标与边界。
2. 读 [03 决策记录](.spec/03-decision-log.md) 是全部结论的权威来源；其中被推翻的条目在 [16](.spec/16-superseded-and-glossary.md) 有汇总。
3. 再按主题读 04–12 的规格文档。
4. 实施前读 [14 路线图](.spec/14-roadmap.md) 与 [15 待验证项与风险](.spec/15-verification-and-risks.md)。

## v1 范围速览

**做**：thin launcher + 精简 bundle、单主会话持久化、渠道抽象 + 本地测试通道、host router + sandbox/local、auto-review + 审批/提问、memory、schedule、多 goal 子代理、NixOS 部署。

**不做**：SSH host（后置未排期）、Web UI（含 web-debug）、heartbeat、多人/群聊权限、token 预算、NixOS VM 测试。真实 IM 已由 M8（QQ 官方 Bot）落地；M9 已实现 C2C 审批按钮（真实门禁待执行），图片链路、群聊按钮/提问按钮、群全量消息与多平台仍后置。

**M9（代码完成）**：QQ C2C 审批按钮（2 按钮、不补发确认消息、文本 fallback 保留）；**M10（代码完成，目标机用户态 G2/G3/G4/G6 通过；G5/12.14 待执行）**：host-aware 持久终端（`terminal_*` 可选择 `local:*`/`sandbox:*`，进程内持久；sandbox 终端固定实例目录并受 TTL/reset 保护）+ Web Search/Fetch（双 provider，默认 Messages 搜索 + 匿名 HTTP 抓取，web 工具豁免 Auto review，可配置空列表恢复全审）。见 [18](.spec/18-qq-button-approval.md)/[19](.spec/19-persistent-terminal-and-web.md)。

## 开发

工具链、代码规范与提交约定见 [AGENTS.md](AGENTS.md)。

```sh
pnpm install
pnpm check          # 构建 + 类型检查 + lint + 格式检查
pnpm test           # 单元 + 进程内集成
pnpm test:process   # 构建后运行进程级恢复场景
```

M1–M10 本地运行（需要测试通道 token；真实模型调用需要 `DEEPSEEK_API_KEY`；终端默认启用，sandbox 终端另需 Nix buildEnv；Web 默认启用但真实搜索/抓取需 API key + 网络）：

```sh
cp .env.example .env   # 填写 DEEPSEEK_API_KEY / NOKORIBI_TEST_TOKEN
pnpm build

# 无 Nix buildEnv 的开发环境：显式使用 local host
NOKORIBI_DEFAULT_HOST=local:workspace DSH_HOME=/tmp/nokoribi-dev \
  node packages/launcher/dist/index.js

curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"你好"}'
curl -s "http://127.0.0.1:8787/v1/outbound?after=0&timeout=10" \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN"
```

使用 sandbox 默认 host 时，需要提供 Nix buildEnv 路径：

```sh
BASE=$(nix build --no-link --print-out-paths --impure --expr \
  'let pkgs = import (builtins.getFlake "github:NixOS/nixpkgs/nixos-unstable") {}; in pkgs.buildEnv { name = "nokoribi-sandbox"; paths = [ pkgs.bash pkgs.coreutils ]; }')
NOKORIBI_DEFAULT_HOST=sandbox:default NOKORIBI_SANDBOX_BASE_ENV="$BASE" \
  DSH_HOME=/tmp/nokoribi-dev node packages/launcher/dist/index.js

# goal 子代理（同一 daemon 内；启动后用测试通道发送）
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"/goal new 检查仓库测试并修复失败 --rounds 5"}'
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"/goal list"}'

# memory、提醒与详细状态
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"记住：部署偏好用 agenix"}'
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"两分钟后提醒我检查构建"}'
curl -s -X POST http://127.0.0.1:8787/v1/inbound \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"/status full"}'
curl -s "http://127.0.0.1:8787/v1/status?full=1" \
  -H "Authorization: Bearer $NOKORIBI_TEST_TOKEN"
```

## NixOS 部署

M6 提供 `flake.nix`、`packages.<system>.default` 与 `nixosModules.default`。目标 NixOS 主机导入 module，密钥通过 agenix 的 `environmentFile` 注入；module 生成只读 Cordis overlay，不写运行时配置文件。

```nix
{
  inputs.nokoribi-agent.url = "github:<you>/nokoribi-agent";

  # NixOS 配置中：
  services.nokoribi-agent = {
    enable = true;
    environmentFile = config.age.secrets.nokoribi-agent-env.path;

    models.main = {
      provider = "deepseek-official";
      model = "deepseek-flash";
    };

    # 验收期开启；token 会以明文写入 Nix store（D119）。
    channel.localTest = {
      enable = true;
      token = "replace-with-acceptance-token";
    };

    hosts.sandbox.packages = with pkgs; [ git jq ];
    # sudo.enable = true;  # 高风险；默认 false（D120）
  };
}
```

agenix secret 内容至少包含：

```text
DEEPSEEK_API_KEY=sk-...
```

本地门禁（不需要 NixOS 主机）：

```sh
nix build .#default
nix run .#default -- --version
nix flake check
```

目标机部署：

```sh
sudo nixos-rebuild switch
systemctl status nokoribi-agent
journalctl -u nokoribi-agent -f
```

`/status full` 通过测试通道查看；systemd unit 使用 `Type=notify`、`WatchdogSec=120`，启动恢复完成前不会报告 ready。完整手工清单见 [12.12](.spec/12-nixos-deployment.md#1212-部署验收清单手工)。默认 `channel.localTest.enable = false`，此时服务没有用户消息入口；验收时请显式开启。

M6 的包保留官方 Node 24.21.0 二进制，由 wrapper 经 Nix glibc loader 启动；原因见 [D145](.spec/03-decision-log.md)。构建本身仍使用 nixpkgs Node/pnpm。

工具调用会先经过 reviewer。被拒绝时会收到 🔐 提示，回复"允许"或"拒绝"（也可用 1/2）；`ask_user_question` 会发 ❓ 提示。`/permission` 只报告 Auto 预设，v1 不支持切换。reviewer 默认复用主模型；可用 `NOKORIBI_REVIEW_FAST_MODEL` / `NOKORIBI_REVIEW_STRONG_MODEL` 分开配置。M10 已实现 `web_search`/`web_fetch` 按 D170 豁免审查（bundle/dev 默认 `NOKORIBI_REVIEW_EXEMPT_TOOLS=web_search,web_fetch`，Nix `review.exemptTools` 同；空列表/空串恢复全量审查），其余工具（含 `terminal_*`、`bash`）不变；M9 代码完成后 C2C 审批提示附带按钮（真实平台门禁待执行），文本回复始终可用。

M2 范围见 [14.3](.spec/14-roadmap.md)，M3 实现与已知限制见 [14.4](.spec/14-roadmap.md) 与 [07.12](.spec/07-shell-hosts-and-sandbox.md)，M4 见 [14.5](.spec/14-roadmap.md) 与 [10.12](.spec/10-goals-and-schedule.md)，M5 见 [14.6](.spec/14-roadmap.md)、[10.13](.spec/10-goals-and-schedule.md) 与 [09.5](.spec/09-prompt-and-memory.md)，M6 见 [14.7](.spec/14-roadmap.md) 与 [12](.spec/12-nixos-deployment.md)，M7 见 [14.8](.spec/14-roadmap.md)、[06](.spec/06-channel-and-interaction.md) 与 [D162/D163](.spec/03-decision-log.md)，M8 见 [14.9](.spec/14-roadmap.md)、[17](.spec/17-qq-official-bot.md) 与 [D164](.spec/03-decision-log.md)，M9 见 [14.10](.spec/14-roadmap.md)、[18](.spec/18-qq-button-approval.md) 与 [D165–D167](.spec/03-decision-log.md)，M10 实现见 [14.11](.spec/14-roadmap.md)、[19](.spec/19-persistent-terminal-and-web.md)、[D168–D171](.spec/03-decision-log.md) 与门禁记录 [notes/m10-fact-gate.md](.spec/notes/m10-fact-gate.md)。图片仍返回 501；`--dump-config` 继续后移。sandbox 是干净/可重置环境，**不是安全隔离边界**；sandbox 内不能 sudo，local 的 sudo 动作仍由 Auto review 审查。M5 的 memory 是主动检索，`/clear` 后不会自动注入旧记忆；定时提醒需要 daemon 常驻。M6 的 NixOS 目标机验收与 M8 的真实 Bot 14 项平台门禁/17.8.2 尚未在当前环境执行，不能把本地 `nix flake check` 当作生产验收。M9/M10 代码已完成，但其真实平台门禁（QQ 交互、NixOS PTY、sandbox 终端、真实搜索/抓取）需目标机与真实凭据；M10 只标“代码完成”，**不是验收通过，也不可用作生产服务**。

## 重要约定

- 本套文档中的"最终决策"以 [03 决策记录](.spec/03-decision-log.md) 与各专题文档为准；[16](.spec/16-superseded-and-glossary.md) 明确列出所有被撤销或被取代的决定。
- 文档中标注"提案/草案"的内容表示讨论中已形成但未逐条确认的技术方案，默认采纳；实施时若有变化需回写本套文档。
- 设计目标是"精简的 DSH 发行版 + 少量自研插件"，不是 fork DSH 内核。
