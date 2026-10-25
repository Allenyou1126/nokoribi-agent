import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";
import * as reviewer from "../src/index.js";

describe("reviewer plugin contract", () => {
    it("exposes the host seam without the upstream name", () => {
        expect(reviewer.name).toBe("nokoribi-reviewer");
        expect(reviewer.inject).toEqual([
            "approval",
            "llm",
            "permissionPresets",
            "sessions",
            "tools",
            "workingDirectory",
        ]);
        expect(typeof reviewer.apply).toBe("function");
    });

    it("validates fast/strong routes and the timeout default", () => {
        const parsed = Config({
            fast: { provider: "p", model: "fast" },
            strong: { provider: "p", model: "strong" },
        }) as unknown as {
            fast: { provider: string; model: string };
            strong: { provider: string; model: string };
            timeoutMs: number;
        };
        expect(parsed.fast).toEqual({
            provider: "p",
            model: "fast",
            reasoningEffort: "",
        });
        expect(parsed.strong.model).toBe("strong");
        expect(parsed.timeoutMs).toBe(30000);
        expect(() => Config({ fast: { provider: "p", model: "f" } })).toThrow();
    });
});
