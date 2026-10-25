import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Logger } from "@nokoribi/shared";
import { isNodeError } from "@nokoribi/shared";

import { configuredValue } from "./env.js";

/** Default file name of the user-provided persona, looked up in the cwd. */
export const DEFAULT_SOUL_FILE_NAME: string = "SOUL.md";

/** SOUL files larger than this many UTF-8 bytes trigger a startup warning. */
export const DEFAULT_SOUL_WARN_BYTES: number = 4096;

/** Environment variable that overrides the default SOUL.md lookup. */
export const SOUL_FILE_ENV: string = "NOKORIBI_SOUL_FILE";

/** How the persona file path was chosen. */
export type SoulFileSource = "config" | "env" | "default";

/** One resolved persona file path plus the precedence level behind it. */
export interface ResolvedSoulFile {
    readonly path: string;
    readonly source: SoulFileSource;
}

/** Loaded persona text and its size facts. */
export interface LoadedSoul {
    readonly path: string;
    readonly source: SoulFileSource;
    readonly text: string;
    readonly bytes: number;
}

/** Options for {@link loadSoul}. */
export interface LoadSoulOptions {
    readonly configured: string | undefined;
    readonly env: Record<string, string | undefined>;
    readonly cwd: string;
    readonly warnBytes: number;
    readonly logger: Logger;
}

/**
 * Resolve the persona file following `config soulFile` → `NOKORIBI_SOUL_FILE`
 * → `<cwd>/SOUL.md`. Relative paths are resolved against `cwd`.
 * @param configured - explicit `prompt.soulFile` configuration value.
 * @param env - environment mapping used to read `NOKORIBI_SOUL_FILE`.
 * @param cwd - working directory used for relative paths and the default.
 * @returns the absolute persona file path and its precedence source.
 */
export function resolveSoulFile(
    configured: string | undefined,
    env: Record<string, string | undefined>,
    cwd: string
): ResolvedSoulFile {
    const fromConfig = configuredValue(configured);
    if (fromConfig !== undefined) {
        return { path: resolve(cwd, fromConfig), source: "config" };
    }
    const fromEnv = configuredValue(env[SOUL_FILE_ENV]);
    if (fromEnv !== undefined) {
        return { path: resolve(cwd, fromEnv), source: "env" };
    }
    return { path: join(cwd, DEFAULT_SOUL_FILE_NAME), source: "default" };
}

/**
 * Read the persona file once at startup.
 *
 * A missing file fails loud: the identity is a required deployment input
 * (D111/D115/D116). An oversized file only logs a warning because the token
 * cost is a deployment preference, not a correctness problem.
 * @param options - resolved configuration, environment, and logger.
 * @returns the trimmed persona text and its byte size.
 * @throws when the file is missing, unreadable, or empty.
 */
export async function loadSoul(options: LoadSoulOptions): Promise<LoadedSoul> {
    const resolved = resolveSoulFile(
        options.configured,
        options.env,
        options.cwd
    );
    let content: string;
    try {
        content = await readFile(resolved.path, "utf8");
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(
                `persona file not found: ${resolved.path} ` +
                    `(resolved from ${resolved.source}); ` +
                    "provide SOUL.md, set prompt.soulFile, " +
                    `or set ${SOUL_FILE_ENV}`
            );
        }
        throw error;
    }
    const text = content.trim();
    if (text === "") {
        throw new Error(
            `persona file is empty: ${resolved.path}; ` +
                "the identity must be non-empty because the harness " +
                "identity sentence is replaced (D117)"
        );
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > options.warnBytes) {
        options.logger.warn("persona file exceeds the soft size limit", {
            file: resolved.path,
            bytes,
            limit: options.warnBytes,
        });
    }
    return {
        path: resolved.path,
        source: resolved.source,
        text,
        bytes,
    };
}
