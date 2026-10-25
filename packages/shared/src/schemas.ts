import type { ZodType } from "zod";
import { z } from "zod";

/** What one outbox entry represents. */
export type OutboxKind = "reply" | "notice" | "interaction";

/** Delivery lifecycle of one outbox entry. */
export type OutboxEntryState = "pending" | "sent" | "failed";

/** One durable outbound message. */
export interface OutboxItem {
    readonly seq: number;
    readonly channelId: string;
    readonly chatId: string;
    readonly kind: OutboxKind;
    readonly text: string;
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
}

const outboxItemSchema = z
    .object({
        seq: z.number().int().nonnegative(),
        channelId: z.string().min(1),
        chatId: z.string().min(1),
        kind: z.enum(["reply", "notice", "interaction"]),
        text: z.string(),
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
    })
    .passthrough() as unknown as ZodType<OutboxDocument>;

/** Empty outbox for a fresh home. */
export function emptyOutbox(): OutboxDocument {
    return { version: 1, nextSeq: 1, items: [] };
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
