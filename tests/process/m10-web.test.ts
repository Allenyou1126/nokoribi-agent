import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    outbound,
    postInbound,
    startDaemon,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";
import {
    startFakeWebSearch,
    type FakeSearchServer,
} from "./support/fake-web-search.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];
const searches: FakeSearchServer[] = [];

function tool(name: string, args: Record<string, unknown>): ScriptedResponse {
    return { kind: "tool-call", name, arguments: args };
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
    after: number,
    needle: string,
    timeoutSeconds = 30
): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let seq = after;
    for (;;) {
        const batch = await outbound(running, seq, 1);
        seq = batch.nextSeq;
        const found = batch.items.find((item) => item.text.includes(needle));
        if (found !== undefined) return found.text;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for outbound text ${JSON.stringify(needle)}`
            );
        }
    }
}

function reviewCount(server: ScriptedLlmServer): number {
    return server.requests.filter(
        (request) => request.system?.startsWith("REVIEW_POLICY") === true
    ).length;
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(searches.splice(0).map((server) => server.close()));
});

describe("M10 web process scenarios", () => {
    it("runs web tools without reviewer calls and keeps bash reviewed", async () => {
        const search = await startFakeWebSearch();
        searches.push(search);
        const server = await startScriptedLlm({
            main: (_request, index) => {
                if (index === 0) {
                    return tool("web_search", { queries: ["nokoribi m10"] });
                }
                if (index === 1) {
                    return tool("web_fetch", {
                        url: "http://127.0.0.1:9/",
                    });
                }
                if (index === 2) {
                    return tool("bash", {
                        command: "printf 'web-ok\\n'",
                        description: "Print a web marker",
                    });
                }
                return { kind: "text", text: "web done" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m10-web-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                DEEPSEEK_SEARCH_BASE_URL: search.baseURL,
            },
        });
        daemons.push(running);
        await postInbound(running, "search the web", "m10-web-1");
        await waitForText(running, 0, "web done");
        const text = await sessionText(home);
        expect(text).toContain("https://example.test/m10");
        expect(text).toContain("non-public");
        expect(text).toContain("web-ok");
        expect(search.requests).toHaveLength(1);
        expect(reviewCount(server)).toBe(1);
        expect(running.output()).not.toContain("web search failed");
    });

    it("restores reviewing for web tools when the exempt list is empty", async () => {
        const search = await startFakeWebSearch();
        searches.push(search);
        const server = await startScriptedLlm({
            main: (_request, index) =>
                index === 0
                    ? tool("web_search", { queries: ["reviewed"] })
                    : { kind: "text", text: "reviewed web done" },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m10-web-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_REVIEW_EXEMPT_TOOLS: "",
                DEEPSEEK_SEARCH_BASE_URL: search.baseURL,
            },
        });
        daemons.push(running);
        await postInbound(running, "search reviewed", "m10-web-2");
        await waitForText(running, 0, "reviewed web done");
        expect(reviewCount(server)).toBe(1);
        expect(search.requests).toHaveLength(1);
    });
});
