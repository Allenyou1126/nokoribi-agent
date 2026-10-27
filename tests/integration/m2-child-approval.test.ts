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
import { afterEach, describe, expect, it, vi } from "vitest";

import ChannelService, {
    type ChannelDriver,
    type InboundMessage,
    type OutboundContent,
} from "../../packages/channel-core/src/index.js";
import * as reviewer from "../../packages/reviewer/src/index.js";

const REVIEW_POLICY_PREFIX = "REVIEW_POLICY";

interface SentMessage {
    readonly chatId: string;
    readonly text: string;
}

class FakeDriver implements ChannelDriver {
    readonly id = "fake";
    readonly capabilities = {
        markdown: "none" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
    };
    readonly sent: SentMessage[] = [];

    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(
        chatId: string,
        content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        this.sent.push({ chatId, text: content.text });
        return {
            channelId: this.id,
            chatId,
            messageId: `sent-${this.sent.length}`,
        };
    }
}

class ScriptedAdapter extends LlmAdapter {
    readonly reviews: string[] = [];
    readonly mainRequests: string[] = [];
    private readonly counts = new Map<string, number>();

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.system?.startsWith(REVIEW_POLICY_PREFIX) === true) {
            this.reviews.push(options.model);
            yield* text(
                '{"risk":"medium","decision":"deny","reason":"child action needs a human"}'
            );
            return;
        }
        const key = options.sessionId ?? "none";
        const count = this.counts.get(key) ?? 0;
        this.counts.set(key, count + 1);
        this.mainRequests.push(key);
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
    timeoutMs = 10_000
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

describe("M2 child approval bridge", () => {
    it("escalates a goal child denial through channel-core", async () => {
        const home = await mkdtemp(join(tmpdir(), "nokoribi-child-"));
        vi.stubEnv("DSH_HOME", home);
        const workspace = join(home, "workspace");
        const ctx = new Context();
        cleanups.push(async () => {
            await ctx.dispose();
            vi.unstubAllEnvs();
            await rm(home, { recursive: true, force: true });
        });

        await mountAgentLoopTestDependencies(ctx, {
            workingDirectory: true,
        });
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
            timeoutMs: 5_000,
        });
        const adapter = new ScriptedAdapter();
        ctx.llm.registerAdapter(["mock"], adapter);

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
            SessionId("main-child-test"),
            { provider: "mock", model: "main-model" },
            { cwd: workspace }
        );
        ctx.permissionPresets.set(parent.session, "auto");

        const childHandle = await ctx.agents.create({
            sessionId: SessionId("goal-a1b2c3d4-child"),
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

        const driver = new FakeDriver();
        await ctx.plugin(ChannelService, {
            allowedSenders: ["local-user"],
            allowedChats: ["local"],
            defaultChatId: "local",
            approvalTimeoutMs: 10_000,
            questionTimeoutMs: 10_000,
        });
        await ctx.channels.initialize();
        await ctx.channels.registerDriver(driver);
        await ctx.channels.attachRuntime({
            agent: parent,
            commands: ctx.commands,
            mainSessionId: parent.id,
        });

        child.followup(
            createUserMessage({
                content: [{ type: "text", text: "run probe" }],
                source: { kind: "user" },
            })
        );

        await waitFor(() =>
            driver.sent.some((message) => message.text.includes("🔐"))
        );
        const prompt = driver.sent.find((message) =>
            message.text.includes("🔐")
        );
        expect(prompt?.text).toContain("goal a1b2c3d4");
        expect(prompt?.text).toContain("工具：probe");
        expect(ctx.channels.status().pendingInteractions).toBe(1);

        const reply: InboundMessage = {
            channelId: "fake",
            chatId: "local",
            senderId: "local-user",
            messageId: "reply-1",
            text: "允许",
            receivedAt: Date.now(),
        };
        await expect(ctx.channels.ingress(reply)).resolves.toMatchObject({
            accepted: true,
        });
        await child.whenIdle();

        expect(executed).toEqual([{ value: "ok" }]);
        expect(ctx.approval.overrideOf(child.session)).toBe("ask");
        expect(adapter.reviews).toEqual(["review-fast", "review-strong"]);
        expect(ctx.channels.status().pendingInteractions).toBe(0);
        const asked = child.session
            .snapshotEvents()
            .some((event) => event.type === "approval/asked");
        expect(asked).toBe(true);
    });
});
