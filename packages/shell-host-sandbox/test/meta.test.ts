import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    backupSandboxMeta,
    createSandboxMeta,
    parseSandboxMeta,
    readSandboxMeta,
    writeSandboxMeta,
} from "../src/meta.js";

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

async function tempFile(name = "main-1.json"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-meta-"));
    dirs.push(dir);
    return join(dir, name);
}

describe("sandbox metadata", () => {
    it("creates a generation-1 record", () => {
        const meta = createSandboxMeta("main-1", 1000);
        expect(meta).toEqual({
            version: 1,
            sessionId: "main-1",
            generation: 1,
            packages: [],
            createdAt: new Date(1000).toISOString(),
            lastUsedAt: new Date(1000).toISOString(),
        });
        expect(parseSandboxMeta(meta, "main-1")).toEqual(meta);
    });

    it("rejects wrong versions, sessions, and malformed fields", () => {
        expect(parseSandboxMeta({}, "main-1")).toBeUndefined();
        expect(
            parseSandboxMeta(
                { ...createSandboxMeta("main-1", 1), version: 2 },
                "main-1"
            )
        ).toBeUndefined();
        expect(
            parseSandboxMeta(createSandboxMeta("main-2", 1), "main-1")
        ).toBeUndefined();
        expect(
            parseSandboxMeta(
                { ...createSandboxMeta("main-1", 1), generation: 0 },
                "main-1"
            )
        ).toBeUndefined();
        expect(
            parseSandboxMeta(
                { ...createSandboxMeta("main-1", 1), packages: [1] },
                "main-1"
            )
        ).toBeUndefined();
    });

    it("round-trips a sidecar and returns undefined when missing", async () => {
        const path = await tempFile();
        await expect(readSandboxMeta(path, "main-1")).resolves.toBeUndefined();
        const meta = {
            ...createSandboxMeta("main-1", 1000),
            generation: 3,
            packages: ["nixpkgs#hello"],
        };
        await writeSandboxMeta(path, meta);
        await expect(readSandboxMeta(path, "main-1")).resolves.toEqual(meta);
    });

    it("throws on invalid JSON so the host can back it up", async () => {
        const path = await tempFile();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, "not json");
        await expect(readSandboxMeta(path, "main-1")).rejects.toThrow();
        const backup = await backupSandboxMeta(path);
        await expect(readFile(backup, "utf8")).resolves.toBe("not json");
    });
});
