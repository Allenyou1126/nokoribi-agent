import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { Daemon, type AgentAppConfig } from "./daemon.js";

export { Daemon } from "./daemon.js";
export type { AgentAppConfig } from "./daemon.js";
export { assistantText, planTurnEnd } from "./replies.js";
export type { TurnReplyPlan } from "./replies.js";

/** Loader plugin label. */
export const name = "agent-app";

/** Services the daemon lifecycle depends on. */
export const inject: string[] = [
    "agents",
    "agentLoop",
    "sessions",
    "sessionPersistence",
    "commands",
    "channels",
];

/** Runtime configuration schema (validated by the Loader). */
export const Config: unknown = z.object({
    provider: z.string().default("deepseek-official"),
    model: z.string().default("deepseek-flash"),
    reasoningEffort: z.string(),
    maxTokens: z.natural().min(1),
    workspace: z.string(),
    shutdownGraceMs: z.natural().min(1).default(20000),
    version: z.string().default("0.0.0-dev"),
});

/** Start the daemon lifecycle. */
export async function apply(
    ctx: Context,
    config: AgentAppConfig
): Promise<void> {
    const daemon = new Daemon(ctx, config);
    await daemon.start();
}
