import type { ZodType } from "zod";
import { z } from "zod";

import { backupFile, readJsonFile, writeJsonAtomic } from "./atomic.js";

/** Reserved session-id prefix for bridge-created goal children (M4). */
export const GOAL_SESSION_PREFIX: string = "goal-";

/** Whether a session id belongs to a bridge-created goal child. */
export function isGoalChildSession(sessionId: string): boolean {
    return sessionId.startsWith(GOAL_SESSION_PREFIX);
}

/** Short goal id used by `/goal` commands: the session-id prefix. */
export function shortGoalId(sessionId: string): string {
    return sessionId.slice(0, 8);
}

/** Model route persisted with a goal child for archiving. */
export interface GoalModelRef {
    readonly provider: string;
    readonly model: string;
}

/** One tracked goal child. M1 never creates entries; the shape stays forward-compatible. */
export interface GoalState {
    readonly sessionId: string;
    readonly goalId: string;
    readonly revision: number;
    readonly phase: "active" | "paused" | "blocked" | "complete";
    readonly lastKnownRounds: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly source: "subagent-tool" | "goal-command";
    /** Detached creation details added in M4; absent on pre-M4 state. */
    readonly objective?: string;
    readonly maxGoalRounds?: number;
    readonly label?: string;
    readonly model?: GoalModelRef;
}

/** Chat identity used for proactive notifications. */
export interface ChatRef {
    readonly channelId: string;
    readonly chatId: string;
}

/** Why this process started. */
export type RestartReason = "first-start" | "clean" | "crash" | "state-corrupt";

/** Durable daemon state stored at `$DSH_HOME/state/agent-state.json`. */
export interface AgentState {
    readonly version: 1;
    readonly mainSessionId: string | null;
    readonly goals: readonly GoalState[];
    readonly archivedGoals: readonly unknown[];
    readonly lastActiveChat: ChatRef | null;
    readonly cleanShutdown: boolean;
    readonly outboxSeq: number;
    readonly lastStartedAt: string | null;
    readonly lastVersion: string;
    readonly lastRestartReason: RestartReason | null;
}

const goalSchema = z
    .object({
        sessionId: z.string().min(1),
        goalId: z.string().min(1),
        revision: z.number().int().nonnegative(),
        phase: z.enum(["active", "paused", "blocked", "complete"]),
        lastKnownRounds: z.number().int().nonnegative(),
        createdAt: z.string(),
        updatedAt: z.string(),
        source: z.enum(["subagent-tool", "goal-command"]),
        objective: z.string().optional(),
        maxGoalRounds: z.number().int().positive().optional(),
        label: z.string().optional(),
        model: z
            .object({
                provider: z.string().min(1),
                model: z.string().min(1),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

const chatSchema = z
    .object({
        channelId: z.string().min(1),
        chatId: z.string().min(1),
    })
    .passthrough();

const agentStateSchema: ZodType<AgentState> = z
    .object({
        version: z.literal(1),
        mainSessionId: z.string().min(1).nullable(),
        goals: z.array(goalSchema),
        archivedGoals: z.array(z.unknown()),
        lastActiveChat: chatSchema.nullable(),
        cleanShutdown: z.boolean(),
        outboxSeq: z.number().int().nonnegative(),
        lastStartedAt: z.string().nullable(),
        lastVersion: z.string(),
        lastRestartReason: z
            .enum(["first-start", "clean", "crash", "state-corrupt"])
            .nullable(),
    })
    .passthrough() as unknown as ZodType<AgentState>;

/** Create the state for a daemon that has never run before. */
export function defaultAgentState(version: string): AgentState {
    return {
        version: 1,
        mainSessionId: null,
        goals: [],
        archivedGoals: [],
        lastActiveChat: null,
        cleanShutdown: false,
        outboxSeq: 0,
        lastStartedAt: null,
        lastVersion: version,
        lastRestartReason: "first-start",
    };
}

/** Outcome of loading the state file. */
export interface LoadedAgentState {
    readonly state: AgentState | null;
    readonly corrupt: boolean;
    readonly backupPath?: string;
}

/** Load and validate the state file, backing up invalid content. */
export async function loadAgentState(path: string): Promise<LoadedAgentState> {
    let raw: unknown;
    try {
        raw = await readJsonFile(path);
    } catch (error) {
        if (error instanceof SyntaxError) {
            const backupPath = await backupFile(path);
            return { state: null, corrupt: true, backupPath };
        }
        throw error;
    }
    if (raw === undefined) return { state: null, corrupt: false };
    const parsed = agentStateSchema.safeParse(raw);
    if (parsed.success) return { state: parsed.data, corrupt: false };
    const backupPath = await backupFile(path);
    return { state: null, corrupt: true, backupPath };
}

/** Persist the state file atomically. */
export async function saveAgentState(
    path: string,
    state: AgentState
): Promise<void> {
    await writeJsonAtomic(path, state);
}
