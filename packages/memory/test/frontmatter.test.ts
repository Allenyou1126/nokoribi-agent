import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "../src/frontmatter.js";
import {
    DEFAULT_CONFIDENCE,
    MemoryFormatError,
    normalizeBody,
    parseFrontmatter,
    parseMemoryFile,
    serializeMemoryFile,
    tryParseMemoryFile,
} from "../src/frontmatter.js";

const fullEntry: MemoryEntry = {
    id: "mem-20261025-013000-abc123",
    title: "用户偏好：NixOS 部署使用 agenix",
    tags: ["type:preference", "project:nokoribi-agent", "topic:nix"],
    source: "session:main-1#turn-12",
    created: "2026-10-25T01:30:00+08:00",
    updated: "2026-10-25T02:00:00+08:00",
    confidence: "high",
    status: "active",
    supersedes: ["mem-20261024-000000-000000"],
    body: "用户希望所有 NixOS 密钥通过 agenix 管理。\n\n不使用明文 EnvironmentFile。",
};

describe("frontmatter serialization", () => {
    it("round-trips every field through a Markdown document", () => {
        const text = serializeMemoryFile(fullEntry);
        expect(parseMemoryFile(text)).toStrictEqual(fullEntry);
    });

    it("writes strings as JSON scalars and tags as a JSON flow array", () => {
        const text = serializeMemoryFile(fullEntry);
        const lines = text.split("\n");
        expect(lines[0]).toBe("---");
        expect(lines).toContain('id: "mem-20261025-013000-abc123"');
        expect(lines).toContain('title: "用户偏好：NixOS 部署使用 agenix"');
        expect(lines).toContain(
            'tags: ["type:preference","project:nokoribi-agent","topic:nix"]'
        );
        expect(lines).toContain('source: "session:main-1#turn-12"');
        expect(lines).toContain('confidence: "high"');
        expect(lines).toContain('status: "active"');
        expect(lines).toContain('supersedes: ["mem-20261024-000000-000000"]');
        expect(lines).toContain("---");
        expect(text.endsWith("\n")).toBe(true);
    });

    it("writes null supersedes and no source when they are absent", () => {
        const entry: MemoryEntry = {
            id: "mem-optional",
            title: "Optional fields",
            tags: ["type:fact"],
            created: "2026-10-25T01:30:00Z",
            updated: "2026-10-25T02:00:00Z",
            confidence: "low",
            status: "active",
            supersedes: [],
            body: "body",
        };
        const text = serializeMemoryFile(entry);
        expect(text).toContain("supersedes: null\n");
        expect(text).not.toContain("source:");
        expect(parseMemoryFile(text)).toStrictEqual(entry);
    });

    it("round-trips quotes, backslashes, and colons", () => {
        const entry: MemoryEntry = {
            ...fullEntry,
            title: 'He said "hi" and \\ left',
            source: "session:a:b#turn-1",
            body: "line 1\n---\nline 3",
        };
        const parsed = parseMemoryFile(serializeMemoryFile(entry));
        expect(parsed).toStrictEqual(entry);
    });

    it("writes an empty body without a trailing blank section", () => {
        const entry: MemoryEntry = { ...fullEntry, body: "" };
        const text = serializeMemoryFile(entry);
        expect(text.endsWith("---\n")).toBe(true);
        expect(parseMemoryFile(text).body).toBe("");
    });

    it("normalizes CRLF and surrounding blank lines", () => {
        expect(normalizeBody("\r\n\r\nfirst\r\nsecond\r\n\r\n")).toBe(
            "first\nsecond"
        );
    });
});

describe("frontmatter parsing", () => {
    it("defaults optional fields on hand-written entries", () => {
        const text = [
            "---",
            "id: mem-handwritten",
            "title: Hand written",
            "tags: type:fact",
            "created: 2026-10-25T01:30:00Z",
            "updated: 2026-10-25T02:00:00Z",
            "---",
            "",
            "Body text.",
        ].join("\n");
        expect(parseMemoryFile(text)).toStrictEqual({
            id: "mem-handwritten",
            title: "Hand written",
            tags: ["type:fact"],
            created: "2026-10-25T01:30:00Z",
            updated: "2026-10-25T02:00:00Z",
            confidence: DEFAULT_CONFIDENCE,
            status: "active",
            supersedes: [],
            body: "Body text.",
        });
    });

    it("returns frontmatter and body separately", () => {
        const parsed = parseFrontmatter(serializeMemoryFile(fullEntry));
        expect(parsed.frontmatter.id).toBe(fullEntry.id);
        expect(parsed.frontmatter.tags).toStrictEqual(fullEntry.tags);
        expect(parsed.body).toBe(fullEntry.body);
    });

    it("accepts a scalar supersedes and single-quoted scalars", () => {
        const text = [
            "---",
            "id: 'mem-1'",
            "title: 'Single quoted'",
            'tags: ["type:fact"]',
            "created: '2026-10-25T01:30:00Z'",
            "updated: '2026-10-25T02:00:00Z'",
            "confidence: high",
            "status: active",
            "supersedes: mem-0",
            "---",
        ].join("\n");
        const parsed = parseMemoryFile(text);
        expect(parsed.title).toBe("Single quoted");
        expect(parsed.tags).toStrictEqual(["type:fact"]);
        expect(parsed.supersedes).toStrictEqual(["mem-0"]);
    });

    it.each([
        ["missing opening delimiter", "id: mem-1\n---\nbody"],
        ["missing closing delimiter", "---\nid: mem-1\nbody"],
        [
            "missing required title",
            '---\nid: "mem-1"\ntags: ["type:fact"]\n' +
                'created: "2026-10-25T01:30:00Z"\n' +
                'updated: "2026-10-25T01:30:00Z"\n---\nbody',
        ],
        [
            "invalid JSON scalar",
            '---\nid: "unterminated\ntitle: "T"\n---\nbody',
        ],
        [
            "invalid confidence",
            '---\nid: "mem-1"\ntitle: "T"\ntags: ["type:fact"]\n' +
                'created: "2026-10-25T01:30:00Z"\n' +
                'updated: "2026-10-25T01:30:00Z"\nconfidence: certain\n---\n',
        ],
        [
            "invalid timestamp",
            '---\nid: "mem-1"\ntitle: "T"\ntags: ["type:fact"]\n' +
                'created: yesterday\nupdated: "2026-10-25T01:30:00Z"\n---\n',
        ],
        [
            "unsupported frontmatter line",
            '---\nid: "mem-1"\ntitle: "T"\ntags: ["type:fact"]\n' +
                'created: "2026-10-25T01:30:00Z"\n' +
                'updated: "2026-10-25T01:30:00Z"\n- stray list item\n---\n',
        ],
    ])("rejects %s", (_label, text) => {
        expect(() => parseMemoryFile(text)).toThrow(MemoryFormatError);
        const result = tryParseMemoryFile(text);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(MemoryFormatError);
    });
});
