import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createLogger } from "@nokoribi/shared";

import { TerminalHostController } from "./backends.js";
import { Config as ConfigSchema, resolveConfig } from "./config.js";
import type { Config as TerminalHostConfig } from "./config.js";
import { registerPtyPrompt } from "./prompt.js";

type ObjectSchema = ReturnType<typeof Schema.object>;

export { TerminalHostController };
export { TERMINAL_HOST_DEFAULTS } from "./config.js";
export type { ResolvedConfig } from "./config.js";
export {
    PTY_DISABLED_PROMPT,
    PTY_SECTION_NAME,
    PTY_SECTION_ORDER,
    PTY_SECTION_PROMPT,
    registerPtyPrompt,
} from "./prompt.js";
export { createHostTerminalSpawner } from "./spawn.js";
export type { HostTerminalSpawner, SpawnLogger } from "./spawn.js";

/** Persistent terminal plugin configuration accepted by {@link apply}. */
export type Config = TerminalHostConfig;

/** Plugin name used by Cordis diagnostics. */
export const name: string = "terminal-host";

/** Every service the terminal host plugin composes. */
export const inject: string[] = [
    "terminals",
    "shellHosts",
    "subprocess",
    "sandboxPolicy",
    "sessionProjections",
    "workingDirectory",
    "systemPrompt",
];

/** Persistent terminal plugin configuration schema. */
export const Config: ObjectSchema = ConfigSchema;

/**
 * Mount host-aware persistent terminals.
 *
 * The prompt section is always registered: a disabled deployment states that
 * fact so the model does not try unavailable tools. Enabled deployments then
 * follow `ctx.shellHosts` and keep one `BashTerminalBackend` per
 * terminal-capable host alive until the plugin or the host disappears.
 * @param ctx - Cordis context carrying every injected service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
    const resolved = resolveConfig(config);
    registerPtyPrompt(ctx, resolved.enabled);
    if (!resolved.enabled) return;
    const controller = new TerminalHostController(
        ctx,
        resolved,
        createLogger("terminal-host")
    );
    controller.start();
    ctx.effect(() => () => controller.dispose());
}
