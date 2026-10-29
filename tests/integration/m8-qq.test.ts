import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import type {
    InboundMessage as SdkInboundMessage,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChannelService, {
    type ChannelHealth,
} from "../../packages/channel-core/src/index.js";
import type { QqBotConfig } from "../../packages/channel-qq-bot/src/config.js";
import { QqBotDriver } from "../../packages/channel-qq-bot/src/driver.js";
import type {
    QqGatewayClient,
    QqGatewayHandlers,
    QqRestClient,
} from "../../packages/channel-qq-bot/src/transport.js";
import { createLogger } from "../../packages/shared/src/log.js";

interface SentRequest {
    readonly scope: "c2c" | "group";
    readonly targetId: string;
    readonly body: Record<string, unknown>;
}

class FakeRest implements QqRestClient {
    readonly requests: SentRequest[] = [];

    async send(
        scope: "c2c" | "group",
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse> {
        this.requests.push({ scope, targetId, body });
        return { id: `sent-${String(this.requests.length)}`, timestamp: 0 };
    }

    async ackInteraction(): Promise<void> {}

    async getGatewayUrl(): Promise<string> {
        return "ws://127.0.0.1/websocket";
    }

    async getAccessToken(): Promise<string> {
        return "token";
    }

    clearTokenCache(): void {}

    stop(): void {}
}

class FakeGateway implements QqGatewayClient {
    handlers: QqGatewayHandlers | undefined;
    state: ChannelHealth["state"] = "online";

    async start(handlers: QqGatewayHandlers): Promise<void> {
        this.handlers = handlers;
    }

    async stop(): Promise<void> {
        this.state = "offline";
    }

    health(): ChannelHealth {
        return { state: this.state };
    }

    interactionAvailable(): boolean {
        return this.state === "online";
    }
}

const config: QqBotConfig = {
    enabled: true,
    appId: "app",
    clientSecretEnv: "SECRET",
    markdown: "basic",
    maxTextLength: 4500,
    maxRepliesPerReply: 4,
    c2cReplyWindowSeconds: 3600,
    groupReplyWindowSeconds: 300,
    requestTimeoutMs: 1000,
    connectTimeoutMs: 1000,
    activeMessageFallback: "auto",
    approvalButtons: true,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
};

class TextAdapter extends LlmAdapter {
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "pong" };
        yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: "pong" },
        };
        yield { type: "finish", reason: { kind: "stop" } };
    }
}

function sdkMessage(
    overrides: Partial<SdkInboundMessage> = {}
): SdkInboundMessage {
    return {
        rawEventType: "C2C_MESSAGE_CREATE",
        kind: "c2c",
        senderId: "user-1",
        content: "hello",
        messageId: "m-1",
        timestamp: new Date().toISOString(),
        raw: {} as SdkInboundMessage["raw"],
        ...overrides,
    };
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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch(() => undefined);
    }
});

async function setup(
    options: {
        readonly activeMessageFallback?: "auto" | "off";
    } = {}
): Promise<{
    ctx: Context;
    rest: FakeRest;
    gateway: FakeGateway;
}> {
    const home = await mkdtemp(join(tmpdir(), "nokoribi-m8-"));
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
    ctx.llm.registerAdapter(["mock"], new TextAdapter());
    const harness = await mountAgentLoopTestHarness(ctx);
    const parent = await harness.create(
        SessionId(`main-m8-${randomUUID()}`),
        { provider: "mock", model: "main-model" },
        { cwd: workspace }
    );

    await ctx.plugin(ChannelService, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        trustedChannels: ["qq-bot"],
        defaultChannelId: "qq-bot",
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
    });
    const rest = new FakeRest();
    const gateway = new FakeGateway();
    await ctx.channels.registerDriver(
        new QqBotDriver({
            config: {
                ...config,
                activeMessageFallback: options.activeMessageFallback ?? "auto",
            },
            rest,
            gateway,
            logger: createLogger("m8-integration", () => undefined),
        })
    );
    await ctx.channels.initialize();
    await ctx.channels.attachRuntime({
        agent: parent,
        commands: ctx.commands,
        mainSessionId: parent.id,
    });
    return { ctx, rest, gateway };
}

describe("M8 QQ driver integration", () => {
    it("accepts a trusted QQ chat and sends a passive reply", async () => {
        const { ctx, rest, gateway } = await setup();
        gateway.handlers?.onInbound(sdkMessage());
        await waitFor(() => ctx.channels.activeChat?.chatId === "c2c:user-1");
        await ctx.channels.sendReply("pong");
        await waitFor(() => rest.requests.length > 0);
        expect(rest.requests[0]).toMatchObject({
            scope: "c2c",
            targetId: "user-1",
            body: {
                msg_id: "m-1",
                msg_seq: 1,
                markdown: { content: "pong" },
            },
        });
    });

    it("defers notices when active messages are disabled and replays them", async () => {
        const { ctx, rest, gateway } = await setup({
            activeMessageFallback: "off",
        });
        gateway.handlers?.onInbound(sdkMessage());
        await waitFor(() => ctx.channels.activeChat?.chatId === "c2c:user-1");
        await ctx.channels.notify("喝水提醒");
        expect(ctx.channels.status().deferredNotices).toBe(1);

        gateway.handlers?.onInbound(
            sdkMessage({ messageId: "m-2", content: "wake" })
        );
        await waitFor(() => ctx.channels.activeChat?.chatId === "c2c:user-1");
        await ctx.channels.sendReply("answer");
        await waitFor(() =>
            rest.requests.some((request) =>
                JSON.stringify(request.body).includes("补发")
            )
        );
        expect(ctx.channels.status().deferredNotices).toBe(0);
    });
});
