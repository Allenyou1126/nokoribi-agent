import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createLogger } from "@nokoribi/shared";

import { MemorySnapshotInjector, resolveInjectConfig } from "./inject.js";
import type { MemoryInjectConfig } from "./inject.js";
import { MemoryService } from "./store.js";
import type { MemoryServiceConfig } from "./store.js";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./store.js";
import { createMemoryTool } from "./tool.js";

/** Plugin name used by Cordis diagnostics. */
export const name: string = "memory";

/** The tool registry and prompt registry must exist before injection. */
export const inject: string[] = ["tools", "systemPrompt", "agents"];

export { MemoryService };
export type {
    MemorySearchOptions,
    MemoryServiceConfig,
    MemoryRuntimeStatus,
    MemoryStats,
    MemoryWriteInput,
} from "./store.js";
export {
    ARCHIVE_DIR_NAME,
    DEFAULT_SEARCH_LIMIT,
    ENTRIES_DIR_NAME,
    MAX_MEMORY_BODY_BYTES,
    MAX_MEMORY_TAGS,
    MAX_MEMORY_TITLE_BYTES,
    MAX_SEARCH_LIMIT,
    MEMORY_FILE_SUFFIX,
    MEMORY_ID_PATTERN,
    MEMORY_TAG_PATTERN,
    MIN_MEMORY_TAGS,
    generateMemoryId,
} from "./store.js";
export * from "./frontmatter.js";
export * from "./inject.js";
export * from "./secret.js";
export * from "./snapshot.js";
export { MEMORY_TOOL_NAME, createMemoryTool } from "./tool.js";

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Automatic snapshot injection configuration accepted by the plugin. */
export type InjectConfig = Partial<MemoryInjectConfig>;

/** Memory plugin configuration: store root, search default, inject options. */
export interface Config extends MemoryServiceConfig {
    /** Automatic pinned-snapshot injection (M16); omitted uses defaults. */
    readonly inject?: InjectConfig | undefined;
}

const injectSchema = Schema.object({
    enable: Schema.boolean()
        .default(true)
        .description(
            "Register the nokoribi:memory runtime context and refresh it " +
                "once per turn."
        ),
    maxChars: Schema.number()
        .default(3000)
        .min(1)
        .description("Hard upper bound for the injected snapshot text."),
    maxEntries: Schema.number()
        .default(20)
        .min(1)
        .description("Hard upper bound for entries in the snapshot."),
    mainOnly: Schema.boolean()
        .default(true)
        .description(
            "Inject only in root (non-child) sessions; false includes " +
                "goal/subagent children."
        ),
    autoTags: Schema.array(Schema.string())
        .default(["type:person", "type:preference"])
        .description(
            "Tags whose entries are included automatically unless their " +
                "confidence is low."
        ),
});

/** Memory plugin configuration schema; only `root` is required. */
export const Config: ObjectSchema = Schema.object({
    root: Schema.string()
        .required()
        .description("Directory holding memory/entries and memory/archive."),
    defaultLimit: Schema.number()
        .default(DEFAULT_SEARCH_LIMIT)
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .description("Default number of search hits (1-50)."),
    inject: injectSchema.description(
        "Automatic pinned-snapshot runtime context (M16)."
    ),
});

/**
 * Mount the memory store: create its directories, install the `memory`
 * service, register the model-facing `memory` tool, and install the automatic
 * pinned snapshot as a runtime context.
 * @param ctx - Cordis context that owns the store, tool, and injection.
 * @param config - validated memory configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
    const logger = createLogger("memory");
    const service = new MemoryService(ctx, config);
    await service.initialize();
    const tool = createMemoryTool(service);
    ctx.effect(() => ctx.tools.register(tool));
    const injector = new MemorySnapshotInjector(
        service,
        resolveInjectConfig(config.inject),
        logger
    );
    await injector.initialize();
    injector.install(ctx);
    logger.info("memory store ready", {
        root: service.root,
        inject: injector.enabled,
    });
}
