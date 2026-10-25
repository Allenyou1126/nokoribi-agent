import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { GoalManager } from "./manager.js";

/** Model-facing tool that starts one long-running goal child. */
export function createStartGoalTool(manager: GoalManager): ToolDefinition {
    return defineTool({
        name: "start_goal",
        description:
            "Start a long-running goal subagent: the host creates a persisted goal for a new continuable child, which automatically continues across goal rounds until it completes, blocks, or reaches its round cap. Use it for multi-round objectives; use `subagent` for bounded one-off delegation. The child reports via `send_message`; use the returned short id with `/goal` commands.",
        parameters: {
            objective: {
                type: "string",
                required: true,
                description:
                    "Concrete completion objective for the goal child, including relevant constraints and success evidence.",
            },
            description: {
                type: "string",
                required: true,
                description:
                    "A short (3-5 word) label for the goal child, used in catalogs and archives.",
            },
            max_goal_rounds: {
                type: "number",
                description:
                    "Optional positive round cap. Omit to use the deployment default.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    kind: {
                        type: "string",
                        required: true,
                        const: "goal",
                    },
                    shortId: {
                        type: "string",
                        required: true,
                    },
                    sessionId: {
                        type: "string",
                        required: true,
                    },
                    goalId: {
                        type: "string",
                        required: true,
                    },
                },
            },
            render: (_args, value) => [
                {
                    type: "text",
                    text: `started goal ${value.shortId} (${value.sessionId})`,
                },
            ],
        },
        async execute(args, exec) {
            const agent = exec.agent;
            if (agent === undefined || agent.id !== manager.mainSessionId) {
                throw new Error(
                    "start_goal may only be called by the main agent"
                );
            }
            const objective = args.objective.trim();
            if (objective === "") {
                throw new Error("goal objective must not be empty");
            }
            const rounds = args.max_goal_rounds;
            if (
                rounds !== undefined &&
                (!Number.isSafeInteger(rounds) || rounds < 1)
            ) {
                throw new Error(
                    "max_goal_rounds must be a positive safe integer"
                );
            }
            const started = await manager.startGoal({
                objective,
                label: args.description,
                ...(rounds === undefined ? {} : { maxRounds: rounds }),
                source: "subagent-tool",
                signal: exec.signal,
            });
            return {
                kind: "goal" as const,
                shortId: started.shortId,
                sessionId: started.childId,
                goalId: started.goalId,
            };
        },
    });
}
