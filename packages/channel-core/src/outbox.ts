import { randomUUID } from "node:crypto";

import {
    emptyOutbox,
    parseOutbox,
    readJsonFile,
    writeJsonAtomic,
    type DeferredNotice,
    type OutboundAction,
    type OutboxDocument,
    type OutboxItem,
    type OutboxKind,
} from "@nokoribi/shared";

/** Passive reply target accepted by {@link OutboxStore.enqueueMany}. */
export interface EnqueueReplyInput {
    readonly messageId: string;
    readonly receivedAt: number;
}

/** Input accepted by {@link OutboxStore.enqueue}. */
export interface EnqueueInput {
    readonly channelId: string;
    readonly chatId: string;
    readonly kind: OutboxKind;
    readonly text: string;
    readonly interactionId?: string | null;
    readonly reply?: EnqueueReplyInput | null;
    readonly actions?: readonly OutboundAction[] | null;
}

/** Bounds applied when deferring one notice. */
export interface DeferredNoticeLimits {
    readonly perChat: number;
    readonly total: number;
    readonly ttlMs: number;
}

/** Result of deferring one notice. */
export interface DeferNoticeResult {
    readonly id: string;
    readonly dropped: number;
}

/** Input accepted by {@link OutboxStore.deferNotice}. */
export interface DeferredNoticeInput {
    readonly channelId: string;
    readonly chatId: string;
    readonly text: string;
    readonly createdAt?: string;
}

/** Durable outbox plus its in-memory history window. */
export class OutboxStore {
    private readonly path: string;
    private readonly historyLimit: number;
    private document: OutboxDocument = emptyOutbox();
    private loaded = false;
    private persistChain: Promise<void> = Promise.resolve();

    constructor(path: string, historyLimit: number) {
        this.path = path;
        this.historyLimit = historyLimit;
    }

    /** Load the durable outbox, validating its schema. */
    async load(): Promise<void> {
        if (this.loaded) return;
        const raw = await readJsonFile(this.path);
        if (raw === undefined) {
            this.document = emptyOutbox();
        } else {
            this.document = parseOutbox(raw);
            this.pruneTerminal();
        }
        this.loaded = true;
    }

    /** All retained entries in sequence order. */
    get items(): readonly OutboxItem[] {
        return this.document.items;
    }

    /** Next sequence number that would be allocated. */
    get nextSeq(): number {
        return this.document.nextSeq;
    }

    /** Number of entries still waiting for delivery. */
    get pendingCount(): number {
        return this.document.items.filter((item) => item.state === "pending")
            .length;
    }

    /** Pending entries in sequence order. */
    pending(): readonly OutboxItem[] {
        return this.document.items
            .filter((item) => item.state === "pending")
            .sort((left, right) => left.seq - right.seq);
    }

    /** Entries with a sequence greater than `after`. */
    historyAfter(after: number): readonly OutboxItem[] {
        return this.document.items
            .filter((item) => item.seq > after)
            .sort((left, right) => left.seq - right.seq);
    }

    /**
     * Next passive reply slot for one `(channel, chat, messageId)`.
     *
     * Derived from every retained item (including sent/failed history) so a
     * retry or restart keeps the same `(msg_id, msg_seq)` pair.
     */
    nextReplySeq(channelId: string, chatId: string, messageId: string): number {
        let max = 0;
        for (const item of this.document.items) {
            if (
                item.channelId !== channelId ||
                item.chatId !== chatId ||
                item.replyTo !== messageId
            ) {
                continue;
            }
            if (typeof item.replySeq === "number" && item.replySeq > max) {
                max = item.replySeq;
            }
        }
        return max + 1;
    }

    /** Append one pending entry and persist it before delivery starts. */
    async enqueue(input: EnqueueInput): Promise<OutboxItem> {
        const [item] = await this.enqueueMany([input]);
        if (item === undefined) {
            throw new Error("outbox enqueue produced no item");
        }
        return item;
    }

    /**
     * Append several pending entries with one durable write.
     *
     * Reply slots are allocated synchronously per `(channel, chat, message)`
     * so concurrent callers cannot allocate the same `replySeq`.
     */
    async enqueueMany(
        inputs: readonly EnqueueInput[]
    ): Promise<readonly OutboxItem[]> {
        await this.ensureLoaded();
        if (inputs.length === 0) return [];
        const replySeqs = new Map<string, number>();
        let nextSeq = this.document.nextSeq;
        const items: OutboxItem[] = [];
        for (const input of inputs) {
            const reply = input.reply ?? null;
            let replyTo: string | null = null;
            let replyReceivedAt: number | null = null;
            let replySeq: number | null = null;
            if (reply !== null) {
                const key = `${input.channelId}\u0000${input.chatId}\u0000${reply.messageId}`;
                let seq = replySeqs.get(key);
                if (seq === undefined) {
                    seq = this.nextReplySeq(
                        input.channelId,
                        input.chatId,
                        reply.messageId
                    );
                }
                replySeqs.set(key, seq + 1);
                replyTo = reply.messageId;
                replyReceivedAt = reply.receivedAt;
                replySeq = seq;
            }
            items.push({
                seq: nextSeq,
                channelId: input.channelId,
                chatId: input.chatId,
                kind: input.kind,
                text: input.text,
                replyTo,
                replyReceivedAt,
                replySeq,
                actions: input.actions ?? null,
                interactionId: input.interactionId ?? null,
                state: "pending",
                attempts: 0,
                nextAttemptAt: null,
                createdAt: new Date().toISOString(),
                sentAt: null,
            });
            nextSeq += 1;
        }
        this.document = {
            ...this.document,
            nextSeq,
            items: [...this.document.items, ...items],
        };
        this.pruneTerminal();
        await this.persist();
        return items;
    }

    /** Mark one entry delivered and persist the reservation commit. */
    async markSent(seq: number): Promise<void> {
        await this.update(seq, (item) => ({
            ...item,
            state: "sent",
            attempts: item.attempts + 1,
            nextAttemptAt: null,
            sentAt: new Date().toISOString(),
        }));
    }

    /** Record a failed delivery attempt, returning whether retries remain. */
    async markAttemptFailed(
        seq: number,
        nextAttemptAt: string | null,
        exhausted: boolean
    ): Promise<boolean> {
        let retry = true;
        await this.update(seq, (item) => {
            retry = !exhausted;
            return {
                ...item,
                state: exhausted ? "failed" : "pending",
                attempts: item.attempts + 1,
                nextAttemptAt,
                sentAt: null,
            };
        });
        return retry;
    }

    /** Drop the passive reply context so the next attempt is an active send. */
    async clearReply(seq: number): Promise<void> {
        await this.update(seq, (item) => ({
            ...item,
            replyTo: null,
            replyReceivedAt: null,
            replySeq: null,
        }));
    }

    /** Mark every still-pending interaction as failed; returns the count. */
    async failPendingInteractions(): Promise<number> {
        await this.ensureLoaded();
        const pending = this.document.items.filter(
            (item) => item.state === "pending" && item.kind === "interaction"
        );
        if (pending.length === 0) return 0;
        const failed = new Set(pending.map((item) => item.seq));
        this.document = {
            ...this.document,
            items: this.document.items.map((item) =>
                failed.has(item.seq)
                    ? { ...item, state: "failed", nextAttemptAt: null }
                    : item
            ),
        };
        this.pruneTerminal();
        await this.persist();
        return pending.length;
    }

    /** Mark one pending interaction prompt as failed; returns the count. */
    async failPendingInteraction(interactionId: string): Promise<number> {
        await this.ensureLoaded();
        const pending = this.document.items.filter(
            (item) =>
                item.state === "pending" &&
                item.kind === "interaction" &&
                item.interactionId === interactionId
        );
        if (pending.length === 0) return 0;
        const failed = new Set(pending.map((item) => item.seq));
        this.document = {
            ...this.document,
            items: this.document.items.map((item) =>
                failed.has(item.seq)
                    ? { ...item, state: "failed", nextAttemptAt: null }
                    : item
            ),
        };
        this.pruneTerminal();
        await this.persist();
        return pending.length;
    }

    /** Drop one pending entry that can no longer be delivered usefully. */
    async markDiscarded(seq: number): Promise<void> {
        await this.ensureLoaded();
        const item = this.document.items.find((entry) => entry.seq === seq);
        if (item === undefined || item.state !== "pending") return;
        this.document = {
            ...this.document,
            items: this.document.items.map((entry) =>
                entry.seq === seq
                    ? {
                          ...entry,
                          state: "failed",
                          nextAttemptAt: null,
                      }
                    : entry
            ),
        };
        this.pruneTerminal();
        await this.persist();
    }

    /**
     * Buffer one notice until its chat sends another inbound message.
     *
     * Expired notices and overflow are dropped oldest-first and counted in
     * the result so the caller can warn without logging message text.
     */
    async deferNotice(
        input: DeferredNoticeInput,
        limits: DeferredNoticeLimits,
        now: number = Date.now()
    ): Promise<DeferNoticeResult> {
        await this.ensureLoaded();
        const notice: DeferredNotice = {
            id: randomUUID(),
            channelId: input.channelId,
            chatId: input.chatId,
            text: input.text,
            createdAt: input.createdAt ?? new Date(now).toISOString(),
        };
        const list = [...this.document.deferredNotices];
        let dropped = this.pruneExpiredNotices(list, now, limits.ttlMs);
        list.push(notice);
        while (
            list.filter(
                (entry) =>
                    entry.channelId === notice.channelId &&
                    entry.chatId === notice.chatId
            ).length > limits.perChat
        ) {
            const index = list.findIndex(
                (entry) =>
                    entry.channelId === notice.channelId &&
                    entry.chatId === notice.chatId
            );
            if (index < 0) break;
            list.splice(index, 1);
            dropped += 1;
        }
        while (list.length > limits.total) {
            list.shift();
            dropped += 1;
        }
        this.document = { ...this.document, deferredNotices: list };
        await this.persist();
        return { id: notice.id, dropped };
    }

    /** Deferred notices for one chat, oldest first, skipping expired ones. */
    listDeferred(
        channelId: string,
        chatId: string,
        limit: number,
        now: number,
        ttlMs: number
    ): readonly DeferredNotice[] {
        if (limit <= 0) return [];
        return this.document.deferredNotices
            .filter(
                (notice) =>
                    notice.channelId === channelId &&
                    notice.chatId === chatId &&
                    !this.noticeExpired(notice, now, ttlMs)
            )
            .slice(0, limit);
    }

    /** Number of non-expired deferred notices. */
    deferredCount(now: number, ttlMs: number): number {
        return this.document.deferredNotices.filter(
            (notice) => !this.noticeExpired(notice, now, ttlMs)
        ).length;
    }

    /** Drop expired deferred notices and persist when anything changed. */
    async pruneDeferred(now: number, ttlMs: number): Promise<number> {
        await this.ensureLoaded();
        const list = [...this.document.deferredNotices];
        const dropped = this.pruneExpiredNotices(list, now, ttlMs);
        if (dropped === 0) return 0;
        this.document = { ...this.document, deferredNotices: list };
        await this.persist();
        return dropped;
    }

    /** Remove deferred notices after they were enqueued successfully. */
    async removeDeferred(ids: readonly string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.ensureLoaded();
        const removing = new Set(ids);
        const kept = this.document.deferredNotices.filter(
            (notice) => !removing.has(notice.id)
        );
        if (kept.length === this.document.deferredNotices.length) return;
        this.document = { ...this.document, deferredNotices: kept };
        await this.persist();
    }

    /** Wait for all queued persistence work. */
    async flush(): Promise<void> {
        await this.persistChain;
    }

    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) await this.load();
    }

    private async update(
        seq: number,
        change: (item: OutboxItem) => OutboxItem
    ): Promise<void> {
        await this.ensureLoaded();
        const items = this.document.items.map((item) =>
            item.seq === seq ? change(item) : item
        );
        this.document = { ...this.document, items };
        this.pruneTerminal();
        await this.persist();
    }

    private pruneExpiredNotices(
        list: DeferredNotice[],
        now: number,
        ttlMs: number
    ): number {
        const kept = list.filter(
            (notice) => !this.noticeExpired(notice, now, ttlMs)
        );
        const dropped = list.length - kept.length;
        list.splice(0, list.length, ...kept);
        return dropped;
    }

    private noticeExpired(
        notice: DeferredNotice,
        now: number,
        ttlMs: number
    ): boolean {
        const createdAt = Date.parse(notice.createdAt);
        return !Number.isFinite(createdAt) || now - createdAt > ttlMs;
    }

    private pruneTerminal(): void {
        const pending = this.document.items.filter(
            (item) => item.state === "pending"
        );
        const terminal = this.document.items
            .filter((item) => item.state !== "pending")
            .sort((left, right) => left.seq - right.seq);
        const keep = terminal.slice(
            Math.max(0, terminal.length - this.historyLimit)
        );
        this.document = {
            ...this.document,
            items: [...keep, ...pending].sort(
                (left, right) => left.seq - right.seq
            ),
        };
    }

    private persist(): Promise<void> {
        const snapshot = this.document;
        this.persistChain = this.persistChain.then(() =>
            writeJsonAtomic(this.path, snapshot)
        );
        return this.persistChain;
    }
}
