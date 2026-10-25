import { describe, expect, it } from "vitest";

import {
    formatModelRoute,
    parseAllowedModels,
    parseModelRoute,
} from "../src/goals/model.js";

describe("goal model routes", () => {
    it("parses exact provider/model routes and formatting", () => {
        expect(parseModelRoute("deepseek-official/deepseek-flash")).toEqual({
            provider: "deepseek-official",
            model: "deepseek-flash",
        });
        expect(parseModelRoute("missing-slash")).toBeUndefined();
        expect(parseModelRoute("/model")).toBeUndefined();
        expect(parseModelRoute("provider/")).toBeUndefined();
        expect(
            formatModelRoute({
                provider: "p",
                model: "m",
                reasoningEffort: "high",
            })
        ).toBe("p/m (high)");
    });

    it("validates allowlists, rejects duplicates, and skips blanks", () => {
        expect(parseAllowedModels([" p/m ", "", "p/n"])).toEqual([
            { provider: "p", model: "m" },
            { provider: "p", model: "n" },
        ]);
        expect(() => parseAllowedModels(["p/m", "p/m"])).toThrow(
            /duplicate goal model route/
        );
        expect(() => parseAllowedModels(["bad"])).toThrow(
            /invalid goal model route/
        );
    });
});
