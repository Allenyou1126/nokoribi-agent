import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import type { GoalChanged, GoalView } from "@deepseek-ai/dsh-goal";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
    SessionId,
    type Session,
    type SessionEvent,
} from "@deepseek-ai/dsh-session";
import type {
    SubagentActivation,
    SubagentCatalogEntry,
    SubagentRunEndInfo,
} from "@deepseek-ai/dsh-subagent";
import {
    GOAL_SESSION_PREFIX,
    shortGoalId,
    type GoalModelRef,
    type GoalState,
    type Logger,
} from "@nokoribi/shared";
import type {} from "@nokoribi/shell-bash";

import { GoalArchive, type GoalArchiveRecord } from "./archive.js";
import { GOAL_HELP, type GoalCommand } from "./commands.js";
import { goalBootstrapPrompt } from "./prompt.js";
import {
    GoalTracker,
    type GoalCreationDetails,
    type GoalSource,
    type GoalStatusSummary,
} from "./tracker.js";

/** Resolved goal manager configuration. */
export interface GoalManagerOptions {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly recoveryTimeoutMs: number;
    readonly archivePath: string;
    readonly notify: (text: string) => Promise<void>;
    readonly persist: () => void;
    readonly logger: Logger;
}

/** One goal child creation request. */
export interface StartGoalOptions {
    readonly objective: string;
    readonly label: string;
    readonly maxRounds?: number;
    readonly source: GoalSource;
    readonly signal?: AbortSignal;
}

/** Created goal child identity. */
export interface StartedGoal {
    readonly childId: string;
    readonly shortId: string;
    readonly goalId: string;
}

const GOAL_ROUND_MESSAGE: string =
    "（系统）进程已重启，请继续当前 goal，不要重复已完成的工作。";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owner of tracked goal children, creation, recovery, commands, and archives. */
export class GoalManager {
    private readonly ctx: Context;
    private readonly config: GoalManagerOptions;
    private readonly tracker = new GoalTracker();
    private readonly archive: GoalArchive;
    private readonly pending = new Map<string, GoalCreationDetails>();
    private readonly blockedNotified = new Map<string, number>();
    private readonly endedNotified = new Set<string>();
    private main: Agent | undefined;
    private mainId: string | null = null;

    constructor(ctx: Context, config: GoalManagerOptions) {
        this.ctx = ctx;
        this.config = config;
        this.archive = new GoalArchive(config.archivePath);
    }

    /** Replace the tracked projection from durable daemon state. */
    load(goals: readonly GoalState[]): void {
        this.tracker.load(goals);
    }

    /** Current tracked goals for `agent-state.json`. */
    snapshot(): readonly GoalState[] {
        return this.tracker.snapshot();
    }

    /** Summaries for `/status`. */
    statusSummaries(): GoalStatusSummary[] {
        return this.tracker.summaries();
    }

    /** Session id of the main agent; `null` before recovery binds it. */
    get mainSessionId(): string | null {
        return this.mainId;
    }

    /** Subscribe to goal, child-session, and lifecycle events. */
    install(): void {
        this.ctx.effect(() =>
            this.ctx.on("goal/changed", (payload) => {
                void this.onGoalChanged(payload.agent, payload.change).catch(
                    (error: unknown) => {
                        this.config.logger.error(
                            "goal change handling failed",
                            {
                                error: errorMessage(error),
                            }
                        );
                    }
                );
            })
        );
        this.ctx.effect(() =>
            this.ctx.on(
                "session/event",
                (session: Session, event: SessionEvent) => {
                    this.onSessionEvent(session, event);
                }
            )
        );
        this.ctx.effect(() =>
            this.ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
                this.onSubagentEnd(info);
            })
        );
    }

    /** Bind the live main agent and clear any goal that should not exist there. */
    async bindMain(agent: Agent): Promise<void> {
        this.main = agent;
        this.mainId = agent.id;
        await this.clearMainGoalIfAny();
    }

    /** Create one continuable goal child and its persisted goal. */
    async startGoal(options: StartGoalOptions): Promise<StartedGoal> {
        const main = this.requireMain();
        const objective = options.objective.trim();
        if (objective === "")
            throw new Error("goal objective must not be empty");
        const maxRounds = options.maxRounds;
        if (
            maxRounds !== undefined &&
            (!Number.isSafeInteger(maxRounds) || maxRounds < 1)
        ) {
            throw new Error("max_goal_rounds must be a positive safe integer");
        }
        const label =
            options.label.trim() === "" ? "goal" : options.label.trim();
        const childId = `${GOAL_SESSION_PREFIX}${randomUUID()}`;
        const shortId = shortGoalId(childId);
        const details: GoalCreationDetails = {
            source: options.source,
            label,
            model: this.modelRef(),
        };
        this.pending.set(childId, details);
        const prompt = goalBootstrapPrompt({
            objective,
            maxRounds: maxRounds ?? 256,
            shortId,
            parentSessionId: main.id,
        });
        let activation: SubagentActivation;
        try {
            activation = await this.ctx.subagents.startActivation({
                provider: "spawn",
                label,
                childId: SessionId(childId),
                request: {
                    parent: main,
                    prompt: [{ type: "text", text: prompt }],
                    agentOptions: this.agentOptions(),
                },
                signal: options.signal ?? new AbortController().signal,
                delivery: "parent",
            });
        } catch (error) {
            this.pending.delete(childId);
            throw error;
        }
        try {
            const child = await this.waitForAgent(
                childId,
                this.config.recoveryTimeoutMs
            );
            const view = this.ctx.goals.create(child, {
                objective,
                ...(maxRounds === undefined
                    ? {}
                    : { maxGoalRounds: maxRounds }),
            });
            this.tracker.upsert(view, childId, details);
            this.persist();
            this.config.logger.info("goal child created", {
                session: childId,
                shortId,
                source: options.source,
            });
            return { childId, shortId, goalId: view.id };
        } catch (error) {
            this.pending.delete(childId);
            await activation.dispose().catch((disposeError: unknown) => {
                this.config.logger.warn("failed to dispose goal child", {
                    session: childId,
                    error: errorMessage(disposeError),
                });
            });
            throw error;
        }
    }

    /** Cold-resume every tracked active goal, sequentially. */
    async recover(): Promise<void> {
        const main = this.requireMain();
        await this.clearMainGoalIfAny();
        if (this.tracker.list().length === 0) return;
        let catalog: readonly SubagentCatalogEntry[] | undefined;
        try {
            catalog = await this.ctx.subagents.listChildren(main.id);
        } catch (error) {
            this.config.logger.warn("goal child catalog unavailable", {
                error: errorMessage(error),
            });
        }
        for (const tracked of this.tracker.list()) {
            if (tracked.phase !== "active") continue;
            const child = catalog?.find(
                (entry) => entry.id === tracked.sessionId
            );
            if (catalog !== undefined && child === undefined) {
                this.config.logger.warn("tracked goal child is missing", {
                    session: tracked.sessionId,
                });
                await this.config.notify(
                    `⚠️ goal ${shortGoalId(tracked.sessionId)} 的子会话不存在，已从跟踪中移除。`
                );
                this.removeTracked(tracked.sessionId);
                continue;
            }
            if (child !== undefined && child.mode !== "continuable") {
                await this.config.notify(
                    `⚠️ goal ${shortGoalId(tracked.sessionId)} 不是 continuable 子代理，无法恢复。`
                );
                this.removeTracked(tracked.sessionId);
                continue;
            }
            await this.recoverOne(main, tracked);
        }
    }

    /** Stop and archive every tracked goal (used by `/clear`). */
    async clearAll(): Promise<void> {
        for (const tracked of this.tracker.list()) {
            try {
                await this.clearOne(tracked);
            } catch (error) {
                this.config.logger.error("goal clearAll failed", {
                    session: tracked.sessionId,
                    error: errorMessage(error),
                });
                await this.config
                    .notify(
                        `⚠️ goal ${shortGoalId(tracked.sessionId)} 清理失败：${errorMessage(error)}`
                    )
                    .catch(() => undefined);
            }
        }
    }

    /** Execute one parsed `/goal` command. */
    async runCommand(
        command: GoalCommand,
        signal?: AbortSignal
    ): Promise<CommandResult> {
        try {
            switch (command.kind) {
                case "help":
                    return { kind: "success", text: GOAL_HELP };
                case "error":
                    return { kind: "error", text: command.message };
                case "new": {
                    const started = await this.startGoal({
                        objective: command.objective,
                        label: `goal: ${command.objective.slice(0, 60)}`,
                        maxRounds: command.maxRounds,
                        source: "goal-command",
                        ...(signal === undefined ? {} : { signal }),
                    });
                    return {
                        kind: "success",
                        text: `已创建 goal ${started.shortId}（${started.childId}）；使用 /goal status ${started.shortId} 查看进度。`,
                    };
                }
                case "list":
                    return await this.listCommand();
                case "status":
                    return await this.statusCommand(command.prefix);
                case "pause":
                    return await this.pauseCommand(command.prefix);
                case "resume":
                    return await this.resumeCommand(command.prefix);
                case "clear":
                    return await this.clearCommand(command.prefix);
                case "archive":
                    return await this.archiveCommand(command.prefix);
            }
        } catch (error) {
            this.config.logger.error("goal command failed", {
                action: command.kind,
                error: errorMessage(error),
            });
            return {
                kind: "error",
                text: `goal 操作失败：${errorMessage(error)}`,
            };
        }
    }

    private async onGoalChanged(
        agent: Agent,
        change: GoalChanged
    ): Promise<void> {
        if (this.mainId !== null && agent.id === this.mainId) {
            if (change.goal !== undefined) {
                await this.clearMainGoal(agent, change.goal);
            }
            return;
        }
        if (
            this.mainId === null ||
            agent.session.header.parentSession !== this.mainId
        ) {
            return;
        }
        if (change.goal === undefined) {
            this.removeTracked(agent.id);
            return;
        }
        const details =
            this.pending.get(agent.id) ??
            this.detailsFromState(this.tracker.get(agent.id));
        const state = this.tracker.upsert(change.goal, agent.id, details);
        this.persist();
        if (
            state.phase === "blocked" &&
            this.blockedNotified.get(state.sessionId) !== state.revision
        ) {
            this.blockedNotified.set(state.sessionId, state.revision);
            await this.config.notify(
                `⚠️ goal ${shortGoalId(state.sessionId)} 阻塞：${state.objective ?? "(unknown)"}`
            );
        }
    }

    private onSessionEvent(session: Session, event: SessionEvent): void {
        if (event.type !== "user/message") return;
        const source = event.data.source;
        if (source.kind !== "goal") return;
        const updated = this.tracker.updateRounds(session.id, source.round);
        if (updated !== undefined) this.persist();
    }

    private onSubagentEnd(info: SubagentRunEndInfo): void {
        const tracked = this.tracker.get(info.id);
        if (tracked === undefined) return;
        if (tracked.phase === "complete" || tracked.phase === "blocked") return;
        if (info.stopReason === "completed") return;
        if (this.endedNotified.has(info.id)) return;
        this.endedNotified.add(info.id);
        void this.config
            .notify(
                `⚠️ goal ${shortGoalId(info.id)} 子代理停止（${info.stopReason}）。`
            )
            .catch((error: unknown) => {
                this.config.logger.error("goal stop notice failed", {
                    error: errorMessage(error),
                });
            });
    }

    private async recoverOne(main: Agent, tracked: GoalState): Promise<void> {
        const shortId = shortGoalId(tracked.sessionId);
        this.endedNotified.delete(tracked.sessionId);
        try {
            const child = await this.wakeChild(main, tracked.sessionId);
            const view = this.ctx.goals.get(child);
            if (view === undefined) {
                throw new Error("子会话没有 goal");
            }
            const details = this.detailsFromState(tracked);
            this.tracker.upsert(view, tracked.sessionId, details);
            this.persist();
            if (view.phase !== "active") return;
            if (view.roundsStarted >= view.maxGoalRounds) {
                await this.config.notify(
                    `⚠️ goal ${shortId} 已达到轮次上限，未重新 arm。`
                );
                return;
            }
            if (view.activation === "disarmed") {
                const resumed = this.ctx.goals.resume(child, {
                    id: view.id,
                    revision: view.revision,
                });
                this.tracker.upsert(resumed, tracked.sessionId, details);
                this.persist();
            }
            this.config.logger.info("goal resumed after restart", {
                session: tracked.sessionId,
                shortId,
            });
        } catch (error) {
            this.config.logger.warn("goal recovery failed", {
                session: tracked.sessionId,
                error: errorMessage(error),
            });
            await this.config
                .notify(
                    `⚠️ goal ${shortId} 恢复失败：${errorMessage(error)}；已保留，可 /goal resume ${shortId} 重试。`
                )
                .catch(() => undefined);
        }
    }

    private async wakeChild(main: Agent, childId: string): Promise<Agent> {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(
                new Error(
                    `goal recovery timed out after ${String(this.config.recoveryTimeoutMs)}ms`
                )
            );
        }, this.config.recoveryTimeoutMs);
        try {
            const content: ContentBlock[] = [
                { type: "text", text: GOAL_ROUND_MESSAGE },
            ];
            await this.ctx.subagents.sendMessage(
                main,
                SessionId(childId),
                content,
                { signal: controller.signal }
            );
            return await this.waitForAgent(
                childId,
                this.config.recoveryTimeoutMs,
                controller.signal
            );
        } finally {
            clearTimeout(timer);
        }
    }

    private async waitForAgent(
        childId: string,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<Agent> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const agent = this.ctx.agents.get(SessionId(childId));
            if (agent !== undefined) return agent;
            if (signal?.aborted === true) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error("goal recovery aborted");
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `goal child ${childId} did not become live within ${String(timeoutMs)}ms`
                );
            }
            await delay(25);
        }
    }

    private async listCommand(): Promise<CommandResult> {
        const goals = this.tracker.list();
        if (goals.length === 0) {
            return { kind: "success", text: "当前没有 goal。" };
        }
        return {
            kind: "success",
            text: goals
                .map((goal) => {
                    const max = goal.maxGoalRounds ?? 0;
                    const live =
                        this.ctx.agents.get(SessionId(goal.sessionId)) ===
                        undefined
                            ? "cold"
                            : "live";
                    return `- ${shortGoalId(goal.sessionId)}  ${goal.phase}  ${String(goal.lastKnownRounds)}/${String(max)}  ${live}  ${goal.objective ?? "(unknown)"}`;
                })
                .join("\n"),
        };
    }

    private async statusCommand(prefix: string): Promise<CommandResult> {
        const tracked = this.resolve(prefix);
        if (typeof tracked === "string")
            return { kind: "error", text: tracked };
        const child = this.ctx.agents.get(SessionId(tracked.sessionId));
        let view: GoalView | undefined;
        if (child !== undefined) {
            try {
                view = this.ctx.goals.get(child);
                if (view !== undefined) {
                    this.tracker.upsert(
                        view,
                        tracked.sessionId,
                        this.detailsFromState(tracked)
                    );
                    this.persist();
                }
            } catch (error) {
                this.config.logger.warn("goal status read failed", {
                    error: errorMessage(error),
                });
            }
        }
        const current = this.tracker.get(tracked.sessionId) ?? tracked;
        const sandbox = await this.sandboxStatus(tracked.sessionId);
        const lines = [
            `goal ${shortGoalId(tracked.sessionId)}`,
            `session: ${tracked.sessionId}`,
            `objective: ${current.objective ?? "(unknown)"}`,
            `phase: ${current.phase}`,
            `rounds: ${String(current.lastKnownRounds)}/${String(current.maxGoalRounds ?? 0)}`,
            `activation: ${view?.activation ?? "unknown"}`,
            `child: ${child?.status ?? "cold"}`,
            `sandbox: ${sandbox}`,
        ];
        if (view?.blockedReason !== undefined) {
            lines.push(`blocked: ${view.blockedReason.message}`);
        }
        return { kind: "success", text: lines.join("\n") };
    }

    private async pauseCommand(prefix: string): Promise<CommandResult> {
        const tracked = this.resolve(prefix);
        if (typeof tracked === "string")
            return { kind: "error", text: tracked };
        const child = this.ctx.agents.get(SessionId(tracked.sessionId));
        if (child === undefined) {
            return {
                kind: "error",
                text: `goal ${shortGoalId(tracked.sessionId)} 当前不在线，无法 pause。`,
            };
        }
        try {
            const view = this.ctx.goals.get(child);
            if (view === undefined) {
                return { kind: "error", text: "子会话没有 goal。" };
            }
            if (view.phase === "paused") {
                return { kind: "success", text: "goal 已经是 paused。" };
            }
            if (view.phase !== "active") {
                return {
                    kind: "error",
                    text: `goal 当前 phase=${view.phase}，不能 pause。`,
                };
            }
            const paused = this.ctx.goals.pause(child, {
                id: view.id,
                revision: view.revision,
            });
            this.tracker.upsert(
                paused,
                tracked.sessionId,
                this.detailsFromState(tracked)
            );
            this.persist();
            return {
                kind: "success",
                text: `已暂停 goal ${shortGoalId(tracked.sessionId)}。`,
            };
        } catch (error) {
            return { kind: "error", text: errorMessage(error) };
        }
    }

    private async resumeCommand(prefix: string): Promise<CommandResult> {
        const tracked = this.resolve(prefix);
        if (typeof tracked === "string")
            return { kind: "error", text: tracked };
        if (tracked.phase === "blocked" || tracked.phase === "complete") {
            return {
                kind: "error",
                text: `goal phase=${tracked.phase}，不能 resume。`,
            };
        }
        const child = this.ctx.agents.get(SessionId(tracked.sessionId));
        if (child === undefined) {
            try {
                const live = await this.wakeChild(
                    this.requireMain(),
                    tracked.sessionId
                );
                const view = this.ctx.goals.get(live);
                if (view === undefined) {
                    return { kind: "error", text: "子会话没有 goal。" };
                }
                if (view.phase === "blocked" || view.phase === "complete") {
                    return {
                        kind: "error",
                        text: `goal phase=${view.phase}，不能 resume。`,
                    };
                }
                const resumed = this.ctx.goals.resume(live, {
                    id: view.id,
                    revision: view.revision,
                });
                this.tracker.upsert(
                    resumed,
                    tracked.sessionId,
                    this.detailsFromState(tracked)
                );
                this.persist();
                return {
                    kind: "success",
                    text: `已恢复 goal ${shortGoalId(tracked.sessionId)}。`,
                };
            } catch (error) {
                return {
                    kind: "error",
                    text: `恢复失败：${errorMessage(error)}`,
                };
            }
        }
        try {
            const view = this.ctx.goals.get(child);
            if (view === undefined) {
                return { kind: "error", text: "子会话没有 goal。" };
            }
            if (view.phase === "blocked" || view.phase === "complete") {
                return {
                    kind: "error",
                    text: `goal phase=${view.phase}，不能 resume。`,
                };
            }
            if (view.phase === "active" && view.activation === "armed") {
                return { kind: "success", text: "goal 已经在运行。" };
            }
            const resumed = this.ctx.goals.resume(child, {
                id: view.id,
                revision: view.revision,
            });
            this.tracker.upsert(
                resumed,
                tracked.sessionId,
                this.detailsFromState(tracked)
            );
            this.persist();
            return {
                kind: "success",
                text: `已恢复 goal ${shortGoalId(tracked.sessionId)}。`,
            };
        } catch (error) {
            return { kind: "error", text: errorMessage(error) };
        }
    }

    private async clearCommand(prefix: string): Promise<CommandResult> {
        const tracked = this.resolve(prefix);
        if (typeof tracked === "string")
            return { kind: "error", text: tracked };
        const warning = await this.clearOne(tracked);
        return {
            kind: "success",
            text: `已清除并归档 goal ${shortGoalId(tracked.sessionId)}。${warning}`,
        };
    }

    private async archiveCommand(prefix: string): Promise<CommandResult> {
        const tracked = this.resolve(prefix);
        if (typeof tracked === "string")
            return { kind: "error", text: tracked };
        const child = this.ctx.agents.get(SessionId(tracked.sessionId));
        if (child !== undefined) {
            if (child.status === "running") {
                return {
                    kind: "error",
                    text: "子代理仍在运行，暂不能归档。",
                };
            }
            try {
                const view = this.ctx.goals.get(child);
                if (view === undefined) {
                    return { kind: "error", text: "子会话没有 goal。" };
                }
                if (view.phase !== "complete") {
                    return {
                        kind: "error",
                        text: `只有 complete 的 goal 可以 archive；当前 ${view.phase}。`,
                    };
                }
                this.tracker.upsert(
                    view,
                    tracked.sessionId,
                    this.detailsFromState(tracked)
                );
                await this.ctx.sessions.flush(child.session);
            } catch (error) {
                return { kind: "error", text: errorMessage(error) };
            }
        }
        const current = this.tracker.get(tracked.sessionId) ?? tracked;
        if (current.phase !== "complete") {
            return {
                kind: "error",
                text: `只有 complete 的 goal 可以 archive；当前 ${current.phase}。`,
            };
        }
        try {
            await this.archiveOne(current, "complete");
        } catch (error) {
            return { kind: "error", text: `归档失败：${errorMessage(error)}` };
        }
        const warning = await this.disposeSandbox(tracked.sessionId);
        this.removeTracked(tracked.sessionId);
        await this.drainChild(tracked.sessionId);
        return {
            kind: "success",
            text: `已归档 goal ${shortGoalId(tracked.sessionId)}；会话保留。${warning}`,
        };
    }

    private async clearOne(tracked: GoalState): Promise<string> {
        const main = this.requireMain();
        const child = this.ctx.agents.get(SessionId(tracked.sessionId));
        if (child !== undefined) {
            try {
                const view = this.ctx.goals.get(child);
                if (view !== undefined) {
                    this.tracker.upsert(
                        view,
                        tracked.sessionId,
                        this.detailsFromState(tracked)
                    );
                    this.ctx.goals.clear(child, {
                        id: view.id,
                        revision: view.revision,
                    });
                }
            } catch (error) {
                this.config.logger.warn("goal clear failed", {
                    session: tracked.sessionId,
                    error: errorMessage(error),
                });
            }
            try {
                this.ctx.subagents.interrupt(child.id, {
                    kind: "ancestor",
                    agent: main,
                });
                await child.whenIdle();
            } catch (error) {
                this.config.logger.warn("goal interrupt failed", {
                    session: tracked.sessionId,
                    error: errorMessage(error),
                });
            }
            try {
                await this.ctx.sessions.flush(child.session);
            } catch (error) {
                this.config.logger.warn("goal child flush failed", {
                    session: tracked.sessionId,
                    error: errorMessage(error),
                });
            }
            await this.drainChild(tracked.sessionId);
        }
        const current = this.tracker.get(tracked.sessionId) ?? tracked;
        try {
            await this.archiveOne(current, "cleared");
        } catch (error) {
            this.config.logger.error("goal clear archive failed", {
                session: tracked.sessionId,
                error: errorMessage(error),
            });
            await this.config
                .notify(
                    `⚠️ goal ${shortGoalId(tracked.sessionId)} 已停止，但归档写入失败：${errorMessage(error)}`
                )
                .catch(() => undefined);
        }
        this.removeTracked(tracked.sessionId);
        return await this.disposeSandbox(tracked.sessionId);
    }

    private async drainChild(childId: string): Promise<void> {
        const main = this.main;
        if (main === undefined) return;
        try {
            await this.ctx.subagents.drainChildren(main, [SessionId(childId)]);
        } catch (error) {
            this.config.logger.warn("goal child drain failed", {
                session: childId,
                error: errorMessage(error),
            });
        }
    }

    private async archiveOne(
        goal: GoalState,
        outcome: GoalArchiveRecord["outcome"]
    ): Promise<void> {
        await this.archive.append(this.archiveRecord(goal, outcome));
    }

    private archiveRecord(
        goal: GoalState,
        outcome: GoalArchiveRecord["outcome"]
    ): GoalArchiveRecord {
        return {
            shortId: shortGoalId(goal.sessionId),
            sessionId: goal.sessionId,
            objective: goal.objective ?? "(unknown)",
            outcome,
            rounds: goal.lastKnownRounds,
            maxGoalRounds: goal.maxGoalRounds ?? 0,
            createdAt: goal.createdAt,
            completedAt: outcome === "complete" ? goal.updatedAt : null,
            archivedAt: new Date().toISOString(),
            source: goal.source,
            ...(goal.label === undefined ? {} : { label: goal.label }),
            ...(goal.model === undefined ? {} : { model: goal.model }),
        };
    }

    private async disposeSandbox(sessionId: string): Promise<string> {
        try {
            await this.ctx.shellHosts.disposeSession(sessionId);
            return "";
        } catch (error) {
            this.config.logger.warn("goal sandbox cleanup failed", {
                session: sessionId,
                error: errorMessage(error),
            });
            return ` sandbox 清理失败：${errorMessage(error)}`;
        }
    }

    private async sandboxStatus(sessionId: string): Promise<string> {
        try {
            const status = await this.ctx.shellHosts.status(
                this.ctx.shellHosts.defaultHost,
                sessionId
            );
            return JSON.stringify(status);
        } catch {
            return "n/a";
        }
    }

    private resolve(prefix: string): GoalState | string {
        const matches = this.tracker.find(prefix);
        if (matches.length === 0) {
            return `未找到前缀为 ${prefix} 的 goal。`;
        }
        if (matches.length > 1) {
            const ids = matches
                .map((goal) => shortGoalId(goal.sessionId))
                .join(", ");
            return `前缀 ${prefix} 有歧义：${ids}`;
        }
        return matches[0] as GoalState;
    }

    private detailsFromState(
        state: GoalState | undefined
    ): GoalCreationDetails {
        return {
            source: state?.source ?? "subagent-tool",
            ...(state?.label === undefined ? {} : { label: state.label }),
            ...(state?.model === undefined ? {} : { model: state.model }),
        };
    }

    private removeTracked(sessionId: string): void {
        this.tracker.remove(sessionId);
        this.pending.delete(sessionId);
        this.blockedNotified.delete(sessionId);
        this.endedNotified.delete(sessionId);
        this.persist();
    }

    private async clearMainGoalIfAny(): Promise<void> {
        const main = this.main;
        if (main === undefined) return;
        try {
            const goal = this.ctx.goals.get(main);
            if (goal !== undefined) await this.clearMainGoal(main, goal);
        } catch (error) {
            this.config.logger.warn("main goal check failed", {
                error: errorMessage(error),
            });
        }
    }

    private async clearMainGoal(main: Agent, goal: GoalView): Promise<void> {
        try {
            this.ctx.goals.clear(main, {
                id: goal.id,
                revision: goal.revision,
            });
            this.config.logger.warn("cleared disallowed main-session goal", {
                goal: goal.id,
            });
            await this.config.notify(
                "⚠️ 检测到主会话 goal，已清除；goal 只能由子代理持有。"
            );
        } catch (error) {
            this.config.logger.error("failed to clear main-session goal", {
                error: errorMessage(error),
            });
        }
    }

    private requireMain(): Agent {
        if (this.main === undefined) {
            throw new Error("main agent is not created");
        }
        return this.main;
    }

    private modelRef(): GoalModelRef {
        return { provider: this.config.provider, model: this.config.model };
    }

    private agentOptions(): AgentOptions {
        const effort = this.config.reasoningEffort?.trim();
        return {
            provider: this.config.provider,
            model: this.config.model,
            ...(effort === undefined || effort === ""
                ? {}
                : {
                      reasoningEffort:
                          effort as AgentOptions["reasoningEffort"],
                  }),
        };
    }

    private persist(): void {
        this.config.persist();
    }
}
