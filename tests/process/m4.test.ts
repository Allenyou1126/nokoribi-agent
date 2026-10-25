import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    readState,
    startDaemon,
    status as daemonStatus,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedRequest,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

interface GoalRef {
    readonly id: string;
    readonly revision: number;
}

function findGoalRef(value: unknown): GoalRef | undefined {
    if (typeof value === "string") {
        try {
            return findGoalRef(JSON.parse(value) as unknown);
        } catch {
            return undefined;
        }
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findGoalRef(item);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const goal = record["goal"];
        if (typeof goal === "object" && goal !== null) {
            const goalRecord = goal as Record<string, unknown>;
            if (
                typeof goalRecord["id"] === "string" &&
                typeof goalRecord["revision"] === "number"
            ) {
                return {
                    id: goalRecord["id"],
                    revision: goalRecord["revision"],
                };
            }
        }
        for (const child of Object.values(record)) {
            const found = findGoalRef(child);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

async function waitForState(
    home: string,
    predicate: (state: Record<string, unknown>) => boolean,
    timeoutMs = 15_000
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const state = await readState(home);
            if (predicate(state)) return state;
        } catch {
            // state file may not exist yet
        }
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for daemon state");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function waitForText(
    running: DaemonHandle,
    after: number,
    needle: string,
    timeoutMs = 15_000
): Promise<string> {
    const outboxPath = join(running.home, "state/outbox.json");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const document = JSON.parse(await readFile(outboxPath, "utf8")) as {
                items?: Array<{ seq?: number; text?: string }>;
            };
            const found = (document.items ?? []).find(
                (item) =>
                    typeof item.seq === "number" &&
                    item.seq > after &&
                    typeof item.text === "string" &&
                    item.text.includes(needle)
            );
            if (found?.text !== undefined) return found.text;
        } catch {
            // outbox may not be written yet
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function daemon(
    server: ScriptedLlmServer,
    extraEnv: Record<string, string> = {},
    home?: string
): Promise<DaemonHandle> {
    const target = home ?? (await tempHome());
    if (home === undefined) homes.push(target);
    const handle = await startDaemon({
        home: target,
        token: `m4-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_GOAL_MODEL: "goal-model",
            NOKORIBI_DEFAULT_HOST: "local:workspace",
            NOKORIBI_GOAL_RECOVERY_TIMEOUT_MS: "5000",
            ...extraEnv,
        },
    });
    daemons.push(handle);
    return handle;
}

function goalChild(request: ScriptedRequest, index: number): ScriptedResponse {
    if (index === 0) {
        return { kind: "text", text: "goal bootstrap ready" };
    }
    if (index === 1) {
        return { kind: "tool-call", name: "get_goal", arguments: {} };
    }
    if (index === 2) {
        const ref = findGoalRef(request.body["messages"]);
        if (ref === undefined) {
            return { kind: "text", text: "missing goal ref" };
        }
        return {
            kind: "tool-call",
            name: "update_goal",
            arguments: {
                goal_id: ref.id,
                revision: ref.revision,
                action: "complete",
            },
        };
    }
    return { kind: "text", text: "goal complete" };
}

async function scripted(): Promise<{
    server: ScriptedLlmServer;
    mainRequests: string[];
}> {
    const mainRequests: string[] = [];
    let mainIndex = 0;
    let goalIndex = 0;
    const server = await startScriptedLlm({
        main: (request) => {
            if (request.model === "goal-model") {
                return goalChild(request, goalIndex++);
            }
            mainRequests.push(request.model);
            return mainIndex++ === 0
                ? { kind: "text", text: "goal settled" }
                : { kind: "text", text: "main idle" };
        },
    });
    servers.push(server);
    return { server, mainRequests };
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M4 process scenarios", () => {
    it("creates a goal via /goal new, completes it, and archives it", async () => {
        const { server } = await scripted();
        const running = await daemon(server);
        expect(
            (
                await postInbound(
                    running,
                    "/goal new 完成探针目标 --rounds 3",
                    "m4-new-1"
                )
            ).status
        ).toBe(202);
        await waitForText(running, 0, "已创建 goal");
        const state = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        const goals = state["goals"] as Array<Record<string, unknown>>;
        const goal = goals[0] as Record<string, unknown>;
        const childId = goal["sessionId"] as string;
        const shortId = childId.slice(0, 8);
        expect(childId.startsWith("goal-")).toBe(true);
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) &&
                (value["goals"] as Array<Record<string, unknown>>)[0]?.[
                    "phase"
                ] === "complete"
        );
        expect(
            (await waitForText(running, 0, "goal settled")).length
        ).toBeGreaterThan(0);
        const statusValue = await daemonStatus(running);
        expect(statusValue.goals).toHaveLength(1);
        expect((statusValue.goals[0] as Record<string, unknown>)["phase"]).toBe(
            "complete"
        );
        const list = await postInbound(running, "/goal list", "m4-list-1");
        expect(list.status).toBe(202);
        await waitForText(running, 0, shortId);
        const status = await postInbound(
            running,
            `/goal status ${shortId}`,
            "m4-status-1"
        );
        expect(status.status).toBe(202);
        await waitForText(running, 0, "phase: complete");
        await mkdir(join(running.home, "sandboxes", childId), {
            recursive: true,
        });
        const archive = await postInbound(
            running,
            `/goal archive ${shortId}`,
            "m4-archive-1"
        );
        expect(archive.status).toBe(202);
        await waitForText(running, 0, "已归档");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 0
        );
        const archiveText = await readFile(
            join(running.home, "archive/goals.jsonl"),
            "utf8"
        );
        expect(archiveText).toContain('"outcome":"complete"');
        expect(archiveText).toContain(childId);
        await expect(
            access(join(running.home, "sandboxes", childId))
        ).rejects.toThrow();
        const sessions = await findSessionFiles(running.home);
        const contents = await Promise.all(
            sessions.map((path) => readFile(path, "utf8"))
        );
        expect(contents.join("\n")).toContain(childId);
    }, 30_000);
    it("starts a goal through start_goal and hides goal tools from the main agent", async () => {
        const seenTools: string[] = [];
        let mainIndex = 0;
        let goalIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                if (request.model === "goal-model") {
                    return goalChild(request, goalIndex++);
                }
                if (mainIndex === 0) {
                    const tools = request.body["tools"];
                    if (Array.isArray(tools)) {
                        for (const tool of tools) {
                            if (
                                typeof tool === "object" &&
                                tool !== null &&
                                typeof (tool as Record<string, unknown>)[
                                    "name"
                                ] === "string"
                            ) {
                                seenTools.push(
                                    (tool as Record<string, unknown>)[
                                        "name"
                                    ] as string
                                );
                            }
                        }
                    }
                }
                const index = mainIndex++;
                return index === 0
                    ? {
                          kind: "tool-call",
                          name: "start_goal",
                          arguments: {
                              objective: "工具路径目标",
                              description: "tool goal probe",
                              max_goal_rounds: 3,
                          },
                      }
                    : {
                          kind: "text",
                          text: index === 1 ? "goal started" : "goal settled",
                      };
            },
        });
        servers.push(server);
        const running = await daemon(server);
        expect(
            (await postInbound(running, "start the goal", "m4-tool-1")).status
        ).toBe(202);
        await waitForText(running, 0, "goal started");
        const state = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        const goal = (
            state["goals"] as Array<Record<string, unknown>>
        )[0] as Record<string, unknown>;
        expect((goal["sessionId"] as string).startsWith("goal-")).toBe(true);
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) &&
                (value["goals"] as Array<Record<string, unknown>>)[0]?.[
                    "phase"
                ] === "complete"
        );
        await waitForText(running, 0, "goal settled");
        expect(seenTools).toContain("start_goal");
        expect(seenTools).not.toContain("create_goal");
        expect(seenTools).not.toContain("get_goal");
        expect(seenTools).not.toContain("update_goal");
    }, 30_000);

    it("rejects a main-session create_goal call", async () => {
        const seenTools: string[] = [];
        let mainIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                if (mainIndex === 0) {
                    const tools = request.body["tools"];
                    if (Array.isArray(tools)) {
                        for (const tool of tools) {
                            if (
                                typeof tool === "object" &&
                                tool !== null &&
                                typeof (tool as Record<string, unknown>)[
                                    "name"
                                ] === "string"
                            ) {
                                seenTools.push(
                                    (tool as Record<string, unknown>)[
                                        "name"
                                    ] as string
                                );
                            }
                        }
                    }
                }
                return mainIndex++ === 0
                    ? {
                          kind: "tool-call",
                          name: "create_goal",
                          arguments: { objective: "should not exist" },
                      }
                    : { kind: "text", text: "goal tool unavailable" };
            },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(running, "try to create a main goal", "m4-hidden-1");
        await waitForText(running, 0, "goal tool unavailable");
        const state = await readState(running.home);
        expect(state["goals"]).toEqual([]);
        expect(seenTools).toContain("start_goal");
        expect(seenTools).not.toContain("create_goal");
        expect(seenTools).not.toContain("get_goal");
        expect(seenTools).not.toContain("update_goal");
    }, 30_000);

    it("pauses and resumes automatic goal rounds", async () => {
        const server = await startScriptedLlm({
            main: (request) =>
                request.model === "goal-model"
                    ? {
                          kind: "text",
                          text: "goal still working",
                          delayMs: 700,
                      }
                    : { kind: "text", text: "main idle" },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(
            running,
            "/goal new 暂停恢复探针 --rounds 20",
            "m4-pause-1"
        );
        await waitForText(running, 0, "已创建 goal");
        const created = await waitForState(running.home, (value) => {
            const goals = value["goals"];
            return (
                Array.isArray(goals) &&
                goals.length === 1 &&
                ((goals[0] as Record<string, unknown>)[
                    "lastKnownRounds"
                ] as number) >= 1
            );
        });
        const goal = (
            created["goals"] as Array<Record<string, unknown>>
        )[0] as Record<string, unknown>;
        const shortId = (goal["sessionId"] as string).slice(0, 8);
        await postInbound(running, `/goal pause ${shortId}`, "m4-pause-2");
        await waitForText(running, 0, "已暂停");
        const paused = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) &&
                (value["goals"] as Array<Record<string, unknown>>)[0]?.[
                    "phase"
                ] === "paused"
        );
        const pausedRounds = (
            (paused["goals"] as Array<Record<string, unknown>>)[0] as Record<
                string,
                unknown
            >
        )["lastKnownRounds"] as number;
        await postInbound(running, `/goal resume ${shortId}`, "m4-pause-3");
        await waitForText(running, 0, "已恢复");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) &&
                ((value["goals"] as Array<Record<string, unknown>>)[0]?.[
                    "lastKnownRounds"
                ] as number) > pausedRounds,
            15_000
        );
    }, 30_000);

    it("cold-resumes an active goal after SIGKILL and rearms it", async () => {
        const server = await startScriptedLlm({
            main: (request) =>
                request.model === "goal-model"
                    ? {
                          kind: "text",
                          text: "goal working after restart",
                          delayMs: 500,
                      }
                    : { kind: "text", text: "main idle" },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await daemon(server, {}, home);
        await postInbound(
            running,
            "/goal new 重启恢复探针 --rounds 30",
            "m4-restart-1"
        );
        await waitForText(running, 0, "已创建 goal");
        const before = await waitForState(running.home, (value) => {
            const goals = value["goals"];
            return (
                Array.isArray(goals) &&
                goals.length === 1 &&
                ((goals[0] as Record<string, unknown>)[
                    "lastKnownRounds"
                ] as number) >= 1
            );
        });
        const beforeRounds = (
            (before["goals"] as Array<Record<string, unknown>>)[0] as Record<
                string,
                unknown
            >
        )["lastKnownRounds"] as number;
        running.signal("SIGKILL");
        await running.exited;
        const restarted = await daemon(server, {}, home);
        await waitForState(
            restarted.home,
            (value) => {
                const goals = value["goals"];
                return (
                    Array.isArray(goals) &&
                    goals.length === 1 &&
                    ((goals[0] as Record<string, unknown>)[
                        "lastKnownRounds"
                    ] as number) > beforeRounds
                );
            },
            20_000
        );
    }, 35_000);

    it("clears and archives every active goal on /clear", async () => {
        const server = await startScriptedLlm({
            main: (request) =>
                request.model === "goal-model"
                    ? {
                          kind: "text",
                          text: "goal working before clear",
                          delayMs: 500,
                      }
                    : { kind: "text", text: "main idle" },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(
            running,
            "/goal new 清理探针 --rounds 20",
            "m4-clear-1"
        );
        await waitForText(running, 0, "已创建 goal");
        const created = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        const childId = (
            (created["goals"] as Array<Record<string, unknown>>)[0] as Record<
                string,
                unknown
            >
        )["sessionId"] as string;
        await mkdir(join(running.home, "sandboxes", childId), {
            recursive: true,
        });
        await postInbound(running, "/clear", "m4-clear-2");
        await waitForText(running, 0, "已新建会话");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 0
        );
        const archiveText = await readFile(
            join(running.home, "archive/goals.jsonl"),
            "utf8"
        );
        expect(archiveText).toContain('"outcome":"cleared"');
        expect(archiveText).toContain(childId);
        await expect(
            access(join(running.home, "sandboxes", childId))
        ).rejects.toThrow();
        const sessions = await findSessionFiles(running.home);
        const contents = await Promise.all(
            sessions.map((path) => readFile(path, "utf8"))
        );
        expect(contents.join("\n")).toContain(childId);

        await postInbound(
            running,
            "/goal new 清理后新会话目标 --rounds 5",
            "m4-clear-3"
        );
        await waitForText(running, 0, "已创建 goal");
        const afterClear = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        const newId = (
            (
                afterClear["goals"] as Array<Record<string, unknown>>
            )[0] as Record<string, unknown>
        )["sessionId"] as string;
        await postInbound(
            running,
            `/goal clear ${newId.slice(0, 8)}`,
            "m4-clear-4"
        );
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 0
        );
    }, 30_000);

    it("tracks two goals and clears them independently", async () => {
        const server = await startScriptedLlm({
            main: (request) =>
                request.model === "goal-model"
                    ? {
                          kind: "text",
                          text: "parallel goal working",
                          delayMs: 800,
                      }
                    : { kind: "text", text: "main idle" },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(
            running,
            "/goal new 并行目标一 --rounds 20",
            "m4-multi-1"
        );
        await waitForText(running, 0, "已创建 goal");
        await postInbound(
            running,
            "/goal new 并行目标二 --rounds 20",
            "m4-multi-2"
        );
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 2
        );
        const state = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 2
        );
        const goals = state["goals"] as Array<Record<string, unknown>>;
        const firstGoal = goals[0];
        const secondGoal = goals[1];
        if (firstGoal === undefined || secondGoal === undefined) {
            throw new Error("expected two tracked goals");
        }
        const first = (firstGoal["sessionId"] as string).slice(0, 8);
        const second = (secondGoal["sessionId"] as string).slice(0, 8);
        expect(first).not.toBe(second);
        const list = await postInbound(running, "/goal list", "m4-multi-3");
        expect(list.status).toBe(202);
        await waitForText(running, 0, first);
        await waitForText(running, 0, second);
        await postInbound(running, `/goal clear ${first}`, "m4-multi-4");
        await waitForText(running, 0, "已清除并归档");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        await postInbound(running, `/goal clear ${second}`, "m4-multi-5");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 0
        );
    }, 35_000);

    it("keeps a tracked goal and notifies when cold recovery fails", async () => {
        const server = await startScriptedLlm({
            main: (request) =>
                request.model === "goal-model"
                    ? {
                          kind: "text",
                          text: "goal before failed recovery",
                          delayMs: 500,
                      }
                    : { kind: "text", text: "main idle" },
        });
        servers.push(server);
        const home = await tempHome();
        homes.push(home);
        const running = await daemon(server, {}, home);
        await postInbound(
            running,
            "/goal new 恢复失败探针 --rounds 30",
            "m4-fail-1"
        );
        await waitForText(running, 0, "已创建 goal");
        const created = await waitForState(running.home, (value) => {
            const goals = value["goals"];
            return (
                Array.isArray(goals) &&
                goals.length === 1 &&
                ((goals[0] as Record<string, unknown>)[
                    "lastKnownRounds"
                ] as number) >= 1
            );
        });
        const childId = (
            (created["goals"] as Array<Record<string, unknown>>)[0] as Record<
                string,
                unknown
            >
        )["sessionId"] as string;
        running.signal("SIGKILL");
        await running.exited;
        const sessions = await findSessionFiles(home);
        await Promise.all(
            sessions
                .filter((path) => path.includes(childId))
                .map((path) => rm(path, { force: true }))
        );
        const restarted = await daemon(server, {}, home);
        await waitForText(restarted, 0, "恢复失败", 15_000);
        const state = await readState(home);
        const goals = state["goals"] as Array<Record<string, unknown>>;
        expect(goals).toHaveLength(1);
        expect(goals[0]?.["sessionId"]).toBe(childId);
        expect(goals[0]?.["phase"]).toBe("active");
    }, 35_000);

    it("delivers a goal child send_message report to the parent", async () => {
        let goalIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                if (request.model === "goal-model") {
                    goalIndex += 1;
                    if (goalIndex === 1) {
                        return { kind: "text", text: "bootstrap ready" };
                    }
                    if (goalIndex === 2) {
                        const encoded = JSON.stringify(
                            request.body["messages"] ?? []
                        );
                        const parent = /main-[0-9a-f-]{36}/.exec(encoded);
                        if (parent === null) {
                            return { kind: "text", text: "no parent" };
                        }
                        return {
                            kind: "tool-call",
                            name: "send_message",
                            arguments: {
                                agent_id: parent[0],
                                message:
                                    "[goal:probe] progress: child progress",
                            },
                        };
                    }
                    return {
                        kind: "text",
                        text: "child still working",
                        delayMs: 500,
                    };
                }
                return { kind: "text", text: "report received" };
            },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(
            running,
            "/goal new 汇报探针 --rounds 10",
            "m4-report-1"
        );
        await waitForText(running, 0, "已创建 goal");
        const created = await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 1
        );
        const shortId = (
            (created["goals"] as Array<Record<string, unknown>>)[0] as Record<
                string,
                unknown
            >
        )["sessionId"] as string;
        await waitForText(running, 0, "report received");
        const list = await postInbound(running, "/goal list", "m4-report-2");
        expect(list.status).toBe(202);
        const short = shortId.slice(0, 8);
        await postInbound(running, `/goal clear ${short}`, "m4-report-3");
        await waitForState(
            running.home,
            (value) =>
                Array.isArray(value["goals"]) && value["goals"].length === 0
        );
    }, 30_000);
});
