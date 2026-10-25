import { afterEach, describe, expect, it } from "vitest";

import {
    Logger,
    createLogger,
    parseLogLevel,
    resolveLogLevel,
} from "../src/log.js";
import { clearRecentLogs, recentLogs } from "../src/recent.js";

afterEach(() => {
    clearRecentLogs();
});

describe("structured logger", () => {
    it("parses levels and defaults to info", () => {
        expect(parseLogLevel(" DEBUG ")).toBe("debug");
        expect(parseLogLevel("Warn")).toBe("warn");
        expect(parseLogLevel("verbose")).toBeUndefined();
        expect(parseLogLevel(undefined)).toBeUndefined();
        expect(resolveLogLevel({})).toBe("info");
        expect(resolveLogLevel({ NOKORIBI_LOG_LEVEL: "error" })).toBe("error");
    });

    it("filters below the configured threshold and keeps recent warnings", () => {
        const lines: string[] = [];
        const logger = new Logger("test", (line) => lines.push(line), "warn");
        logger.info("ignored");
        logger.warn("visible", { count: 1 });
        logger.error("failed");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(" warn test visible count=1");
        expect(lines[1]).toContain(" error test failed");
        expect(recentLogs().map((entry) => entry.message)).toEqual([
            "failed",
            "visible",
        ]);
    });

    it("inherits the level in child loggers", () => {
        const lines: string[] = [];
        const parent = new Logger("root", (line) => lines.push(line), "error");
        const child = parent.child("child");
        child.warn("ignored");
        child.error("visible");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(" error root.child visible");
    });

    it("uses the environment level by default", () => {
        const previous = process.env.NOKORIBI_LOG_LEVEL;
        process.env.NOKORIBI_LOG_LEVEL = "debug";
        const lines: string[] = [];
        try {
            createLogger("env", (line) => lines.push(line)).debug("visible");
            expect(lines).toHaveLength(1);
        } finally {
            if (previous === undefined) {
                delete process.env.NOKORIBI_LOG_LEVEL;
            } else {
                process.env.NOKORIBI_LOG_LEVEL = previous;
            }
        }
    });
});
