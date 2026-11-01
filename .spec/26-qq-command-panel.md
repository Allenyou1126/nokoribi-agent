# 26 QQ 指令面板自动同步（M18）

> 状态：**代码完成（2026-11-01），真实平台门禁 V23 待执行**。仅同步 **C2C 单聊**面板；群聊面板不做。实现口径见 [D184](03-decision-log.md)，平台事实见 [notes/qq-official-bot-api-facts.md](notes/qq-official-bot-api-facts.md) §6.6，门禁记录见 [notes/qq-fact-gate.md](notes/qq-fact-gate.md) #21–#23。

## 26.1 目标与非目标

**目标**：QQ 官方 Bot 的 C2C 指令面板自动反映主 agent 当前可用的全部已注册斜杠命令。启动后、命令注册表变化时自动同步；用户点击面板项后，`/name` 被填入输入框，发送后仍由 channel-core 的 `ctx.commands` 正常执行。

**做**：

- `ChannelDriver` 新增可选 `syncCommands`；channel-core 在 runtime 挂载、driver 注册、`commands/change` 时发布 `CommandRuntime.list(mainAgent)`。
- QQ driver 通过 `/v2/panels` 创建/更新一个 `scope=c2c`、`target_type=all`、固定 `remark` 的面板。
- 命令名 `/name`、描述截断、20 项上限、幂等更新、失败不阻塞、可重试错误单次重试。
- NixOS `channel.qqBot.commandPanel` 与 bundle env `NOKORIBI_QQ_BOT_COMMAND_PANEL`（默认 `true`）。

**不做**：

- 群聊（group）面板：不请求 `scope=group`，不创建/更新群面板。
- 频道/Guild 全局指令（旧 `/v2/apps/{appid}/commands`）。
- skills（`/skill-name`）或未知斜杠透传命令进入面板。
- `target_type=specific` 的用户定向面板、target 修改接口。
- >20 命令的多面板拆分、link 项、自定义菜单 `/v2/menu`。
- `commandPanel=false` 时删除已有面板；运行期轮询面板变化；命令描述本地化。

## 26.2 平台事实

| 事实 | 值 | 来源 |
|---|---|---|
| 创建面板 | `POST /v2/panels`，10 QPM；`scope=c2c|group|channel|dm`，`target_type=all|specific` | [创建指令面板](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html) |
| 列表 | `GET /v2/panels?scope=...`，30 QPM，分页 `cursor/limit`（默认 20，最大 50） | [查询指令面板列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.get.html) |
| 修改 | `PUT /v2/panels/{panel_id}`，10 QPM，覆盖 items/remark，不影响关联对象 | [修改指令面板](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.put.html) |
| 详情/删除 | `GET/DELETE /v2/panels/{panel_id}` | [详情](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.get.html)、[删除](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.delete.html) |
| 数量限制 | 一个机器人最多 20 个面板；一个面板最多 20 个元素 | 同上 |
| `PanelItem` | `type=command|link`；`name` ≤14 字符；`desc` ≤30 字符；`remark` ≤255 | 同上 |
| 点击语义 | `type=command` 时 `name` 原样填入聊天输入框；不会替框架注册指令 | 官方文档 + 第三方 [Kokkoro](https://kokkoro.js.org/develop/command) |
| 业务错误 | HTTP 200 + body `code`；`40030006/40030011/40030012/40030013/40030015/40030018/40030020/40030021` 等 | 官方文档 |
| 空列表响应（实测） | 无面板时 `GET /v2/panels` 返回 HTTP 200 `{"is_end":true}`，**省略 `records`/`next_cursor`**；适配器按空列表处理 | 2026-11-01 hkg-dog-darell 实测（AppID 102816855） |

结论：面板项 `name` 必须写 `/name`；本适配器只创建 c2c 全局面板。

## 26.3 设计

### 26.3.1 channel-core 通用 seam

- `contract.ts` 新增 `ChannelCommand { name; description }`；`ChannelDriver.syncCommands?(commands)` 为可选、best-effort，不得影响消息收发。
- `service.ts` 的 `publishCommands()`：读 `runtime.commands.list(runtime.agent)`，映射为 `{name, description}`，逐个 driver 调用；`commands.list` 或 driver 抛错只 warn。
- 触发点：`attachRuntime()` 末尾、`registerDriver()` 成功且已有 runtime、`ctx.on("commands/change")`。
- 无 driver 实现 `syncCommands` 时提前返回，不读命令表；core 不做去抖，QQ 面板层自行串行/去重。

### 26.3.2 QQ 面板协调器

- 固定 `remark = "nokoribi-agent:slash-commands"`；每次同步先 `GET` 列表，按 remark 认领面板：
  - 无匹配 → `POST` 创建；
  - 有匹配且 items 语义相同 → 跳过；
  - 有匹配且不同 → `PUT` 覆盖；
  - 多个匹配 → 更新最新一个并 warn，不删除；
  - `target_type !== "all"` → warn，仍更新 items（不修改 target）。
- 空列表容错：`records` 缺失或为 `null` 时视为空列表（真实平台无面板时只回 `{"is_end":true}`，2026-11-01 实测）；只有 `records` 存在但不是数组才视为畸形响应并放弃本轮。
- **不重复创建**：`GET` 失败直接放弃本轮，不盲目 `POST`；`POST` 成功但响应丢失时，下次 `GET` 命中后转为更新。单 daemon 正常启动/重启不会产生重复面板（详见 26.5）。
- 单实例串行：`sync()` 运行中只保留最新目录；items 签名相同跳过写；命令减少时覆盖为最新列表。
- 命令映射：按 name 排序；`name = "/" + command.name`；超过 14 字符跳过（截断会破坏命令）；描述折叠空白并按 code point 截到 30（29 + `…`），空描述回退命令名；最多 20 项。
- 失败：每个 scope 独立 try/catch；`classifySendError` 为 `retry`/`auth` 时 30s 后单次重试，永久错误不重试；`stop()` 清理重试并等待在途同步。

### 26.3.3 数据流

```
daemon createAgent + registerCommands
  → channel-core attachRuntime
  → publishCommands()（commands.list(mainAgent)）
  → QqBotDriver.syncCommands
  → QqCommandPanel.sync
  → GET /v2/panels?scope=c2c → POST/PUT（或跳过）
```

## 26.4 配置

NixOS：

```nix
channel.qqBot.commandPanel = true;  # false: 不读写任何面板
```

bundle/开发环境：`NOKORIBI_QQ_BOT_COMMAND_PANEL`（默认 `true`）。`commandPanel=false` 不删除已有面板；需要清理时手动调用面板删除接口或在开放平台处理。

## 26.5 失败模式与边界

| 场景 | 行为 |
|---|---|
| 面板 API 无权限/不可用 | 每轮 warn，daemon 正常 ready；消息闭环不受影响 |
| `GET` 失败 | 放弃本轮，不 `POST`；可重试错误 30s 后单次重试 |
| `GET` 空列表（无 `records`） | 视为空列表，继续 `POST` 创建（2026-11-01 实机修复，D185） |
| `POST` 成功但响应丢失 | 下次 `GET` 命中 remark 后更新，不重复创建 |
| 单 daemon 启动/重启 | 先 `GET` 认领，不会重复创建 |
| 多 daemon 共用同一 AppID | 同 remark 后写者覆盖；可能出现多个同 remark 面板，只更新最新一个并 warn，不自动删除（已知限制） |
| 历史遗留多个同 remark 面板 | 同上，不自动删除 |
| 外部删除面板 | 下次启动/命令变化时重建；运行期不轮询 |
| 命令 >20 | 前 20 个进入面板，其余仍可手输；warn |
| 命令名 `/name` >14 | 跳过 + warn |
| 描述 >30 | 截断 + `…` |
| 空命令集 | 跳过，不创建空面板 |
| `commandPanel=false` | 不请求 `/v2/panels`，不删除已有面板 |

## 26.6 安全与风险

- 面板内容仅为命令名与描述（代码内公开文案）；不得把 secret、内部 URL、用户数据写入 command description（命令描述会展示给用户）。
- 面板写入使用 Bot access token，属 app 级配置；默认开启，可用 `commandPanel=false` 关闭。
- 面板是发现性能力，失败不改变消息闭环与审批/提问路径；Auto review 不覆盖面板同步（非工具调用），但也不接触用户消息内容。
- 群聊面板未实现：群聊命令仍依赖用户手动 @bot 输入；不在 V23 验收范围。

## 26.7 测试

- `packages/channel-core/test/service-commands.test.ts`：attach 发布、`commands/change` 重发、无 publisher driver 不读目录。
- `packages/channel-qq-bot/test/panel.test.ts`：items 映射/截断/上限；创建、更新、跳过、ignored remark、多面板、重试/停止、空目录；断言只请求 c2c。
- `packages/channel-qq-bot/test/rest.test.ts`：面板 GET/POST/PUT、query、HTTP 200 业务错误、空列表响应（`{"is_end":true}` / `records:null`）容错与畸形 `records` 拒绝。
- `packages/channel-qq-bot/test/{config,driver}.test.ts`：默认开关、关闭时不触达 client、`syncCommands` 转发。
- `tests/process/m18-qq-command-panel.test.ts`：daemon + fake QQ 启动后一个 c2c 面板包含全部命令、无 group 请求；`NOKORIBI_QQ_BOT_COMMAND_PANEL=false` 无面板请求。
- 现有 M8/M9/M14/M15 进程/集成测试回归。

## 26.8 真实平台门禁 V23

> 需要真实 Bot（AppID/ClientSecret、开发体验用户）。执行前只可标“代码完成”。

1. C2C 面板 API 可用性：`GET /v2/panels?scope=c2c` 正常；daemon 启动后创建一个面板；记录权限/错误码。**2026-11-01 首次实测：`GET` 可达、鉴权正常，无面板时返回 200 `{"is_end":true}`（省略 `records`）；适配器已容错（D185），面板创建仍待验证。**
2. C2C 客户端可见性：输入框 `/` 出现面板；点击项后 `/name` 原样插入；发送后命令执行（至少 `/stop`、`/status`、`/steer`、`/queue`）。
3. 重启幂等：连续重启 daemon 不产生第二个同 remark 面板；面板 items 与命令表一致；`commandPanel=false` 无写请求。
4. 限制/错误：20 项上限、14/30 字符上限、`40030020` 内容安全、`40030013` 数量限制的实际表现，必要时回写规格。

## 26.9 文件清单与实现记录

新增：`packages/channel-qq-bot/src/panel.ts`、`packages/channel-qq-bot/test/panel.test.ts`、`packages/channel-core/test/service-commands.test.ts`、`tests/process/m18-qq-command-panel.test.ts`、本规格。

修改：`packages/channel-core/src/{contract,service}.ts`；`packages/channel-qq-bot/src/{config,driver,index,rest}.ts` 及其测试；`tests/process/support/fake-qq-bot.ts`；`tests/integration/{m14-message-media,m15-question-buttons}.test.ts`（commands mock）；`packages/bundle/cordis.patch.yml`；`nix/{module,overlay}.nix`、`nix/check-module.py`；`.env.example`；`packages/launcher/src/index.ts`；`README.md`、`AGENTS.md` 与 `.spec/03/06/12/13/14/15/16/17`、notes。

实现日期：2026-11-01。本地门禁见 [13.1](13-testing-and-ops.md)。

实机修复（2026-11-01）：首次在 hkg-dog-darell 启动发现 `GET /v2/panels` 在无面板时返回 200 `{"is_end":true}`（省略 `records`），旧校验误判为响应错误，同步在 `GET` 阶段中止、面板从未创建；`listPanels` 改为缺失/`null` 视为空列表，并补 rest 单测（D185）。

## 26.10 待决/后续

- 群聊面板（若平台行为明确后再评估）。
- 超过 20 条命令时的多面板拆分或精选列表。
- 多 daemon 共用 AppID 的面板所有权/协调策略（当前 last-writer-wins）。
