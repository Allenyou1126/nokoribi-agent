import { join } from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Resolved runtime paths for one daemon instance. */
export interface HomePaths {
    readonly home: string;
    readonly stateDir: string;
    readonly runDir: string;
    readonly sessionsDir: string;
    readonly archiveDir: string;
    readonly memoryDir: string;
    readonly sandboxesDir: string;
    readonly workspaceDir: string;
    readonly profileDir: string;
    readonly agentStatePath: string;
    readonly outboxPath: string;
    readonly seenPath: string;
    readonly lockPath: string;
    readonly testChannelPath: string;
    readonly readyPath: string;
    readonly startupErrorPath: string;
}

/** Resolve every path from `DSH_HOME` and an optional workspace override. */
export function resolveHomePaths(
    configuredWorkspace?: string,
    env: Record<string, string | undefined> = process.env
): HomePaths {
    const home = resolveDshHome(undefined, env);
    const stateDir = join(home, "state");
    const runDir = join(home, "run");
    const workspaceDir = configuredWorkspace ?? join(home, "workspace");
    return {
        home,
        stateDir,
        runDir,
        sessionsDir: join(home, "sessions"),
        archiveDir: join(home, "archive"),
        memoryDir: join(home, "memory"),
        sandboxesDir: join(home, "sandboxes"),
        workspaceDir,
        profileDir: join(runDir, "profile"),
        agentStatePath: join(stateDir, "agent-state.json"),
        outboxPath: join(stateDir, "outbox.json"),
        seenPath: join(stateDir, "ingress-seen.json"),
        lockPath: join(runDir, "agent.lock"),
        testChannelPath: join(runDir, "test-channel.json"),
        readyPath: join(runDir, "ready.json"),
        startupErrorPath: join(runDir, "startup-error.json"),
    };
}

/** Create the directories owned by this daemon. */
export async function ensureHomeDirs(paths: HomePaths): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    for (const dir of [
        paths.stateDir,
        paths.runDir,
        paths.archiveDir,
        paths.memoryDir,
        paths.sandboxesDir,
        paths.workspaceDir,
    ]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
    }
}
