import {
    emptySeen,
    parseSeen,
    readJsonFile,
    writeJsonAtomic,
    type SeenDocument,
} from "@nokoribi/shared";

/** Bounded durable dedupe set for inbound message identities. */
export class SeenStore {
    private readonly path: string;
    private readonly limit: number;
    private document: SeenDocument = emptySeen();
    private loaded = false;
    private persistChain: Promise<void> = Promise.resolve();

    constructor(path: string, limit: number) {
        this.path = path;
        this.limit = limit;
    }

    /** Load the durable set. */
    async load(): Promise<void> {
        if (this.loaded) return;
        const raw = await readJsonFile(this.path);
        this.document = raw === undefined ? emptySeen() : parseSeen(raw);
        this.loaded = true;
    }

    /** Whether this message identity was already processed. */
    has(key: string): boolean {
        return this.document.seen.some((entry) => entry.key === key);
    }

    /** Record an identity before injection; persists before returning. */
    async add(key: string): Promise<void> {
        if (!this.loaded) await this.load();
        if (this.has(key)) return;
        const seen = [
            ...this.document.seen,
            { key, at: new Date().toISOString() },
        ];
        this.document = {
            version: 1,
            seen: seen.slice(Math.max(0, seen.length - this.limit)),
        };
        const snapshot = this.document;
        this.persistChain = this.persistChain.then(() =>
            writeJsonAtomic(this.path, snapshot)
        );
        await this.persistChain;
    }

    /** Wait for queued persistence work. */
    async flush(): Promise<void> {
        await this.persistChain;
    }
}
