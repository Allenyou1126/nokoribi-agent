import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
    startMockLlmServer,
    type MockLlmServer,
} from "@deepseek-ai/dsh-llm-mock-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    appendPendingOutbox,
    cleanupHome,
    postInbound,
    readState,
    startDaemon,
    status,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";

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

async function daemon(
    token = `tok-${Math.random().toString(36).slice(2)}`
): Promise<DaemonHandle> {
    const home = await tempHome();
    homes.push(home);
    const handle = await startDaemon({
        home,
        token,
        mockBaseUrl: mock.baseURL,
    });
    daemons.push(handle);
    return handle;
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

describe("M1 process scenarios", () => {
    it("answers a message, dedupes it, and serves status", async () => {
        const running = await daemon();
        expect((await postInbound(running, "hello", "m-1")).status).toBe(202);
        const first = await waitForOutbound(running, 0);
        expect(first.items[0]).toMatchObject({
            kind: "reply",
            text: "pong from mock",
        });
        const lastSeq = first.items[first.items.length - 1]?.seq ?? 0;

        expect((await postInbound(running, "hello", "m-1")).status).toBe(202);
        const duplicate = await waitForOutbound(running, lastSeq, 1).catch(
            () => ({ items: [], nextSeq: lastSeq + 1 })
        );
        expect(duplicate.items).toEqual([]);

        const current = await status(running);
        expect(current.ready).toBe(true);
        expect(current.mainSessionId).toMatch(/^main-/);
        expect(current.agentStatus).toBe("idle");
        const { access } = await import("node:fs/promises");
        await expect(
            access(join(running.home, "AGENTS.md"))
        ).resolves.toBeUndefined();
        await expect(
            access(join(running.home, "workspace/AGENTS.md"))
        ).resolves.toBeUndefined();
    });

    it("runs /status and /clear, keeping the old session file", async () => {
        const running = await daemon();
        const before = await status(running);
        expect((await postInbound(running, "/status", "s-1")).status).toBe(202);
        const statusItems = await waitForOutbound(running, 0);
        expect(statusItems.items[0]?.text).toContain("mainSession:");

        expect((await postInbound(running, "/clear", "c-1")).status).toBe(202);
        const cleared = await waitForOutbound(
            running,
            statusItems.items.at(-1)?.seq ?? 0,
            10
        );
        expect(cleared.items[0]?.text).toContain("已新建会话");
        const after = await status(running);
        expect(after.mainSessionId).not.toBe(before.mainSessionId);
        const oldFiles = await findSessionFiles(running.home);
        expect(
            oldFiles.some((path) => path.includes(before.mainSessionId ?? ""))
        ).toBe(true);
    });

    it("exits cleanly on SIGTERM and restarts without a crash notice", async () => {
        const running = await daemon();
        expect((await postInbound(running, "hello", "t-1")).status).toBe(202);
        const first = await waitForOutbound(running, 0);
        const sessionId = (await status(running)).mainSessionId;

        const exitCode = await running.stop();
        expect(exitCode).toBe(0);
        const state = await readState(running.home);
        expect(state.cleanShutdown).toBe(true);

        const restarted = await startDaemon({
            home: running.home,
            token: running.token,
            mockBaseUrl: mock.baseURL,
        });
        daemons.push(restarted);
        const current = await status(restarted);
        expect(current.mainSessionId).toBe(sessionId);
        expect(current.lastRestartReason).toBe("clean");
        const lastSeq = first.items.at(-1)?.seq ?? 0;
        await expect(waitForOutbound(restarted, lastSeq, 1)).rejects.toThrow(
            /timed out/
        );
        expect((await postInbound(restarted, "again", "t-2")).status).toBe(202);
        await waitForOutbound(restarted, lastSeq, 10);
    });

    it("recovers a killed daemon, replays pending outbox, and keeps dedupe", async () => {
        const running = await daemon();
        expect((await postInbound(running, "hello", "k-1")).status).toBe(202);
        const first = await waitForOutbound(running, 0);
        const sessionId = (await status(running)).mainSessionId;
        running.signal("SIGKILL");
        await running.exited;

        await appendPendingOutbox(running.home, "queued while down");
        const restarted = await startDaemon({
            home: running.home,
            token: running.token,
            mockBaseUrl: mock.baseURL,
        });
        daemons.push(restarted);
        const current = await status(restarted);
        expect(current.mainSessionId).toBe(sessionId);
        expect(current.lastRestartReason).toBe("crash");

        const items = await waitForOutbound(
            restarted,
            first.items.at(-1)?.seq ?? 0,
            10
        );
        expect(
            items.items.some((item) => item.text === "queued while down")
        ).toBe(true);
        expect(items.items.some((item) => item.text.includes("进程重启"))).toBe(
            true
        );

        expect((await postInbound(restarted, "hello", "k-1")).status).toBe(202);
        const duplicate = await waitForOutbound(
            restarted,
            items.items.at(-1)?.seq ?? 0,
            1
        ).catch(() => ({ items: [], nextSeq: 0 }));
        expect(duplicate.items).toEqual([]);
    });

    it("supports /steer with text and the bare delivery modes", async () => {
        const running = await daemon();
        expect(
            (await postInbound(running, "/steer forced", "st-1")).status
        ).toBe(202);
        const first = await waitForOutbound(running, 0, 10);
        expect(first.items.some((item) => item.text === "已 steer")).toBe(true);
        const second = await waitForOutbound(
            running,
            first.items.at(-1)?.seq ?? 0,
            10
        );
        expect(
            second.items.some((item) => item.text === "pong from mock")
        ).toBe(true);

        expect((await postInbound(running, "/queue", "q-1")).status).toBe(202);
        const queued = await waitForOutbound(
            running,
            second.items.at(-1)?.seq ?? 0,
            5
        );
        expect(
            queued.items.some((item) => item.text.includes("强制使用 followup"))
        ).toBe(true);
    });

    it("backs up corrupt state, starts fresh, and notifies", async () => {
        const running = await daemon();
        const oldSession = (await status(running)).mainSessionId;
        await running.stop();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(running.home, "state/agent-state.json"), "{oops");
        const restarted = await startDaemon({
            home: running.home,
            token: running.token,
            mockBaseUrl: mock.baseURL,
        });
        daemons.push(restarted);
        const current = await status(restarted);
        expect(current.lastRestartReason).toBe("state-corrupt");
        expect(current.mainSessionId).not.toBe(oldSession);
        const entries = await readdir(join(running.home, "state"));
        expect(entries.some((entry) => entry.includes("corrupt"))).toBe(true);
        const items = await waitForOutbound(restarted, 0, 5);
        expect(
            items.items.some((item) => item.text.includes("状态文件损坏"))
        ).toBe(true);
    });

    it("refuses a second instance for the same DSH_HOME", async () => {
        const running = await daemon();
        await expect(
            startDaemon({
                home: running.home,
                token: running.token,
                mockBaseUrl: mock.baseURL,
            })
        ).rejects.toThrow(/lock|startup failed/i);
    });

    it("cancels a running turn with /stop without an abort notice", async () => {
        const slow = await startMockLlmServer({
            host: "127.0.0.1",
            port: 0,
            sequence: ["slow_success"],
            repeatLast: true,
            successText: "x".repeat(400),
            chunkSize: 1,
            chunkDelayMs: 100,
        });
        try {
            const home = await tempHome();
            homes.push(home);
            const running = await startDaemon({
                home,
                token: `slow-${Math.random().toString(36).slice(2)}`,
                mockBaseUrl: slow.baseURL,
            });
            daemons.push(running);
            expect(
                (await postInbound(running, "long task", "slow-1")).status
            ).toBe(202);
            const deadline = Date.now() + 5000;
            while ((await status(running)).agentStatus !== "running") {
                if (Date.now() > deadline)
                    throw new Error("agent never became running");
                await new Promise((resolveDelay) =>
                    setTimeout(resolveDelay, 50)
                );
            }
            expect((await postInbound(running, "/stop", "stop-1")).status).toBe(
                202
            );
            const items = await waitForOutbound(running, 0, 10);
            expect(items.items.some((item) => item.text === "已停止")).toBe(
                true
            );
            expect(
                items.items.some((item) => item.text.includes("非用户原因中止"))
            ).toBe(false);
        } finally {
            await slow.close();
        }
    });
});
