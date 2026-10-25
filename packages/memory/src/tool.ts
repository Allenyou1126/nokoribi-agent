import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { MemoryEntry } from "./frontmatter.js";
import { normalizeBody } from "./frontmatter.js";
import type { MemoryService } from "./store.js";

/** Model-facing memory tool name. */
export const MEMORY_TOOL_NAME: string = "memory";

/** Maximum characters of body preview shown by `search`. */
const PREVIEW_CHARS: number = 160;

const MEMORY_TOOL_DESCRIPTION: string = `Long-term memory: a global Markdown store that is never injected into the prompt. Before relying on history, preferences, or decisions, run search. Before writing, search for duplicates; use supersedes (not a new near-duplicate) when replacing an existing entry. Only store durable facts: user preferences, personal facts, project-stable facts (tag project:<name>), important decisions and corrections, and reusable lessons. Never store secrets, credentials, API keys, tokens, logs, transcripts, or transient task state. Tags use namespace:value (type:preference|fact|decision|person|project, project:<name>, topic:<name>). forget is a soft delete: the entry is archived, not erased.`;

/**
 * Build the model-facing memory tool for one store.
 * @param service - memory service the tool reads and writes.
 * @returns the registry-ready `memory` tool definition.
 */
export function createMemoryTool(service: MemoryService): ToolDefinition {
    return defineTool({
        name: MEMORY_TOOL_NAME,
        description: MEMORY_TOOL_DESCRIPTION,
        parameters: {
            action: {
                type: "string",
                required: true,
                enum: ["search", "read", "write", "forget"],
                description:
                    "search: find entries; read: full entry by id; " +
                    "write: create or update; forget: archive by id.",
            },
            query: {
                type: "string",
                description:
                    "search keywords matched against title, tags, and body; " +
                    "omit for the most recently updated entries.",
            },
            tags: {
                type: "array",
                items: { type: "string" },
                description:
                    "write: 1-20 namespace:value tags; search: tags that " +
                    "must all be present.",
            },
            limit: {
                type: "integer",
                description: "search page size (default 10, max 50).",
            },
            id: {
                type: "string",
                description:
                    "read/forget: entry id; write: existing active id to " +
                    "update (omit to create).",
            },
            title: {
                type: "string",
                description: "write: short retrieval title (max 200 bytes).",
            },
            body: {
                type: "string",
                description: "write: Markdown body (max 64 KiB).",
            },
            source: {
                type: "string",
                description:
                    "write: optional provenance such as session:<id>#turn-12.",
            },
            confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "write: trust level (default medium).",
            },
            supersedes: {
                type: "array",
                items: { type: "string" },
                description:
                    "write: ids of active entries this entry replaces; " +
                    "they are archived.",
            },
        },
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            switch (args.action) {
                case "search": {
                    const hits = await service.search({
                        query: args.query,
                        tags: args.tags,
                        limit: args.limit,
                    });
                    return formatSearchResults(hits);
                }
                case "read": {
                    const id = requireArgument(args.id, "read", "id");
                    const entry = await service.read(id);
                    if (entry === undefined) {
                        throw new Error(`memory entry "${id}" was not found`);
                    }
                    return formatEntry(entry);
                }
                case "write": {
                    const title = requireArgument(args.title, "write", "title");
                    const body = requireArgument(args.body, "write", "body");
                    if (args.tags === undefined || args.tags.length === 0) {
                        throw new Error(
                            'memory write requires "tags" ' +
                                "(1-20 namespace:value tags)"
                        );
                    }
                    const entry = await service.write({
                        ...(args.id === undefined ? {} : { id: args.id }),
                        title,
                        tags: args.tags,
                        body,
                        ...(args.source === undefined
                            ? {}
                            : { source: args.source }),
                        ...(args.confidence === undefined
                            ? {}
                            : { confidence: args.confidence }),
                        ...(args.supersedes === undefined
                            ? {}
                            : { supersedes: args.supersedes }),
                    });
                    return formatWriteResult(entry, args.id === undefined);
                }
                case "forget": {
                    const id = requireArgument(args.id, "forget", "id");
                    const entry = await service.forget(id);
                    return formatForgetResult(entry);
                }
                default:
                    throw new Error(
                        `unknown memory action "${String(args.action)}"`
                    );
            }
        },
    });
}

/** Require one action-specific string argument. */
function requireArgument(
    value: string | undefined,
    action: string,
    field: string
): string {
    if (value === undefined || value.trim() === "") {
        throw new Error(`memory action "${action}" requires "${field}"`);
    }
    return value;
}

/** Collapse a body into one short preview line. */
function bodyPreview(body: string): string {
    const collapsed = normalizeBody(body).replace(/\s+/g, " ").trim();
    if (collapsed.length <= PREVIEW_CHARS) return collapsed;
    return `${collapsed.slice(0, PREVIEW_CHARS)}…`;
}

/** Render search hits as compact Markdown. */
function formatSearchResults(hits: readonly MemoryEntry[]): string {
    if (hits.length === 0) return "No memory entries matched.";
    const lines: string[] = [
        `Found ${String(hits.length)} memory ${
            hits.length === 1 ? "entry" : "entries"
        }.`,
    ];
    for (const hit of hits) {
        lines.push(
            "",
            `- ${hit.id}: ${hit.title}`,
            `  tags: ${hit.tags.join(", ")}`,
            `  updated: ${hit.updated} | confidence: ${hit.confidence}`
        );
        const preview = bodyPreview(hit.body);
        if (preview !== "") lines.push(`  ${preview}`);
    }
    return lines.join("\n");
}

/** Render one full entry. */
function formatEntry(entry: MemoryEntry): string {
    const lines: string[] = [
        `# ${entry.title}`,
        "",
        `- id: ${entry.id}`,
        `- tags: ${entry.tags.join(", ")}`,
    ];
    if (entry.source !== undefined) lines.push(`- source: ${entry.source}`);
    lines.push(
        `- created: ${entry.created}`,
        `- updated: ${entry.updated}`,
        `- confidence: ${entry.confidence}`,
        `- status: ${entry.status}`
    );
    if (entry.supersedes.length > 0) {
        lines.push(`- supersedes: ${entry.supersedes.join(", ")}`);
    }
    if (entry.body !== "") lines.push("", entry.body);
    return lines.join("\n");
}

/** Render the write confirmation, noting archived superseded ids. */
function formatWriteResult(entry: MemoryEntry, created: boolean): string {
    const lines: string[] = [
        `Saved memory entry \`${entry.id}\` (${created ? "created" : "updated"}).`,
        `- title: ${entry.title}`,
        `- tags: ${entry.tags.join(", ")}`,
        `- confidence: ${entry.confidence}`,
    ];
    if (entry.supersedes.length > 0) {
        lines.push(`- supersedes: ${entry.supersedes.join(", ")}`);
    }
    return lines.join("\n");
}

/** Render the forget (soft delete) confirmation. */
function formatForgetResult(entry: MemoryEntry): string {
    return (
        `Archived memory entry \`${entry.id}\` (${entry.title}). ` +
        "It is no longer searchable but remains under archive/."
    );
}
