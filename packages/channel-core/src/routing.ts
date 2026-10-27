import type { OutboxKind } from "@nokoribi/shared";

import type { ReplyContext } from "./contract.js";

/** One channel/chat target. */
export interface ChatRef {
    readonly channelId: string;
    readonly chatId: string;
}

/** Driver fields used by pure routing decisions. */
export interface RoutingDriverView {
    readonly id: string;
    readonly defaultChatId?: string;
    readonly capabilities: {
        readonly activeMessages?: boolean;
    };
    canDeliver?(
        chatId: string,
        content: {
            readonly kind: OutboxKind;
            readonly reply?: ReplyContext;
        }
    ): boolean;
}

/** Result of choosing where a notice should go. */
export type NoticeRoute =
    | { readonly action: "send"; readonly chat: ChatRef }
    | { readonly action: "defer"; readonly chat: ChatRef }
    | { readonly action: "drop"; readonly reason: string };

/** Stable in-memory key for one channel/chat pair. */
export function chatKey(chat: ChatRef): string {
    return `${chat.channelId}\u0000${chat.chatId}`;
}

/** Whether a driver can deliver a notice without a passive context. */
export function isNoticeDeliverable(
    driver: RoutingDriverView,
    chatId: string
): boolean {
    try {
        if (driver.canDeliver !== undefined) {
            return driver.canDeliver(chatId, { kind: "notice" });
        }
        return driver.capabilities.activeMessages !== false;
    } catch {
        return false;
    }
}

/**
 * Choose the target for one system notice.
 *
 * Precedence follows D159 then D161: the source chat, then another
 * active-capable driver with an explicit default chat, then defer for the
 * source chat, then drop. A driver without `defaultChatId` is never used as a
 * fallback because the core cannot address it without an inbound context.
 */
export function pickNoticeRoute(input: {
    readonly source: ChatRef | null;
    readonly drivers: readonly RoutingDriverView[];
}): NoticeRoute {
    const source = input.source;
    const sourceDriver =
        source === null
            ? undefined
            : input.drivers.find((driver) => driver.id === source.channelId);
    if (
        source !== null &&
        sourceDriver !== undefined &&
        isNoticeDeliverable(sourceDriver, source.chatId)
    ) {
        return { action: "send", chat: source };
    }
    for (const driver of input.drivers) {
        if (source !== null && driver.id === source.channelId) continue;
        const chatId = driver.defaultChatId;
        if (chatId === undefined) continue;
        if (!isNoticeDeliverable(driver, chatId)) continue;
        return {
            action: "send",
            chat: { channelId: driver.id, chatId },
        };
    }
    if (source !== null && sourceDriver !== undefined) {
        return { action: "defer", chat: source };
    }
    return {
        action: "drop",
        reason: source === null ? "no-chat" : "driver-unavailable",
    };
}

/** Pick the chat a reply/notice belongs to, in priority order. */
export function resolveReplyTarget(
    turnChat: ChatRef | null,
    lastActiveChat: ChatRef | null,
    defaultTarget: ChatRef | null
): ChatRef | null {
    return turnChat ?? lastActiveChat ?? defaultTarget;
}

/**
 * Passive reply slots left for one inbound message.
 *
 * `nextSeq` is the next 1-based slot. Absent or non-positive limit means no
 * cap (`Infinity`); a fully consumed context returns 0.
 */
export function remainingReplySlots(
    maxReplies: number | undefined,
    nextSeq: number
): number {
    if (maxReplies === undefined || maxReplies <= 0) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, maxReplies - (nextSeq - 1));
}
