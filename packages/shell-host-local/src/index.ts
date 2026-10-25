import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import type {
    ShellHostCapabilities,
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
    "主机环境：持久工作区，可访问主机路径与系统命令（可 sudo）；不是隔离环境。";

/** M1 local host capabilities: no background jobs, no permission sandbox. */
export const LOCAL_HOST_CAPABILITIES: ShellHostCapabilities = {
    background: false,
    sandbox: false,
    workdir: "local",
};

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Local host plugin configuration. */
export interface Config {
    /** Host id to register; must keep the `local:` prefix. */
    readonly id?: string | undefined;
    /** Default working directory passed by the daemon (workspace root). */
    readonly workspace?: string | undefined;
}

/** Local host configuration schema; the id has a stable default. */
export const Config: ObjectSchema = Schema.object({
    id: Schema.string()
        .default(LOCAL_HOST_ID)
        .description("Host id to register; must keep the local: prefix."),
    workspace: Schema.string().description(
        "Default working directory; the daemon passes the persistent workspace."
    ),
});

/**
 * Build the local host provider registered with `ctx.shellHosts`.
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

/**
 * Register `local:workspace` with the shell router.
 *
 * Execution reuses the router's inherited local bash capability; the provider
 * only carries metadata in M1 (background jobs and TTL arrive with M3).
 * @param ctx - Cordis context carrying `ctx.shellHosts`.
 * @param config - validated local host configuration.
 * @returns the disposer that unregisters the host with the plugin fiber.
 */
export const apply: (ctx: Context, config?: Config) => () => void = (
    ctx,
    config = {}
) => {
    return ctx.shellHosts.register(
        createLocalHostProvider(config.id ?? LOCAL_HOST_ID, config.workspace)
    );
};
