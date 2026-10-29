import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    outbound,
    postInbound,
    startDaemon,
    status,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedRequest,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

function tool(name: string, args: Record<string, unknown>): ScriptedResponse {
    return { kind: "tool-call", name, arguments: args };
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

async function sessionText(home: string): Promise<string> {
    const files = await findSessionFiles(home);
    const contents = await Promise.all(
        files.map((path) => readFile(path, "utf8"))
    );
    return contents.join("\n");
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
                `timed out waiting for outbound text ${JSON.stringify(needle)}\n` +
                    running.output()
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

describe("M11 session search process scenarios", () => {
    it("finds a prior main session through session_search after /clear", async () => {
        const sentinel = `ZEPHYR-${Math.random().toString(36).slice(2, 10)}`;
        const seenTools: string[] = [];
        const toolResultRequests: string[] = [];
        const server = await startScriptedLlm({
            main: (request, index) => {
                if (index === 0) {
                    return { kind: "text", text: "prior reply" };
                }
                if (index === 1) {
                    seenTools.push(...toolNames(request));
                    return tool("session_search", { query: sentinel });
                }
                toolResultRequests.push(requestText(request));
                return { kind: "text", text: "found the prior session" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m11-search-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: { NOKORIBI_DEFAULT_HOST: "local:workspace" },
        });
        daemons.push(running);

        await postInbound(running, `remember ${sentinel} for later`, "m11-1");
        await waitForText(running, "prior reply");
        expect((await postInbound(running, "/clear", "m11-2")).status).toBe(
            202
        );
        await waitForText(running, "已新建会话");
        await postInbound(
            running,
            "find the codeword in earlier sessions",
            "m11-3"
        );
        try {
            await waitForText(running, "found the prior session", 45);
        } catch (error) {
            const files = await findSessionFiles(home);
            const contents = await Promise.all(
                files.map((path) => readFile(path, "utf8"))
            );
            const items = await outbound(running, 0, 1);
            const current = await status(running);
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}\n` +
                    `--- requests: ${server.requests.length}\n` +
                    `--- outbox: ${JSON.stringify(items)}\n` +
                    `--- status: ${JSON.stringify(current)}\n` +
                    `--- session files: ${files.length}\n` +
                    contents.join("\n")
            );
        }

        // The new main session sees the search tools *and* the tool result from
        // the FTS index reached the model on the following request.
        expect(seenTools).toContain("session_search");
        expect(toolResultRequests.join("\n")).toContain(sentinel);
        // The dedicated derived index was created by the first search.
        await expect(
            access(join(home, "session-search.db"))
        ).resolves.toBeUndefined();
        // The prior session file is untouched source data.
        expect(await sessionText(home)).toContain(sentinel);
        expect(running.output()).not.toContain("SESSION_QUERY_TOOL_FAILED");
        expect(running.output()).not.toContain("SESSION_QUERY_SEARCH_DISABLED");
    }, 60_000);

    it("hides the session-search tools and FTS index when disabled", async () => {
        const seenTools: string[] = [];
        const server = await startScriptedLlm({
            main: (request) => {
                seenTools.push(...toolNames(request));
                return { kind: "text", text: "session search disabled ok" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m11-disabled-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_SESSION_SEARCH_ENABLED: "false",
            },
        });
        daemons.push(running);

        await postInbound(running, "search history", "m11-off-1");
        await waitForText(running, "session search disabled ok");
        expect(seenTools).not.toContain("session_search");
        expect(seenTools).not.toContain("session_event_search");
        expect(seenTools).not.toContain("session_event_read");
        // openAt=never must not create the derived index file.
        await expect(access(join(home, "session-search.db"))).rejects.toThrow();
    }, 60_000);
});
