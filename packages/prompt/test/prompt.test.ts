import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    GLOBAL_AGENTS_TEMPLATE,
    WORKSPACE_AGENTS_TEMPLATE,
} from "../src/agents.js";
import * as promptPlugin from "../src/index.js";
import { Config } from "../src/index.js";
import {
    INTERACTION_PROMPT,
    INTERACTION_SECTION_NAME,
    INTERACTION_SECTION_ORDER,
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

    it("registers the SOUL and interaction sections", async () => {
        const directory = await makeTempDir();
        const soulFile = await writeSoul(directory);
        const ctx = await mountPromptHost();
        await ctx.plugin(promptPlugin, { soulFile, seedAgents: false });

        const assembly = await ctx.systemPrompt.assemble();
        const names = assembly.sections.map((section) => section.name);
        expect(names).toContain(SOUL_SECTION_NAME);
        expect(names).toContain(INTERACTION_SECTION_NAME);
        expect(names.indexOf(SOUL_SECTION_NAME)).toBeLessThan(
            names.indexOf(INTERACTION_SECTION_NAME)
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
        expect(SOUL_SECTION_ORDER).toBe(0);
        expect(INTERACTION_SECTION_ORDER).toBe(4000);
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
