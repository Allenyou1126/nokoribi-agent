import type { ZodType } from "zod";
import { z } from "zod";

/** What one outbox entry represents. */
export type OutboxKind = "reply" | "notice" | "interaction";

/** Delivery lifecycle of one outbox entry. */
export type OutboxEntryState = "pending" | "sent" | "failed";

/** Render intent of one outbound action widget. */
export type OutboundActionKind = "callback" | "link" | "command";

/**
 * One platform-agnostic action attached to an outbound message.
 *
 * Drivers map these fields onto their platform widgets; platform-specific
 * fields survive schema validation through `.passthrough()` and can be added
 * without migrating the outbox document.
 */
export interface OutboundAction {
    readonly id: string;
    readonly label: string;
    readonly kind: OutboundActionKind;
    readonly payload?: string;
    readonly url?: string;
    readonly style?: "default" | "primary" | "danger";
    readonly disabled?: boolean;
}

/** One notice held until its chat can accept a passive reply. */
export interface DeferredNotice {
    readonly id: string;
    readonly channelId: string;
    readonly chatId: string;
    /** Raw text without the leading warning marker. */
    readonly text: string;
    readonly createdAt: string;
}

/** One durable outbound message. */
export interface OutboxItem {
    readonly seq: number;
    readonly channelId: string;
    readonly chatId: string;
    readonly kind: OutboxKind;
    readonly text: string;
    /** Platform message id this outbound message passively replies to. */
    readonly replyTo?: string | null;
    /** Platform message time used for passive-window checks. */
    readonly replyReceivedAt?: number | null;
    /** 1-based reply slot for `replyTo` (QQ `msg_seq`). */
    readonly replySeq?: number | null;
    /** Optional platform actions rendered with the message. */
    readonly actions?: readonly OutboundAction[] | null;
    readonly interactionId: string | null;
    readonly state: OutboxEntryState;
    readonly attempts: number;
    readonly nextAttemptAt: string | null;
    readonly createdAt: string;
    readonly sentAt: string | null;
}

/** Complete outbox document stored at `$DSH_HOME/state/outbox.json`. */
export interface OutboxDocument {
    readonly version: 1;
    readonly nextSeq: number;
    readonly items: readonly OutboxItem[];
    /** Notices waiting for their chat's next inbound message. */
    readonly deferredNotices: readonly DeferredNotice[];
}

const outboundActionSchema = z
    .object({
        id: z.string().min(1),
        label: z.string().min(1),
        kind: z.enum(["callback", "link", "command"]),
        payload: z.string().optional(),
        url: z.string().optional(),
        style: z.enum(["default", "primary", "danger"]).optional(),
        disabled: z.boolean().optional(),
    })
    .passthrough();

const deferredNoticeSchema = z
    .object({
        id: z.string().min(1),
        channelId: z.string().min(1),
        chatId: z.string().min(1),
        text: z.string(),
        createdAt: z.string(),
    })
    .passthrough();

const outboxItemSchema = z
    .object({
        seq: z.number().int().nonnegative(),
        channelId: z.string().min(1),
        chatId: z.string().min(1),
        kind: z.enum(["reply", "notice", "interaction"]),
        text: z.string(),
        replyTo: z.string().min(1).optional().nullable(),
        replyReceivedAt: z.number().nonnegative().optional().nullable(),
        replySeq: z.number().int().positive().optional().nullable(),
        actions: z.array(outboundActionSchema).max(32).optional().nullable(),
        interactionId: z.string().min(1).nullable(),
        state: z.enum(["pending", "sent", "failed"]),
        attempts: z.number().int().nonnegative(),
        nextAttemptAt: z.string().nullable(),
        createdAt: z.string(),
        sentAt: z.string().nullable(),
    })
    .passthrough();

const outboxDocumentSchema: ZodType<OutboxDocument> = z
    .object({
        version: z.literal(1),
        nextSeq: z.number().int().nonnegative(),
        items: z.array(outboxItemSchema),
        deferredNotices: z.array(deferredNoticeSchema).optional().default([]),
    })
    .passthrough() as unknown as ZodType<OutboxDocument>;

/** Empty outbox for a fresh home. */
export function emptyOutbox(): OutboxDocument {
    return { version: 1, nextSeq: 1, items: [], deferredNotices: [] };
}

/** Validate one outbox document; throws on malformed content. */
export function parseOutbox(value: unknown): OutboxDocument {
    return outboxDocumentSchema.parse(value);
}

/** One processed inbound message identity. */
export interface SeenEntry {
    readonly key: string;
    readonly at: string;
}

/** Durable dedupe document stored at `$DSH_HOME/state/ingress-seen.json`. */
export interface SeenDocument {
    readonly version: 1;
    readonly seen: readonly SeenEntry[];
}

const seenSchema: ZodType<SeenDocument> = z
    .object({
        version: z.literal(1),
        seen: z.array(
            z
                .object({
                    key: z.string().min(1),
                    at: z.string(),
                })
                .passthrough()
        ),
    })
    .passthrough() as unknown as ZodType<SeenDocument>;

/** Empty dedupe document. */
export function emptySeen(): SeenDocument {
    return { version: 1, seen: [] };
}

/** Validate one dedupe document; throws on malformed content. */
export function parseSeen(value: unknown): SeenDocument {
    return seenSchema.parse(value);
}
