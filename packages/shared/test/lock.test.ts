import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockHeldError, SingleInstanceLock } from "../src/lock.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-lock-"));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

describe("single instance lock", () => {
    it("rejects a second live holder", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent.lock");
        const lock = SingleInstanceLock.acquire(path, "0.1.0");
        expect(() => SingleInstanceLock.acquire(path, "0.1.0")).toThrow(
            LockHeldError
        );
        lock.release();
    });

    it("takes over a lock whose holder process is gone", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent.lock");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
            path,
            JSON.stringify({ pid: 999_999_999, startedAt: "x", version: "x" })
        );
        const lock = SingleInstanceLock.acquire(path, "0.1.0");
        const holder = JSON.parse(await readFile(path, "utf8")) as {
            pid: number;
        };
        expect(holder.pid).toBe(process.pid);
        lock.release();
        await expect(readFile(path, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("refuses to steal an unreadable lock", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent.lock");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, "garbage");
        expect(() => SingleInstanceLock.acquire(path, "0.1.0")).toThrow(
            LockHeldError
        );
    });
});
