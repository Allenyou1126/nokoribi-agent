import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Raised when another live process holds the single-instance lock. */
export class LockHeldError extends Error {
    readonly lockPath: string;
    readonly holderPid: number | undefined;

    constructor(message: string, lockPath: string, holderPid?: number) {
        super(message);
        this.name = "LockHeldError";
        this.lockPath = lockPath;
        this.holderPid = holderPid;
    }
}

/** The lock record written by the owning process. */
export interface LockHolder {
    readonly pid: number;
    readonly startedAt: string;
    readonly version: string;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EPERM"
        );
    }
}

function readHolder(path: string): LockHolder | undefined {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (
            typeof value === "object" &&
            value !== null &&
            "pid" in value &&
            typeof (value as { pid: unknown }).pid === "number"
        ) {
            return value as LockHolder;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Lifetime single-instance lock.
 *
 * The lock is an `O_EXCL`-created file carrying the owning pid. A lock left by
 * a process that no longer exists is taken over once; a malformed record is
 * treated as held (fail closed). Pid reuse is an accepted limitation, matching
 * the semantics of the underlying atomic-write helpers used by DSH.
 */
export class SingleInstanceLock {
    private readonly path: string;
    private released = false;

    private constructor(path: string) {
        this.path = path;
    }

    /** Acquire the lock or throw {@link LockHeldError}. */
    static acquire(path: string, version: string): SingleInstanceLock {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const holder: LockHolder = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            version,
        };
        const content = `${JSON.stringify(holder)}\n`;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const fd = openSync(path, "wx", 0o600);
                try {
                    writeSync(fd, content);
                } finally {
                    closeSync(fd);
                }
                return new SingleInstanceLock(path);
            } catch (error) {
                const code =
                    error instanceof Error && "code" in error
                        ? (error as NodeJS.ErrnoException).code
                        : undefined;
                if (code !== "EEXIST") throw error;
                const existing = readHolder(path);
                if (existing !== undefined && isProcessAlive(existing.pid)) {
                    throw new LockHeldError(
                        `another nokoribi-agent process holds ${path} (pid ${existing.pid})`,
                        path,
                        existing.pid
                    );
                }
                if (existing === undefined) {
                    throw new LockHeldError(
                        `lock ${path} exists but its holder is unreadable; refusing to steal it`,
                        path
                    );
                }
                try {
                    unlinkSync(path);
                } catch (unlinkError) {
                    const unlinkCode =
                        unlinkError instanceof Error && "code" in unlinkError
                            ? (unlinkError as NodeJS.ErrnoException).code
                            : undefined;
                    if (unlinkCode !== "ENOENT") throw unlinkError;
                }
            }
        }
        throw new LockHeldError(
            `could not acquire ${path} after clearing a stale lock`,
            path
        );
    }

    /** Remove the lock file. Idempotent. */
    release(): void {
        if (this.released) return;
        this.released = true;
        if (!existsSync(this.path)) return;
        try {
            unlinkSync(this.path);
        } catch (error) {
            const code =
                error instanceof Error && "code" in error
                    ? (error as NodeJS.ErrnoException).code
                    : undefined;
            if (code !== "ENOENT") throw error;
        }
    }
}
