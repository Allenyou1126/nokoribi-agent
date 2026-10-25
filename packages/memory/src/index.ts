import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createLogger } from "@nokoribi/shared";

import { MemoryService } from "./store.js";
import type { MemoryServiceConfig } from "./store.js";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./store.js";
import { createMemoryTool } from "./tool.js";

/** Plugin name used by Cordis diagnostics. */
export const name: string = "memory";

/** The tool registry must exist before the memory tool can register. */
export const inject: string[] = ["tools"];

export { MemoryService };
export type {
    MemorySearchOptions,
    MemoryServiceConfig,
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
export * from "./secret.js";
export { MEMORY_TOOL_NAME, createMemoryTool } from "./tool.js";

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Memory plugin configuration: store root plus the default search limit. */
export type Config = MemoryServiceConfig;

/** Memory plugin configuration schema; `root` must be provided. */
export const Config: ObjectSchema = Schema.object({
    root: Schema.string()
        .required()
        .description("Directory holding memory/entries and memory/archive."),
    defaultLimit: Schema.number()
        .default(DEFAULT_SEARCH_LIMIT)
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .description("Default number of search hits (1-50)."),
});

/**
 * Mount the memory store: create its directories, install the `memory`
 * service, and register the model-facing `memory` tool.
 * @param ctx - Cordis context that owns the store and tool.
 * @param config - validated memory configuration.
 */
export async function apply(
    ctx: Context,
    config: MemoryServiceConfig
): Promise<void> {
    const service = new MemoryService(ctx, config);
    await service.initialize();
    const tool = createMemoryTool(service);
    ctx.effect(() => ctx.tools.register(tool));
    createLogger("memory").info("memory store ready", { root: service.root });
}
