import type { GoalView } from "@deepseek-ai/dsh-goal";
import { describe, expect, it } from "vitest";

import { GoalTracker } from "../src/goals/tracker.js";

function view(id: string, overrides: Partial<GoalView> = {}): GoalView {
    return {
        id,
        revision: 1,
        objective: "probe objective",
        phase: "active",
        maxGoalRounds: 5,
        roundsStarted: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        activation: "armed",
        ...overrides,
    } as unknown as GoalView;
}

describe("GoalTracker", () => {
    it("tracks the child session and goal ids separately", () => {
        const tracker = new GoalTracker();
        const state = tracker.upsert(view("goal-id-1"), "goal-session-1", {
            source: "goal-command",
            label: "probe",
        });
        expect(state.sessionId).toBe("goal-session-1");
        expect(state.goalId).toBe("goal-id-1");
        expect(state.lastKnownRounds).toBe(0);
        expect(tracker.get("goal-session-1")?.label).toBe("probe");
    });

    it("preserves source and creation details across updates", () => {
        const tracker = new GoalTracker();
        tracker.upsert(view("goal-id-1"), "goal-session-1", {
            source: "goal-command",
            model: { provider: "p", model: "m" },
        });
        const updated = tracker.upsert(
            view("goal-id-1", {
                revision: 2,
                phase: "paused",
                roundsStarted: 3,
                updatedAt: 2_000,
            }),
            "goal-session-1",
            { source: "subagent-tool" }
        );
        expect(updated.source).toBe("goal-command");
        expect(updated.phase).toBe("paused");
        expect(updated.lastKnownRounds).toBe(3);
        expect(updated.model).toEqual({ provider: "p", model: "m" });
    });

    it("never lowers the known round count", () => {
        const tracker = new GoalTracker();
        tracker.upsert(view("goal-id-1"), "goal-session-1", {
            source: "goal-command",
        });
        expect(tracker.updateRounds("goal-session-1", 4)?.lastKnownRounds).toBe(
            4
        );
        expect(tracker.updateRounds("goal-session-1", 2)?.lastKnownRounds).toBe(
            4
        );
    });

    it("finds goals by prefix and reports ambiguity", () => {
        const tracker = new GoalTracker();
        tracker.upsert(view("goal-a1"), "goal-aaa1", {
            source: "goal-command",
        });
        tracker.upsert(view("goal-b2"), "goal-bbb2", {
            source: "goal-command",
        });
        expect(tracker.find("goal-aaa")).toHaveLength(1);
        expect(tracker.find("goal-")).toHaveLength(2);
        expect(tracker.find("missing")).toHaveLength(0);
        expect(tracker.summaries()[0]?.shortId).toBe("goal-aaa");
    });

    it("loads and snapshots detached state", () => {
        const tracker = new GoalTracker();
        tracker.load([
            {
                sessionId: "goal-session-1",
                goalId: "goal-id-1",
                revision: 2,
                phase: "active",
                lastKnownRounds: 1,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                source: "goal-command",
            },
        ]);
        const snapshot = tracker.snapshot();
        expect(snapshot).toHaveLength(1);
        (snapshot[0] as { phase: string }).phase = "complete";
        expect(tracker.get("goal-session-1")?.phase).toBe("active");
        expect(tracker.remove("goal-session-1")?.sessionId).toBe(
            "goal-session-1"
        );
        expect(tracker.get("goal-session-1")).toBeUndefined();
    });
});
