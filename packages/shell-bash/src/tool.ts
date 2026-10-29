import { isAbsolute, join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { JobRegistry } from "@deepseek-ai/dsh-jobs";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ShellExecution } from "@deepseek-ai/dsh-shell";
import { DSH_ENV_PREFIX } from "@deepseek-ai/dsh-shell";
import type { ShellEnvRegistry } from "@deepseek-ai/dsh-shell-env";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";

import { processJob, processOutcome, processSources } from "./background.js";
import type { ShellHostExecRequest, ShellHostRegistry } from "./hosts.js";
import {
    BASH_SECTION_NAME,
    BASH_SECTION_PROMPT,
    HOSTS_SECTION_NAME,
    HOSTS_SECTION_ORDER,
    renderHostsPrompt,
} from "./prompt.js";
import { renderForeground, toStreamValue } from "./render.js";
import type { BashForegroundValue } from "./render.js";

/** Model-facing bash tool name. */
export const BASH_TOOL_NAME: string = "bash";

/** Model-facing host discovery tool name. */
export const DISCOVERY_TOOL_NAME: string = "get_available_shell_host";

/** Services the model-facing shell tools consume. */
export interface BashToolDependencies {
    readonly shellHosts: ShellHostRegistry;
    readonly shellEnv: ShellEnvRegistry;
    readonly workingDirectory: WorkingDirectoryService;
    readonly jobs?: JobRegistry | undefined;
    /**
     * Whether a terminal backend is registered for one host. The terminal
     * service is optional at this layer, so prompt/discovery output uses this
     * predicate instead of the provider's static capability bit.
     */
    readonly terminalAvailable?: ((hostId: string) => boolean) | undefined;
}

/** Background bash result shown to the model. */
export interface BashBackgroundValue {
    readonly kind: "background";
    readonly host: string;
    readonly jobId: string;
}

/** Discovery result returned by `get_available_shell_host`. */
export interface ShellDiscoveryValue {
    readonly default: string;
    readonly hosts: readonly {
        readonly id: string;
        readonly kind: string;
        readonly description: string;
        readonly background: boolean;
        readonly workdir: "local" | "remote";
        readonly terminal: boolean;
    }[];
}

function toolAborted(): HarnessError {
    const error = new HarnessError("tool call aborted", TOOL_ABORTED);
    error.name = "AbortError";
    return error;
}

function validateBashArgs(args: {
    readonly command: string;
    readonly description: string;
    readonly timeoutMs?: number | undefined;
}): void {
    if (args.command.trim() === "") {
        throw new Error("invalid command: expected a non-empty string");
    }
    if (args.description.trim() === "") {
        throw new Error("invalid description: expected a non-empty string");
    }
    if (
        args.timeoutMs !== undefined &&
        (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
    ) {
        throw new Error(
            `invalid timeoutMs: expected a positive number, got ` +
                JSON.stringify(args.timeoutMs)
        );
    }
}

function bashDescription(): string {
    return `Execute a bash command (\`bash -c\`) on a shell host and return its stdout/stderr. Each call runs in a fresh shell; pass \`workdir\` instead of using \`cd\`. Omit \`host\` for the default host; use \`get_available_shell_host\` to list hosts. The sandbox host is a disposable clean environment, not the workspace: use \`$${DSH_ENV_PREFIX}SANDBOX_DIR\` and \`$${DSH_ENV_PREFIX}WORKSPACE_DIR\` with cp/rsync, and write important artifacts back to the workspace. The local host is the real host environment and may use sudo (reviewed by Auto review); the sandbox cannot sudo. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Provide \`description\` before \`command\` in the arguments. Before any delete or move, verify the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with \`\${VAR:?}\`.`;
}

function discoveryDescription(): string {
    return "List the configured shell hosts (id, kind, description, background and workdir support) and the default host. Call this before using a host name you are unsure about.";
}

function resolveLocalWorkdir(
    modelWorkdir: string | undefined,
    sessionCwd: string | undefined
): string | undefined {
    if (modelWorkdir === undefined) return sessionCwd;
    if (isAbsolute(modelWorkdir) || sessionCwd === undefined) {
        return modelWorkdir;
    }
    return join(sessionCwd, modelWorkdir);
}

function startBackgroundJob(
    jobs: JobRegistry,
    shellHosts: ShellHostRegistry,
    request: ShellHostExecRequest,
    hostId: string,
    exec: ToolRunContext
): string {
    let process: ShellExecution | undefined;
    return jobs.start({
        kind: "bash",
        label: request.command,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        toolCall: {
            callId: exec.callId,
            rootCallId: exec.rootCallId,
        },
        output: processSources(() => process),
        run: () =>
            processJob(async (signal) => {
                process = await shellHosts.start(
                    {
                        ...request,
                        signal,
                        onExpiry: "none",
                        runInBackground: true,
                    },
                    hostId
                );
                return process;
            }, processOutcome),
    });
}

/**
 * Build the model-facing `bash` tool.
 * @param deps - host registry, managed environment, working directory, jobs.
 * @returns the tool definition registered by {@link apply}.
 */
export function createBashTool(deps: BashToolDependencies): ToolDefinition {
    return defineTool({
        name: BASH_TOOL_NAME,
        description: bashDescription(),
        parameters: {
            description: {
                type: "string",
                required: true,
                description:
                    'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status".',
            },
            command: {
                type: "string",
                required: true,
                description: "The bash command to execute.",
            },
            host: {
                type: "string",
                description:
                    "Shell host id; omit for the default host. Use get_available_shell_host to list ids.",
            },
            timeoutMs: {
                type: "number",
                description:
                    "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.",
            },
            workdir: {
                type: "string",
                description:
                    "Working directory. local: relative to the session workspace; sandbox: relative to the sandbox temporary directory. Absolute paths are host paths.",
            },
            run_in_background: {
                type: "boolean",
                description:
                    "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.",
            },
        },
        output: {
            schema: {
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            kind: {
                                type: "string",
                                required: true,
                                const: "background",
                            },
                            host: { type: "string", required: true },
                            jobId: { type: "string", required: true },
                        },
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            kind: {
                                type: "string",
                                required: true,
                                const: "foreground",
                            },
                            host: { type: "string", required: true },
                            exitCode: {
                                required: true,
                                oneOf: [{ type: "integer" }, { type: "null" }],
                            },
                            signal: {
                                required: true,
                                oneOf: [{ type: "string" }, { type: "null" }],
                            },
                            timedOut: { type: "boolean", required: true },
                            aborted: { type: "boolean", required: true },
                            timeoutMs: { type: "number", required: true },
                            stdout: {
                                type: "object",
                                additionalProperties: false,
                                required: true,
                                properties: {
                                    text: { type: "string", required: true },
                                    truncated: {
                                        type: "boolean",
                                        required: true,
                                    },
                                    spillPath: { type: "string" },
                                },
                            },
                            stderr: {
                                type: "object",
                                additionalProperties: false,
                                required: true,
                                properties: {
                                    text: { type: "string", required: true },
                                    truncated: {
                                        type: "boolean",
                                        required: true,
                                    },
                                    spillPath: { type: "string" },
                                },
                            },
                        },
                    },
                ],
            },
            render: (_args, value) => [
                {
                    type: "text",
                    text:
                        value.kind === "background"
                            ? `started background job ${value.jobId}`
                            : renderForeground(value as BashForegroundValue),
                },
            ],
            presentationMeta: (_args, value) => ({ host: value.host }),
        },
        async execute(args, exec) {
            validateBashArgs(args);
            const hostId = args.host ?? deps.shellHosts.defaultHost;
            const host = deps.shellHosts.get(hostId);
            if (host === undefined) {
                const registered = deps.shellHosts
                    .list()
                    .map((entry) => entry.id);
                throw new Error(
                    `unknown shell host "${hostId}" (registered: ${
                        registered.length === 0 ? "none" : registered.join(", ")
                    }); use get_available_shell_host`
                );
            }
            if (exec.signal.aborted) throw toolAborted();

            let sessionCwd: string | undefined;
            if (host.kind === "local" && exec.agent !== undefined) {
                sessionCwd = await deps.workingDirectory.ensure(
                    exec.agent,
                    exec.signal
                );
            }
            const workdir =
                host.kind === "local"
                    ? resolveLocalWorkdir(args.workdir, sessionCwd)
                    : args.workdir;
            const dshEnv = deps.shellEnv.collect(exec);
            const request: ShellHostExecRequest = {
                command: args.command,
                ...(workdir === undefined ? {} : { workdir }),
                ...(args.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: args.timeoutMs }),
                signal: exec.signal,
                dshEnv,
                ...(exec.agent === undefined
                    ? {}
                    : { sessionId: exec.agent.session.header.id }),
                ...(args.run_in_background === true
                    ? { runInBackground: true }
                    : {}),
            };

            if (args.run_in_background === true) {
                if (!host.capabilities.background) {
                    throw new Error(
                        `shell host "${host.id}" does not support background jobs`
                    );
                }
                const jobs = deps.jobs;
                if (jobs === undefined) {
                    throw new Error(
                        "background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs"
                    );
                }
                const jobId = startBackgroundJob(
                    jobs,
                    deps.shellHosts,
                    request,
                    host.id,
                    exec
                );
                return {
                    kind: "background" as const,
                    host: host.id,
                    jobId,
                };
            }

            const result = await deps.shellHosts.execute(request, host.id);
            if (result.aborted) throw toolAborted();
            return {
                kind: "foreground" as const,
                host: host.id,
                exitCode: result.exitCode,
                signal: result.signal,
                timedOut: result.timedOut,
                aborted: result.aborted,
                timeoutMs: result.timeoutMs,
                stdout: toStreamValue(result.stdout),
                stderr: toStreamValue(result.stderr),
            };
        },
    });
}

/**
 * Build the host discovery tool.
 * @param deps - the shell host registry.
 * @returns the tool definition registered by {@link apply}.
 */
export function createHostDiscoveryTool(
    deps: Pick<BashToolDependencies, "shellHosts" | "terminalAvailable">
): ToolDefinition {
    return defineTool({
        name: DISCOVERY_TOOL_NAME,
        description: discoveryDescription(),
        parameters: {},
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    default: { type: "string", required: true },
                    hosts: {
                        type: "array",
                        required: true,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                id: { type: "string", required: true },
                                kind: { type: "string", required: true },
                                description: {
                                    type: "string",
                                    required: true,
                                },
                                background: {
                                    type: "boolean",
                                    required: true,
                                },
                                workdir: {
                                    type: "string",
                                    required: true,
                                    enum: ["local", "remote"],
                                },
                                terminal: {
                                    type: "boolean",
                                    required: true,
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [
                { type: "text", text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute() {
            return {
                default: deps.shellHosts.defaultHost,
                hosts: deps.shellHosts.list().map((host) => ({
                    id: host.id,
                    kind: host.kind,
                    description: host.description,
                    background: host.capabilities.background,
                    workdir: host.capabilities.workdir,
                    terminal:
                        host.capabilities.terminal &&
                        (deps.terminalAvailable?.(host.id) ?? true),
                })),
            };
        },
    });
}

/** Plugin name used by Cordis diagnostics. */
export const name: string = "tool-bash-hosted";

/** Services the tool plugin requires before it activates. */
export const inject: string[] = [
    "tools",
    "shellHosts",
    "systemPrompt",
    "shellEnv",
    "workingDirectory",
    "jobs",
];

/**
 * Register the model-facing bash and host discovery tools plus their prompt
 * guidance.
 * @param ctx - Cordis context carrying every required service.
 */
export function apply(ctx: Context): void {
    const terminalTypes = (): ReadonlySet<string> => {
        const terminals = ctx.get("terminals") as
            | { listBackends(): string[] }
            | undefined;
        return new Set(terminals?.listBackends() ?? []);
    };
    const terminalAvailable = (hostId: string): boolean =>
        terminalTypes().has(hostId);
    ctx.systemPrompt.section({
        name: HOSTS_SECTION_NAME,
        order: HOSTS_SECTION_ORDER,
        text: () =>
            renderHostsPrompt(
                ctx.shellHosts.defaultHost,
                ctx.shellHosts.list(),
                terminalTypes().size > 0
            ),
        interpolate: false,
    });
    ctx.systemPrompt.section({
        name: BASH_SECTION_NAME,
        order: ctx.systemPrompt.getSectionOrder("TOOL_BASH"),
        text: BASH_SECTION_PROMPT,
        interpolate: false,
    });
    const deps: BashToolDependencies = {
        shellHosts: ctx.shellHosts,
        shellEnv: ctx.shellEnv,
        workingDirectory: ctx.workingDirectory,
        jobs: ctx.jobs,
        terminalAvailable,
    };
    ctx.tools.register(createBashTool(deps));
    ctx.tools.register(createHostDiscoveryTool(deps));
}
