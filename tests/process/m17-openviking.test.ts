import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    startDaemon,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import {
    startFakeOpenViking,
    type FakeOpenVikingServer,
} from "./support/fake-openviking.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedRequest,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const plugins: ScriptedLlmServer[] = [];
const servers: FakeOpenVikingServer[] = [];

function toolNames(request: ScriptedRequest): readonly string[] {
    const tools = request.body.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => {
        if (typeof tool !== "object" || tool === null) return "";
        const record = tool as Record<string, unknown>;
        const nested = record.function;
        if (typeof nested === "object" && nested !== null) {
            return String((nested as Record<string, unknown>).name ?? "");
        }
        return String(record.name ?? "");
    });
}

function bodyText(request: ScriptedRequest): string {
    return JSON.stringify(request.body);
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(plugins.splice(0).map((server) => server.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M17 OpenViking optional memory backend", () => {
    it("boots without a reachable server and disables local memory", async () => {
        const home = await tempHome();
        homes.push(home);
        const plugin = await startScriptedLlm({
            main: () => ({ kind: "text", text: "M17-NO-SERVER-OK" }),
        });
        plugins.push(plugin);
        const daemon = await startDaemon({
            home,
            token: "m17-token",
            mockBaseUrl: plugin.baseURL,
            extraEnv: {
                NOKORIBI_OPENVIKING_ENABLED: "true",
                NOKORIBI_OPENVIKING_ENDPOINT: "http://127.0.0.1:9",
                NOKORIBI_OPENVIKING_API_KEY_ENV: "NOKORIBI_TEST_OV_KEY",
                NOKORIBI_TEST_OV_KEY: "fake-key",
                OPENVIKING_STATE_DIR: join(home, "openviking-state"),
                OPENVIKING_TIMEOUT_MS: "1500",
                OPENVIKING_RECALL_TIMEOUT_MS: "1500",
            },
        });
        daemons.push(daemon);
        const inbound = await postInbound(daemon, "hello m17", "m17-no-server");
        expect([200, 202]).toContain(inbound.status);
        const batch = await waitForOutbound(daemon, 0, 20);
        expect(batch.items.map((item) => item.text).join("\n")).toContain(
            "M17-NO-SERVER-OK"
        );
        expect(daemon.output()).not.toContain("daemon startup failed");
        const first = plugin.requests[0];
        expect(first).toBeDefined();
        if (first === undefined) return;
        // Local memory (tool/storage/snapshot) must not mount while OpenViking
        // owns memory (D175 mutual exclusion).
        expect(toolNames(first)).not.toContain("memory");
    }, 60_000);

    it("serves recall from a fake server and captures the turn", async () => {
        const home = await tempHome();
        homes.push(home);
        const fake = await startFakeOpenViking();
        servers.push(fake);
        const plugin = await startScriptedLlm({
            main: () => ({ kind: "text", text: "M17-SERVER-OK" }),
        });
        plugins.push(plugin);
        const daemon = await startDaemon({
            home,
            token: "m17-token",
            mockBaseUrl: plugin.baseURL,
            extraEnv: {
                NOKORIBI_OPENVIKING_ENABLED: "true",
                NOKORIBI_OPENVIKING_ENDPOINT: fake.baseURL,
                NOKORIBI_OPENVIKING_PEER_ID: "test-peer",
                OPENVIKING_STATE_DIR: join(home, "openviking-state"),
                OPENVIKING_TIMEOUT_MS: "5000",
            },
        });
        daemons.push(daemon);

        await postInbound(daemon, "what do you remember m17", "m17-server");
        const batch = await waitForOutbound(daemon, 0, 20);
        expect(batch.items.map((item) => item.text).join("\n")).toContain(
            "M17-SERVER-OK"
        );

        const paths = fake.requests.map((request) => request.path);
        expect(paths).toContain("/health");
        expect(paths).toContain("/api/v1/search/search");
        expect(
            fake.requests.some((request) =>
                /^\/api\/v1\/sessions\/[^/]+\/messages$/.test(request.path)
            )
        ).toBe(true);
        expect(
            plugin.requests.some((request) =>
                bodyText(request).includes("FAKE-VIKING-RECALL")
            )
        ).toBe(true);
        const first = plugin.requests[0];
        expect(first).toBeDefined();
        if (first === undefined) return;
        expect(toolNames(first)).not.toContain("memory");
    }, 60_000);
});
