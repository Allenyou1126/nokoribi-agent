import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-agent";
import {
    mountAgentLoopTestDependencies,
    mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import Commands from "@deepseek-ai/dsh-commands";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import { SessionId } from "@deepseek-ai/dsh-session";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import UserQuestionService from "@deepseek-ai/dsh-user-questions";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChannelService, {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
    type ChannelCapabilities,
    type ChannelDriver,
    type ChannelHealth,
    type InboundMessage,
    type OutboundContent,
} from "../../packages/channel-core/src/index.js";

interface SentMessage {
    readonly chatId: string;
    readonly content: OutboundContent;
}

interface FakeDriver extends ChannelDriver {
    readonly sent: SentMessage[];
    calls: number;
    failWith: Error | undefined;
    failOnce: Error | undefined;
}

interface FakeOptions {
    readonly id: string;
    readonly capabilities?: Partial<ChannelCapabilities>;
    readonly defaultChatId?: string;
    readonly canDeliver?: (
        chatId: string,
        content: Pick<OutboundContent, "kind" | "reply">
    ) => boolean;
    readonly health?: () => ChannelHealth;
}

function makeDriver(options: FakeOptions): FakeDriver {
    const capabilities: ChannelCapabilities = {
        markdown: "none",
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
        ...options.capabilities,
    };
    const driver: FakeDriver = {
        id: options.id,
        capabilities,
        sent: [],
        calls: 0,
        failWith: undefined,
        failOnce: undefined,
        async start(): Promise<void> {},
        async stop(): Promise<void> {},
        async send(
            chatId: string,
            content: OutboundContent
        ): Promise<{ channelId: string; chatId: string; messageId: string }> {
            driver.calls += 1;
            if (driver.failOnce !== undefined) {
                const error = driver.failOnce;
                driver.failOnce = undefined;
                throw error;
            }
            if (driver.failWith !== undefined) throw driver.failWith;
            driver.sent.push({ chatId, content });
            return {
                channelId: driver.id,
                chatId,
                messageId: `sent-${String(driver.calls)}`,
            };
        },
        health: () => options.health?.() ?? { state: "online" },
        ...(options.defaultChatId === undefined
            ? {}
            : { defaultChatId: options.defaultChatId }),
        ...(options.canDeliver === undefined
            ? {}
            : { canDeliver: options.canDeliver }),
    };
    return driver;
}

class TextAdapter extends LlmAdapter {
    text: string;

    constructor(text: string) {
        super();
        this.text = text;
    }

    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield* textChunks(this.text);
    }
}

function textChunks(value: string): AsyncIterable<StreamChunk> {
    return (async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: value };
        yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: value },
        };
        yield { type: "finish", reason: { kind: "stop" } };
    })();
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 15_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

interface SetupOptions {
    readonly drivers: readonly FakeDriver[];
    readonly trustedChannels?: readonly string[];
    readonly defaultChannelId?: string;
    readonly defaultChatId?: string;
    readonly responseText?: string;
    readonly prepare?: (home: string) => Promise<void>;
}

interface SetupResult {
    readonly ctx: Context;
    readonly parent: Awaited<
        ReturnType<
            Awaited<ReturnType<typeof mountAgentLoopTestHarness>>["create"]
        >
    >;
    readonly home: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch(() => undefined);
    }
});

async function setup(options: SetupOptions): Promise<SetupResult> {
    const home = await mkdtemp(join(tmpdir(), "nokoribi-m7-"));
    vi.stubEnv("DSH_HOME", home);
    const workspace = join(home, "workspace");
    const ctx = new Context();
    cleanups.push(async () => {
        await ctx.dispose();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    });

    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    ctx.provide("shell", { sandboxMode: "danger-full-access" });
    await ctx.plugin(Commands);
    await ctx.plugin(UserQuestionService);
    await ctx.plugin(ApprovalService, { policy: "never" });
    await ctx.plugin(PermissionPresetService, {
        presets: {
            "danger-full-access": {
                sandbox: "danger-full-access",
                approval: "never",
            },
        },
        defaultPreset: "danger-full-access",
    });
    ctx.llm.registerAdapter(
        ["mock"],
        new TextAdapter(options.responseText ?? "pong")
    );

    const harness = await mountAgentLoopTestHarness(ctx);
    const parent = await harness.create(
        SessionId(`main-m7-${randomUUID()}`),
        { provider: "mock", model: "main-model" },
        { cwd: workspace }
    );

    await ctx.plugin(ChannelService, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: options.defaultChatId ?? "local",
        trustedChannels: options.trustedChannels ?? [],
        defaultChannelId:
            options.defaultChannelId ?? options.drivers[0]?.id ?? "",
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
    });
    for (const driver of options.drivers) {
        await ctx.channels.registerDriver(driver);
    }
    await options.prepare?.(home);
    await ctx.channels.initialize();
    await ctx.channels.attachRuntime({
        agent: parent,
        commands: ctx.commands,
        mainSessionId: parent.id,
    });
    return { ctx, parent, home };
}

function inbound(
    channelId: string,
    messageId: string,
    text: string,
    overrides: Partial<InboundMessage> = {}
): InboundMessage {
    return {
        channelId,
        chatId: "local",
        senderId: "local-user",
        messageId,
        text,
        receivedAt: Date.now(),
        ...overrides,
    };
}

describe("M7 channel routing", () => {
    it("routes a turn reply to its source chat with a passive context", async () => {
        const source = makeDriver({
            id: "fake-a",
            defaultChatId: "a-chat",
        });
        const other = makeDriver({
            id: "fake-b",
            defaultChatId: "b-chat",
        });
        const { ctx } = await setup({
            drivers: [source, other],
            defaultChannelId: "fake-b",
        });

        const result = await ctx.channels.ingress(
            inbound("fake-a", "m-a-1", "hello")
        );
        expect(result.accepted).toBe(true);
        await ctx.channels.sendReply("pong");
        await waitFor(() => source.sent.length > 0);

        expect(other.sent).toHaveLength(0);
        const sent = source.sent[0];
        expect(sent?.chatId).toBe("local");
        expect(sent?.content.kind).toBe("reply");
        expect(sent?.content.deliveryId).toBeGreaterThan(0);
        expect(sent?.content.attempt).toBe(0);
        expect(sent?.content.reply).toEqual({
            messageId: "m-a-1",
            receivedAt: expect.any(Number),
            seq: 1,
        });
    });

    it("lets trusted channels bypass the static allowlist", async () => {
        const trusted = makeDriver({ id: "fake-a" });
        const untrusted = makeDriver({ id: "fake-b" });
        const { ctx } = await setup({
            drivers: [trusted, untrusted],
            trustedChannels: ["fake-a"],
        });

        const accepted = await ctx.channels.ingress(
            inbound("fake-a", "t-1", "hi", {
                chatId: "stranger-chat",
                senderId: "stranger",
            })
        );
        expect(accepted.accepted).toBe(true);
        await ctx.channels.sendReply("pong");
        await waitFor(() => trusted.sent.length > 0);

        const denied = await ctx.channels.ingress(
            inbound("fake-b", "t-2", "hi", {
                chatId: "stranger-chat",
                senderId: "stranger",
            })
        );
        expect(denied).toMatchObject({
            accepted: false,
            reason: "not-allowed",
        });
    });

    it("falls back to an active-capable channel for notices", async () => {
        const qq = makeDriver({
            id: "qq",
            capabilities: { activeMessages: false },
        });
        const local = makeDriver({ id: "local", defaultChatId: "local" });
        const { ctx } = await setup({
            drivers: [qq, local],
            defaultChannelId: "local",
        });

        await ctx.channels.ingress(inbound("qq", "n-1", "hi"));
        await ctx.channels.notify("提醒喝水");
        await waitFor(() =>
            local.sent.some((message) => message.content.kind === "notice")
        );

        const notice = local.sent.find(
            (message) => message.content.kind === "notice"
        );
        expect(notice?.content.text).toContain("⚠️ 提醒喝水");
        expect(
            qq.sent.filter((message) => message.content.kind === "notice")
        ).toHaveLength(0);
    });

    it("defers notices and replays them on the chat's next inbound", async () => {
        const qq = makeDriver({
            id: "qq",
            capabilities: { activeMessages: false },
        });
        const { ctx } = await setup({
            drivers: [qq],
            defaultChannelId: "qq",
        });

        await ctx.channels.ingress(inbound("qq", "d-1", "hello"));
        await ctx.channels.notify("喝水提醒");
        expect(ctx.channels.status().deferredNotices).toBe(1);

        await ctx.channels.ingress(inbound("qq", "d-2", "wake"));
        await ctx.channels.sendReply("answer");
        await waitFor(
            () =>
                qq.sent.some(
                    (message) =>
                        message.content.kind === "notice" &&
                        message.content.text.includes("⚠️ 补发")
                ) && qq.sent.some((message) => message.content.kind === "reply")
        );

        const replay = qq.sent.find(
            (message) => message.content.kind === "notice"
        );
        expect(replay?.content.text).toBe("⚠️ 补发：喝水提醒");
        expect(replay?.content.reply).toEqual({
            messageId: "d-2",
            receivedAt: expect.any(Number),
            seq: 1,
        });
        const reply = qq.sent.find(
            (message) => message.content.kind === "reply"
        );
        expect(reply?.content.reply?.seq).toBe(2);
        expect(ctx.channels.status().deferredNotices).toBe(0);
    });

    it("fails a non-retryable delivery without another attempt", async () => {
        const driver = makeDriver({ id: "fake-a" });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });

        await ctx.channels.ingress(inbound("fake-a", "e-1", "hello"));
        driver.failWith = new NonRetryableDeliveryError("permanent");
        await ctx.channels.sendReply("pong");
        await waitFor(() =>
            ctx.channels.historyAfter(0).some((item) => item.state === "failed")
        );

        expect(driver.sent).toHaveLength(0);
        expect(driver.calls).toBe(1);
    });

    it("drops a passive context and retries once as an active message", async () => {
        const driver = makeDriver({ id: "fake-a" });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });

        await ctx.channels.ingress(inbound("fake-a", "p-1", "hello"));
        driver.failOnce = new PassiveReplyExpiredError();
        await ctx.channels.sendReply("pong");
        await waitFor(() => driver.sent.length > 0);

        expect(driver.calls).toBe(2);
        expect(driver.sent[0]?.content.reply).toBeUndefined();
        const item = ctx.channels.historyAfter(0).at(-1);
        expect(item?.state).toBe("sent");
        expect(item?.replyTo).toBeNull();
    });

    it("fails outbox entries whose channel is not registered", async () => {
        const driver = makeDriver({ id: "fake-a" });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
            prepare: async (home) => {
                await mkdir(join(home, "state"), { recursive: true });
                await writeFile(
                    join(home, "state/outbox.json"),
                    JSON.stringify({
                        version: 1,
                        nextSeq: 2,
                        items: [
                            {
                                seq: 1,
                                channelId: "ghost",
                                chatId: "chat",
                                kind: "reply",
                                text: "lost",
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
            },
        });

        await waitFor(() =>
            ctx.channels
                .historyAfter(0)
                .some(
                    (item) =>
                        item.channelId === "ghost" && item.state === "failed"
                )
        );
        expect(driver.sent).toHaveLength(0);
    });

    it("truncates replies to the driver's passive slot limit", async () => {
        const driver = makeDriver({
            id: "fake-a",
            capabilities: { maxTextLength: 20, maxRepliesPerReply: 2 },
        });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });

        await ctx.channels.ingress(inbound("fake-a", "c-1", "hello"));
        await ctx.channels.sendReply("a".repeat(60));
        await waitFor(
            () =>
                driver.sent.filter(
                    (message) => message.content.kind === "reply"
                ).length >= 2
        );
        const replies = driver.sent.filter(
            (message) => message.content.kind === "reply"
        );
        expect(replies).toHaveLength(2);
        expect(replies[0]?.content.reply?.seq).toBe(1);
        expect(replies[1]?.content.reply?.seq).toBe(2);
        for (const reply of replies) {
            expect(reply.content.text.length).toBeLessThanOrEqual(20);
        }
        expect(replies[1]?.content.text.endsWith("…")).toBe(true);
    });

    it("restores the persisted active chat before routing", async () => {
        const driver = makeDriver({ id: "fake-a" });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });
        ctx.channels.restoreActiveChat({
            channelId: "fake-a",
            chatId: "restored-chat",
        });
        await ctx.channels.notify("恢复通知");
        await waitFor(() => driver.sent.length > 0);

        expect(driver.sent[0]?.chatId).toBe("restored-chat");
        expect(driver.sent[0]?.content.kind).toBe("notice");
    });

    it("attaches actions to the last formatted chunk only", async () => {
        const supported = makeDriver({
            id: "fake-a",
            capabilities: {
                maxTextLength: 12,
                outboundActions: true,
            },
        });
        const unsupported = makeDriver({ id: "fake-b" });
        const { ctx } = await setup({
            drivers: [supported, unsupported],
            defaultChannelId: "fake-a",
        });

        await ctx.channels.sendReply("hello world hello world", {
            actions: [
                {
                    id: "allow",
                    label: "允许",
                    kind: "callback",
                    payload: "a1",
                },
            ],
        });
        await waitFor(() => supported.sent.length > 1);

        const replies = supported.sent.filter(
            (message) => message.content.kind === "reply"
        );
        expect(replies.length).toBeGreaterThan(1);
        expect(
            replies.slice(0, -1).every((message) => {
                return message.content.actions === undefined;
            })
        ).toBe(true);
        expect(replies.at(-1)?.content.actions?.[0]?.id).toBe("allow");

        ctx.channels.restoreActiveChat({
            channelId: "fake-b",
            chatId: "b-chat",
        });
        await ctx.channels.sendReply("plain", {
            actions: [{ id: "x", label: "X", kind: "command", payload: "/x" }],
        });
        await waitFor(() => unsupported.sent.length > 0);
        expect(unsupported.sent[0]?.content.actions).toBeUndefined();
    });

    it("exposes channel health in the status document", async () => {
        const driver = makeDriver({
            id: "fake-a",
            health: () => ({ state: "connecting", detail: "dialing" }),
        });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });
        expect(ctx.channels.status().channels).toEqual([
            { id: "fake-a", state: "connecting", detail: "dialing" },
        ]);
    });

    it("routes inbound action metadata through the broker", async () => {
        const driver = makeDriver({ id: "fake-a" });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "fake-a",
        });

        const fallback = await ctx.channels.ingress(
            inbound("fake-a", "a-1", "允许", {
                action: { id: "button-1", payload: "allow", messageId: "m-1" },
            })
        );
        expect(fallback.accepted).toBe(true);
        // M9: action-only callbacks are accepted; the empty-text check no
        // longer applies before the action branch.
        const empty = await ctx.channels.ingress(
            inbound("fake-a", "a-2", "", {
                action: { id: "button-2" },
            })
        );
        expect(empty).toMatchObject({ accepted: true });
    });

    it("drops a notice when no chat can be addressed", async () => {
        const driver = makeDriver({
            id: "qq",
            capabilities: { activeMessages: false },
        });
        const { ctx } = await setup({
            drivers: [driver],
            defaultChannelId: "qq",
        });
        await ctx.channels.notify("无处投递");
        expect(ctx.channels.status().deferredNotices).toBe(0);
        expect(driver.sent).toHaveLength(0);
    });
});
