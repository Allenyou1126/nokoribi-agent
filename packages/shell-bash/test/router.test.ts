import { Context } from "@deepseek-ai/cordis";
import type { Volatile } from "@deepseek-ai/cordis";
import type { ShellExecution } from "@deepseek-ai/dsh-shell";
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
    const start = async (request: {
        command: string;
        workdir?: string | undefined;
        timeoutMs?: number | undefined;
        onExpiry?: "kill" | "none" | undefined;
        signal?: AbortSignal | undefined;
        env?: Readonly<Record<string, string>> | undefined;
    }): Promise<ShellExecution> =>
        await ctx.shellHosts.spawnBash({
            command: request.command,
            ...(request.workdir === undefined
                ? {}
                : { workdir: request.workdir }),
            ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
            ...(request.onExpiry === undefined
                ? {}
                : { onExpiry: request.onExpiry }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.env === undefined ? {} : { env: request.env }),
        });
    return ctx.shellHosts.register({
        id: "local:workspace",
        kind: "local",
        title: "Local workspace",
        description: "主机环境",
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal: false,
        },
        start,
        run: async (request) => await (await start(request)).result(),
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

    it("serves ctx.shell through the local default host", async () => {
        const { ctx, subprocess } = createFixture();
        registerLocal(ctx);
        const result = await ctx.shell
            .execute(ctx.shell.resolve({ command: "echo hi" }))
            .then((execution) => execution.result());
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("hello\n");
        const spawn = subprocess.spawns[0];
        expect(spawn?.argv).toEqual(["bash", "-c", "echo hi"]);
        expect(spawn?.env?.NO_COLOR).toBe("1");
        expect(spawn?.cwd).toBe(process.cwd());
    });

    it("routes ctx.shellHosts execution through the local provider", async () => {
        const { ctx, subprocess } = createFixture();
        registerLocal(ctx);
        const result = await ctx.shellHosts.execute({
            command: "echo hi",
        });
        expect(result.stdout.text).toBe("hello\n");
        expect(subprocess.spawns[0]?.argv).toEqual(["bash", "-c", "echo hi"]);
    });

    it("fails closed for a sandbox default host on the sessionless facade", async () => {
        const { ctx } = createFixture(
            routerConfig({ defaultHost: "sandbox:default" })
        );
        ctx.shellHosts.register({
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
            start: async () => {
                throw new Error("not used");
            },
        });
        await expect(
            ctx.shell.execute(
                ctx.shell.resolve({
                    command: "echo hi",
                    workdir: process.cwd(),
                })
            )
        ).rejects.toThrow(/without a session/);
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
        expect(parsed.defaultHost).toBe("sandbox:default");
        expect(parsed.timeoutMs.get()).toBe(120_000);
        expect(parsed.maxTimeoutMs.get()).toBe(600_000);
        const { router } = createFixture(parsed);
        expect(router.sandboxMode).toBe("danger-full-access");
    });

    it("loads as a Cordis plugin over the subprocess seam", async () => {
        expect(routerPlugin.name).toBe("shell-router");
        expect(routerPlugin.inject).toEqual(["subprocess"]);
        expect(routerPlugin.DEFAULT_HOST).toBe("sandbox:default");

        const ctx = new Context();
        new FakeSubprocess(ctx);
        const fiber = await ctx.plugin(routerPlugin, {});
        expect(ctx.shell.sandboxMode).toBe("danger-full-access");
        expect(ctx.shellHosts.defaultHost).toBe("sandbox:default");
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
