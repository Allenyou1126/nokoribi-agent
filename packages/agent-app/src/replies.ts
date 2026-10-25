import type { AssistantMessage } from "@deepseek-ai/dsh-llm";
import type { TurnEndReason } from "@deepseek-ai/dsh-session";

/** What the bridge should emit after one turn closes. */
export interface TurnReplyPlan {
    readonly text?: string;
    readonly notice?: string;
}

/** Extract the model-visible text of one assistant message. */
export function assistantText(message: AssistantMessage): string {
    const parts: string[] = [];
    for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") {
            parts.push(block.text);
        }
    }
    return parts.join("");
}

/** Decide whether a closed turn produces a user-visible reply and/or a notice. */
export function planTurnEnd(
    reason: TurnEndReason,
    text: string | undefined
): TurnReplyPlan {
    const trimmed = text?.trim() ?? "";
    switch (reason.kind) {
        case "completed":
        case "max-tokens":
        case "blocked":
            return trimmed === "" ? {} : { text: trimmed };
        case "aborted":
            if (reason.reason.kind === "user") return {};
            return trimmed === ""
                ? { notice: "本轮被非用户原因中止" }
                : { text: trimmed, notice: "本轮被非用户原因中止" };
        case "error":
            return {
                ...(trimmed === "" ? {} : { text: trimmed }),
                notice: `本轮失败：${reason.error.code}`,
            };
        default:
            return trimmed === "" ? {} : { text: trimmed };
    }
}
