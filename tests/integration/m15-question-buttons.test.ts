import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type {
    ChatScope,
    InteractionEvent,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChannelService, {
    type ChannelHealth,
    type InboundMessage,
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
    readonly scope: ChatScope;
    readonly targetId: string;
    readonly body: Record<string, unknown>;
}

class FakeRest implements QqRestClient {
    readonly requests: SentRequest[] = [];
    readonly acks: { interactionId: string; code: 0 | 1 }[] = [];

    async send(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse> {
        this.requests.push({ scope, targetId, body });
        return { id: `sent-${String(this.requests.length)}`, timestamp: 0 };
    }

    async ackInteraction(interactionId: string, code: 0 | 1): Promise<void> {
        this.acks.push({ interactionId, code });
    }

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

    async emitInteraction(event: InteractionEvent): Promise<void> {
        await this.handlers?.onInteraction(event);
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
    questionButtons: true,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
};

function fakeAgent(): Agent {
    return {
        id: "main-m15",
        status: "idle",
        session: { header: {}, snapshotEvents: () => [] },
        steer: vi.fn(),
        followup: vi.fn(),
        cancel: vi.fn(),
    } as unknown as Agent;
}

interface SetupResult {
    readonly ctx: Context;
    readonly rest: FakeRest;
    readonly gateway: FakeGateway;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch(() => undefined);
    }
});

async function setup(chatId = "c2c:user-1"): Promise<SetupResult> {
    const home = await mkdtemp(join(tmpdir(), "nokoribi-m15-"));
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
    ctx.provide("attachments", {
        saveImages: async () => [],
        saveFile: async () => ({ attachmentId: "", name: "", bytes: 0 }),
        readFileStream: async function* () {},
    });
    const rest = new FakeRest();
    const gateway = new FakeGateway();
    await ctx.plugin(ChannelService as unknown as Plugin, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        trustedChannels: ["qq-bot"],
        defaultChannelId: "qq-bot",
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
    });
    await ctx.channels.initialize();
    await ctx.channels.registerDriver(
        new QqBotDriver({
            config,
            rest,
            gateway,
            logger: createLogger("m15-integration", () => undefined),
        })
    );
    await ctx.channels.attachRuntime({
        agent: fakeAgent(),
        commands: ctx.commands,
        mainSessionId: "main-m15",
    });
    ctx.channels.restoreActiveChat({ channelId: "qq-bot", chatId });
    return { ctx, rest, gateway };
}

function questionRequest(): AskUserQuestionRequest {
    return {
        agent: fakeAgent(),
        questions: [
            {
                id: "q1",
                question: "Which option?",
                options: [{ label: "Alpha" }, { label: "Beta" }],
            },
        ],
    } as AskUserQuestionRequest;
}

function ask(ctx: Context): Promise<{ readonly answers: readonly unknown[] }> {
    return ctx.waterfall(
        "user-questions/request",
        questionRequest(),
        () => Promise.resolve({ answers: [] }) as never
    ) as Promise<{ readonly answers: readonly unknown[] }>;
}

function keyboardOf(body: Record<string, unknown> | undefined):
    | {
          content: {
              rows: { buttons: { id: string; action: { data: string } }[] }[];
          };
      }
    | undefined {
    const keyboard = body?.keyboard;
    if (typeof keyboard !== "object" || keyboard === null) return undefined;
    return keyboard as {
        content: {
            rows: { buttons: { id: string; action: { data: string } }[] }[];
        };
    };
}

function interaction(
    id: string,
    button: { id: string; action: { data: string } },
    userId = "user-1"
): InteractionEvent {
    return {
        id,
        type: 11,
        scene: "c2c",
        chat_type: 2,
        timestamp: new Date().toISOString(),
        user_openid: userId,
        version: 1,
        data: {
            type: 11,
            resolved: {
                button_data: button.action.data,
                button_id: button.id,
            },
        },
    };
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 10_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("M15 QQ question button integration", () => {
    it("settles a question from a C2C keyboard click", async () => {
        const result = await setup();
        const pending = ask(result.ctx);
        await waitFor(() =>
            result.rest.requests.some(
                (request) => request.body.keyboard !== undefined
            )
        );
        const prompt = result.rest.requests.find(
            (request) => request.body.keyboard !== undefined
        );
        expect(prompt?.body.msg_type).toBe(2);
        const buttons =
            keyboardOf(prompt?.body)?.content.rows[0]?.buttons ?? [];
        expect(buttons.map((button) => button.id)).toHaveLength(2);
        const beta = buttons[1];
        expect(beta).toBeDefined();
        await result.gateway.emitInteraction(
            interaction(
                "interaction-question-1",
                beta as { id: string; action: { data: string } }
            )
        );
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: ["Beta"] }],
        });
        // QQ ack happens before the click reaches channel core (M9 semantics).
        expect(result.rest.acks).toEqual([
            { interactionId: "interaction-question-1", code: 0 },
        ]);
    });

    it("falls back to numbered text replies without a keyboard config", async () => {
        const result = await setup();
        const pending = ask(result.ctx);
        await waitFor(() =>
            result.rest.requests.some(
                (request) => request.body.keyboard !== undefined
            )
        );
        const reply: InboundMessage = {
            channelId: "qq-bot",
            chatId: "c2c:user-1",
            senderId: "user-1",
            messageId: "text-answer-1",
            text: "1",
            receivedAt: Date.now(),
        };
        await expect(result.ctx.channels.ingress(reply)).resolves.toMatchObject(
            { accepted: true }
        );
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: ["Alpha"] }],
        });
    });

    it("keeps group question prompts textual", async () => {
        const result = await setup("group:group-1");
        const pending = ask(result.ctx);
        await waitFor(() =>
            result.rest.requests.some(
                (request) => request.body.keyboard === undefined
            )
        );
        const prompt = result.rest.requests.find(
            (request) => request.body.keyboard === undefined
        );
        expect(prompt?.scope).toBe("group");
        await expect(
            result.ctx.channels.ingress({
                channelId: "qq-bot",
                chatId: "group:group-1",
                senderId: "member-1",
                messageId: "group-answer-1",
                text: "2",
                receivedAt: Date.now(),
            })
        ).resolves.toMatchObject({ accepted: true });
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: ["Beta"] }],
        });
    });
});
