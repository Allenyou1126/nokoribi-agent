import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OutboxStore } from "../src/outbox.js";

const dirs: string[] = [];

async function store(
    limit = 100
): Promise<{ path: string; store: OutboxStore }> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-outbox-"));
    dirs.push(dir);
    const path = join(dir, "outbox.json");
    return { path, store: new OutboxStore(path, limit) };
}

afterEach(async () => {
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

describe("outbox store", () => {
    it("allocates sequences and persists pending entries before delivery", async () => {
        const { path, store: box } = await store();
        const first = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "one",
        });
        const second = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "two",
        });
        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(box.pendingCount).toBe(2);
        const reloaded = new OutboxStore(path, 100);
        await reloaded.load();
        expect(reloaded.pending().map((item) => item.text)).toEqual([
            "one",
            "two",
        ]);
    });

    it("marks sent entries and keeps them in history", async () => {
        const { store: box } = await store();
        const item = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "one",
        });
        await box.markSent(item.seq);
        expect(box.pendingCount).toBe(0);
        expect(box.historyAfter(0).map((entry) => entry.state)).toEqual([
            "sent",
        ]);
    });

    it("retries with metadata and can exhaust", async () => {
        const { store: box } = await store();
        const item = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "one",
        });
        await expect(
            box.markAttemptFailed(
                item.seq,
                new Date(Date.now() + 1000).toISOString(),
                false
            )
        ).resolves.toBe(true);
        expect(box.pending()[0]?.attempts).toBe(1);
        await expect(box.markAttemptFailed(item.seq, null, true)).resolves.toBe(
            false
        );
        expect(box.pendingCount).toBe(0);
        expect(box.historyAfter(0)[0]?.state).toBe("failed");
    });

    it("prunes terminal history but keeps every pending entry", async () => {
        const { path, store: box } = await store(1);
        for (let index = 0; index < 3; index += 1) {
            const item = await box.enqueue({
                channelId: "local-test",
                chatId: "local",
                kind: "reply",
                text: `sent-${index}`,
            });
            await box.markSent(item.seq);
        }
        await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "pending",
        });
        const reloaded = new OutboxStore(path, 1);
        await reloaded.load();
        expect(reloaded.historyAfter(0).length).toBe(2);
        expect(reloaded.pendingCount).toBe(1);
    });
});
