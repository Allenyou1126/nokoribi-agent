import type {
    DaemonStatus,
    FullGoalStatus,
    FullMemoryStatus,
    FullSandboxStatus,
    FullScheduleStatus,
    FullStatusDetails,
} from "@nokoribi/channel-core";

import {
    AGENT_STATUS_LABELS,
    CHANNEL_STATE_LABELS,
    formatBytes,
    formatDuration,
    GOAL_CHILD_LABELS,
    GOAL_PHASE_LABELS,
    labelOf,
    LOG_LEVEL_LABELS,
    MEMORY_INJECT_LABELS,
    PERMISSION_PRESET_LABELS,
    RESTART_REASON_LABELS,
    SCHEDULE_KIND_LABELS,
    SCHEDULE_STATE_LABELS,
} from "./labels.js";

function text(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function orUnknown(value: string): string {
    return value === "" ? "（未知）" : value;
}

/**
 * Normalize a provider-owned status value into the public status shape.
 * @param host - shell host id.
 * @param sessionId - session owning the host instance.
 * @param value - value returned by `ctx.shellHosts.status`.
 * @returns a stable full-status record.
 */
export function normalizeSandboxStatus(
    host: string,
    sessionId: string,
    value: unknown
): FullSandboxStatus {
    const record =
        typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
    const createdAt = record["createdAt"];
    const lastUsedAt = record["lastUsedAt"];
    return {
        host,
        sessionId,
        dir: text(record["dir"]),
        exists: record["exists"] === true,
        generation: number(record["generation"]),
        packages: stringList(record["packages"]),
        createdAt: typeof createdAt === "string" ? createdAt : null,
        lastUsedAt: typeof lastUsedAt === "string" ? lastUsedAt : null,
        idleTtlMs: number(record["idleTtlMs"]),
        activeCommands: number(record["activeCommands"]),
        backgroundCommands: number(record["backgroundCommands"]),
        terminalSessions: number(record["terminalSessions"]),
    };
}

function packagesText(packages: readonly string[]): string {
    if (packages.length === 0) return "（无）";
    return `${String(packages.length)} 个（${packages.join("、")}）`;
}

/**
 * Render one sandbox status as descriptive text without internal field names.
 * @param sandbox - normalized sandbox status.
 * @returns a Chinese one-line summary; a failed read keeps its error text.
 */
export function formatSandboxDetail(sandbox: FullSandboxStatus): string {
    if (sandbox.error !== undefined) return `读取失败（${sandbox.error}）`;
    return [
        `第 ${String(sandbox.generation)} 代`,
        `目录${sandbox.exists ? "存在" : "不存在"}`,
        `活动命令 ${String(sandbox.activeCommands)}`,
        `后台命令 ${String(sandbox.backgroundCommands)}`,
        `持久终端 ${String(sandbox.terminalSessions)}`,
        `空闲回收 ${formatDuration(sandbox.idleTtlMs / 1000)}`,
        `临时包：${packagesText(sandbox.packages)}`,
        `最近使用 ${sandbox.lastUsedAt ?? "无记录"}`,
    ].join(" · ");
}

function goalSandboxText(sandbox: FullGoalStatus["sandbox"]): string {
    if (sandbox === null) return "沙箱未创建";
    if (sandbox.error !== undefined) {
        return `沙箱读取失败（${sandbox.error}）`;
    }
    return `沙箱第 ${String(sandbox.generation)} 代（活动命令 ${String(
        sandbox.activeCommands
    )}）`;
}

function formatGoal(goal: FullGoalStatus): string {
    return (
        `· ${goal.shortId}：${labelOf(GOAL_PHASE_LABELS, goal.phase)} · ` +
        `轮次 ${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)} · ` +
        `子会话 ${labelOf(GOAL_CHILD_LABELS, goal.childStatus)} · ` +
        `模型 ${goal.model ?? "默认"} · ${goalSandboxText(goal.sandbox)} · ` +
        `目标：${goal.objective}`
    );
}

function formatSchedule(schedule: FullScheduleStatus): string {
    return (
        `· ${schedule.id}：${schedule.title} · ` +
        `${labelOf(SCHEDULE_KIND_LABELS, schedule.kind)} · ` +
        `触发 ${schedule.scheduledAt} · ` +
        `${labelOf(SCHEDULE_STATE_LABELS, schedule.state)}`
    );
}

function formatSandbox(sandbox: FullSandboxStatus): string {
    return `· ${sandbox.host} / ${sandbox.sessionId}：${formatSandboxDetail(sandbox)}`;
}

function formatRecentError(
    entry: FullStatusDetails["recentErrors"][number]
): string {
    return (
        `· ${entry.at} ${labelOf(LOG_LEVEL_LABELS, entry.level)} ` +
        `${entry.module}：${entry.message}`
    );
}

function permissionText(permission: string | null): string {
    if (permission === null) return "未就绪";
    const label = (PERMISSION_PRESET_LABELS as Record<string, string>)[
        permission
    ];
    return label === undefined ? permission : `${permission}（${label}）`;
}

function channelText(channels: DaemonStatus["channels"]): string {
    if (channels === undefined || channels.length === 0) return "（无）";
    return channels
        .map(
            (channel) =>
                `${channel.id} ${labelOf(CHANNEL_STATE_LABELS, channel.state)}`
        )
        .join(" · ");
}

const GOAL_PHASE_ORDER: readonly string[] = Object.keys(GOAL_PHASE_LABELS);

function goalBreakdown(goals: readonly unknown[]): string {
    const counts = new Map<string, number>();
    for (const goal of goals) {
        if (typeof goal !== "object" || goal === null) continue;
        const phase = (goal as { phase?: unknown }).phase;
        if (typeof phase !== "string") continue;
        counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const phase of GOAL_PHASE_ORDER) {
        const count = counts.get(phase);
        if (count === undefined || count === 0) continue;
        parts.push(`${labelOf(GOAL_PHASE_LABELS, phase)} ${String(count)}`);
    }
    return parts.join(" · ");
}

/**
 * Render the `/status` summary block.
 * @param status - current daemon status document.
 * @param model - effective main model route for display.
 * @returns stable newline-separated Simplified-Chinese text.
 */
export function formatStatusSummary(
    status: DaemonStatus,
    model: string
): string {
    const total = status.goals.length;
    const breakdown = goalBreakdown(status.goals);
    const goals =
        total === 0
            ? "Goal：0 个"
            : breakdown === ""
              ? `Goal：${String(total)} 个`
              : `Goal：${String(total)} 个（${breakdown}）`;
    return [
        "📊 运行状态",
        `主会话状态：${labelOf(AGENT_STATUS_LABELS, status.agentStatus)}`,
        `版本：${status.version} · 已运行 ${formatDuration(status.uptimeSec)}`,
        `主会话：${status.mainSessionId ?? "未就绪"}`,
        `模型：${model}`,
        `权限：${permissionText(status.permission)}`,
        goals,
        `待处理：审批/提问 ${String(status.pendingInteractions)} 条 · ` +
            `待发送 ${String(status.outboxLength)} 条 · ` +
            `延后通知 ${String(status.deferredNotices ?? 0)} 条`,
        `频道：${channelText(status.channels)}`,
        `上次重启：${
            status.lastRestartReason === null
                ? "无记录"
                : labelOf(RESTART_REASON_LABELS, status.lastRestartReason)
        }`,
    ].join("\n");
}

/**
 * Render the detailed status block for `/status full`.
 * @param details - assembled full status.
 * @returns stable newline-separated text without secrets or message bodies.
 */
export function formatFullStatus(details: FullStatusDetails): string {
    const lines: string[] = ["📋 详细状态", ""];
    const section = (title: string, entries: readonly string[]): void => {
        lines.push(
            `【${title}】`,
            ...(entries.length === 0 ? ["（无）"] : entries),
            ""
        );
    };

    section("环境", [
        `工作目录：${orUnknown(details.workspace)}`,
        `状态文件：${orUnknown(details.state)}`,
        `锁文件：${orUnknown(details.lock)}`,
        `存储目录：${orUnknown(details.storage)}`,
    ]);
    section("版本", [
        `DSH：${details.dshVersion} · 应用：${details.appVersion}`,
        `上次版本：${details.lastVersion}`,
        `上次启动：${details.lastStartedAt ?? "无记录"}`,
        `上次重启：${
            details.restartReason === null
                ? "无记录"
                : labelOf(RESTART_REASON_LABELS, details.restartReason)
        }`,
    ]);
    const effort = details.model.reasoningEffort?.trim();
    section("模型", [
        `主模型：${details.model.provider}/${details.model.model}${
            effort === undefined || effort === ""
                ? ""
                : `（推理强度 ${effort}）`
        }`,
        details.reviewer === null
            ? "审查模型：未配置"
            : `审查模型：快速 ${details.reviewer.fast.provider}/` +
              `${details.reviewer.fast.model} · 强化 ` +
              `${details.reviewer.strong.provider}/` +
              `${details.reviewer.strong.model} · 超时 ` +
              `${formatDuration(details.reviewer.timeoutMs / 1000)}`,
    ]);
    section("记忆", memoryLines(details.memory));
    section("投递", [`下一条待发送序号：${String(details.nextOutboxSeq)}`]);
    section(
        "Goal",
        details.goals.map((goal) => formatGoal(goal))
    );
    section(
        "定时任务",
        details.schedules.map((schedule) => formatSchedule(schedule))
    );
    section(
        "沙箱",
        details.sandboxes.map((sandbox) => formatSandbox(sandbox))
    );
    section(
        "最近错误",
        details.recentErrors.map((entry) => formatRecentError(entry))
    );
    while (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
}

function memoryLines(memory: FullMemoryStatus): string[] {
    return [
        `条目：活跃 ${String(memory.activeEntries)} · 归档 ` +
            `${String(memory.archivedEntries)} · 无效 ` +
            `${String(memory.invalidEntries)} · 占用 ` +
            `${formatBytes(memory.bytes)}`,
        `快照：已 pin ${String(memory.pinnedEntries)} 条 · ` +
            `${String(memory.snapshotChars)} 字`,
        `自动注入：${labelOf(MEMORY_INJECT_LABELS, memory.inject)}`,
    ];
}
