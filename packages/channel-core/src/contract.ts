import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";
import type {
    OutboundAction,
    OutboundActionKind,
    OutboxKind,
} from "@nokoribi/shared";

export type { OutboundAction, OutboundActionKind };

/** What a channel driver can render and accept. */
export interface ChannelCapabilities {
    readonly markdown: "none" | "basic" | "full";
    /** 0 means no length limit. */
    readonly maxTextLength: number;
    readonly inboundImages: boolean;
    readonly outboundFiles: boolean;
    /** Whether `send()` can render `OutboundContent.actions`. */
    readonly outboundActions?: boolean;
    /** Whether the driver reports button/menu callbacks as `InboundAction`. */
    readonly inboundActions?: boolean;
    /**
     * Whether the driver can deliver without a passive reply context.
     * Absent means yes; QQ reports false while active messages are unavailable.
     */
    readonly activeMessages?: boolean;
    /** Maximum passive replies per inbound message; absent or 0 means no cap. */
    readonly maxRepliesPerReply?: number;
}

/** One action callback reported by a channel driver. */
export interface InboundAction {
    /** Platform callback/button id. */
    readonly id: string;
    /** Opaque callback payload provided by the platform. */
    readonly payload?: string;
    /** Robot message the action belongs to, when the platform provides it. */
    readonly messageId?: string;
}

/** One inbound platform message, already normalized by the driver. */
export interface InboundMessage {
    readonly channelId: string;
    readonly chatId: string;
    readonly senderId: string;
    /** Channel-level idempotency key. */
    readonly messageId: string;
    readonly text?: string;
    readonly images?: readonly {
        readonly mime: string;
        readonly data: Uint8Array;
    }[];
    readonly replyTo?: string;
    /** Set when this message is a button/menu action callback. */
    readonly action?: InboundAction;
    readonly receivedAt: number;
    /** Code-level delivery override; only explicit callers set this. */
    readonly delivery?: DeliveryMode;
}

/** Delivery semantics for one inbound message. */
export type DeliveryMode = "steer" | "followup" | "interrupt";

/** Passive reply context for one outbound message. */
export interface ReplyContext {
    /** Platform message id this outbound message replies to. */
    readonly messageId: string;
    /** Platform message time in milliseconds, for window checks. */
    readonly receivedAt: number;
    /** 1-based reply slot for `messageId` (QQ `msg_seq`). */
    readonly seq: number;
}

/** One already-formatted outbound message accepted by a driver. */
export interface OutboundContent {
    readonly kind: OutboxKind;
    readonly text: string;
    /** Durable outbox sequence number; stable across retries and restarts. */
    readonly deliveryId: number;
    /** Failed attempts before this delivery attempt. */
    readonly attempt: number;
    readonly reply?: ReplyContext;
    /** Optional action widgets; drivers without `outboundActions` never see them. */
    readonly actions?: readonly OutboundAction[];
}

/** Identifier of a message accepted by the platform. */
export interface SentRef {
    readonly channelId: string;
    readonly chatId: string;
    readonly messageId: string;
}

/** One driver's connection health. */
export interface ChannelHealth {
    readonly state: "online" | "connecting" | "offline";
    readonly detail?: string;
}

/** Platform adapter contract used by channel core. */
export interface ChannelDriver {
    readonly id: string;
    readonly capabilities: ChannelCapabilities;
    /** Chat this driver can address without an inbound context, if any. */
    readonly defaultChatId?: string;
    start(handler: { onInbound(message: InboundMessage): void }): Promise<void>;
    stop(): Promise<void>;
    send(chatId: string, content: OutboundContent): Promise<SentRef>;
    /** Optional pre-delivery check used before enqueueing prompts/notices. */
    canDeliver?(
        chatId: string,
        content: Pick<OutboundContent, "kind" | "reply">
    ): boolean;
    /** Optional health snapshot surfaced by `status()`. */
    health?(): ChannelHealth;
}

/** Live main-agent runtime attached after recovery completes. */
export interface ChannelRuntime {
    readonly agent: Agent;
    readonly commands: CommandRuntime;
    readonly mainSessionId: string;
    /** Called whenever an accepted message updates the active chat. */
    readonly onChatActive?: (chat: {
        readonly channelId: string;
        readonly chatId: string;
    }) => void;
}

/** Result of feeding one inbound message into the pipeline. */
export interface IngressResult {
    readonly accepted: boolean;
    readonly duplicate: boolean;
    readonly reason?:
        | "not-allowed"
        | "buffered"
        | "unsupported-images"
        | "paused"
        | "empty";
}

/** Raised when the startup buffer is full. */
export class IngressBufferFullError extends Error {
    constructor(limit: number) {
        super(`inbound buffer is full (limit ${limit})`);
        this.name = "IngressBufferFullError";
    }
}

/** Raised when a driver cannot be resolved for an outbound entry. */
export class DriverNotFoundError extends Error {
    constructor(channelId: string) {
        super(`no channel driver registered for ${channelId}`);
        this.name = "DriverNotFoundError";
    }
}

/** Raised when a driver cannot deliver a message and retrying is pointless. */
export class NonRetryableDeliveryError extends Error {
    readonly reason: string;

    constructor(reason: string, message?: string) {
        super(message ?? reason);
        this.name = "NonRetryableDeliveryError";
        this.reason = reason;
    }
}

/**
 * Raised by a driver when the passive reply context is no longer valid.
 * Channel core drops the reply context and retries once as an active message.
 */
export class PassiveReplyExpiredError extends NonRetryableDeliveryError {
    readonly retryWithoutReply: true = true;

    constructor(message = "passive reply context expired") {
        super("passive-reply-expired", message);
        this.name = "PassiveReplyExpiredError";
    }
}
