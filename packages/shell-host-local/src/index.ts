import { delimiter } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecution, ShellRunResult } from "@deepseek-ai/dsh-shell";
import Schema from "@deepseek-ai/schemastery";
import type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostProvider,
} from "@nokoribi/shell-bash";

/** Plugin name used by Cordis diagnostics. */
export const name: string = "shell-host-local";

/** The router's host registry must exist before a provider can register. */
export const inject: string[] = ["shellHosts"];

/** Host id of the persistent local host (D29). */
export const LOCAL_HOST_ID: string = "local:workspace";

/** Short human-readable host title. */
export const LOCAL_HOST_TITLE: string = "Local workspace";

/** Model-facing description; kept short for host discovery (07.4). */
export const LOCAL_HOST_DESCRIPTION: string =
    "主机环境：持久工作区，可访问主机路径与系统命令（可 sudo，经 Auto review）；不是隔离环境。";

/** M3 local host capabilities: foreground and background, no DSH sandbox. */
export const LOCAL_HOST_CAPABILITIES: ShellHostCapabilities = {
    background: true,
    sandbox: false,
    workdir: "local",
};

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Local host plugin configuration. */
export interface Config {
    /** Whether this host should register; deployment can disable it. */
    readonly enabled?: boolean | undefined;
    /** Host id to register; must keep the `local:` prefix. */
    readonly id?: string | undefined;
    /** Default working directory passed by the daemon (workspace root). */
    readonly workspace?: string | undefined;
    /** Extra executable directories prepended to PATH (D77). */
    readonly extraPackages?: readonly string[] | undefined;
}

/** Local host configuration schema; the id has a stable default. */
export const Config: ObjectSchema = Schema.object({
    enabled: Schema.boolean()
        .default(true)
        .description("Register the local host for model use."),
    id: Schema.string()
        .default(LOCAL_HOST_ID)
        .description("Host id to register; must keep the local: prefix."),
    workspace: Schema.string().description(
        "Default working directory; the daemon passes the persistent workspace."
    ),
    extraPackages: Schema.array(Schema.string())
        .default([])
        .description(
            "Directories prepended to PATH for local commands (Nix makeBinPath output)."
        ),
});

/**
 * Build the local host metadata registered with `ctx.shellHosts`.
 * @param id - host id override; defaults to `local:workspace`.
 * @param workspace - default working directory for local commands.
 * @returns provider metadata for the persistent local host.
 */
export function createLocalHostProvider(
    id?: string,
    workspace?: string
): ShellHostProvider {
    return {
        id: id ?? LOCAL_HOST_ID,
        kind: "local",
        title: LOCAL_HOST_TITLE,
        description: LOCAL_HOST_DESCRIPTION,
        capabilities: LOCAL_HOST_CAPABILITIES,
        ...(workspace === undefined ? {} : { defaultWorkdir: workspace }),
    };
}

function localPath(
    extraPackages: readonly string[],
    requested: Readonly<Record<string, string>> | undefined
): string {
    const entries = [
        ...extraPackages,
        requested?.PATH ?? process.env.PATH ?? "",
    ].filter((entry) => entry.trim() !== "");
    return entries.join(delimiter);
}

/**
 * Register `local:workspace` with the shell router.
 *
 * Execution reuses the router's inherited bash mechanics through
 * `ctx.shellHosts.spawnBash`, adding the deployment's extra PATH entries.
 * @param ctx - Cordis context carrying `ctx.shellHosts`.
 * @param config - validated local host configuration.
 * @returns the disposer that unregisters the host with the plugin fiber.
 */
export const apply: (ctx: Context, config?: Config) => () => void = (
    ctx,
    config = {}
) => {
    if (config.enabled === false) return () => {};
    const id = config.id ?? LOCAL_HOST_ID;
    const extraPackages = config.extraPackages ?? [];
    const start = async (
        request: ShellHostExecRequest
    ): Promise<ShellExecution> => {
        const workdir = request.workdir ?? config.workspace;
        const path = localPath(extraPackages, request.env);
        return await ctx.shellHosts.spawnBash({
            command: request.command,
            ...(workdir === undefined ? {} : { workdir }),
            ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
            ...(request.onExpiry === undefined
                ? {}
                : { onExpiry: request.onExpiry }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            env: { ...request.env, PATH: path },
            ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
        });
    };
    const run = async (
        request: ShellHostExecRequest
    ): Promise<ShellRunResult> => {
        return await (await start(request)).result();
    };
    return ctx.shellHosts.register({
        ...createLocalHostProvider(id, config.workspace),
        run,
        start,
    });
};
