import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-goal";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-schedule";
import type {} from "@deepseek-ai/dsh-subagent";
import z from "@deepseek-ai/schemastery";
import "@nokoribi/shell-bash";
import type {} from "@nokoribi/memory";

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
    "permissionPresets",
    "shellHosts",
    "goals",
    "subagents",
    "schedule",
    "sessionController",
    "memory",
    "tools",
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
    goalProvider: z.string(),
    goalModel: z.string(),
    goalReasoningEffort: z.string(),
    goalModels: z.array(z.string()).default([]),
    goalRecoveryTimeoutMs: z.natural().min(1).default(30000),
    memoryProvider: z.string(),
    memoryModel: z.string(),
    memoryReasoningEffort: z.string(),
    memoryCurator: z.boolean().default(true),
    memoryCuratorTimeoutMs: z.natural().min(1).default(60000),
    reviewFastProvider: z.string(),
    reviewFastModel: z.string(),
    reviewFastReasoningEffort: z.string(),
    reviewStrongProvider: z.string(),
    reviewStrongModel: z.string(),
    reviewStrongReasoningEffort: z.string(),
    reviewTimeoutMs: z.natural().min(1),
});

/** Start the daemon lifecycle. */
export async function apply(
    ctx: Context,
    config: AgentAppConfig
): Promise<void> {
    const daemon = new Daemon(ctx, config);
    await daemon.start();
}
