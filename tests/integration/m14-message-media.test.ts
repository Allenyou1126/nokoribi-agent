import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileAttachmentRef } from "../../packages/channel-core/src/contract.js";
import ChannelService from "../../packages/channel-core/src/service.js";
import {
    LocalTestChannel,
    type LocalTestAttachments,
} from "../../packages/channel-local-test/src/channel.js";

const IMAGE_REF = {
    attachmentId: "img-1",
    mediaType: "image/png",
    bytes: 4,
    width: 1,
    height: 1,
};

const FILE_REF = {
    attachmentId: "file-1",
    name: "report.txt",
    bytes: 6,
} as unknown as FileAttachmentRef;

const FILE_BYTES = new Uint8Array([97, 98, 99, 100, 101, 102]);

interface Harness {
    readonly ctx: Context;
    readonly channel: LocalTestChannel;
    readonly url: string;
    readonly agent: Agent;
    readonly saveImages: ReturnType<typeof vi.fn>;
    readonly token: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch(() => undefined);
    }
});

function fakeAgent(): Agent {
    return {
        id: "main-1",
        status: "idle",
        session: {
            header: {},
            snapshotEvents: () => [],
        },
        steer: vi.fn(),
        followup: vi.fn(),
        cancel: vi.fn(),
    } as unknown as Agent;
}

async function setup(): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), "nokoribi-m14-int-"));
    vi.stubEnv("DSH_HOME", home);
    const ctx = new Context();
    cleanups.push(async () => {
        await ctx.fiber.dispose();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(
            () => undefined
        );
    });
    ctx.provide("agents", {});
    ctx.provide("commands", { register: () => () => undefined });
    ctx.provide("approval", {});
    ctx.provide("userQuestions", {});
    const saveImages = vi.fn(async () => [IMAGE_REF]);
    const attachments = {
        saveImages,
        saveFile: async () => FILE_REF,
        readFileStream: async function* (ref: FileAttachmentRef) {
            yield ref.bytes === FILE_REF.bytes
                ? FILE_BYTES
                : new Uint8Array(ref.bytes);
        },
    };
    ctx.provide("attachments", attachments);
    const agent = fakeAgent();
    await ctx.plugin(ChannelService as unknown as Plugin, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        defaultChannelId: "local-test",
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
        outboxMaxAttempts: 2,
    });
    const token = `m14-${Math.random().toString(36).slice(2)}`;
    const channel = new LocalTestChannel(
        {
            host: "127.0.0.1",
            port: 0,
            token,
            senderId: "local-user",
            chatId: "local",
            longPollTimeoutMs: 1000,
            maxTextLength: 0,
            markdown: "basic",
            maxBodyBytes: 1024 * 1024,
        },
        ctx.channels,
        attachments as LocalTestAttachments
    );
    const port = await channel.listen();
    cleanups.push(async () => {
        await channel.stop();
    });
    await ctx.channels.initialize();
    await ctx.channels.registerDriver(channel);
    await ctx.channels.attachRuntime({
        agent,
        commands: ctx.commands,
        mainSessionId: "main-1",
    });
    ctx.channels.restoreActiveChat({
        channelId: "local-test",
        chatId: "local",
    });
    return {
        ctx,
        channel,
        url: `http://127.0.0.1:${String(port)}`,
        agent,
        saveImages,
        token,
    };
}

function auth(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
    };
}

function deliveredContent(agent: Agent): readonly unknown[] {
    const followup = agent.followup as unknown as {
        readonly mock: { readonly calls: readonly unknown[][] };
    };
    const message = followup.mock.calls[0]?.[0] as
        | { readonly content?: readonly unknown[] }
        | undefined;
    return message?.content ?? [];
}

interface OutboundItemJson {
    readonly seq: number;
    readonly kind: string;
    readonly text: string;
    readonly files?: readonly {
        readonly attachmentId: string;
        readonly name: string;
        readonly bytes: number;
        readonly mime: string;
    }[];
}

async function outbound(
    harness: Harness,
    after = 0
): Promise<readonly OutboundItemJson[]> {
    const response = await fetch(
        `${harness.url}/v1/outbound?after=${String(after)}&timeout=1`,
        { headers: { authorization: `Bearer ${harness.token}` } }
    );
    const body = (await response.json()) as {
        items: OutboundItemJson[];
    };
    return body.items;
}

async function waitForFileOutbound(
    harness: Harness
): Promise<OutboundItemJson> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const items = await outbound(harness);
        const found = items.find(
            (item) => item.files !== undefined && item.files.length > 0
        );
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for outbound file entry");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function waitForAttachment(
    harness: Harness,
    attachmentId: string
): Promise<Response> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const response = await fetch(
            `${harness.url}/v1/attachments/${attachmentId}`,
            { headers: { authorization: `Bearer ${harness.token}` } }
        );
        if (response.status === 200) return response;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for attachment ${attachmentId} (status ${String(
                    response.status
                )})`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("M14 integration: channel core and local test driver", () => {
    it("injects inbound images into the agent user message", async () => {
        const harness = await setup();
        const response = await fetch(`${harness.url}/v1/inbound`, {
            method: "POST",
            headers: auth(harness.token),
            body: JSON.stringify({
                messageId: "img-1",
                text: "look at this",
                images: [{ mime: "image/png", data: "AAEC" }],
            }),
        });
        expect(response.status).toBe(202);
        expect(harness.saveImages).toHaveBeenCalledOnce();
        const [saved] = harness.saveImages.mock.calls[0] as [
            readonly { readonly mediaType: string }[],
        ];
        expect(saved[0]?.mediaType).toBe("image/png");
        expect(deliveredContent(harness.agent)).toEqual([
            { type: "text", text: "look at this" },
            { type: "image", attachment: IMAGE_REF },
        ]);
    });

    it("delivers outbound files and streams their stored bytes", async () => {
        const harness = await setup();
        const seqs = await harness.ctx.channels.sendFiles(
            [FILE_REF],
            "caption"
        );
        expect(seqs).toHaveLength(2);
        const fileItem = await waitForFileOutbound(harness);
        expect(fileItem.files).toEqual([
            {
                attachmentId: "file-1",
                name: "report.txt",
                bytes: 6,
                mime: "text/plain; charset=utf-8",
            },
        ]);
        const bytes = await waitForAttachment(harness, "file-1");
        expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(FILE_BYTES);
        const history = await outbound(harness);
        expect(history.some((item) => item.text === "caption")).toBe(true);
    });
});
