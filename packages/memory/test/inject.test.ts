import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt, {
    renderContextSections,
} from "@deepseek-ai/dsh-system-prompt";
import type { PromptContext } from "@deepseek-ai/dsh-system-prompt";
import { createLogger } from "@nokoribi/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
    DEFAULT_INJECT_AUTO_TAGS,
    DEFAULT_INJECT_ENABLE,
    DEFAULT_INJECT_MAIN_ONLY,
    DEFAULT_INJECT_MAX_CHARS,
    DEFAULT_INJECT_MAX_ENTRIES,
    MEMORY_CONTEXT_NAME,
    MemorySnapshotInjector,
    resolveInjectConfig,
} from "../src/inject.js";
import { MemoryService } from "../src/store.js";

const directories: string[] = [];

async function makeRoot(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-memory-inject-"));
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

function logger(sink: string[] = []) {
    return createLogger("memory", (line) => sink.push(line), "warn");
}

function mainAgent(): Agent {
    return {
        id: "main-1",
        session: { header: {} },
    } as unknown as Agent;
}

function childAgent(): Agent {
    return {
        id: "goal-1",
        session: {
            header: { origin: "subagent", parentSession: "main-1" },
        },
    } as unknown as Agent;
}

interface CapturedContext {
    context?: PromptContext;
    preStep?: (
        payload: { agent: Agent; turn: number; step: number },
        next: () => Promise<unknown>
    ) => Promise<unknown>;
}

function fakeContext(captured: CapturedContext): Context {
    return {
        systemPrompt: {
            context: (context: PromptContext) => {
                captured.context = context;
                return () => {};
            },
        },
        on: (
            name: string,
            listener: CapturedContext["preStep"] & (() => void)
        ) => {
            if (name === "agent/pre-step") captured.preStep = listener;
            return () => {};
        },
        effect: (callback: () => () => void) => callback(),
    } as unknown as Context;
}

describe("resolveInjectConfig", () => {
    it("fills every default for a root-only configuration", () => {
        expect(resolveInjectConfig(undefined)).toStrictEqual({
            enable: DEFAULT_INJECT_ENABLE,
            maxChars: DEFAULT_INJECT_MAX_CHARS,
            maxEntries: DEFAULT_INJECT_MAX_ENTRIES,
            mainOnly: DEFAULT_INJECT_MAIN_ONLY,
            autoTags: [...DEFAULT_INJECT_AUTO_TAGS],
        });
    });

    it("accepts partial overrides and normalizes tags", () => {
        expect(
            resolveInjectConfig({
                enable: false,
                maxChars: 100,
                maxEntries: 2,
                mainOnly: false,
                autoTags: [" type:fact ", "type:fact", ""],
            })
        ).toStrictEqual({
            enable: false,
            maxChars: 100,
            maxEntries: 2,
            mainOnly: false,
            autoTags: ["type:fact"],
        });
    });

    it("rejects invalid budgets", () => {
        expect(() => resolveInjectConfig({ maxChars: 0 })).toThrow(
            /positive integer/
        );
        expect(() => resolveInjectConfig({ maxEntries: 1.5 })).toThrow(
            /positive integer/
        );
    });
});

describe("MemorySnapshotInjector", () => {
    it("renders the first snapshot at startup and publishes status", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        await service.write({
            title: "称呼",
            tags: ["type:person"],
            body: "用户希望被称为老板。",
        });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger()
        );
        await injector.initialize();
        expect(injector.snapshotText).toContain("称呼");
        expect(injector.snapshotText).toContain("长期记忆快照");
        expect(service.runtimeStatus).toStrictEqual({
            enabled: true,
            snapshotChars: injector.snapshotText.length,
        });
    });

    it("publishes disabled status without rendering", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig({ enable: false }),
            logger()
        );
        await injector.initialize();
        expect(injector.snapshotText).toBe("");
        expect(service.runtimeStatus).toStrictEqual({
            enabled: false,
            snapshotChars: 0,
        });
    });

    it("freezes one snapshot per turn and refreshes on the next turn", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger()
        );
        await injector.initialize();
        const agent = mainAgent();
        await injector.refresh(agent, 1);
        expect(injector.snapshotText).toBe("");
        const entry = await service.write({
            title: "称呼",
            tags: ["type:person"],
            body: "用户希望被称为老板。",
        });
        injector.invalidate();
        await injector.refresh(agent, 1);
        expect(injector.snapshotText).toBe("");
        await injector.refresh(agent, 2);
        expect(injector.snapshotText).toContain("称呼");
        await service.forget(entry.id);
        await injector.refresh(agent, 2);
        expect(injector.snapshotText).toContain("称呼");
        await injector.refresh(agent, 3);
        expect(injector.snapshotText).toBe("");
    });

    it("picks up external entries-directory edits on the next turn", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger()
        );
        await injector.initialize();
        const agent = mainAgent();
        await injector.refresh(agent, 1);
        await writeFile(
            join(root, "entries", "mem-external.md"),
            [
                "---",
                'id: "mem-external"',
                'title: "External"',
                'tags: ["type:person"]',
                'created: "2026-01-01T00:00:00.000Z"',
                'updated: "2026-01-01T00:00:00.000Z"',
                "pinned: true",
                "---",
                "",
                "外部编辑写入的条目。",
            ].join("\n")
        );
        await injector.refresh(agent, 2);
        expect(injector.snapshotText).toContain("External");
    });

    it("keeps the previous snapshot when rendering fails", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        const sink: string[] = [];
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger(sink)
        );
        await injector.initialize();
        service.listActive = async () => {
            throw new Error("disk boom");
        };
        await expect(injector.refresh(mainAgent(), 1)).resolves.toBeUndefined();
        expect(sink.some((line) => line.includes("disk boom"))).toBe(true);
    });

    it("registers a required runtime context and a pre-step listener", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        await service.write({
            title: "称呼",
            tags: ["type:person"],
            body: "用户希望被称为老板。",
        });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger()
        );
        await injector.initialize();
        const captured: CapturedContext = {};
        injector.install(fakeContext(captured));
        const context = captured.context;
        expect(context?.name).toBe(MEMORY_CONTEXT_NAME);
        expect(context?.required).toBe(true);
        expect(context?.interpolate).toBe(false);
        const text = context?.text;
        if (typeof text !== "function") throw new Error("context text missing");
        const main = mainAgent();
        expect(text({ agent: main })).toContain("称呼");
        expect(text({ agent: childAgent() })).toBe("");
        expect(text({})).toBe("");
        const preStep = captured.preStep;
        if (preStep === undefined) throw new Error("pre-step not registered");
        let entered = false;
        await preStep({ agent: main, turn: 1, step: 1 }, async () => {
            entered = true;
            return { kind: "enter", messages: [] };
        });
        expect(entered).toBe(true);
    });

    it("registers nothing when disabled", async () => {
        const root = await makeRoot();
        const service = new MemoryService(new Context(), { root });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig({ enable: false }),
            logger()
        );
        await injector.initialize();
        const captured: CapturedContext = {};
        injector.install(fakeContext(captured));
        expect(captured.context).toBeUndefined();
        expect(captured.preStep).toBeUndefined();
    });

    it("keeps the context when optional runtime context is suppressed", async () => {
        const ctx = new Context();
        await ctx.plugin(SystemPrompt, { includeRuntimeContext: false });
        const root = await makeRoot();
        const service = new MemoryService(ctx, { root });
        await service.write({
            title: "称呼",
            tags: ["type:person"],
            body: "用户希望被称为老板。",
        });
        const injector = new MemorySnapshotInjector(
            service,
            resolveInjectConfig(undefined),
            logger()
        );
        await injector.initialize();
        injector.install(ctx);
        const agent = mainAgent();
        const assembly = await ctx.systemPrompt.assemble({ agent });
        const sections = renderContextSections(assembly);
        expect(
            sections.some((section) => section.name === MEMORY_CONTEXT_NAME)
        ).toBe(true);
        expect(
            assembly.contexts.find(
                (context) => context.name === MEMORY_CONTEXT_NAME
            )?.text
        ).toContain("称呼");
    });
});
