import { Context } from "@deepseek-ai/cordis";
import type { Volatile } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import * as routerPlugin from "../src/index.js";
import { Config } from "../src/index.js";
import { ShellRouter } from "../src/router.js";
import type { ShellRouterConfig } from "../src/router.js";
import { FakeSubprocess } from "./support/fake-subprocess.js";

function numberValue(data: number): Volatile<number> {
    return { get: () => data };
}

function optionalStringValue(
    data: string | undefined
): Volatile<string | undefined> {
    return { get: () => data };
}

function routerConfig(
    overrides: Partial<ShellRouterConfig> = {}
): ShellRouterConfig {
    return {
        cwd: optionalStringValue(undefined),
        timeoutMs: numberValue(120_000),
        maxTimeoutMs: numberValue(600_000),
        maxOutputBytes: numberValue(64_000),
        maxSpillBytes: numberValue(64 * 1024 * 1024),
        graceMs: numberValue(3_000),
        defaultHost: "local:workspace",
        ...overrides,
    };
}

interface RouterFixture {
    readonly ctx: Context;
    readonly subprocess: FakeSubprocess;
    readonly router: ShellRouter;
}

function createFixture(
    config: ShellRouterConfig = routerConfig()
): RouterFixture {
    const ctx = new Context();
    const subprocess = new FakeSubprocess(ctx, { stdout: "hello\n" });
    const router = new ShellRouter(ctx, config);
    return { ctx, subprocess, router };
}

function registerLocal(ctx: Context): () => void {
    return ctx.shellHosts.register({
        id: "local:workspace",
        kind: "local",
        title: "Local workspace",
        description: "主机环境",
        capabilities: {
            background: false,
            sandbox: false,
            workdir: "local",
        },
    });
}

describe("ShellRouter", () => {
    it("reports danger-full-access as its sandbox mode", () => {
        const { ctx, router } = createFixture();
        expect(router.sandboxMode).toBe("danger-full-access");
        expect(ctx.shell.sandboxMode).toBe("danger-full-access");
    });

    it("rejects resolve until the default host is registered", () => {
        const { router } = createFixture();
        expect(() => router.resolve({ command: "echo hi" })).toThrow(
            /default shell host/
        );
    });

    it("resolves against the inherited local bash defaults", () => {
        const { ctx, router } = createFixture();
        const dispose = registerLocal(ctx);
        const spec = router.resolve({ command: "echo hi" });
        expect(spec.command).toBe("echo hi");
        expect(spec.workdir).toBe(process.cwd());
        expect(spec.timeoutMs).toBe(120_000);
        expect(spec.onExpiry).toBe("kill");
        expect(spec.stdoutMaxBytes).toBe(64_000);
        dispose();
    });

    it("executes the local host through the inherited capability", async () => {
        const { ctx, subprocess } = createFixture();
        registerLocal(ctx);
        const result = await ctx.shellHosts.execute({
            command: "echo hi",
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("hello\n");
        const spawn = subprocess.spawns[0];
        expect(spawn?.argv).toEqual(["bash", "-c", "echo hi"]);
        expect(spawn?.env?.NO_COLOR).toBe("1");
        expect(spawn?.cwd).toBe(process.cwd());
    });

    it("requires the default host before direct execute calls", async () => {
        const { router } = createFixture();
        await expect(
            router.execute({
                command: "echo hi",
                workdir: process.cwd(),
                timeoutMs: 1000,
                onExpiry: "kill",
                stdoutMaxBytes: 64_000,
                sandboxPolicy: undefined,
            })
        ).rejects.toThrow(/default shell host/);
    });

    it("rejects unknown hosts on the registry seam", async () => {
        const { ctx } = createFixture();
        registerLocal(ctx);
        await expect(
            ctx.shellHosts.execute({ command: "ls" }, "sandbox:default")
        ).rejects.toThrow(/unknown shell host/);
    });

    it("composes the validated config with bash budgets", () => {
        const parsed = Config({}) as unknown as ShellRouterConfig;
        expect(parsed.defaultHost).toBe("local:workspace");
        expect(parsed.timeoutMs.get()).toBe(120_000);
        expect(parsed.maxTimeoutMs.get()).toBe(600_000);
        const { router } = createFixture(parsed);
        expect(router.sandboxMode).toBe("danger-full-access");
    });

    it("loads as a Cordis plugin over the subprocess seam", async () => {
        expect(routerPlugin.name).toBe("shell-router");
        expect(routerPlugin.inject).toEqual(["subprocess"]);
        expect(routerPlugin.DEFAULT_HOST).toBe("local:workspace");

        const ctx = new Context();
        new FakeSubprocess(ctx);
        const fiber = await ctx.plugin(routerPlugin, {});
        expect(ctx.shell.sandboxMode).toBe("danger-full-access");
        expect(ctx.shellHosts.defaultHost).toBe("local:workspace");
        expect(() => ctx.shell.resolve({ command: "echo hi" })).toThrow(
            /default shell host/
        );
        await fiber.dispose();
        expect(ctx.get("shell")).toBeUndefined();
        expect(ctx.get("shellHosts")).toBeUndefined();
    });

    it("fails loud for an invalid default host id", async () => {
        const ctx = new Context();
        new FakeSubprocess(ctx);
        const attempt = async (): Promise<void> => {
            await ctx.plugin(routerPlugin, { defaultHost: "workspace" });
        };
        await expect(attempt()).rejects.toThrow(/invalid shell host id/);
    });

    it("rejects a non-string default host in the schema", () => {
        expect(() =>
            Config({ defaultHost: 42 } as unknown as Record<string, never>)
        ).toThrow();
    });
});
