import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import type { SandboxHost, SandboxStatus } from "../src/host.js";
import { createSandboxTools } from "../src/tools.js";

function agent(sessionId = "main-1"): Agent {
    return {
        id: sessionId,
        session: { header: { id: sessionId } },
    } as unknown as Agent;
}

function exec(withAgent = true): ToolRunContext {
    return {
        callId: "call-1",
        rootCallId: "call-1",
        name: "sandbox",
        arguments: {},
        signal: new AbortController().signal,
        ...(withAgent ? { agent: agent() } : {}),
        deferContext: () => {},
        concludeTurn: () => {},
    } as unknown as ToolRunContext;
}

function status(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
    return {
        host: "sandbox:default",
        sessionId: "main-1",
        dir: "/home/sandboxes/main-1",
        exists: true,
        generation: 2,
        packages: ["nixpkgs#hello"],
        createdAt: "2026-10-25T00:00:00.000Z",
        lastUsedAt: "2026-10-25T00:01:00.000Z",
        idleTtlMs: 1_800_000,
        activeCommands: 0,
        backgroundCommands: 0,
        terminalSessions: 0,
        allowRuntimePackages: true,
        ...overrides,
    };
}

function fakeHost(overrides: Partial<SandboxHost> = {}): SandboxHost {
    return {
        status: async () => status(),
        reset: async () => {},
        addPackages: async (
            _sessionId: string,
            packages: readonly string[]
        ) => [...packages],
        removePackages: async (
            _sessionId: string,
            packages: readonly string[]
        ) => packages.filter((item) => item !== "nixpkgs#hello"),
        listPackages: async () => ["nixpkgs#hello"],
        ...overrides,
    } as unknown as SandboxHost;
}

function textOf(blocks: readonly { type: string }[]): string {
    const block = blocks[0] as { type: "text"; text: string } | undefined;
    return block?.text ?? "";
}

describe("sandbox tools", () => {
    it("renders status and reset", async () => {
        const reset = vi.fn(async () => {});
        const host = fakeHost({ reset });
        const tools = createSandboxTools(host);
        const value = await tools.sandbox.execute({ action: "status" }, exec());
        expect(value).toContain("generation: 2");
        expect(value).toContain("packages: nixpkgs#hello");
        const rendered = tools.sandbox.output.render(
            { action: "status" },
            value as never
        );
        expect(textOf(rendered)).toContain("host: sandbox:default");

        const resetValue = await tools.sandbox.execute(
            { action: "reset" },
            exec()
        );
        expect(reset).toHaveBeenCalledWith("main-1");
        expect(resetValue).toContain("generation: 2");
    });

    it("lists, adds, and removes packages", async () => {
        const host = fakeHost();
        const tools = createSandboxTools(host);
        const listed = await tools.packages.execute({ action: "list" }, exec());
        expect(listed).toContain("nixpkgs#hello");
        const added = await tools.packages.execute(
            { action: "add", packages: ["nixpkgs#jq"] },
            exec()
        );
        expect(added).toContain("nixpkgs#jq");
        const removed = await tools.packages.execute(
            { action: "remove", packages: ["nixpkgs#hello"] },
            exec()
        );
        expect(removed).toContain("packages: (none)");
    });

    it("requires packages for add/remove and an agent session", async () => {
        const tools = createSandboxTools(fakeHost());
        await expect(
            tools.packages.execute({ action: "add", packages: [] }, exec())
        ).rejects.toThrow(/requires packages/);
        await expect(
            tools.sandbox.execute({ action: "status" }, exec(false))
        ).rejects.toThrow(/require an agent session/);
    });
});
