import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";

/** What a channel driver can render and accept. */
export interface ChannelCapabilities {
    readonly markdown: "none" | "basic" | "full";
    /** 0 means no length limit. */
    readonly maxTextLength: number;
    readonly inboundImages: boolean;
    readonly outboundFiles: boolean;
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
    readonly receivedAt: number;
    /** Code-level delivery override; only explicit callers set this. */
    readonly delivery?: DeliveryMode;
}

/** Delivery semantics for one inbound message. */
export type DeliveryMode = "steer" | "followup" | "interrupt";

/** Text content accepted by a driver. */
export interface OutboundContent {
    readonly kind: "text";
    readonly text: string;
}

/** Identifier of a message accepted by the platform. */
export interface SentRef {
    readonly channelId: string;
    readonly chatId: string;
    readonly messageId: string;
}

/** Platform adapter contract used by channel core. */
export interface ChannelDriver {
    readonly id: string;
    readonly capabilities: ChannelCapabilities;
    start(handler: { onInbound(message: InboundMessage): void }): Promise<void>;
    stop(): Promise<void>;
    send(chatId: string, content: OutboundContent): Promise<SentRef>;
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
