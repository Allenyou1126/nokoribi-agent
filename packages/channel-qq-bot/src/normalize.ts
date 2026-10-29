import type { InboundMessage } from "@nokoribi/channel-core";
import type {
    InboundMessage as SdkInboundMessage,
    InteractionEvent,
} from "@tencent-connect/qqbot-nodejs/protocol";

const ACCEPTED_EVENTS: ReadonlySet<string> = new Set([
    "C2C_MESSAGE_CREATE",
    "GROUP_AT_MESSAGE_CREATE",
]);

/** Parse a platform RFC3339 timestamp; invalid values fall back to now. */
export function parseTimestamp(value: string | undefined): number {
    if (value === undefined || value === "") return Date.now();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

/** Trim text and remove a leading mention left by the platform. */
export function normalizeText(value: string): string {
    return value.replace(/^\s*<@!?[^>]+>\s*/, "").trim();
}

/** One inbound image URL the driver downloads before delivery. */
export interface InboundImageSource {
    readonly mime: string;
    readonly url: string;
}

/** Normalized inbound message plus image URLs not yet downloaded. */
export interface NormalizedInboundMessage extends InboundMessage {
    readonly imageSources?: readonly InboundImageSource[];
}

/** Collect image attachments as download sources (other media is ignored). */
function imageSourcesOf(
    message: SdkInboundMessage
): readonly InboundImageSource[] {
    const attachments = message.attachments ?? [];
    const sources: InboundImageSource[] = [];
    for (const attachment of attachments) {
        const mime = (attachment.content_type ?? "").trim().toLowerCase();
        const url = (attachment.url ?? "").trim();
        if (!mime.startsWith("image/") || url === "") continue;
        sources.push({ mime, url });
    }
    return sources;
}

/**
 * Map one SDK-normalized QQ event to channel core's inbound shape.
 *
 * Only C2C messages and group @ mentions are accepted. Group full-message
 * events, bot self-messages, interaction events and every other event type are
 * ignored. Messages carrying images are forwarded with `message.imageSources`
 * (the driver downloads them; core's `InboundMessage.images` holds bytes).
 */
export function normalizeInbound(
    message: SdkInboundMessage
): NormalizedInboundMessage | null {
    if (!ACCEPTED_EVENTS.has(message.rawEventType)) return null;
    if (message.senderIsBot === true) return null;
    if (message.messageId.trim() === "") return null;

    const text = normalizeText(message.content ?? "");
    const imageSources = imageSourcesOf(message);
    if (text === "" && imageSources.length === 0) return null;

    if (message.kind === "c2c") {
        const userId = message.senderId.trim();
        if (userId === "") return null;
        return {
            channelId: "qq-bot",
            chatId: `c2c:${userId}`,
            senderId: userId,
            messageId: message.messageId,
            ...(text === "" ? {} : { text }),
            receivedAt: parseTimestamp(message.timestamp),
            ...(imageSources.length === 0 ? {} : { imageSources }),
            ...(message.refMsgIdx === undefined
                ? {}
                : { replyTo: message.refMsgIdx }),
        };
    }

    if (message.kind === "group") {
        const groupId = message.groupOpenid?.trim() ?? "";
        const memberId = message.senderId.trim();
        if (groupId === "" || memberId === "") return null;
        return {
            channelId: "qq-bot",
            chatId: `group:${groupId}`,
            senderId: memberId,
            messageId: message.messageId,
            ...(text === "" ? {} : { text }),
            receivedAt: parseTimestamp(message.timestamp),
            ...(imageSources.length === 0 ? {} : { imageSources }),
            ...(message.refMsgIdx === undefined
                ? {}
                : { replyTo: message.refMsgIdx }),
        };
    }

    return null;
}

/** Decoded callback payload stored in a keyboard button's `action.data`. */
export interface InteractionButtonPayload {
    /** Opaque broker token. */
    readonly token: string;
    /** Text fallback shown for logs/compatibility; never authoritative. */
    readonly fallback: string;
}

/**
 * Parse one keyboard callback payload (`{"k":"...","t":"..."}`).
 *
 * The token is the only required field; a missing or non-string `t` becomes an
 * empty fallback. Any malformed payload is rejected so the driver can
 * acknowledge the click as failed without reaching channel core.
 */
export function parseInteractionButtonData(
    raw: string | undefined
): InteractionButtonPayload | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const token = record.k;
    if (typeof token !== "string" || token.trim() === "") return undefined;
    return {
        token,
        fallback: typeof record.t === "string" ? record.t : "",
    };
}

interface ParsedInteraction {
    readonly interactionId: string;
    readonly userId: string;
    readonly buttonData: string;
    readonly payload: InteractionButtonPayload;
}

function parseInteraction(
    event: InteractionEvent
): ParsedInteraction | undefined {
    if (event.type !== 11) return undefined;
    if (event.chat_type !== 2) return undefined;
    const interactionId = (event.id ?? "").trim();
    if (interactionId === "") return undefined;
    const userId = (event.user_openid ?? "").trim();
    if (userId === "") return undefined;
    const buttonData = event.data?.resolved?.button_data;
    const payload = parseInteractionButtonData(buttonData);
    if (payload === undefined || buttonData === undefined) return undefined;
    return { interactionId, userId, buttonData, payload };
}

/**
 * Ack code for one interaction event: 0 for a supported C2C message-button
 * callback, 1 for everything else.
 */
export function interactionAckCode(event: InteractionEvent): 0 | 1 {
    return parseInteraction(event) === undefined ? 1 : 0;
}

/**
 * Map one supported `INTERACTION_CREATE` event to channel core's inbound shape.
 *
 * Only C2C (`chat_type=2`) message-button callbacks (`type=11`) with a valid
 * token are accepted. The event id doubles as the dedupe key/message id; the
 * button payload becomes the authoritative `InboundAction`.
 */
export function normalizeInteraction(
    event: InteractionEvent
): InboundMessage | null {
    const parsed = parseInteraction(event);
    if (parsed === undefined) return null;
    return {
        channelId: "qq-bot",
        chatId: `c2c:${parsed.userId}`,
        senderId: parsed.userId,
        messageId: parsed.interactionId,
        text: parsed.payload.fallback,
        receivedAt: parseTimestamp(event.timestamp),
        action: {
            id: parsed.payload.token,
            payload: parsed.buttonData,
            messageId: parsed.interactionId,
        },
    };
}
