import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "@nokoribi/shared";
import { ensureParent, isNodeError } from "@nokoribi/shared";

import { configuredValue } from "./env.js";

/** Environment variable locating the shipped AGENTS.md templates. */
export const TEMPLATES_DIR_ENV: string = "NOKORIBI_TEMPLATES_DIR";

/** Environment variable supplying the persistent workspace directory. */
export const WORKSPACE_ENV: string = "NOKORIBI_WORKSPACE";

/** File name of the layered instruction files read by DSH. */
export const AGENTS_FILE_NAME: string = "AGENTS.md";

/** Template copied to `$DSH_HOME/AGENTS.md` on first start. */
export const GLOBAL_AGENTS_TEMPLATE: string = "AGENTS.global.md";

/** Template copied to `<workspace>/AGENTS.md` on first start. */
export const WORKSPACE_AGENTS_TEMPLATE: string = "AGENTS.workspace.md";

/** Options for {@link seedAgentInstructions}. */
export interface AgentsSeedOptions {
    /** Resolved harness home (`$DSH_HOME`). */
    readonly home: string;
    /** Persistent workspace root. */
    readonly workspace: string;
    /** Templates directory override. */
    readonly templatesDir: string | undefined;
    /** Environment mapping used to read the templates-directory override. */
    readonly env: Record<string, string | undefined>;
    /** Optional logger for seeded-file notices. */
    readonly logger: Logger | undefined;
    /** Seed the user-global AGENTS.md (default `true`). */
    readonly seedGlobalAgents?: boolean | undefined;
    /** Seed the workspace AGENTS.md (default `true`). */
    readonly seedWorkspaceAgents?: boolean | undefined;
    /** Global instruction target override. */
    readonly globalAgentsFile: string | undefined;
    /** Workspace instruction target override. */
    readonly workspaceAgentsFile: string | undefined;
}

/** What {@link seedAgentInstructions} created and what already existed. */
export interface AgentsSeedResult {
    readonly globalFile: string;
    readonly workspaceFile: string;
    readonly created: readonly string[];
    readonly skipped: readonly string[];
}

interface SeedTarget {
    readonly file: string;
    readonly template: string;
}

function defaultTemplatesDir(): string {
    return fileURLToPath(new URL("../../../templates/", import.meta.url));
}

/**
 * Resolve the templates directory: explicit config, then
 * `NOKORIBI_TEMPLATES_DIR`, then the copy shipped beside the package.
 * @param configured - explicit `prompt.templatesDir` value.
 * @param env - environment mapping used to read the override.
 * @returns the directory holding `AGENTS.global.md`/`AGENTS.workspace.md`.
 */
export function resolveTemplatesDir(
    configured: string | undefined,
    env: Record<string, string | undefined>
): string {
    return (
        configuredValue(configured) ??
        configuredValue(env[TEMPLATES_DIR_ENV]) ??
        defaultTemplatesDir()
    );
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (
            isNodeError(error) &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
            return false;
        }
        throw error;
    }
}

async function readTemplate(
    templatesDir: string,
    template: string
): Promise<string> {
    const path = join(templatesDir, template);
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(
                `missing AGENTS.md seed template: ${path}; ` +
                    "set prompt.templatesDir or " +
                    TEMPLATES_DIR_ENV
            );
        }
        throw error;
    }
}

/**
 * Seed the two layered AGENTS.md files once. Existing files are never
 * overwritten (D114): a present file is reported as skipped.
 * @param options - resolved paths, templates directory, and logger.
 * @returns the target paths split into created and skipped files.
 * @throws when a target is missing and its template cannot be found.
 */
export async function seedAgentInstructions(
    options: AgentsSeedOptions
): Promise<AgentsSeedResult> {
    const templatesDir = resolveTemplatesDir(options.templatesDir, options.env);
    const globalFile =
        options.globalAgentsFile ?? join(options.home, AGENTS_FILE_NAME);
    const workspaceFile =
        options.workspaceAgentsFile ??
        join(options.workspace, AGENTS_FILE_NAME);
    const targets: SeedTarget[] = [];
    if (options.seedGlobalAgents ?? true) {
        targets.push({
            file: globalFile,
            template: GLOBAL_AGENTS_TEMPLATE,
        });
    }
    if (options.seedWorkspaceAgents ?? true) {
        targets.push({
            file: workspaceFile,
            template: WORKSPACE_AGENTS_TEMPLATE,
        });
    }
    const created: string[] = [];
    const skipped: string[] = [];
    for (const target of targets) {
        if (await fileExists(target.file)) {
            skipped.push(target.file);
            continue;
        }
        const content = await readTemplate(templatesDir, target.template);
        await ensureParent(target.file);
        try {
            await writeFile(target.file, content, {
                flag: "wx",
                mode: 0o644,
            });
        } catch (error) {
            if (isNodeError(error) && error.code === "EEXIST") {
                skipped.push(target.file);
                continue;
            }
            throw error;
        }
        created.push(target.file);
        options.logger?.info("seeded AGENTS.md", {
            file: target.file,
            template: target.template,
        });
    }
    return { globalFile, workspaceFile, created, skipped };
}
