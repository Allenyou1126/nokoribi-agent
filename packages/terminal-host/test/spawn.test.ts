import { Readable } from "node:stream";

import type { Context } from "@deepseek-ai/cordis";
import type {
    SubprocessOutcome,
    SubprocessTerminalHandle,
    SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type {
    ShellTerminalLaunch,
    ShellTerminalLaunchRequest,
} from "@nokoribi/shell-bash";
import { describe, expect, it, vi } from "vitest";

import { createHostTerminalSpawner } from "../src/spawn.js";
import type { SpawnLogger } from "../src/spawn.js";

const HOST_ID = "sandbox:default";
const SESSION_ID = "session-1";

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function outcome(): SubprocessOutcome {
    return { exitCode: 0, signal: null };
}

function fakeHandle(
    overrides: Partial<SubprocessTerminalHandle> = {}
): SubprocessTerminalHandle {
    return {
        pid: 4242,
        output: Readable.from([]),
        done: Promise.resolve(outcome()),
        write: vi.fn(async (): Promise<void> => {}),
        resize: vi.fn(async (): Promise<void> => {}),
        inspectForeground: vi.fn(async () => undefined),
        inspectActivity: vi.fn(async () => ({
            state: "unknown" as const,
            revision: 0,
        })),
        signalForeground: vi.fn(async (): Promise<number> => 7),
        terminate: vi.fn(async (): Promise<void> => {}),
        ...overrides,
    };
}

function spawnSpec(
    overrides: Partial<SubprocessTerminalSpawnSpec> = {}
): SubprocessTerminalSpawnSpec {
    return {
        argv: ["/bin/bash", "--noprofile", "--norc", "-i"],
        cwd: "/requested",
        env: {
            TERM: "dumb",
            PS1: "dsh> ",
            PROMPT_COMMAND: "prompt-marker",
            DSH_SHELL: "1",
            DSH_SESSION_ID: "session-1",
            PATH: "/ambient/bin",
        },
        rows: 40,
        cols: 160,
        terminalType: "dumb",
        shellActivity: true,
        graceMs: 3000,
        ...overrides,
    };
}

function harness(
    launchValue: ShellTerminalLaunch | undefined,
    handle: SubprocessTerminalHandle = fakeHandle()
) {
    const launch = vi.fn(
        async (
            _hostId: string,
            _request: ShellTerminalLaunchRequest
        ): Promise<ShellTerminalLaunch | undefined> => launchValue
    );
    const spawnTerminal = vi.fn(
        async (
            _spec: SubprocessTerminalSpawnSpec
        ): Promise<SubprocessTerminalHandle> => handle
    );
    const ctx = {
        shellHosts: { terminalLaunch: launch },
        subprocess: { spawnTerminal },
    } as unknown as Context;
    return { ctx, launch, spawnTerminal, handle };
}

describe("host terminal spawner", () => {
    it("launches through the host and replaces argv, cwd, and env", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const launched: ShellTerminalLaunch = {
            argv: ["setpriv", "--no-new-privs", "--", "/bin/bash", "-i"],
            cwd: "/sandbox",
            env: { PATH: "/guard:/base/bin", DSH_SANDBOX_DIR: "/sandbox" },
            release,
        };
        const test = harness(launched);
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        const handle = await spawner(spawnSpec(), SESSION_ID);

        expect(handle.pid).toBe(4242);
        expect(test.launch).toHaveBeenCalledTimes(1);
        const [hostId, request] = test.launch.mock.calls[0]!;
        expect(hostId).toBe(HOST_ID);
        expect(request.sessionId).toBe(SESSION_ID);
        expect(request.cwd).toBe("/requested");
        expect(request.signal).toBeUndefined();

        expect(test.spawnTerminal).toHaveBeenCalledTimes(1);
        const passed = test.spawnTerminal.mock.calls[0]![0];
        expect(passed.argv).toEqual(launched.argv);
        expect(passed.cwd).toBe("/sandbox");
        expect(passed.env).toEqual({
            TERM: "dumb",
            PS1: "dsh> ",
            PROMPT_COMMAND: "prompt-marker",
            DSH_SHELL: "1",
            DSH_SESSION_ID: "session-1",
            PATH: "/guard:/base/bin",
            DSH_SANDBOX_DIR: "/sandbox",
        });
        expect(passed.rows).toBe(40);
        expect(passed.cols).toBe(160);
        expect(passed.terminalType).toBe("dumb");
        expect(passed.shellActivity).toBe(true);
        expect(passed.graceMs).toBe(3000);
    });

    it("keeps the upstream env when the host provides none", async () => {
        const test = harness({ argv: ["/bin/bash", "-i"], cwd: "/workspace" });
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        const spec = spawnSpec();
        await spawner(spec, SESSION_ID);

        const passed = test.spawnTerminal.mock.calls[0]![0];
        expect(passed.cwd).toBe("/workspace");
        expect(passed.env).toBe(spec.env);
        expect(passed.env?.PROMPT_COMMAND).toBe("prompt-marker");
    });

    it("releases the host launch exactly once across repeated terminate calls", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const underlying = fakeHandle();
        const test = harness(
            { argv: ["/bin/bash"], cwd: "/workspace", release },
            underlying
        );
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        const handle = await spawner(spawnSpec(), SESSION_ID);

        await handle.terminate();
        expect(underlying.terminate).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);

        await handle.terminate();
        expect(underlying.terminate).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("releases the host launch when the PTY exits on its own", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const pending = deferred<SubprocessOutcome>();
        const underlying = fakeHandle({ done: pending.promise });
        const test = harness(
            { argv: ["/bin/bash"], cwd: "/workspace", release },
            underlying
        );
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        await spawner(spawnSpec(), SESSION_ID);
        expect(release).not.toHaveBeenCalled();

        pending.resolve(outcome());
        await vi.waitFor(() => {
            expect(release).toHaveBeenCalledTimes(1);
        });
    });

    it("releases the host launch when the PTY fails after startup", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const pending = deferred<SubprocessOutcome>();
        const underlying = fakeHandle({ done: pending.promise });
        const test = harness(
            { argv: ["/bin/bash"], cwd: "/workspace", release },
            underlying
        );
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        await spawner(spawnSpec(), SESSION_ID);
        const settled = pending.promise.catch(() => undefined);

        pending.reject(new Error("transport failed"));
        await settled;
        await vi.waitFor(() => {
            expect(release).toHaveBeenCalledTimes(1);
        });
    });

    it("releases and rethrows when the PTY primitive rejects", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const test = harness({
            argv: ["/bin/bash"],
            cwd: "/workspace",
            release,
        });
        test.spawnTerminal.mockRejectedValueOnce(new Error("pty unavailable"));
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);

        await expect(spawner(spawnSpec(), SESSION_ID)).rejects.toThrow(
            "pty unavailable"
        );
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("rejects when the host returns no launch", async () => {
        const test = harness(undefined);
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);

        await expect(spawner(spawnSpec(), SESSION_ID)).rejects.toThrow(
            /returned no terminal launch/
        );
        expect(test.spawnTerminal).not.toHaveBeenCalled();
    });

    it("rejects an empty host argv before spawning", async () => {
        const test = harness({ argv: [], cwd: "/workspace" });
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);

        await expect(spawner(spawnSpec(), SESSION_ID)).rejects.toThrow(
            /empty terminal argv/
        );
        expect(test.spawnTerminal).not.toHaveBeenCalled();
    });

    it("keeps teardown successful when release fails", async () => {
        const warn = vi.fn();
        const log: SpawnLogger = { warn };
        const release = vi.fn(async (): Promise<void> => {
            throw new Error("pin release failed");
        });
        const test = harness({
            argv: ["/bin/bash"],
            cwd: "/workspace",
            release,
        });
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID, log);
        const handle = await spawner(spawnSpec(), SESSION_ID);

        await expect(handle.terminate()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            "terminal launch release failed",
            expect.objectContaining({
                host: HOST_ID,
                error: "pin release failed",
            })
        );
    });

    it("releases when terminate itself fails", async () => {
        const release = vi.fn(async (): Promise<void> => {});
        const underlying = fakeHandle({
            terminate: vi.fn(async (): Promise<void> => {
                throw new Error("terminate failed");
            }),
        });
        const test = harness(
            { argv: ["/bin/bash"], cwd: "/workspace", release },
            underlying
        );
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        const handle = await spawner(spawnSpec(), SESSION_ID);

        await expect(handle.terminate()).rejects.toThrow("terminate failed");
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("delegates write, resize, inspection, and foreground signals", async () => {
        const underlying = fakeHandle();
        const test = harness(
            { argv: ["/bin/bash"], cwd: "/workspace" },
            underlying
        );
        const spawner = createHostTerminalSpawner(test.ctx, HOST_ID);
        const handle = await spawner(spawnSpec(), SESSION_ID);

        await handle.write("echo hi\n");
        await handle.resize(120, 30);
        expect(underlying.write).toHaveBeenCalledWith("echo hi\n");
        expect(underlying.resize).toHaveBeenCalledWith(120, 30);
        await expect(handle.inspectForeground()).resolves.toBeUndefined();
        await expect(handle.inspectActivity()).resolves.toEqual({
            state: "unknown",
            revision: 0,
        });
        await expect(handle.signalForeground("SIGINT")).resolves.toBe(7);
        expect(underlying.signalForeground).toHaveBeenCalledWith("SIGINT");
        expect(handle.output).toBe(underlying.output);
        await expect(handle.done).resolves.toEqual(outcome());
    });
});
