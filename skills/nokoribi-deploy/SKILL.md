---
name: nokoribi-deploy
description: NixOS 部署、升级或回滚 Nokoribi Agent 后的构建门禁与目标机验证清单。
whenToUse: 当用户要求部署、升级、回滚或验证 Nokoribi Agent 的 NixOS 服务时使用。
---

# nokoribi-deploy

用于 NixOS 目标机上的部署闭环。命令都在仓库根目录或目标机 shell 执行；
不要在没有用户确认时 `nixos-rebuild switch`。

## 1. 构建前门禁（开发机）

- 依赖或 `pnpm-lock.yaml` 变化后，先确认 `nix/deps.nix` 的
  `fetchPnpmDeps` 哈希已更新（`nix build .#default` 会打印期望哈希）。
- 本地验证：
  - `nix build .#default`
  - `nix run .#default -- --version`
  - `nix flake check`（package / unit / package-smoke / module-eval；
    不能替代目标机手工清单）
- 应用层门禁由仓库所有者执行：`pnpm check`、`pnpm test`、
  `pnpm test:process`。

## 2. 目标机部署

1. 更新 flake input 或本地 `nixos-rebuild switch`；查看构建日志中的
   module-eval 与 unit 检查。
2. `systemctl status nokoribi-agent` 必须是 `active (running)` 且 unit 已
   收到 notify ready（`Type=notify`）。启动失败看
   `journalctl -u nokoribi-agent -b -n 200`。
3. 确认 `$DSH_HOME`（默认 `/var/lib/nokoribi-agent`）与 `home/` 属主是
   服务用户，权限 0750/0700；`run/ready.json` 与 `run/test-channel.json`
   的 pid 与主进程一致。

## 3. 状态与恢复检查

- 测试通道（`channel.localTest.enable = true`）：
  - `curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/status`
  - `POST /v1/inbound` 发一条消息，`GET /v1/outbound` 确认回复。
- `/v1/status?full=1`（或 IM 里 `/status full`）应有 reviewer、goals、
  schedules、sandboxes、memory、recent errors。
- 重启一次 `systemctl restart nokoribi-agent`：确认会话恢复、inbox/
  outbox 重发、goal 恢复（`after = network-online.target`）。
- 部署后日志关键字：`ready`、`main session`、`resume`、`outbox`、
  `goal recovery`、`watchdog`。反复重启时检查 `StartLimitBurst=5`。

## 4. 升级/回滚注意

- 升级不自动备份；回滚 NixOS generation 不回滚 `$DSH_HOME` 数据。
  session JSONL 格式可能不向后兼容，回退二进制前先确认风险。
- 密钥只通过 EnvironmentFile/agenix 注入；不要在 Nix store 或仓库写
  secret。QQ ClientSecret、OpenViking key 都只出现环境变量名。
- 变更 rows/选项后不要手改运行时状态文件；Nix overlay 是权威配置
  （没有运行时 override 文件）。

## 5. 验收边界

- `nix flake check` 与本地测试只证明“代码完成”；目标机手工清单
  （12.12/12.14 等）未执行前不要宣称“完整验收通过”。
- 真实 QQ 平台、真实 Web API、真实 MCP server 需要凭证与网络，属于
  目标机/手工门禁。
