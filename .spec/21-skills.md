# 21 本地 Skill（M12）

> 状态：**代码完成并经自动化门禁验证（2026-10-30 实现并通过本地门禁）**。本文是 M12 的实施规格：挂载 DSH `dsh-skill` 注册表 + `dsh-skill-filesystem` 本地 provider + `dsh-tool-skill` 模型目录/加载工具，随发行版打包两个只读技能，并提供 `skill.*` NixOS 选项。里程碑总览见 [14.15](14-roadmap.md)；实现记录与偏差见 21.8。标“已核实”的是对照 rc.3 包 README/类型/源码与本次实现确认的事实。

## 21.1 需求与范围

1. **可发现**：模型在会话中得到一份 durable catalog（名字 + 截断描述），知道哪些技能可用。
2. **按需加载**：模型可用 `skill` 工具加载技能全文；用户可用 `/name` 直接调用。
3. **本地来源**：Nix 打包的只读技能目录 + `$DSH_HOME/skills` + 可选自定义目录；不做远程 hub/下载/市场。
4. **可关闭**：部署可整体关闭 skill 行（catalog、工具、provider 全不注册）。
5. **可运维**：随发行版附带 2 个 Nokoribi 运维技能（`nokoribi-deploy`、`nokoribi-debug`），内容短小、可执行。

**非目标**：技能市场/远程源、技能自动创建或版本生命周期、技能资源附件的自动打包（provider 给 base 目录提示，模型自行读文件）、`whenToUse` 的 catalog 渲染（上游不渲染，仅 metadata）。

**完成定义**：`tests/process/m12-skills.test.ts` 通过（catalog/工具加载/`/name` 注入/停用四段）；`nix/package.nix` 打包 `skills/`；Nix module-eval 启用/停用断言；`nix build .#default` + `package-smoke` 断言 `share/skills`。

## 21.2 现状与差距

### 21.2.1 实现前现状（已核实，2026-10-29）

| 现状 | 事实 |
|---|---|
| skill 服务 | 组合未挂载任何 `dsh-skill*` 行；`ctx.skills` 不存在 |
| 技能目录 | 仓库无 `skills/`；Nix 发行版只打包 `SOUL.md`/`templates/` |
| 用户命令 | channel-core 对未知斜杠命令报“未知命令”（M12 需要落到 agent，由 channel 所有者在 M14 早期改动） |
| 提示词 | 无技能指引；`skill` 工具不存在 |

### 21.2.2 上游事实（已核实，2026-10-29 复核）

| 包 | 事实 |
|---|---|
| `@deepseek-ai/dsh-skill` | `ctx.skills` 注册表（service）；config `collectCacheMaxEntries`（默认 128）；provider 合并/policy 过滤/按名加载；技能名 kebab-case、description 必填；provider 失败只警告并返回不完整观察；invalidation 由 provider 驱动（无 TTL） |
| `@deepseek-ai/dsh-skill-filesystem` | 本地 provider；config `providerName`（默认 `filesystem`）、`includeDefaultRoots`（默认 true）、`dshHome`（默认 `$DSH_HOME` 或 `~/.dsh`；**显式空串会 resolve 成 cwd，不能传 ""**）、`agentsHome`、`customSkillDirs`（默认 []，rank 300）、`watch`（默认 true，chokidar 深度 1）、`bundledSkillDir`（rank 600；未配置且 `includeDefaultRoots=true` 时读 `$DSH_BUNDLED_SKILL_DIR`）、其余 `watch*` 调优字段。默认根优先级：project-dsh 100 `<projectRoot>/.dsh/skills` → project-agents 200 → custom 300 → user-dsh 400 `<dshHome>/skills`（跳过 `.system`）→ user-agents 500 → bundled 600。技能格式：目录包 `<name>/SKILL.md` 或平铺 `<name>.md`；frontmatter 必填 `name`/`description`，可选 `whenToUse`/`metadata`/`disable-model-invocation`/`user-invocable`；发现只解析 frontmatter，每次加载重读正文 |
| `@deepseek-ai/dsh-tool-skill` | durable session catalog（模型可调用技能存在且 `skill` 工具可见时，首个请求前注入 user-role `<available_skills>` 消息；变更时追加完整替换，全删时追加空目录）；`skill` 工具加载正文为 canonical `<skill_content>` 块；`/name` 出现在**直接用户输入**中且命名 user-invocable 技能时，把同一 `<skill_content>` 作为 user-role instructions context 注入该 step；config `catalogDescriptionMaxLength`（默认 500，最小 3）；`inject ["tools","skills","agents","workingDirectory"]` |

## 21.3 设计

### 21.3.1 三行装配

```
$DSH_HOME/skills/**  ┐
customSkillDirs      ├─► dsh-skill-filesystem ─► ctx.skills ◄─ dsh-tool-skill ─► catalog + skill 工具 + /name
${package}/share/skills (bundled, 只读) ┘              ▲
                                        dsh-skill (registry)
```

- 行顺序：`skill` → `skill-filesystem` → `tool-skill`，放在工具区（`tool-fs*` 之后、Web 之前）。
- `includeDefaultRoots: true` 保留 project/user 根；`dshHome` 传 `$DSH_HOME`（空值回退默认，见 21.2.2）；`customSkillDirs` 来自 `NOKORIBI_SKILL_DIRS`（冒号分隔）；`bundledSkillDir` 来自 `NOKORIBI_BUNDLED_SKILLS`；`watch: true` 让 `$DSH_HOME/skills` 的新增/改名/删除实时生效。
- 发行版默认 `bundledDir = ${package}/share/skills`（只读、随 Nix 构建）；`$DSH_HOME/skills` 可写，供模型/用户本地扩展。
- `skill.enable=false`：三行一起 disabled（catalog 与工具都不注册；provider 不再扫描目录）。

### 21.3.2 随发行版的技能

`skills/` 目录只放两个目录包（`skills/<name>/SKILL.md`），Nix 原样复制到 `share/skills`：

| 技能 | 用途 | 正文要点 |
|---|---|---|
| `nokoribi-deploy` | NixOS 部署/升级后验证 | `systemctl status/restart`、`journalctl -u nokoribi-agent`、`/v1/status?full=1`、就绪/锁/恢复、outbox 与 goal 恢复、部署清单指向 [12.12](12-nixos-deployment.md) |
| `nokoribi-debug` | daemon 故障与单会话排障 | journald 关键字（startup-error/ready/锁）、`$DSH_HOME/run/*.json`、`sessions/*.jsonl`、`/clear`、`/status full`、memory/schedule/goal 的排障顺序 |

两个技能都同时 `modelInvocable`/`userInvocable`（省略 invocation 字段即默认允许），正文 ≤ ~120 行，不放秘密/易变事实（易变事实进 memory）。

### 21.3.3 `/name` 调用链

1. 用户在 IM/本地测试通道发送 `/nokoribi-debug ...`。
2. channel-core 必须把**未知**斜杠命令当作普通用户消息交给 agent（channel 所有者的早期改动；M12 不注册任何 command）。
3. `dsh-tool-skill` 的 pre-step 手势监听扫描 claimed 用户消息，命中 workspace catalog 中 user-invocable 技能后把 `<skill_content>` 作为 user-role instructions context 注入该步。
4. 模型看到 `<skill_content>` 后按指示执行；catalog 文案要求“不要再用 `skill` 工具重复加载”。

若 channel passthrough 尚未合入，M12 的进程测试只覆盖 catalog/工具/停用三段，`/name` 段标记 pending 并报告；**不修改 channel-core**（越界）。

## 21.4 配置

### 21.4.1 bundle 默认（开发/非 Nix）

| 行 | config |
|---|---|
| `skill` | 无（`collectCacheMaxEntries` 默认 128）；`disabled: NOKORIBI_SKILL_ENABLED=false` |
| `skill-filesystem` | `includeDefaultRoots: true`；`dshHome: $DSH_HOME \|\| undefined`；`customSkillDirs: (NOKORIBI_SKILL_DIRS ?? '').split(':').map(trim).filter(Boolean)`；`bundledSkillDir: NOKORIBI_BUNDLED_SKILLS \|\| undefined`；`watch: true`；`disabled` 同上 |
| `tool-skill` | `catalogDescriptionMaxLength: NOKORIBI_SKILL_DESCRIPTION_MAX ?? 500`；`disabled` 同上 |

环境变量（dev，`.env.example`）：`NOKORIBI_SKILL_ENABLED`（true）、`NOKORIBI_SKILL_DIRS`（冒号列表）、`NOKORIBI_BUNDLED_SKILLS`、`NOKORIBI_SKILL_DESCRIPTION_MAX`（500）。**传空串给 `dshHome`/`bundledSkillDir` 会被 resolve 成 cwd，必须用 `|| undefined` 而不是 `?? ''`**（实现偏差，见 21.8）。

### 21.4.2 NixOS 选项

```nix
services.nokoribi-agent.skill = {
  enable = true;
  customDirs = [];                 # 追加只读技能根（rank 300）
  bundledDir = null;               # null -> ${package}/share/skills
  catalogDescriptionMaxLength = 500;
};
```

overlay（启用）：`skill-filesystem` 全量 config `{includeDefaultRoots=true; dshHome=cfg.dshHome; customSkillDirs=cfg.skill.customDirs; bundledSkillDir=bundledSkillsDir; watch=true;}`；`tool-skill` `{catalogDescriptionMaxLength=...;}`；`skill` 行不 patch（bundle 默认启用、无配置）。停用：三行 `disabled = true`（不写 config）。

## 21.5 信任边界与安全

- **技能正文是模型可见指令**：cadet 的 SKILL.md 等价于持久化操作指令。bundled 根是仓库/发行版可信只读内容；`customSkillDirs` 是运维可信输入；`$DSH_HOME/skills` 可被模型用 `write`/`edit` 写入（Auto review 审查写操作），属于**持久化提示注入面**（模型可写目录 → 未来会话自动加载）。缓解：catalog 仅展示 name+description；加载需模型/用户显式选择；写入仍过 reviewer；部署方可用 `skill.enable=false` 或空 `$DSH_HOME/skills` 收紧。残余风险登记 [15](15-verification-and-risks.md)。
- **无远程源**：不访问网络，无供应链/下载校验面。
- **资源提示不是附件**：provider 只告诉模型 base 目录，模型要按 fs 工具策略读文件（工作区/主机边界沿用 fs 工具）。
- **Nix 只读**：`share/skills` 来自 store，servce 用户不可写；自定义根由运维保证权限。

## 21.6 测试

进程测试（`tests/process/m12-skills.test.ts`，fake LLM + local-test 通道 + `NOKORIBI_BUNDLED_SKILLS=<repo>/skills`）：

1. **catalog**：首个 fake LLM 请求的 messages 中包含 `<available_skills>` 且有 `nokoribi-debug`/`nokoribi-deploy`（durable user-role 消息）。
2. **工具加载**：脚本化 `skill` 调用 `{name:"nokoribi-debug"}` → 下一请求 messages 含 `<skill_content name="nokoribi-debug">` 与正文片段（如 `journalctl -u nokoribi-agent`）→ 最终 outbound 回复。
3. **`/name` 注入**：发送 `/nokoribi-debug` 用户消息 → 请求中含 `<skill_content`（依赖 channel passthrough；未合入时按 21.3.3 降级并记录）。
4. **停用**：`NOKORIBI_SKILL_ENABLED=false` → 首请求 tools 不含 `skill`、messages 不含 `<available_skills>`。

Nix/打包门禁：`module-eval` 断言启用时 `skill-filesystem`/`tool-skill` 全量 config 与 `bundledSkillDir` 以 `share/skills` 结尾；停用时三行 disabled 且无 config；`package-smoke` 断言 `${package}/share/skills/nokoribi-deploy/SKILL.md` 与 `nokoribi-debug/SKILL.md` 存在。

## 21.7 验收与门禁

| 门禁 | 内容 | 状态 |
|---|---|---|
| G-M12-1 | `vitest run --config vitest.process.config.ts tests/process/m12-skills.test.ts` 3 场景通过（catalog/工具加载/`/name` 注入/停用；channel passthrough 已合入） | **通过（本地，2026-10-30）** |
| G-M12-2 | `nix build .#default` + `package-smoke`（share/skills 两技能 + bundle 依赖解析） | **通过（本地，2026-10-30）** |
| G-M12-3 | module-eval 启用/停用断言 | **通过（本地，2026-10-30）** |
| G-M12-4 | 目标机：`$DSH_HOME/skills` 运行时新增技能下轮 catalog 出现；`/name` 在真实 QQ 通道可用 | 待目标机 |

## 21.8 实现记录与偏差（2026-10-29）

- 新增依赖：`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-tool-skill`（均 0.2.1-rc.3，`packages/bundle`）；lock 与 `nix/deps.nix` 哈希更新。
- bundle 三行 + env 开关；仓库新增 `skills/nokoribi-deploy/SKILL.md`、`skills/nokoribi-debug/SKILL.md`；`nix/package.nix` 复制 `skills/` → `$out/share/skills`。
- Nix `skill.*` 选项、overlay 行、module-eval/package-smoke 断言、`flake.nix` 样例选项。
- **偏差**：计划写 `dshHome: process.env.DSH_HOME ?? ''`；空串会被上游 `resolve()` 解析成 cwd（会扫工作区当 $DSH_HOME）。实现改为 `process.env.DSH_HOME || undefined`（未设置时用上游默认 `$DSH_HOME`/`~/.dsh`）；`bundledSkillDir` 同理，未设置时传 `undefined` 以保持“不挂 bundled 根”。已报告 Lead。
- `/name` 依赖 channel-core 未知命令 passthrough（channel 所有者的 M14 早期改动）；测试与 21.6 一致，未合入则降级记录。
- `whenToUse` 只作 frontmatter 元数据，catalog 不渲染（上游限制）。
- 门禁结果（2026-10-30）：3 个进程场景（catalog 含两技能、`skill` 工具加载正文、`/nokoribi-debug` 用户消息注入 `<skill_content>`、停用无 catalog/工具）通过；`package-smoke` 断言 `share/skills/nokoribi-{deploy,debug}/SKILL.md` 存在，并验证 bundle 能解析 `dsh-skill`/`dsh-skill-filesystem`/`dsh-tool-skill`。

## 21.9 未决项

- 远程技能源/市场（明确不做，后续若做需要信任与签名设计）。
- 技能正文长度上限（上游无 cap；靠作者自律与 reviewer）。
- `/name` 在 QQ 群/C2C 的渲染与权限（与 M14/M15 一并目标机验证）。
- 模型自建技能生命周期（`write` 到 `$DSH_HOME/skills` 的提示注入风险是否需要额外审批/禁用开关）。
