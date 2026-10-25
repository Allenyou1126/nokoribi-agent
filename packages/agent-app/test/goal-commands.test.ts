import { describe, expect, it } from "vitest";

import { parseGoalCommand } from "../src/goals/commands.js";

describe("parseGoalCommand", () => {
    it("parses new objectives and rounds", () => {
        expect(parseGoalCommand(" new 修复 M4 --rounds 7 ")).toEqual({
            kind: "new",
            objective: "修复 M4",
            maxRounds: 7,
        });
        expect(parseGoalCommand("new 做一件事")).toEqual({
            kind: "new",
            objective: "做一件事",
        });
    });

    it("keeps a trailing --rounds literal only when it is a flag", () => {
        expect(parseGoalCommand("new 处理 --rounds 3 的情况")).toEqual({
            kind: "new",
            objective: "处理 --rounds 3 的情况",
        });
        expect(parseGoalCommand("new 做 --rounds")).toEqual({
            kind: "error",
            message: "--rounds 需要一个正整数。",
        });
        expect(parseGoalCommand("new 做 --rounds 0")).toEqual({
            kind: "error",
            message: "--rounds 必须是正整数。",
        });
    });

    it("requires a non-empty objective", () => {
        expect(parseGoalCommand("new").kind).toBe("error");
        expect(parseGoalCommand("new --rounds 3").kind).toBe("error");
        expect(parseGoalCommand("").kind).toBe("help");
    });

    it("parses list, status, pause, resume, clear, and archive", () => {
        expect(parseGoalCommand("list")).toEqual({ kind: "list" });
        for (const action of [
            "status",
            "pause",
            "resume",
            "clear",
            "archive",
        ] as const) {
            expect(parseGoalCommand(`${action} goal-a1b2`)).toEqual({
                kind: action,
                prefix: "goal-a1b2",
            });
        }
    });

    it("rejects missing, empty, or whitespace prefixes", () => {
        expect(parseGoalCommand("status").kind).toBe("error");
        expect(parseGoalCommand("status goal-a goal-b").kind).toBe("error");
        expect(parseGoalCommand("status  ").kind).toBe("error");
    });

    it("reports unknown subcommands", () => {
        const result = parseGoalCommand("wat");
        expect(result.kind).toBe("error");
        if (result.kind === "error") {
            expect(result.message).toContain("未知 /goal 子命令");
        }
    });
});
