import type { ChatScope } from "@tencent-connect/qqbot-nodejs/protocol";

/** Limits applied before each QQ send. */
export interface SendLimiterOptions {
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly globalPerSecond?: number;
    readonly c2cPerSecond?: number;
    readonly groupPerMinute?: number;
    readonly relationPerMinute?: number;
}

interface Rule {
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window limiter for platform rate limits.
 *
 * The outbox pump is serial, so these limits are a safety net rather than a
 * throughput mechanism. `close()` unblocks shutdown within the sleep cap.
 */
export class SendLimiter {
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly globalPerSecond: number;
    private readonly c2cPerSecond: number;
    private readonly groupPerMinute: number;
    private readonly relationPerMinute: number;
    private readonly history = new Map<string, number[]>();
    private closed = false;

    constructor(options: SendLimiterOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? DEFAULT_SLEEP;
        this.globalPerSecond = options.globalPerSecond ?? 100;
        this.c2cPerSecond = options.c2cPerSecond ?? 10;
        this.groupPerMinute = options.groupPerMinute ?? 60;
        this.relationPerMinute = options.relationPerMinute ?? 20;
    }

    /** Wait until one send may proceed. */
    async acquire(scope: ChatScope, chatId: string): Promise<void> {
        for (;;) {
            if (this.closed) throw new Error("qq-bot driver is stopped");
            const now = this.now();
            let waitMs = 0;
            for (const rule of this.rules(scope, chatId)) {
                if (rule.limit <= 0) continue;
                const timestamps = this.history.get(rule.key) ?? [];
                const cutoff = now - rule.windowMs;
                while (
                    timestamps.length > 0 &&
                    (timestamps[0] ?? 0) <= cutoff
                ) {
                    timestamps.shift();
                }
                this.history.set(rule.key, timestamps);
                if (timestamps.length >= rule.limit) {
                    const oldest = timestamps[0] ?? now;
                    waitMs = Math.max(waitMs, oldest + rule.windowMs - now);
                }
            }
            if (waitMs <= 0) {
                this.record(scope, chatId, now);
                return;
            }
            await this.sleep(Math.min(waitMs, 500));
        }
    }

    /** Release any in-flight waits; subsequent acquisitions fail. */
    close(): void {
        this.closed = true;
    }

    private rules(scope: ChatScope, chatId: string): readonly Rule[] {
        return [
            {
                key: "global",
                limit: this.globalPerSecond,
                windowMs: 1000,
            },
            {
                key: `scope:${scope}`,
                limit:
                    scope === "c2c" ? this.c2cPerSecond : this.groupPerMinute,
                windowMs: scope === "c2c" ? 1000 : 60_000,
            },
            {
                key: `relation:${chatId}`,
                limit: this.relationPerMinute,
                windowMs: 60_000,
            },
        ];
    }

    private record(scope: ChatScope, chatId: string, now: number): void {
        for (const rule of this.rules(scope, chatId)) {
            if (rule.limit <= 0) continue;
            const timestamps = this.history.get(rule.key) ?? [];
            timestamps.push(now);
            this.history.set(rule.key, timestamps);
        }
    }
}
