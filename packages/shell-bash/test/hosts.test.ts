import { Context } from "@deepseek-ai/cordis";
import type { ShellRunResult } from "@deepseek-ai/dsh-shell";
import { describe, expect, it } from "vitest";

import { ShellHostRegistry } from "../src/hosts.js";
import type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostProvider,
} from "../src/hosts.js";

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
        },
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
            background: false,
            sandbox: false,
            workdir: "local",
        },
        ...overrides,
    };
}

function withCapabilities(capabilities: unknown): ShellHostProvider {
    return {
        ...localProvider(),
        capabilities: capabilities as ShellHostCapabilities,
    };
}

function runResult(text = ""): ShellRunResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text, truncated: false },
        stderr: { text: "", truncated: false },
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

    it("rejects invalid capabilities and empty metadata", () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        expect(() =>
            registry.register(
                withCapabilities({
                    background: false,
                    sandbox: true,
                    workdir: "local",
                })
            )
        ).toThrow(/sandbox: false/);
        expect(() =>
            registry.register(
                withCapabilities({
                    background: false,
                    sandbox: false,
                    workdir: "somewhere",
                })
            )
        ).toThrow(/workdir/);
        expect(() => registry.register(localProvider({ title: " " }))).toThrow(
            /non-empty title/
        );
        expect(() =>
            registry.register(localProvider({ description: "" }))
        ).toThrow(/non-empty description/);
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

    it("falls back to the router local runner for local hosts", async () => {
        const requests: ShellHostExecRequest[] = [];
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
            runLocal: async (request) => {
                requests.push(request);
                return runResult(request.command);
            },
        });
        registry.register(localProvider({ defaultWorkdir: "/srv/workspace" }));
        const result = await registry.execute({ command: "echo hi" });
        expect(result.stdout.text).toBe("echo hi");
        expect(requests).toEqual([
            { command: "echo hi", workdir: "/srv/workspace" },
        ]);
    });

    it("keeps an explicit request workdir over the host default", async () => {
        const requests: ShellHostExecRequest[] = [];
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
            runLocal: async (request) => {
                requests.push(request);
                return runResult();
            },
        });
        registry.register(localProvider({ defaultWorkdir: "/srv/workspace" }));
        await registry.execute({ command: "ls", workdir: "/tmp" });
        expect(requests[0]?.workdir).toBe("/tmp");
    });

    it("rejects unknown hosts and hosts without an executor", async () => {
        const registry = new ShellHostRegistry(new Context(), {
            defaultHost: "local:workspace",
        });
        registry.register(localProvider());
        await expect(
            registry.execute({ command: "ls" }, "sandbox:default")
        ).rejects.toThrow(/unknown shell host "sandbox:default"/);
        await expect(registry.execute({ command: "ls" })).rejects.toThrow(
            /does not implement execution/
        );
    });
});
