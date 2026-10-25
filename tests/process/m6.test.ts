import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    startDaemon,
    statusFull,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

async function waitForFile(
    path: string,
    predicate: (content: string) => boolean,
    timeoutMs = 10_000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const content = await readFile(path, "utf8");
            if (predicate(content)) return content;
        } catch {
            // not written yet
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${path}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
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

describe("M6 process scenarios", () => {
    it("sends systemd ready, watchdog, and stopping notifications", async () => {
        const home = await tempHome();
        homes.push(home);
        const script = join(home, "fake-systemd-notify.sh");
        const log = join(home, "notify.log");
        await writeFile(
            script,
            '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NOKORIBI_NOTIFY_LOG"\n',
            { mode: 0o755 }
        );
        await chmod(script, 0o755);
        const server = await startScriptedLlm({
            main: () => ({ kind: "text", text: "notify ok" }),
        });
        servers.push(server);
        const running = await startDaemon({
            home,
            token: "m6-notify",
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_SYSTEMD_NOTIFY: script,
                NOKORIBI_NOTIFY_LOG: log,
                NOTIFY_SOCKET: join(home, "notify.sock"),
                WATCHDOG_USEC: "300000",
            },
        });
        daemons.push(running);
        const ready = await waitForFile(log, (content) =>
            content.includes("--ready")
        );
        expect(ready).toContain("--ready");
        const watchdog = await waitForFile(log, (content) =>
            content.includes("WATCHDOG=1")
        );
        expect(watchdog).toContain("WATCHDOG=1");
        const exited = await running.stop();
        expect(exited).toBe(0);
        const stopping = await waitForFile(log, (content) =>
            content.includes("--stopping")
        );
        expect(stopping).toContain("--stopping");
    });

    it("uses the configured default goal round cap", async () => {
        const home = await tempHome();
        homes.push(home);
        const server = await startScriptedLlm({
            main: () => ({ kind: "text", text: "goal bootstrap" }),
        });
        servers.push(server);
        const running = await startDaemon({
            home,
            token: "m6-goal-rounds",
            mockBaseUrl: server.baseURL,
            extraEnv: {
                NOKORIBI_DEFAULT_HOST: "local:workspace",
                NOKORIBI_GOAL_DEFAULT_MAX_ROUNDS: "3",
                NOKORIBI_MEMORY_CURATOR: "false",
            },
        });
        daemons.push(running);
        await postInbound(
            running,
            "/goal new 默认轮次测试",
            "m6-goal-rounds-1"
        );
        await waitForOutbound(running, 0, 10);
        const deadline = Date.now() + 10_000;
        for (;;) {
            const full = await statusFull(running);
            const goal = full.details.goals[0] as
                | { maxGoalRounds?: number }
                | undefined;
            if (goal?.maxGoalRounds === 3) break;
            if (Date.now() > deadline) {
                throw new Error("timed out waiting for configured goal rounds");
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(fullGoalRounds(await statusFull(running))).toBe(3);
    });
});

function fullGoalRounds(full: {
    details: { goals: unknown[] };
}): number | undefined {
    const goal = full.details.goals[0] as
        | { maxGoalRounds?: number }
        | undefined;
    return goal?.maxGoalRounds;
}
