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
import {
    LlmAdapter,
    ToolCallId,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import { SessionId } from "@deepseek-ai/dsh-session";
import ApprovalService, {
    setApprovalPolicy,
} from "@deepseek-ai/dsh-user-approval";
import UserQuestionService from "@deepseek-ai/dsh-user-questions";
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
import * as reviewer from "../../packages/reviewer/src/index.js";
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
    interactive = true;

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
        return this.interactive && this.state === "online";
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
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
};

class ScriptedAdapter extends LlmAdapter {
    private readonly counts = new Map<string, number>();

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.system?.startsWith("REVIEW_POLICY") === true) {
            yield* text(
                '{"risk":"medium","decision":"deny","reason":"child action needs a human"}'
            );
            return;
        }
        const key = options.sessionId ?? "none";
        const count = this.counts.get(key) ?? 0;
        this.counts.set(key, count + 1);
        if (count === 0) {
            yield* toolCall("probe", { value: "ok" });
            return;
        }
        yield* text("child finished");
    }
}

function text(value: string): AsyncIterable<StreamChunk> {
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

function toolCall(
    name: string,
    args: Record<string, unknown>
): AsyncIterable<StreamChunk> {
    const id = ToolCallId("probe-call-1");
    const raw = JSON.stringify(args);
    return (async function* () {
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
            type: "tool-call-delta",
            index: 0,
            id,
            name,
            argumentsDelta: raw,
        };
        yield {
            type: "block-end",
            index: 0,
            block: { type: "tool-call", id, name, arguments: raw },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
    })();
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 15000
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

interface SetupResult {
    readonly ctx: Context;
    readonly rest: FakeRest;
    readonly gateway: FakeGateway;
    readonly executed: unknown[];
    readonly child: {
        followup(message: unknown): void;
        whenIdle(): Promise<void>;
    };
    readonly sentMessage: (index: number) => SentRequest | undefined;
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
    chatId = "c2c:user-1"
): InteractionEvent {
    const userId = chatId.startsWith("c2c:")
        ? chatId.slice("c2c:".length)
        : "user-1";
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

async function setup(activeChat = "c2c:user-1"): Promise<SetupResult> {
    const home = await mkdtemp(join(tmpdir(), "nokoribi-m9-"));
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
    await ctx.plugin(ApprovalService, { policy: "ask" });
    await ctx.plugin(PermissionPresetService, {
        presets: {
            "danger-full-access": {
                sandbox: "danger-full-access",
                approval: "never",
            },
        },
        defaultPreset: "danger-full-access",
    });
    await ctx.plugin(reviewer, {
        fast: { provider: "mock", model: "review-fast" },
        strong: { provider: "mock", model: "review-strong" },
        timeoutMs: 5000,
    });
    ctx.llm.registerAdapter(["mock"], new ScriptedAdapter());

    const executed: unknown[] = [];
    ctx.tools.register({
        name: "probe",
        description: "Record one value.",
        parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
            },
            render: () => [{ type: "text", text: "ok" }],
        },
        execute: async (args: unknown) => {
            executed.push(args);
            return { ok: true };
        },
    });

    const harness = await mountAgentLoopTestHarness(ctx);
    const parent = await harness.create(
        SessionId(`main-m9-${randomUUID()}`),
        { provider: "mock", model: "main-model" },
        { cwd: workspace }
    );
    ctx.permissionPresets.set(parent.session, "auto");
    const childHandle = await ctx.agents.create({
        sessionId: SessionId(`goal-${randomUUID().slice(0, 8)}-child`),
        parentAgent: parent,
        meta: {
            origin: "subagent",
            parentSession: parent.session.id,
            cwd: workspace,
        },
        agentOptions: { provider: "mock", model: "child-model" },
    });
    const child = childHandle.agent;
    ctx.permissionPresets.set(child.session, "auto");
    setApprovalPolicy(child.session, "never");

    const rest = new FakeRest();
    const gateway = new FakeGateway();
    await ctx.plugin(ChannelService, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        trustedChannels: ["qq-bot"],
        defaultChannelId: "qq-bot",
        approvalTimeoutMs: 10000,
        questionTimeoutMs: 10000,
    });
    await ctx.channels.initialize();
    await ctx.channels.registerDriver(
        new QqBotDriver({
            config,
            rest,
            gateway,
            logger: createLogger("m9-integration", () => undefined),
        })
    );
    await ctx.channels.attachRuntime({
        agent: parent,
        commands: ctx.commands,
        mainSessionId: parent.id,
    });
    const [channel, chatId] = activeChat.split(":");
    ctx.channels.restoreActiveChat({
        channelId: "qq-bot",
        chatId: `${channel}:${chatId}`,
    });

    return {
        ctx,
        rest,
        gateway,
        executed,
        child: {
            followup: (message) => {
                child.followup(message as never);
            },
            whenIdle: () => child.whenIdle(),
        },
        sentMessage: (index) => rest.requests[index],
    };
}

function startChild(result: SetupResult): void {
    result.child.followup(
        createUserMessage({
            content: [{ type: "text", text: "run probe" }],
            source: { kind: "user" },
        })
    );
}

async function waitForPrompt(result: SetupResult): Promise<SentRequest> {
    await waitFor(() =>
        result.rest.requests.some(
            (request) => request.body.keyboard !== undefined
        )
    );
    const prompt = result.rest.requests.find(
        (request) => request.body.keyboard !== undefined
    );
    if (prompt === undefined) throw new Error("missing keyboard prompt");
    return prompt;
}

describe("M9 QQ button approval integration", () => {
    it("allows from a C2C button and rejects a later stale click", async () => {
        const result = await setup();
        startChild(result);
        const prompt = await waitForPrompt(result);
        const keyboard = keyboardOf(prompt.body);
        const allow = keyboard?.content.rows[0]?.buttons[0];
        expect(allow).toBeDefined();
        expect(
            keyboard?.content.rows[0]?.buttons.map((button) => button.id)
        ).toHaveLength(2);

        await result.gateway.emitInteraction(
            interaction(
                "interaction-allow",
                allow as { id: string; action: { data: string } }
            )
        );
        await result.child.whenIdle();
        expect(result.executed).toHaveLength(1);
        expect(result.rest.acks).toContainEqual({
            interactionId: "interaction-allow",
            code: 0,
        });

        await result.gateway.emitInteraction(
            interaction(
                "interaction-stale",
                allow as { id: string; action: { data: string } }
            )
        );
        await waitFor(() =>
            result.rest.requests.some((request) =>
                JSON.stringify(request.body).includes("按钮已失效")
            )
        );
        expect(result.executed).toHaveLength(1);
    });

    it("rejects from a C2C button without executing the tool", async () => {
        const result = await setup();
        startChild(result);
        const prompt = await waitForPrompt(result);
        const keyboard = keyboardOf(prompt.body);
        const deny = keyboard?.content.rows[0]?.buttons[1];
        expect(deny).toBeDefined();
        await result.gateway.emitInteraction(
            interaction(
                "interaction-deny",
                deny as { id: string; action: { data: string } }
            )
        );
        await result.child.whenIdle();
        expect(result.executed).toHaveLength(0);
    });

    it("keeps text approval working for C2C", async () => {
        const result = await setup();
        startChild(result);
        await waitForPrompt(result);
        const reply: InboundMessage = {
            channelId: "qq-bot",
            chatId: "c2c:user-1",
            senderId: "user-1",
            messageId: "text-approve-1",
            text: "允许",
            receivedAt: Date.now(),
        };
        await expect(result.ctx.channels.ingress(reply)).resolves.toMatchObject(
            {
                accepted: true,
            }
        );
        await result.child.whenIdle();
        expect(result.executed).toHaveLength(1);
    });

    it("keeps group approvals textual without a keyboard", async () => {
        const result = await setup("group:group-1");
        startChild(result);
        await waitFor(() =>
            result.rest.requests.some(
                (request) => request.body.keyboard === undefined
            )
        );
        const prompt = result.rest.requests.find(
            (request) => request.body.keyboard === undefined
        );
        expect(prompt).toBeDefined();
        const reply: InboundMessage = {
            channelId: "qq-bot",
            chatId: "group:group-1",
            senderId: "member-1",
            messageId: "group-approve-1",
            text: "1",
            receivedAt: Date.now(),
        };
        await expect(result.ctx.channels.ingress(reply)).resolves.toMatchObject(
            {
                accepted: true,
            }
        );
        await result.child.whenIdle();
        expect(result.executed).toHaveLength(1);
    });
});
