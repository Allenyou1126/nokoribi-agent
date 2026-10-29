import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    REPO_ROOT,
    cleanupHome,
    outbound,
    postInbound,
    startDaemon,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedRequest,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const FAKE_MCP = resolve(REPO_ROOT, "tests/process/support/fake-mcp.ts");

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

function tool(name: string, args: Record<string, unknown>): ScriptedResponse {
    return { kind: "tool-call", name, arguments: args };
}

/**
 * Generated overlay patch with one stdio MCP client row. This is the same shape
 * the NixOS overlay produces for `mcp.servers`, but injected through
 * NOKORIBI_PATCH so process tests need no Nix build.
 */
function mcpPatch(): string {
    return JSON.stringify([
        {
            insert: [
                {
                    id: "mcp-fake",
                    name: "@deepseek-ai/dsh-mcp-client",
                    config: {
                        serverName: "fake",
                        transport: "stdio",
                        command: process.execPath,
                        args: [FAKE_MCP],
                        env: {},
                        cwd: REPO_ROOT,
                        toolCallTimeoutMs: 10000,
                        failOnStartupError: true,
                        reconnect: {
                            enabled: false,
                            initialDelayMs: 500,
                            maxDelayMs: 1000,
                            maxAttempts: 1,
                        },
                    },
                },
            ],
        },
    ]);
}

function toolNames(request: ScriptedRequest): string[] {
    const tools = request.body["tools"];
    if (!Array.isArray(tools)) return [];
    const names: string[] = [];
    for (const entry of tools) {
        if (typeof entry !== "object" || entry === null) continue;
        const name = (entry as Record<string, unknown>)["name"];
        if (typeof name === "string") names.push(name);
    }
    return names;
}

function requestText(request: ScriptedRequest): string {
    return JSON.stringify(request.body);
}

function isReview(request: ScriptedRequest): boolean {
    return request.system?.startsWith("REVIEW_POLICY") === true;
}

async function waitForText(
    running: DaemonHandle,
    needle: string,
    timeoutSeconds = 30
): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    // `after` is exclusive: keep the last seen sequence so a long-poll that
    // starts on a stale batch can never skip a newly enqueued reply.
    let last = 0;
    for (;;) {
        const batch = await outbound(running, last, 1);
        const found = batch.items.find((item) => item.text.includes(needle));
        if (found !== undefined) return found.text;
        const newest = batch.items.at(-1);
        if (newest !== undefined) last = newest.seq;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for outbound text ${JSON.stringify(needle)}`
            );
        }
    }
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M13 MCP client process scenarios", () => {
    it("bridges a fake stdio MCP tool through Auto review", async () => {
        const seenTools: string[] = [];
        const toolResultRequests: string[] = [];
        let called = false;
        const server = await startScriptedLlm({
            main: (request) => {
                const names = toolNames(request);
                seenTools.push(...names);
                if (!called && names.includes("mcp__fake__echo")) {
                    called = true;
                    return tool("mcp__fake__echo", { text: "m13-sentinel" });
                }
                if (called) {
                    toolResultRequests.push(requestText(request));
                    return { kind: "text", text: "mcp call done" };
                }
                return { kind: "text", text: "mcp not ready" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const patchPath = join(home, "mcp.patch.yml");
        await writeFile(patchPath, mcpPatch(), "utf8");
        const running = await startDaemon({
            home,
            token: `m13-mcp-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_PATCH: patchPath,
            },
        });
        daemons.push(running);

        // The inserted mcp-client row loads after the daemon writes its ready
        // handshake (patch insert appends at the end of the Cordis tree), so
        // poll with ordinary messages until discovery published the tool
        // instead of racing the very first request.
        for (let attempt = 0; attempt < 50 && !called; attempt += 1) {
            await postInbound(
                running,
                `call the fake echo tool (${attempt})`,
                `m13-${attempt}`
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(called, running.output()).toBe(true);
        await waitForText(running, "mcp call done");

        // Discovery registered the server-qualified tool before the call.
        expect(seenTools, running.output()).toContain("mcp__fake__echo");
        // The real JSON-RPC round trip result reached the model.
        expect(toolResultRequests.join("\n")).toContain("echo:m13-sentinel");
        // MCP tools register through ctx.tools and are therefore reviewed.
        const reviews = server.requests.filter((request) => isReview(request));
        expect(reviews.length).toBeGreaterThanOrEqual(1);
        expect(reviews.map(requestText).join("\n")).toContain(
            "mcp__fake__echo"
        );
        expect(running.output()).not.toContain("MCP server connection failed");
    }, 60_000);
});
