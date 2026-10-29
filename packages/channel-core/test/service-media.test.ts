import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    FileAttachmentRef,
    ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    ChannelCapabilities,
    ChannelDriver,
    InboundMessage,
    OutboundContent,
} from "../src/contract.js";
import ChannelService from "../src/service.js";

interface SentMessage {
    readonly chatId: string;
    readonly content: OutboundContent;
}

class FakeDriver implements ChannelDriver {
    readonly id = "fake";
    readonly capabilities: ChannelCapabilities;
    readonly sent: SentMessage[] = [];
    failure: Error | undefined;

    constructor(capabilities?: Partial<ChannelCapabilities>) {
        this.capabilities = {
            markdown: "none",
            maxTextLength: 4500,
            inboundImages: true,
            outboundFiles: true,
            outboundActions: true,
            inboundActions: true,
            activeMessages: true,
            ...capabilities,
        };
    }

    async start(): Promise<void> {}
    async stop(): Promise<void> {}

    async send(
        chatId: string,
        content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        if (this.failure !== undefined) throw this.failure;
        this.sent.push({ chatId, content });
        return {
            channelId: this.id,
            chatId,
            messageId: `sent-${String(this.sent.length)}`,
        };
    }
}

interface FakeAttachments {
    saveImages: ReturnType<typeof vi.fn>;
    saveFile: ReturnType<typeof vi.fn>;
    readFileStream: ReturnType<typeof vi.fn>;
}

const IMAGE_REF = {
    attachmentId: "img-1",
    mediaType: "image/png",
    bytes: 4,
    width: 1,
    height: 1,
} as unknown as ImageAttachmentRef;

const FILE_REF = {
    attachmentId: "file-1",
    name: "report.txt",
    bytes: 6,
} as unknown as FileAttachmentRef;

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

function fakeAttachments(): FakeAttachments {
    return {
        saveImages: vi.fn(async () => [IMAGE_REF]),
        saveFile: vi.fn(async () => FILE_REF),
        readFileStream: vi.fn(async function* () {
            yield new Uint8Array([1, 2, 3, 4, 5, 6]);
        }),
    };
}

function inboundMessage(
    overrides: Partial<InboundMessage> = {}
): InboundMessage {
    return {
        channelId: "fake",
        chatId: "local",
        senderId: "local-user",
        messageId: `in-${String(Math.random())}`,
        receivedAt: Date.now(),
        text: "hello",
        ...overrides,
    };
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const dirs: string[] = [];
const contexts: Context[] = [];

afterEach(async () => {
    await Promise.all(
        contexts.splice(0).map(async (ctx) => {
            await ctx.fiber.dispose();
        })
    );
    vi.unstubAllEnvs();
    await Promise.all(
        dirs
            .splice(0)
            .map((dir) =>
                rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(
                    () => undefined
                )
            )
    );
});

interface SetupResult {
    readonly ctx: Context;
    readonly agent: Agent;
    readonly driver: FakeDriver;
    readonly attachments: FakeAttachments;
}

async function setup(
    options: {
        readonly capabilities?: Partial<ChannelCapabilities>;
        readonly attachments?: FakeAttachments;
    } = {}
): Promise<SetupResult> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-service-media-"));
    dirs.push(dir);
    vi.stubEnv("DSH_HOME", dir);
    const ctx = new Context();
    contexts.push(ctx);
    ctx.provide("agents", {});
    ctx.provide("commands", {
        register: () => () => undefined,
    });
    ctx.provide("approval", {});
    ctx.provide("userQuestions", {});
    const attachments = options.attachments ?? fakeAttachments();
    ctx.provide("attachments", attachments);
    const agent = fakeAgent();
    const driver = new FakeDriver(options.capabilities);
    await ctx.plugin(ChannelService as unknown as Plugin, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        trustedChannels: ["fake"],
        defaultChannelId: "fake",
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
    });
    await ctx.channels.registerDriver(driver);
    await ctx.channels.initialize();
    await ctx.channels.attachRuntime({
        agent,
        commands: ctx.commands,
        mainSessionId: "main-1",
    });
    return { ctx, agent, driver, attachments };
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

describe("channel service inbound images", () => {
    it("saves images and delivers text plus image blocks", async () => {
        const { ctx, agent, attachments } = await setup();
        const data = new Uint8Array([137, 80, 78, 71]);
        await expect(
            ctx.channels.ingress(
                inboundMessage({
                    messageId: "img-1",
                    text: "look at this",
                    images: [{ mime: "image/png", data }],
                })
            )
        ).resolves.toMatchObject({ accepted: true });
        expect(attachments.saveImages).toHaveBeenCalledWith([
            { data, mediaType: "image/png" },
        ]);
        expect(deliveredContent(agent)).toEqual([
            { type: "text", text: "look at this" },
            { type: "image", attachment: IMAGE_REF },
        ]);
    });

    it("delivers an image-only message without a text block", async () => {
        const { ctx, agent } = await setup();
        await expect(
            ctx.channels.ingress(
                inboundMessage({
                    messageId: "img-only",
                    text: undefined,
                    images: [{ mime: "image/png", data: new Uint8Array([1]) }],
                })
            )
        ).resolves.toMatchObject({ accepted: true });
        expect(deliveredContent(agent)).toEqual([
            { type: "image", attachment: IMAGE_REF },
        ]);
    });

    it("degrades to text-only when saving images fails", async () => {
        const attachments = fakeAttachments();
        attachments.saveImages.mockRejectedValueOnce(
            new Error("unsupported image")
        );
        const { ctx, agent } = await setup({ attachments });
        await expect(
            ctx.channels.ingress(
                inboundMessage({
                    messageId: "img-fail",
                    text: "caption",
                    images: [{ mime: "image/png", data: new Uint8Array([2]) }],
                })
            )
        ).resolves.toMatchObject({ accepted: true });
        expect(deliveredContent(agent)).toEqual([
            { type: "text", text: "caption" },
        ]);
    });

    it("rejects images from drivers without the inboundImages capability", async () => {
        const { ctx, agent, attachments } = await setup({
            capabilities: { inboundImages: false },
        });
        await expect(
            ctx.channels.ingress(
                inboundMessage({
                    messageId: "img-unsupported",
                    images: [{ mime: "image/png", data: new Uint8Array([3]) }],
                })
            )
        ).resolves.toMatchObject({
            accepted: false,
            reason: "unsupported-images",
        });
        expect(attachments.saveImages).not.toHaveBeenCalled();
        expect(agent.followup).not.toHaveBeenCalled();
    });
});

describe("channel service outbound files", () => {
    it("enqueues text first and one entry per file, keeping seqs", async () => {
        const { ctx, driver, agent } = await setup();
        const secondFile = {
            attachmentId: "file-2",
            name: "second.txt",
            bytes: 2,
        } as unknown as FileAttachmentRef;
        const seqs = await ctx.channels.sendFiles(
            [FILE_REF, secondFile],
            "here are the files"
        );
        expect(seqs).toHaveLength(3);
        await waitFor(() => driver.sent.length === 3);
        expect(driver.sent.map((message) => message.content.text)).toEqual([
            "here are the files",
            "",
            "",
        ]);
        expect(driver.sent[0]?.content.files).toBeUndefined();
        expect(driver.sent[1]?.content.files).toEqual([FILE_REF]);
        expect(driver.sent[2]?.content.files).toEqual([secondFile]);
        expect(agent.followup).not.toHaveBeenCalled();
    });

    it("keeps only the final text chunk adjacent to the file entries", async () => {
        const { ctx, driver } = await setup({
            capabilities: { maxTextLength: 20 },
        });
        const text = "alpha beta gamma delta epsilon zeta eta";
        const seqs = await ctx.channels.sendFiles([FILE_REF], text);
        await waitFor(() => driver.sent.length === seqs.length);
        const contents = driver.sent.map((message) => message.content);
        const fileEntry = contents.at(-1);
        expect(fileEntry?.files).toEqual([FILE_REF]);
        expect(
            contents
                .slice(0, -1)
                .every((content) => content.files === undefined)
        ).toBe(true);
        expect(
            contents.slice(0, -1).every((content) => content.text !== "")
        ).toBe(true);
    });

    it("rejects files for drivers without the outboundFiles capability", async () => {
        const { ctx } = await setup({
            capabilities: { outboundFiles: false },
        });
        await expect(
            ctx.channels.sendFiles([FILE_REF], "attachment")
        ).rejects.toThrow(/不支持|unsupported|files/i);
    });
});
