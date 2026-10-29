import { describe, expect, it } from "vitest";

import {
    PTY_DISABLED_PROMPT,
    PTY_SECTION_NAME,
    PTY_SECTION_ORDER,
    PTY_SECTION_PROMPT,
    registerPtyPrompt,
} from "../src/prompt.js";
import { createFakeContext } from "./support/fake-context.js";

const PROMPT_FACTS: readonly string[] = [
    "terminal_*",
    "bash(host)",
    "get_available_shell_host",
    "terminal: true",
    "sudo",
    "Auto review",
    "DSH_SANDBOX_DIR",
    "TTL",
    "reset",
    "有界",
    "进程内",
    "/clear",
    "daemon 重启",
    "run_in_background",
    "terminal_close",
];

describe("pty prompt", () => {
    it("exposes stable section metadata", () => {
        expect(PTY_SECTION_NAME).toBe("nokoribi:pty");
        expect(PTY_SECTION_ORDER).toBe(3100);
    });

    it("covers routing, host safety, output bounds, and persistence", () => {
        for (const fact of PROMPT_FACTS) {
            expect(PTY_SECTION_PROMPT).toContain(fact);
        }
    });

    it("states that persistent terminals are disabled", () => {
        expect(PTY_DISABLED_PROMPT).toBe("持久终端在本部署禁用。");
    });

    it("registers the enabled section statically", () => {
        const fake = createFakeContext();
        registerPtyPrompt(fake.ctx, true);

        expect(fake.sections).toHaveLength(1);
        expect(fake.sections[0]).toEqual({
            name: PTY_SECTION_NAME,
            order: PTY_SECTION_ORDER,
            text: PTY_SECTION_PROMPT,
            interpolate: false,
        });
    });

    it("registers only the disabled notice when disabled", () => {
        const fake = createFakeContext();
        registerPtyPrompt(fake.ctx, false);

        expect(fake.sections).toHaveLength(1);
        expect(fake.sections[0]?.text).toBe(PTY_DISABLED_PROMPT);
    });
});
