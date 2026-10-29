import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
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
    readonly capabilities = {
        markdown: "none" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
        outboundActions: true,
        inboundActions: true,
        activeMessages: true,
    };
    readonly sent: SentMessage[] = [];

    async start(): Promise<void> {}
    async stop(): Promise<void> {}

    async send(
        chatId: string,
        content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        this.sent.push({ chatId, content });
        return {
            channelId: this.id,
            chatId,
            messageId: `sent-${String(this.sent.length)}`,
        };
    }
}

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

function approval(agent: Agent): ApprovalRequest {
    return {
        agent,
        toolName: "probe",
        reason: "test approval",
    } as ApprovalRequest;
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
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

async function setup(): Promise<{
    ctx: Context;
    agent: Agent;
    driver: FakeDriver;
}> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-service-action-"));
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
    const agent = fakeAgent();
    const driver = new FakeDriver();
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
    return { ctx, agent, driver };
}

function actionMessage(
    messageId: string,
    action: { id: string; payload?: string },
    text?: string
): InboundMessage {
    return {
        channelId: "fake",
        chatId: "local",
        senderId: "local-user",
        messageId,
        receivedAt: Date.now(),
        ...(text === undefined ? {} : { text }),
        action,
    };
}

describe("channel service approval actions", () => {
    it("routes an action-only callback to the broker before the empty check", async () => {
        const { ctx, agent, driver } = await setup();
        const pending = ctx.waterfall("approval/request", approval(agent), () =>
            Promise.resolve("unavailable")
        );
        await waitFor(() => driver.sent.length > 0);
        const actions = driver.sent[0]?.content.actions;
        expect(actions).toHaveLength(2);
        const allow = actions?.find((action) => action.label === "允许一次");
        expect(allow).toBeDefined();
        await expect(
            ctx.channels.ingress(
                actionMessage("action-1", {
                    id: allow?.id ?? "",
                    ...(allow?.payload === undefined
                        ? {}
                        : { payload: allow.payload }),
                })
            )
        ).resolves.toMatchObject({ accepted: true });
        await expect(pending).resolves.toBe("allowed-once");
        expect(ctx.channels.status().pendingInteractions).toBe(0);
        expect(agent.steer).not.toHaveBeenCalled();
    });

    it("keeps the approval pending and warns once for an unknown action", async () => {
        const { ctx, agent, driver } = await setup();
        const pending = ctx.waterfall("approval/request", approval(agent), () =>
            Promise.resolve("unavailable")
        );
        await waitFor(() => driver.sent.length > 0);
        const prompt = driver.sent[0];
        expect(prompt).toBeDefined();
        await expect(
            ctx.channels.ingress(
                actionMessage(
                    "action-2",
                    {
                        id: "stale-token",
                        payload: JSON.stringify({ t: "允许" }),
                    },
                    "允许"
                )
            )
        ).resolves.toMatchObject({ accepted: true });
        expect(ctx.channels.status().pendingInteractions).toBe(1);
        await waitFor(() =>
            driver.sent.some((message) =>
                message.content.text.includes("按钮已失效")
            )
        );
        expect(agent.steer).not.toHaveBeenCalled();

        await ctx.channels.ingress({
            channelId: "fake",
            chatId: "local",
            senderId: "local-user",
            messageId: "text-1",
            receivedAt: Date.now(),
            text: "允许",
        });
        await expect(pending).resolves.toBe("allowed-once");
        expect(ctx.channels.status().pendingInteractions).toBe(0);
    });
});
