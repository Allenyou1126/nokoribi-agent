# M10 平台与环境门禁记录

> 状态：**M10 代码完成（2026-10-29），目标机用户态 G2/G3/G4/G6 已通过，G5 与完整 12.14 systemd 验收待执行**。M10 = host-aware 持久终端 + Web Search/Fetch，规格见 [19](../19-persistent-terminal-and-web.md) 19.6。本文件记录 19.6 的 G1–G7：G1（开发机真实 PTY）、G7（reviewer 豁免回归）由自动化进程测试覆盖；G2（NixOS 目标机用户态 PTY）、G3（sandbox 终端）、G4（真实 DeepSeek 搜索）、G6（真实公网抓取与 SSRF 拒绝）已在 hkg-dog-darell 用户态临时环境通过；G5（`deepseek-search-api`/`deepseek-fetch-api` 切换）与 systemd unit/12.14 完整目标机验收仍未执行。执行后把结果写回本表，并同步 [19.6](../19-persistent-terminal-and-web.md)、[15.1.1](../15-verification-and-risks.md) 与 [12.14](../12-nixos-deployment.md)。

## 1. 本次观察（文档施工机，2026-10-29）

环境：Arch Linux 开发机（非 NixOS）、Node.js 24、DSH `0.2.1-rc.3`、默认 host `local:workspace`、系统 bash。以下命令均由文档施工者实际运行：

| 命令 | 观察结果 |
|---|---|
| `pnpm test:unit` | 56 文件 / 438 测试通过（flake unit 使用，不含 `tests/integration`，不含真实 PTY） |
| `pnpm test` | 60 文件 / 458 测试通过（单元 + `tests/integration`） |
| `pnpm test:process` | 10 文件 / 64 场景通过；其中 M10 新增 6 场景：`tests/process/m10-terminal.test.ts` 4 场景（真实 local PTY）、`tests/process/m10-web.test.ts` 2 场景（fake DeepSeek 搜索 HTTP + reviewer 豁免计数） |
| `pnpm check` | **通过**（2026-10-29 最终门禁）：构建 + tsc + oxlint 0 warnings/errors + oxfmt clean |
| `nix flake check` | **通过**（2026-10-29 最终门禁）：package/unit/package-smoke/module-eval/module-eval-disabled 全部通过 |
| `nix build .#default` | **通过**（2026-10-29 最终门禁） |
| `nix run .#default -- --version` | **通过**：`nokoribi-agent 0.1.0` |

> 以上为 2026-10-29 的施工/最终门禁观察值，不是真实平台验收结论；G2–G6 目标机/真实网络门禁仍未执行。

自动化覆盖（不替代真实门禁）：

- `packages/terminal-host/test/`（33 测试）：fake `spawnTerminal` 下的 per-host backend 注册/注销、launch 替换 argv/cwd/env、release 幂等、spawn 失败清理、`enabled=false` 只注册禁用提示。
- `packages/shell-bash/test/`：`terminal` 能力位校验、`terminalLaunch` 路由/未知 host/未实现、`onChange`、发现工具 `terminal` 字段。
- `packages/shell-host-local/test/`、`packages/shell-host-sandbox/test/`：local launch argv/cwd/PATH/`terminalBashPath`；sandbox pin/TTL 跳过/reset/dispose 拒绝/`terminalSessions`/`buildSandboxTerminalArgv`。
- `packages/reviewer/test/`：`exemptTools` schema 默认 `[]` 与自定义列表解析；运行时放行行为由 `tests/process/m10-web.test.ts` 覆盖。
- `packages/agent-app/test/terminal-cleanup.test.ts`：`killTerminalsForAgent`/`killTerminalsForSession` 的有界等待与失败降级。

## 2. 目标机用户态验证（2026-10-29，hkg-dog-darell）

环境：NixOS 26.05（kernel 6.18.40，x86_64），用户 `allenyou`；代码 `~/nokoribi-bot`（commit `39e331c`，与 origin/main 一致）；`nix build .#default` 产物 `/nix/store/8mhq9430cg7avw9g3da5x1cd2rs1kz3p-nokoribi-agent-0.1.0`；隔离运行目录 `~/nokoribi-tmp/m10`（独立 env/DSH_HOME/logs/pid，端口 8790），QQ 渠道关闭，仅启用 local-test；未安装 systemd unit、未修改 `/etc`/NixOS 配置。测试结束已停止 daemon，端口释放。

| 门禁 | 目标机观察 | 结论 |
|---|---|---|
| G2 | 经测试通道让模型 `terminal_open {type:"local:workspace"}`，两次 `terminal_send` 执行 `cd /tmp && export M10=ok`、`echo PTY:$PWD:$M10`，`terminal_close`；回复 `PTY:/tmp:ok`。随后 `/clear` 返回“已新建会话，旧会话已归档”，日志无 cleanup/“open persistent terminal sessions”错误。 | **用户态通过**（setsid 用户进程；systemd unit/信号重启仍未测，12.14 待执行） |
| G3 | `terminal_open {type:"sandbox:default"}` → `terminal_send` 执行 `printf 'SB:%s\n' "$PWD"; id -u; (sudo -n true 2>&1 || echo NOSUDO)`；输出 `SB:/home/allenyou/nokoribi-tmp/m10/dsh/sandboxes/<session>`、`id -u=1001`、sudo 被 sandbox guard 拒绝。 | **基础通过**（真实 Nix buildEnv/setpriv PTY；reset/packages 互锁仍由单测覆盖） |
| G4 | 真实 `web_search "NixOS 26.05 release date"` 返回 `nixos.org` 与 `distrowatch.com` source；未设置 `DEEPSEEK_SEARCH_BASE_URL`，走默认 DeepSeek 搜索。 | **通过**（真实 `DEEPSEEK_API_KEY` + 网络） |
| G6 | 真实 `web_fetch https://example.com` 返回 `Example Domain` / HTTP 200；`web_fetch http://127.0.0.1:9/` 返回 `URL hostname "127.0.0.1" resolves to a non-public IP address`。 | **基础通过**（公网抓取 + SSRF 负例；重定向/大小上限未独立构造） |
| G5 | 未切换 `deepseek-search-api`/`deepseek-fetch-api`。 | **待执行** |
| G1/G7 | 见第 1 节自动化观察。 | **自动化通过** |

## 3. G1–G7 门禁表

| # | 门禁 | 验证方式 / 命令 | 状态 | 证据与结论 |
|---|---|---|---|---|
| G1 | 开发机 bash PTY（open/send/read/close） | `pnpm test:process`（`tests/process/m10-terminal.test.ts`）；真实 `dsh-subprocess-local` PTY | **自动化通过（2026-10-29 观察 4/4）** | 覆盖：`terminal_open` → `terminal_send` 改 cwd/env → 后续 `terminal_send`/`terminal_list` 看到持久状态 → `terminal_close`；`/clear` 时先关闭旧 agent 终端再 `disposeSession`（不出现 “open persistent terminal sessions” 拒绝）；`NOKORIBI_TERMINAL_ENABLED=false` 时模型看不到 `terminal_*` 工具与 `nokoribi:pty` 引导段（整组行停用），hosts 发现工具保留；SIGTERM 干净退出。结论：**D168 的 `BashTerminalBackend` + 注入 `spawnTerminal` 方案在开发机可用，无需回退 vendoring**（owner 隔离由 `ctx.terminals` 上游机制承担，本地单测覆盖 backend 注册/清理，未在进程测试中单列） |
| G2 | NixOS 目标机 PTY（systemd 用户会话、`/proc`、信号） | 目标机部署后经测试通道：`terminal_open {type:"local:workspace"}` → `terminal_send` 改 cwd/env → `terminal_send` 读回 → `terminal_close`；`/clear` 检查清理错误 | **用户态通过（2026-10-29 hkg-dog-darell）** | 回复 `PTY:/tmp:ok`；`/clear` 成功且日志无 cleanup 错误。setsid 用户进程，非 systemd unit；D148 shim、`/proc`、SIGTERM 下的 PTY 清理与 12.14 完整清单仍未测 |
| G3 | sandbox 终端（Nix buildEnv + setpriv + 临时包） | 设 `NOKORIBI_DEFAULT_HOST=sandbox:default`、绝对 `NOKORIBI_SANDBOX_BASE_ENV` 与 `setpriv`；`terminal_open {type:"sandbox:default"}` → `terminal_send` 查 cwd/uid/sudo → `terminal_close` | **基础通过（2026-10-29）** | 输出 `SB:/home/allenyou/nokoribi-tmp/m10/dsh/sandboxes/<session>`、`id -u=1001`、sudo 被 PATH guard 拒绝；reset 在终端打开时拒绝、`sandbox_packages add` 后新终端可见新包仍由单测覆盖，未在目标机重复 |
| G4 | 真实 DeepSeek 搜索（默认 `deepseek-official`） | 真实 `DEEPSEEK_API_KEY` + 网络；测试通道让模型调用 `web_search` | **通过（2026-10-29 hkg-dog-darell）** | `web_search "NixOS 26.05 release date"` 返回 `nixos.org` 与 `distrowatch.com` 真实 source；未设置 `DEEPSEEK_SEARCH_BASE_URL`，走默认 endpoint |
| G5 | `deepseek-search-api` / `deepseek-fetch-api` 真实调用 | 设 `NOKORIBI_WEB_SEARCH_PROVIDER=deepseek-search-api`、`NOKORIBI_WEB_FETCH_PROVIDER=deepseek-fetch-api` 后各调用一次 | **待执行（需 API key；本次未切换）** | provider id/配置已按 rc.3 核对；真实账号/接口可用性未知 |
| G6 | `http` fetch 真实公网抓取与 SSRF 拒绝 | 真实网络下 `web_fetch` 公网 URL；`web_fetch http://127.0.0.1:9/` 返回 blocked | **基础通过（2026-10-29 hkg-dog-darell）** | `example.com` 返回 `Example Domain`/HTTP 200；localhost 返回 `URL hostname "127.0.0.1" resolves to a non-public IP address`。重定向/大小上限/代理行为未独立构造 |
| G7 | 豁免后的 reviewer 回归 | `pnpm test:process`（`tests/process/m10-web.test.ts`，2 场景）+ `pnpm test:unit`（reviewer 单测） | **自动化通过（2026-10-29 观察 2/2）** | 场景一：`web_search`/`web_fetch` 不产生 reviewer 请求，`bash` 仍产生（fake LLM 按 `REVIEW_POLICY` 系统提示计数）；场景二：`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 时 `web_search` 恢复审查。结论：默认豁免只命中两个 web 工具，`terminal_*`/`bash`/文件工具未豁免 |

## 3. 剩余门禁与前置

| 门禁 | 前置条件 | 当前状态 |
|---|---|---|
| G2 完整项 | systemd unit（`services.nokoribi-agent`）/用户级 12.14 清单、`/proc`、真实 SIGTERM 与重启后无残留 PTY | 用户态已通过；systemd/重启项待目标机安装或按 [12.14](../12-nixos-deployment.md) 手工执行 |
| G3 完整项 | 临时包 `sandbox_packages add` 后新开终端可见新包；终端打开时 `sandbox reset` 拒绝、关闭后成功 | 基础 sandbox PTY 已通过；这两项仍由单测覆盖，未在目标机重复 |
| G5 | `DEEPSEEK_API_KEY`、账号可用的 Search/Fetch API endpoint | 本次未切换 provider，待执行 |
| G6 完整项 | 同源重定向、大小/字符上限、代理环境 | 公网抓取 + SSRF 负例已通过；边界项未独立构造 |
| 12.14 | NixOS module 安装、systemd unit、目标机手工清单 | 本次只做用户态临时部署；12.14 未执行 |
| 通用 | `pnpm check`、`nix flake check`、`nix build .#default`、`nix run --version` 已由 Lead 最终门禁执行并通过；不能替代剩余真实门禁 | **已执行（2026-10-29）** |

## 4. 结果写回约定

- 执行 G2–G6 后，在本表“状态/证据”列填日期、命令、输出摘要与结论；若发现规格偏差，按 [04.7](../04-architecture-and-build.md) 与“实现偏离规格必须同步更新规格”约定回写 [19](../19-persistent-terminal-and-web.md) 与相关文档。
- 目标机用户态 G2/G3/G4/G6 已通过，但 systemd 12.14/G5/完整边界项未执行前，README/AGENTS/14.11 仍不得写“M10 验收通过”。
- G4/G5 若因账号/网络不可用：按 [15.5](../15-verification-and-risks.md) 用 `web.enable=false` 发行并在 README 标注，保留代码路径。
