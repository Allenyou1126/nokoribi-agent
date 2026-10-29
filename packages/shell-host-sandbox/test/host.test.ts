import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShellExecution, ShellRunResult } from "@deepseek-ai/dsh-shell";
import { afterEach, describe, expect, it } from "vitest";

import { SandboxHost } from "../src/host.js";
import type { SandboxHostConfig, SandboxHostDeps } from "../src/host.js";

const dirs: string[] = [];
const hosts: SandboxHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) host.dispose();
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

function runResult(
    text = "",
    exitCode = 0,
    overrides: Partial<ShellRunResult> = {}
): ShellRunResult {
    return {
        exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text, truncated: false },
        stderr: { text: "", truncated: false },
        ...overrides,
    };
}

function reader(text: string) {
    return {
        readFrom: (fromByte: number) => ({
            text: text.slice(fromByte),
            nextOffset: text.length,
            lossy: false,
        }),
    };
}

function execution(
    result = runResult("spawned"),
    done: Promise<void> = Promise.resolve(),
    status: "running" | "completed" = "completed"
): ShellExecution {
    return {
        status,
        exitCode: status === "running" ? null : result.exitCode,
        signal: null,
        done,
        observed: {
            stdout: reader(result.stdout.text),
            stderr: reader(result.stderr.text),
        },
        readOutput: () => ({ delta: result.stdout.text, lossy: false }),
        kill: () => true,
        result: async () => {
            await done;
            return result;
        },
    };
}

function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
} {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((inner) => {
        resolve = inner;
    });
    return {
        promise,
        resolve: () => resolve?.(),
    };
}

interface Fixture {
    readonly host: SandboxHost;
    readonly config: SandboxHostConfig;
    readonly root: string;
    readonly env: string;
    readonly requests: import("@deepseek-ai/dsh-shell").ShellExecRequest[];
    setNow(value: number): void;
}

async function fixture(
    options: {
        readonly baseEnvironment?: string;
        readonly allowRuntimePackages?: boolean;
        readonly resolveExecutable?: (command: string) => Promise<string>;
        readonly spawn?: (
            request: import("@deepseek-ai/dsh-shell").ShellExecRequest
        ) => Promise<ShellExecution>;
    } = {}
): Promise<Fixture> {
    const rootDir = await mkdtemp(join(tmpdir(), "nokoribi-sandbox-"));
    dirs.push(rootDir);
    const env = join(rootDir, "env");
    await mkdir(join(env, "bin"), { recursive: true });
    const requests: import("@deepseek-ai/dsh-shell").ShellExecRequest[] = [];
    let now = 0;
    const config: SandboxHostConfig = {
        id: "sandbox:default",
        root: join(rootDir, "sandboxes"),
        workspace: join(rootDir, "workspace"),
        baseEnvironment:
            options.baseEnvironment === undefined
                ? env
                : options.baseEnvironment,
        shellHook: "",
        idleTtlMs: 1000,
        sweepIntervalMs: 100_000,
        allowRuntimePackages: options.allowRuntimePackages ?? true,
        nixBinary: "nix",
        nixTimeoutMs: 5000,
        noNewPrivilegesCommand: "setpriv",
    };
    const deps: SandboxHostDeps = {
        spawnBash: async (request) => {
            requests.push(request);
            if (options.spawn !== undefined)
                return await options.spawn(request);
            return execution(runResult("spawned"));
        },
        resolveExecutable:
            options.resolveExecutable ??
            (async (command) => `/usr/bin/${command}`),
        now: () => now,
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
        },
    };
    const host = new SandboxHost(config, deps);
    hosts.push(host);
    return {
        host,
        config,
        root: join(rootDir, "sandboxes"),
        env,
        requests,
        setNow: (value) => {
            now = value;
        },
    };
}

describe("SandboxHost", () => {
    it("runs a command with a guarded PATH, managed env, and cwd", async () => {
        const test = await fixture();
        const result = await test.host.run({
            command: "echo hi",
            sessionId: "main-1",
        });
        expect(result.stdout.text).toBe("spawned");
        const request = test.requests[0];
        expect(request?.command).toContain(
            "exec '/usr/bin/setpriv' --no-new-privs"
        );
        expect(request?.env?.PATH).toBe(
            `${join(test.root, "main-1", ".path-guard")}:${join(test.env, "bin")}`
        );
        expect(request?.workdir).toBe(join(test.root, "main-1"));
        expect(request?.dshEnv).toMatchObject({
            DSH_SANDBOX_DIR: join(test.root, "main-1"),
            DSH_WORKSPACE_DIR: test.config.workspace,
        });
        const guard = await stat(
            join(test.root, "main-1", ".path-guard", "sudo")
        );
        expect(guard.mode & 0o777).toBe(0o555);
        const status = await test.host.status("main-1");
        expect(status).toMatchObject({
            exists: true,
            generation: 1,
            activeCommands: 0,
            packages: [],
        });
        const sidecar = JSON.parse(
            await readFile(join(test.root, "main-1.json"), "utf8")
        ) as { generation: number };
        expect(sidecar.generation).toBe(1);
    });

    it("resolves relative workdirs inside the sandbox and keeps absolute ones", async () => {
        const test = await fixture();
        await test.host.run({
            command: "pwd",
            workdir: "sub",
            sessionId: "main-1",
        });
        await test.host.run({
            command: "pwd",
            workdir: "/tmp/absolute",
            sessionId: "main-1",
        });
        expect(test.requests[0]?.workdir).toBe(
            join(test.root, "main-1", "sub")
        );
        expect(test.requests[1]?.workdir).toBe("/tmp/absolute");
    });

    it("requires a session id", async () => {
        const test = await fixture();
        await expect(test.host.run({ command: "ls" })).rejects.toThrow(
            /requires an agent session/
        );
        await expect(
            test.host.run({ command: "ls", sessionId: "../escape" })
        ).rejects.toThrow(/invalid sandbox session id/);
    });

    it("reports an unconfigured base environment and missing setpriv", async () => {
        const unconfigured = await fixture({ baseEnvironment: "" });
        await expect(
            unconfigured.host.run({ command: "ls", sessionId: "main-1" })
        ).rejects.toThrow(/environment is not configured/);

        const missing = await fixture({
            resolveExecutable: async (command) => {
                if (command === "setpriv") throw new Error("not found");
                return `/usr/bin/${command}`;
            },
        });
        await expect(
            missing.host.run({ command: "ls", sessionId: "main-1" })
        ).rejects.toThrow(/requires setpriv/);
    });

    it("resets generation and packages", async () => {
        const test = await fixture();
        await test.host.run({ command: "echo hi", sessionId: "main-1" });
        await test.host.addPackages("main-1", ["nixpkgs#hello"]);
        expect((await test.host.status("main-1")).generation).toBe(1);
        await test.host.reset("main-1");
        const status = await test.host.status("main-1");
        expect(status.generation).toBe(2);
        expect(status.packages).toEqual([]);
        expect(status.exists).toBe(true);
    });

    it("refuses reset while a background command is active", async () => {
        const gate = deferred();
        const test = await fixture({
            spawn: async () =>
                execution(runResult(""), gate.promise, "running"),
        });
        await test.host.start({
            command: "sleep 60",
            sessionId: "main-1",
            runInBackground: true,
        });
        expect((await test.host.status("main-1")).activeCommands).toBe(1);
        await expect(test.host.reset("main-1")).rejects.toThrow(
            /active commands/
        );
        gate.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        await test.host.reset("main-1");
        expect((await test.host.status("main-1")).generation).toBe(2);
    });

    it("reclaims an expired sandbox on the next use", async () => {
        const test = await fixture();
        await test.host.run({ command: "echo one", sessionId: "main-1" });
        await test.host.addPackages("main-1", ["nixpkgs#hello"]);
        test.setNow(2000);
        await test.host.run({ command: "echo two", sessionId: "main-1" });
        const status = await test.host.status("main-1");
        expect(status.generation).toBe(2);
        expect(status.packages).toEqual([]);
    });

    it("sweeps an expired idle sandbox and keeps the generation", async () => {
        const test = await fixture();
        await test.host.run({ command: "echo one", sessionId: "main-1" });
        await test.host.addPackages("main-1", ["nixpkgs#hello"]);
        test.setNow(2000);
        await test.host.sweepNow();
        const status = await test.host.status("main-1");
        expect(status.exists).toBe(false);
        expect(status.generation).toBe(2);
        expect(status.packages).toEqual([]);
    });

    it("adds, removes, and lists temporary packages", async () => {
        const test = await fixture();
        const added = await test.host.addPackages("main-1", [
            "nixpkgs#hello",
            "nixpkgs#hello",
            "nixpkgs#jq",
        ]);
        expect(added).toEqual(["nixpkgs#hello", "nixpkgs#jq"]);
        const validation = test.requests.at(-1);
        expect(validation?.command).toContain("exec '/usr/bin/nix' shell");
        expect(validation?.command).toContain("'/usr/bin/bash' -c true");
        await expect(test.host.listPackages("main-1")).resolves.toEqual([
            "nixpkgs#hello",
            "nixpkgs#jq",
        ]);
        await expect(
            test.host.removePackages("main-1", ["nixpkgs#hello"])
        ).resolves.toEqual(["nixpkgs#jq"]);
        expect((await test.host.status("main-1")).packages).toEqual([
            "nixpkgs#jq",
        ]);
    });

    it("rejects package additions when disabled or when nix fails", async () => {
        const disabled = await fixture({ allowRuntimePackages: false });
        await expect(
            disabled.host.addPackages("main-1", ["nixpkgs#hello"])
        ).rejects.toThrow(/runtime packages are disabled/);

        const failing = await fixture({
            spawn: async () =>
                execution(
                    runResult("", 1, {
                        stderr: { text: "cannot fetch", truncated: false },
                    })
                ),
        });
        await expect(
            failing.host.addPackages("main-1", ["nixpkgs#hello"])
        ).rejects.toThrow(/cannot fetch/);
        await expect(
            failing.host.addPackages("main-1", ["--impure"])
        ).rejects.toThrow(/must not start with a nix option/);
    });

    it("launches a pinned terminal with restricted argv, cwd, and env", async () => {
        const test = await fixture();
        const launch = await test.host.terminal({
            sessionId: "main-1",
            cwd: "/workspace",
        });
        expect(launch.argv).toEqual([
            "/usr/bin/setpriv",
            "--no-new-privs",
            "--",
            "/usr/bin/bash",
            "--noprofile",
            "--norc",
            "-i",
        ]);
        expect(launch.cwd).toBe(join(test.root, "main-1"));
        expect(launch.env).toMatchObject({
            PATH: `${join(test.root, "main-1", ".path-guard")}:${join(test.env, "bin")}`,
            DSH_SANDBOX_DIR: join(test.root, "main-1"),
            DSH_WORKSPACE_DIR: test.config.workspace,
        });
        expect((await test.host.status("main-1")).terminalSessions).toBe(1);
        await launch.release?.();
        expect((await test.host.status("main-1")).terminalSessions).toBe(0);
    });

    it("adds a nix shell layer for terminal packages", async () => {
        const test = await fixture();
        await test.host.addPackages("main-1", ["nixpkgs#hello"]);
        const launch = await test.host.terminal({ sessionId: "main-1" });
        expect(launch.argv.slice(0, 7)).toEqual([
            "/usr/bin/nix",
            "shell",
            test.env,
            "nixpkgs#hello",
            "--command",
            "/usr/bin/setpriv",
            "--no-new-privs",
        ]);
        await launch.release?.();
    });

    it("protects pinned terminals from reset, TTL sweep, and disposal", async () => {
        const test = await fixture();
        const launch = await test.host.terminal({ sessionId: "main-1" });
        await expect(test.host.reset("main-1")).rejects.toThrow(
            /persistent terminals/
        );
        await expect(test.host.disposeSession("main-1")).rejects.toThrow(
            /open persistent terminal/
        );
        test.setNow(2000);
        await test.host.sweepNow();
        expect((await test.host.status("main-1")).exists).toBe(true);
        await launch.release?.();
        await test.host.reset("main-1");
        expect((await test.host.status("main-1")).generation).toBe(2);
    });

    it("requires a session for terminal launches", async () => {
        const test = await fixture();
        await expect(test.host.terminal({})).rejects.toThrow(
            /requires an agent session/
        );
    });

    it("disposes a session directory and sidecar", async () => {
        const test = await fixture();
        await test.host.run({ command: "echo hi", sessionId: "main-1" });
        const paths = [
            join(test.root, "main-1"),
            join(test.root, "main-1.json"),
        ];
        for (const path of paths) {
            await expect(stat(path)).resolves.toBeDefined();
        }
        await test.host.disposeSession("main-1");
        for (const path of paths) {
            await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect((await test.host.status("main-1")).exists).toBe(false);
    });

    it("backs up corrupt metadata and starts a fresh generation", async () => {
        const test = await fixture();
        await mkdir(test.root, { recursive: true });
        await writeFile(join(test.root, "main-1.json"), "not json");
        await test.host.run({ command: "echo hi", sessionId: "main-1" });
        const entries = await readdir(test.root);
        expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
        expect((await test.host.status("main-1")).generation).toBe(1);
    });

    it("reports status before the first command without creating", async () => {
        const test = await fixture();
        const status = await test.host.status("main-1");
        expect(status).toMatchObject({
            exists: false,
            generation: 1,
            packages: [],
            createdAt: null,
        });
        await expect(stat(join(test.root, "main-1"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});
