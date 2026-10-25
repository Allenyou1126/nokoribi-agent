import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import type {
    CommandInvocation,
    CommandResult,
} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-goal";
import type { AssistantMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-permission-presets";
import {
    SessionId,
    type Session,
    type SessionEvent,
    type TurnEndReason,
} from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-subagent";
import "@nokoribi/channel-core";
import {
    createLogger,
    defaultAgentState,
    ensureHomeDirs,
    loadAgentState,
    resolveHomePaths,
    saveAgentState,
    SingleInstanceLock,
    writeJsonAtomic,
    type AgentState,
    type HomePaths,
    type Logger,
    type RestartReason,
} from "@nokoribi/shared";
import type {} from "@nokoribi/shell-bash";

import { parseGoalCommand } from "./goals/commands.js";
import { installMainToolPolicy } from "./goals/main-policy.js";
import { GoalManager } from "./goals/manager.js";
import { createStartGoalTool } from "./goals/tool.js";
import { assistantText, planTurnEnd } from "./replies.js";

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
    /** Bound for one cold goal recovery. */
    readonly goalRecoveryTimeoutMs?: number;
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
 * Daemon lifecycle: lock, state, main agent create/resume, command surface,
 * reply mirroring, system notices, and graceful shutdown.
 */
export class Daemon {
    private readonly ctx: Context;
    private readonly config: AgentAppConfig;
    private readonly paths: HomePaths;
    private readonly logger: Logger;
    private readonly goals: GoalManager;
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
        const goalEffortRaw =
            config.goalReasoningEffort ?? config.reasoningEffort;
        const goalEffort =
            goalEffortRaw === undefined || goalEffortRaw.trim() === ""
                ? undefined
                : goalEffortRaw;
        this.goals = new GoalManager(ctx, {
            provider: config.goalProvider ?? config.provider,
            model: config.goalModel ?? config.model,
            ...(goalEffort === undefined
                ? {}
                : { reasoningEffort: goalEffort }),
            recoveryTimeoutMs: config.goalRecoveryTimeoutMs ?? 30000,
            archivePath: this.paths.goalsArchivePath,
            notify: (text) => this.ctx.channels.notify(text),
            persist: () => this.persistSoon(),
            logger: this.logger,
        });
    }

    /** Start the daemon; throws on lock, state, or session failures. */
    async start(): Promise<void> {
        await ensureHomeDirs(this.paths);
        this.ctx.effect(() => () => this.shutdown());
        try {
            this.lock = SingleInstanceLock.acquire(
                this.paths.lockPath,
                this.config.version
            );
            this.ctx.shellHosts.requireDefaultHost();
            this.goals.install();
            this.ctx.effect(() =>
                this.ctx.tools.register(createStartGoalTool(this.goals))
            );
            await this.ctx.channels.initialize();
            await this.recover();
        } catch (error) {
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
            this.logger.error("shutdown flush failed", {
                error: errorMessage(error),
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
        await this.ctx.sessions.flush(this.handle.agent.session);
        await this.goals.bindMain(this.handle.agent);
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
        await this.goals.recover();
        await this.ctx.channels.resumeOutbox();
        await this.emitStartupNotice();
        await this.ctx.channels.drainBuffered();
        this.ready = true;
        await this.writeState(false);
        await writeJsonAtomic(this.paths.readyPath, {
            pid: process.pid,
            sessionId: this.mainSessionId,
            startedAt: new Date().toISOString(),
        });
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
        return {
            provider: this.config.provider,
            model: this.config.model,
            ...(this.config.reasoningEffort === undefined
                ? {}
                : {
                      reasoningEffort: this.config
                          .reasoningEffort as AgentOptions["reasoningEffort"],
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
    }

    private installSessionListener(): void {
        this.ctx.effect(() =>
            this.ctx.on(
                "session/event",
                (session: Session, event: SessionEvent) => {
                    if (session.id !== this.mainSessionId) return;
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
        this.turnText.clear();
        return { kind: "success", text: "已停止" };
    }

    private statusCommand(rawInput: string): CommandResult {
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
            `lastRestart: ${status.lastRestartReason ?? "-"}`,
        ];
        if (rawInput.trim() === "full") {
            lines.push(
                `workspace: ${this.paths.workspaceDir}`,
                `state: ${this.paths.agentStatePath}`,
                `lock: ${this.paths.lockPath}`,
                `nextOutboxSeq: ${this.ctx.channels.nextOutboxSeq}`
            );
        }
        return { kind: "success", text: lines.join("\n") };
    }

    private async clearCommand(): Promise<CommandResult> {
        if (this.clearing) {
            return { kind: "error", text: "正在新建会话，请稍后" };
        }
        this.clearing = true;
        try {
            await this.clearSession();
            return { kind: "success", text: "已新建会话，旧会话已归档" };
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

    private async clearSession(): Promise<void> {
        const old = this.handle;
        if (old === undefined) throw new Error("main agent is not created");
        await this.ctx.channels.abortInteractions("clear");
        old.agent.cancel({ kind: "user" });
        await this.ctx.sessions.flush(old.agent.session);
        await this.goals.clearAll();
        const previousId = this.mainSessionId;
        const next = await this.createAgent();
        this.handle = next;
        this.mainSessionId = next.agent.id;
        await this.ctx.sessions.flush(next.agent.session);
        await this.goals.bindMain(next.agent);
        this.state = {
            ...(this.state ?? defaultAgentState(this.config.version)),
            mainSessionId: this.mainSessionId,
        };
        await this.writeState(false);
        this.turnText.clear();
        await this.attachRuntime();
        await this.ctx.channels.drainBuffered();
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
