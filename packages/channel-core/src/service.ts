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
    type OutboundAction,
    type OutboxItem,
    type OutboxKind,
    type RecentLogEntry,
    type RestartReason,
} from "@nokoribi/shared";

import { InteractionBroker, type InteractionAbortReason } from "./broker.js";
import {
    DriverNotFoundError,
    IngressBufferFullError,
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
    type ChannelDriver,
    type ChannelHealth,
    type ChannelRuntime,
    type DeliveryMode,
    type InboundMessage,
    type IngressResult,
} from "./contract.js";
import { SeenStore } from "./dedupe.js";
import { chooseDelivery } from "./delivery.js";
import { formatOutbound } from "./format.js";
import { OutboxStore, type EnqueueInput } from "./outbox.js";
import {
    chatKey,
    pickNoticeRoute,
    remainingReplySlots,
    resolveReplyTarget,
    type ChatRef,
} from "./routing.js";

declare module "@deepseek-ai/cordis" {
    interface Context {
        channels: ChannelService;
    }
}

/** One driver's health plus its id, served by the status document. */
export interface ChannelStatus extends ChannelHealth {
    readonly id: string;
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
    /** Driver health snapshots; absent in older status providers. */
    readonly channels?: readonly ChannelStatus[];
    /** Notices waiting for their chat's next inbound message. */
    readonly deferredNotices?: number;
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

/** Optional outbound extras accepted by reply/notice helpers. */
export interface OutboundOptions {
    readonly actions?: readonly OutboundAction[];
}

/** Channel core configuration. */
export interface ChannelCoreConfig {
    readonly allowedSenders: readonly string[];
    readonly allowedChats: readonly string[];
    readonly defaultChatId: string;
    /** Channels that enforce their own platform-level admission. */
    readonly trustedChannels: readonly string[];
    /** Explicit default channel; empty means the first registered driver. */
    readonly defaultChannelId: string;
    readonly outboxMaxAttempts: number;
    readonly outboxBaseDelayMs: number;
    readonly outboxMaxDelayMs: number;
    readonly outboxHistoryLimit: number;
    readonly dedupeLimit: number;
    readonly ingressBufferLimit: number;
    readonly approvalTimeoutMs: number;
    readonly questionTimeoutMs: number;
    readonly deferredNoticeTtlMs: number;
    readonly deferredNoticePerChatLimit: number;
    readonly deferredNoticeTotalLimit: number;
    readonly deferredNoticesPerInbound: number;
    readonly inboundChatLimit: number;
}

interface Waiter {
    readonly after: number;
    readonly resolve: (items: readonly OutboxItem[]) => void;
    readonly timer: NodeJS.Timeout;
}

interface InboundChatContext {
    readonly chat: ChatRef;
    readonly messageId: string;
    readonly receivedAt: number;
}

interface ReplySeed {
    readonly messageId: string;
    readonly receivedAt: number;
}

interface EnqueueOptions {
    readonly interactionId?: string;
    readonly reply?: ReplySeed;
    readonly actions?: readonly OutboundAction[];
    readonly maxChunks?: number;
    readonly requireReply?: boolean;
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
        trustedChannels: z.array(z.string()).default([]),
        defaultChannelId: z.string().default(""),
        outboxMaxAttempts: z.natural().min(1).default(8),
        outboxBaseDelayMs: z.natural().min(1).default(1000),
        outboxMaxDelayMs: z.natural().min(1).default(60000),
        outboxHistoryLimit: z.natural().min(1).default(1000),
        dedupeLimit: z.natural().min(1).default(5000),
        ingressBufferLimit: z.natural().min(1).default(1000),
        approvalTimeoutMs: z.natural().min(1).default(60000),
        questionTimeoutMs: z.natural().min(1).default(300000),
        deferredNoticeTtlMs: z
            .natural()
            .min(1)
            .default(7 * 24 * 60 * 60 * 1000),
        deferredNoticePerChatLimit: z.natural().min(1).default(5),
        deferredNoticeTotalLimit: z.natural().min(1).default(50),
        deferredNoticesPerInbound: z.natural().min(1).default(1),
        inboundChatLimit: z.natural().min(1).default(100),
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
    private lastActiveChat: ChatRef | null = null;
    private turnChat: ChatRef | null = null;
    private readonly pendingTurnChats: ChatRef[] = [];
    private readonly lastInboundByChat = new Map<string, InboundChatContext>();
    private warnedMissingDefaultChannel = false;
    private notifyingOutboxFailure = false;

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
                await this.enqueueInteractionPrompt(
                    input.text,
                    input.interactionId,
                    input.actions
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
        await this.outbox.pruneDeferred(
            Date.now(),
            this.config.deferredNoticeTtlMs
        );
        for (const channel of this.config.trustedChannels) {
            this.logger.warn("trusted channel enabled (platform limits only)", {
                channel,
            });
        }
        if (
            this.config.defaultChannelId !== "" &&
            !this.drivers.has(this.config.defaultChannelId)
        ) {
            this.logger.warn("configured default channel is not registered", {
                channel: this.config.defaultChannelId,
            });
        }
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
        this.pendingTurnChats.length = 0;
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
    async sendReply(
        text: string,
        options: OutboundOptions = {}
    ): Promise<void> {
        const chat = this.replyTarget();
        if (chat === null) {
            this.logger.error("failed to route reply: no channel target");
            return;
        }
        const driver = this.drivers.get(chat.channelId);
        if (driver === undefined) {
            this.logger.error("failed to route reply: driver missing", {
                channel: chat.channelId,
            });
            return;
        }
        const seed = this.replyContextFor(chat);
        const passive =
            seed !== undefined &&
            this.passiveDeliverable(driver, chat.chatId, "reply", {
                messageId: seed.messageId,
                receivedAt: seed.receivedAt,
                seq: this.nextReplySeq(chat, seed.messageId),
            });
        const active = this.activeDeliverable(driver, chat.chatId, "reply");
        if (!passive && !active) {
            try {
                await this.deferNoticeText(chat, text);
                this.logger.warn("reply deferred: channel is not deliverable", {
                    channel: chat.channelId,
                    chatId: chat.chatId,
                });
            } catch (error) {
                this.logger.error("failed to defer reply", {
                    channel: chat.channelId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        await this.enqueueText("reply", chat, text, {
            ...(passive && seed !== undefined ? { reply: seed } : {}),
            ...(options.actions === undefined
                ? {}
                : { actions: options.actions }),
        });
    }

    /** Stop accepting ingress while keeping the runtime reference. */
    pause(): void {
        this.active = false;
    }

    /** Current last-active chat, if any message was accepted. */
    get activeChat(): ChatRef | null {
        return this.lastActiveChat;
    }

    /** Restore the persisted active chat after recovery. */
    restoreActiveChat(chat: ChatRef | null): void {
        if (chat === null) {
            this.lastActiveChat = null;
            return;
        }
        if (!this.drivers.has(chat.channelId)) {
            this.logger.warn("cannot restore active chat: driver missing", {
                channel: chat.channelId,
            });
            return;
        }
        this.lastActiveChat = { ...chat };
    }

    /** Promote the queued turn source when a turn starts. */
    noteTurnStart(): void {
        const next = this.pendingTurnChats.shift();
        if (next !== undefined) this.turnChat = next;
    }

    /** Forget queued turn sources after a cancel or session switch. */
    clearPendingTurnChats(): void {
        this.pendingTurnChats.length = 0;
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

    /** Send a system notice to the active chat. */
    async notify(text: string, options: OutboundOptions = {}): Promise<void> {
        const body = stripWarningPrefix(text);
        if (body === "") return;
        const route = pickNoticeRoute({
            source: this.turnChat ?? this.lastActiveChat,
            drivers: [...this.drivers.values()],
        });
        if (route.action === "drop") {
            this.logger.warn("dropped notice: no deliverable channel/chat", {
                reason: route.reason,
            });
            return;
        }
        if (route.action === "defer") {
            if (options.actions !== undefined && options.actions.length > 0) {
                this.logger.warn("actions dropped while deferring notice", {
                    channel: route.chat.channelId,
                });
            }
            await this.deferNoticeText(route.chat, body);
            return;
        }
        await this.enqueueText("notice", route.chat, `⚠️ ${body}`, options);
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
            channels: this.channelStatuses(),
            deferredNotices: this.outbox.deferredCount(
                Date.now(),
                this.config.deferredNoticeTtlMs
            ),
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
        if (this.config.defaultChannelId !== "") {
            if (this.drivers.has(this.config.defaultChannelId)) {
                return this.config.defaultChannelId;
            }
            if (!this.warnedMissingDefaultChannel) {
                this.warnedMissingDefaultChannel = true;
                this.logger.warn(
                    "configured default channel is not registered; falling back",
                    { channel: this.config.defaultChannelId }
                );
            }
        }
        const first = this.drivers.keys().next();
        return first.done === true ? "local-test" : first.value;
    }

    private defaultTarget(): ChatRef | null {
        const channelId = this.defaultChannelId();
        if (!this.drivers.has(channelId)) return null;
        return { channelId, chatId: this.config.defaultChatId };
    }

    private replyTarget(): ChatRef | null {
        return resolveReplyTarget(
            this.turnChat,
            this.lastActiveChat,
            this.defaultTarget()
        );
    }

    private replyContextFor(chat: ChatRef): ReplySeed | undefined {
        const context = this.lastInboundByChat.get(chatKey(chat));
        if (context === undefined) return undefined;
        return {
            messageId: context.messageId,
            receivedAt: context.receivedAt,
        };
    }

    private nextReplySeq(chat: ChatRef, messageId: string): number {
        return this.outbox.nextReplySeq(chat.channelId, chat.chatId, messageId);
    }

    private passiveDeliverable(
        driver: ChannelDriver,
        chatId: string,
        kind: OutboxKind,
        reply: {
            readonly messageId: string;
            readonly receivedAt: number;
            readonly seq: number;
        }
    ): boolean {
        if (driver.canDeliver === undefined) return true;
        try {
            return driver.canDeliver(chatId, { kind, reply });
        } catch {
            return false;
        }
    }

    private activeDeliverable(
        driver: ChannelDriver,
        chatId: string,
        kind: OutboxKind
    ): boolean {
        if (driver.canDeliver === undefined) {
            return driver.capabilities.activeMessages !== false;
        }
        try {
            return driver.canDeliver(chatId, { kind });
        } catch {
            return false;
        }
    }

    private async process(message: InboundMessage): Promise<IngressResult> {
        const trusted = this.config.trustedChannels.includes(message.channelId);
        if (
            !trusted &&
            (!this.config.allowedSenders.includes(message.senderId) ||
                !this.config.allowedChats.includes(message.chatId))
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
        const runtime = this.runtime;
        if (runtime === undefined) {
            if (message.action === undefined && text === "") {
                return { accepted: false, duplicate: false, reason: "empty" };
            }
            if (this.buffer.length >= this.config.ingressBufferLimit) {
                throw new IngressBufferFullError(
                    this.config.ingressBufferLimit
                );
            }
            this.buffer.push(message);
            return { accepted: true, duplicate: false, reason: "buffered" };
        }
        const chat: ChatRef = {
            channelId: message.channelId,
            chatId: message.chatId,
        };
        if (message.action !== undefined) {
            this.lastActiveChat = { ...chat };
            runtime.onChatActive?.(chat);
            let consumed = false;
            try {
                consumed = await this.broker.handleAction(message.action);
            } catch (error) {
                this.logger.warn("failed to handle inbound action", {
                    channel: message.channelId,
                    messageId: message.messageId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
            if (!consumed) await this.notifyActionExpired(chat);
            return { accepted: true, duplicate: false };
        }
        if (text === "") {
            return { accepted: false, duplicate: false, reason: "empty" };
        }
        this.lastActiveChat = { ...chat };
        this.rememberInbound(message);
        runtime.onChatActive?.(chat);
        await this.releaseDeferredNotices(message);

        if (text.startsWith("/")) {
            await this.executeCommand(runtime, text, message);
            return { accepted: true, duplicate: false };
        }

        if (this.broker.hasPending() && (await this.broker.handleReply(text))) {
            return { accepted: true, duplicate: false };
        }

        const delivery = this.resolveDelivery(message.delivery, runtime.agent);
        await this.deliverText(runtime.agent, chat, text, delivery);
        return { accepted: true, duplicate: false };
    }

    private async notifyActionExpired(chat: ChatRef): Promise<void> {
        const body =
            "该按钮已失效（审批已处理、已超时或进程重启），请以最新提示为准。";
        const driver = this.drivers.get(chat.channelId);
        if (driver === undefined) {
            this.logger.warn("cannot notify expired action: driver missing", {
                channel: chat.channelId,
            });
            return;
        }
        try {
            const seed = this.replyContextFor(chat);
            if (seed !== undefined) {
                const seq = this.nextReplySeq(chat, seed.messageId);
                const remaining = remainingReplySlots(
                    driver.capabilities.maxRepliesPerReply,
                    seq
                );
                const passive =
                    remaining > 0 &&
                    this.passiveDeliverable(driver, chat.chatId, "notice", {
                        messageId: seed.messageId,
                        receivedAt: seed.receivedAt,
                        seq,
                    });
                if (passive) {
                    await this.enqueueText("notice", chat, `⚠️ ${body}`, {
                        reply: seed,
                    });
                    return;
                }
            }
            if (this.activeDeliverable(driver, chat.chatId, "notice")) {
                await this.enqueueText("notice", chat, `⚠️ ${body}`);
                return;
            }
            await this.deferNoticeText(chat, body);
        } catch (error) {
            this.logger.warn("failed to notify expired action", {
                channel: chat.channelId,
                chatId: chat.chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private rememberInbound(message: InboundMessage): void {
        const chat: ChatRef = {
            channelId: message.channelId,
            chatId: message.chatId,
        };
        const key = chatKey(chat);
        this.lastInboundByChat.delete(key);
        this.lastInboundByChat.set(key, {
            chat,
            messageId: message.messageId,
            receivedAt: message.receivedAt,
        });
        while (this.lastInboundByChat.size > this.config.inboundChatLimit) {
            const oldest = this.lastInboundByChat.keys().next();
            if (oldest.done === true) break;
            this.lastInboundByChat.delete(oldest.value);
        }
    }

    private async releaseDeferredNotices(
        message: InboundMessage
    ): Promise<void> {
        const chat: ChatRef = {
            channelId: message.channelId,
            chatId: message.chatId,
        };
        const driver = this.drivers.get(chat.channelId);
        if (driver === undefined) return;
        const now = Date.now();
        if (
            this.outbox.deferredCount(now, this.config.deferredNoticeTtlMs) ===
            0
        ) {
            return;
        }
        const remaining = remainingReplySlots(
            driver.capabilities.maxRepliesPerReply,
            this.nextReplySeq(chat, message.messageId)
        );
        if (remaining <= 0) {
            this.logger.warn(
                "deferred notices pending but no passive reply slot",
                { channel: chat.channelId, chatId: chat.chatId }
            );
            return;
        }
        const limit = Math.min(
            this.config.deferredNoticesPerInbound,
            remaining
        );
        const notices = this.outbox.listDeferred(
            chat.channelId,
            chat.chatId,
            limit,
            now,
            this.config.deferredNoticeTtlMs
        );
        for (const notice of notices) {
            try {
                await this.enqueueText(
                    "notice",
                    chat,
                    `⚠️ 补发：${notice.text}`,
                    {
                        reply: {
                            messageId: message.messageId,
                            receivedAt: message.receivedAt,
                        },
                        maxChunks: 1,
                        requireReply: true,
                    }
                );
                await this.outbox.removeDeferred([notice.id]);
                this.logger.info("deferred notice replayed", {
                    channel: chat.channelId,
                    chatId: chat.chatId,
                });
            } catch (error) {
                this.logger.error("failed to replay deferred notice", {
                    channel: chat.channelId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                return;
            }
        }
    }

    private async enqueueInteractionPrompt(
        text: string,
        interactionId: string,
        actions?: readonly OutboundAction[]
    ): Promise<void> {
        const chat = this.replyTarget();
        if (chat === null) throw new DriverNotFoundError("default");
        const driver = this.drivers.get(chat.channelId);
        if (driver === undefined) throw new DriverNotFoundError(chat.channelId);
        const seed = this.replyContextFor(chat);
        if (seed !== undefined) {
            const remaining = remainingReplySlots(
                driver.capabilities.maxRepliesPerReply,
                this.nextReplySeq(chat, seed.messageId)
            );
            if (remaining <= 0) {
                throw new NonRetryableDeliveryError(
                    "interaction-undeliverable"
                );
            }
            const passive = this.passiveDeliverable(
                driver,
                chat.chatId,
                "interaction",
                {
                    messageId: seed.messageId,
                    receivedAt: seed.receivedAt,
                    seq: this.nextReplySeq(chat, seed.messageId),
                }
            );
            if (!passive) {
                throw new NonRetryableDeliveryError(
                    "interaction-undeliverable"
                );
            }
            await this.enqueueText("interaction", chat, text, {
                interactionId,
                reply: seed,
                ...(actions === undefined ? {} : { actions }),
            });
            return;
        }
        if (!this.activeDeliverable(driver, chat.chatId, "interaction")) {
            throw new NonRetryableDeliveryError("interaction-undeliverable");
        }
        await this.enqueueText("interaction", chat, text, {
            interactionId,
            ...(actions === undefined ? {} : { actions }),
        });
    }

    private async enqueueText(
        kind: OutboxKind,
        chat: ChatRef,
        text: string,
        options: EnqueueOptions = {}
    ): Promise<void> {
        if (text.trim() === "") return;
        const driver = this.drivers.get(chat.channelId);
        if (driver === undefined) throw new DriverNotFoundError(chat.channelId);
        const capabilities = driver.capabilities;
        const actions = this.selectActions(driver, options.actions);
        let reply = options.reply;
        let maxChunks = options.maxChunks;
        if (reply !== undefined) {
            const remaining = remainingReplySlots(
                capabilities.maxRepliesPerReply,
                this.nextReplySeq(chat, reply.messageId)
            );
            if (remaining !== Number.POSITIVE_INFINITY) {
                if (remaining <= 0) {
                    if (options.requireReply === true) {
                        throw new NonRetryableDeliveryError(
                            "reply-slots-exhausted"
                        );
                    }
                    this.logger.warn(
                        "passive reply slots exhausted; sending active",
                        { channel: chat.channelId, chatId: chat.chatId }
                    );
                    reply = undefined;
                } else if (maxChunks === undefined) {
                    maxChunks = remaining;
                } else {
                    maxChunks = Math.min(maxChunks, remaining);
                }
            }
        }
        const chunks = formatOutbound(
            text,
            capabilities,
            maxChunks === undefined ? {} : { maxChunks }
        );
        if (chunks.length === 0) return;
        const inputs: EnqueueInput[] = chunks.map((chunk, index) => ({
            channelId: chat.channelId,
            chatId: chat.chatId,
            kind,
            text: chunk,
            interactionId: options.interactionId ?? null,
            reply:
                reply === undefined
                    ? null
                    : {
                          messageId: reply.messageId,
                          receivedAt: reply.receivedAt,
                      },
            actions: index === chunks.length - 1 ? (actions ?? null) : null,
        }));
        await this.outbox.enqueueMany(inputs);
        this.notifyWaiters();
        void this.pump();
    }

    private selectActions(
        driver: ChannelDriver,
        actions: readonly OutboundAction[] | undefined
    ): readonly OutboundAction[] | undefined {
        if (actions === undefined || actions.length === 0) return undefined;
        if (driver.capabilities.outboundActions === true) return actions;
        this.logger.warn(
            "channel does not support outbound actions; dropping them",
            { channel: driver.id, count: actions.length }
        );
        return undefined;
    }

    private async deferNoticeText(
        chat: ChatRef,
        text: string
    ): Promise<boolean> {
        const body = stripWarningPrefix(text);
        if (body === "") return false;
        const result = await this.outbox.deferNotice(
            {
                channelId: chat.channelId,
                chatId: chat.chatId,
                text: body,
            },
            {
                perChat: this.config.deferredNoticePerChatLimit,
                total: this.config.deferredNoticeTotalLimit,
                ttlMs: this.config.deferredNoticeTtlMs,
            }
        );
        if (result.dropped > 0) {
            this.logger.warn("deferred notice cap dropped entries", {
                channel: chat.channelId,
                chatId: chat.chatId,
                dropped: result.dropped,
            });
        }
        return true;
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
        chat: ChatRef,
        text: string,
        delivery: DeliveryMode
    ): Promise<void> {
        const wasRunning = agent.status === "running";
        const message = createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
        });
        this.noteTurnSource(chat, delivery, wasRunning);
        if (delivery === "interrupt") {
            agent.cancel({ kind: "user" });
        }
        if (delivery === "followup" || delivery === "interrupt") {
            agent.followup(message);
        } else {
            agent.steer(message);
        }
    }

    private noteTurnSource(
        chat: ChatRef,
        delivery: DeliveryMode,
        wasRunning: boolean
    ): void {
        if (delivery === "interrupt" || !wasRunning) {
            this.turnChat = { ...chat };
            return;
        }
        if (delivery === "followup") {
            this.pendingTurnChats.push({ ...chat });
            while (
                this.pendingTurnChats.length > this.config.inboundChatLimit
            ) {
                this.pendingTurnChats.shift();
            }
            return;
        }
        if (this.turnChat === null) this.turnChat = { ...chat };
    }

    private async executeCommand(
        runtime: ChannelRuntime,
        line: string,
        message: InboundMessage
    ): Promise<void> {
        const chat: ChatRef = {
            channelId: message.channelId,
            chatId: message.chatId,
        };
        const reply: ReplySeed = {
            messageId: message.messageId,
            receivedAt: message.receivedAt,
        };
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
                chat,
                `未知命令：${line.split(/\s+/, 1)[0] ?? line}`,
                { reply }
            );
            return;
        }
        const text = execution.result.text;
        if (text !== undefined && text !== "") {
            await this.enqueueText("reply", chat, text, { reply });
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
        const chat =
            this.lastActiveChat ?? this.turnChat ?? this.defaultTarget();
        if (chat === null) {
            return { kind: "error", text: "没有可用渠道" };
        }
        void this.deliverText(runtime.agent, chat, text, mode).catch(
            (error) => {
                this.logger.error("forced delivery failed", {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        );
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
        let failedReplies = 0;
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
                    await this.outbox.markAttemptFailed(item.seq, null, true);
                    this.logger.error("outbound channel is not registered", {
                        seq: item.seq,
                        channel: item.channelId,
                    });
                    continue;
                }
                const reply = readReply(item);
                const actions =
                    item.actions !== undefined &&
                    item.actions !== null &&
                    item.actions.length > 0 &&
                    driver.capabilities.outboundActions === true
                        ? item.actions
                        : undefined;
                try {
                    await driver.send(item.chatId, {
                        kind: item.kind,
                        text: item.text,
                        deliveryId: item.seq,
                        attempt: item.attempts,
                        ...(reply === undefined ? {} : { reply }),
                        ...(actions === undefined ? {} : { actions }),
                    });
                    await this.outbox.markSent(item.seq);
                    this.notifyWaiters();
                    progressed = true;
                } catch (error) {
                    const outcome = await this.handleFailure(item, error);
                    if (outcome === "retry-now") progressed = true;
                    if (outcome === "failed-reply") failedReplies += 1;
                }
            }
        }
        if (failedReplies > 0) {
            await this.emitOutboxFailureNotice(failedReplies);
        }
    }

    private async handleFailure(
        item: OutboxItem,
        error: unknown
    ): Promise<"retry" | "retry-now" | "failed" | "failed-reply" | "deferred"> {
        if (
            error instanceof PassiveReplyExpiredError &&
            item.replyTo !== null &&
            item.replyTo !== undefined
        ) {
            await this.outbox.clearReply(item.seq);
            this.logger.warn(
                "passive reply expired; retrying as an active message",
                { seq: item.seq }
            );
            return "retry-now";
        }
        const attempts = item.attempts + 1;
        const permanent = error instanceof NonRetryableDeliveryError;
        const exhausted = attempts >= this.config.outboxMaxAttempts;
        const deferrable =
            (item.replyTo === null || item.replyTo === undefined) &&
            (item.kind === "notice" || item.kind === "reply");
        if ((permanent || exhausted) && deferrable) {
            if (await this.tryDeferFailed(item)) {
                this.logger.warn("outbound entry deferred", {
                    seq: item.seq,
                    kind: item.kind,
                    channel: item.channelId,
                });
                return "deferred";
            }
        }
        if (permanent || exhausted) {
            await this.outbox.markAttemptFailed(item.seq, null, true);
            this.logger.error("outbound delivery failed", {
                seq: item.seq,
                attempts,
                exhausted,
                error: error instanceof Error ? error.message : String(error),
            });
            return item.kind === "reply" && exhausted
                ? "failed-reply"
                : "failed";
        }
        const delay = Math.min(
            this.config.outboxMaxDelayMs,
            this.config.outboxBaseDelayMs * 2 ** (attempts - 1)
        );
        await this.outbox.markAttemptFailed(
            item.seq,
            new Date(Date.now() + delay).toISOString(),
            false
        );
        this.logger.error("outbound delivery failed", {
            seq: item.seq,
            attempts,
            exhausted: false,
            error: error instanceof Error ? error.message : String(error),
        });
        this.schedule(() => void this.pump(), delay);
        return "retry";
    }

    private async tryDeferFailed(item: OutboxItem): Promise<boolean> {
        try {
            const deferred = await this.deferNoticeText(
                { channelId: item.channelId, chatId: item.chatId },
                item.text
            );
            if (!deferred) return false;
            await this.outbox.markDiscarded(item.seq);
            return true;
        } catch (error) {
            this.logger.error("failed to defer outbound entry", {
                seq: item.seq,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private async emitOutboxFailureNotice(count: number): Promise<void> {
        if (this.notifyingOutboxFailure) return;
        const route = pickNoticeRoute({
            source: this.turnChat ?? this.lastActiveChat,
            drivers: [...this.drivers.values()],
        });
        if (route.action !== "send") {
            this.logger.warn(
                "outbox failures were not notified: no active channel",
                { count }
            );
            return;
        }
        this.notifyingOutboxFailure = true;
        try {
            await this.notify(
                `有 ${String(count)} 条消息发送失败，请检查日志。`
            );
            this.schedule(() => void this.pump(), 0);
        } catch (error) {
            this.logger.error("failed to notify outbox failures", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.notifyingOutboxFailure = false;
        }
    }

    private channelStatuses(): readonly ChannelStatus[] {
        return [...this.drivers.values()].map((driver) => {
            if (driver.health === undefined) {
                return {
                    id: driver.id,
                    state:
                        driver.capabilities.activeMessages === false
                            ? ("offline" as const)
                            : ("online" as const),
                };
            }
            try {
                return { id: driver.id, ...driver.health() };
            } catch {
                return {
                    id: driver.id,
                    state: "offline" as const,
                    detail: "health check failed",
                };
            }
        });
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

/** Strip one leading warning marker from a notice body. */
function stripWarningPrefix(text: string): string {
    const trimmed = text.trim();
    return trimmed.startsWith("⚠️") ? trimmed.slice(2).trimStart() : trimmed;
}

/** Build a passive reply context from one outbox entry, if complete. */
function readReply(item: OutboxItem):
    | {
          readonly messageId: string;
          readonly receivedAt: number;
          readonly seq: number;
      }
    | undefined {
    const messageId = item.replyTo;
    const receivedAt = item.replyReceivedAt;
    const seq = item.replySeq;
    if (
        messageId === null ||
        messageId === undefined ||
        receivedAt === null ||
        receivedAt === undefined ||
        seq === null ||
        seq === undefined
    ) {
        return undefined;
    }
    return { messageId, receivedAt, seq };
}

export default ChannelService;
export const name = "channel-core";
export const inject: string[] = [
    "agents",
    "commands",
    "approval",
    "userQuestions",
];
