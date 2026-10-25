import {
    emptyOutbox,
    parseOutbox,
    readJsonFile,
    writeJsonAtomic,
    type OutboxDocument,
    type OutboxItem,
    type OutboxKind,
} from "@nokoribi/shared";

/** Input accepted by {@link OutboxStore.enqueue}. */
export interface EnqueueInput {
    readonly channelId: string;
    readonly chatId: string;
    readonly kind: OutboxKind;
    readonly text: string;
    readonly interactionId?: string | null;
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

    /** Append one pending entry and persist it before delivery starts. */
    async enqueue(input: EnqueueInput): Promise<OutboxItem> {
        await this.ensureLoaded();
        const item: OutboxItem = {
            seq: this.document.nextSeq,
            channelId: input.channelId,
            chatId: input.chatId,
            kind: input.kind,
            text: input.text,
            interactionId: input.interactionId ?? null,
            state: "pending",
            attempts: 0,
            nextAttemptAt: null,
            createdAt: new Date().toISOString(),
            sentAt: null,
        };
        this.document = {
            ...this.document,
            nextSeq: this.document.nextSeq + 1,
            items: [...this.document.items, item],
        };
        await this.persist();
        return item;
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
