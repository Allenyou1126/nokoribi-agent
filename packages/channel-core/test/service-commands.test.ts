import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    ChannelCommand,
    ChannelDriver,
    OutboundContent,
} from "../src/contract.js";
import ChannelService from "../src/service.js";

class RecordingDriver implements ChannelDriver {
    readonly id = "recording";
    readonly capabilities = {
        markdown: "none" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
    };
    readonly catalogs: (readonly ChannelCommand[])[] = [];

    async start(): Promise<void> {}
    async stop(): Promise<void> {}

    async send(
        chatId: string,
        _content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        return { channelId: this.id, chatId, messageId: "sent-1" };
    }

    syncCommands(commands: readonly ChannelCommand[]): void {
        this.catalogs.push(commands);
    }
}

class PlainDriver implements ChannelDriver {
    readonly id = "plain";
    readonly capabilities = {
        markdown: "none" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
    };

    async start(): Promise<void> {}
    async stop(): Promise<void> {}

    async send(
        chatId: string,
        _content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        return { channelId: this.id, chatId, messageId: "sent-1" };
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
        dirs.splice(0).map((dir) =>
            rm(dir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 10,
            })
        )
    );
});

interface SetupResult {
    readonly ctx: Context;
    readonly agent: Agent;
    readonly list: ReturnType<typeof vi.fn>;
}

async function setup(
    driver: ChannelDriver,
    catalog: readonly ChannelCommand[]
): Promise<SetupResult> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-service-commands-"));
    dirs.push(dir);
    vi.stubEnv("DSH_HOME", dir);
    const ctx = new Context();
    contexts.push(ctx);
    ctx.provide("agents", {});
    const list = vi.fn(() => catalog);
    ctx.provide("commands", {
        register: () => () => undefined,
        execute: async () => undefined,
        list,
    });
    ctx.provide("approval", {});
    ctx.provide("userQuestions", {});
    ctx.provide("attachments", {
        saveImages: async () => [],
        saveFile: async () => ({ attachmentId: "", name: "", bytes: 0 }),
        readFileStream: async function* () {},
    });
    const agent = fakeAgent();
    await ctx.plugin(ChannelService as unknown as Plugin, {
        allowedSenders: ["local-user"],
        allowedChats: ["local"],
        defaultChatId: "local",
        trustedChannels: [driver.id],
        defaultChannelId: driver.id,
        approvalTimeoutMs: 10_000,
        questionTimeoutMs: 10_000,
    });
    await ctx.channels.registerDriver(driver);
    await ctx.channels.initialize();
    return { ctx, agent, list };
}

describe("channel core command catalog publishing", () => {
    it("publishes the main agent's effective commands after attach", async () => {
        const driver = new RecordingDriver();
        const { ctx, agent } = await setup(driver, [
            { name: "stop", description: "Stop the current turn" },
            { name: "status", description: "Show status" },
        ]);
        await ctx.channels.attachRuntime({
            agent,
            commands: ctx.commands,
            mainSessionId: "main-1",
        });
        expect(driver.catalogs).toHaveLength(1);
        expect(driver.catalogs[0]).toEqual([
            { name: "stop", description: "Stop the current turn" },
            { name: "status", description: "Show status" },
        ]);
    });

    it("republishes when the command registry changes", async () => {
        const driver = new RecordingDriver();
        const { ctx, agent } = await setup(driver, [
            { name: "stop", description: "Stop the current turn" },
        ]);
        await ctx.channels.attachRuntime({
            agent,
            commands: ctx.commands,
            mainSessionId: "main-1",
        });
        expect(driver.catalogs).toHaveLength(1);
        ctx.emit("commands/change");
        expect(driver.catalogs.length).toBeGreaterThanOrEqual(2);
        expect(driver.catalogs.at(-1)).toEqual([
            { name: "stop", description: "Stop the current turn" },
        ]);
    });

    it("does not read the catalog when no driver can publish", async () => {
        const driver = new PlainDriver();
        const { ctx, agent, list } = await setup(driver, [
            { name: "stop", description: "Stop the current turn" },
        ]);
        await ctx.channels.attachRuntime({
            agent,
            commands: ctx.commands,
            mainSessionId: "main-1",
        });
        expect(list).not.toHaveBeenCalled();
    });
});
