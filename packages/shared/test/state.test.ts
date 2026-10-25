import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    defaultAgentState,
    isGoalChildSession,
    loadAgentState,
    saveAgentState,
    shortGoalId,
} from "../src/state.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nokoribi-shared-"));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(
        dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
});

describe("agent state", () => {
    it("loads missing state as absent", async () => {
        const dir = await tempDir();
        const loaded = await loadAgentState(join(dir, "agent-state.json"));
        expect(loaded.state).toBeNull();
        expect(loaded.corrupt).toBe(false);
    });

    it("round-trips state and preserves unknown fields", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent-state.json");
        const state = {
            ...defaultAgentState("0.1.0"),
            mainSessionId: "main-1",
            lastActiveChat: { channelId: "local-test", chatId: "local" },
            goals: [
                {
                    sessionId: "goal-a1b2c3d4-child",
                    goalId: "goal-uuid",
                    revision: 2,
                    phase: "active" as const,
                    lastKnownRounds: 3,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:01:00.000Z",
                    source: "goal-command" as const,
                    objective: "probe",
                    maxGoalRounds: 10,
                    label: "probe goal",
                    model: {
                        provider: "p",
                        model: "m",
                        reasoningEffort: "high",
                    },
                },
            ],
            extra: "kept",
        };
        await saveAgentState(path, state);
        const loaded = await loadAgentState(path);
        expect(loaded.corrupt).toBe(false);
        expect(loaded.state?.mainSessionId).toBe("main-1");
        expect((loaded.state as unknown as { extra?: string }).extra).toBe(
            "kept"
        );
        expect(loaded.state?.goals[0]?.objective).toBe("probe");
        expect(loaded.state?.goals[0]?.model).toEqual({
            provider: "p",
            model: "m",
            reasoningEffort: "high",
        });
        expect(isGoalChildSession("goal-a1b2-child")).toBe(true);
        expect(shortGoalId("goal-a1b2c3d4-child")).toBe("goal-a1b");
        expect(isGoalChildSession("main-1")).toBe(false);
    });

    it("backs up corrupt state instead of throwing it away", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent-state.json");
        await writeFile(path, "{not json", "utf8");
        const loaded = await loadAgentState(path);
        expect(loaded.state).toBeNull();
        expect(loaded.corrupt).toBe(true);
        expect(loaded.backupPath).toBeDefined();
        await expect(readFile(loaded.backupPath ?? "", "utf8")).resolves.toBe(
            "{not json"
        );
    });

    it("rejects an unknown future version as corrupt", async () => {
        const dir = await tempDir();
        const path = join(dir, "agent-state.json");
        await writeFile(
            path,
            JSON.stringify({
                version: 2,
                mainSessionId: null,
                goals: [],
                archivedGoals: [],
                lastActiveChat: null,
                cleanShutdown: false,
                outboxSeq: 0,
                lastStartedAt: null,
                lastVersion: "x",
                lastRestartReason: null,
            })
        );
        const loaded = await loadAgentState(path);
        expect(loaded.corrupt).toBe(true);
    });
});
