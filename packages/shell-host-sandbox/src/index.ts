import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createLogger } from "@nokoribi/shared";

import { SandboxHost } from "./host.js";
import type { SandboxHostConfig, SandboxStatus } from "./host.js";
import { createSandboxTools } from "./tools.js";

export { SandboxHost };
export type { SandboxHostConfig, SandboxStatus };
export {
    SANDBOX_PACKAGES_TOOL_NAME,
    SANDBOX_TOOL_NAME,
    createSandboxTools,
} from "./tools.js";
export { GUARDED_COMMANDS, ensurePathGuard } from "./guard.js";
export { buildSandboxCommand, shellQuote } from "./command.js";

/** Plugin name used by Cordis diagnostics. */
export const name: string = "shell-host-sandbox";

/** The host registry, tools and executable resolution must exist first. */
export const inject: string[] = ["shellHosts", "tools", "subprocess"];

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Validated sandbox host configuration. */
export type Config = SandboxHostConfig;

/** Sandbox host configuration schema; every field has a deployment default. */
export const Config: ObjectSchema = Schema.object({
    id: Schema.string()
        .default("sandbox:default")
        .description("Host id to register; must keep the sandbox: prefix."),
    root: Schema.string()
        .required()
        .description("Per-session sandbox root ($DSH_HOME/sandboxes)."),
    workspace: Schema.string()
        .required()
        .description("Persistent workspace exposed as DSH_WORKSPACE_DIR."),
    baseEnvironment: Schema.string()
        .default("")
        .description(
            "Absolute Nix buildEnv store path; empty disables execution."
        ),
    shellHook: Schema.string()
        .default("")
        .description("Trusted shellHook evaluated before each command."),
    idleTtlMs: Schema.number()
        .default(30 * 60 * 1000)
        .min(1)
        .description("Idle time before the sandbox is reclaimed."),
    sweepIntervalMs: Schema.number()
        .default(60 * 1000)
        .min(1)
        .description("Interval between TTL sweeps."),
    allowRuntimePackages: Schema.boolean()
        .default(true)
        .description("Allow sandbox_packages to realize runtime packages."),
    nixBinary: Schema.string()
        .default("nix")
        .description("Nix binary used for temporary package layers."),
    nixTimeoutMs: Schema.number()
        .default(120 * 1000)
        .min(1)
        .description("Timeout for nix package-validation commands."),
    noNewPrivilegesCommand: Schema.string()
        .default("")
        .description("setpriv path/name; empty resolves setpriv from PATH."),
});

/**
 * Register the sandbox host and its control tools.
 * @param ctx - Cordis context carrying the host, tool and subprocess seams.
 * @param config - validated sandbox configuration.
 */
export function apply(ctx: Context, config: SandboxHostConfig): void {
    const logger = createLogger("sandbox");
    const host = new SandboxHost(config, {
        spawnBash: (request) => ctx.shellHosts.spawnBash(request),
        resolveExecutable: (command, env) =>
            ctx.subprocess.resolveExecutable(
                command,
                env === undefined
                    ? undefined
                    : (Object.fromEntries(
                          Object.entries(env).filter(
                              (entry): entry is [string, string] =>
                                  entry[1] !== undefined
                          )
                      ) as Record<string, string>)
            ),
        logger,
    });
    const unregister = ctx.shellHosts.register(host);
    ctx.effect(() => () => {
        unregister();
        host.dispose();
    });
    const tools = createSandboxTools(host);
    ctx.effect(() => ctx.tools.register(tools.sandbox));
    ctx.effect(() => ctx.tools.register(tools.packages));
}
