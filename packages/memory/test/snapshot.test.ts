import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "../src/frontmatter.js";
import {
    SNAPSHOT_ENTRY_MAX_CHARS,
    SNAPSHOT_HEADER,
    SNAPSHOT_LONG_TERM_GROUP,
    SNAPSHOT_PROFILE_GROUP,
    isSnapshotEntry,
    renderMemorySnapshot,
} from "../src/snapshot.js";

const OPTIONS = {
    maxChars: 3000,
    maxEntries: 20,
    autoTags: ["type:person", "type:preference"],
};

function entry(
    overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "id">
): MemoryEntry {
    return {
        title: overrides.id,
        tags: ["type:fact"],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        confidence: "medium",
        status: "active",
        pinned: false,
        supersedes: [],
        body: "body",
        ...overrides,
    };
}

describe("memory snapshot selection", () => {
    it("includes pinned entries and auto-tagged entries only", () => {
        const pinned = entry({ id: "mem-pinned", pinned: true });
        const preference = entry({
            id: "mem-pref",
            tags: ["type:preference"],
        });
        const person = entry({ id: "mem-person", tags: ["type:person"] });
        const plain = entry({ id: "mem-plain", tags: ["type:fact"] });
        expect(isSnapshotEntry(pinned, OPTIONS.autoTags)).toBe(true);
        expect(isSnapshotEntry(preference, OPTIONS.autoTags)).toBe(true);
        expect(isSnapshotEntry(person, OPTIONS.autoTags)).toBe(true);
        expect(isSnapshotEntry(plain, OPTIONS.autoTags)).toBe(false);
    });

    it("skips low-confidence auto entries but keeps explicit pins", () => {
        const lowPreference = entry({
            id: "mem-low",
            tags: ["type:preference"],
            confidence: "low",
        });
        const lowPinned = entry({
            id: "mem-low-pinned",
            tags: ["type:preference"],
            confidence: "low",
            pinned: true,
        });
        expect(isSnapshotEntry(lowPreference, OPTIONS.autoTags)).toBe(false);
        expect(isSnapshotEntry(lowPinned, OPTIONS.autoTags)).toBe(true);
        const snapshot = renderMemorySnapshot(
            [lowPreference, lowPinned],
            OPTIONS
        );
        expect(snapshot.text).toContain("mem-low-pinned");
        expect(snapshot.text).not.toContain("mem-low：");
    });

    it("filters archived and non-active entries", () => {
        const archived = entry({
            id: "mem-archived",
            pinned: true,
            status: "archived",
        });
        expect(isSnapshotEntry(archived, OPTIONS.autoTags)).toBe(false);
        expect(renderMemorySnapshot([archived], OPTIONS).text).toBe("");
    });

    it("renders nothing when no entry qualifies", () => {
        const snapshot = renderMemorySnapshot(
            [entry({ id: "mem-plain", tags: ["type:fact"] })],
            OPTIONS
        );
        expect(snapshot).toStrictEqual({
            text: "",
            included: 0,
            omitted: 0,
        });
    });
});

describe("memory snapshot rendering", () => {
    it("renders the header, two groups, and single-line entries", () => {
        const person = entry({
            id: "mem-person",
            title: "称呼",
            tags: ["type:person"],
            body: "用户希望被称呼为老板。\n第二行不要保留。",
        });
        const decision = entry({
            id: "mem-decision",
            title: "部署决定",
            tags: ["type:decision"],
            pinned: true,
            body: "所有 NixOS 密钥走 agenix。",
        });
        const snapshot = renderMemorySnapshot([person, decision], OPTIONS);
        expect(snapshot.included).toBe(2);
        expect(snapshot.omitted).toBe(0);
        expect(snapshot.text.startsWith(SNAPSHOT_HEADER)).toBe(true);
        expect(snapshot.text).toContain(SNAPSHOT_PROFILE_GROUP);
        expect(snapshot.text).toContain(SNAPSHOT_LONG_TERM_GROUP);
        expect(snapshot.text).toContain(
            "- 称呼：用户希望被称呼为老板。 第二行不要保留。"
        );
        expect(snapshot.text).toContain(
            "- 部署决定：所有 NixOS 密钥走 agenix。"
        );
        expect(snapshot.text).not.toContain("另有");
    });

    it("orders pinned first, then updated descending, then id", () => {
        const older = entry({
            id: "mem-b",
            title: "Older pinned",
            tags: ["type:preference"],
            pinned: true,
            updated: "2026-01-01T00:00:00.000Z",
        });
        const newer = entry({
            id: "mem-a",
            title: "Newer pinned",
            tags: ["type:preference"],
            pinned: true,
            updated: "2026-02-01T00:00:00.000Z",
        });
        const unpinned = entry({
            id: "mem-0",
            title: "Unpinned tagged",
            tags: ["type:preference"],
            updated: "2026-03-01T00:00:00.000Z",
        });
        const first = renderMemorySnapshot(
            [unpinned, older, newer],
            OPTIONS
        ).text;
        const second = renderMemorySnapshot(
            [newer, unpinned, older],
            OPTIONS
        ).text;
        expect(first).toBe(second);
        const profile = first.indexOf(SNAPSHOT_PROFILE_GROUP);
        expect(profile).toBeGreaterThan(-1);
        const newerIndex = first.indexOf("Newer pinned");
        const olderIndex = first.indexOf("Older pinned");
        const unpinnedIndex = first.indexOf("Unpinned tagged");
        expect(newerIndex).toBeGreaterThan(profile);
        expect(newerIndex).toBeLessThan(olderIndex);
        expect(olderIndex).toBeLessThan(unpinnedIndex);
    });

    it("collapses and truncates one entry line to the cap", () => {
        const long = entry({
            id: "mem-long",
            title: "Long",
            tags: ["type:person"],
            body: "x".repeat(SNAPSHOT_ENTRY_MAX_CHARS * 2),
        });
        const text = renderMemorySnapshot([long], OPTIONS).text;
        const line = text
            .split("\n")
            .find((candidate) => candidate.startsWith("- Long："));
        expect(line).toBeDefined();
        expect((line ?? "").length).toBe(SNAPSHOT_ENTRY_MAX_CHARS);
        expect(line?.endsWith("…")).toBe(true);
    });

    it("truncates by entry budget and appends the footer", () => {
        const entries = [
            entry({ id: "mem-1", title: "One", pinned: true }),
            entry({ id: "mem-2", title: "Two", pinned: true }),
            entry({ id: "mem-3", title: "Three", pinned: true }),
        ];
        const snapshot = renderMemorySnapshot(entries, {
            ...OPTIONS,
            maxEntries: 2,
        });
        expect(snapshot.included).toBe(2);
        expect(snapshot.omitted).toBe(1);
        expect(snapshot.text).toContain("Two");
        expect(snapshot.text).not.toContain("Three");
        expect(
            snapshot.text.endsWith("另有 1 条未注入，可用 memory search")
        ).toBe(true);
    });

    it("truncates by character budget", () => {
        const headerLength = SNAPSHOT_HEADER.length;
        const entries = [
            entry({
                id: "mem-1",
                title: "One",
                tags: ["type:person"],
                body: "a".repeat(100),
            }),
            entry({
                id: "mem-2",
                title: "Two",
                tags: ["type:person"],
                body: "b".repeat(100),
            }),
        ];
        const snapshot = renderMemorySnapshot(entries, {
            ...OPTIONS,
            maxChars: headerLength + 150,
        });
        expect(snapshot.included).toBe(1);
        expect(snapshot.omitted).toBe(1);
        expect(snapshot.text.length).toBeLessThanOrEqual(headerLength + 150);
        expect(snapshot.text).toContain("另有 1 条未注入，可用 memory search");
    });

    it("counts omitted entries across both groups", () => {
        const entries = [
            entry({ id: "mem-p1", title: "P1", tags: ["type:person"] }),
            entry({ id: "mem-p2", title: "P2", tags: ["type:person"] }),
            entry({ id: "mem-l1", title: "L1", pinned: true }),
            entry({ id: "mem-l2", title: "L2", pinned: true }),
        ];
        const snapshot = renderMemorySnapshot(entries, {
            ...OPTIONS,
            maxEntries: 3,
        });
        expect(snapshot.included).toBe(3);
        expect(snapshot.omitted).toBe(1);
        expect(snapshot.text).toContain("另有 1 条未注入");
    });
});
