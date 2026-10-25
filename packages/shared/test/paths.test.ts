import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureHomeDirs, resolveHomePaths } from "../src/paths.js";

describe("home paths", () => {
    it("resolves and creates the service HOME directory", async () => {
        const home = await mkdtemp(join(tmpdir(), "nokoribi-paths-"));
        try {
            const paths = resolveHomePaths(undefined, {
                DSH_HOME: home,
            });
            expect(paths.home).toBe(home);
            expect(paths.homeDir).toBe(join(home, "home"));
            expect(paths.workspaceDir).toBe(join(home, "workspace"));
            await ensureHomeDirs(paths);
            expect((await stat(paths.homeDir)).isDirectory()).toBe(true);
            expect((await stat(paths.workspaceDir)).isDirectory()).toBe(true);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it("honors an explicit workspace override", () => {
        const paths = resolveHomePaths("/srv/nokoribi-workspace", {
            DSH_HOME: "/var/lib/nokoribi-agent",
        });
        expect(paths.workspaceDir).toBe("/srv/nokoribi-workspace");
        expect(paths.homeDir).toBe("/var/lib/nokoribi-agent/home");
    });
});
