import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    it("fails pending interaction prompts and discards terminal entries", async () => {
        const { store: box } = await store();
        const reply = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "reply",
            text: "keep",
        });
        const interaction = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "interaction",
            text: "prompt",
            interactionId: "i-1",
        });
        const other = await box.enqueue({
            channelId: "local-test",
            chatId: "local",
            kind: "interaction",
            text: "other",
            interactionId: "i-2",
        });
        await expect(box.failPendingInteraction("i-1")).resolves.toBe(1);
        expect(box.pending().map((item) => item.seq)).toEqual([
            reply.seq,
            other.seq,
        ]);
        await expect(box.failPendingInteractions()).resolves.toBe(1);
        expect(box.pendingCount).toBe(1);
        await box.markDiscarded(reply.seq);
        expect(box.pendingCount).toBe(0);
        expect(
            box.historyAfter(0).every((item) => item.state === "failed")
        ).toBe(true);
        expect(interaction.seq).toBe(2);
    });

    it("persists passive reply context and actions across reload", async () => {
        const { path, store: box } = await store();
        const item = await box.enqueue({
            channelId: "qq-bot",
            chatId: "c2c:user",
            kind: "reply",
            text: "hi",
            reply: { messageId: "m-1", receivedAt: 1234 },
            actions: [
                {
                    id: "allow",
                    label: "允许",
                    kind: "callback",
                    payload: "a1",
                },
            ],
        });
        expect(item.replyTo).toBe("m-1");
        expect(item.replyReceivedAt).toBe(1234);
        expect(item.replySeq).toBe(1);
        expect(item.actions?.[0]?.id).toBe("allow");
        const reloaded = new OutboxStore(path, 100);
        await reloaded.load();
        const stored = reloaded.historyAfter(0)[0];
        expect(stored?.replyTo).toBe("m-1");
        expect(stored?.replyReceivedAt).toBe(1234);
        expect(stored?.replySeq).toBe(1);
        expect(stored?.actions?.[0]?.kind).toBe("callback");
    });

    it("reads a legacy outbox document without new fields", async () => {
        const { path } = await store();
        await writeFile(
            path,
            JSON.stringify({
                version: 1,
                nextSeq: 2,
                items: [
                    {
                        seq: 1,
                        channelId: "local-test",
                        chatId: "local",
                        kind: "reply",
                        text: "old",
                        interactionId: null,
                        state: "pending",
                        attempts: 0,
                        nextAttemptAt: null,
                        createdAt: new Date().toISOString(),
                        sentAt: null,
                    },
                ],
            })
        );
        const box = new OutboxStore(path, 100);
        await box.load();
        const item = box.pending()[0];
        expect(item?.text).toBe("old");
        expect(item?.replyTo ?? null).toBeNull();
        expect(item?.actions ?? null).toBeNull();
        expect(box.deferredCount(Date.now(), 1000)).toBe(0);
    });

    it("allocates reply slots per reply context across batches", async () => {
        const { store: box } = await store();
        const first = await box.enqueueMany([
            {
                channelId: "qq-bot",
                chatId: "c",
                kind: "reply",
                text: "one",
                reply: { messageId: "m", receivedAt: 1 },
            },
            {
                channelId: "qq-bot",
                chatId: "c",
                kind: "reply",
                text: "two",
                reply: { messageId: "m", receivedAt: 1 },
            },
        ]);
        expect(first.map((item) => item.replySeq)).toEqual([1, 2]);
        const third = await box.enqueue({
            channelId: "qq-bot",
            chatId: "c",
            kind: "reply",
            text: "three",
            reply: { messageId: "m", receivedAt: 1 },
        });
        expect(third.replySeq).toBe(3);
        const other = await box.enqueue({
            channelId: "qq-bot",
            chatId: "c",
            kind: "reply",
            text: "other",
            reply: { messageId: "m-2", receivedAt: 1 },
        });
        expect(other.replySeq).toBe(1);
    });

    it("clears passive context before an active retry", async () => {
        const { store: box } = await store();
        const item = await box.enqueue({
            channelId: "qq-bot",
            chatId: "c",
            kind: "reply",
            text: "one",
            reply: { messageId: "m", receivedAt: 1 },
        });
        await box.clearReply(item.seq);
        const stored = box.historyAfter(0)[0];
        expect(stored?.replyTo).toBeNull();
        expect(stored?.replyReceivedAt).toBeNull();
        expect(stored?.replySeq).toBeNull();
    });

    it("defers notices per chat with TTL and bounded overflow", async () => {
        const { store: box } = await store();
        const now = Date.now();
        const limits = { perChat: 2, total: 3, ttlMs: 1000 };
        await box.deferNotice(
            { channelId: "qq-bot", chatId: "c", text: "one" },
            limits,
            now
        );
        await box.deferNotice(
            { channelId: "qq-bot", chatId: "c", text: "two" },
            limits,
            now
        );
        const overflow = await box.deferNotice(
            { channelId: "qq-bot", chatId: "c", text: "three" },
            limits,
            now
        );
        expect(overflow.dropped).toBe(1);
        expect(
            box
                .listDeferred("qq-bot", "c", 10, now, 1000)
                .map((notice) => notice.text)
        ).toEqual(["two", "three"]);
        expect(box.deferredCount(now, 1000)).toBe(2);
        expect(box.pendingCount).toBe(0);
        expect(box.historyAfter(0)).toEqual([]);

        const old = await box.deferNotice(
            { channelId: "qq-bot", chatId: "d", text: "old" },
            limits,
            now
        );
        expect(old.dropped).toBe(0);
        expect(box.listDeferred("qq-bot", "d", 10, now + 5000, 1000)).toEqual(
            []
        );
        expect(box.deferredCount(now + 5000, 1000)).toBe(0);

        const notices = box.listDeferred("qq-bot", "c", 10, now, 1000);
        await box.removeDeferred(notices.map((notice) => notice.id));
        expect(box.listDeferred("qq-bot", "c", 10, now, 1000)).toHaveLength(0);

        const capped = { perChat: 5, total: 2, ttlMs: 60_000 };
        await box.deferNotice(
            { channelId: "a", chatId: "1", text: "a1" },
            capped,
            now + 10_000
        );
        await box.deferNotice(
            { channelId: "b", chatId: "1", text: "b1" },
            capped,
            now + 10_000
        );
        await box.deferNotice(
            { channelId: "c", chatId: "1", text: "c1" },
            capped,
            now + 10_000
        );
        expect(box.deferredCount(now + 10_000, 60_000)).toBe(2);
    });
});
