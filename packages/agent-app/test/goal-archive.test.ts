import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GoalArchive, type GoalArchiveRecord } from "../src/goals/archive.js";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

describe("GoalArchive", () => {
    it("appends one JSON record per line", async () => {
        const root = await mkdtemp(join(tmpdir(), "nokoribi-goal-archive-"));
        directories.push(root);
        const path = join(root, "nested", "goals.jsonl");
        const archive = new GoalArchive(path);
        const record: GoalArchiveRecord = {
            shortId: "goal-a1b2",
            sessionId: "goal-a1b2-session",
            objective: "probe",
            outcome: "complete",
            rounds: 2,
            maxGoalRounds: 5,
            createdAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
            archivedAt: "2026-01-01T00:02:00.000Z",
            source: "goal-command",
        };
        await archive.append(record);
        await archive.append({ ...record, outcome: "cleared" });
        const lines = (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as GoalArchiveRecord);
        expect(lines).toHaveLength(2);
        expect(lines[0]?.sessionId).toBe("goal-a1b2-session");
        expect(lines[1]?.outcome).toBe("cleared");
        expect(lines[1]?.completedAt).toBe("2026-01-01T00:01:00.000Z");
    });
});
