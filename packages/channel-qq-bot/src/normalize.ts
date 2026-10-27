import type { InboundMessage } from "@nokoribi/channel-core";
import type { InboundMessage as SdkInboundMessage } from "@tencent-connect/qqbot-nodejs/protocol";

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

/**
 * Map one SDK-normalized QQ event to channel core's inbound shape.
 *
 * Only C2C messages and group @ mentions are accepted. Group full-message
 * events, bot self-messages, attachment-only messages, interaction events and
 * every other event type are ignored.
 */
export function normalizeInbound(
    message: SdkInboundMessage
): InboundMessage | null {
    if (!ACCEPTED_EVENTS.has(message.rawEventType)) return null;
    if (message.senderIsBot === true) return null;
    if (message.messageId.trim() === "") return null;

    const text = normalizeText(message.content ?? "");
    if (text === "") return null;

    if (message.kind === "c2c") {
        const userId = message.senderId.trim();
        if (userId === "") return null;
        return {
            channelId: "qq-bot",
            chatId: `c2c:${userId}`,
            senderId: userId,
            messageId: message.messageId,
            text,
            receivedAt: parseTimestamp(message.timestamp),
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
            text,
            receivedAt: parseTimestamp(message.timestamp),
            ...(message.refMsgIdx === undefined
                ? {}
                : { replyTo: message.refMsgIdx }),
        };
    }

    return null;
}
