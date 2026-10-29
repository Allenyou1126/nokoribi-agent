import { Context } from "@deepseek-ai/cordis";
import type { ShellExecution, ShellRunResult } from "@deepseek-ai/dsh-shell";
import { describe, expect, it } from "vitest";

import { ShellHostRegistry } from "../src/hosts.js";
import type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostProvider,
} from "../src/hosts.js";

function runResult(text = "", exitCode = 0): ShellRunResult {
    return {
        exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text, truncated: false },
        stderr: { text: "", truncated: false },
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

function execution(text = ""): ShellExecution {
    return {
        status: "completed",
        exitCode: 0,
        signal: null,
        done: Promise.resolve(),
        observed: {
            stdout: reader(text),
            stderr: reader(""),
        },
        readOutput: () => ({ delta: text, lossy: false }),
        kill: () => false,
        result: async () => runResult(text),
    };
}

function localProvider(
    overrides: Partial<ShellHostProvider> = {}
): ShellHostProvider {
    return {
        id: "local:workspace",
        kind: "local",
        title: "Local workspace",
        description: "主机环境",
        capabilities: {
            background: false,
            sandbox: false,
            workdir: "local",
            terminal: false,
        },
        run: async (request) => runResult(request.command),
        ...overrides,
    };
}

function sandboxProvider(
    overrides: Partial<ShellHostProvider> = {}
): ShellHostProvider {
    return {
        id: "sandbox:default",
        kind: "sandbox",
        title: "Sandbox",
        description: "干净环境",
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal: false,
        },
        run: async (request) => runResult(request.command),
        start: async (request) => execution(request.command),
        ...overrides,
    };
}

function withCapabilities(capabilities: unknown): ShellHostProvider {
    return {
        ...localProvider(),
        capabilities: capabilities as ShellHostCapabilities,
    };
}

describe("ShellHostRegistry", () => {
    it("exposes the configured default host id", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        expect(registry.defaultHost).toBe("local:workspace");
        expect(registry.list()).toEqual([]);
    });

    it("rejects an invalid default host id at construction", () => {
        expect(
            () =>
                new ShellHostRegistry(new Context(), {
                    defaultHost: "workspace",
                })
        ).toThrow(/invalid shell host id/);
    });

    it("registers, lists, and looks up a host", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        const dispose = registry.register(localProvider());
        expect(registry.list().map((host) => host.id)).toEqual([
            "local:workspace",
        ]);
        expect(registry.get("local:workspace")?.title).toBe("Local workspace");
        expect(registry.get("sandbox:default")).toBeUndefined();
        expect(registry.requireDefaultHost().id).toBe("local:workspace");
        dispose();
        expect(registry.list()).toEqual([]);
    });

    it("reports which hosts expose per-session status", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        registry.register(
            sandboxProvider({
                status: async () => ({ generation: 1 }),
            })
        );
        expect(registry.hasStatus("local:workspace")).toBe(false);
        expect(registry.hasStatus("sandbox:default")).toBe(true);
        expect(registry.hasStatus("missing:host")).toBe(false);
    });

    it("sorts host discovery output by id", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(sandboxProvider());
        registry.register(localProvider());
        expect(registry.list().map((host) => host.id)).toEqual([
            "local:workspace",
            "sandbox:default",
        ]);
    });

    it("rejects duplicate host ids", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        expect(() => registry.register(localProvider())).toThrow(
            /duplicate shell host id/
        );
    });

    it("rejects malformed ids and kind mismatches", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        expect(() =>
            registry.register(localProvider({ id: "workspace" }))
        ).toThrow(/invalid shell host id/);
        expect(() =>
            registry.register(localProvider({ id: "Local:workspace" }))
        ).toThrow(/invalid shell host id/);
        expect(() =>
            registry.register(localProvider({ id: "machine:x" }))
        ).toThrow(/unknown kind/);
        expect(() =>
            registry.register(
                localProvider({ id: "sandbox:default", kind: "local" })
            )
        ).toThrow(/id prefix/);
    });

    it("rejects invalid capabilities, empty metadata, and missing start", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        expect(() =>
            registry.register(
                withCapabilities({
                    background: false,
                    sandbox: true,
                    workdir: "local",
                    terminal: false,
                })
            )
        ).toThrow(/sandbox: false/);
        expect(() =>
            registry.register(
                withCapabilities({
                    background: false,
                    sandbox: false,
                    workdir: "somewhere",
                    terminal: false,
                })
            )
        ).toThrow(/workdir/);
        expect(() =>
            registry.register(
                withCapabilities({
                    background: false,
                    sandbox: false,
                    workdir: "local",
                    terminal: "yes",
                })
            )
        ).toThrow(/capabilities.terminal/);
        expect(() => registry.register(localProvider({ title: " " }))).toThrow(
            /non-empty title/
        );
        expect(() =>
            registry.register(localProvider({ description: "" }))
        ).toThrow(/non-empty description/);
        expect(() =>
            registry.register(
                localProvider({
                    capabilities: {
                        background: true,
                        sandbox: false,
                        workdir: "local",
                        terminal: false,
                    },
                })
            )
        ).toThrow(/does not implement start/);
    });

    it("validates and forwards persistent terminal launches", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        const requests: string[] = [];
        registry.register(
            localProvider({
                capabilities: {
                    background: false,
                    sandbox: false,
                    workdir: "local",
                    terminal: true,
                },
                terminal: async (request) => {
                    requests.push(request.sessionId ?? "-");
                    return {
                        argv: ["bash", "-i"],
                        cwd: "/work",
                        env: { PATH: "/bin" },
                    };
                },
            })
        );
        await expect(
            registry.terminalLaunch("local:workspace", {
                sessionId: "main-1",
                cwd: "/work",
            })
        ).resolves.toEqual({
            argv: ["bash", "-i"],
            cwd: "/work",
            env: { PATH: "/bin" },
        });
        expect(requests).toEqual(["main-1"]);
        await expect(
            registry.terminalLaunch("sandbox:default", {})
        ).rejects.toThrow(/unknown shell host/);
    });

    it("rejects terminal capability and implementation mismatches", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        expect(() =>
            registry.register(
                localProvider({
                    capabilities: {
                        background: false,
                        sandbox: false,
                        workdir: "local",
                        terminal: true,
                    },
                })
            )
        ).toThrow(/does not implement terminal/);
        expect(() =>
            registry.register(
                localProvider({
                    terminal: async () => ({ argv: ["bash"], cwd: "/" }),
                })
            )
        ).toThrow(/capabilities.terminal: false/);
    });

    it("notifies terminal observers on registration changes", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        let changes = 0;
        const disposeListener = registry.onChange(() => {
            changes += 1;
        });
        const disposeHost = registry.register(localProvider());
        expect(changes).toBe(1);
        disposeHost();
        expect(changes).toBe(2);
        disposeListener();
        registry.register(localProvider());
        expect(changes).toBe(2);
    });

    it("rejects terminal launches for hosts without terminal support", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        await expect(
            registry.terminalLaunch("local:workspace", {})
        ).rejects.toThrow(/does not support persistent terminals/);
    });

    it("requires the default host to exist", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        registry.register(localProvider());
        expect(() => registry.requireDefaultHost()).toThrow(
            /default shell host "sandbox:default" is not registered/
        );
    });

    it("executes through a provider runner when one is supplied", async () => {
        const requests: ShellHostExecRequest[] = [];
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        registry.register(
            sandboxProvider({
                run: async (request) => {
                    requests.push(request);
                    return runResult("sandbox output");
                },
            })
        );
        const result = await registry.execute({
            command: "echo sandbox",
        });
        expect(requests).toEqual([{ command: "echo sandbox" }]);
        expect(result.stdout.text).toBe("sandbox output");
    });

    it("falls back to the start handle for foreground execution", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        registry.register(
            sandboxProvider({
                run: undefined,
                start: async () => execution("from start"),
            })
        );
        const result = await registry.execute({ command: "echo hi" });
        expect(result.stdout.text).toBe("from start");
    });

    it("starts a background handle through the provider", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        registry.register(sandboxProvider());
        const handle = await registry.start({ command: "sleep 1" });
        expect(handle.status).toBe("completed");
    });

    it("rejects start for providers without background support", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        expect(registry.hasStart("local:workspace")).toBe(false);
        await expect(registry.start({ command: "ls" })).rejects.toThrow(
            /does not support background jobs/
        );
    });

    it("delegates spawnBash to the router callback", async () => {
        const requests: string[] = [];
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
            spawnBash: async (request) => {
                requests.push(request.command);
                return execution(request.command);
            },
        });
        const handle = await registry.spawnBash({ command: "echo spawn" });
        expect(requests).toEqual(["echo spawn"]);
        expect(handle.status).toBe("completed");
    });

    it("fails loud when no bash spawner is installed", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        await expect(registry.spawnBash({ command: "ls" })).rejects.toThrow(
            /did not install a bash spawner/
        );
    });

    it("rejects unknown hosts and hosts without an executor", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider({ run: undefined }));
        await expect(
            registry.execute({ command: "ls" }, "sandbox:default")
        ).rejects.toThrow(/unknown shell host "sandbox:default"/);
        await expect(registry.execute({ command: "ls" })).rejects.toThrow(
            /does not implement execution/
        );
    });

    it("forwards reset, status, and per-session disposal", async () => {
        const calls: string[] = [];
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        registry.register(
            sandboxProvider({
                reset: async (sessionId) => {
                    calls.push(`reset:${sessionId}`);
                },
                status: async (sessionId) => ({ sessionId }),
                disposeSession: async (sessionId) => {
                    calls.push(`dispose:${sessionId}`);
                },
            })
        );
        await registry.reset("sandbox:default", "main-1");
        await expect(
            registry.status("sandbox:default", "main-1")
        ).resolves.toEqual({ sessionId: "main-1" });
        await registry.disposeSession("main-1");
        expect(calls).toEqual(["reset:main-1", "dispose:main-1"]);
    });

    it("aggregates per-session disposal failures after every provider", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "sandbox:default",
        });
        const calls: string[] = [];
        registry.register({
            ...localProvider({ id: "sandbox:other", kind: "sandbox" }),
            disposeSession: async () => {
                calls.push("sandbox");
                throw new Error("sandbox failed");
            },
        });
        registry.register({
            ...localProvider({ id: "local:other" }),
            disposeSession: async () => {
                calls.push("local");
            },
        });
        await expect(registry.disposeSession("main-1")).rejects.toThrow(
            /sandbox failed/
        );
        expect(calls).toEqual(["sandbox", "local"]);
    });

    it("rejects reset/status for hosts that do not provide them", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        await expect(
            registry.reset("local:workspace", "main-1")
        ).rejects.toThrow(/does not support reset/);
        await expect(
            registry.status("local:workspace", "main-1")
        ).rejects.toThrow(/does not expose status/);
    });
});
