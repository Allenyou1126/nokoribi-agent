import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import z from "@deepseek-ai/schemastery";
import {
    createLogger,
    ensureHomeDirs,
    resolveHomePaths,
    type Logger,
    type OutboxItem,
    type RecentLogEntry,
    type RestartReason,
} from "@nokoribi/shared";

import { InteractionBroker, type InteractionAbortReason } from "./broker.js";
import type {
    ChannelDriver,
    ChannelRuntime,
    DeliveryMode,
    InboundMessage,
    IngressResult,
} from "./contract.js";
import { IngressBufferFullError } from "./contract.js";
import { SeenStore } from "./dedupe.js";
import { chooseDelivery } from "./delivery.js";
import { formatOutbound } from "./format.js";
import { OutboxStore } from "./outbox.js";

declare module "@deepseek-ai/cordis" {
    interface Context {
        channels: ChannelService;
    }
}

/** Public status document served by the local test channel. */
export interface DaemonStatus {
    readonly version: string;
    readonly uptimeSec: number;
    readonly mainSessionId: string | null;
    readonly agentStatus: "starting" | "idle" | "running";
    readonly goals: readonly unknown[];
    readonly pendingInteractions: number;
    readonly outboxLength: number;
    readonly permission: string | null;
    readonly lastRestartReason: RestartReason | null;
    readonly ready: boolean;
}

/** Status source installed by agent-app once the main session is live. */
export type StatusProvider = () => Omit<
    DaemonStatus,
    "outboxLength" | "pendingInteractions"
> & {
    readonly pendingInteractions?: number;
};

/** One reviewer route shown in full status. */
export interface ReviewerRouteStatus {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}

/** Reviewer configuration shown in full status. */
export interface ReviewerStatus {
    readonly fast: ReviewerRouteStatus;
    readonly strong: ReviewerRouteStatus;
    readonly timeoutMs: number;
}

/** One goal in full status. */
export interface FullGoalStatus {
    readonly shortId: string;
    readonly sessionId: string;
    readonly goalId: string;
    readonly objective: string;
    readonly phase: string;
    readonly roundsStarted: number;
    readonly maxGoalRounds: number;
    readonly model: string | null;
    readonly childStatus: "running" | "idle" | "cold";
    readonly sandbox: FullSandboxStatus | null;
}

/** One per-session sandbox in full status. */
export interface FullSandboxStatus {
    readonly host: string;
    readonly sessionId: string;
    readonly dir: string;
    readonly exists: boolean;
    readonly generation: number;
    readonly packages: readonly string[];
    readonly createdAt: string | null;
    readonly lastUsedAt: string | null;
    readonly idleTtlMs: number;
    readonly activeCommands: number;
    readonly backgroundCommands: number;
    readonly error?: string;
}

/** One active reminder in full status. */
export interface FullScheduleStatus {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly scheduledAt: string;
    readonly state: string;
}

/** Memory-store counts in full status. */
export interface FullMemoryStatus {
    readonly activeEntries: number;
    readonly archivedEntries: number;
    readonly invalidEntries: number;
    readonly bytes: number;
}

/** Detailed status returned by `/status full` and `GET /v1/status?full=1`. */
export interface FullStatusDetails {
    readonly workspace: string;
    readonly state: string;
    readonly lock: string;
    readonly storage: string;
    readonly nextOutboxSeq: number;
    readonly dshVersion: string;
    readonly appVersion: string;
    readonly model: ReviewerRouteStatus;
    readonly reviewer: ReviewerStatus | null;
    readonly goals: readonly FullGoalStatus[];
    readonly schedules: readonly FullScheduleStatus[];
    readonly sandboxes: readonly FullSandboxStatus[];
    readonly memory: FullMemoryStatus;
    readonly recentErrors: readonly RecentLogEntry[];
    readonly lastVersion: string;
    readonly lastStartedAt: string | null;
    readonly restartReason: RestartReason | null;
}

/** Full-status source installed by agent-app. */
export type FullStatusProvider = () => Promise<FullStatusDetails>;

/** Channel core configuration. */
export interface ChannelCoreConfig {
    readonly allowedSenders: readonly string[];
    readonly allowedChats: readonly string[];
    readonly defaultChatId: string;
    readonly outboxMaxAttempts: number;
    readonly outboxBaseDelayMs: number;
    readonly outboxMaxDelayMs: number;
    readonly outboxHistoryLimit: number;
    readonly dedupeLimit: number;
    readonly ingressBufferLimit: number;
    readonly approvalTimeoutMs: number;
    readonly questionTimeoutMs: number;
}

interface Waiter {
    readonly after: number;
    readonly resolve: (items: readonly OutboxItem[]) => void;
    readonly timer: NodeJS.Timeout;
}

/**
 * Channel core: driver registry, ingress pipeline, dedupe, outbox, and
 * delivery. It is usable before the main agent exists: inbound messages are
 * buffered until `attachRuntime` releases them.
 */
export class ChannelService extends Service {
    static readonly inject: string[] = [
        "agents",
        "commands",
        "approval",
        "userQuestions",
    ];

    static readonly Config: unknown = z.object({
        allowedSenders: z.array(z.string()).default(["local-user"]),
        allowedChats: z.array(z.string()).default(["local"]),
        defaultChatId: z.string().default("local"),
        outboxMaxAttempts: z.natural().min(1).default(8),
        outboxBaseDelayMs: z.natural().min(1).default(1000),
        outboxMaxDelayMs: z.natural().min(1).default(60000),
        outboxHistoryLimit: z.natural().min(1).default(1000),
        dedupeLimit: z.natural().min(1).default(5000),
        ingressBufferLimit: z.natural().min(1).default(1000),
        approvalTimeoutMs: z.natural().min(1).default(60000),
        questionTimeoutMs: z.natural().min(1).default(300000),
    });

    private readonly config: ChannelCoreConfig;
    private readonly logger: Logger;
    private readonly outbox: OutboxStore;
    private readonly seen: SeenStore;
    private readonly broker: InteractionBroker;
    private staleInteractions = 0;
    private readonly drivers = new Map<string, ChannelDriver>();
    private readonly buffer: InboundMessage[] = [];
    private readonly waiters = new Set<Waiter>();
    private readonly timers = new Set<NodeJS.Timeout>();
    private runtime: ChannelRuntime | undefined;
    private statusProvider: StatusProvider | undefined;
    private fullStatusProvider: FullStatusProvider | undefined;
    private active = false;
    private disposed = false;
    private oneShot: DeliveryMode | null = null;
    private ingressChain: Promise<unknown> = Promise.resolve();
    private pumping: Promise<void> | undefined;
    private lastActiveChat: {
        channelId: string;
        chatId: string;
    } | null = null;

    constructor(ctx: Context, config: ChannelCoreConfig) {
        super(ctx, "channels");
        this.config = config;
        this.logger = createLogger("channel-core");
        const paths = resolveHomePaths();
        void ensureHomeDirs(paths);
        this.outbox = new OutboxStore(
            join(paths.stateDir, "outbox.json"),
            config.outboxHistoryLimit
        );
        this.seen = new SeenStore(
            join(paths.stateDir, "ingress-seen.json"),
            config.dedupeLimit
        );
        this.broker = new InteractionBroker({
            approvalTimeoutMs: config.approvalTimeoutMs,
            questionTimeoutMs: config.questionTimeoutMs,
            logger: createLogger("interaction-broker"),
            sendPrompt: async (input) => {
                const chat = this.lastActiveChat ?? {
                    channelId: this.defaultChannelId(),
                    chatId: this.config.defaultChatId,
                };
                await this.enqueueText(
                    "interaction",
                    chat.chatId,
                    input.text,
                    input.interactionId
                );
            },
            sendNotice: async (text) => {
                await this.notify(text);
            },
            onTerminal: (interactionId) => {
                void this.outbox
                    .failPendingInteraction(interactionId)
                    .catch((error: unknown) => {
                        this.logger.error(
                            "failed to discard interaction prompt",
                            {
                                interactionId,
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            }
                        );
                    });
            },
        });
        this.registerCommands();
        ctx.effect(() =>
            ctx.on("approval/request", (request) =>
                this.broker.requestApproval(request)
            )
        );
        ctx.effect(() =>
            ctx.on("user-questions/request", (request) =>
                this.broker.requestQuestion(request)
            )
        );
        ctx.effect(() => () => this.dispose());
    }

    /** Load durable outbox and dedupe state without activating ingress. */
    async initialize(): Promise<void> {
        await this.outbox.load();
        await this.seen.load();
        this.staleInteractions = await this.outbox.failPendingInteractions();
    }

    /** Install the status source used by `/v1/status` and `/status`. */
    setStatusProvider(provider: StatusProvider | undefined): void {
        this.statusProvider = provider;
    }

    /** Install the detailed status source used by `/status full`. */
    setFullStatusProvider(provider: FullStatusProvider | undefined): void {
        this.fullStatusProvider = provider;
    }

    /**
     * Read detailed status for `/status full` and `/v1/status?full=1`.
     * @returns the installed details, or a minimal empty document.
     */
    async fullStatus(): Promise<FullStatusDetails> {
        if (this.fullStatusProvider !== undefined) {
            return await this.fullStatusProvider();
        }
        return {
            workspace: "",
            state: "",
            lock: "",
            storage: "",
            nextOutboxSeq: this.outbox.nextSeq,
            dshVersion: "unknown",
            appVersion: "unknown",
            model: { provider: "unknown", model: "unknown" },
            reviewer: null,
            goals: [],
            schedules: [],
            sandboxes: [],
            memory: {
                activeEntries: 0,
                archivedEntries: 0,
                invalidEntries: 0,
                bytes: 0,
            },
            recentErrors: [],
            lastVersion: "unknown",
            lastStartedAt: null,
            restartReason: null,
        };
    }

    /** Register and start one driver. Returns a disposer that stops it. */
    async registerDriver(driver: ChannelDriver): Promise<() => void> {
        if (this.drivers.has(driver.id)) {
            throw new Error(
                `channel driver ${driver.id} is already registered`
            );
        }
        this.drivers.set(driver.id, driver);
        try {
            await driver.start({
                onInbound: (message) => {
                    void this.ingress(message).catch((error: unknown) => {
                        this.logger.error("ingress failed", {
                            channel: message.channelId,
                            messageId: message.messageId,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });
                    });
                },
            });
        } catch (error) {
            this.drivers.delete(driver.id);
            throw error;
        }
        this.logger.info("driver started", { channel: driver.id });
        void this.pump();
        return () => {
            this.drivers.delete(driver.id);
            void driver.stop();
        };
    }

    /**
     * Attach (or replace) the live main agent. Buffered ingress stays queued
     * until the caller finishes recovery and calls {@link drainBuffered}.
     */
    async attachRuntime(runtime: ChannelRuntime): Promise<void> {
        this.runtime = runtime;
        this.active = true;
        await this.outbox.load();
        await this.seen.load();
        this.logger.info("runtime attached", {
            session: runtime.mainSessionId,
        });
        void this.pump();
    }

    /** Retry pending outbox entries and wait for the current pump pass. */
    async resumeOutbox(): Promise<void> {
        await this.pump();
        if (this.staleInteractions > 0 && this.runtime !== undefined) {
            const count = this.staleInteractions;
            this.staleInteractions = 0;
            await this.notify(
                `上次有 ${String(count)} 条待审批/提问，进程重启后已失效。`
            );
        }
    }

    /** Release buffered ingress in arrival order. */
    async drainBuffered(): Promise<void> {
        const buffered = this.buffer.splice(0, this.buffer.length);
        for (const message of buffered) {
            try {
                await this.process(message);
            } catch (error) {
                this.logger.error("buffered ingress failed", {
                    messageId: message.messageId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /** Abort every pending approval/question and optionally notify the user. */
    async abortInteractions(reason: InteractionAbortReason): Promise<void> {
        await this.broker.abortAll(reason, reason !== "disposed");
    }

    /** Send one final assistant reply to the active chat. */
    async sendReply(text: string): Promise<void> {
        const chat = this.lastActiveChat ?? {
            channelId: this.defaultChannelId(),
            chatId: this.config.defaultChatId,
        };
        await this.enqueueText("reply", chat.chatId, text);
    }

    /** Stop accepting ingress while keeping the runtime reference. */
    pause(): void {
        this.active = false;
    }

    /** Current last-active chat, if any message was accepted. */
    get activeChat(): { channelId: string; chatId: string } | null {
        return this.lastActiveChat;
    }

    /** Feed one normalized inbound message. */
    async ingress(message: InboundMessage): Promise<IngressResult> {
        if (message.images !== undefined && message.images.length > 0) {
            return {
                accepted: false,
                duplicate: false,
                reason: "unsupported-images",
            };
        }
        if (!this.active || this.runtime === undefined) {
            if (this.buffer.length >= this.config.ingressBufferLimit) {
                throw new IngressBufferFullError(
                    this.config.ingressBufferLimit
                );
            }
            this.buffer.push(message);
            return { accepted: true, duplicate: false, reason: "buffered" };
        }
        const task = this.ingressChain.then(() => this.process(message));
        this.ingressChain = task.then(
            () => undefined,
            () => undefined
        );
        return task;
    }

    /** Enqueue one already-formatted outbound text. */
    async enqueueText(
        kind: "reply" | "notice" | "interaction",
        chatId: string,
        text: string,
        interactionId?: string
    ): Promise<void> {
        if (text.trim() === "") return;
        const channelId =
            this.lastActiveChat?.channelId ?? this.defaultChannelId();
        const driver = this.drivers.get(channelId);
        const capabilities = driver?.capabilities ?? {
            markdown: "basic" as const,
            maxTextLength: 0,
            inboundImages: false,
            outboundFiles: false,
        };
        for (const chunk of formatOutbound(text, capabilities)) {
            await this.outbox.enqueue({
                channelId,
                chatId,
                kind,
                text: chunk,
                interactionId: interactionId ?? null,
            });
        }
        this.notifyWaiters();
        void this.pump();
    }

    /** Send a system notice to the last active chat. */
    async notify(text: string): Promise<void> {
        const chat = this.lastActiveChat ?? {
            channelId: this.defaultChannelId(),
            chatId: this.config.defaultChatId,
        };
        const prefixed = text.startsWith("⚠️") ? text : `⚠️ ${text}`;
        await this.enqueueText("notice", chat.chatId, prefixed);
    }

    /** Read retained outbox history after `after`. */
    historyAfter(after: number): readonly OutboxItem[] {
        return this.outbox.historyAfter(after);
    }

    /** Wait for at least one outbox entry newer than `after`. */
    waitForOutbound(
        after: number,
        timeoutMs: number
    ): Promise<readonly OutboxItem[]> {
        const existing = this.outbox.historyAfter(after);
        if (existing.length > 0) return Promise.resolve(existing);
        return new Promise((resolve) => {
            const waiter: Waiter = {
                after,
                resolve: (items) => {
                    clearTimeout(waiter.timer);
                    this.waiters.delete(waiter);
                    resolve(items);
                },
                timer: setTimeout(() => {
                    this.waiters.delete(waiter);
                    resolve([]);
                }, timeoutMs),
            };
            this.waiters.add(waiter);
        });
    }

    /** Current status document. */
    status(): DaemonStatus {
        const base = this.statusProvider?.() ?? {
            version: "0.0.0-dev",
            uptimeSec: Math.floor(process.uptime()),
            mainSessionId: this.runtime?.mainSessionId ?? null,
            agentStatus:
                this.runtime === undefined
                    ? ("starting" as const)
                    : this.agentStatus(),
            goals: [],
            permission: null,
            lastRestartReason: null,
            ready: this.runtime !== undefined,
        };
        return {
            ...base,
            pendingInteractions: this.broker.pendingCount,
            outboxLength: this.outbox.pendingCount,
        };
    }

    /** Next outbox sequence number that will be allocated. */
    get nextOutboxSeq(): number {
        return this.outbox.nextSeq;
    }

    /** Number of entries still pending delivery. */
    get outboxLength(): number {
        return this.outbox.pendingCount;
    }

    private agentStatus(): "idle" | "running" {
        return this.runtime?.agent.status === "running" ? "running" : "idle";
    }

    private defaultChannelId(): string {
        const first = this.drivers.keys().next();
        return first.done === true ? "local-test" : first.value;
    }

    private async process(message: InboundMessage): Promise<IngressResult> {
        if (
            !this.config.allowedSenders.includes(message.senderId) ||
            !this.config.allowedChats.includes(message.chatId)
        ) {
            this.logger.warn("dropped inbound outside allowlist", {
                channel: message.channelId,
                messageId: message.messageId,
            });
            return { accepted: false, duplicate: false, reason: "not-allowed" };
        }
        const key = `${message.channelId}\u0000${message.messageId}`;
        if (this.seen.has(key)) {
            return { accepted: true, duplicate: true };
        }
        await this.seen.add(key);
        const text = message.text?.trim() ?? "";
        if (text === "") {
            return { accepted: false, duplicate: false, reason: "empty" };
        }
        const runtime = this.runtime;
        if (runtime === undefined) {
            if (this.buffer.length >= this.config.ingressBufferLimit) {
                throw new IngressBufferFullError(
                    this.config.ingressBufferLimit
                );
            }
            this.buffer.push(message);
            return { accepted: true, duplicate: false, reason: "buffered" };
        }
        this.lastActiveChat = {
            channelId: message.channelId,
            chatId: message.chatId,
        };
        runtime.onChatActive?.({
            channelId: message.channelId,
            chatId: message.chatId,
        });

        if (text.startsWith("/")) {
            await this.executeCommand(runtime, text, message);
            return { accepted: true, duplicate: false };
        }

        if (this.broker.hasPending() && (await this.broker.handleReply(text))) {
            return { accepted: true, duplicate: false };
        }

        const delivery = this.resolveDelivery(message.delivery, runtime.agent);
        await this.deliverText(runtime.agent, text, delivery);
        return { accepted: true, duplicate: false };
    }

    private resolveDelivery(
        explicit: DeliveryMode | undefined,
        agent: Agent
    ): DeliveryMode {
        const choice = chooseDelivery(
            explicit,
            this.oneShot,
            agent.status === "running" ? "running" : "idle"
        );
        if (choice.consumedOneShot) this.oneShot = null;
        return choice.mode;
    }

    private async deliverText(
        agent: Agent,
        text: string,
        delivery: DeliveryMode
    ): Promise<void> {
        const message = createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
        });
        if (delivery === "interrupt") {
            agent.cancel({ kind: "user" });
        }
        if (delivery === "followup" || delivery === "interrupt") {
            agent.followup(message);
        } else {
            agent.steer(message);
        }
    }

    private async executeCommand(
        runtime: ChannelRuntime,
        line: string,
        message: InboundMessage
    ): Promise<void> {
        const controller = new AbortController();
        const execution = await runtime.commands.execute(
            runtime.agent,
            line,
            [],
            controller.signal
        );
        if (execution === undefined) {
            await this.enqueueText(
                "reply",
                message.chatId,
                `未知命令：${line.split(/\s+/, 1)[0] ?? line}`
            );
            return;
        }
        const text = execution.result.text;
        if (text !== undefined && text !== "") {
            await this.enqueueText("reply", message.chatId, text);
        }
    }

    private registerCommands(): void {
        this.ctx.effect(() =>
            this.ctx.commands.register({
                name: "steer",
                description:
                    "Force the next delivery to steer; bare sets one-shot mode",
                input: { hint: "text" },
                handler: (invocation) => this.steerCommand(invocation.rawInput),
            })
        );
        this.ctx.effect(() =>
            this.ctx.commands.register({
                name: "queue",
                description:
                    "Force the next delivery to followup; bare sets one-shot mode",
                input: { hint: "text" },
                handler: (invocation) => this.queueCommand(invocation.rawInput),
            })
        );
    }

    private steerCommand(rawInput: string): CommandResult {
        return this.forcedDelivery("steer", rawInput);
    }

    private queueCommand(rawInput: string): CommandResult {
        return this.forcedDelivery("followup", rawInput);
    }

    private forcedDelivery(
        mode: Exclude<DeliveryMode, "interrupt">,
        rawInput: string
    ): CommandResult {
        const runtime = this.runtime;
        if (runtime === undefined) {
            return { kind: "error", text: "主会话尚未就绪" };
        }
        const text = rawInput.trim();
        if (text === "") {
            this.oneShot = mode;
            return {
                kind: "success",
                text:
                    mode === "steer"
                        ? "下一条消息将强制使用 steer"
                        : "下一条消息将强制使用 followup",
            };
        }
        void this.deliverText(runtime.agent, text, mode).catch((error) => {
            this.logger.error("forced delivery failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
        return {
            kind: "success",
            text: mode === "steer" ? "已 steer" : "已排队",
        };
    }

    private notifyWaiters(): void {
        for (const waiter of this.waiters) {
            const items = this.outbox.historyAfter(waiter.after);
            if (items.length > 0) waiter.resolve(items);
        }
    }

    private async pump(): Promise<void> {
        if (this.pumping !== undefined) return this.pumping;
        this.pumping = this.pumpOnce().finally(() => {
            this.pumping = undefined;
        });
        return this.pumping;
    }

    private async pumpOnce(): Promise<void> {
        if (this.disposed || this.runtime === undefined) return;
        let progressed = true;
        while (progressed) {
            progressed = false;
            await this.outbox.load();
            for (const item of this.outbox.pending()) {
                if (this.disposed) return;
                if (
                    item.kind === "interaction" &&
                    item.interactionId !== null &&
                    this.broker.isTerminal(item.interactionId)
                ) {
                    await this.outbox.markDiscarded(item.seq);
                    this.notifyWaiters();
                    progressed = true;
                    continue;
                }
                if (item.nextAttemptAt !== null) {
                    const delay = Date.parse(item.nextAttemptAt) - Date.now();
                    if (delay > 0) {
                        this.schedule(() => void this.pump(), delay);
                        continue;
                    }
                }
                const driver = this.drivers.get(item.channelId);
                if (driver === undefined) {
                    this.schedule(
                        () => void this.pump(),
                        this.config.outboxBaseDelayMs
                    );
                    continue;
                }
                try {
                    await driver.send(item.chatId, {
                        kind: "text",
                        text: item.text,
                    });
                    await this.outbox.markSent(item.seq);
                    this.notifyWaiters();
                    progressed = true;
                } catch (error) {
                    const attempts = item.attempts + 1;
                    const exhausted = attempts >= this.config.outboxMaxAttempts;
                    const delay = Math.min(
                        this.config.outboxMaxDelayMs,
                        this.config.outboxBaseDelayMs * 2 ** (attempts - 1)
                    );
                    await this.outbox.markAttemptFailed(
                        item.seq,
                        exhausted
                            ? null
                            : new Date(Date.now() + delay).toISOString(),
                        exhausted
                    );
                    this.logger.error("outbound delivery failed", {
                        seq: item.seq,
                        attempts,
                        exhausted,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                    if (!exhausted) {
                        this.schedule(() => void this.pump(), delay);
                    }
                }
            }
        }
    }

    private schedule(task: () => void, delay: number): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            task();
        }, delay);
        this.timers.add(timer);
    }

    private async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.active = false;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve([]);
        }
        this.waiters.clear();
        const drivers = [...this.drivers.values()];
        this.drivers.clear();
        await this.broker.dispose();
        await Promise.allSettled(drivers.map((driver) => driver.stop()));
        await this.outbox.flush();
        await this.seen.flush();
    }
}

export default ChannelService;
export const name = "channel-core";
export const inject: string[] = [
    "agents",
    "commands",
    "approval",
    "userQuestions",
];
