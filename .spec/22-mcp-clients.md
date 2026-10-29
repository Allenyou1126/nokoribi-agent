# 22 MCP 客户端（M13）

> 状态：**代码完成并经自动化门禁验证（2026-10-30 实现并通过本地门禁；streamable-http fake 测试仍 pending）**。本文是 M13 的实施规格：挂载 `@deepseek-ai/dsh-mcp-client` + `@deepseek-ai/dsh-mcp-resources`，用 Nix `mcp.servers` 动态生成每个外部 MCP server 的 client 行；stdio 用进程测试的 fake server 验证，streamable-http 暂未自动化（见 22.9）。里程碑总览见 [14.15](14-roadmap.md)；实现记录与偏差见 22.8。标“已核实”的是对照 rc.3 包 README/类型/本次实现确认的事实。

## 22.1 需求与范围

1. **接入外部工具面**：模型可以把外部 MCP server 的工具当作本机工具调用（`mcp__<server>__<tool>`），不需要为每个生态写适配器。
2. **两种传输**：本地 stdio（`command`/`args`/`env`/`cwd`）与 Streamable HTTP（`url`/`headers`）。
3. **资源读取**：`dsh-mcp-resources` 提供 3 个共享工具（list resources / list templates / read），无需每个 server 单独配置。
4. **秘密不落 store**：`env`/`headers` 的**值**在 Nix 里是环境变量名（间接引用），overlay 渲染为 `!!js process.env.NAME`；真实值走 EnvironmentFile/agenix。
5. **失败降级**：默认 `failOnStartupError=false`，初始连接失败只记录错误、daemon 仍启动；重连有上限/退避；损坏的配置在加载期报错。
6. **审查**：MCP 工具通过 `ctx.tools` 注册，Auto review 默认逐次审查（不自动豁免）。

**非目标**：打包外部 MCP server、MCP prompt 模板、resource 订阅/变更通知、MCP task 扩展、多 server 聚合（每个工具调用显式给 server 名）、把 MCP 工具加入 review 豁免。MCP server 的命令权限面/凭据出界与启动延迟是接受的残余风险（[15](15-verification-and-risks.md)）。

**完成定义**：`tests/process/m13-mcp.test.ts`（fake stdio server + fake LLM 调 `mcp__fake__echo` + reviewer 观察）；`nix/deps.nix` 哈希更新、`nix build .#default` 通过；module-eval 断言 0/1/2 server 与停用/空列表；streamable-http 自动化或明确 pending。

## 22.2 现状与差距

### 22.2.1 实现前现状（已核实，2026-10-29）

| 现状 | 事实 |
|---|---|
| MCP | 仓库无任何 `dsh-mcp-client`/`dsh-mcp-resources` 行/依赖；模型只能使用内置工具 |
| Nix | 无 `mcp.*` 选项；overlay 只生成固定行 |
| 测试 | 无 fake MCP server；`NOKORIBI_PATCH` 测试叠加路径已存在（harness `extraEnv` 可传） |

### 22.2.2 上游事实（已核实，2026-10-29 复核）

| 包 | 事实 |
|---|---|
| `@deepseek-ai/dsh-mcp-client` | 每个实例连一个 server；工具名固定 `mcp__<serverName>__<rawName>`（serverName `[A-Za-z0-9_-]{1,32}`，同一 scope 内唯一；冲突/重名在加载期失败）。config（stdio）：`transport:'stdio'`、`serverName`、`command`、`args[]`、`env{}`、`cwd`、`toolCallTimeoutMs`（默认 60000）、`maxInstructionBytes`（默认 32768）、`failOnStartupError`（默认 false）、`reconnect{enabled=true, initialDelayMs=500, maxDelayMs=30000, maxAttempts=10}`；config（HTTP）：`transport:'streamable-http'`、`url`、`headers{}` 加同名超时/重连字段。stdio 子进程环境 = subprocess seam 的 `scrubbedParentEnv()`（剔除 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 与 `DSH_*`）再合并 config `env`；`tools/list` 变化自动换 generation，失败保留旧工具集；`reconnect.maxAttempts` 次连续失败后注销工具并停止重连 |
| `@deepseek-ai/dsh-mcp-resources` | 无 config；当 caller scope 内有任一所配置 server 时注册 3 个共享工具（`list_mcp_resources`/`list_mcp_resource_templates`/`read_mcp_resource`，每次调用显式给 `server` 名）并在系统提示词加 server 名列表；无 server 时**零 token/零工具**；连接失败不移除共享工具 |
| `@modelcontextprotocol/client` | 传递依赖 2.2.0（MCP SDK）；协议/SDK 校验失败按上游行为抛错 |

## 22.3 设计

### 22.3.1 固定行 + 动态行

```
bundle (静态):  mcp-resources（始终启用，无 config）
Nix overlay / 测试 patch (动态):
  mcp-<serverName>  name=@deepseek-ai/dsh-mcp-client  config={serverName, transport, ...}
```

- `mcp-resources` 只挂一次，始终启用：没有 server 时它不产生任何工具/schema/提示词，因此不影响默认部署的 token 面。
- 每个 server 一行，行 id 固定 `mcp-<serverName>`，便于 Nix overlay 覆盖/排障；行顺序按 `mcp.servers` 列表顺序追加在 overlay 末尾（Cordis 按 `inject` 激活，行序只影响诊断顺序）。
- 生产配置来自 Nix overlay；开发/进程测试用 `NOKORIBI_PATCH` 叠加一个生成好的 patch 文件（harness 已有该入口），不需要 Nix。

### 22.3.2 NixOS 选项与渲染

```nix
services.nokoribi-agent.mcp.servers = [{
  name = "github";
  transport = "stdio";              # stdio | streamable-http
  command = "npx";                  # stdio 必填
  args = [ "-y" "@modelcontextprotocol/server-github" ];
  env = { GITHUB_TOKEN = "GITHUB_TOKEN"; };   # 值是环境变量名
  cwd = null;
  url = null;                       # streamable-http 必填
  headers = { Authorization = "MCP_AUTH_HEADER"; };  # 值是环境变量名
  toolCallTimeoutSeconds = 60;
  maxInstructionBytes = 32768;
  failOnStartupError = false;
  reconnect = { enable = true; initialDelayMs = 500; maxDelayMs = 30000; maxAttempts = 10; };
}];
```

overlay 渲染要点（patch 是行 config 替换，必须写全）：

- `serverName = server.name`、`transport`、`toolCallTimeoutMs = toolCallTimeoutSeconds*1000`、`maxInstructionBytes`、`failOnStartupError`、`reconnect = {enabled = reconnect.enable; initialDelayMs; maxDelayMs; maxAttempts;}`（注意上游字段名是 `enabled`，Nix 选项名是 `enable`，映射时改写）。
- stdio：`command`/`args`/`cwd` + `env`；HTTP：`url` + `headers`。另一传输的字段不写。
- **秘密渲染**：`env`/`headers` 的 value 是环境变量名。overlay 先把它渲染成 overlay 文本中的标记值 `__nokoribi_js_process_env_<NAME>__`，再由 `module.nix` 的后处理把它替换为 `!!js process.env.<NAME>`。这样 store 里的 overlay 只含变量名，不含值；YAML 保持合法（`!!js` 是 app-boot 支持的 tag）。
- 校验（module assertion）：`name` 非空、唯一、匹配 `[A-Za-z0-9_-]{1,32}`；stdio 必须给 `command`；streamable-http 必须给 `url`；`env`/`headers` 的 value 必须是合法 shell 变量名 `[A-Za-z_][A-Za-z0-9_]*`（防止把任意文本注入 overlay YAML）；reconnect 边界合理、`maxDelayMs >= initialDelayMs`。

### 22.3.3 测试用 fake server

`tests/process/support/fake-mcp.ts`：零依赖 Node 脚本（`node fake-mcp.ts` 由 mcp-client 以 stdio 子进程启动），实现 JSON-RPC 2.0（换行分隔）握手：

- `initialize` → `{protocolVersion, capabilities:{tools:{}}, serverInfo:{name:"fake",version:"0.0.0"}}`
- `notifications/initialized` → 无响应
- `tools/list` → `[{name:"echo", description:"Echo text", inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]`
- `tools/call` → `{content:[{type:"text",text:`echo:<text>`}]}`（未知工具 → JSON-RPC error）
- 可选环境变量指定监听工具名，便于断言 `mcp__fake__echo`。

进程测试生成 patch：

```yaml
- id: mcp-fake
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: fake
    transport: stdio
    command: node
    args: [ <repo>/tests/process/support/fake-mcp.ts ]   # 用 process.execPath 启动更稳
    env: {}
    cwd: <repo>
    toolCallTimeoutMs: 10000
    failOnStartupError: true
    reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 1000, maxAttempts: 1 }
```

`NOKORIBI_PATCH=<file>` 叠加在 bundle 之后：daemon 启动时连接 fake server，模型工具表出现 `mcp__fake__echo`。

## 22.4 配置

### 22.4.1 NixOS 选项（默认值）

| 选项 | 默认 | 说明 |
|---|---|---|
| `mcp.servers` | `[]` | submodule 列表；空列表 → overlay 无任何 MCP client 行 |
| `mcp.servers[].name` | （必填，校验） | server 名/命名空间 |
| `mcp.servers[].transport` | `stdio` | `stdio` \| `streamable-http` |
| `mcp.servers[].command` | `null` | stdio 必填 |
| `mcp.servers[].args` | `[]` | stdio 参数 |
| `mcp.servers[].env` | `{}` | 值 = 环境变量名 |
| `mcp.servers[].cwd` | `null` | stdio 工作目录 |
| `mcp.servers[].url` | `null` | HTTP 必填 |
| `mcp.servers[].headers` | `{}` | 值 = 环境变量名 |
| `mcp.servers[].toolCallTimeoutSeconds` | `60` | 渲染为 `toolCallTimeoutMs` |
| `mcp.servers[].maxInstructionBytes` | `32768` | 上游默认 |
| `mcp.servers[].failOnStartupError` | `false` | true 时初始连接失败使行加载失败 |
| `mcp.servers[].reconnect.enable` | `true` | → `reconnect.enabled` |
| `mcp.servers[].reconnect.initialDelayMs` | `500` | |
| `mcp.servers[].reconnect.maxDelayMs` | `30000` | |
| `mcp.servers[].reconnect.maxAttempts` | `10` | |

### 22.4.2 bundle 默认（dev/非 Nix）

- `mcp-resources` 行无 config、始终启用。
- server 行只来自 `NOKORIBI_PATCH`（测试）或用户自定义 patch；bundle 不提供 `NOKORIBI_MCP_*` 环境开关（生产由 Nix 生成；dev 手工写 patch）。`.env.example` 说明这一点。

## 22.5 信任边界与安全

- **外部 server 是另一个信任域**：stdio server 以 daemon 用户权限运行（本部署 `danger-full-access`，无文件系统沙箱），因此只能配置可信 server；命令/参数在 Nix store 中可见（非秘密）。
- **凭据不落 store**：`env`/`headers` 的值只以环境变量名出现；真实值由 systemd `EnvironmentFile`（agenix）注入。overlay 渲染为 `!!js process.env.NAME`，磁盘上只有表达式。
- **环境最小化**：stdio 子进程环境先剔除 ambient `*KEY*/*PASSWORD*/*SECRET*/*TOKEN*` 与 `DSH_*`，再合并显式 `env`；不要通过 `env` 传 `DEEPSEEK_API_KEY` 等不相关秘密。
- **数据出界**：MCP 工具把模型给的参数/上下文发给外部 server，属部署者接受的边界（[15](15-verification-and-risks.md)）；HTTP header 值同样不落 store。
- **审查**：MCP 工具经 `ctx.tools` 注册，默认逐次 Auto review（不加入 `review.exemptTools`）；`mcp-resources` 的 3 个读取工具同样逐次审查。审查成本随 server 工具数增长，登记风险。
- **启动失败**：默认 `failOnStartupError=false` 只记录错误；恶意/损坏 server 不能阻止 daemon 启动（除非运维显式置 true）。
- **工具名空间**：server 名唯一性在加载期校验；重名/非法名在 Nix 校验或引擎加载期失败。

## 22.6 测试

进程测试（`tests/process/m13-mcp.test.ts`）：

1. 构造临时 patch 文件：一个 `mcp-fake` 行（stdio，`command = process.execPath`，`args = [fake-mcp.ts]`，`failOnStartupError: true`，重连关闭）。
2. `startDaemon({ extraEnv: { NOKORIBI_PATCH: patchPath, NOKORIBI_DEFAULT_HOST: "local:workspace" } })`。
3. fake LLM 首个请求断言 tools 含 `mcp__fake__echo`（discovery 已在 ready 前完成），脚本化调用 `mcp__fake__echo {text:"m13-sentinel"}`。
4. 下一请求 messages 含 `echo:m13-sentinel`（工具结果进入模型上下文），最终 outbound 回复断言。
5. reviewer 观察：`reviewCount(server) >= 1`，且审查请求（system 以 `REVIEW_POLICY` 开头）的 body 含 `mcp__fake__echo`（证明 MCP 工具被审查）。

Nix 静态门禁（`nix/check-module.py` + `flake.nix` 样例）：样例 `mcp.servers` 配 2 个 server（stdio + streamable-http），断言 overlay 出现 `mcp-<name>` 行且 config 字段/秘密间接引用正确（`env`/`headers` 的 value 以 `!!js process.env.` 形式出现，或 YAML 解析后隐藏值不出现）；0 server（默认样例/disabled 样例）断言 overlay 中没有任何 `@deepseek-ai/dsh-mcp-client` 行。

## 22.7 验收与门禁

| 门禁 | 内容 | 状态 |
|---|---|---|
| G-M13-1 | `vitest run --config vitest.process.config.ts tests/process/m13-mcp.test.ts`（fake stdio server 端到端 + 审查） | **通过（本地，2026-10-30；3 次压力重跑稳定）** |
| G-M13-2 | `nix build .#default`（deps hash 含 MCP 依赖）+ `package-smoke` | **通过（本地，2026-10-30）** |
| G-M13-3 | module-eval 0/1/2 server 断言（`module-eval`、`module-eval-mcp-single`、`module-eval-disabled`）；停用样例无 MCP 行 | **通过（本地，2026-10-30）** |
| G-M13-4 | streamable-http fake server 进程测试 | **pending**（未自动化，见 22.9） |
| G-M13-5 | 目标机：真实 MCP server（stdio + HTTP）、启动失败降级、重连、凭据 agenix 注入 | 待目标机 |

## 22.8 实现记录与偏差（2026-10-29）

- 新增依赖：`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-mcp-resources`（0.2.1-rc.3，`packages/bundle`）；传递 `@modelcontextprotocol/client@2.2.0`；lock 与 `nix/deps.nix` 哈希更新。
- bundle 新增 `mcp-resources` 行（始终启用、无 config）。
- Nix 新增 `mcp.servers` 选项、动态 `mcp-<name>` 行、秘密间接引用渲染（marker→`!!js` 后处理）、断言；`flake.nix` 样例含 2 个 server。
- 进程测试 `tests/process/m13-mcp.test.ts` + `tests/process/support/fake-mcp.ts`（stdio JSON-RPC 2.0）。
- 偏差：`reconnect.enable`（Nix 选项名）映射到上游 `reconnect.enabled`；HTTP 样例只做 module-eval（无自动化 fake HTTP server）。
- overlay 语义：patch 行只能覆盖**已存在**的 row id，因此 MCP client 行通过一个无 id 的 `insert` patch 追加到 Cordis 顶层；`mcp-resources` 是 bundle 静态行。
- 启动顺序（已核实）：id-less insert 的行位于 bundle 全部行（含 `nokoribi-agent-app`）之后，daemon 的 ready 握手可能先于 MCP discovery 完成约 100–300ms。进程测试因此用普通消息轮询直到 `mcp__fake__echo` 出现，而不是假设“ready 即工具可见”；生产部署中首条用户消息通常在启动之后较久才到达，影响可忽略（若未来要求 ready 即工具可见，需要改成 bundle 内 group 行插入）。
- 门禁结果（2026-10-30）：fake stdio server 端到端（initialize/tools list/tools call）、`mcp__fake__echo` 结果进入下一请求、reviewer 观察到 `mcp__fake__echo` 审查请求均通过；`nix build .#default` + `package-smoke`（bundle 可解析 `dsh-mcp-client`/`dsh-mcp-resources`）通过；overlay 实测值 `!!js process.env.GITHUB_TOKEN` / `!!js process.env.MCP_AUTH_HEADER`（无字面秘密）。

## 22.9 未决项

- **streamable-http fake server 进程测试**：待补（需要一个最小 HTTP MCP server 的 SSE/JSON 响应形状；当前未实现，避免用未核实协议细节写测试）。
- MCP 工具审查成本：server 工具多时 reviewer 调用量线性增长；可能需要按工具名豁免策略（未定）。
- resources 读取的自动化测试（需 fake server 声明 resources capability + list/read 响应）。
- MCP server 启动/发现超时沿用 SDK 60s 默认，无独立配置（上游限制）。
