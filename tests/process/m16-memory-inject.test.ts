import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    startDaemon,
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

/** First line of every injected snapshot. */
const SNAPSHOT_MARKER = "本地长期记忆快照";

/** Over-budget footer for exactly one omitted entry. */
const OMITTED_FOOTER = "另有 1 条未注入，可用 memory search";

interface FixtureEntry {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly tags?: readonly string[];
    readonly pinned?: boolean;
    readonly confidence?: string;
    readonly updated?: string;
}

/** Write memory entries directly under the daemon's DSH_HOME. */
async function writeMemoryEntries(
    home: string,
    entries: readonly FixtureEntry[]
): Promise<void> {
    const directory = join(home, "memory", "entries");
    await mkdir(directory, { recursive: true });
    for (const entry of entries) {
        const text = [
            "---",
            `id: ${JSON.stringify(entry.id)}`,
            `title: ${JSON.stringify(entry.title)}`,
            `tags: ${JSON.stringify(entry.tags ?? ["type:person"])}`,
            'created: "2026-01-01T00:00:00.000Z"',
            `updated: ${JSON.stringify(
                entry.updated ?? "2026-01-01T00:00:00.000Z"
            )}`,
            `confidence: ${JSON.stringify(entry.confidence ?? "high")}`,
            'status: "active"',
            `pinned: ${entry.pinned === false ? "false" : "true"}`,
            "supersedes: null",
            "---",
            "",
            entry.body,
            "",
        ].join("\n");
        await writeFile(join(directory, `${entry.id}.md`), text);
    }
}

/** Serialize one scripted request body for content assertions. */
function requestText(request: ScriptedRequest): string {
    return JSON.stringify(request.body);
}

/** Count non-overlapping occurrences of one needle. */
function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

/** Poll a predicate until it holds or the deadline expires. */
async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 20_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** Wait until the outbox holds a reply containing one needle. */
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
            // the outbox is not written yet
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** Reply with `present` when the request body contains `needle`. */
function replyWhenBodyContains(
    request: ScriptedRequest,
    needle: string,
    present: string,
    missing: string
): ScriptedResponse {
    return requestText(request).includes(needle)
        ? { kind: "text", text: present }
        : { kind: "text", text: missing };
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
        token: `m16-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_GOAL_MODEL: "goal-model",
            NOKORIBI_MEMORY_CURATOR: "false",
            NOKORIBI_DEFAULT_HOST: "local:workspace",
            ...extraEnv,
        },
    });
    daemons.push(handle);
    return handle;
}

async function memoryEntryFiles(home: string): Promise<string[]> {
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

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M16 memory injection process scenarios", () => {
    it("injects a pinned entry written by the memory tool on the next turn", async () => {
        let mainIndex = 0;
        const server = await startScriptedLlm({
            main: (request) => {
                const index = mainIndex++;
                if (index === 0) {
                    return {
                        kind: "tool-call",
                        name: "memory",
                        arguments: {
                            action: "write",
                            title: "用户称呼",
                            tags: ["type:person"],
                            body: "用户希望被称呼为老板。",
                            pinned: true,
                        },
                    };
                }
                if (index === 1) return { kind: "text", text: "已记住" };
                return replyWhenBodyContains(
                    request,
                    SNAPSHOT_MARKER,
                    "快照可见",
                    "快照缺失"
                );
            },
        });
        servers.push(server);
        const running = await daemon(server);
        await postInbound(running, "记住我的称呼", "m16-inject-1");
        await waitForText(running, "已记住");
        const files = await memoryEntryFiles(running.home);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain("pinned: true");

        await postInbound(running, "我们之前说了什么", "m16-inject-2");
        await waitForText(running, "快照可见");
        const injected = server.requests.find((request) =>
            requestText(request).includes(SNAPSHOT_MARKER)
        );
        expect(injected).toBeDefined();
        expect(requestText(injected as ScriptedRequest)).toContain(
            "用户希望被称呼为老板。"
        );

        await postInbound(running, "/status full", "m16-inject-3");
        const statusText = await waitForText(running, "inject=enabled");
        expect(statusText).toContain("pinned=1");
        expect(statusText).toMatch(/snapshotChars=[1-9][0-9]*/);
    });

    it("injects the snapshot into the main session but not a goal child", async () => {
        const home = await tempHome();
        homes.push(home);
        await writeMemoryEntries(home, [
            {
                id: "mem-main-pin",
                title: "称呼",
                body: "用户希望被称呼为老板。",
            },
        ]);
        const server = await startScriptedLlm({
            main: (request) => {
                if (request.model === "goal-model") {
                    return { kind: "text", text: "goal bootstrap" };
                }
                return replyWhenBodyContains(
                    request,
                    SNAPSHOT_MARKER,
                    "主会话有快照",
                    "主会话无快照"
                );
            },
        });
        servers.push(server);
        const running = await daemon(server, {}, home);
        await postInbound(running, "你好", "m16-mainonly-1");
        await waitForText(running, "主会话有快照");

        await postInbound(
            running,
            "/goal new 无快照子代理 --rounds 2",
            "m16-mainonly-2"
        );
        await waitForText(running, "已创建 goal");
        await waitFor(
            () =>
                server.requests.some(
                    (request) => request.model === "goal-model"
                ),
            "goal child request"
        );
        const childRequests = server.requests.filter(
            (request) => request.model === "goal-model"
        );
        for (const request of childRequests) {
            expect(requestText(request)).not.toContain(SNAPSHOT_MARKER);
        }
    });

    it("does not inject when NOKORIBI_MEMORY_INJECT_ENABLED=false", async () => {
        const home = await tempHome();
        homes.push(home);
        await writeMemoryEntries(home, [
            {
                id: "mem-disabled-pin",
                title: "称呼",
                body: "用户希望被称呼为老板。",
            },
        ]);
        const server = await startScriptedLlm({
            main: (request) =>
                replyWhenBodyContains(
                    request,
                    SNAPSHOT_MARKER,
                    "不应出现快照",
                    "无快照"
                ),
        });
        servers.push(server);
        const running = await daemon(
            server,
            {
                NOKORIBI_MEMORY_INJECT_ENABLED: "false",
            },
            home
        );
        await postInbound(running, "你好", "m16-disabled-1");
        await waitForText(running, "无快照");
        for (const request of server.requests) {
            expect(request.model).toBe("main-model");
            expect(requestText(request)).not.toContain(SNAPSHOT_MARKER);
        }
    });

    it("appends the over-budget footer when entries exceed the configured budget", async () => {
        const home = await tempHome();
        homes.push(home);
        await writeMemoryEntries(home, [
            {
                id: "mem-budget-1",
                title: "偏好一",
                body: "偏好一内容。",
                updated: "2026-03-01T00:00:00.000Z",
            },
            {
                id: "mem-budget-2",
                title: "偏好二",
                body: "偏好二内容。",
                updated: "2026-02-01T00:00:00.000Z",
            },
            {
                id: "mem-budget-3",
                title: "偏好三",
                body: "偏好三内容。",
                updated: "2026-01-01T00:00:00.000Z",
            },
        ]);
        const server = await startScriptedLlm({
            main: (request) =>
                replyWhenBodyContains(
                    request,
                    OMITTED_FOOTER,
                    "截断提示可见",
                    "截断提示缺失"
                ),
        });
        servers.push(server);
        const running = await daemon(
            server,
            {
                NOKORIBI_MEMORY_INJECT_MAX_ENTRIES: "2",
            },
            home
        );
        await postInbound(running, "你好", "m16-budget-1");
        await waitForText(running, "截断提示可见");
        const injected = server.requests.find((request) =>
            requestText(request).includes(SNAPSHOT_MARKER)
        );
        expect(injected).toBeDefined();
        const text = requestText(injected as ScriptedRequest);
        expect(text).toContain(OMITTED_FOOTER);
        expect(text).toContain("偏好一");
        expect(text).toContain("偏好二");
        expect(text).not.toContain("偏好三");
    });

    it("does not duplicate the snapshot after a restart", async () => {
        const home = await tempHome();
        homes.push(home);
        await writeMemoryEntries(home, [
            {
                id: "mem-restart-pin",
                title: "称呼",
                body: "用户希望被称呼为老板。",
            },
        ]);
        const first = await startScriptedLlm({
            main: () => ({ kind: "text", text: "第一次" }),
        });
        servers.push(first);
        const running = await daemon(first, {}, home);
        await postInbound(running, "你好", "m16-restart-1");
        await waitForText(running, "第一次");
        const firstRequest = first.requests[0];
        expect(firstRequest).toBeDefined();
        expect(
            countOccurrences(
                requestText(firstRequest as ScriptedRequest),
                SNAPSHOT_MARKER
            )
        ).toBe(1);
        await running.stop();

        const second = await startScriptedLlm({
            main: () => ({ kind: "text", text: "第二次" }),
        });
        servers.push(second);
        const restarted = await daemon(second, {}, home);
        await postInbound(restarted, "继续", "m16-restart-2");
        await waitForText(restarted, "第二次");
        const resumedRequest = second.requests[0];
        expect(resumedRequest).toBeDefined();
        expect(
            countOccurrences(
                requestText(resumedRequest as ScriptedRequest),
                SNAPSHOT_MARKER
            )
        ).toBe(1);
    });

    it("omits the memory section and tool when NO_KORIBI_MEMORY_ENABLED=false", async () => {
        const server = await startScriptedLlm({
            main: () => ({ kind: "text", text: "无记忆段" }),
        });
        servers.push(server);
        const running = await daemon(server, {
            NOKORIBI_MEMORY_ENABLED: "false",
        });
        await postInbound(running, "你好", "m16-localoff-1");
        await waitForText(running, "无记忆段");
        const request = server.requests[0];
        expect(request).toBeDefined();
        if (request === undefined) throw new Error("missing main request");
        expect(request.system ?? "").not.toContain("## Memory");
        expect(request.system ?? "").not.toContain("长期记忆是全局单库");
        const tools = Array.isArray(request.body["tools"])
            ? (request.body["tools"] as Array<Record<string, unknown>>)
            : [];
        expect(tools.some((tool) => tool["name"] === "memory")).toBe(false);
    });
});
