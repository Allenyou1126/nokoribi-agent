import { backupFile, readJsonFile, writeJsonAtomic } from "@nokoribi/shared";

/** Durable per-session sandbox metadata (sidecar beside the temp directory). */
export interface SandboxMeta {
    readonly version: 1;
    readonly sessionId: string;
    readonly generation: number;
    readonly packages: readonly string[];
    readonly createdAt: string;
    readonly lastUsedAt: string;
}

/** Build a fresh generation-1 record for one session. */
export function createSandboxMeta(sessionId: string, now: number): SandboxMeta {
    const stamp = new Date(now).toISOString();
    return {
        version: 1,
        sessionId,
        generation: 1,
        packages: [],
        createdAt: stamp,
        lastUsedAt: stamp,
    };
}

/**
 * Parse a sidecar document, rejecting records belonging to another session.
 * @param value - parsed JSON value.
 * @param sessionId - expected session id.
 * @returns the validated record, or undefined when the shape is invalid.
 */
export function parseSandboxMeta(
    value: unknown,
    sessionId: string
): SandboxMeta | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return undefined;
    if (record.sessionId !== sessionId) return undefined;
    if (
        typeof record.generation !== "number" ||
        !Number.isInteger(record.generation) ||
        record.generation < 1
    ) {
        return undefined;
    }
    if (!Array.isArray(record.packages)) return undefined;
    if (!record.packages.every((item) => typeof item === "string")) {
        return undefined;
    }
    if (typeof record.createdAt !== "string") return undefined;
    if (typeof record.lastUsedAt !== "string") return undefined;
    return {
        version: 1,
        sessionId,
        generation: record.generation,
        packages: record.packages,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
    };
}

/**
 * Read one sidecar. A missing file returns undefined; malformed JSON or an
 * invalid shape throws so the host can back up and rebuild it.
 * @param path - sidecar path.
 * @param sessionId - expected session id.
 * @returns the record, or undefined when the file does not exist.
 */
export async function readSandboxMeta(
    path: string,
    sessionId: string
): Promise<SandboxMeta | undefined> {
    const value = await readJsonFile(path);
    if (value === undefined) return undefined;
    const parsed = parseSandboxMeta(value, sessionId);
    if (parsed === undefined) {
        throw new Error(`invalid sandbox metadata at ${path}`);
    }
    return parsed;
}

/** Atomically persist one sidecar. */
export async function writeSandboxMeta(
    path: string,
    meta: SandboxMeta
): Promise<void> {
    await writeJsonAtomic(path, meta);
}

/**
 * Move a damaged sidecar beside itself and return the backup path.
 * @param path - damaged sidecar path.
 * @returns the backup path.
 */
export async function backupSandboxMeta(path: string): Promise<string> {
    return await backupFile(path);
}
