import type { GoalView } from "@deepseek-ai/dsh-goal";
import {
    shortGoalId,
    type GoalModelRef,
    type GoalState,
} from "@nokoribi/shared";

/** How a tracked goal child was created. */
export type GoalSource = GoalState["source"];

/** Detached creation details for a newly tracked goal. */
export interface GoalCreationDetails {
    readonly source: GoalSource;
    readonly label?: string;
    readonly model?: GoalModelRef;
}

/** In-memory durable projection of tracked goal children. */
export class GoalTracker {
    private readonly bySession = new Map<string, GoalState>();

    /** Replace the whole projection, typically from `agent-state.json`. */
    load(goals: readonly GoalState[]): void {
        this.bySession.clear();
        for (const goal of goals) {
            this.bySession.set(goal.sessionId, { ...goal });
        }
    }

    /** Create or update one tracked goal from the service's live view. */
    upsert(
        view: GoalView,
        sessionId: string,
        details: GoalCreationDetails
    ): GoalState {
        const previous = this.bySession.get(sessionId);
        const label = previous?.label ?? details.label;
        const model = previous?.model ?? details.model;
        const next: GoalState = {
            sessionId,
            goalId: view.id,
            revision: view.revision,
            phase: view.phase,
            lastKnownRounds: Math.max(
                previous?.lastKnownRounds ?? 0,
                view.roundsStarted
            ),
            createdAt: new Date(view.createdAt).toISOString(),
            updatedAt: new Date(view.updatedAt).toISOString(),
            source: previous?.source ?? details.source,
            objective: view.objective,
            maxGoalRounds: view.maxGoalRounds,
            ...(label === undefined ? {} : { label }),
            ...(model === undefined ? {} : { model }),
        };
        this.bySession.set(next.sessionId, next);
        return next;
    }

    /** Update the largest admitted goal round for one child. */
    updateRounds(sessionId: string, rounds: number): GoalState | undefined {
        const previous = this.bySession.get(sessionId);
        if (previous === undefined || rounds <= previous.lastKnownRounds) {
            return previous;
        }
        const next: GoalState = {
            ...previous,
            lastKnownRounds: rounds,
            updatedAt: new Date().toISOString(),
        };
        this.bySession.set(sessionId, next);
        return next;
    }

    /** Remove one tracked child and return its last state. */
    remove(sessionId: string): GoalState | undefined {
        const previous = this.bySession.get(sessionId);
        this.bySession.delete(sessionId);
        return previous;
    }

    /** Read one tracked child. */
    get(sessionId: string): GoalState | undefined {
        return this.bySession.get(sessionId);
    }

    /** Resolve every child whose session id starts with `prefix`. */
    find(prefix: string): GoalState[] {
        return this.list().filter((goal) => goal.sessionId.startsWith(prefix));
    }

    /** List tracked children in creation order. */
    list(): GoalState[] {
        return [...this.bySession.values()].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt)
        );
    }

    /** Detached durable snapshot for `agent-state.json`. */
    snapshot(): readonly GoalState[] {
        return this.list().map((goal) => ({ ...goal }));
    }

    /** Summaries for `/status` and `/goal list`. */
    summaries(): GoalStatusSummary[] {
        return this.list().map((goal) => ({
            shortId: shortGoalId(goal.sessionId),
            sessionId: goal.sessionId,
            goalId: goal.goalId,
            phase: goal.phase,
            roundsStarted: goal.lastKnownRounds,
            maxGoalRounds: goal.maxGoalRounds ?? 0,
            objective: goal.objective ?? "(unknown)",
        }));
    }
}

/** Public summary of one tracked goal. */
export interface GoalStatusSummary {
    readonly shortId: string;
    readonly sessionId: string;
    readonly goalId: string;
    readonly phase: GoalState["phase"];
    readonly roundsStarted: number;
    readonly maxGoalRounds: number;
    readonly objective: string;
}
