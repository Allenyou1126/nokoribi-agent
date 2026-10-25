import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    GLOBAL_AGENTS_TEMPLATE,
    WORKSPACE_AGENTS_TEMPLATE,
} from "../src/agents.js";
import * as promptPlugin from "../src/index.js";
import { Config } from "../src/index.js";
import {
    CHILD_DELEGATION_PROMPT,
    GOAL_CHILD_PROMPT,
    GOAL_CHILD_TOOL_PROMPT,
    GOAL_MAIN_PROMPT,
    GOAL_SECTION_NAME,
    GOAL_SECTION_ORDER,
    GOAL_TOOL_SECTION_NAME,
    INTERACTION_PROMPT,
    INTERACTION_SECTION_NAME,
    INTERACTION_SECTION_ORDER,
    MEMORY_PROMPT,
    MEMORY_SECTION_NAME,
    MEMORY_SECTION_ORDER,
    SAFETY_PROMPT,
    SAFETY_SECTION_NAME,
    SAFETY_SECTION_ORDER,
    SCHEDULE_PROMPT,
    SCHEDULE_SECTION_NAME,
    SCHEDULE_SECTION_ORDER,
    SOUL_SECTION_NAME,
    SOUL_SECTION_ORDER,
} from "../src/sections.js";

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-prompt-"));
    directories.push(directory);
    return directory;
}

async function mountPromptHost(): Promise<Context> {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    return ctx;
}

async function writeSoul(
    directory: string,
    text = "你是我的人设。\n"
): Promise<string> {
    const file = join(directory, "SOUL.md");
    await writeFile(file, text);
    return file;
}

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

describe("prompt plugin", () => {
    it("exports the Cordis plugin contract", () => {
        expect(promptPlugin.name).toBe("prompt");
        expect(promptPlugin.inject).toEqual(["systemPrompt"]);
        expect(typeof promptPlugin.apply).toBe("function");
    });

    it("registers the static prompt sections in order", async () => {
        const directory = await makeTempDir();
        const soulFile = await writeSoul(directory);
        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, { soulFile, seedAgents: false });

        const assembly = await ctx.systemPrompt.assemble();
        const names = assembly.sections.map((section) => section.name);
        expect(names).toContain(SOUL_SECTION_NAME);
        expect(names).toContain(INTERACTION_SECTION_NAME);
        expect(names).toContain(MEMORY_SECTION_NAME);
        expect(names).toContain(SAFETY_SECTION_NAME);
        expect(names).toContain(GOAL_SECTION_NAME);
        expect(names).toContain(SCHEDULE_SECTION_NAME);
        expect(names.indexOf(SOUL_SECTION_NAME)).toBeLessThan(
            names.indexOf(INTERACTION_SECTION_NAME)
        );
        expect(names.indexOf(INTERACTION_SECTION_NAME)).toBeLessThan(
            names.indexOf(MEMORY_SECTION_NAME)
        );
        expect(names.indexOf(MEMORY_SECTION_NAME)).toBeLessThan(
            names.indexOf(GOAL_SECTION_NAME)
        );
        expect(names.indexOf(GOAL_SECTION_NAME)).toBeLessThan(
            names.indexOf(SCHEDULE_SECTION_NAME)
        );
        expect(names.indexOf(SCHEDULE_SECTION_NAME)).toBeLessThan(
            names.indexOf(SAFETY_SECTION_NAME)
        );

        const soul = assembly.sections.find(
            (section) => section.name === SOUL_SECTION_NAME
        );
        expect(soul?.text).toBe("你是我的人设。");
        expect(soul?.interpolate).toBe(false);
        const interaction = assembly.sections.find(
            (section) => section.name === INTERACTION_SECTION_NAME
        );
        expect(interaction?.text).toBe(INTERACTION_PROMPT);
        expect(interaction?.interpolate).toBe(false);
        const memory = assembly.sections.find(
            (section) => section.name === MEMORY_SECTION_NAME
        );
        expect(memory?.text).toBe(MEMORY_PROMPT);
        expect(memory?.interpolate).toBe(false);
        const goal = assembly.sections.find(
            (section) => section.name === GOAL_SECTION_NAME
        );
        expect(goal?.text).toBe(GOAL_MAIN_PROMPT);
        expect(goal?.interpolate).toBe(false);
        const schedule = assembly.sections.find(
            (section) => section.name === SCHEDULE_SECTION_NAME
        );
        expect(schedule?.text).toBe(SCHEDULE_PROMPT);
        expect(schedule?.interpolate).toBe(false);
        const safety = assembly.sections.find(
            (section) => section.name === SAFETY_SECTION_NAME
        );
        expect(safety?.text).toBe(SAFETY_PROMPT);
        expect(safety?.interpolate).toBe(false);
        expect(SOUL_SECTION_ORDER).toBe(0);
        expect(INTERACTION_SECTION_ORDER).toBe(4000);
        expect(MEMORY_SECTION_ORDER).toBe(5000);
        expect(GOAL_SECTION_ORDER).toBe(6000);
        expect(SCHEDULE_SECTION_ORDER).toBe(7000);
        expect(SAFETY_SECTION_ORDER).toBe(8000);
    });

    it("documents the memory, schedule, interaction and goal contracts", () => {
        expect(MEMORY_SECTION_NAME).toBe("nokoribi:memory");
        expect(SCHEDULE_SECTION_NAME).toBe("nokoribi:schedule");
        expect(MEMORY_PROMPT).toContain("search");
        expect(MEMORY_PROMPT).toContain("read");
        expect(MEMORY_PROMPT).toContain("write");
        expect(MEMORY_PROMPT).toContain("forget");
        expect(MEMORY_PROMPT).toContain("软归档");
        expect(MEMORY_PROMPT).toContain("不会自动注入");
        expect(MEMORY_PROMPT).toContain("tags");
        expect(MEMORY_PROMPT).toContain("source");
        expect(MEMORY_PROMPT).toContain("密钥");
        expect(SCHEDULE_PROMPT).toContain("schedule_create");
        expect(SCHEDULE_PROMPT).toContain("schedule_list");
        expect(SCHEDULE_PROMPT).toContain("schedule_update");
        expect(SCHEDULE_PROMPT).toContain("schedule_delete");
        expect(SCHEDULE_PROMPT).toContain("title");
        for (const parameter of [
            "after_seconds",
            "at",
            "every_seconds",
            "daily",
            "weekly",
            "cron",
        ]) {
            expect(SCHEDULE_PROMPT).toContain(parameter);
        }
        expect(SCHEDULE_PROMPT).toContain("最小 60 秒");
        expect(SCHEDULE_PROMPT).toContain("IANA");
        expect(SCHEDULE_PROMPT).toContain("[SCHEDULE REMINDER]");
        expect(SCHEDULE_PROMPT).toContain("[SCHEDULE REMINDER BATCH]");
        expect(SCHEDULE_PROMPT).toContain("user 角色消息");
        expect(SCHEDULE_PROMPT).toContain("heartbeat");
        expect(INTERACTION_PROMPT).toContain("/status full");
        expect(INTERACTION_PROMPT).toContain("[SCHEDULE REMINDER]");
        expect(INTERACTION_PROMPT).toContain("[SCHEDULE REMINDER BATCH]");
        expect(INTERACTION_PROMPT).toContain("不进入对话历史");
        expect(GOAL_MAIN_PROMPT).toContain("reasoning_effort");
        expect(GOAL_MAIN_PROMPT).toContain("--model");
        expect(GOAL_MAIN_PROMPT).toContain("--effort");
        expect(GOAL_CHILD_PROMPT).toContain("已由宿主创建");
    });

    it("keeps template braces in the SOUL text literal", async () => {
        const directory = await makeTempDir();
        const soulFile = await writeSoul(
            directory,
            "身份：{{model}} 保持字面量\n"
        );
        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, { soulFile, seedAgents: false });

        const rendered = renderPrompt(await ctx.systemPrompt.assemble());
        expect(rendered).toContain("{{model}}");
    });

    it("fails loud when the SOUL file is missing", async () => {
        const directory = await makeTempDir();
        const ctx = await mountPromptHost();
        const attempt = async (): Promise<void> => {
            await ctx.plugin(promptPlugin, {
                soulFile: join(directory, "missing.md"),
                seedAgents: false,
            });
        };
        await expect(attempt()).rejects.toThrow(/persona file not found/);
    });

    it("removes its sections when the plugin fiber is disposed", async () => {
        const directory = await makeTempDir();
        const soulFile = await writeSoul(directory);
        const ctx = await mountPromptHost();
        const fiber = await ctx.plugin(promptPlugin, {
            soulFile,
            seedAgents: false,
        });
        const loaded = await ctx.systemPrompt.assemble();
        expect(loaded.sections.map((section) => section.name)).toContain(
            SOUL_SECTION_NAME
        );
        await fiber.dispose();
        const names = (await ctx.systemPrompt.assemble()).sections.map(
            (section) => section.name
        );
        expect(names).not.toContain(SOUL_SECTION_NAME);
        expect(names).not.toContain(INTERACTION_SECTION_NAME);
        expect(names).not.toContain(MEMORY_SECTION_NAME);
        expect(names).not.toContain(SCHEDULE_SECTION_NAME);
        expect(names).not.toContain(SAFETY_SECTION_NAME);
    });

    it("replaces the child delegation context only for children", () => {
        const assembly = {
            sections: [],
            contexts: [
                { name: "subagent:delegation", text: "old text" },
                { name: "other", text: "keep" },
            ],
            tools: [],
            variables: {},
        } as unknown as PromptAssembly;
        const child = {
            id: "goal-a1b2c3d4-child",
            session: {
                header: { origin: "subagent", parentSession: "parent" },
            },
        } as unknown as Agent;
        const root = {
            id: "main-1",
            session: { header: {} },
        } as unknown as Agent;
        const replaced = promptPlugin.overrideChildDelegation(assembly, child);
        expect(replaced.contexts[0]?.text).toBe(CHILD_DELEGATION_PROMPT);
        expect(replaced.contexts[1]?.text).toBe("keep");
        expect(promptPlugin.overrideChildDelegation(assembly, root)).toBe(
            assembly
        );
        expect(promptPlugin.overrideChildDelegation(assembly, undefined)).toBe(
            assembly
        );
    });

    it("selects goal guidance by agent kind and rewrites tool:goal", () => {
        const root = {
            id: "main-1",
            session: { header: {} },
        } as unknown as Agent;
        const goalChild = {
            id: "goal-a1b2c3d4-child",
            session: {
                header: { origin: "subagent", parentSession: "parent" },
            },
        } as unknown as Agent;
        const otherChild = {
            id: "sub-a1b2c3d4",
            session: {
                header: { origin: "subagent", parentSession: "parent" },
            },
        } as unknown as Agent;
        expect(promptPlugin.goalPromptForAgent(root)).toBe(GOAL_MAIN_PROMPT);
        expect(promptPlugin.goalPromptForAgent(goalChild)).toBe(
            GOAL_CHILD_PROMPT
        );
        expect(promptPlugin.goalPromptForAgent(otherChild)).toBe("");
        expect(promptPlugin.goalPromptForAgent(undefined)).toBe(
            GOAL_MAIN_PROMPT
        );

        const assembly = {
            sections: [
                { name: GOAL_TOOL_SECTION_NAME, text: "original goal tool" },
                { name: "safety", text: "keep" },
            ],
            contexts: [],
            tools: [],
            variables: {},
        } as unknown as PromptAssembly;
        const rootAdjusted = promptPlugin.adjustGoalPrompt(assembly, root);
        expect(
            rootAdjusted.sections.map((section) => section.name)
        ).not.toContain(GOAL_TOOL_SECTION_NAME);
        const childAdjusted = promptPlugin.adjustGoalPrompt(
            assembly,
            goalChild
        );
        expect(
            childAdjusted.sections.find(
                (section) => section.name === GOAL_TOOL_SECTION_NAME
            )?.text
        ).toBe(GOAL_CHILD_TOOL_PROMPT);
        expect(promptPlugin.adjustGoalPrompt(assembly, undefined)).toBe(
            assembly
        );
    });

    it("seeds global and workspace AGENTS.md through DSH_HOME", async () => {
        const root = await makeTempDir();
        const soulFile = await writeSoul(root);
        const templatesDir = join(root, "templates");
        await mkdir(templatesDir, { recursive: true });
        await writeFile(
            join(templatesDir, GLOBAL_AGENTS_TEMPLATE),
            "global seed\n"
        );
        await writeFile(
            join(templatesDir, WORKSPACE_AGENTS_TEMPLATE),
            "workspace seed\n"
        );
        const home = join(root, "dsh-home");
        const workspace = join(root, "workspace");
        vi.stubEnv("DSH_HOME", home);

        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, {
            soulFile,
            workspace,
            templatesDir,
        });

        await expect(readFile(join(home, "AGENTS.md"), "utf8")).resolves.toBe(
            "global seed\n"
        );
        await expect(
            readFile(join(workspace, "AGENTS.md"), "utf8")
        ).resolves.toBe("workspace seed\n");
    });

    it("does not seed when disabled", async () => {
        const root = await makeTempDir();
        const soulFile = await writeSoul(root);
        const templatesDir = join(root, "templates");
        await mkdir(templatesDir, { recursive: true });
        await writeFile(
            join(templatesDir, GLOBAL_AGENTS_TEMPLATE),
            "global seed\n"
        );
        await writeFile(
            join(templatesDir, WORKSPACE_AGENTS_TEMPLATE),
            "workspace seed\n"
        );
        const home = join(root, "dsh-home");
        vi.stubEnv("DSH_HOME", home);

        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, {
            soulFile,
            workspace: join(root, "workspace"),
            templatesDir,
            seedAgents: false,
        });

        await expect(readFile(join(home, "AGENTS.md"), "utf8")).rejects.toThrow(
            /ENOENT/
        );
    });

    it("accepts the bundle-shaped seed switches", async () => {
        const root = await makeTempDir();
        const soulFile = await writeSoul(root);
        const templatesDir = join(root, "templates");
        await mkdir(templatesDir, { recursive: true });
        await writeFile(
            join(templatesDir, GLOBAL_AGENTS_TEMPLATE),
            "global seed\n"
        );
        await writeFile(
            join(templatesDir, WORKSPACE_AGENTS_TEMPLATE),
            "workspace seed\n"
        );
        const home = join(root, "dsh-home");
        const workspace = join(root, "workspace");
        vi.stubEnv("DSH_HOME", home);

        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, {
            soulFile,
            templatesDir,
            workspace,
            seedGlobalAgents: true,
            seedWorkspaceAgents: false,
        });

        await expect(readFile(join(home, "AGENTS.md"), "utf8")).resolves.toBe(
            "global seed\n"
        );
        await expect(
            readFile(join(workspace, "AGENTS.md"), "utf8")
        ).rejects.toThrow(/ENOENT/);
    });

    it("validates configuration defaults", () => {
        const parsed = Config({}) as unknown as Record<string, unknown>;
        expect(parsed.soulWarnBytes).toBe(4096);
        expect(parsed.seedAgents).toBe(true);
        expect(parsed.seedGlobalAgents).toBe(true);
        expect(parsed.seedWorkspaceAgents).toBe(true);
        expect(parsed.soulFile).toBeUndefined();
        expect(() => Config({ soulWarnBytes: 0 })).toThrow();
    });
});
