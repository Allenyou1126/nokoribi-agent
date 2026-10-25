/** Log severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured field values accepted by the logger. */
export type LogFieldValue = string | number | boolean | undefined;

/** Structured fields attached to one log line. */
export type LogFields = Record<string, LogFieldValue>;

/** Sink receiving one fully formatted line. */
export type LogSink = (line: string) => void;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

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
    private readonly threshold: number;

    constructor(
        moduleName: string,
        sink: LogSink = (line) => process.stderr.write(line),
        level: LogLevel = "info"
    ) {
        this.moduleName = moduleName;
        this.sink = sink;
        this.threshold = LEVEL_WEIGHT[level];
    }

    /** Return a logger with a nested module name. */
    child(moduleName: string): Logger {
        return new Logger(
            `${this.moduleName}.${moduleName}`,
            this.sink,
            this.threshold === LEVEL_WEIGHT.debug
                ? "debug"
                : this.threshold === LEVEL_WEIGHT.info
                  ? "info"
                  : this.threshold === LEVEL_WEIGHT.warn
                    ? "warn"
                    : "error"
        );
    }

    /** Write one structured line at the given level. */
    log(level: LogLevel, message: string, fields?: LogFields): void {
        if (LEVEL_WEIGHT[level] < this.threshold) return;
        const timestamp = new Date().toISOString();
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
