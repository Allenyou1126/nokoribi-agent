import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type { GoalModelRef, GoalState } from "@nokoribi/shared";

/** Why a goal left the tracked set. */
export type GoalArchiveOutcome = GoalState["phase"] | "cleared";

/** One line in `$DSH_HOME/archive/goals.jsonl`. */
export interface GoalArchiveRecord {
    readonly shortId: string;
    readonly sessionId: string;
    readonly objective: string;
    readonly outcome: GoalArchiveOutcome;
    readonly rounds: number;
    readonly maxGoalRounds: number;
    readonly createdAt: string;
    readonly completedAt: string | null;
    readonly archivedAt: string;
    readonly source: GoalState["source"];
    readonly label?: string;
    readonly model?: GoalModelRef;
}

/** Append-only archive index for completed or cleared goal children. */
export class GoalArchive {
    private readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    /** Append one durable record, creating the archive directory if needed. */
    async append(record: GoalArchiveRecord): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const handle = await open(this.path, "a", 0o600);
        try {
            await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
}
