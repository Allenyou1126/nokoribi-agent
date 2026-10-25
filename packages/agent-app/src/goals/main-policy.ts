import type { Context } from "@deepseek-ai/cordis";

/** Model-facing goal tools that must never be visible to the main session. */
export const MAIN_HIDDEN_GOAL_TOOLS: readonly string[] = [
    "create_goal",
    "get_goal",
    "update_goal",
];

/**
 * Hide same-session goal tools from the main agent's scope. Goal children are
 * separate agents and keep their own view; `/goal` is the main-session control
 * surface.
 * @param agentCtx - unpublished main-agent scope.
 */
export function installMainToolPolicy(agentCtx: Context): void {
    const visible = MAIN_HIDDEN_GOAL_TOOLS.filter(
        (name) => agentCtx.tools.get(name) !== undefined
    );
    if (visible.length === 0) return;
    agentCtx.effect(() => agentCtx.tools.restrict({ deny: visible }));
}
