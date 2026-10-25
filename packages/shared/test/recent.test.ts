import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../src/log.js";
import {
    RECENT_LOG_LIMIT,
    clearRecentLogs,
    recentLogs,
} from "../src/recent.js";
import { resolvePackageVersion } from "../src/version.js";

afterEach(() => {
    clearRecentLogs();
});

describe("recent diagnostics", () => {
    it("retains warnings and errors but not info lines", () => {
        const lines: string[] = [];
        const logger = createLogger("probe", (line) => lines.push(line));
        logger.info("ignore me");
        logger.warn("careful", { detail: "not stored" });
        logger.error("broken");
        expect(lines).toHaveLength(3);
        expect(recentLogs()).toEqual([
            expect.objectContaining({
                level: "error",
                module: "probe",
                message: "broken",
            }),
            expect.objectContaining({
                level: "warn",
                module: "probe",
                message: "careful",
            }),
        ]);
        expect(JSON.stringify(recentLogs())).not.toContain("not stored");
    });

    it("bounds the buffer and returns newest first", () => {
        const logger = createLogger("bounded", () => undefined);
        for (let index = 0; index < RECENT_LOG_LIMIT + 5; index += 1) {
            logger.warn(`message-${String(index)}`);
        }
        const logs = recentLogs();
        expect(logs).toHaveLength(RECENT_LOG_LIMIT);
        expect(logs[0]?.message).toBe(
            `message-${String(RECENT_LOG_LIMIT + 4)}`
        );
        expect(logs.at(-1)?.message).toBe("message-5");
        expect(recentLogs(3)).toHaveLength(3);
    });
});

describe("resolvePackageVersion", () => {
    it("reads the installed DSH manifest and falls back safely", () => {
        expect(resolvePackageVersion("@deepseek-ai/dsh-agent")).toMatch(
            /^0\.2\.1/
        );
        expect(resolvePackageVersion("@nokoribi/not-a-package")).toBe(
            "unknown"
        );
    });
});
