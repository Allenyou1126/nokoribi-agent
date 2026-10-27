import { describe, expect, it } from "vitest";

import { SendLimiter } from "../src/limiter.js";

describe("qq send limiter", () => {
    it("waits for the C2C per-second window", async () => {
        let now = 0;
        const sleeps: number[] = [];
        const limiter = new SendLimiter({
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
            c2cPerSecond: 2,
            groupPerMinute: 1000,
            relationPerMinute: 1000,
            globalPerSecond: 1000,
        });
        await limiter.acquire("c2c", "c2c:u1");
        await limiter.acquire("c2c", "c2c:u1");
        await limiter.acquire("c2c", "c2c:u1");
        expect(sleeps.length).toBeGreaterThan(0);
        expect(now).toBeGreaterThanOrEqual(1000);
    });

    it("waits for the per-relation window", async () => {
        let now = 0;
        const sleeps: number[] = [];
        const limiter = new SendLimiter({
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
            c2cPerSecond: 1000,
            groupPerMinute: 1000,
            relationPerMinute: 1,
            globalPerSecond: 1000,
        });
        await limiter.acquire("group", "group:g1");
        await limiter.acquire("group", "group:g1");
        expect(sleeps.some((ms) => ms > 0)).toBe(true);
        expect(now).toBeGreaterThanOrEqual(60000);
    });

    it("rejects acquisitions after close", async () => {
        const limiter = new SendLimiter();
        limiter.close();
        await expect(limiter.acquire("c2c", "c2c:u1")).rejects.toThrow(
            /stopped/
        );
    });

    it("unblocks a waiting acquisition when closed", async () => {
        let now = 0;
        const limiter = new SendLimiter({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
                limiter.close();
            },
            c2cPerSecond: 1,
            groupPerMinute: 1000,
            relationPerMinute: 1000,
            globalPerSecond: 1000,
        });
        await limiter.acquire("c2c", "c2c:u1");
        await expect(limiter.acquire("c2c", "c2c:u1")).rejects.toThrow(
            /stopped/
        );
    });
});
