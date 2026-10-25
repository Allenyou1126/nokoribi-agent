import { dirname } from "node:path";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Permission bits for runtime state files. */
export const STATE_FILE_MODE = 0o600;

/** Permission bits for directories created by this process. */
export const STATE_DIR_MODE = 0o700;

/** Write one JSON document atomically with user-private permissions. */
export async function writeJsonAtomic(
    path: string,
    value: unknown,
    options: { mode?: number; dirMode?: number } = {}
): Promise<void> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await writeFileAtomic(path, content, {
        mode: options.mode ?? STATE_FILE_MODE,
        dirMode: options.dirMode ?? STATE_DIR_MODE,
    });
}

/** Read and parse one JSON document, or `undefined` when it does not exist. */
export async function readJsonFile(path: string): Promise<unknown | undefined> {
    const { readFile } = await import("node:fs/promises");
    try {
        const content = await readFile(path, "utf8");
        return JSON.parse(content) as unknown;
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
    }
}

/** Rename a damaged file beside itself, returning the backup path. */
export async function backupFile(path: string): Promise<string> {
    const { rename } = await import("node:fs/promises");
    const stamp = new Date().toISOString().replaceAll(":", "-");
    let candidate = `${path}.corrupt-${stamp}`;
    let suffix = 1;
    for (;;) {
        try {
            await rename(path, candidate);
            return candidate;
        } catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST") throw error;
            candidate = `${path}.corrupt-${stamp}-${suffix++}`;
        }
    }
}

/** Ensure the parent directory of a file exists. */
export async function ensureParent(path: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(path), { recursive: true, mode: STATE_DIR_MODE });
}

/** Narrow an unknown error to a Node filesystem error. */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
