import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobHandle, JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";
import type { ShellExecution, ShellRunResult } from "@deepseek-ai/dsh-shell";
import type { ShellEnvRegistry } from "@deepseek-ai/dsh-shell-env";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";
import { describe, expect, it } from "vitest";

import { ShellHostRegistry } from "../src/hosts.js";
import type { ShellHostProvider } from "../src/hosts.js";
import { createBashTool, createHostDiscoveryTool } from "../src/tool.js";

function runResult(
    text = "",
    exitCode: number | null = 0,
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

function execution(text = "", result = runResult(text)): ShellExecution {
    return {
        status: "completed",
        exitCode: result.exitCode,
        signal: null,
        done: Promise.resolve(),
        observed: {
            stdout: reader(result.stdout.text),
            stderr: reader(result.stderr.text),
        },
        readOutput: () => ({ delta: text, lossy: false }),
        kill: () => false,
        result: async () => result,
    };
}

function fakeAgent(sessionId = "main-1"): Agent {
    return {
        id: sessionId,
        session: { header: { id: sessionId } },
    } as unknown as Agent;
}

function fakeExec(agent = true): ToolRunContext {
    return {
        callId: "call-1",
        rootCallId: "call-1",
        name: "bash",
        arguments: {},
        signal: new AbortController().signal,
        ...(agent ? { agent: fakeAgent() } : {}),
        deferContext: () => {},
        concludeTurn: () => {},
    } as unknown as ToolRunContext;
}

function makeRegistry(defaultHost: string, providers: ShellHostProvider[]) {
    const ctx = new Context();
    const registry = new ShellHostRegistry(ctx, { defaultHost });
    for (const provider of providers) registry.register(provider);
    return registry;
}

function localProvider(
    onRun?: (request: { command: string; workdir?: string | undefined }) => void
): ShellHostProvider {
    return {
        id: "local:workspace",
        kind: "local",
        title: "Local",
        description: "local host",
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal: false,
        },
        run: async (request) => {
            onRun?.(request);
            return runResult("local output");
        },
        start: async (request) => {
            onRun?.(request);
            return execution("local output");
        },
    };
}

function sandboxProvider(
    onStart?: (request: {
        command: string;
        workdir?: string | undefined;
        sessionId?: string | undefined;
    }) => void
): ShellHostProvider {
    return {
        id: "sandbox:default",
        kind: "sandbox",
        title: "Sandbox",
        description: "sandbox host",
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal: false,
        },
        run: async (request) => {
            onStart?.(request);
            return runResult("sandbox output");
        },
        start: async (request) => {
            onStart?.(request);
            return execution("sandbox output");
        },
    };
}

function fakeJobs(capture: (spec: JobSpec) => void): JobRegistry {
    return {
        start: (spec: JobSpec) => {
            capture(spec);
            return "bash-1";
        },
    } as unknown as JobRegistry;
}

const shellEnv = {
    collect: () => ({ DSH_HOME: "/tmp/home" }),
} as unknown as ShellEnvRegistry;

const workingDirectory = {
    ensure: async () => "/srv/workspace",
} as unknown as WorkingDirectoryService;

describe("bash tool", () => {
    it("runs on the default host and renders the foreground result", async () => {
        const needs: string[] = [];
        const registry = makeRegistry("local:workspace", [
            localProvider((request) => {
                if (request.workdir !== undefined) needs.push(request.workdir);
            }),
        ]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        const args = { command: "echo hi", description: "Echo a greeting" };
        const value = await tool.execute(args, fakeExec());
        expect(value).toMatchObject({
            kind: "foreground",
            host: "local:workspace",
            exitCode: 0,
        });
        expect(needs).toEqual(["/srv/workspace"]);
        const blocks = tool.output.render(args, value as never);
        expect(blocks).toEqual([{ type: "text", text: "local output" }]);
    });

    it("resolves a relative local workdir against the session cwd", async () => {
        const workdirs: (string | undefined)[] = [];
        const registry = makeRegistry("local:workspace", [
            localProvider((request) => workdirs.push(request.workdir)),
        ]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        await tool.execute(
            { command: "pwd", description: "Print cwd", workdir: "sub" },
            fakeExec()
        );
        expect(workdirs).toEqual(["/srv/workspace/sub"]);
    });

    it("leaves a relative sandbox workdir for the provider", async () => {
        const workdirs: (string | undefined)[] = [];
        const registry = makeRegistry("sandbox:default", [
            sandboxProvider((request) => workdirs.push(request.workdir)),
        ]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        await tool.execute(
            { command: "pwd", description: "Print cwd", workdir: "sub" },
            fakeExec()
        );
        expect(workdirs).toEqual(["sub"]);
    });

    it("renders timeout and exit markers", async () => {
        const registry = makeRegistry("local:workspace", [
            {
                ...localProvider(),
                run: async () =>
                    runResult("", null, {
                        timedOut: true,
                        timeoutMs: 250,
                        stderr: { text: "boom", truncated: false },
                    }),
            },
        ]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        const value = await tool.execute(
            { command: "false", description: "Fail" },
            fakeExec()
        );
        const blocks = tool.output.render(
            { command: "false", description: "Fail" },
            value as never
        );
        expect(blocks[0]).toMatchObject({ type: "text" });
        expect((blocks[0] as { text: string }).text).toContain("[stderr]");
        expect((blocks[0] as { text: string }).text).toContain(
            "[timed out after 250ms]"
        );
        expect((blocks[0] as { text: string }).text).not.toContain(
            "[exit code: 3]"
        );
    });

    it("rejects unknown hosts and lists registered ids", async () => {
        const registry = makeRegistry("local:workspace", [localProvider()]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        await expect(
            tool.execute(
                {
                    command: "ls",
                    description: "List files",
                    host: "sandbox:missing",
                },
                fakeExec()
            )
        ).rejects.toThrow(/unknown shell host[\s\S]*local:workspace/);
    });

    it("starts a background job and opens it with ctx.jobs", async () => {
        let spec: JobSpec | undefined;
        const registry = makeRegistry("local:workspace", [localProvider()]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
            jobs: fakeJobs((captured) => {
                spec = captured;
            }),
        });
        const value = await tool.execute(
            {
                command: "sleep 1",
                description: "Sleep briefly",
                run_in_background: true,
            },
            fakeExec()
        );
        expect(value).toEqual({
            kind: "background",
            host: "local:workspace",
            jobId: "bash-1",
        });
        expect(spec).toMatchObject({
            kind: "bash",
            label: "sleep 1",
            owner: "main-1",
        });
        expect(spec?.run).toBeTypeOf("function");

        const handle: JobHandle = {
            id: "bash-1" as JobHandle["id"],
            append: () => {},
            updateProgress: () => {},
        };
        const hooks = spec!.run(handle);
        await expect(hooks.done).resolves.toMatchObject({
            status: "completed",
            detail: "exit code: 0",
        });
    });

    it("rejects background work when the host lacks the capability", async () => {
        const registry = makeRegistry("local:workspace", [
            {
                ...localProvider(),
                capabilities: {
                    background: false,
                    sandbox: false,
                    workdir: "local",
                    terminal: false,
                },
                start: undefined,
            },
        ]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
            jobs: fakeJobs(() => {}),
        });
        await expect(
            tool.execute(
                {
                    command: "sleep 1",
                    description: "Sleep briefly",
                    run_in_background: true,
                },
                fakeExec()
            )
        ).rejects.toThrow(/does not support background jobs/);
    });

    it("rejects background work without a job registry", async () => {
        const registry = makeRegistry("local:workspace", [localProvider()]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        await expect(
            tool.execute(
                {
                    command: "sleep 1",
                    description: "Sleep briefly",
                    run_in_background: true,
                },
                fakeExec()
            )
        ).rejects.toThrow(/background jobs unavailable/);
    });

    it("validates empty commands and descriptions", async () => {
        const registry = makeRegistry("local:workspace", [localProvider()]);
        const tool = createBashTool({
            shellHosts: registry,
            shellEnv,
            workingDirectory,
        });
        await expect(
            tool.execute({ command: " ", description: "x" }, fakeExec())
        ).rejects.toThrow(/invalid command/);
        await expect(
            tool.execute({ command: "ls", description: " " }, fakeExec())
        ).rejects.toThrow(/invalid description/);
        await expect(
            tool.execute(
                { command: "ls", description: "x", timeoutMs: 0 },
                fakeExec()
            )
        ).rejects.toThrow(/invalid timeoutMs/);
    });
});

describe("host discovery tool", () => {
    it("returns the default and registered hosts", async () => {
        const registry = makeRegistry("sandbox:default", [
            sandboxProvider(),
            localProvider(),
        ]);
        const tool = createHostDiscoveryTool({ shellHosts: registry });
        const value = await tool.execute({}, fakeExec(false));
        expect(value).toEqual({
            default: "sandbox:default",
            hosts: [
                {
                    id: "local:workspace",
                    kind: "local",
                    description: "local host",
                    background: true,
                    workdir: "local",
                    terminal: false,
                },
                {
                    id: "sandbox:default",
                    kind: "sandbox",
                    description: "sandbox host",
                    background: true,
                    workdir: "local",
                    terminal: false,
                },
            ],
        });
        const blocks = tool.output.render({}, value as never);
        expect((blocks[0] as { text: string }).text).toContain(
            '"sandbox:default"'
        );
    });

    it("hides terminal support when no backend is registered", async () => {
        const registry = makeRegistry("local:workspace", [
            {
                ...localProvider(),
                capabilities: {
                    background: true,
                    sandbox: false,
                    workdir: "local",
                    terminal: true,
                },
                terminal: async () => ({
                    argv: ["bash", "-i"],
                    cwd: "/work",
                }),
            },
        ]);
        const tool = createHostDiscoveryTool({
            shellHosts: registry,
            terminalAvailable: () => false,
        });
        const value = await tool.execute({}, fakeExec(false));
        const hosts = (value as { hosts: { terminal: boolean }[] }).hosts;
        expect(hosts[0]?.terminal).toBe(false);
    });
});
