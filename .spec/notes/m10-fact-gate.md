# M10 平台与环境门禁记录

> 状态：**M10 代码完成（2026-10-29），真实门禁待执行**。M10 = host-aware 持久终端 + Web Search/Fetch，规格见 [19](../19-persistent-terminal-and-web.md) 19.6。本文件记录 19.6 的 G1–G7：G1（开发机真实 PTY）与 G7（reviewer 豁免回归）由自动化进程测试覆盖并通过；G2（NixOS 目标机 PTY）、G3（sandbox 终端）、G4（真实 DeepSeek 搜索）、G5（DeepSeek Search/Fetch API provider）、G6（真实公网抓取与 SSRF 拒绝）需要 NixOS 目标机、Nix buildEnv/setpriv 或真实 `DEEPSEEK_API_KEY` + 网络出口，**尚未执行**。执行后把结果写回本表，并同步 [19.6](../19-persistent-terminal-and-web.md)、[15.1.1](../15-verification-and-risks.md) 与 [12.14](../12-nixos-deployment.md)。

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

## 2. G1–G7 门禁表

| # | 门禁 | 验证方式 / 命令 | 状态 | 证据与结论 |
|---|---|---|---|---|
| G1 | 开发机 bash PTY（open/send/read/close） | `pnpm test:process`（`tests/process/m10-terminal.test.ts`）；真实 `dsh-subprocess-local` PTY | **自动化通过（2026-10-29 观察 4/4）** | 覆盖：`terminal_open` → `terminal_send` 改 cwd/env → 后续 `terminal_send`/`terminal_list` 看到持久状态 → `terminal_close`；`/clear` 时先关闭旧 agent 终端再 `disposeSession`（不出现 “open persistent terminal sessions” 拒绝）；`NOKORIBI_TERMINAL_ENABLED=false` 时模型看不到 `terminal_*` 工具与 `nokoribi:pty` 引导段（整组行停用），hosts 发现工具保留；SIGTERM 干净退出。结论：**D168 的 `BashTerminalBackend` + 注入 `spawnTerminal` 方案在开发机可用，无需回退 vendoring**（owner 隔离由 `ctx.terminals` 上游机制承担，本地单测覆盖 backend 注册/清理，未在进程测试中单列） |
| G2 | NixOS 目标机 PTY（systemd 用户会话、`/proc`、信号） | 目标机部署后经测试通道：`terminal_open {type:"local:workspace"}` → `terminal_send "pwd; echo $$"` → `terminal_read`；`systemctl status nokoribi-agent`、journald 检查；重启服务确认无残留 PTY | **待执行（需 NixOS 目标机）** | 与 G1 差异：D148 的 `node-shim`/subprocess scope、systemd 用户会话、`/proc` 访问、真实信号与进程树清理。当前开发机为 Arch，不能执行 |
| G3 | sandbox 终端（Nix buildEnv + setpriv + 临时包） | 设 `NOKORIBI_DEFAULT_HOST=sandbox:default`、绝对 `NOKORIBI_SANDBOX_BASE_ENV`（含 bash/coreutils/util-linux）与 `setpriv`；`terminal_open {type:"sandbox:default"}` → `terminal_send "pwd; bash --version"`；验证 cwd 是 `$DSH_SANDBOX_DIR`、sudo 失败、`sandbox reset` 在终端打开时被拒绝、`sandbox status` 显示 `terminalSessions: 1`；`terminal_close` 后 reset 成功且 generation+1；`sandbox_packages add` 后新开终端可见新包 | **待执行（需 Nix buildEnv；手工/gated）** | 单测已覆盖 argv（`setpriv --no-new-privs`、有临时包时的 `nix shell … --command setpriv`）、受限 PATH 与 pin 互锁；真实 `nix shell` 下 PTY 行为未验证 |
| G4 | 真实 DeepSeek 搜索（默认 `deepseek-official`） | 真实 `DEEPSEEK_API_KEY` + 网络出口；经测试通道让模型调用 `web_search`，记录返回 source、延迟与（按账号）消耗；核对 `DEEPSEEK_SEARCH_BASE_URL` 覆盖生效 | **待执行（需 API key + 网络）** | provider 默认基址 `https://api.deepseek.com/anthropic/v1`（`/messages` 追加），模型默认 `deepseek-v4-flash`，每次搜索 = 一次辅助模型轮次（计入预算）；本机 fake HTTP 只验证协议形状（`tests/process/support/fake-web-search.ts`），不证明真实服务可用 |
| G5 | `deepseek-search-api` / `deepseek-fetch-api` 真实调用 | 设 `NOKORIBI_WEB_SEARCH_PROVIDER=deepseek-search-api`、`NOKORIBI_WEB_FETCH_PROVIDER=deepseek-fetch-api` 后各调用一次；记录凭据解析（默认 `DEEPSEEK_API_KEY`）、基址与响应 | **待执行（需 API key）** | provider id 与配置已按 rc.3 核对（基址默认 `https://api.deepseek.com/v1/tools`，直连不耗辅助模型轮次）；真实账号/接口可用性未知 |
| G6 | `http` fetch 真实公网抓取与 SSRF 拒绝 | 真实网络下 `web_fetch` 一个公网 URL 成功并截断；`web_fetch http://127.0.0.1:9/` 返回 blocked/非公网错误；观察代理环境变量行为 | **待执行（需真实公网出口）** | 自动化已有负例：`tests/process/m10-web.test.ts` 用 `http://127.0.0.1:9/` 断言返回 “non-public”，但真实公网抓取、重定向与大小上限未验证 |
| G7 | 豁免后的 reviewer 回归 | `pnpm test:process`（`tests/process/m10-web.test.ts`，2 场景）+ `pnpm test:unit`（reviewer 单测） | **自动化通过（2026-10-29 观察 2/2）** | 场景一：`web_search`/`web_fetch` 不产生 reviewer 请求，`bash` 仍产生（fake LLM 按 `REVIEW_POLICY` 系统提示计数）；场景二：`NOKORIBI_REVIEW_EXEMPT_TOOLS=""` 时 `web_search` 恢复审查。结论：默认豁免只命中两个 web 工具，`terminal_*`/`bash`/文件工具未豁免 |

## 3. 不能执行的原因与前置

| 门禁 | 前置条件 | 当前状态 |
|---|---|---|
| G2 | NixOS 目标机（systemd 用户会话、`/proc`、`nix`、官方 Node wrapper + D148 shim）；目标机部署记录见 [14.7](../14-roadmap.md) M6 目标机记录 | 当前开发机是 Arch，不能执行 |
| G3 | 绝对路径 Nix buildEnv（bash/coreutils/util-linux，`setpriv` 可用）；可选 `nix` 运行时包与网络/缓存 | 本机可用 Nix 但未做目标机级验收；`nix shell` 下 PTY 未实测 |
| G4/G5 | `DEEPSEEK_API_KEY`（EnvironmentFile/agenix 或环境变量）、可直连 `api.deepseek.com`（或代理策略）、账号额度 | 未在本次执行；fake HTTP 不能替代 |
| G6 | 真实公网出口、DNS、代理；可接受的外部 HTTP 服务 | 未在本次执行；仅有 localhost 负例 |
| 通用 | `pnpm check`、`nix flake check`、`nix build .#default`、`nix run --version` 已由 Lead 最终门禁执行并通过；三者不能替代 G2–G6 | **已执行（2026-10-29）** |

## 4. 结果写回约定

- 执行 G2–G6 后，在本表“状态/证据”列填日期、命令、输出摘要与结论；若发现规格偏差，按 [04.7](../04-architecture-and-build.md) 与“实现偏离规格必须同步更新规格”约定回写 [19](../19-persistent-terminal-and-web.md) 与相关文档。
- G2 通过前，README/AGENTS/14.11 只能写“M10 代码完成，真实门禁与目标机验收待执行”，不得写“验收通过”。
- G4/G5 若因账号/网络不可用：按 [15.5](../15-verification-and-risks.md) 用 `web.enable=false` 发行并在 README 标注，保留代码路径。
