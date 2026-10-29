import { describe, expect, it } from "vitest";

import { apply, Config, inject, name } from "../src/index.js";
import {
    PTY_DISABLED_PROMPT,
    PTY_SECTION_NAME,
    PTY_SECTION_ORDER,
    PTY_SECTION_PROMPT,
} from "../src/prompt.js";
import { createFakeContext, createHostInfo } from "./support/fake-context.js";

describe("terminal host plugin", () => {
    it("declares its identity and injected services", () => {
        expect(name).toBe("terminal-host");
        expect(inject).toEqual([
            "terminals",
            "shellHosts",
            "subprocess",
            "sandboxPolicy",
            "sessionProjections",
            "workingDirectory",
            "systemPrompt",
        ]);
    });

    it("exposes the configuration schema with defaults", () => {
        expect(Config({})).toMatchObject({
            enabled: true,
            bashPath: "bash",
            sendTimeoutMs: 30000,
            rows: 40,
            cols: 160,
            scrollbackLines: 10000,
        });
    });

    it("registers the prompt section and host backends when enabled", async () => {
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        apply(fake.ctx, {});

        expect(fake.sections).toHaveLength(1);
        expect(fake.sections[0]?.name).toBe(PTY_SECTION_NAME);
        expect(fake.sections[0]?.order).toBe(PTY_SECTION_ORDER);
        expect(fake.sections[0]?.text).toBe(PTY_SECTION_PROMPT);
        expect(fake.sections[0]?.interpolate).toBe(false);
        expect(fake.backends.has("local:workspace")).toBe(true);
        expect(fake.effects).toHaveLength(1);

        await fake.disposeEffects();
        expect(fake.backends.size).toBe(0);
    });

    it("registers only the disabled prompt when disabled", () => {
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        apply(fake.ctx, { enabled: false });

        expect(fake.sections).toHaveLength(1);
        expect(fake.sections[0]?.text).toBe(PTY_DISABLED_PROMPT);
        expect(fake.backends.size).toBe(0);
        expect(fake.effects).toHaveLength(0);
    });
});
