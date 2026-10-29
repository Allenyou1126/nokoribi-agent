import Schema from "@deepseek-ai/schemastery";

type ObjectSchema = ReturnType<typeof Schema.object>;

/**
 * Persistent terminal plugin configuration (19.3.9).
 *
 * Every field has a deployment default; `enabled: false` keeps the plugin
 * loaded but registers no terminal backend.
 */
export interface Config {
    /** Whether persistent terminals are available in this deployment. */
    readonly enabled?: boolean | undefined;
    /** Interactive shell for `local:*` terminals; sandbox ignores it. */
    readonly bashPath?: string | undefined;
    /** Upper bound for one foreground terminal send, in milliseconds. */
    readonly sendTimeoutMs?: number | undefined;
    /** Initial PTY row count. */
    readonly rows?: number | undefined;
    /** Initial PTY column count. */
    readonly cols?: number | undefined;
    /** Maximum retained scrollback lines per terminal. */
    readonly scrollbackLines?: number | undefined;
}

/** Configuration with every default materialized. */
export interface ResolvedConfig {
    readonly enabled: boolean;
    readonly bashPath: string;
    readonly sendTimeoutMs: number;
    readonly rows: number;
    readonly cols: number;
    readonly scrollbackLines: number;
}

/** Deployment defaults; the schema and {@link resolveConfig} share them. */
export const TERMINAL_HOST_DEFAULTS: ResolvedConfig = {
    enabled: true,
    bashPath: "bash",
    sendTimeoutMs: 30000,
    rows: 40,
    cols: 160,
    scrollbackLines: 10000,
};

/**
 * Fill every configuration default.
 * @param config - validated or partial plugin configuration.
 * @returns the configuration with no optional fields left.
 */
export function resolveConfig(config?: Config): ResolvedConfig {
    return {
        enabled: config?.enabled ?? TERMINAL_HOST_DEFAULTS.enabled,
        bashPath: config?.bashPath ?? TERMINAL_HOST_DEFAULTS.bashPath,
        sendTimeoutMs:
            config?.sendTimeoutMs ?? TERMINAL_HOST_DEFAULTS.sendTimeoutMs,
        rows: config?.rows ?? TERMINAL_HOST_DEFAULTS.rows,
        cols: config?.cols ?? TERMINAL_HOST_DEFAULTS.cols,
        scrollbackLines:
            config?.scrollbackLines ?? TERMINAL_HOST_DEFAULTS.scrollbackLines,
    };
}

/** Persistent terminal plugin configuration schema. */
export const Config: ObjectSchema = Schema.object({
    enabled: Schema.boolean()
        .default(TERMINAL_HOST_DEFAULTS.enabled)
        .description(
            "Register persistent terminal backends for terminal hosts."
        ),
    bashPath: Schema.string()
        .default(TERMINAL_HOST_DEFAULTS.bashPath)
        .description(
            "Interactive shell for local terminals; sandbox hosts ignore it."
        ),
    sendTimeoutMs: Schema.number()
        .default(TERMINAL_HOST_DEFAULTS.sendTimeoutMs)
        .min(1)
        .description("Upper bound for one foreground terminal send."),
    rows: Schema.number()
        .default(TERMINAL_HOST_DEFAULTS.rows)
        .min(1)
        .description("Initial PTY row count."),
    cols: Schema.number()
        .default(TERMINAL_HOST_DEFAULTS.cols)
        .min(1)
        .description("Initial PTY column count."),
    scrollbackLines: Schema.number()
        .default(TERMINAL_HOST_DEFAULTS.scrollbackLines)
        .min(1)
        .description("Maximum retained scrollback lines per terminal."),
});
