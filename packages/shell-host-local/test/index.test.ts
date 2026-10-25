import { Context } from "@deepseek-ai/cordis";
import { ShellHostRegistry } from "@nokoribi/shell-bash";
import { describe, expect, it } from "vitest";

import * as hostPlugin from "../src/index.js";
import {
    Config,
    LOCAL_HOST_CAPABILITIES,
    LOCAL_HOST_DESCRIPTION,
    LOCAL_HOST_ID,
    LOCAL_HOST_TITLE,
    apply,
    createLocalHostProvider,
} from "../src/index.js";

function createHostContext(): Context {
    const ctx = new Context();
    new ShellHostRegistry(ctx, { defaultHost: LOCAL_HOST_ID });
    return ctx;
}

describe("shell-host-local", () => {
    it("exports the Cordis plugin contract", () => {
        expect(hostPlugin.name).toBe("shell-host-local");
        expect(hostPlugin.inject).toEqual(["shellHosts"]);
        expect(typeof hostPlugin.apply).toBe("function");
    });

    it("describes the persistent local workspace host", () => {
        expect(LOCAL_HOST_ID).toBe("local:workspace");
        expect(createLocalHostProvider()).toEqual({
            id: LOCAL_HOST_ID,
            kind: "local",
            title: LOCAL_HOST_TITLE,
            description: LOCAL_HOST_DESCRIPTION,
            capabilities: LOCAL_HOST_CAPABILITIES,
        });
        expect(LOCAL_HOST_CAPABILITIES).toEqual({
            background: false,
            sandbox: false,
            workdir: "local",
        });
    });

    it("registers with the shell router and disposes cleanly", () => {
        const ctx = createHostContext();
        const dispose = apply(ctx, {});
        expect(ctx.shellHosts.list()).toEqual([
            {
                id: LOCAL_HOST_ID,
                kind: "local",
                title: LOCAL_HOST_TITLE,
                description: LOCAL_HOST_DESCRIPTION,
                capabilities: {
                    background: false,
                    sandbox: false,
                    workdir: "local",
                },
            },
        ]);
        expect(ctx.shellHosts.requireDefaultHost().id).toBe(LOCAL_HOST_ID);
        dispose();
        expect(ctx.shellHosts.list()).toEqual([]);
    });

    it("rejects a duplicate registration", () => {
        const ctx = createHostContext();
        apply(ctx, {});
        expect(() => apply(ctx, {})).toThrow(/duplicate shell host id/);
    });

    it("registers under a configured custom id", () => {
        const ctx = createHostContext();
        apply(ctx, { id: "local:dev" });
        expect(ctx.shellHosts.get("local:dev")?.kind).toBe("local");
    });

    it("validates the default host id in configuration", () => {
        const parsed = Config({}) as unknown as { id: string };
        expect(parsed.id).toBe(LOCAL_HOST_ID);
    });

    it("uses the configured workspace as the default workdir", () => {
        const provider = createLocalHostProvider(undefined, "/srv/workspace");
        expect(provider.defaultWorkdir).toBe("/srv/workspace");
        const parsed = Config({
            workspace: "/srv/workspace",
        }) as unknown as { id: string; workspace?: string };
        expect(parsed.id).toBe(LOCAL_HOST_ID);
        expect(parsed.workspace).toBe("/srv/workspace");
    });

    it("loads as a Cordis plugin and disposes with its fiber", async () => {
        const ctx = createHostContext();
        const fiber = await ctx.plugin(hostPlugin);
        expect(ctx.shellHosts.list()).toHaveLength(1);
        await fiber.dispose();
        expect(ctx.shellHosts.list()).toEqual([]);
    });
});
