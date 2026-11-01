import {
    startMockLlmServer,
    type MockLlmServer,
} from "@deepseek-ai/dsh-llm-mock-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    cleanupHome,
    startDaemon,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import { FakeQqBot } from "./support/fake-qq-bot.js";

let mock: MockLlmServer;

beforeAll(async () => {
    mock = await startMockLlmServer({
        host: "127.0.0.1",
        port: 0,
        sequence: ["success"],
        repeatLast: true,
        successText: "pong from mock",
    });
});

afterAll(async () => {
    await mock.close();
});

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const fakes: FakeQqBot[] = [];

async function daemon(
    extraEnv: Record<string, string> = {}
): Promise<{ running: DaemonHandle; fake: FakeQqBot }> {
    const fake = await FakeQqBot.start({ heartbeatMs: 200 });
    fakes.push(fake);
    const home = await tempHome();
    homes.push(home);
    const running = await startDaemon({
        home,
        token: `tok-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: mock.baseURL,
        extraEnv: {
            NOKORIBI_QQ_BOT_ENABLED: "true",
            NOKORIBI_QQ_BOT_APP_ID: "app-1",
            NOKORIBI_QQ_BOT_CLIENT_SECRET: "qq-secret",
            NOKORIBI_QQ_BOT_API_BASE: fake.apiUrl,
            NOKORIBI_QQ_BOT_TOKEN_BASE: fake.apiUrl,
            NOKORIBI_QQ_BOT_GATEWAY_URL: fake.wsUrl,
            NOKORIBI_QQ_BOT_REQUEST_TIMEOUT_MS: "2000",
            NOKORIBI_QQ_BOT_CONNECT_TIMEOUT_MS: "3000",
            NOKORIBI_QQ_BOT_RECONNECT_BASE_MS: "50",
            NOKORIBI_QQ_BOT_RECONNECT_MAX_MS: "100",
            NOKORIBI_QQ_BOT_MAX_REPLIES: "4",
            ...extraEnv,
        },
    });
    daemons.push(running);
    await fake.waitForIdentify();
    return { running, fake };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(
        fakes.splice(0).map(async (fake) => {
            await fake.close().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

describe("M18 QQ command panel process scenarios", () => {
    it("publishes every registered slash command to the C2C panel once", async () => {
        const { fake } = await daemon();
        await fake.waitForPanels(1);
        expect(fake.panels).toHaveLength(1);
        const panel = fake.panels[0];
        expect(panel?.scope).toBe("c2c");
        expect(panel?.target_type).toBe("all");
        expect(panel?.panel.remark).toBe("nokoribi-agent:slash-commands");
        const items = panel?.panel.items ?? [];
        const names = items.map((item) => item.name);
        for (const name of [
            "/stop",
            "/status",
            "/goal",
            "/clear",
            "/new",
            "/permission",
            "/steer",
            "/queue",
        ]) {
            expect(names).toContain(name);
        }
        expect(items.length).toBeLessThanOrEqual(20);
        for (const item of items) {
            expect(item.type).toBe("command");
            expect(Array.from(item.name).length).toBeLessThanOrEqual(14);
            expect(Array.from(item.desc).length).toBeLessThanOrEqual(30);
            expect(item.desc).toMatch(/[\u4e00-\u9fff]/);
        }
        const statusItem = items.find((item) => item.name === "/status");
        expect(statusItem?.desc).toContain("full");
        const panelRequests = fake.httpRequests.filter((request) =>
            request.path.startsWith("/v2/panels")
        );
        expect(panelRequests.length).toBeGreaterThanOrEqual(2);
        expect(
            panelRequests.some((request) =>
                request.path.includes("scope=group")
            )
        ).toBe(false);
    });

    it("does not touch the command panel when disabled", async () => {
        const { fake } = await daemon({
            NOKORIBI_QQ_BOT_COMMAND_PANEL: "false",
        });
        await delay(300);
        const panelRequests = fake.httpRequests.filter((request) =>
            request.path.startsWith("/v2/panels")
        );
        expect(panelRequests).toHaveLength(0);
        expect(fake.panels).toHaveLength(0);
    });
});
