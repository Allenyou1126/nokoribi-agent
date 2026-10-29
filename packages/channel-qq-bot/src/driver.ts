import type {
    ChannelCapabilities,
    ChannelDriver,
    ChannelHealth,
    FileAttachmentRef,
    InboundMessage,
    OutboundContent,
    ReplyContext,
    SentRef,
} from "@nokoribi/channel-core";
import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
} from "@nokoribi/channel-core";
import type { Logger, OutboundAction } from "@nokoribi/shared";
import type {
    ChatScope,
    InboundMessage as SdkInboundMessage,
    InlineKeyboard,
    InteractionEvent,
    KeyboardButton,
} from "@tencent-connect/qqbot-nodejs/protocol";

import {
    resolveActiveMessageDisableMs,
    resolveInboundImageMaxBytes,
    resolveInboundImages,
    resolveInboundImageTimeoutMs,
    resolveInteractionButtons,
    resolveQuestionButtons,
    resolveReplyWindowMarginMs,
    type QqBotConfig,
} from "./config.js";
import {
    classifySendError,
    safeErrorFields,
    toDeliveryError,
} from "./errors.js";
import { SendLimiter } from "./limiter.js";
import {
    interactionAckCode,
    normalizeInbound,
    normalizeInteraction,
    type InboundImageSource,
} from "./normalize.js";
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
    /** Read one stored outbound file's bytes from the attachment service. */
    readonly readFile?: (file: FileAttachmentRef) => AsyncIterable<Uint8Array>;
}

const SUPPORTED_IMAGE_MIME: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
]);

/** Map one declared/returned content type onto the attachment vocabulary. */
function normalizeImageMime(mime: string | undefined): string | undefined {
    const base = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (base === "image/jpg") return "image/jpeg";
    return SUPPORTED_IMAGE_MIME.has(base) ? base : undefined;
}

/** QQ rich-media file type code for one stored file name. */
export function mediaFileTypeFor(name: string): 1 | 2 | 3 | 4 {
    const ext = name.includes(".")
        ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
        : "";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return 1;
    if (["mp4", "mov", "m4v", "avi", "mkv"].includes(ext)) return 2;
    if (["silk", "amr", "wav", "mp3", "ogg"].includes(ext)) return 3;
    return 4;
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

const MAX_KEYBOARD_LABEL = 10;
const MAX_KEYBOARD_BUTTONS = 2;

function keyboardLabel(label: string, logger: Logger): string {
    const chars = Array.from(label);
    if (chars.length <= MAX_KEYBOARD_LABEL) return label;
    logger.warn("qq bot keyboard label truncated", {
        labelLength: chars.length,
    });
    return chars.slice(0, MAX_KEYBOARD_LABEL).join("");
}

function keyboardStyle(style: OutboundAction["style"]): number {
    if (style === "primary") return 4;
    if (style === "danger") return 3;
    return 0;
}

/**
 * Map channel-core actions onto one QQ inline keyboard row.
 *
 * Only callback actions with a payload are renderable. M9 produces exactly two
 * buttons; extra actions are ignored so an unsupported row can never fail the
 * whole approval message.
 */
function buildKeyboard(
    actions: readonly OutboundAction[] | undefined,
    logger: Logger
): InlineKeyboard | undefined {
    if (actions === undefined || actions.length === 0) return undefined;
    const buttons: KeyboardButton[] = [];
    for (const action of actions) {
        if (buttons.length >= MAX_KEYBOARD_BUTTONS) {
            logger.warn("qq bot keyboard button limit reached", {
                count: actions.length,
            });
            break;
        }
        if (action.kind !== "callback") {
            logger.debug("qq bot skipped non-callback action", {
                kind: action.kind,
            });
            continue;
        }
        if (action.disabled === true) {
            logger.debug("qq bot skipped disabled action", { id: action.id });
            continue;
        }
        if (action.payload === undefined || action.payload === "") {
            logger.warn("qq bot skipped callback action without payload", {
                id: action.id,
            });
            continue;
        }
        const label = keyboardLabel(action.label, logger);
        if (label.trim() === "") {
            logger.warn("qq bot skipped callback action with empty label", {
                id: action.id,
            });
            continue;
        }
        buttons.push({
            id: action.id,
            render_data: {
                label,
                visited_label: label,
                style: keyboardStyle(action.style),
            },
            action: {
                type: 1,
                permission: { type: 2 },
                data: action.payload,
            },
        });
    }
    if (buttons.length === 0) return undefined;
    return { content: { rows: [{ buttons }] } };
}

function buildBody(
    config: QqBotConfig,
    text: string,
    reply: ReplyContext | undefined,
    keyboard: InlineKeyboard | undefined
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
    if (keyboard !== undefined) body.keyboard = keyboard;
    return body;
}

function toTextBody(body: Record<string, unknown>): Record<string, unknown> {
    const text = readBodyText(body) ?? "";
    const next: Record<string, unknown> = { msg_type: 0, content: text };
    if (typeof body.msg_id === "string") next.msg_id = body.msg_id;
    if (typeof body.msg_seq === "number") next.msg_seq = body.msg_seq;
    if (body.keyboard !== undefined) next.keyboard = body.keyboard;
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
    private readonly readFile:
        | ((file: FileAttachmentRef) => AsyncIterable<Uint8Array>)
        | undefined;
    private readonly windowMarginMs: number;
    private readonly activeDisableMs: number;
    private readonly inboundImages: boolean;
    private readonly inboundImageMaxBytes: number;
    private readonly inboundImageTimeoutMs: number;
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
        this.inboundImages = resolveInboundImages(options.config);
        this.inboundImageMaxBytes = resolveInboundImageMaxBytes(options.config);
        this.inboundImageTimeoutMs = resolveInboundImageTimeoutMs(
            options.config
        );
        this.readFile = options.readFile;
    }

    get capabilities(): ChannelCapabilities {
        const interactions =
            resolveInteractionButtons(this.config) &&
            this.gateway.interactionAvailable();
        return {
            markdown: this.config.markdown,
            maxTextLength: this.config.maxTextLength,
            inboundImages: this.inboundImages,
            outboundFiles: true,
            outboundActions: interactions,
            inboundActions: interactions,
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
        await this.gateway.start({
            onInbound: (message) => this.acceptInbound(message, handler),
            onInteraction: (event) => this.handleInteraction(event, handler),
        });
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.limiter.close();
        await this.gateway.stop();
    }

    /** Normalize one SDK event and download its images before delivery. */
    private acceptInbound(
        message: SdkInboundMessage,
        handler: { onInbound(message: InboundMessage): void }
    ): void {
        const normalized = normalizeInbound(message);
        if (normalized === null) {
            this.logger.debug("ignored qq bot inbound", {
                event: message.rawEventType,
            });
            return;
        }
        const { imageSources, ...base } = normalized;
        if (
            !this.inboundImages ||
            imageSources === undefined ||
            imageSources.length === 0
        ) {
            this.deliverTextOnly(imageSources);
            if (base.text !== undefined) handler.onInbound(base);
            return;
        }
        void this.deliverWithImages(base, imageSources)
            .then((delivered) => {
                if (delivered !== undefined) handler.onInbound(delivered);
            })
            .catch((error: unknown) => {
                this.logger.warn(
                    "qq bot inbound image handling failed",
                    safeErrorFields(error)
                );
                if (base.text !== undefined) handler.onInbound(base);
            });
    }

    /** Log and drop image sources when the driver cannot forward them. */
    private deliverTextOnly(
        imageSources: readonly InboundImageSource[] | undefined
    ): void {
        if (imageSources === undefined || imageSources.length === 0) return;
        this.logger.debug("qq bot ignored inbound images", {
            count: imageSources.length,
            enabled: this.inboundImages,
        });
    }

    /**
     * Download every image source and build the final inbound message.
     * @returns the message to deliver, or undefined when nothing is left.
     */
    private async deliverWithImages(
        base: InboundMessage,
        sources: readonly InboundImageSource[]
    ): Promise<InboundMessage | undefined> {
        const images: { mime: string; data: Uint8Array }[] = [];
        let failures = 0;
        for (const source of sources) {
            try {
                const image = await this.downloadImage(source);
                if (image !== undefined) images.push(image);
            } catch (error) {
                failures += 1;
                this.logger.warn(
                    "qq bot inbound image download failed",
                    safeErrorFields(error)
                );
            }
        }
        const note = "[图片下载失败，已忽略]";
        if (failures > 0) {
            const text =
                base.text === undefined || base.text === ""
                    ? note
                    : `${base.text}\n${note}`;
            return {
                ...base,
                text,
                ...(images.length === 0 ? {} : { images }),
            };
        }
        if (images.length === 0) {
            this.logger.debug("qq bot ignored unsupported inbound images");
            return base.text === undefined ? undefined : base;
        }
        return { ...base, images };
    }

    /** Fetch one inbound image with bounded timeout/bytes and mime filter. */
    private async downloadImage(
        source: InboundImageSource
    ): Promise<{ mime: string; data: Uint8Array } | undefined> {
        const download = this.rest.downloadImage;
        if (download === undefined) {
            throw new Error("QQ REST client cannot download images");
        }
        const result = await download.call(this.rest, source.url, {
            maxBytes: this.inboundImageMaxBytes,
            timeoutMs: this.inboundImageTimeoutMs,
        });
        const mime =
            normalizeImageMime(result.mime) ?? normalizeImageMime(source.mime);
        if (mime === undefined) {
            this.logger.debug("qq bot ignored unsupported image mime", {
                declared: source.mime,
            });
            return undefined;
        }
        return { mime, data: result.data };
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
        const files = content.files ?? [];
        if (files.length > 0) {
            return await this.sendFiles(chatId, chat, content, files);
        }
        return await this.sendText(chatId, chat, content);
    }

    /** Send one text-only message (with an optional keyboard). */
    private async sendText(
        chatId: string,
        chat: ParsedQqChat,
        content: OutboundContent
    ): Promise<SentRef> {
        const keyboard =
            chat.scope === "c2c" && this.keyboardEnabled(content.actionKind)
                ? buildKeyboard(content.actions, this.logger)
                : undefined;
        if (
            chat.scope !== "c2c" &&
            content.actions !== undefined &&
            content.actions.length > 0
        ) {
            this.logger.debug("qq bot drops group keyboard actions", {
                count: content.actions.length,
            });
        }
        const reply = content.reply;
        if (reply !== undefined) {
            if (!this.passiveValid(chat.scope, reply)) {
                throw new PassiveReplyExpiredError();
            }
            return await this.sendBody(
                chatId,
                chat,
                buildBody(this.config, content.text, reply, keyboard),
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
            buildBody(this.config, content.text, undefined, keyboard),
            false
        );
    }

    /** Whether the configured button surface covers one interaction kind. */
    private keyboardEnabled(
        actionKind: "approval" | "question" | undefined
    ): boolean {
        if (actionKind === "question") {
            return resolveQuestionButtons(this.config);
        }
        return this.config.approvalButtons;
    }

    /**
     * Send text (when present) followed by one `msg_type=7` message per file.
     *
     * Rich media is implemented for C2C only. Group chats keep the text path
     * and drop files because group rich-media delivery is not verified yet
     * (documented limitation in .spec/23); a file-only group entry fails as
     * non-retryable instead of looping.
     */
    private async sendFiles(
        chatId: string,
        chat: ParsedQqChat,
        content: OutboundContent,
        files: readonly FileAttachmentRef[]
    ): Promise<SentRef> {
        if (chat.scope !== "c2c") {
            if (content.text.trim() === "") {
                throw new NonRetryableDeliveryError(
                    "group-rich-media-unsupported",
                    "QQ group chats do not support rich-media files yet"
                );
            }
            this.logger.warn("qq bot dropped group files; c2c only", {
                count: files.length,
            });
            return await this.sendText(chatId, chat, content);
        }
        let sent: SentRef | undefined;
        if (content.text.trim() !== "") {
            sent = await this.sendText(chatId, chat, content);
        }
        let index = 0;
        for (const file of files) {
            sent = await this.sendFile(
                chat,
                file,
                content,
                index === 0 ? content.reply : undefined,
                files.length
            );
            index += 1;
        }
        if (sent === undefined) {
            throw new NonRetryableDeliveryError(
                "empty-content",
                "refusing to send an empty QQ message"
            );
        }
        return sent;
    }

    /** Upload and send one stored file as a C2C rich-media message. */
    private async sendFile(
        chat: ParsedQqChat,
        file: FileAttachmentRef,
        content: OutboundContent,
        reply: ReplyContext | undefined,
        count: number
    ): Promise<SentRef> {
        const upload = this.rest.uploadMedia;
        if (upload === undefined) {
            throw new NonRetryableDeliveryError(
                "rich-media-unsupported",
                "QQ REST client cannot upload rich media"
            );
        }
        if (this.readFile === undefined) {
            throw new NonRetryableDeliveryError(
                "attachments-unavailable",
                "attachment service is not available for outbound files"
            );
        }
        if (reply !== undefined && !this.passiveValid(chat.scope, reply)) {
            throw new PassiveReplyExpiredError();
        }
        if (reply === undefined && !this.activeAvailable()) {
            throw new NonRetryableDeliveryError(
                "active-unavailable",
                "QQ active messages are unavailable"
            );
        }
        const data = await this.readFileBytes(file);
        const fileType = mediaFileTypeFor(file.name);
        try {
            const uploaded = await upload.call(
                this.rest,
                chat.scope,
                chat.targetId,
                {
                    file_type: fileType,
                    srv_send_msg: false,
                    file_data: Buffer.from(data).toString("base64"),
                    ...(fileType === 4 ? { file_name: file.name } : {}),
                }
            );
            const body: Record<string, unknown> = {
                msg_type: 7,
                media: { file_info: uploaded.file_info },
                ...(reply === undefined
                    ? {}
                    : { msg_id: reply.messageId, msg_seq: reply.seq }),
            };
            const response = await this.rest.send(
                chat.scope,
                chat.targetId,
                body
            );
            this.logger.info("qq bot sent rich-media file", {
                count,
                bytes: file.bytes,
                fileType,
            });
            return {
                channelId: this.id,
                chatId: `c2c:${chat.targetId}`,
                messageId: response.id,
            };
        } catch (error) {
            const kind = classifySendError(error);
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
            throw toDeliveryError(kind, error);
        }
    }

    /** Collect one stored file's bytes with a defensive size check. */
    private async readFileBytes(file: FileAttachmentRef): Promise<Uint8Array> {
        const readFile = this.readFile;
        if (readFile === undefined) {
            throw new NonRetryableDeliveryError(
                "attachments-unavailable",
                "attachment service is not available for outbound files"
            );
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of readFile(file)) {
            total += chunk.length;
            chunks.push(chunk);
        }
        if (total !== file.bytes) {
            throw new Error(
                `attachment byte mismatch for ${file.attachmentId}`
            );
        }
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return data;
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

    private async handleInteraction(
        event: InteractionEvent,
        handler: { onInbound(message: InboundMessage): void }
    ): Promise<void> {
        if (this.stopped) return;
        if (event.id.trim() === "") return;
        const code: 0 | 1 = resolveInteractionButtons(this.config)
            ? interactionAckCode(event)
            : 1;
        try {
            await this.rest.ackInteraction(event.id, code);
        } catch (error) {
            this.logger.warn(
                "qq bot interaction acknowledgement failed",
                safeErrorFields(error)
            );
        }
        if (code !== 0) {
            this.logger.debug("ignored qq bot interaction", {
                eventType: event.type,
                chatType: event.chat_type,
            });
            return;
        }
        const normalized = normalizeInteraction(event);
        if (normalized === null) return;
        handler.onInbound(normalized);
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
