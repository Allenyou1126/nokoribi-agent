import { describe, expect, it } from "vitest";

import { assistantText, planTurnEnd } from "../src/replies.js";

const userAbort = {
    kind: "aborted" as const,
    reason: { kind: "user" as const },
};

describe("turn reply planning", () => {
    it("sends completed text", () => {
        expect(planTurnEnd({ kind: "completed" }, " hello ")).toEqual({
            text: "hello",
        });
    });

    it("does not send empty completed text", () => {
        expect(planTurnEnd({ kind: "completed" }, "   ")).toEqual({});
    });

    it("stays silent for a user /stop", () => {
        expect(planTurnEnd(userAbort, "partial")).toEqual({});
    });

    it("notices a non-user abort", () => {
        expect(
            planTurnEnd(
                { kind: "aborted", reason: { kind: "disposed" } },
                undefined
            )
        ).toEqual({ notice: "本轮被非用户原因中止" });
    });

    it("notices errors with their code", () => {
        expect(
            planTurnEnd(
                {
                    kind: "error",
                    error: { code: "UNKNOWN", message: "boom" },
                } as never,
                undefined
            ).notice
        ).toContain("UNKNOWN");
    });

    it("extracts text blocks only", () => {
        expect(
            assistantText({
                id: "m",
                role: "assistant",
                source: { kind: "model", provider: "p", model: "m" },
                content: [
                    { type: "text", text: "a" },
                    { type: "text", text: "b" },
                ],
            } as never)
        ).toBe("ab");
    });
});
