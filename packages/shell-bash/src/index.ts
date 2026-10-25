import type { Context } from "@deepseek-ai/cordis";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import Schema from "@deepseek-ai/schemastery";

import { ShellHostRegistry } from "./hosts.js";
import type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostInfo,
    ShellHostKind,
    ShellHostProvider,
    ShellHostRegistryOptions,
    ShellHostRunner,
    ShellHostStarter,
} from "./hosts.js";
import { ShellRouter } from "./router.js";
import type { ShellRouterConfig } from "./router.js";

export { ShellHostRegistry };
export type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostInfo,
    ShellHostKind,
    ShellHostProvider,
    ShellHostRegistryOptions,
    ShellHostRunner,
    ShellHostStarter,
};
export { ShellRouter };
export type { ShellRouterConfig };

/** Plugin name used by Cordis diagnostics. */
export const name: string = "shell-router";

/** The inherited local bash capability needs the subprocess seam. */
export const inject: string[] = ["subprocess"];

/** M3 default host: the clean disposable sandbox (D49). */
export const DEFAULT_HOST: string = "sandbox:default";

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Validated router config: LocalBashExecutor budgets plus defaultHost. */
export type Config = ShellRouterConfig;

/** Router configuration schema, reusing the bash executor's budget fields. */
export const Config: ObjectSchema = Schema.object({
    ...LocalBashExecutor.Config.dict,
    defaultHost: Schema.string()
        .default(DEFAULT_HOST)
        .description("Shell host id used when a caller does not name one."),
});

/**
 * Load the shell router: it provides `ctx.shell` and `ctx.shellHosts`.
 * @param ctx - Cordis context that owns both services.
 * @param config - validated router configuration.
 */
export function apply(ctx: Context, config: ShellRouterConfig): void {
    new ShellRouter(ctx, config);
}
