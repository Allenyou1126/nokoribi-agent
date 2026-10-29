import { resolve } from "node:path";

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

/** Bundled read-only skills shipped by the repository (M12). */
const BUNDLED_SKILLS = resolve(REPO_ROOT, "skills");

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

describe("M12 local skills process scenarios", () => {
    it("publishes the bundled catalog and loads a skill body", async () => {
        const catalogRequests: string[] = [];
        const toolResultRequests: string[] = [];
        const server = await startScriptedLlm({
            main: (request, index) => {
                if (index === 0) {
                    catalogRequests.push(requestText(request));
                    return tool("skill", { name: "nokoribi-debug" });
                }
                toolResultRequests.push(requestText(request));
                return { kind: "text", text: "skill loaded" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m12-skill-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_BUNDLED_SKILLS: BUNDLED_SKILLS,
            },
        });
        daemons.push(running);

        const first = await postInbound(
            running,
            "load the debug skill",
            "m12-1"
        );
        expect(first.status).toBe(202);
        await waitForText(running, "skill loaded");

        // Durable catalog: model-invocable skills from the bundled root appear
        // in the first request as a user-role <available_skills> message.
        const catalog = catalogRequests.join("\n");
        expect(catalog).toContain("<available_skills>");
        expect(catalog).toContain("nokoribi-debug");
        expect(catalog).toContain("nokoribi-deploy");
        // The `skill` tool result carries the canonical <skill_content> block
        // and the real SKILL.md body.
        const loaded = toolResultRequests.join("\n");
        expect(loaded).toContain("<skill_content");
        expect(loaded).toContain("nokoribi-debug");
        expect(loaded).toContain("journalctl -u nokoribi-agent");
    }, 60_000);

    it("injects <skill_content> for a /name user invocation", async () => {
        const slashRequests: string[] = [];
        const server = await startScriptedLlm({
            main: (_request, index) => {
                if (index === 0) {
                    return { kind: "text", text: "first turn done" };
                }
                slashRequests.push(requestText(_request));
                return { kind: "text", text: "slash invocation done" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m12-slash-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_BUNDLED_SKILLS: BUNDLED_SKILLS,
            },
        });
        daemons.push(running);

        await postInbound(running, "first message", "m12-2a");
        await waitForText(running, "first turn done");
        const reply = await postInbound(
            running,
            "/nokoribi-debug hi",
            "m12-2b"
        );
        expect(reply.status).toBe(202);
        const text = await waitForText(running, "slash invocation done");
        expect(text).not.toContain("未知命令");
        // The user-explicit gesture injects the same <skill_content> rendering
        // into the step without a `skill` tool call.
        const injected = slashRequests.join("\n");
        expect(injected).toContain("<skill_content");
        expect(injected).toContain("nokoribi-debug");
    }, 60_000);

    it("hides the catalog and skill tool when skills are disabled", async () => {
        const seenTools: string[] = [];
        const requests: string[] = [];
        const server = await startScriptedLlm({
            main: (request) => {
                seenTools.push(...toolNames(request));
                requests.push(requestText(request));
                return { kind: "text", text: "skills disabled ok" };
            },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await startDaemon({
            home,
            token: `m12-off-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_BUNDLED_SKILLS: BUNDLED_SKILLS,
                NOKORIBI_SKILL_ENABLED: "false",
            },
        });
        daemons.push(running);

        await postInbound(running, "skills please", "m12-3");
        await waitForText(running, "skills disabled ok");
        expect(seenTools).not.toContain("skill");
        expect(requests.join("\n")).not.toContain("<available_skills>");
    }, 60_000);
});
