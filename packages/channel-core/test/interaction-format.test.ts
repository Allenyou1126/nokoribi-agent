import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";

import {
    describeAgent,
    formatApprovalPrompt,
    formatQuestionPrompt,
    parseApprovalReply,
    parseQuestionReply,
} from "../src/interaction-format.js";

const question = {
    id: "q1",
    header: "Choose",
    question: "Which option?",
    detail: "Pick one.",
    options: [
        { label: "Alpha", description: "first" },
        { label: "Beta" },
        { label: "Gamma" },
    ],
};

function agent(id: string, child = false): Agent {
    return {
        id,
        session: {
            header: child
                ? { origin: "subagent", parentSession: "parent" }
                : {},
        },
    } as unknown as Agent;
}

describe("describeAgent", () => {
    it("distinguishes the main session and goal children", () => {
        expect(describeAgent(agent("main-1"))).toBe("主会话");
        expect(describeAgent(agent("goal-a1b2c3d4-child", true))).toBe(
            "goal a1b2c3d4"
        );
        expect(describeAgent(agent("child-xyz", true))).toBe("goal child-xy");
    });
});

describe("formatApprovalPrompt", () => {
    it("includes tool, reason, summary, and reply contract", () => {
        const text = formatApprovalPrompt({
            origin: "主会话",
            toolName: "write",
            reason: "irreversible",
            summary: 'write {"path":"/tmp/x"}',
            timeoutSeconds: 60,
        });
        expect(text).toContain("🔐 审批（主会话）");
        expect(text).toContain("工具：write");
        expect(text).toContain("原因：irreversible");
        expect(text).toContain("动作：write");
        expect(text).toContain("允许 / 拒绝");
        expect(text).toContain("60 秒");
    });
});

describe("formatQuestionPrompt", () => {
    it("numbers options and explains multi-select", () => {
        const text = formatQuestionPrompt({
            origin: "goal a1b2c3d4",
            index: 1,
            total: 2,
            question: { ...question, multiSelect: true },
            timeoutSeconds: 300,
        });
        expect(text).toContain("❓ 提问（goal a1b2c3d4）(1/2)");
        expect(text).toContain("[Choose]");
        expect(text).toContain("Which option?");
        expect(text).toContain("1. Alpha — first");
        expect(text).toContain("3. Gamma");
        expect(text).toContain("多选可用 1,3");
    });
});

describe("parseApprovalReply", () => {
    it.each(["允许", "允许一次", "同意", "1", "yes", "ALLOW"])(
        "accepts %s",
        (text) => {
            expect(parseApprovalReply(text)).toBe("allow");
        }
    );

    it.each(["拒绝", "不同意", "2", "no", "DENY"])("rejects %s", (text) => {
        expect(parseApprovalReply(text)).toBe("deny");
    });

    it("returns undefined for unknown replies", () => {
        expect(parseApprovalReply("maybe")).toBeUndefined();
    });
});

describe("parseQuestionReply", () => {
    it("matches numbers and labels", () => {
        expect(parseQuestionReply("2", question)).toEqual({
            selected: ["Beta"],
        });
        expect(parseQuestionReply("alpha", question)).toEqual({
            selected: ["Alpha"],
        });
    });

    it("treats unmatched single-select text as custom", () => {
        expect(parseQuestionReply("something else", question)).toEqual({
            selected: [],
            custom: "something else",
        });
    });

    it("parses multi-select numbers", () => {
        expect(
            parseQuestionReply("1, 3", { ...question, multiSelect: true })
        ).toEqual({ selected: ["Alpha", "Gamma"] });
        expect(
            parseQuestionReply("1 2", { ...question, multiSelect: true })
        ).toEqual({ selected: ["Alpha", "Beta"] });
    });

    it("treats unmatched multi-select text as custom", () => {
        expect(
            parseQuestionReply("Alpha, something", {
                ...question,
                multiSelect: true,
            })
        ).toEqual({ selected: [], custom: "Alpha, something" });
    });

    it("rejects empty input", () => {
        expect(parseQuestionReply("   ", question)).toBeUndefined();
    });
});
