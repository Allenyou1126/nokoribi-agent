# Nokoribi Agent

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下文简称 DSH）的单用户、常驻、长程个人 Agent 的设计文档。

> **状态（2026-10-25）**：前期规划完成，尚未开始实现。本仓库当前只有设计文档，没有代码。
>
> **目标 DSH 版本**：全部 `@deepseek-ai/*` 包固定 `0.2.1-rc.3`，手动整批升级。

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
| [14 路线图](.spec/14-roadmap.md) | M1–M6 交付物、依赖、验收标准、后置项 |
| [15 待验证项与风险](.spec/15-verification-and-risks.md) | 实现前必须验证的 9 项、风险登记、实现期开放问题、已接受的残余风险 |
| [16 被取代/否决与术语](.spec/16-superseded-and-glossary.md) | 被撤销或被取代的决策及原因、被否决的方案、术语表 |

## 阅读顺序

1. 先读 [01 背景与需求](.spec/01-background-and-requirements.md) 了解目标与边界。
2. 读 [03 决策记录](.spec/03-decision-log.md) 是全部结论的权威来源；其中被推翻的条目在 [16](.spec/16-superseded-and-glossary.md) 有汇总。
3. 再按主题读 04–12 的规格文档。
4. 实施前读 [14 路线图](.spec/14-roadmap.md) 与 [15 待验证项与风险](.spec/15-verification-and-risks.md)。

## v1 范围速览

**做**：thin launcher + 精简 bundle、单主会话持久化、渠道抽象 + 本地测试通道、host router + sandbox/local、auto-review + 审批/提问、memory、schedule、多 goal 子代理、NixOS 部署。

**不做**：真实 IM 适配器、SSH host（后置）、Web UI（含 web-debug）、heartbeat、多人/群聊权限、token 预算、NixOS VM 测试。

## 重要约定

- 本套文档中的"最终决策"以 [03 决策记录](.spec/03-decision-log.md) 与各专题文档为准；[16](.spec/16-superseded-and-glossary.md) 明确列出所有被撤销或被取代的决定。
- 文档中标注"提案/草案"的内容表示讨论中已形成但未逐条确认的技术方案，默认采纳；实施时若有变化需回写本套文档。
- 设计目标是"精简的 DSH 发行版 + 少量自研插件"，不是 fork DSH 内核。
