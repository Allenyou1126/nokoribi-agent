import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@nokoribi/shared";
import { createLogger } from "@nokoribi/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
    DEFAULT_SOUL_WARN_BYTES,
    SOUL_FILE_ENV,
    loadSoul,
    resolveSoulFile,
} from "../src/soul.js";

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-soul-"));
    directories.push(directory);
    return directory;
}

interface CapturedLogger {
    readonly lines: string[];
    readonly logger: Logger;
}

function captureLogger(): CapturedLogger {
    const lines: string[] = [];
    const logger = createLogger("test", (line) => {
        lines.push(line);
    });
    return { lines, logger };
}

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

describe("resolveSoulFile", () => {
    it("prefers the configured file", () => {
        const resolved = resolveSoulFile(
            "persona.md",
            { [SOUL_FILE_ENV]: "/env/SOUL.md" },
            "/base"
        );
        expect(resolved).toEqual({
            path: "/base/persona.md",
            source: "config",
        });
    });

    it("falls back to the environment variable", () => {
        const resolved = resolveSoulFile(
            undefined,
            {
                [SOUL_FILE_ENV]: "/env/SOUL.md",
            },
            "/base"
        );
        expect(resolved).toEqual({
            path: "/env/SOUL.md",
            source: "env",
        });
    });

    it("falls back to <cwd>/SOUL.md", () => {
        const resolved = resolveSoulFile("   ", {}, "/base");
        expect(resolved).toEqual({
            path: "/base/SOUL.md",
            source: "default",
        });
    });
});

describe("loadSoul", () => {
    it("fails loud when the persona file is missing", async () => {
        const directory = await makeTempDir();
        const caught = captureLogger();
        await expect(
            loadSoul({
                configured: join(directory, "missing.md"),
                env: {},
                cwd: directory,
                warnBytes: DEFAULT_SOUL_WARN_BYTES,
                logger: caught.logger,
            })
        ).rejects.toThrow(/persona file not found/);
    });

    it("fails loud when the persona file is empty", async () => {
        const directory = await makeTempDir();
        const file = join(directory, "SOUL.md");
        await writeFile(file, "  \n\n");
        const caught = captureLogger();
        await expect(
            loadSoul({
                configured: file,
                env: {},
                cwd: directory,
                warnBytes: DEFAULT_SOUL_WARN_BYTES,
                logger: caught.logger,
            })
        ).rejects.toThrow(/persona file is empty/);
    });

    it("loads trimmed text and reports raw byte size", async () => {
        const directory = await makeTempDir();
        const file = join(directory, "SOUL.md");
        await writeFile(file, "\n你好\n");
        const caught = captureLogger();
        const loaded = await loadSoul({
            configured: file,
            env: {},
            cwd: directory,
            warnBytes: DEFAULT_SOUL_WARN_BYTES,
            logger: caught.logger,
        });
        expect(loaded.text).toBe("你好");
        expect(loaded.bytes).toBe(Buffer.byteLength("\n你好\n", "utf8"));
        expect(loaded.source).toBe("config");
        expect(caught.lines).toEqual([]);
    });

    it("warns above the soft size limit but still loads", async () => {
        const directory = await makeTempDir();
        const file = join(directory, "SOUL.md");
        await writeFile(file, "x".repeat(32));
        const caught = captureLogger();
        const loaded = await loadSoul({
            configured: file,
            env: {},
            cwd: directory,
            warnBytes: 16,
            logger: caught.logger,
        });
        expect(loaded.text).toHaveLength(32);
        expect(caught.lines).toHaveLength(1);
        expect(caught.lines[0]).toContain("persona file exceeds");
    });
});
