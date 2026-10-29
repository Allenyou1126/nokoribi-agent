import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ChannelService,
    InboundMessage,
    IngressResult,
} from "@nokoribi/channel-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalTestChannel, type LocalTestConfig } from "../src/channel.js";

const dirs: string[] = [];
const channels: LocalTestChannel[] = [];

async function start(
    outboundItems: readonly Record<string, unknown>[] = [
        {
            seq: 1,
            kind: "reply",
            chatId: "local",
            text: "one",
            interactionId: null,
        },
        {
            seq: 2,
            kind: "notice",
            chatId: "local",
            text: "two",
            interactionId: null,
        },
    ]
): Promise<{
    channel: LocalTestChannel;
    url: string;
    ingress: ReturnType<typeof vi.fn>;
}> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-http-"));
    dirs.push(dir);
    process.env.DSH_HOME = dir;
    const seen = new Set<string>();
    const ingress = vi.fn(
        async (message: InboundMessage): Promise<IngressResult> => {
            if (seen.has(message.messageId)) {
                return { accepted: true, duplicate: true };
            }
            seen.add(message.messageId);
            return { accepted: true, duplicate: false };
        }
    );
    const fake = {
        ingress,
        status: () => ({
            version: "0.1.0",
            uptimeSec: 1,
            mainSessionId: "main-1",
            agentStatus: "idle",
            goals: [],
            pendingInteractions: 0,
            outboxLength: 0,
            lastRestartReason: "first-start",
            ready: true,
        }),
        waitForOutbound: async (after: number) =>
            outboundItems.filter((item) =>
                (item.seq as number | undefined) !== undefined
                    ? (item.seq as number) > after
                    : false
            ),
        nextOutboxSeq: 3,
    } as unknown as ChannelService;
    const config: LocalTestConfig = {
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        senderId: "local-user",
        chatId: "local",
        longPollTimeoutMs: 1000,
        maxTextLength: 0,
        markdown: "basic",
        maxBodyBytes: 1024 * 1024,
    };
    const channel = new LocalTestChannel(config, fake);
    const port = await channel.listen();
    await channel.writeDiscoveryFile();
    channels.push(channel);
    return { channel, url: `http://127.0.0.1:${port}`, ingress };
}

afterEach(async () => {
    await Promise.all(channels.splice(0).map((channel) => channel.stop()));
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

function auth(token = "secret"): Record<string, string> {
    return { authorization: `Bearer ${token}` };
}

describe("local test channel", () => {
    it("rejects missing or wrong tokens", async () => {
        const { url } = await start();
        expect((await fetch(`${url}/v1/status`)).status).toBe(401);
        expect(
            (await fetch(`${url}/v1/status`, { headers: auth("wrong") })).status
        ).toBe(401);
    });

    it("accepts inbound and returns the message id", async () => {
        const { url, ingress } = await start();
        const response = await fetch(`${url}/v1/inbound`, {
            method: "POST",
            headers: { ...auth(), "content-type": "application/json" },
            body: JSON.stringify({ text: "hello", messageId: "m-1" }),
        });
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ messageId: "m-1" });
        expect(ingress).toHaveBeenCalledTimes(1);
    });

    it("returns duplicate inbound idempotently", async () => {
        const { url } = await start();
        const body = JSON.stringify({ text: "hello", messageId: "m-1" });
        const headers = { ...auth(), "content-type": "application/json" };
        expect(
            (
                await fetch(`${url}/v1/inbound`, {
                    method: "POST",
                    headers,
                    body,
                })
            ).status
        ).toBe(202);
        expect(
            (
                await fetch(`${url}/v1/inbound`, {
                    method: "POST",
                    headers,
                    body,
                })
            ).status
        ).toBe(202);
    });

    it("rejects invalid delivery and empty text", async () => {
        const { url } = await start();
        const headers = { ...auth(), "content-type": "application/json" };
        expect(
            (
                await fetch(`${url}/v1/inbound`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ text: "x", delivery: "cancel" }),
                })
            ).status
        ).toBe(400);
        expect(
            (
                await fetch(`${url}/v1/inbound`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ text: "   " }),
                })
            ).status
        ).toBe(400);
    });

    it("returns 501 for inbound images in M1", async () => {
        const { url } = await start();
        const response = await fetch(`${url}/v1/inbound`, {
            method: "POST",
            headers: { ...auth(), "content-type": "application/json" },
            body: JSON.stringify({
                text: "look",
                images: [{ mime: "image/png", dataBase64: "AA==" }],
            }),
        });
        expect(response.status).toBe(501);
    });

    it("accepts action-only callbacks and invalid actions", async () => {
        const { url, ingress } = await start();
        const headers = { ...auth(), "content-type": "application/json" };
        const accepted = await fetch(`${url}/v1/inbound`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                messageId: "act-1",
                action: {
                    id: "token-1",
                    payload: JSON.stringify({ k: "token-1" }),
                    messageId: "platform-1",
                },
            }),
        });
        expect(accepted.status).toBe(202);
        expect(ingress).toHaveBeenCalledWith(
            expect.objectContaining({
                messageId: "act-1",
                action: {
                    id: "token-1",
                    payload: JSON.stringify({ k: "token-1" }),
                    messageId: "platform-1",
                },
            })
        );
        const firstMessage = ingress.mock.calls[0]?.[0] as
            | InboundMessage
            | undefined;
        expect(firstMessage?.text).toBeUndefined();

        for (const action of [
            {},
            { id: "" },
            { id: "token-1", payload: 1 },
            { id: "token-1", messageId: " " },
        ]) {
            const invalid = await fetch(`${url}/v1/inbound`, {
                method: "POST",
                headers,
                body: JSON.stringify({ action }),
            });
            expect(invalid.status).toBe(400);
        }
    });

    it("advertises action capabilities and projects outbound actions", async () => {
        const outbound = await start([
            {
                seq: 1,
                kind: "interaction",
                chatId: "local",
                text: "prompt",
                interactionId: "i-1",
                actions: [
                    {
                        id: "token-1",
                        label: "允许一次",
                        kind: "callback",
                        payload: "{}",
                        style: "primary",
                    },
                ],
            },
        ]);
        expect(outbound.channel.capabilities.outboundActions).toBe(true);
        expect(outbound.channel.capabilities.inboundActions).toBe(true);
        const response = await fetch(
            `${outbound.url}/v1/outbound?after=0&timeout=1`,
            { headers: auth() }
        );
        await expect(response.json()).resolves.toEqual({
            items: [
                {
                    seq: 1,
                    kind: "interaction",
                    chatId: "local",
                    text: "prompt",
                    interactionId: "i-1",
                    actions: [
                        {
                            id: "token-1",
                            label: "允许一次",
                            kind: "callback",
                            payload: "{}",
                            style: "primary",
                        },
                    ],
                },
            ],
            nextSeq: 2,
        });
    });

    it("serves status and outbound history", async () => {
        const { url } = await start();
        const status = await fetch(`${url}/v1/status`, { headers: auth() });
        expect(status.status).toBe(200);
        await expect(status.json()).resolves.toMatchObject({
            mainSessionId: "main-1",
            ready: true,
        });
        const outbound = await fetch(`${url}/v1/outbound?after=0&timeout=1`, {
            headers: auth(),
        });
        await expect(outbound.json()).resolves.toEqual({
            items: [
                { seq: 1, kind: "reply", chatId: "local", text: "one" },
                { seq: 2, kind: "notice", chatId: "local", text: "two" },
            ],
            nextSeq: 3,
        });
        const empty = await fetch(`${url}/v1/outbound?after=2&timeout=0`, {
            headers: auth(),
        });
        await expect(empty.json()).resolves.toEqual({
            items: [],
            nextSeq: 2,
        });
    });
});
