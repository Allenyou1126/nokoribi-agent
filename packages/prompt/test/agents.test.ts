import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    GLOBAL_AGENTS_TEMPLATE,
    TEMPLATES_DIR_ENV,
    WORKSPACE_AGENTS_TEMPLATE,
    resolveTemplatesDir,
    seedAgentInstructions,
} from "../src/agents.js";

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "nokoribi-agents-"));
    directories.push(directory);
    return directory;
}

async function makeTemplates(
    directory: string,
    names: readonly string[] = [
        GLOBAL_AGENTS_TEMPLATE,
        WORKSPACE_AGENTS_TEMPLATE,
    ]
): Promise<string> {
    const templatesDir = join(directory, "templates");
    await mkdir(templatesDir, { recursive: true });
    for (const name of names) {
        await writeFile(join(templatesDir, name), `seed:${name}\n`);
    }
    return templatesDir;
}

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

describe("resolveTemplatesDir", () => {
    it("prefers config, then the environment, then shipped templates", () => {
        expect(
            resolveTemplatesDir("/configured", {
                [TEMPLATES_DIR_ENV]: "/env",
            })
        ).toBe("/configured");
        expect(
            resolveTemplatesDir(undefined, {
                [TEMPLATES_DIR_ENV]: "/env",
            })
        ).toBe("/env");
        expect(resolveTemplatesDir(undefined, {})).toContain("templates");
    });
});

describe("seedAgentInstructions", () => {
    it("creates both AGENTS.md files with parent directories", async () => {
        const root = await makeTempDir();
        const templatesDir = await makeTemplates(root);
        const home = join(root, "home");
        const workspace = join(root, "state", "workspace");
        const result = await seedAgentInstructions({
            home,
            workspace,
            templatesDir,
            env: {},
            logger: undefined,
            globalAgentsFile: undefined,
            workspaceAgentsFile: undefined,
        });
        expect(result.created).toEqual([
            join(home, "AGENTS.md"),
            join(workspace, "AGENTS.md"),
        ]);
        expect(result.skipped).toEqual([]);
        await expect(readFile(join(home, "AGENTS.md"), "utf8")).resolves.toBe(
            `seed:${GLOBAL_AGENTS_TEMPLATE}\n`
        );
        await expect(
            readFile(join(workspace, "AGENTS.md"), "utf8")
        ).resolves.toBe(`seed:${WORKSPACE_AGENTS_TEMPLATE}\n`);
    });

    it("never overwrites existing instruction files", async () => {
        const root = await makeTempDir();
        const templatesDir = await makeTemplates(root);
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const options = {
            home,
            workspace,
            templatesDir,
            env: {},
            logger: undefined,
            globalAgentsFile: undefined,
            workspaceAgentsFile: undefined,
        } as const;
        await seedAgentInstructions(options);
        await writeFile(join(home, "AGENTS.md"), "custom global\n");
        const second = await seedAgentInstructions(options);
        expect(second.created).toEqual([]);
        expect(second.skipped).toHaveLength(2);
        await expect(readFile(join(home, "AGENTS.md"), "utf8")).resolves.toBe(
            "custom global\n"
        );
    });

    it("fails loud when a seed template is missing", async () => {
        const root = await makeTempDir();
        const templatesDir = await makeTemplates(root, [
            GLOBAL_AGENTS_TEMPLATE,
        ]);
        await expect(
            seedAgentInstructions({
                home: join(root, "home"),
                workspace: join(root, "workspace"),
                templatesDir,
                env: {},
                logger: undefined,
                globalAgentsFile: undefined,
                workspaceAgentsFile: undefined,
            })
        ).rejects.toThrow(/missing AGENTS\.md seed template/);
    });

    it("falls back to the templates shipped beside the package", async () => {
        const root = await makeTempDir();
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const result = await seedAgentInstructions({
            home,
            workspace,
            templatesDir: undefined,
            env: {},
            logger: undefined,
            globalAgentsFile: undefined,
            workspaceAgentsFile: undefined,
        });
        expect(result.created).toHaveLength(2);
        await expect(
            readFile(join(home, "AGENTS.md"), "utf8")
        ).resolves.toContain("Nokoribi");
        await expect(
            readFile(join(workspace, "AGENTS.md"), "utf8")
        ).resolves.toContain("workspace");
    });

    it("supports seeding each layer independently", async () => {
        const root = await makeTempDir();
        const templatesDir = await makeTemplates(root);
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const result = await seedAgentInstructions({
            home,
            workspace,
            templatesDir,
            env: {},
            logger: undefined,
            seedWorkspaceAgents: false,
            globalAgentsFile: undefined,
            workspaceAgentsFile: undefined,
        });
        expect(result.created).toEqual([join(home, "AGENTS.md")]);
        await expect(
            readFile(join(workspace, "AGENTS.md"), "utf8")
        ).rejects.toThrow(/ENOENT/);
    });
});
