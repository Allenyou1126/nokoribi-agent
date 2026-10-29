# 25 OpenViking 可选记忆后端（M17）

> 状态：**代码完成（2026-10-30）；真实 OpenViking server spike 待外部部署后执行**。里程碑见 [14.15](14-roadmap.md)；本地记忆与自动注入设计见 [09.5](09-prompt-and-memory.md)。M17 是 v1 后增强，不改变 [14.14](14-roadmap.md) 的 v1 完成定义。**不能标“M17 验收通过”**：fake/无 server 自动化已通过，真实 server 召回/延迟/降级未记录。

## 25.1 目标与边界

- 默认仍是本地记忆（`packages/memory` + pinned 快照，D172–D174）。
- 增加启用 OpenViking 的开关；**启用后由 OpenViking 接管**记忆（profile/recall/capture/commit），本地 `nokoribi-memory` 组件停用（存储、工具、快照），不做双写/双读。两者互斥（D175）。
- **不打包 openviking-server**：server 由用户外部部署（uv/Docker/云），需自带 embedding + VLM provider；仓库只保留连接配置与文档。
- 接入组件：`@openviking/dsh-memory-plugin`（Apache-2.0，pin 版本 `0.5.31`）作为 profile bundle；前置 M12（`dsh-skill-filesystem`）与 M13（`dsh-mcp-client`），插件已验证兼容 DSH `0.2.1-rc.3`。
- 不做：本地/OpenViking 混合检索、自动迁移、在仓库内提供 embedding/VLM、OpenViking 数据备份、`openviking-server` 的 Nix 打包。

## 25.2 配置

NixOS module（M17 新增）：

```nix
memory.openviking = {
  enable = false;                    # 默认本地记忆
  endpoint = null;                   # 例如 "http://127.0.0.1:1933"
  apiKeyEnv = "OPENVIKING_API_KEY";  # EnvironmentFile/agenix 中的变量名，值不写入 store
  peerId = null;                     # 显式 actor peer
  workspacePeer = null;              # workspace 派生 peer；"0" 关闭
  recallMaxTokens = null;            # server-assembled recall 的 token 预算
};
```

约束：

- `enable = true` 时 `endpoint` 必填（module eval 断言）；`apiKeyEnv` 只是变量名，密钥值仍走 `environmentFile`/agenix。
- 启用时 module 同时注入：`NOKORIBI_OPENVIKING_ENABLED=true`、`NOKORIBI_MEMORY_ENABLED=false`、连接相关环境变量；关闭时不注入任何 OpenViking 环境变量（默认本地记忆）。
- 连接相关的配置全部收敛在 `memory.openviking.*`（D175），不散落到 `models.*`/`skill.*`。

环境变量映射（launcher 负责从 `NOKORIBI_OPENVIKING_*` 归一到插件读取的 `OPENVIKING_*`）：

| Nix 选项 | 环境变量 | 插件读取 |
|---|---|---|
| `endpoint` | `NOKORIBI_OPENVIKING_ENDPOINT` | `OPENVIKING_URL` |
| `apiKeyEnv`（变量名） | `NOKORIBI_OPENVIKING_API_KEY_ENV` + 该变量本身 | `OPENVIKING_API_KEY`（若已设置则不覆盖） |
| `peerId` | `NOKORIBI_OPENVIKING_PEER_ID` | `OPENVIKING_PEER_ID` |
| `workspacePeer` | `NOKORIBI_OPENVIKING_WORKSPACE_PEER` | `OPENVIKING_WORKSPACE_PEER` |
| `recallMaxTokens` | `NOKORIBI_OPENVIKING_RECALL_MAX_TOKENS` | `OPENVIKING_RECALL_MAX_TOKENS` |

手动部署也可以直接设置 `OPENVIKING_*` 环境变量；`NOKORIBI_*` 是 NixOS module 的稳定接口。

## 25.3 运行时装配

- launcher 生成的 runtime profile 在 `NOKORIBI_OPENVIKING_ENABLED=true` 时把 bundle 列表写成 `["@nokoribi/bundle", "@openviking/dsh-memory-plugin"]`；默认只有 `@nokoribi/bundle`。插件包随发行版安装（launcher 依赖），但 Cordis 层只在启用时加载。
- 插件注册 row `openviking-memory-runtime`；其 apply 内部挂载 MCP proxy（`mcp__openviking__*` 工具面）与一个隔离的 `ctx.skills` provider（内置 OpenViking skills），并注册 `agent/created`/`agent/pre-step`/`session/event`/`turn/end` 生命周期。
- 本地记忆关闭通过 bundle 的既有环境开关：`NOKORIBI_MEMORY_ENABLED=false` 停用 `nokoribi-memory` 行（工具/存储/快照）、`nokoribi-prompt` 的 memory 段与 agent-app 的 memory curator。launcher 在启用 OpenViking 时强制该值，避免“双后端”。
- 无 overlay 行禁用：`memory.openviking.enable=true` 不需要写 Cordis overlay；关闭态是 bundle 默认。module 只注入环境变量（与 D175 的“纯 Nix 只读配置”一致）。
- `OPENVIKING_STATE_DIR`（可选）可指向 `DSH_HOME` 下的持久目录，避免插件把去重/降级记忆写到 `$HOME/.openviking`；NixOS module 默认写 `DSH_HOME/openviking-state`。

## 25.4 生命周期与降级

- 插件启动失败（server 不可达、鉴权失败）**不得阻止 daemon 启动**：插件在 `agent/created`/`agent/pre-step` 内部捕获异常并记录日志，pre-step 会重试 profile 投递。
- 写入失败进入插件自身的 pending queue，由后台 drainer 探测 server 健康后重放（默认 60s）；capture 与 commit 属于同一开关，关闭 sync 后不再新增写入。
- `skipSubagentSessions` 默认 false，goal/subagent 会话参与 capture/recall；如需隔离由部署配置决定（M17 不暴露 Nix 选项，保持插件默认）。
- 启用后**没有本地 fallback**：OpenViking 不可用时记忆能力降级为“不可用”，不影响对话主流程；文档必须写明这一点。
- 卸载/关闭：改回 `memory.openviking.enable=false` 即恢复本地记忆；OpenViking 侧数据保留在外部 server，不做反向迁移。

## 25.5 安全与部署边界

- 记忆数据出界：启用后对话内容、profile、recall 查询与 capture 均发往外部 OpenViking server；server 及其 embedding/VLM provider 的数据保留、合规与访问控制由部署者负责。
- 额外密钥面：OpenViking key（`apiKeyEnv`）、embedding/VLM provider 密钥均由外部 server 持有；仓库不打包、不读取这些密钥。
- 许可：插件 Apache-2.0；OpenViking server 为 AGPL，部署责任在用户，仓库不分发。
- MCP 工具面：`mcp__openviking__*` 进入 `ctx.tools`，因此仍经过 Auto review（M17 不加入 `exemptTools`）；`forget` 为永久删除，提示词/文档要求仅在用户明确要求时使用。
- 本地记忆的残余风险（持久化提示注入面，[15.4](15-verification-and-risks.md)）在启用后转移为“OpenViking 自动 recall 内容 + 插件注入块”；插件自带 `<openviking-context>` 来源声明，仍按不可信数据对待。
- 本地 entries → OpenViking 的迁移**不做自动化**：如需迁移，用户按 `memory search/read` 导出后通过 OpenViking 的 remember/write 工具或 server 侧导入完成；`$DSH_HOME/memory/entries` 在停用本地记忆后保留原样（不删除）。

## 25.6 测试与门禁

- **module-eval**：`memory.openviking.enable=true` 时断言 `NOKORIBI_OPENVIKING_ENABLED`/`NOKORIBI_MEMORY_ENABLED=false`/连接 env 注入、`endpoint` 必填校验；`enable=false` 时断言无 OpenViking env。
- **无 server 启动**：进程测试以 `NOKORIBI_OPENVIKING_ENABLED=true` + 不可达 endpoint 启动 daemon，必须 ready、主会话可用、`send_to_user`/对话正常，且 `memory` 工具不出现（本地记忆已停用）；日志有插件连接失败记录。
- **fake server**：进程测试用零依赖 fake OpenViking HTTP server（`/health`、`/api/v1/sessions`、`/api/v1/system/status`、`/api/v1/fs/ls`、`/api/v1/content/read`、`/api/v1/skills`、`/api/v1/search/search`、`/api/v1/sessions/*/messages`、`/api/v1/sessions/*/commit`）验证启动 profile 拉取、进入 pre-step 的 recall 请求、assistant/user capture 写入；断言 daemon 正常回复、关闭干净。
- **真实 server spike（外部部署，手工）**：记录 recall 命中/延迟、capture/commit 可见性、断线降级、MCP 工具面可用性；未记录前 M17 只能标“代码完成”。
- 自动化门禁：`pnpm check`、`pnpm test`、`pnpm test:unit`、`pnpm test:process`、`pnpm test:process tests/process/m17-openviking.test.ts`、`nix flake check`（module-eval）、`nix build .#default`。

## 25.7 范围外 / 后续

- OpenViking server 的 Nix/容器打包与 NixOS 服务化（用户外部部署）。
- 本地与 OpenViking 双写/灰度/回切、自动迁移与去重。
- 每轮自动检索、embedding/向量能力（沿用本地记忆的范围外口径）。
- OpenViking 专属 Nix 选项（`syncTurns`/`skipSubagentSessions`/`skillCatalog` 等）：M17 只暴露 D175 确认的连接配置；其余用插件默认，后续按需补充并回写本文。

## 25.8 实现记录（2026-10-30，代码完成）

- **launcher**（`packages/launcher/src/index.ts`）：`NOKORIBI_OPENVIKING_ENABLED=true` 时 profile bundle 列表追加 `@openviking/dsh-memory-plugin`；`applyOpenVikingEnvironment()` 把 `NOKORIBI_OPENVIKING_*` 归一为插件读取的 `OPENVIKING_URL`/`OPENVIKING_API_KEY`/`OPENVIKING_PEER_ID`/`OPENVIKING_WORKSPACE_PEER`/`OPENVIKING_RECALL_MAX_TOKENS`，并强制 `NOKORIBI_MEMORY_ENABLED=false`；启用但插件 bundle 被跳过/缺失时**启动失败**（不允许静默失去记忆后端）。`--help` 增加全部新 env 说明。
- **本地记忆关闭路径**：bundle 的 `nokoribi-memory`/`nokoribi-prompt`/`nokoribi-agent-app` 行按 `NOKORIBI_MEMORY_ENABLED` 停用组件/提示词段/curator；agent-app 不再硬 inject `memory`（`ctx.get("memory")` 可选），因此 OpenViking/停用本地记忆时 daemon 正常启动。
- **依赖**：`packages/launcher` 增加 `@openviking/dsh-memory-plugin@0.5.31` 与三个显式 DSH peer（`dsh-llm`/`dsh-mcp-client`/`dsh-skill-filesystem` 0.2.1-rc.3），避免 pnpm 从 registry 自动安装 host 包副本；lock 与 `nix/deps.nix` FOD 哈希随依赖更新。
- **测试**：`tests/process/m17-openviking.test.ts` + 零依赖 fake server `tests/process/support/fake-openviking.ts`（health/sessions/system-status/fs-ls/content-read/skills/search/find/recall/messages/commit）2 场景通过：①不可达 endpoint 启动 daemon 正常 ready、主会话可对话、`memory` 工具不出现（本地记忆互斥停用）；②fake server 下 `/health`/`/api/v1/search/search` recall 命中注入模型请求、`POST /api/v1/sessions/*/messages` capture 发生、正常回复与干净关闭。
- **Nix**：`memory.openviking.*` 选项 → systemd 环境变量（`NOKORIBI_OPENVIKING_*`、`NOKORIBI_MEMORY_ENABLED=false`、`OPENVIKING_STATE_DIR=$DSH_HOME/openviking-state`）；module-eval 断言启用/停用两支与 `endpoint` 必填。详见 [14.15](14-roadmap.md) 与 [12](12-nixos-deployment.md)（最终回写）。
- **最终门禁（2026-10-30）**：`pnpm check`、`pnpm test:unit`（60 文件/512 测试）、`pnpm test`（66 文件/537 测试）、`pnpm test:process`（17 文件/84 场景，含 M17 2/2）、`nix flake check --offline`（package/unit/package-smoke/module-eval ×4，其中 `module-eval-openviking` 通过）、`nix build --offline .#default` 与 `nix run --offline .#default -- --version` 均通过。
- **未完成 / 后置**：真实 OpenViking server spike（外部部署；记录召回/延迟/降级/MCP 工具面）；本地 entries → OpenViking 迁移只有文档说明；插件高级选项（`syncTurns` 等）不暴露。**M17 只能标“代码完成”**，不能标验收通过。
