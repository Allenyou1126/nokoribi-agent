import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryConfidence, MemoryEntry } from "../src/frontmatter.js";
import { parseMemoryFile, serializeMemoryFile } from "../src/frontmatter.js";
import { SecretDetectedError } from "../src/secret.js";
import {
    DEFAULT_SEARCH_LIMIT,
    MAX_MEMORY_BODY_BYTES,
    MAX_MEMORY_TITLE_BYTES,
    MAX_SEARCH_LIMIT,
    MemoryService,
    generateMemoryId,
} from "../src/store.js";

const directories: string[] = [];

async function makeRoot(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-memory-"));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

function makeService(root: string, defaultLimit?: number): MemoryService {
    return new MemoryService(new Context(), {
        root,
        ...(defaultLimit === undefined ? {} : { defaultLimit }),
    });
}

/** One deterministic entry written directly to disk. */
function sampleEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
    return {
        id: "mem-sample",
        title: "Sample title",
        tags: ["type:fact"],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        confidence: "medium",
        status: "active",
        supersedes: [],
        body: "Sample body",
        ...overrides,
    };
}

async function writeRawEntry(
    root: string,
    entry: MemoryEntry,
    directory: "entries" | "archive" = "entries"
): Promise<void> {
    const dir = join(root, directory);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${entry.id}.md`), serializeMemoryFile(entry));
}

describe("MemoryService storage", () => {
    it("creates an entry with a generated id and reads it back", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const entry = await service.write({
            title: "NixOS deployment",
            tags: ["type:preference", "project:nixos"],
            body: "Use agenix for secrets.",
            source: "session:main-1#turn-2",
            confidence: "high",
        });
        expect(entry.id).toMatch(/^mem-\d{8}-\d{6}-[0-9a-f]{6}$/);
        expect(entry.created).toBe(entry.updated);
        expect(entry.status).toBe("active");
        expect(entry.supersedes).toStrictEqual([]);
        expect(await service.read(entry.id)).toStrictEqual(entry);
        const text = await readFile(
            join(root, "entries", `${entry.id}.md`),
            "utf8"
        );
        expect(parseMemoryFile(text)).toStrictEqual(entry);
    });

    it("generates distinct ids within one second", () => {
        const first = generateMemoryId(new Date("2026-10-25T01:30:00.000Z"));
        const second = generateMemoryId(new Date("2026-10-25T01:30:00.000Z"));
        expect(first).toMatch(/^mem-20261025-013000-[0-9a-f]{6}$/);
        expect(second).toMatch(/^mem-20261025-013000-[0-9a-f]{6}$/);
        expect(first).not.toBe(second);
    });

    it("creates private directories and entry files", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        await service.initialize();
        const entriesStat = await stat(join(root, "entries"));
        const archiveStat = await stat(join(root, "archive"));
        expect(entriesStat.mode & 0o777).toBe(0o700);
        expect(archiveStat.mode & 0o777).toBe(0o700);
        const entry = await service.write({
            title: "Private",
            tags: ["type:fact"],
            body: "secret-free",
        });
        const fileStat = await stat(join(root, "entries", `${entry.id}.md`));
        expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it("persists entries across service instances", async () => {
        const root = await makeRoot();
        const first = makeService(root);
        const entry = await first.write({
            title: "Persistent",
            tags: ["type:fact"],
            body: "keyword agenix",
        });
        const second = makeService(root);
        expect(await second.read(entry.id)).toStrictEqual(entry);
        const hits = await second.search({ query: "agenix" });
        expect(hits.map((hit) => hit.id)).toStrictEqual([entry.id]);
    });

    it("installs itself as the ctx.memory service", async () => {
        const root = await makeRoot();
        const ctx = new Context();
        const service = new MemoryService(ctx, { root });
        expect(service.root).toBe(root);
        expect(ctx.memory).toBeDefined();
        expect(ctx.memory.root).toBe(root);
        expect(await ctx.memory.stats()).toStrictEqual({
            active: 0,
            archived: 0,
            invalid: 0,
            bytes: 0,
        });
    });

    it("upserts an explicit id and keeps its created timestamp", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const first = await service.write({
            id: "entry-one",
            title: "First",
            tags: ["type:fact"],
            body: "one",
        });
        const second = await service.write({
            id: "entry-one",
            title: "Second",
            tags: ["type:decision"],
            body: "two",
            confidence: "high",
        });
        expect(second.id).toBe("entry-one");
        expect(second.created).toBe(first.created);
        expect(second.title).toBe("Second");
        expect(second.tags).toStrictEqual(["type:decision"]);
        expect(second.confidence).toBe("high");
        expect(Date.parse(second.updated)).toBeGreaterThanOrEqual(
            Date.parse(first.updated)
        );
        expect(await readdir(join(root, "entries"))).toStrictEqual([
            "entry-one.md",
        ]);
    });

    it("rejects unsafe ids and invalid writes", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const base = {
            title: "Valid title",
            tags: ["type:fact"],
            body: "valid body",
        };
        await expect(
            service.write({ ...base, id: "../escape" })
        ).rejects.toThrow(/invalid memory id/);
        await expect(
            service.write({
                ...base,
                title: "x".repeat(MAX_MEMORY_TITLE_BYTES + 1),
            })
        ).rejects.toThrow(/title exceeds/);
        await expect(
            service.write({
                ...base,
                body: "x".repeat(MAX_MEMORY_BODY_BYTES + 1),
            })
        ).rejects.toThrow(/body exceeds/);
        await expect(service.write({ ...base, tags: [] })).rejects.toThrow(
            /between 1 and 20 tags/
        );
        await expect(
            service.write({
                ...base,
                tags: Array.from(
                    { length: 21 },
                    (_, index) => `topic:t${String(index)}`
                ),
            })
        ).rejects.toThrow(/between 1 and 20 tags/);
        await expect(
            service.write({ ...base, tags: ["no-namespace"] })
        ).rejects.toThrow(/namespace:value/);
        await expect(
            service.write({ ...base, tags: ["type:"] })
        ).rejects.toThrow(/namespace:value/);
        await expect(
            service.write({
                ...base,
                confidence: "certain" as MemoryConfidence,
            })
        ).rejects.toThrow(/confidence/);
        await expect(
            service.write({ ...base, id: "self", supersedes: ["self"] })
        ).rejects.toThrow(/supersede itself/);
        expect(await service.search()).toStrictEqual([]);
    });

    it("rejects credentials in the title, body, or source", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const base = {
            title: "Clean title",
            tags: ["type:fact"],
            body: "clean body",
        };
        await expect(
            service.write({ ...base, body: "sk-abcdefghijklmnopqrstuvwxyz" })
        ).rejects.toBeInstanceOf(SecretDetectedError);
        await expect(
            service.write({ ...base, title: "AKIAABCDEFGHIJKLMNOP" })
        ).rejects.toBeInstanceOf(SecretDetectedError);
        await expect(
            service.write({
                ...base,
                source: "password=correct-horse-battery",
            })
        ).rejects.toBeInstanceOf(SecretDetectedError);
        expect(await service.search()).toStrictEqual([]);
    });
});

describe("MemoryService search", () => {
    it("scores title matches above tag matches and body matches", async () => {
        const root = await makeRoot();
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-body",
                title: "Nothing here",
                body: "alpha keyword in body",
                updated: "2026-01-02T00:00:00.000Z",
            })
        );
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-tags",
                title: "Nothing here",
                tags: ["topic:alpha"],
                updated: "2026-01-03T00:00:00.000Z",
            })
        );
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-title",
                title: "Alpha in title",
                updated: "2026-01-01T00:00:00.000Z",
            })
        );
        const service = makeService(root);
        const hits = await service.search({ query: "alpha" });
        expect(hits.map((hit) => hit.id)).toStrictEqual([
            "entry-title",
            "entry-tags",
            "entry-body",
        ]);
    });

    it("filters by required tags and returns a case-insensitive match", async () => {
        const root = await makeRoot();
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-fact",
                tags: ["type:fact"],
                title: "alpha",
            })
        );
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-pref",
                tags: ["type:preference"],
                title: "alpha",
            })
        );
        const service = makeService(root);
        const hits = await service.search({
            query: "ALPHA",
            tags: ["type:preference"],
        });
        expect(hits.map((hit) => hit.id)).toStrictEqual(["entry-pref"]);
    });

    it("returns the most recently updated entries for an empty query", async () => {
        const root = await makeRoot();
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-old",
                updated: "2026-01-01T00:00:00.000Z",
            })
        );
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-new",
                updated: "2026-01-03T00:00:00.000Z",
            })
        );
        await writeRawEntry(
            root,
            sampleEntry({
                id: "entry-mid",
                updated: "2026-01-02T00:00:00.000Z",
            })
        );
        const service = makeService(root);
        const hits = await service.search();
        expect(hits.map((hit) => hit.id)).toStrictEqual([
            "entry-new",
            "entry-mid",
            "entry-old",
        ]);
    });

    it("breaks updated ties by id", async () => {
        const root = await makeRoot();
        await writeRawEntry(root, sampleEntry({ id: "entry-b" }));
        await writeRawEntry(root, sampleEntry({ id: "entry-a" }));
        const service = makeService(root);
        const hits = await service.search();
        expect(hits.map((hit) => hit.id)).toStrictEqual(["entry-a", "entry-b"]);
    });

    it("uses the default limit of 10 and caps an explicit limit at 50", async () => {
        const root = await makeRoot();
        const entries = Array.from({ length: 55 }, (_, index) =>
            sampleEntry({
                id: `entry-${String(index).padStart(2, "0")}`,
                updated: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
            })
        );
        await Promise.all(entries.map((entry) => writeRawEntry(root, entry)));
        const service = makeService(root);
        expect(await service.search()).toHaveLength(DEFAULT_SEARCH_LIMIT);
        expect(await service.search({ limit: 100 })).toHaveLength(
            MAX_SEARCH_LIMIT
        );
        expect(await service.search({ limit: 2 })).toHaveLength(2);
        expect(await makeService(root, 3).search()).toHaveLength(3);
    });

    it("skips malformed files and archived entries", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "entries"), { recursive: true });
        await writeFile(join(root, "entries", "garbage.md"), "not an entry");
        await writeFile(
            join(root, "entries", "mismatch.md"),
            serializeMemoryFile(sampleEntry({ id: "other-id" }))
        );
        await writeFile(
            join(root, "entries", "archived.md"),
            serializeMemoryFile(
                sampleEntry({ id: "archived", status: "archived" })
            )
        );
        const service = makeService(root);
        const valid = await service.write({
            title: "Only valid",
            tags: ["type:fact"],
            body: "body",
        });
        const hits = await service.search();
        expect(hits.map((hit) => hit.id)).toStrictEqual([valid.id]);
        expect(await service.read("garbage")).toBeUndefined();
        expect(await service.read("archived")).toBeUndefined();
        const stats = await service.stats();
        expect(stats.active).toBe(1);
        expect(stats.archived).toBe(1);
        expect(stats.invalid).toBe(2);
    });

    it("serializes concurrent writes instead of losing entries", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const writes = Array.from({ length: 10 }, (_, index) =>
            service.write({
                id: `entry-${String(index)}`,
                title: `Entry ${String(index)}`,
                tags: ["type:fact"],
                body: `body ${String(index)}`,
            })
        );
        const entries = await Promise.all(writes);
        expect(entries).toHaveLength(10);
        expect(new Set(entries.map((entry) => entry.id)).size).toBe(10);
        expect(await readdir(join(root, "entries"))).toHaveLength(10);
        for (const entry of entries) {
            expect((await service.read(entry.id))?.body).toBe(entry.body);
        }
    });
});

describe("MemoryService forget and supersede", () => {
    it("moves a forgotten entry to archive and hides it from search", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const entry = await service.write({
            title: "Forget me",
            tags: ["type:fact"],
            body: "obsolete",
        });
        const archived = await service.forget(entry.id);
        expect(archived.status).toBe("archived");
        await expect(
            readFile(join(root, "entries", `${entry.id}.md`), "utf8")
        ).rejects.toMatchObject({ code: "ENOENT" });
        const archiveText = await readFile(
            join(root, "archive", `${entry.id}.md`),
            "utf8"
        );
        expect(parseMemoryFile(archiveText).status).toBe("archived");
        expect(await service.read(entry.id)).toBeUndefined();
        expect(await service.search()).toStrictEqual([]);
        const stats = await service.stats();
        expect(stats.active).toBe(0);
        expect(stats.archived).toBe(1);
        expect(stats.bytes).toBe(
            (await stat(join(root, "archive", `${entry.id}.md`))).size
        );
    });

    it("refuses to forget a missing entry twice", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        await expect(service.forget("no-such-entry")).rejects.toThrow(
            /was not found/
        );
        const entry = await service.write({
            title: "Once",
            tags: ["type:fact"],
            body: "body",
        });
        await service.forget(entry.id);
        await expect(service.forget(entry.id)).rejects.toThrow(/was not found/);
    });

    it("rejects reviving an archived id", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const entry = await service.write({
            title: "Original",
            tags: ["type:fact"],
            body: "body",
        });
        await service.forget(entry.id);
        await expect(
            service.write({
                id: entry.id,
                title: "Revived",
                tags: ["type:fact"],
                body: "body",
            })
        ).rejects.toThrow(/archived/);
    });

    it("archives entries named by supersedes", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const old = await service.write({
            title: "Old preference",
            tags: ["type:preference"],
            body: "old",
        });
        const replacement = await service.write({
            title: "New preference",
            tags: ["type:preference"],
            body: "new",
            supersedes: old.id,
        });
        expect(replacement.supersedes).toStrictEqual([old.id]);
        expect(await service.read(old.id)).toBeUndefined();
        const archived = parseMemoryFile(
            await readFile(join(root, "archive", `${old.id}.md`), "utf8")
        );
        expect(archived.status).toBe("archived");
        const hits = await service.search();
        expect(hits.map((hit) => hit.id)).toStrictEqual([replacement.id]);
        const stats = await service.stats();
        expect(stats.active).toBe(1);
        expect(stats.archived).toBe(1);
    });

    it("ignores supersedes ids that do not exist or are archived", async () => {
        const root = await makeRoot();
        const service = makeService(root);
        const old = await service.write({
            title: "Old",
            tags: ["type:fact"],
            body: "old",
        });
        await service.forget(old.id);
        const entry = await service.write({
            title: "New",
            tags: ["type:fact"],
            body: "new",
            supersedes: [old.id, "never-existed"],
        });
        expect(await service.read(entry.id)).toStrictEqual(entry);
        expect((await service.stats()).archived).toBe(1);
    });
});
