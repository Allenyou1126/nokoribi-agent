import { Context } from "@deepseek-ai/cordis";
import type {
    ShellExecRequest,
    ShellExecution,
    ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import { ShellHostRegistry } from "@nokoribi/shell-bash";
import { describe, expect, it } from "vitest";

import * as hostPlugin from "../src/index.js";
import {
    Config,
    LOCAL_HOST_CAPABILITIES,
    LOCAL_HOST_DESCRIPTION,
    LOCAL_HOST_ID,
    LOCAL_HOST_TITLE,
    apply,
    createLocalHostProvider,
} from "../src/index.js";

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

function createHostContext(
    spawnBash: (request: ShellExecRequest) => Promise<ShellExecution> = async (
        request
    ) => execution(request.command)
): Context {
    const ctx = new Context();
    new ShellHostRegistry(ctx, {
        defaultHost: LOCAL_HOST_ID,
        spawnBash,
    });
    return ctx;
}

describe("shell-host-local", () => {
    it("exports the Cordis plugin contract", () => {
        expect(hostPlugin.name).toBe("shell-host-local");
        expect(hostPlugin.inject).toEqual(["shellHosts"]);
        expect(typeof hostPlugin.apply).toBe("function");
    });

    it("describes the persistent local workspace host", () => {
        expect(LOCAL_HOST_ID).toBe("local:workspace");
        expect(createLocalHostProvider()).toEqual({
            id: LOCAL_HOST_ID,
            kind: "local",
            title: LOCAL_HOST_TITLE,
            description: LOCAL_HOST_DESCRIPTION,
            capabilities: LOCAL_HOST_CAPABILITIES,
        });
        expect(LOCAL_HOST_CAPABILITIES).toEqual({
            background: true,
            sandbox: false,
            workdir: "local",
        });
    });

    it("registers with the shell router and disposes cleanly", () => {
        const ctx = createHostContext();
        const dispose = apply(ctx, {});
        expect(ctx.shellHosts.list()).toEqual([
            {
                id: LOCAL_HOST_ID,
                kind: "local",
                title: LOCAL_HOST_TITLE,
                description: LOCAL_HOST_DESCRIPTION,
                capabilities: {
                    background: true,
                    sandbox: false,
                    workdir: "local",
                },
            },
        ]);
        expect(ctx.shellHosts.requireDefaultHost().id).toBe(LOCAL_HOST_ID);
        dispose();
        expect(ctx.shellHosts.list()).toEqual([]);
    });

    it("rejects a duplicate registration", () => {
        const ctx = createHostContext();
        apply(ctx, {});
        expect(() => apply(ctx, {})).toThrow(/duplicate shell host id/);
    });

    it("registers under a configured custom id", () => {
        const ctx = createHostContext();
        apply(ctx, { id: "local:dev" });
        expect(ctx.shellHosts.get("local:dev")?.kind).toBe("local");
    });

    it("validates the default host id and extraPackages in configuration", () => {
        const parsed = Config({}) as unknown as {
            id: string;
            extraPackages: string[];
        };
        expect(parsed.id).toBe(LOCAL_HOST_ID);
        expect(parsed.extraPackages).toEqual([]);
        const withPackages = Config({
            extraPackages: ["/nix/store/x/bin"],
        }) as unknown as { extraPackages: string[] };
        expect(withPackages.extraPackages).toEqual(["/nix/store/x/bin"]);
    });

    it("uses the configured workspace as the default workdir", () => {
        const provider = createLocalHostProvider(undefined, "/srv/workspace");
        expect(provider.defaultWorkdir).toBe("/srv/workspace");
        const parsed = Config({
            workspace: "/srv/workspace",
        }) as unknown as { id: string; workspace?: string };
        expect(parsed.id).toBe(LOCAL_HOST_ID);
        expect(parsed.workspace).toBe("/srv/workspace");
    });

    it("prepends extraPackages to PATH and passes the workdir", async () => {
        const requests: ShellExecRequest[] = [];
        const ctx = createHostContext(async (request) => {
            requests.push(request);
            return execution("local output");
        });
        apply(ctx, {
            workspace: "/srv/workspace",
            extraPackages: ["/opt/extra/bin"],
        });
        const result = await ctx.shellHosts.execute({
            command: "echo hi",
            workdir: "/srv/workspace",
        });
        expect(result.stdout.text).toBe("local output");
        expect(requests[0]?.workdir).toBe("/srv/workspace");
        expect(requests[0]?.env?.PATH).toBe(
            `/opt/extra/bin:${process.env.PATH ?? ""}`
        );
    });

    it("falls back to the configured workspace when workdir is omitted", async () => {
        const requests: ShellExecRequest[] = [];
        const ctx = createHostContext(async (request) => {
            requests.push(request);
            return execution();
        });
        apply(ctx, { workspace: "/srv/workspace" });
        await ctx.shellHosts.execute({ command: "ls" });
        expect(requests[0]?.workdir).toBe("/srv/workspace");
    });

    it("starts a background handle with a passed timeout and signal", async () => {
        const requests: ShellExecRequest[] = [];
        const ctx = createHostContext(async (request) => {
            requests.push(request);
            return execution();
        });
        apply(ctx, { workspace: "/srv/workspace" });
        const controller = new AbortController();
        const handle = await ctx.shellHosts.start({
            command: "sleep 1",
            timeoutMs: 5000,
            onExpiry: "none",
            signal: controller.signal,
            sessionId: "main-1",
            runInBackground: true,
        });
        expect(handle.status).toBe("completed");
        expect(requests[0]).toMatchObject({
            command: "sleep 1",
            workdir: "/srv/workspace",
            timeoutMs: 5000,
            onExpiry: "none",
            signal: controller.signal,
        });
    });

    it("loads as a Cordis plugin and disposes with its fiber", async () => {
        const ctx = createHostContext();
        const fiber = await ctx.plugin(hostPlugin);
        expect(ctx.shellHosts.list()).toHaveLength(1);
        await fiber.dispose();
        expect(ctx.shellHosts.list()).toEqual([]);
    });
});
