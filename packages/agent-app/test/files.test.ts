import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { FileAttachmentRef } from "@nokoribi/channel-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createSendToUserTool,
    readOutboundFile,
    type SendToUserToolOptions,
} from "../src/files.js";

const dirs: string[] = [];

async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-files-tool-"));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(
        dirs
            .splice(0)
            .map((dir) =>
                rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(
                    () => undefined
                )
            )
    );
});

function fakeExec(): ToolRunContext {
    return {
        callId: "call-1",
        rootCallId: "call-1",
        name: "send_to_user",
        arguments: {},
        signal: new AbortController().signal,
        deferContext: () => {},
        concludeTurn: () => {},
    } as unknown as ToolRunContext;
}

const FILE_REF = {
    attachmentId: "file-1",
    name: "report.txt",
    bytes: 6,
} as unknown as FileAttachmentRef;

interface Harness {
    readonly tool: ToolDefinition;
    readonly workspace: string;
    readonly sendFiles: ReturnType<typeof vi.fn>;
    readonly saveFile: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: Partial<SendToUserToolOptions> = {}): Harness {
    const workspace = overrides.workspaceDir ?? "";
    const sendFiles = vi.fn(async () => [7]);
    const saveFile = vi.fn(async () => FILE_REF);
    const tool = createSendToUserTool({
        workspaceDir: workspace,
        maxBytes: 1024,
        channels: { sendFiles } as unknown as SendToUserToolOptions["channels"],
        saveFile,
        ...overrides,
    });
    return { tool, workspace, sendFiles, saveFile };
}

async function run(
    tool: ToolDefinition,
    args: Record<string, unknown>
): Promise<Record<string, unknown>> {
    return (await tool.execute(args, fakeExec())) as Record<string, unknown>;
}

describe("send_to_user tool", () => {
    it("advertises text and path arguments", () => {
        const { tool } = makeHarness();
        expect(tool.name).toBe("send_to_user");
        expect(tool.description).toContain("workspace");
        const parameters = tool.parameters as {
            properties?: Record<string, unknown>;
        };
        expect(Object.keys(parameters.properties ?? {}).sort()).toEqual([
            "path",
            "text",
        ]);
    });

    it("reads, saves and sends one workspace file with text", async () => {
        const workspace = await makeWorkspace();
        await writeFile(join(workspace, "report.txt"), "hello\n");
        const harness = makeHarness({ workspaceDir: workspace });
        await expect(
            run(harness.tool, { text: " done", path: "report.txt" })
        ).resolves.toEqual({ seq: 7, name: "report.txt", bytes: 6 });
        expect(harness.saveFile).toHaveBeenCalledWith({
            data: new Uint8Array(Buffer.from("hello\n")),
            name: "report.txt",
        });
        expect(harness.sendFiles).toHaveBeenCalledWith([FILE_REF], "done");
    });

    it("sends text only without touching the attachment store", async () => {
        const harness = makeHarness();
        await expect(
            run(harness.tool, { text: "status update" })
        ).resolves.toEqual({ seq: 7, name: "", bytes: 0 });
        expect(harness.saveFile).not.toHaveBeenCalled();
        expect(harness.sendFiles).toHaveBeenCalledWith([], "status update");
    });

    it("sends a file without text", async () => {
        const workspace = await makeWorkspace();
        await writeFile(join(workspace, "report.txt"), "hello\n");
        const harness = makeHarness({ workspaceDir: workspace });
        await expect(
            run(harness.tool, { path: "report.txt" })
        ).resolves.toMatchObject({ seq: 7, name: "report.txt" });
        expect(harness.sendFiles).toHaveBeenCalledWith([FILE_REF], "");
    });

    it("rejects missing arguments, missing files and oversized files", async () => {
        const workspace = await makeWorkspace();
        await writeFile(join(workspace, "big.bin"), new Uint8Array(2048));
        const harness = makeHarness({ workspaceDir: workspace });
        await expect(run(harness.tool, {})).rejects.toThrow(/text|path/);
        await expect(
            run(harness.tool, { path: "missing.txt" })
        ).rejects.toThrow(/不存在/);
        await expect(run(harness.tool, { path: "big.bin" })).rejects.toThrow(
            /过大/
        );
        expect(harness.saveFile).not.toHaveBeenCalled();
    });

    it("accepts absolute paths and reports channel failures", async () => {
        const workspace = await makeWorkspace();
        await writeFile(join(workspace, "absolute.txt"), "abc");
        const harness = makeHarness({
            workspaceDir: workspace,
            maxBytes: 1024 * 1024,
        });
        await expect(
            run(harness.tool, { path: join(workspace, "absolute.txt") })
        ).resolves.toMatchObject({ seq: 7 });
        harness.sendFiles.mockRejectedValueOnce(new Error("channel down"));
        await expect(run(harness.tool, { text: "hi" })).rejects.toThrow(
            /channel down/
        );
    });
});

describe("readOutboundFile", () => {
    it("rejects directories", async () => {
        const workspace = await makeWorkspace();
        await mkdir(join(workspace, "folder"));
        await expect(
            readOutboundFile("folder", workspace, 1024)
        ).rejects.toThrow(/普通文件/);
    });
});
