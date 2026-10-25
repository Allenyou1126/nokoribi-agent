import { recordRecentLog } from "./recent.js";

/** Log severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured field values accepted by the logger. */
export type LogFieldValue = string | number | boolean | undefined;

/** Structured fields attached to one log line. */
export type LogFields = Record<string, LogFieldValue>;

/** Sink receiving one fully formatted line. */
export type LogSink = (line: string) => void;

/** Ordered set of accepted log levels. */
export const LOG_LEVELS: readonly LogLevel[] = [
    "debug",
    "info",
    "warn",
    "error",
];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/**
 * Parse one configured log level.
 * @param value - candidate text, usually from `NOKORIBI_LOG_LEVEL`.
 * @returns the normalized level, or undefined for an empty/invalid value.
 */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
    const normalized = value?.trim().toLowerCase();
    return LOG_LEVELS.find((level) => level === normalized);
}

/**
 * Resolve the process log threshold.
 * @param env - environment to inspect.
 * @returns the configured level, defaulting to `info`.
 */
export function resolveLogLevel(
    env: Record<string, string | undefined> = process.env
): LogLevel {
    return parseLogLevel(env.NOKORIBI_LOG_LEVEL) ?? "info";
}

function formatValue(value: LogFieldValue): string {
    if (typeof value === "string") {
        return /\s/.test(value) ? JSON.stringify(value) : value;
    }
    return String(value);
}

function formatFields(fields: LogFields | undefined): string {
    if (fields === undefined) return "";
    const parts = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatValue(value)}`);
    return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** Minimal line logger; message content must never be passed as a field. */
export class Logger {
    private readonly moduleName: string;
    private readonly sink: LogSink;
    private readonly level: LogLevel;
    private readonly threshold: number;

    constructor(
        moduleName: string,
        sink: LogSink = (line) => process.stderr.write(line),
        level: LogLevel = resolveLogLevel()
    ) {
        this.moduleName = moduleName;
        this.sink = sink;
        this.level = level;
        this.threshold = LEVEL_WEIGHT[level];
    }

    /** Return a logger with a nested module name. */
    child(moduleName: string): Logger {
        return new Logger(
            `${this.moduleName}.${moduleName}`,
            this.sink,
            this.level
        );
    }

    /** Write one structured line at the given level. */
    log(level: LogLevel, message: string, fields?: LogFields): void {
        if (LEVEL_WEIGHT[level] < this.threshold) return;
        const timestamp = new Date().toISOString();
        if (level === "warn" || level === "error") {
            recordRecentLog({
                at: timestamp,
                level,
                module: this.moduleName,
                message,
            });
        }
        this.sink(
            `${timestamp} ${level} ${this.moduleName} ${message}${formatFields(fields)}\n`
        );
    }

    debug(message: string, fields?: LogFields): void {
        this.log("debug", message, fields);
    }

    info(message: string, fields?: LogFields): void {
        this.log("info", message, fields);
    }

    warn(message: string, fields?: LogFields): void {
        this.log("warn", message, fields);
    }

    error(message: string, fields?: LogFields): void {
        this.log("error", message, fields);
    }
}

/** Create a logger for one module. */
export function createLogger(
    moduleName: string,
    sink?: LogSink,
    level?: LogLevel
): Logger {
    return new Logger(moduleName, sink, level);
}
