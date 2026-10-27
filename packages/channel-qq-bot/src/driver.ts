import type {
    ChannelCapabilities,
    ChannelDriver,
    ChannelHealth,
    InboundMessage,
    OutboundContent,
    ReplyContext,
    SentRef,
} from "@nokoribi/channel-core";
import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
} from "@nokoribi/channel-core";
import type { Logger } from "@nokoribi/shared";
import type { ChatScope } from "@tencent-connect/qqbot-nodejs/protocol";

import {
    resolveActiveMessageDisableMs,
    resolveReplyWindowMarginMs,
    type QqBotConfig,
} from "./config.js";
import {
    classifySendError,
    safeErrorFields,
    toDeliveryError,
} from "./errors.js";
import { SendLimiter } from "./limiter.js";
import { normalizeInbound } from "./normalize.js";
import type { QqGatewayClient, QqRestClient } from "./transport.js";

/** One parsed `chatId` with its QQ scope. */
export interface ParsedQqChat {
    readonly scope: ChatScope;
    readonly targetId: string;
}

/** Parse the namespaced `c2c:<openid>` / `group:<openid>` chat id. */
export function parseChatId(chatId: string): ParsedQqChat | null {
    if (chatId.startsWith("c2c:")) {
        const targetId = chatId.slice("c2c:".length).trim();
        return targetId === "" ? null : { scope: "c2c", targetId };
    }
    if (chatId.startsWith("group:")) {
        const targetId = chatId.slice("group:".length).trim();
        return targetId === "" ? null : { scope: "group", targetId };
    }
    return null;
}

/** Options for the QQ channel driver. */
export interface QqBotDriverOptions {
    readonly config: QqBotConfig;
    readonly rest: QqRestClient;
    readonly gateway: QqGatewayClient;
    readonly logger: Logger;
    readonly now?: () => number;
    readonly limiter?: SendLimiter;
}

function readBodyText(body: Record<string, unknown>): string | undefined {
    const markdown = body.markdown;
    if (typeof markdown === "object" && markdown !== null) {
        const content = (markdown as { content?: unknown }).content;
        if (typeof content === "string") return content;
    }
    return typeof body.content === "string" ? body.content : undefined;
}

function hasMarkdown(body: Record<string, unknown>): boolean {
    return typeof body.markdown === "object" && body.markdown !== null;
}

function buildBody(
    config: QqBotConfig,
    text: string,
    reply: ReplyContext | undefined
): Record<string, unknown> {
    if (text.trim() === "") {
        throw new NonRetryableDeliveryError(
            "empty-text",
            "refusing to send an empty QQ message"
        );
    }
    const body: Record<string, unknown> =
        config.markdown === "none"
            ? { msg_type: 0, content: text }
            : { msg_type: 2, markdown: { content: text } };
    if (reply !== undefined) {
        body.msg_id = reply.messageId;
        body.msg_seq = reply.seq;
    }
    return body;
}

function toTextBody(body: Record<string, unknown>): Record<string, unknown> {
    const text = readBodyText(body) ?? "";
    const next: Record<string, unknown> = { msg_type: 0, content: text };
    if (typeof body.msg_id === "string") next.msg_id = body.msg_id;
    if (typeof body.msg_seq === "number") next.msg_seq = body.msg_seq;
    return next;
}

function truncateBody(body: Record<string, unknown>): Record<string, unknown> {
    const text = readBodyText(body) ?? "";
    if (text.length <= 2) return body;
    const cut = Math.max(1, Math.floor(text.length * 0.9));
    const next = `${text.slice(0, cut)}…`;
    if (hasMarkdown(body)) {
        return {
            ...body,
            markdown: { content: next },
        };
    }
    return { ...body, content: next };
}

/**
 * QQ official-bot channel driver.
 *
 * Passive replies are preferred. When the inbound window or reply slots are
 * exhausted, the driver attempts an active message only when the configured
 * fallback allows it; otherwise channel core defers the notice/reply.
 */
export class QqBotDriver implements ChannelDriver {
    readonly id = "qq-bot";
    private readonly config: QqBotConfig;
    private readonly rest: QqRestClient;
    private readonly gateway: QqGatewayClient;
    private readonly logger: Logger;
    private readonly now: () => number;
    private readonly limiter: SendLimiter;
    private readonly windowMarginMs: number;
    private readonly activeDisableMs: number;
    private stopped = false;
    private started = false;
    private activeDisabledUntil = 0;
    private activeDay = "";
    private activeSentToday = 0;

    constructor(options: QqBotDriverOptions) {
        this.config = options.config;
        this.rest = options.rest;
        this.gateway = options.gateway;
        this.logger = options.logger;
        this.now = options.now ?? Date.now;
        this.limiter = options.limiter ?? new SendLimiter({ now: this.now });
        this.windowMarginMs = resolveReplyWindowMarginMs(options.config);
        this.activeDisableMs = resolveActiveMessageDisableMs(options.config);
    }

    get capabilities(): ChannelCapabilities {
        return {
            markdown: this.config.markdown,
            maxTextLength: this.config.maxTextLength,
            inboundImages: false,
            outboundFiles: false,
            outboundActions: false,
            inboundActions: false,
            activeMessages: this.activeAvailable(),
            maxRepliesPerReply: this.config.maxRepliesPerReply,
        };
    }

    async start(handler: {
        onInbound(message: InboundMessage): void;
    }): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        await this.gateway.start((message) => {
            const normalized = normalizeInbound(message);
            if (normalized === null) {
                this.logger.debug("ignored qq bot inbound", {
                    event: message.rawEventType,
                });
                return;
            }
            handler.onInbound(normalized);
        });
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.limiter.close();
        await this.gateway.stop();
    }

    async send(chatId: string, content: OutboundContent): Promise<SentRef> {
        if (this.stopped) throw new Error("qq-bot driver is stopped");
        const chat = parseChatId(chatId);
        if (chat === null) {
            throw new NonRetryableDeliveryError(
                "invalid-chat-id",
                `invalid qq chat id ${JSON.stringify(chatId)}`
            );
        }
        await this.limiter.acquire(chat.scope, chatId);
        const reply = content.reply;
        if (reply !== undefined) {
            if (!this.passiveValid(chat.scope, reply)) {
                throw new PassiveReplyExpiredError();
            }
            return await this.sendBody(
                chatId,
                chat,
                buildBody(this.config, content.text, reply),
                true
            );
        }
        if (!this.activeAvailable()) {
            throw new NonRetryableDeliveryError(
                "active-unavailable",
                "QQ active messages are unavailable"
            );
        }
        return await this.sendBody(
            chatId,
            chat,
            buildBody(this.config, content.text, undefined),
            false
        );
    }

    canDeliver(
        chatId: string,
        content: Pick<OutboundContent, "kind" | "reply">
    ): boolean {
        const chat = parseChatId(chatId);
        if (chat === null) return false;
        if (content.reply !== undefined) {
            return this.passiveValid(chat.scope, content.reply);
        }
        return this.activeAvailable();
    }

    health(): ChannelHealth {
        const health = this.gateway.health();
        const details: string[] = [];
        if (health.detail !== undefined) details.push(health.detail);
        if (!this.activeAvailable()) {
            details.push("active-messages-unavailable");
        }
        return {
            state: health.state,
            ...(details.length === 0 ? {} : { detail: details.join("; ") }),
        };
    }

    private async sendBody(
        chatId: string,
        chat: ParsedQqChat,
        initial: Record<string, unknown>,
        passive: boolean
    ): Promise<SentRef> {
        let body = initial;
        let lengthRetried = false;
        let markdownRetried = false;
        for (;;) {
            try {
                const response = await this.rest.send(
                    chat.scope,
                    chat.targetId,
                    body
                );
                if (!passive) this.noteActiveSent();
                return {
                    channelId: this.id,
                    chatId,
                    messageId: response.id,
                };
            } catch (error) {
                const kind = classifySendError(error);
                if (kind === "duplicate") {
                    return {
                        channelId: this.id,
                        chatId,
                        messageId: String(body.msg_id ?? "duplicate"),
                    };
                }
                if (kind === "passive-expired") {
                    throw new PassiveReplyExpiredError();
                }
                if (kind === "active-unavailable") {
                    this.markActiveUnavailable(error);
                    throw new NonRetryableDeliveryError(
                        "active-unavailable",
                        "QQ active messages are unavailable"
                    );
                }
                if (
                    kind === "markdown-unavailable" &&
                    !markdownRetried &&
                    hasMarkdown(body)
                ) {
                    markdownRetried = true;
                    body = toTextBody(body);
                    this.logger.warn(
                        "qq bot markdown rejected; retrying as text",
                        safeErrorFields(error)
                    );
                    continue;
                }
                if (kind === "length" && !lengthRetried) {
                    lengthRetried = true;
                    body = truncateBody(body);
                    this.logger.warn(
                        "qq bot message too long; retrying truncated",
                        safeErrorFields(error)
                    );
                    continue;
                }
                throw toDeliveryError(kind, error);
            }
        }
    }

    private passiveValid(scope: ChatScope, reply: ReplyContext): boolean {
        if (!Number.isInteger(reply.seq) || reply.seq < 1) return false;
        if (reply.seq > this.config.maxRepliesPerReply) return false;
        const windowMs = this.passiveWindowMs(scope);
        return this.now() - reply.receivedAt <= windowMs;
    }

    private passiveWindowMs(scope: ChatScope): number {
        const seconds =
            scope === "c2c"
                ? this.config.c2cReplyWindowSeconds
                : this.config.groupReplyWindowSeconds;
        return Math.max(0, seconds * 1000 - this.windowMarginMs);
    }

    private activeAvailable(): boolean {
        if (this.config.activeMessageFallback !== "auto") return false;
        return this.now() >= this.activeDisabledUntil;
    }

    private markActiveUnavailable(error: unknown): void {
        this.activeDisabledUntil = this.now() + this.activeDisableMs;
        this.logger.warn("qq bot active messages marked unavailable", {
            ...safeErrorFields(error),
            retryAfterMs: this.activeDisableMs,
        });
    }

    private noteActiveSent(): void {
        const day = new Date(this.now()).toISOString().slice(0, 10);
        if (day !== this.activeDay) {
            this.activeDay = day;
            this.activeSentToday = 0;
        }
        this.activeSentToday += 1;
        if (this.activeSentToday === 1000) {
            this.logger.warn("qq bot reached the daily active-message quota", {
                count: this.activeSentToday,
            });
        }
    }
}
