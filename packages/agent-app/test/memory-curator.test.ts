import { describe, expect, it } from "vitest";

import { buildCuratorPrompt } from "../src/memory/curator.js";

describe("memory curator prompt", () => {
    it("includes the goal outcome, report, dedupe, and safety rules", () => {
        const prompt = buildCuratorPrompt({
            objective: "完成部署偏好整理",
            phase: "complete",
            rounds: 3,
            maxRounds: 9,
            report: "[goal:goal-a1b] done\nnext: none",
        });
        expect(prompt).toContain("memory");
        expect(prompt).toContain("完成部署偏好整理");
        expect(prompt).toContain("rounds: 3/9");
        expect(prompt).toContain("[goal:goal-a1b] done");
        expect(prompt).toContain("先用 memory action=search");
        expect(prompt).toContain("最多写入 3 条");
        expect(prompt).toContain("不要向用户或父 agent 发消息");
        expect(prompt).toContain("不写密钥");
    });

    it("notes a missing report and keeps the prompt self-contained", () => {
        const prompt = buildCuratorPrompt({
            objective: "blocked objective",
            phase: "blocked",
            rounds: 1,
            maxRounds: 2,
            report: undefined,
        });
        expect(prompt).toContain("(none)");
        expect(prompt).toContain("goal phase: blocked");
        expect(prompt).toContain("不要创建 goal");
    });
});
