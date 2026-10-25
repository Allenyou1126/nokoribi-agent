import { describe, expect, it, vi } from "vitest";

import {
    SystemdNotifier,
    resolveWatchdogIntervalMs,
    type SystemdNotifyRunner,
} from "../src/systemd.js";

function runner(): {
    readonly run: SystemdNotifyRunner;
    readonly calls: Array<{
        command: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }>;
} {
    const calls: Array<{
        command: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }> = [];
    return {
        calls,
        run: async (command, args, env) => {
            calls.push({ command, args, env });
        },
    };
}

describe("systemd notifier", () => {
    it("is a no-op when NOTIFY_SOCKET is absent", async () => {
        const fake = runner();
        const notifier = new SystemdNotifier({ env: {}, run: fake.run });
        expect(notifier.enabled).toBe(false);
        await notifier.ready();
        await notifier.watchdog();
        await notifier.stopping();
        expect(fake.calls).toEqual([]);
        expect(notifier.watchdogIntervalMs).toBeUndefined();
    });

    it("reports readiness and sends serial watchdog heartbeats", async () => {
        vi.useFakeTimers();
        const fake = runner();
        const notifier = new SystemdNotifier({
            env: {
                NOTIFY_SOCKET: "/tmp/notify.sock",
                NOKORIBI_SYSTEMD_NOTIFY: "/run/systemd-notify",
                WATCHDOG_USEC: "300000",
            },
            run: fake.run,
        });
        try {
            expect(notifier.enabled).toBe(true);
            await notifier.ready("test ready");
            expect(fake.calls[0]).toMatchObject({
                command: "/run/systemd-notify",
                args: ["--ready", "--status=test ready"],
            });
            expect(fake.calls[0]?.env.NOTIFY_SOCKET).toBe("/tmp/notify.sock");
            await vi.advanceTimersByTimeAsync(100);
            expect(
                fake.calls.some((call) => call.args[0] === "WATCHDOG=1")
            ).toBe(true);
            expect(notifier.watchdogIntervalMs).toBe(100);
            await notifier.stopping("test stop");
            expect(fake.calls.at(-1)).toMatchObject({
                args: ["--stopping", "--status=test stop"],
            });
            expect(notifier.watchdogIntervalMs).toBeUndefined();
        } finally {
            notifier.stop();
            vi.useRealTimers();
        }
    });

    it("fails startup when the ready helper fails", async () => {
        const notifier = new SystemdNotifier({
            env: { NOTIFY_SOCKET: "/tmp/notify.sock" },
            run: async () => {
                throw new Error("helper broken");
            },
        });
        await expect(notifier.ready()).rejects.toThrow(
            /systemd notification failed: helper broken/
        );
        expect(notifier.watchdogIntervalMs).toBeUndefined();
    });

    it("logs and continues when a watchdog heartbeat fails", async () => {
        vi.useFakeTimers();
        const warn = vi.fn();
        let calls = 0;
        const notifier = new SystemdNotifier({
            env: {
                NOTIFY_SOCKET: "/tmp/notify.sock",
                WATCHDOG_USEC: "300000",
            },
            logger: { warn, debug: vi.fn() },
            run: async () => {
                calls += 1;
                if (calls > 1) throw new Error("watchdog failed");
            },
        });
        try {
            await notifier.ready();
            await vi.advanceTimersByTimeAsync(100);
            expect(warn).toHaveBeenCalled();
            expect(notifier.watchdogIntervalMs).toBe(100);
        } finally {
            notifier.stop();
            vi.useRealTimers();
        }
    });

    it("parses watchdog intervals and ignores another process", () => {
        expect(resolveWatchdogIntervalMs({})).toBeUndefined();
        expect(
            resolveWatchdogIntervalMs({ WATCHDOG_USEC: "invalid" })
        ).toBeUndefined();
        expect(
            resolveWatchdogIntervalMs({
                WATCHDOG_USEC: "300000",
                WATCHDOG_PID: String(process.pid),
            })
        ).toBe(100);
        expect(
            resolveWatchdogIntervalMs({
                WATCHDOG_USEC: "300000",
                WATCHDOG_PID: String(process.pid + 1),
            })
        ).toBeUndefined();
    });
});
