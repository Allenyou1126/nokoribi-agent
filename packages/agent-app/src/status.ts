import type {
    FullGoalStatus,
    FullSandboxStatus,
    FullScheduleStatus,
    FullStatusDetails,
} from "@nokoribi/channel-core";

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
    };
}

function formatGoal(goal: FullGoalStatus): string {
    const sandbox =
        goal.sandbox === null
            ? "-"
            : goal.sandbox.error !== undefined
              ? `error(${goal.sandbox.error})`
              : `gen=${String(goal.sandbox.generation)} active=${String(goal.sandbox.activeCommands)}`;
    return (
        `- ${goal.shortId} phase=${goal.phase} ` +
        `rounds=${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)} ` +
        `child=${goal.childStatus} model=${goal.model ?? "-"} ` +
        `objective=${goal.objective} sandbox=${sandbox}`
    );
}

function formatSandbox(sandbox: FullSandboxStatus): string {
    if (sandbox.error !== undefined) {
        return `- ${sandbox.host}/${sandbox.sessionId} error=${sandbox.error}`;
    }
    return (
        `- ${sandbox.host}/${sandbox.sessionId} ` +
        `gen=${String(sandbox.generation)} exists=${String(sandbox.exists)} ` +
        `active=${String(sandbox.activeCommands)} ` +
        `background=${String(sandbox.backgroundCommands)} ` +
        `ttl=${String(sandbox.idleTtlMs)} ` +
        `packages=${sandbox.packages.join(",") || "(none)"} ` +
        `lastUsed=${sandbox.lastUsedAt ?? "-"}`
    );
}

function formatSchedule(schedule: FullScheduleStatus): string {
    return (
        `- ${schedule.id} [${schedule.kind}] ${schedule.title} ` +
        `at=${schedule.scheduledAt} state=${schedule.state}`
    );
}

/**
 * Render the detailed status block for `/status full`.
 * @param details - assembled full status.
 * @returns stable newline-separated text without secrets or message bodies.
 */
export function formatFullStatus(details: FullStatusDetails): string {
    const reviewer =
        details.reviewer === null
            ? "(not configured)"
            : `fast=${details.reviewer.fast.provider}/${details.reviewer.fast.model} ` +
              `strong=${details.reviewer.strong.provider}/${details.reviewer.strong.model} ` +
              `timeoutMs=${String(details.reviewer.timeoutMs)}`;
    const lines = [
        `workspace: ${details.workspace}`,
        `state: ${details.state}`,
        `lock: ${details.lock}`,
        `storage: ${details.storage}`,
        `dsh: ${details.dshVersion}`,
        `app: ${details.appVersion}`,
        `model: ${details.model.provider}/${details.model.model}${
            details.model.reasoningEffort === undefined
                ? ""
                : ` (${details.model.reasoningEffort})`
        }`,
        `reviewer: ${reviewer}`,
        `lastVersion: ${details.lastVersion}`,
        `lastStarted: ${details.lastStartedAt ?? "-"}`,
        `restart: ${details.restartReason ?? "-"}`,
        `nextOutboxSeq: ${String(details.nextOutboxSeq)}`,
        `memory: active=${String(details.memory.activeEntries)} ` +
            `archived=${String(details.memory.archivedEntries)} ` +
            `invalid=${String(details.memory.invalidEntries)} ` +
            `bytes=${String(details.memory.bytes)}`,
        "goals:",
        ...(details.goals.length === 0
            ? ["- (none)"]
            : details.goals.map((goal) => formatGoal(goal))),
        "schedules:",
        ...(details.schedules.length === 0
            ? ["- (none)"]
            : details.schedules.map((schedule) => formatSchedule(schedule))),
        "sandboxes:",
        ...(details.sandboxes.length === 0
            ? ["- (none)"]
            : details.sandboxes.map((sandbox) => formatSandbox(sandbox))),
        "recentErrors:",
        ...(details.recentErrors.length === 0
            ? ["- (none)"]
            : details.recentErrors.map(
                  (entry) =>
                      `- ${entry.at} ${entry.level} ${entry.module} ${entry.message}`
              )),
    ];
    return lines.join("\n");
}
