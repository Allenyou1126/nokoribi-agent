/** Maximum number of warning/error records retained for diagnostics. */
export const RECENT_LOG_LIMIT: number = 20;

/** One retained warning or error line. */
export interface RecentLogEntry {
    readonly at: string;
    readonly level: "warn" | "error";
    readonly module: string;
    readonly message: string;
}

const records: RecentLogEntry[] = [];

/**
 * Retain one warning/error line for `/status full`.
 * @param entry - timestamped, low-sensitivity log summary.
 */
export function recordRecentLog(entry: RecentLogEntry): void {
    records.push(entry);
    if (records.length > RECENT_LOG_LIMIT) {
        records.splice(0, records.length - RECENT_LOG_LIMIT);
    }
}

/**
 * Read retained warning/error lines, newest first.
 * @param limit - maximum number of rows to return.
 * @returns a detached snapshot.
 */
export function recentLogs(limit: number = RECENT_LOG_LIMIT): RecentLogEntry[] {
    const bounded = Math.max(0, Math.min(limit, records.length));
    return records.slice(records.length - bounded).toReversed();
}

/** Clear the process-local diagnostics buffer (tests and explicit resets). */
export function clearRecentLogs(): void {
    records.length = 0;
}
