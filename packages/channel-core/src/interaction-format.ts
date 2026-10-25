import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionItem } from "@deepseek-ai/dsh-user-questions";

/** Human-readable identity for the agent asking a question. */
export function describeAgent(agent: Agent): string {
    const header = agent.session.header;
    const child =
        header.origin === "subagent" || header.parentSession !== undefined;
    if (!child) return "主会话";
    const goal = /^goal-([0-9a-z]{8})/i.exec(agent.id)?.[1];
    return `goal ${goal ?? agent.id.slice(0, 8)}`;
}

/** Short, single-line summary of one pending tool action. */
export function formatToolSummary(
    toolName: string,
    argumentsText: string | undefined,
    maxChars = 600
): string | undefined {
    if (argumentsText === undefined || argumentsText.trim() === "") {
        return undefined;
    }
    const compact = argumentsText.replace(/\s+/g, " ").trim();
    return `${toolName} ${compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact}`;
}

function normalizeReason(reason: string | undefined): string {
    if (reason === undefined || reason.trim() === "") return "需要用户确认";
    return reason.replace(/\s+/g, " ").trim();
}

/** Approval prompt shown to the user (🔐). */
export function formatApprovalPrompt(input: {
    readonly origin: string;
    readonly toolName: string;
    readonly reason?: string;
    readonly summary?: string;
    readonly timeoutSeconds: number;
}): string {
    const lines = [
        `🔐 审批（${input.origin}）`,
        `工具：${input.toolName}`,
        `原因：${normalizeReason(input.reason)}`,
    ];
    if (input.summary !== undefined) {
        lines.push(`动作：${input.summary}`);
    }
    lines.push(
        `回复 允许 / 拒绝（或 1 / 2）。${String(input.timeoutSeconds)} 秒内未回复视为拒绝。`
    );
    return lines.join("\n");
}

/** Question prompt shown to the user (❓). */
export function formatQuestionPrompt(input: {
    readonly origin: string;
    readonly index: number;
    readonly total: number;
    readonly question: AskUserQuestionItem;
    readonly timeoutSeconds: number;
}): string {
    const { question } = input;
    const lines = [
        `❓ 提问（${input.origin}）(${String(input.index)}/${String(input.total)})`,
    ];
    if (question.header !== undefined && question.header.trim() !== "") {
        lines.push(`[${question.header.trim()}]`);
    }
    lines.push(question.question);
    if (question.detail !== undefined && question.detail.trim() !== "") {
        lines.push("", question.detail.trim());
    }
    if (question.options !== undefined && question.options.length > 0) {
        lines.push("");
        question.options.forEach((option, index) => {
            const suffix =
                option.description === undefined
                    ? ""
                    : ` — ${option.description}`;
            lines.push(`${String(index + 1)}. ${option.label}${suffix}`);
        });
        lines.push(
            "",
            question.multiSelect === true
                ? "回复编号（多选可用 1,3），或直接输入文本。"
                : "回复编号，或直接输入文本。"
        );
    } else {
        lines.push("", "直接回复文本。");
    }
    lines.push(`${String(input.timeoutSeconds)} 秒内未回复将报错。`);
    return lines.join("\n");
}

const APPROVE_WORDS = new Set([
    "允许",
    "允许一次",
    "同意",
    "approve",
    "allow",
    "yes",
    "y",
    "1",
]);
const REJECT_WORDS = new Set([
    "拒绝",
    "不同意",
    "deny",
    "reject",
    "no",
    "n",
    "2",
]);

/** Parse one approval reply; undefined means show help and keep waiting. */
export function parseApprovalReply(text: string): "allow" | "deny" | undefined {
    const normalized = text.trim().toLowerCase();
    if (APPROVE_WORDS.has(normalized)) return "allow";
    if (REJECT_WORDS.has(normalized)) return "deny";
    return undefined;
}

function splitMulti(text: string): string[] {
    return text
        .split(/[,，、\s]+/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

function matchOption(
    token: string,
    question: AskUserQuestionItem
): string | undefined {
    const options = question.options ?? [];
    const byNumber = Number.parseInt(token, 10);
    if (
        Number.isInteger(byNumber) &&
        String(byNumber) === token &&
        byNumber >= 1 &&
        byNumber <= options.length
    ) {
        return options[byNumber - 1]?.label;
    }
    const lower = token.toLowerCase();
    return options.find((option) => option.label.toLowerCase() === lower)
        ?.label;
}

/** Parse one question reply into the answer vocabulary. */
export function parseQuestionReply(
    text: string,
    question: AskUserQuestionItem
): { selected: string[]; custom?: string } | undefined {
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    const options = question.options ?? [];
    if (options.length === 0) return { selected: [], custom: trimmed };

    const wholeLabel = matchOption(trimmed, question);
    if (wholeLabel !== undefined) {
        return { selected: [wholeLabel] };
    }

    if (question.multiSelect === true) {
        const tokens = splitMulti(trimmed);
        const selected: string[] = [];
        for (const token of tokens) {
            const label = matchOption(token, question);
            if (label === undefined) {
                return { selected: [], custom: trimmed };
            }
            if (!selected.includes(label)) selected.push(label);
        }
        return selected.length === 0 ? undefined : { selected };
    }

    const [token] = splitMulti(trimmed);
    if (token === undefined) {
        return { selected: [], custom: trimmed };
    }
    const label = matchOption(token, question);
    if (label === undefined) return { selected: [], custom: trimmed };
    if (splitMulti(trimmed).length !== 1) {
        return { selected: [], custom: trimmed };
    }
    return { selected: [label] };
}
