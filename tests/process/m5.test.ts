import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    readState,
    startDaemon,
    statusFull,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
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
    timeoutMs = 20_000
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
    needle: string,
    timeoutMs = 20_000
): Promise<string> {
    const outboxPath = join(running.home, "state/outbox.json");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const document = JSON.parse(await readFile(outboxPath, "utf8")) as {
                items?: Array<{ text?: string }>;
            };
            const found = (document.items ?? []).find(
                (item) =>
                    typeof item.text === "string" && item.text.includes(needle)
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
        token: `m5-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_GOAL_MODEL: "goal-model",
            NOKORIBI_MEMORY_MODEL: "memory-model",
            NOKORIBI_MEMORY_CURATOR: "false",
            NOKORIBI_DEFAULT_HOST: "local:workspace",
            ...extraEnv,
        },
    });
    daemons.push(handle);
    return handle;
}

async function memoryFiles(home: string): Promise<string[]> {
    try {
        const names = await readdir(join(home, "memory", "entries"));
        return await Promise.all(
            names.map((name) =>
                readFile(join(home, "memory", "entries", name), "utf8")
            )
        );
    } catch {
        return [];
    }
}

async function waitForMemory(
    home: string,
    needle: string,
    timeoutMs = 20_000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const files = await memoryFiles(home);
        const found = files.find((file) => file.includes(needle));
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for memory ${JSON.stringify(needle)}`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const memoryWrite: ScriptedResponse = {
    kind: "tool-call",
    name: "memory",
    arguments: {
        action: "write",
        title: "部署偏好",
        tags: ["type:preference", "project:nokoribi-agent"],
        body: "用户偏好用 agenix 管理 NixOS 密钥。",
        source: "session:test#turn-1",
    },
};

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M5 process scenarios", () => {
    it("writes memory, restarts, and searches it in a new turn", async () => {
        const home = await tempHome();
        homes.push(home);
        let mainIndex = 0;
        const first = await startScriptedLlm({
            main: (request) => {
                if (request.model === "memory-model") {
                    return { kind: "text", text: "unexpected curator" };
                }
                return mainIndex++ === 0
                    ? memoryWrite
                    : { kind: "text", text: "记住了" };
            },
        });
        servers.push(first);
        const running = await daemon(first, {}, home);
        await postInbound(running, "记住我的部署偏好", "m5-memory-1");
        await waitForText(running, "记住了");
        expect(await memoryFiles(home)).toHaveLength(1);
        const prompt = first.requests[0]?.system ?? "";
        expect(prompt).toContain("长期记忆是全局单库");
        expect(prompt).toContain("提醒（Schedule）");
        await running.stop();

        let searchIndex = 0;
        const second = await startScriptedLlm({
            main: (request) => {
                if (searchIndex++ === 0) {
                    return {
                        kind: "tool-call",
                        name: "memory",
                        arguments: { action: "search", query: "agenix" },
                    };
                }
                return JSON.stringify(request.body).includes("agenix")
                    ? { kind: "text", text: "找到记忆" }
                    : { kind: "text", text: "未找到记忆" };
            },
        });
        servers.push(second);
        const restarted = await daemon(second, {}, home);
        await postInbound(restarted, "之前说的部署偏好是什么", "m5-memory-2");
        await waitForText(restarted, "找到记忆");
        const full = await statusFull(restarted);
        expect(full.details.memory.activeEntries).toBe(1);
        expect(full.details.memory.bytes).toBeGreaterThan(0);
    });

    it("delivers a due schedule reminder to the main agent", async () => {
        let mainIndex = 0;
        const server = await startScriptedLlm({
            main: () => {
                const index = mainIndex++;
                if (index === 0) {
                    return {
                        kind: "tool-call",
                        name: "schedule_create",
                        arguments: {
                            prompt: "提醒用户喝水",
                            title: "喝水提醒",
                            after_seconds: 2,
                        },
                    };
                }
                return index === 1
                    ? { kind: "text", text: "提醒已设置" }
                    : { kind: "text", text: "提醒触发" };
            },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(running, "2 秒后提醒我喝水", "m5-schedule-1");
        await waitForText(running, "提醒已设置");
        await waitForText(running, "提醒触发", 15_000);
        const stored = await readFile(
            join(running.home, "storage", "schedule.json"),
            "utf8"
        );
        expect(stored).toContain("喝水提醒");
    });

    it("delivers an overdue reminder after SIGKILL and restart", async () => {
        const home = await tempHome();
        homes.push(home);
        let firstIndex = 0;
        const first = await startScriptedLlm({
            main: () => {
                if (firstIndex++ === 0) {
                    return {
                        kind: "tool-call",
                        name: "schedule_create",
                        arguments: {
                            prompt: "逾期提醒测试",
                            title: "逾期测试",
                            after_seconds: 5,
                        },
                    };
                }
                return { kind: "text", text: "逾期测试已设置" };
            },
        });
        servers.push(first);
        const running = await daemon(first, {}, home);
        await postInbound(running, "设置一个逾期提醒", "m5-overdue-1");
        await waitForText(running, "逾期测试已设置");
        running.signal("SIGKILL");
        await running.exited;
        await new Promise((resolve) => setTimeout(resolve, 6000));

        const second = await startScriptedLlm({
            main: (request) =>
                JSON.stringify(request.body).includes("SCHEDULE REMINDER")
                    ? { kind: "text", text: "逾期提醒已送达" }
                    : { kind: "text", text: "unexpected restart turn" },
        });
        servers.push(second);
        const restarted = await daemon(second, {}, home);
        await waitForText(restarted, "逾期提醒已送达", 15_000);
    });

    it("deletes old-session reminders on /clear", async () => {
        let mainIndex = 0;
        const server = await startScriptedLlm({
            main: () =>
                mainIndex++ === 0
                    ? {
                          kind: "tool-call",
                          name: "schedule_create",
                          arguments: {
                              prompt: "旧会话提醒",
                              title: "旧会话提醒",
                              after_seconds: 60,
                          },
                      }
                    : { kind: "text", text: "旧会话提醒已设置" },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(running, "设置旧会话提醒", "m5-clear-schedule-1");
        await waitForText(running, "旧会话提醒已设置");
        await postInbound(running, "/clear", "m5-clear-schedule-2");
        await waitForText(running, "已删除旧会话的 1 条提醒");
        const stored = await readFile(
            join(running.home, "storage", "schedule.json"),
            "utf8"
        );
        expect(stored).not.toContain("旧会话提醒");
        const full = await statusFull(running);
        expect(full.details.schedules).toEqual([]);
    });

    it("selects an allowlisted goal model and rejects another", async () => {
        let goalIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                if (request.model === "alt-model") {
                    if (goalIndex++ === 0) {
                        return { kind: "text", text: "alt bootstrap" };
                    }
                    if (goalIndex === 2) {
                        return {
                            kind: "tool-call",
                            name: "get_goal",
                            arguments: {},
                        };
                    }
                    if (goalIndex === 3) {
                        const ref = findGoalRef(request.body["messages"]);
                        if (ref === undefined) {
                            return { kind: "text", text: "missing goal" };
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
                    return { kind: "text", text: "alt done" };
                }
                return { kind: "text", text: "goal settled" };
            },
        });
        servers.push(server);
        const running = await daemon(server, {
            NOKORIBI_GOAL_MODELS: "deepseek-official/alt-model",
        });
        await postInbound(
            running,
            "/goal new 完成模型路由 --model deepseek-official/alt-model --rounds 3",
            "m5-model-1"
        );
        await waitForText(running, "已创建 goal");
        await waitForState(
            running.home,
            (state) =>
                Array.isArray(state["goals"]) &&
                (state["goals"] as Array<Record<string, unknown>>)[0]?.[
                    "phase"
                ] === "complete"
        );
        expect(
            server.requests.some((request) => request.model === "alt-model")
        ).toBe(true);
        await postInbound(
            running,
            "/goal new 坏模型 --model deepseek-official/nope",
            "m5-model-2"
        );
        await waitForText(running, "is not allowed");
        const state = await readState(running.home);
        expect((state["goals"] as unknown[]).length).toBe(1);
    });

    it("runs the memory curator after a goal completes", async () => {
        let goalIndex = 0;
        let curatorIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                if (request.model === "memory-model") {
                    if (curatorIndex++ === 0) {
                        return {
                            kind: "tool-call",
                            name: "memory",
                            arguments: {
                                action: "search",
                                query: "goal 结论",
                            },
                        };
                    }
                    if (curatorIndex === 2) {
                        return {
                            kind: "tool-call",
                            name: "memory",
                            arguments: {
                                action: "write",
                                title: "goal 提炼",
                                tags: ["type:fact"],
                                body: "goal 完成后的稳定结论。",
                                source: "goal:test",
                            },
                        };
                    }
                    return { kind: "text", text: "curated" };
                }
                if (request.model === "goal-model") {
                    if (goalIndex++ === 0) {
                        return { kind: "text", text: "goal bootstrap" };
                    }
                    if (goalIndex === 2) {
                        return {
                            kind: "tool-call",
                            name: "get_goal",
                            arguments: {},
                        };
                    }
                    if (goalIndex === 3) {
                        const ref = findGoalRef(request.body["messages"]);
                        if (ref === undefined) {
                            return { kind: "text", text: "missing goal" };
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
                    return { kind: "text", text: "goal done" };
                }
                return { kind: "text", text: "goal settled" };
            },
        });
        servers.push(server);
        const running = await daemon(server, {
            NOKORIBI_MEMORY_CURATOR: "true",
        });
        await postInbound(
            running,
            "/goal new 完成记忆提炼 --rounds 3",
            "m5-curator-1"
        );
        await waitForText(running, "已创建 goal");
        await waitForMemory(running.home, "goal 提炼");
        expect(
            server.requests.some(
                (request: ScriptedRequest) => request.model === "memory-model"
            )
        ).toBe(true);
    });

    it("serves full status and injects time context", async () => {
        const server = await startScriptedLlm({
            main: () => ({ kind: "text", text: "状态正常" }),
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(running, "查看状态", "m5-status-1");
        await waitForText(running, "状态正常");
        await postInbound(running, "/status full", "m5-status-2");
        const fullText = await waitForText(running, "recentErrors:");
        expect(fullText).toContain("workspace:");
        expect(fullText).toContain("memory:");
        expect(fullText).toContain("reviewer:");
        const full = await statusFull(running);
        expect(full.details.dshVersion).toMatch(/^0\.2\.1/);
        expect(full.details.memory.activeEntries).toBe(0);
        expect(full.details.schedules).toEqual([]);
        const system = server.requests[0]?.system ?? "";
        expect(system).toContain("长期记忆是全局单库");
        expect(system).toContain("提醒（Schedule）");
        expect(JSON.stringify(server.requests[0]?.body)).toContain(
            "Time sampled while preparing"
        );
    });
});
