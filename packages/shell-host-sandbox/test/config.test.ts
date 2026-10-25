import { describe, expect, it } from "vitest";

import { Config } from "../src/index.js";

describe("sandbox host config", () => {
    it("defaults to enabled and accepts an explicit disable", () => {
        const base = {
            root: "/tmp/sandboxes",
            workspace: "/tmp/workspace",
        };
        const enabled = Config(base) as unknown as { enabled: boolean };
        expect(enabled.enabled).toBe(true);
        const disabled = Config({
            ...base,
            enabled: false,
        }) as unknown as { enabled: boolean };
        expect(disabled.enabled).toBe(false);
    });
});
