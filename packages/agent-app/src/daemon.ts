import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-attachment";
import type {
    CommandInvocation,
    CommandResult,
} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-goal";
import type { AssistantMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-schedule";
import {
    SessionId,
    type Session,
    type SessionEvent,
    type TurnEndReason,
} from "@deepseek-ai/dsh-session";
import {
    SessionHandleClosedError,
    SessionPersistenceNotFoundError,
} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-subagent";
import type {
    FullGoalStatus,
    FullSandboxStatus,
    FullScheduleStatus,
    FullStatusDetails,
} from "@nokoribi/channel-core";
import "@nokoribi/channel-core";
import type {} from "@nokoribi/memory";
import {
    createLogger,
    defaultAgentState,
    ensureHomeDirs,
    loadAgentState,
    recentLogs,
    resolveHomePaths,
    resolvePackageVersion,
    saveAgentState,
    SingleInstanceLock,
    SystemdNotifier,
    writeJsonAtomic,
    type AgentState,
    type HomePaths,
    type Logger,
    type RestartReason,
} from "@nokoribi/shared";
import type {} from "@nokoribi/shell-bash";

import { createSendToUserTool, DEFAULT_SEND_FILE_MAX_BYTES } from "./files.js";
import { parseGoalCommand } from "./goals/commands.js";
import { installMainToolPolicy } from "./goals/main-policy.js";
import { GoalManager } from "./goals/manager.js";
import { formatModelRoute, parseAllowedModels } from "./goals/model.js";
import { createStartGoalTool } from "./goals/tool.js";
import { MemoryCurator } from "./memory/curator.js";
import { assistantText, planTurnEnd } from "./replies.js";
import type {} from "./session-bridge.js";
import { formatFullStatus, normalizeSandboxStatus } from "./status.js";
import { killTerminalsForAgent } from "./terminal-cleanup.js";

/** Resolved agent-app configuration. */
export interface AgentAppConfig {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly maxTokens?: number;
    readonly workspace?: string;
    readonly shutdownGraceMs: number;
    readonly version: string;
    /** Goal-child provider; defaults to the main provider. */
    readonly goalProvider?: string;
    /** Goal-child model; defaults to the main model. */
    readonly goalModel?: string;
    /** Goal-child reasoning effort; defaults to the main effort. */
    readonly goalReasoningEffort?: string;
    /** Exact provider/model routes accepted for goal children. */
    readonly goalModels?: readonly string[];
    /** Round cap for goals that omit an explicit max (default 256). */
    readonly goalDefaultMaxRounds?: number;
    /** Bound for one cold goal recovery. */
    readonly goalRecoveryTimeoutMs?: number;
    /** Upper bound for one outbound file from `send_to_user` (default 32 MiB). */
    readonly sendFileMaxBytes?: number;
    /** One-shot memory-curator route; defaults to the goal route. */
    readonly memoryProvider?: string;
    readonly memoryModel?: string;
    readonly memoryReasoningEffort?: string;
    /** Whether terminal goals trigger best-effort extraction (default true). */
    readonly memoryCurator?: boolean;
    readonly memoryCuratorTimeoutMs?: number;
    /** Fast reviewer route, shown by `/status full`. */
    readonly reviewFastProvider?: string;
    readonly reviewFastModel?: string;
    readonly reviewFastReasoningEffort?: string;
    /** Strong reviewer route, shown by `/status full`. */
    readonly reviewStrongProvider?: string;
    readonly reviewStrongModel?: string;
    readonly reviewStrongReasoningEffort?: string;
    readonly reviewTimeoutMs?: number;
}

function isNotFound(error: unknown): boolean {
    return (
        error instanceof SessionPersistenceNotFoundError ||
        (error instanceof Error &&
            error.name === "SessionPersistenceNotFoundError")
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a shutdown flush failed only because persistence teardown already
 * closed the session handle. Cordis disposes plugin effects concurrently, so
 * the persistence backend's handle teardown can win the race against this
 * daemon's shutdown effect. A closed write handle is still safe: the backend's
 * `close()` drains its routed buffer through still-open storage before
 * releasing it, so the flush is redundant rather than failed. The backend's
 * own service-wide `flushAll()` skips the same error for the same reason.
 */
function isClosedHandleFlush(error: unknown): boolean {
    if (error instanceof SessionHandleClosedError) return true;
    return (
        error instanceof AggregateError &&
        error.errors.length > 0 &&
        error.errors.every((inner) => inner instanceof SessionHandleClosedError)
    );
}

function normalizeEffort(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Daemon lifecycle: lock, state, main agent create/resume, command surface,
 * reply mirroring, system notices, and graceful shutdown.
 */
export class Daemon {
    private readonly ctx: Context;
    private readonly config: AgentAppConfig;
    private readonly paths: HomePaths;
    private readonly logger: Logger;
    private readonly goals: GoalManager;
    private readonly curator: MemoryCurator;
    private readonly notifier: SystemdNotifier;
    private readonly goalConfigError: Error | undefined;
    private readonly turnText = new Map<number, string>();
    private lock: SingleInstanceLock | undefined;
    private state: AgentState | undefined;
    private handle: AgentHandle | undefined;
    private mainSessionId: string | null = null;
    private ready = false;
    private shuttingDown = false;
    private clearing = false;
    private resumeMissing = false;
    private restartReason: RestartReason = "first-start";
    private stateChain: Promise<void> = Promise.resolve();

    constructor(ctx: Context, config: AgentAppConfig) {
        this.ctx = ctx;
        this.config = config;
        this.paths = resolveHomePaths(config.workspace);
        this.logger = createLogger("agent-app");
        this.notifier = new SystemdNotifier({ logger: this.logger });
        const goalEffortRaw =
            config.goalReasoningEffort ?? config.reasoningEffort;
        const goalEffort =
            goalEffortRaw === undefined || goalEffortRaw.trim() === ""
                ? undefined
                : goalEffortRaw;
        const memoryEffortRaw = config.memoryReasoningEffort ?? goalEffortRaw;
        const memoryEffort =
            memoryEffortRaw === undefined || memoryEffortRaw.trim() === ""
                ? undefined
                : memoryEffortRaw;
        let allowedModels: ReturnType<typeof parseAllowedModels> = [];
        let goalConfigError: Error | undefined;
        try {
            allowedModels = parseAllowedModels(config.goalModels ?? []);
        } catch (error) {
            goalConfigError =
                error instanceof Error ? error : new Error(String(error));
        }
        this.goalConfigError = goalConfigError;
        this.goals = new GoalManager(ctx, {
            provider: config.goalProvider ?? config.provider,
            model: config.goalModel ?? config.model,
            ...(goalEffort === undefined
                ? {}
                : { reasoningEffort: goalEffort }),
            allowedModels,
            defaultMaxRounds: config.goalDefaultMaxRounds ?? 256,
            recoveryTimeoutMs: config.goalRecoveryTimeoutMs ?? 30000,
            archivePath: this.paths.goalsArchivePath,
            notify: (text) => this.ctx.channels.notify(text),
            persist: () => this.persistSoon(),
            logger: this.logger,
        });
        this.curator = new MemoryCurator(
            ctx,
            this.goals,
            {
                enabled: config.memoryCurator ?? true,
                provider:
                    config.memoryProvider ??
                    config.goalProvider ??
                    config.provider,
                model: config.memoryModel ?? config.goalModel ?? config.model,
                ...(memoryEffort === undefined
                    ? {}
                    : { reasoningEffort: memoryEffort }),
                timeoutMs: config.memoryCuratorTimeoutMs ?? 60000,
            },
            this.logger
        );
    }

    /** Start the daemon; throws on lock, state, or session failures. */
    async start(): Promise<void> {
        await ensureHomeDirs(this.paths);
        this.ctx.effect(() => () => this.shutdown());
        try {
            if (this.goalConfigError !== undefined) {
                throw this.goalConfigError;
            }
            this.lock = SingleInstanceLock.acquire(
                this.paths.lockPath,
                this.config.version
            );
            this.ctx.shellHosts.requireDefaultHost();
            this.goals.install();
            if (this.ctx.get("memory") !== undefined) {
                this.curator.install();
            } else {
                this.logger.warn(
                    "memory service is disabled; curator extraction is off"
                );
            }
            this.ctx.effect(() =>
                this.ctx.tools.register(createStartGoalTool(this.goals))
            );
            this.ctx.effect(() =>
                this.ctx.tools.register(
                    createSendToUserTool({
                        workspaceDir: this.paths.workspaceDir,
                        maxBytes:
                            this.config.sendFileMaxBytes ??
                            DEFAULT_SEND_FILE_MAX_BYTES,
                        channels: this.ctx.channels,
                        saveFile: (input) =>
                            this.ctx.attachments.saveFile(input),
                        logger: this.logger,
                    })
                )
            );
            await this.ctx.channels.initialize();
            await this.recover();
        } catch (error) {
            this.notifier.stop();
            await unlink(this.paths.readyPath).catch(() => undefined);
            await writeJsonAtomic(this.paths.startupErrorPath, {
                message: errorMessage(error),
                pid: process.pid,
                at: new Date().toISOString(),
            }).catch(() => undefined);
            this.lock?.release();
            throw error;
        }
    }

    /** Stop accepting messages, wait briefly, flush, mark clean, release lock. */
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.ready = false;
        await this.notifier.stopping();
        this.ctx.channels.pause();
        await this.ctx.channels
            .abortInteractions("shutdown")
            .catch(() => undefined);
        const agent = this.handle?.agent;
        try {
            if (agent !== undefined) {
                await Promise.race([
                    agent.whenIdle(),
                    new Promise<void>((resolve) =>
                        setTimeout(resolve, this.config.shutdownGraceMs)
                    ),
                ]);
                if (agent.status === "running") {
                    agent.cancel({ kind: "disposed" });
                }
                await this.ctx.sessions.flush(agent.session);
            }
        } catch (error) {
            if (isClosedHandleFlush(error)) {
                // Persistence teardown closed the handle first; its close()
                // already drained the routed events. Keep this out of the
                // error log so a clean shutdown is not reported as failed.
                this.logger.debug(
                    "shutdown flush skipped: persistence already closed the session handle",
                    { error: errorMessage(error) }
                );
            } else {
                this.logger.error("shutdown flush failed", {
                    error: errorMessage(error),
                });
            }
        }
        if (agent !== undefined) {
            // Terminals are cleaned after the final flush and before the lock
            // is released; the helper bounds its own wait and only warns.
            await killTerminalsForAgent(this.ctx, agent, {
                logger: this.logger,
            });
        }
        try {
            if (this.state !== undefined) {
                await this.writeState(true);
            }
        } catch (error) {
            this.logger.error("failed to persist clean shutdown", {
                error: errorMessage(error),
            });
        } finally {
            await unlink(this.paths.readyPath).catch(() => undefined);
            this.notifier.stop();
            this.lock?.release();
            this.lock = undefined;
        }
    }

    private async recover(): Promise<void> {
        const loaded = await loadAgentState(this.paths.agentStatePath);
        if (loaded.corrupt) {
            this.restartReason = "state-corrupt";
        } else if (loaded.state === null) {
            this.restartReason = "first-start";
        } else {
            this.restartReason = loaded.state.cleanShutdown ? "clean" : "crash";
        }
        const previousId = loaded.state?.mainSessionId ?? null;
        this.state = {
            ...(loaded.state ?? defaultAgentState(this.config.version)),
            version: 1,
            cleanShutdown: false,
            lastStartedAt: new Date().toISOString(),
            lastVersion: this.config.version,
            lastRestartReason: this.restartReason,
            outboxSeq: this.ctx.channels.nextOutboxSeq - 1,
        };
        if (loaded.state === null) {
            this.state = {
                ...this.state,
                mainSessionId: null,
                archivedGoals: [],
                lastActiveChat: null,
            };
        }
        this.goals.load(loaded.state?.goals ?? []);
        await this.writeState(false);

        if (previousId !== null) {
            try {
                this.handle = await this.resumeAgent(previousId);
            } catch (error) {
                if (!isNotFound(error)) throw error;
                this.logger.warn("persisted main session missing; creating", {
                    session: previousId,
                });
                this.resumeMissing = true;
                this.handle = await this.createAgent();
            }
        } else {
            this.handle = await this.createAgent();
        }
        this.mainSessionId = this.handle.agent.id;
        this.ctx.sessionController.bind(this.handle.agent, Promise.resolve());
        await this.ctx.sessions.flush(this.handle.agent.session);
        await this.goals.bindMain(this.handle.agent);
        this.curator.bindMain(this.handle.agent);
        this.state = {
            ...this.state,
            mainSessionId: this.mainSessionId,
            outboxSeq: this.ctx.channels.nextOutboxSeq - 1,
        };
        await this.writeState(false);

        this.installSessionListener();
        this.registerCommands();
        this.installStatusProvider();
        await this.attachRuntime();
        this.ctx.channels.restoreActiveChat(this.state?.lastActiveChat ?? null);
        await this.goals.recover();
        await this.ctx.channels.resumeOutbox();
        await this.emitStartupNotice();
        await this.ctx.channels.drainBuffered();
        this.ready = true;
        this.ctx.sessionController.markReady();
        await this.writeState(false);
        await writeJsonAtomic(this.paths.readyPath, {
            pid: process.pid,
            sessionId: this.mainSessionId,
            startedAt: new Date().toISOString(),
        });
        if (this.notifier.enabled) {
            try {
                await this.notifier.ready(
                    `ready (session ${this.mainSessionId ?? "-"})`
                );
            } catch (error) {
                await unlink(this.paths.readyPath).catch(() => undefined);
                throw error;
            }
        }
        this.logger.info("daemon ready", {
            session: this.mainSessionId,
            restart: this.restartReason,
        });
    }

    private async createAgent(): Promise<AgentHandle> {
        const id = `main-${randomUUID()}`;
        const handle = await this.ctx.agents.create({
            sessionId: SessionId(id),
            meta: { cwd: this.paths.workspaceDir },
            agentOptions: this.agentOptions(),
            setup: (agentCtx) => installMainToolPolicy(agentCtx),
        });
        this.installMainPermissions(handle.agent);
        return handle;
    }

    private async resumeAgent(sessionId: string): Promise<AgentHandle> {
        const handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: this.agentOptions(),
            setup: (agentCtx) => installMainToolPolicy(agentCtx),
        });
        this.installMainPermissions(handle.agent);
        return handle;
    }

    private installMainPermissions(agent: Agent): void {
        this.ctx.permissionPresets.set(agent.session, "auto");
        const current = this.ctx.permissionPresets.current(agent.session);
        if (current !== "auto") {
            throw new Error(
                `failed to select the auto permission preset (got ${current})`
            );
        }
        this.installPermissionCommand(agent);
    }

    private installPermissionCommand(agent: Agent): void {
        agent.ctx.inject(["commands"], (commandCtx) => {
            commandCtx.effect(() =>
                commandCtx.commands.register({
                    name: "permission",
                    description:
                        "Report the current permission preset; switching is disabled",
                    input: { hint: "<preset>" },
                    handler: (invocation) => {
                        const current = this.ctx.permissionPresets.current(
                            invocation.agent.session
                        );
                        if (invocation.rawInput.trim() !== "") {
                            return {
                                kind: "error",
                                text: `不支持切换权限预设；当前为 ${current}。v1 没有 DSH 沙箱回退，切走会绕过 Auto review。`,
                            };
                        }
                        return {
                            kind: "success",
                            text: `permission: ${current}\nAuto review 已启用；切换预设会绕过审查，v1 不支持。`,
                        };
                    },
                })
            );
        });
    }

    private agentOptions(): AgentOptions {
        const effort = normalizeEffort(this.config.reasoningEffort);
        return {
            provider: this.config.provider,
            model: this.config.model,
            ...(effort === undefined
                ? {}
                : {
                      reasoningEffort:
                          effort as AgentOptions["reasoningEffort"],
                  }),
            ...(this.config.maxTokens === undefined
                ? {}
                : { maxTokens: this.config.maxTokens }),
        };
    }

    private async attachRuntime(): Promise<void> {
        const handle = this.handle;
        if (handle === undefined) throw new Error("main agent is not created");
        await this.ctx.channels.attachRuntime({
            agent: handle.agent,
            commands: this.ctx.commands,
            mainSessionId: handle.agent.id,
            onChatActive: (chat) => {
                this.state = {
                    ...this.state,
                    lastActiveChat: chat,
                } as AgentState;
                this.persistSoon();
            },
        });
    }

    private installStatusProvider(): void {
        this.ctx.channels.setStatusProvider(() => ({
            version: this.config.version,
            uptimeSec: Math.floor(process.uptime()),
            mainSessionId: this.mainSessionId,
            agentStatus:
                this.ready && this.handle !== undefined
                    ? this.handle.agent.status === "running"
                        ? "running"
                        : "idle"
                    : "starting",
            goals: this.goals.statusSummaries(),
            permission:
                this.handle === undefined
                    ? null
                    : this.ctx.permissionPresets.current(
                          this.handle.agent.session
                      ),
            lastRestartReason: this.restartReason,
            ready: this.ready,
        }));
        this.ctx.channels.setFullStatusProvider(() => this.fullStatus());
    }

    private installSessionListener(): void {
        this.ctx.effect(() =>
            this.ctx.on(
                "session/event",
                (session: Session, event: SessionEvent) => {
                    if (session.id !== this.mainSessionId) return;
                    if (event.type === "turn/start") {
                        this.ctx.channels.noteTurnStart();
                        return;
                    }
                    if (event.type === "assistant/message") {
                        const text = assistantText(
                            event.data.message as AssistantMessage
                        );
                        if (text.trim() !== "") {
                            this.turnText.set(event.data.turn, text);
                        }
                        return;
                    }
                    if (event.type === "turn/end") {
                        const text = this.turnText.get(event.data.turn);
                        this.turnText.delete(event.data.turn);
                        this.handleTurnEnd(event.data.reason, text);
                    }
                }
            )
        );
    }

    private handleTurnEnd(
        reason: TurnEndReason,
        text: string | undefined
    ): void {
        const plan = planTurnEnd(reason, text);
        if (plan.text !== undefined) {
            void this.ctx.channels
                .sendReply(plan.text)
                .catch((error: unknown) => {
                    this.logger.error("failed to enqueue reply", {
                        error: errorMessage(error),
                    });
                });
        }
        if (plan.notice !== undefined) {
            void this.ctx.channels
                .notify(plan.notice)
                .catch((error: unknown) => {
                    this.logger.error("failed to enqueue notice", {
                        error: errorMessage(error),
                    });
                });
        }
    }

    private registerCommands(): void {
        const register = (definition: {
            readonly name: string;
            readonly description: string;
            readonly input?: { readonly hint: string };
            readonly handler: (
                invocation: CommandInvocation
            ) => CommandResult | Promise<CommandResult>;
        }): void => {
            this.ctx.effect(() => this.ctx.commands.register(definition));
        };
        register({
            name: "stop",
            description: "Stop the main agent's current turn",
            handler: () => this.stopCommand(),
        });
        register({
            name: "status",
            description: "Show daemon status; use /status full for paths",
            input: { hint: "full" },
            handler: (invocation) => this.statusCommand(invocation.rawInput),
        });
        register({
            name: "goal",
            description:
                "Create and control goal subagents: new/list/status/pause/resume/clear/archive",
            input: {
                hint: "new <objective> [--rounds N] | list | status <id>",
            },
            handler: (invocation) =>
                this.goals.runCommand(
                    parseGoalCommand(invocation.rawInput),
                    invocation.signal
                ),
        });
        register({
            name: "clear",
            description:
                "Create a new main session and keep the old one archived",
            handler: () => this.clearCommand(),
        });
        register({
            name: "new",
            description: "Alias of /clear",
            handler: () => this.clearCommand(),
        });
    }

    private async stopCommand(): Promise<CommandResult> {
        const handle = this.handle;
        if (handle === undefined) {
            return { kind: "error", text: "主会话尚未就绪" };
        }
        await this.ctx.channels.abortInteractions("user-stop");
        handle.agent.cancel({ kind: "user" });
        this.ctx.channels.clearPendingTurnChats();
        this.turnText.clear();
        return { kind: "success", text: "已停止" };
    }

    private async statusCommand(rawInput: string): Promise<CommandResult> {
        const status = this.ctx.channels.status();
        const lines = [
            `version: ${status.version}`,
            `uptime: ${status.uptimeSec}s`,
            `agent: ${status.agentStatus}`,
            `mainSession: ${status.mainSessionId ?? "-"}`,
            `model: ${this.config.model}`,
            `permission: ${status.permission ?? "-"}`,
            `goals: ${status.goals.length}`,
            `pendingInteractions: ${status.pendingInteractions}`,
            `outbox: ${status.outboxLength}`,
            `channels: ${
                (status.channels ?? [])
                    .map((channel) => `${channel.id}=${channel.state}`)
                    .join(",") || "-"
            }`,
            `deferredNotices: ${status.deferredNotices ?? 0}`,
            `lastRestart: ${status.lastRestartReason ?? "-"}`,
        ];
        if (rawInput.trim() === "full") {
            try {
                lines.push(formatFullStatus(await this.fullStatus()));
            } catch (error) {
                lines.push(`fullStatusError: ${errorMessage(error)}`);
            }
        }
        return { kind: "success", text: lines.join("\n") };
    }

    private async fullStatus(): Promise<FullStatusDetails> {
        const tracked = this.goals.snapshot();
        const sessionIds = new Set<string>();
        if (this.mainSessionId !== null) {
            sessionIds.add(this.mainSessionId);
        }
        for (const goal of tracked) sessionIds.add(goal.sessionId);

        const sandboxes: FullSandboxStatus[] = [];
        for (const host of this.ctx.shellHosts.list()) {
            if (!this.ctx.shellHosts.hasStatus(host.id)) continue;
            for (const sessionId of sessionIds) {
                try {
                    sandboxes.push(
                        normalizeSandboxStatus(
                            host.id,
                            sessionId,
                            await this.ctx.shellHosts.status(host.id, sessionId)
                        )
                    );
                } catch (error) {
                    sandboxes.push({
                        host: host.id,
                        sessionId,
                        dir: "",
                        exists: false,
                        generation: 0,
                        packages: [],
                        createdAt: null,
                        lastUsedAt: null,
                        idleTtlMs: 0,
                        activeCommands: 0,
                        backgroundCommands: 0,
                        terminalSessions: 0,
                        error: errorMessage(error),
                    });
                }
            }
        }
        const sandboxBySession = new Map<string, FullSandboxStatus>();
        for (const sandbox of sandboxes) {
            if (sandbox.error === undefined) {
                sandboxBySession.set(sandbox.sessionId, sandbox);
            }
        }

        const goals: FullGoalStatus[] = tracked.map((goal) => {
            const child = this.ctx.agents.get(SessionId(goal.sessionId));
            const childStatus =
                child === undefined
                    ? "cold"
                    : child.status === "running"
                      ? "running"
                      : "idle";
            return {
                shortId: goal.sessionId.slice(0, 8),
                sessionId: goal.sessionId,
                goalId: goal.goalId,
                objective: goal.objective ?? "(unknown)",
                phase: goal.phase,
                roundsStarted: goal.lastKnownRounds,
                maxGoalRounds: goal.maxGoalRounds ?? 0,
                model:
                    goal.model === undefined
                        ? null
                        : formatModelRoute(goal.model),
                childStatus,
                sandbox: sandboxBySession.get(goal.sessionId) ?? null,
            };
        });

        let schedules: FullScheduleStatus[] = [];
        if (this.handle !== undefined) {
            try {
                schedules = (
                    await this.ctx.schedule.list({
                        sessionId: this.handle.agent.id,
                    })
                ).map((record) => ({
                    id: record.id,
                    title: record.title,
                    kind: record.kind,
                    scheduledAt: record.scheduledAt,
                    state:
                        Date.parse(record.scheduledAt) <= Date.now()
                            ? "overdue"
                            : "scheduled",
                }));
            } catch (error) {
                this.logger.warn("failed to read schedules for status", {
                    error: errorMessage(error),
                });
            }
        }

        let memory: FullStatusDetails["memory"] = {
            activeEntries: 0,
            archivedEntries: 0,
            invalidEntries: 0,
            bytes: 0,
            pinnedEntries: 0,
            snapshotChars: 0,
            inject: "disabled",
        };
        const memoryService = this.ctx.get("memory");
        if (memoryService !== undefined) {
            try {
                const stats = await memoryService.stats();
                const runtime = memoryService.runtimeStatus;
                memory = {
                    activeEntries: stats.active,
                    archivedEntries: stats.archived,
                    invalidEntries: stats.invalid,
                    bytes: stats.bytes,
                    pinnedEntries: stats.pinned,
                    snapshotChars: runtime?.snapshotChars ?? 0,
                    inject: runtime?.enabled === true ? "enabled" : "disabled",
                };
            } catch (error) {
                this.logger.warn("failed to read memory stats", {
                    error: errorMessage(error),
                });
            }
        }

        const fastEffort = this.config.reviewFastReasoningEffort?.trim();
        const strongEffort = this.config.reviewStrongReasoningEffort?.trim();
        const reviewer = {
            fast: {
                provider:
                    this.config.reviewFastProvider ?? this.config.provider,
                model: this.config.reviewFastModel ?? this.config.model,
                ...(fastEffort === undefined || fastEffort === ""
                    ? {}
                    : { reasoningEffort: fastEffort }),
            },
            strong: {
                provider:
                    this.config.reviewStrongProvider ??
                    this.config.reviewFastProvider ??
                    this.config.provider,
                model:
                    this.config.reviewStrongModel ??
                    this.config.reviewFastModel ??
                    this.config.model,
                ...(strongEffort === undefined || strongEffort === ""
                    ? {}
                    : { reasoningEffort: strongEffort }),
            },
            timeoutMs: this.config.reviewTimeoutMs ?? 30000,
        };
        const mainEffort = this.config.reasoningEffort?.trim();

        return {
            workspace: this.paths.workspaceDir,
            state: this.paths.agentStatePath,
            lock: this.paths.lockPath,
            storage: this.paths.storageDir,
            nextOutboxSeq: this.ctx.channels.nextOutboxSeq,
            dshVersion: resolvePackageVersion("@deepseek-ai/dsh-agent"),
            appVersion: this.config.version,
            model: {
                provider: this.config.provider,
                model: this.config.model,
                ...(mainEffort === undefined || mainEffort === ""
                    ? {}
                    : { reasoningEffort: mainEffort }),
            },
            reviewer,
            goals,
            schedules,
            sandboxes,
            memory,
            recentErrors: recentLogs(10),
            lastVersion: this.state?.lastVersion ?? this.config.version,
            lastStartedAt: this.state?.lastStartedAt ?? null,
            restartReason: this.restartReason,
        };
    }

    private async clearCommand(): Promise<CommandResult> {
        if (this.clearing) {
            return { kind: "error", text: "正在新建会话，请稍后" };
        }
        this.clearing = true;
        try {
            const removedSchedules = await this.clearSession();
            const suffix =
                removedSchedules > 0
                    ? `；已删除旧会话的 ${String(removedSchedules)} 条提醒`
                    : "";
            return {
                kind: "success",
                text: `已新建会话，旧会话已归档${suffix}`,
            };
        } catch (error) {
            this.logger.error("clear failed", { error: errorMessage(error) });
            return {
                kind: "error",
                text: `新建会话失败：${errorMessage(error)}`,
            };
        } finally {
            this.clearing = false;
        }
    }

    private async clearSession(): Promise<number> {
        const old = this.handle;
        if (old === undefined) throw new Error("main agent is not created");
        const previousId = this.mainSessionId;
        await this.ctx.channels.abortInteractions("clear");
        old.agent.cancel({ kind: "user" });
        await this.ctx.sessions.flush(old.agent.session);
        // Owner-scoped terminals must close before the previous agent and its
        // sandbox are disposed; the helper bounds its own wait and only warns.
        await killTerminalsForAgent(this.ctx, old.agent, {
            logger: this.logger,
        });
        await this.goals.clearAll();
        this.curator.clear();
        const removedSchedules =
            previousId === null ? 0 : await this.clearSchedules(previousId);
        const next = await this.createAgent();
        this.handle = next;
        this.mainSessionId = next.agent.id;
        this.ctx.sessionController.bind(next.agent, Promise.resolve());
        await this.ctx.sessions.flush(next.agent.session);
        await this.goals.bindMain(next.agent);
        this.curator.bindMain(next.agent);
        this.state = {
            ...(this.state ?? defaultAgentState(this.config.version)),
            mainSessionId: this.mainSessionId,
        };
        await this.writeState(false);
        this.turnText.clear();
        await this.attachRuntime();
        await this.ctx.channels.drainBuffered();
        this.ctx.sessionController.markReady();
        await this.writeState(false);
        try {
            await old.dispose();
        } catch (error) {
            this.logger.error("failed to dispose previous agent", {
                session: previousId ?? "-",
                error: errorMessage(error),
            });
        }
        if (previousId !== null) {
            try {
                await this.ctx.shellHosts.disposeSession(previousId);
            } catch (error) {
                this.logger.error("failed to dispose previous sandbox", {
                    session: previousId,
                    error: errorMessage(error),
                });
            }
        }
        this.logger.info("main session cleared", {
            previous: previousId ?? "-",
            session: this.mainSessionId ?? "-",
        });
        return removedSchedules;
    }

    /**
     * Remove every reminder bound to a session that is being archived.
     * Active and inactive rows are both removed so stale tasks cannot retry.
     * @param sessionId - session whose reminders should stop.
     * @returns number of rows the scheduler confirmed deleted.
     */
    private async clearSchedules(sessionId: string): Promise<number> {
        let removed = 0;
        try {
            const entries = await this.ctx.schedule.catalog();
            for (const entry of entries) {
                if (String(entry.sessionId) !== sessionId) continue;
                try {
                    const result = await this.ctx.schedule.delete({
                        sessionId: entry.sessionId,
                        id: entry.id,
                    });
                    if (result.deleted) removed += 1;
                } catch (error) {
                    this.logger.warn("failed to delete schedule", {
                        session: sessionId,
                        schedule: entry.id,
                        error: errorMessage(error),
                    });
                }
            }
        } catch (error) {
            this.logger.error("failed to enumerate schedules for clear", {
                session: sessionId,
                error: errorMessage(error),
            });
        }
        return removed;
    }

    private async emitStartupNotice(): Promise<void> {
        if (this.restartReason === "crash") {
            await this.ctx.channels.notify("进程重启，已恢复会话");
            return;
        }
        if (this.restartReason === "state-corrupt") {
            await this.ctx.channels.notify("状态文件损坏，已备份并新建会话");
            return;
        }
        if (this.resumeMissing) {
            await this.ctx.channels.notify("旧主会话不存在，已新建会话");
        }
    }

    private async writeState(cleanShutdown: boolean): Promise<void> {
        const state = this.stateSnapshot(cleanShutdown);
        this.state = state;
        await saveAgentState(this.paths.agentStatePath, state);
    }

    private stateSnapshot(cleanShutdown: boolean): AgentState {
        const base = this.state;
        return {
            version: 1,
            mainSessionId: this.mainSessionId,
            goals: this.goals.snapshot(),
            archivedGoals: base?.archivedGoals ?? [],
            lastActiveChat: base?.lastActiveChat ?? null,
            cleanShutdown,
            outboxSeq: this.ctx.channels.nextOutboxSeq - 1,
            lastStartedAt: base?.lastStartedAt ?? new Date().toISOString(),
            lastVersion: this.config.version,
            lastRestartReason: this.restartReason,
        };
    }

    private persistSoon(): void {
        this.stateChain = this.stateChain
            .then(() => this.writeState(false))
            .catch((error: unknown) => {
                this.logger.error("failed to persist state", {
                    error: errorMessage(error),
                });
            });
    }
}
