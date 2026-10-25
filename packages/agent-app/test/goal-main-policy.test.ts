import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import {
    installMainToolPolicy,
    MAIN_HIDDEN_GOAL_TOOLS,
} from "../src/goals/main-policy.js";

describe("installMainToolPolicy", () => {
    it("restricts only the registered goal tools", () => {
        const restrictions: unknown[] = [];
        const effects: (() => void)[] = [];
        const fake = {
            tools: {
                get: (name: string) =>
                    name === "get_goal" || name === "create_goal"
                        ? {}
                        : undefined,
                restrict: (filter: unknown) => {
                    restrictions.push(filter);
                    return () => undefined;
                },
            },
            effect: (callback: () => () => void) => {
                const disposer = callback();
                effects.push(disposer);
                return disposer;
            },
        } as unknown as Context;
        installMainToolPolicy(fake);
        expect(restrictions).toEqual([{ deny: ["create_goal", "get_goal"] }]);
        expect(effects).toHaveLength(1);
        expect(MAIN_HIDDEN_GOAL_TOOLS).toContain("update_goal");
    });

    it("does nothing when goal tools are absent", () => {
        const fake = {
            tools: {
                get: () => undefined,
                restrict: () => {
                    throw new Error("should not restrict");
                },
            },
            effect: (callback: () => () => void) => callback(),
        } as unknown as Context;
        expect(() => installMainToolPolicy(fake)).not.toThrow();
    });
});
