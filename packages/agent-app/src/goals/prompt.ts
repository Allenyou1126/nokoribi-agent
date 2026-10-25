/** Inputs for the model-visible bootstrap message sent to a new goal child. */
export interface GoalBootstrapInput {
    readonly objective: string;
    readonly maxRounds: number;
    readonly shortId: string;
    readonly parentSessionId: string;
}

/** Stable initial message for a bridge-created goal child. */
export function goalBootstrapPrompt(input: GoalBootstrapInput): string {
    return [
        "<goal_bootstrap>",
        `Objective: ${JSON.stringify(input.objective)}`,
        `Round cap: ${String(input.maxRounds)}`,
        `Goal short id: ${input.shortId}`,
        `Direct parent session id: ${input.parentSessionId}`,
        "",
        "The host has created (or is creating) the persisted goal for this session. Do not call create_goal; it is unavailable to delegated children.",
        "Do not start the objective in this bootstrap turn. Wait for the first <goal_round> message, then work toward the objective in this same session.",
        `Report only at milestones, blockage, or completion with send_message to ${input.parentSessionId}. Prefix reports with [goal:${input.shortId}] and use progress | blocked | done.`,
        "Use get_goal for the current goal id/revision, and update_goal action=complete or blocked when appropriate. Do not call pause, resume, edit, or clear.",
        "If the host says the process restarted, continue the current goal without repeating completed work.",
        "</goal_bootstrap>",
    ].join("\n");
}
