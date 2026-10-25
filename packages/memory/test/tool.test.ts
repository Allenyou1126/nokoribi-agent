import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryService } from "../src/store.js";
import { MEMORY_TOOL_NAME, createMemoryTool } from "../src/tool.js";

const directories: string[] = [];

async function makeRoot(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-memory-tool-"));
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

function fakeExec(): ToolRunContext {
    return {
        callId: "call-1",
        rootCallId: "call-1",
        name: MEMORY_TOOL_NAME,
        arguments: {},
        signal: new AbortController().signal,
        deferContext: () => {},
        concludeTurn: () => {},
    } as unknown as ToolRunContext;
}

async function makeTool(): Promise<{
    readonly root: string;
    readonly service: MemoryService;
    readonly tool: ToolDefinition;
}> {
    const root = await makeRoot();
    const service = new MemoryService(new Context(), { root });
    return { root, service, tool: createMemoryTool(service) };
}

async function run(
    tool: ToolDefinition,
    args: Record<string, unknown>
): Promise<string> {
    return (await tool.execute(args, fakeExec())) as string;
}

function idOf(writeOutput: string): string {
    const match = /`([^`]+)`/.exec(writeOutput);
    if (match === null) throw new Error(`no id in output: ${writeOutput}`);
    return match[1];
}

describe("memory tool", () => {
    it("describes the four actions and their arguments", async () => {
        const { tool } = await makeTool();
        expect(tool.name).toBe("memory");
        expect(tool.description.length).toBeGreaterThan(100);
        const parameters = tool.parameters as {
            readonly properties?: Record<string, unknown>;
            readonly required?: readonly string[];
        };
        expect(Object.keys(parameters.properties ?? {}).sort()).toStrictEqual([
            "action",
            "body",
            "confidence",
            "id",
            "limit",
            "query",
            "source",
            "supersedes",
            "tags",
            "title",
        ]);
        expect(parameters.required).toStrictEqual(["action"]);
        const action = parameters.properties?.action as
            | { enum?: readonly string[] }
            | undefined;
        expect(action?.enum).toStrictEqual([
            "search",
            "read",
            "write",
            "forget",
        ]);
    });

    it("writes, searches, reads, and forgets through Markdown output", async () => {
        const { root, tool } = await makeTool();
        const write = await run(tool, {
            action: "write",
            title: "NixOS deployment",
            tags: ["type:preference", "project:nixos"],
            body: "Use agenix for secrets.",
            source: "session:main-1#turn-2",
            confidence: "high",
        });
        expect(write).toContain("Saved memory entry");
        expect(write).toContain("(created)");
        expect(write).toContain("NixOS deployment");
        const id = idOf(write);
        expect(
            await readFile(join(root, "entries", `${id}.md`), "utf8")
        ).toContain("Use agenix for secrets.");

        const search = await run(tool, { action: "search", query: "agenix" });
        expect(search).toContain("Found 1 memory entry");
        expect(search).toContain(id);
        expect(search).toContain("type:preference");

        const read = await run(tool, { action: "read", id });
        expect(read).toContain("# NixOS deployment");
        expect(read).toContain("- source: session:main-1#turn-2");
        expect(read).toContain("- confidence: high");
        expect(read).toContain("Use agenix for secrets.");

        const forget = await run(tool, { action: "forget", id });
        expect(forget).toContain("Archived memory entry");
        expect(forget).toContain(id);
        await expect(run(tool, { action: "read", id })).rejects.toThrow(
            /was not found/
        );
        expect(await run(tool, { action: "search" })).toBe(
            "No memory entries matched."
        );
    });

    it("reports an update and superseded ids", async () => {
        const { tool } = await makeTool();
        const first = await run(tool, {
            action: "write",
            title: "Old",
            tags: ["type:fact"],
            body: "old body",
        });
        const oldId = idOf(first);
        const update = await run(tool, {
            action: "write",
            id: oldId,
            title: "New",
            tags: ["type:fact"],
            body: "new body",
        });
        expect(update).toContain("(updated)");
        expect(idOf(update)).toBe(oldId);
        const second = await run(tool, {
            action: "write",
            title: "Replacement",
            tags: ["type:fact"],
            body: "replacement body",
            supersedes: [oldId],
        });
        expect(second).toContain("supersedes");
        expect(second).toContain(oldId);
        await expect(run(tool, { action: "read", id: oldId })).rejects.toThrow(
            /was not found/
        );
    });

    it("requires the arguments each action needs", async () => {
        const { tool } = await makeTool();
        await expect(run(tool, { action: "read" })).rejects.toThrow(
            /requires "id"/
        );
        await expect(run(tool, { action: "forget" })).rejects.toThrow(
            /requires "id"/
        );
        await expect(
            run(tool, { action: "write", tags: ["type:fact"], body: "b" })
        ).rejects.toThrow(/requires "title"/);
        await expect(
            run(tool, { action: "write", title: "T", body: "b" })
        ).rejects.toThrow(/requires "tags"/);
        await expect(
            run(tool, { action: "write", title: "T", tags: ["type:fact"] })
        ).rejects.toThrow(/requires "body"/);
        await expect(
            run(tool, { action: "read", id: "missing" })
        ).rejects.toThrow(/was not found/);
    });

    it("rejects malformed tool arguments and credentials", async () => {
        const { tool } = await makeTool();
        await expect(run(tool, { action: "unknown" })).rejects.toThrow();
        await expect(
            run(tool, {
                action: "search",
                limit: "ten",
            })
        ).rejects.toThrow();
        await expect(
            run(tool, {
                action: "write",
                title: "T",
                tags: ["type:fact"],
                body: "sk-abcdefghijklmnopqrstuvwxyz",
            })
        ).rejects.toThrow(/must never contain secrets/);
        await expect(
            run(tool, {
                action: "write",
                title: "T",
                tags: ["not-a-tag"],
                body: "b",
            })
        ).rejects.toThrow(/namespace:value/);
    });

    it("renders its string value as one text block", async () => {
        const { tool } = await makeTool();
        expect(tool.output.render({}, "hello")).toStrictEqual([
            { type: "text", text: "hello" },
        ]);
    });
});
