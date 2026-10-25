import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    appendPendingInteraction,
    cleanupHome,
    postInbound,
    startDaemon,
    status,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

function review(text: string): ScriptedResponse {
    return { kind: "text", text };
}

function deny(reason: string): ScriptedResponse {
    return review(JSON.stringify({ risk: "medium", decision: "deny", reason }));
}

function allow(): ScriptedResponse {
    return review('{"risk":"low","decision":"allow"}');
}

async function daemon(
    server: ScriptedLlmServer,
    extraEnv: Record<string, string> = {}
): Promise<DaemonHandle> {
    const home = await tempHome();
    homes.push(home);
    const handle = await startDaemon({
        home,
        token: `m2-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_REVIEW_FAST_MODEL: "review-fast",
            NOKORIBI_REVIEW_STRONG_MODEL: "review-strong",
            ...extraEnv,
        },
    });
    daemons.push(handle);
    return handle;
}

async function scripted(
    main: (request: unknown, index: number) => ScriptedResponse,
    reviewResponse: (
        request: unknown,
        tier: "fast" | "strong",
        index: number
    ) => ScriptedResponse = () => allow()
): Promise<ScriptedLlmServer> {
    const server = await startScriptedLlm({
        main,
        review: (request, tier, index) => reviewResponse(request, tier, index),
    });
    servers.push(server);
    return server;
}

function writeCall(
    path = "probe.txt",
    content = "written\n"
): ScriptedResponse {
    return {
        kind: "tool-call",
        name: "write",
        arguments: { file_path: path, content },
    };
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

describe("M2 process scenarios", () => {
    it("selects auto, reports it, and allows a reviewed write", async () => {
        const server = await scripted((_request, index) =>
            index === 0
                ? writeCall()
                : { kind: "text", text: "write completed" }
        );
        const running = await daemon(server);

        const permission = await postInbound(running, "/permission", "p-1");
        expect(permission.status).toBe(202);
        const permissionItems = await waitForOutbound(running, 0);
        expect(permissionItems.items[0]?.text).toContain("permission: auto");
        const switchAttempt = await postInbound(
            running,
            "/permission auto",
            "p-2"
        );
        expect(switchAttempt.status).toBe(202);
        const switchItems = await waitForOutbound(
            running,
            permissionItems.items.at(-1)?.seq ?? 0
        );
        expect(switchItems.items[0]?.text).toContain("不支持切换");

        const afterSwitch = switchItems.items.at(-1)?.seq ?? 0;
        expect((await postInbound(running, "write it", "w-1")).status).toBe(
            202
        );
        const result = await waitForOutbound(running, afterSwitch, 15);
        expect(
            result.items.some((item) => item.text === "write completed")
        ).toBe(true);
        const { readFile } = await import("node:fs/promises");
        await expect(
            readFile(join(running.home, "workspace/probe.txt"), "utf8")
        ).resolves.toBe("written\n");
        const current = await status(running);
        expect(current.agentStatus).toBe("idle");
        expect(current.permission).toBe("auto");
        expect(current.pendingInteractions).toBe(0);
        expect(
            server.requests.filter((request) =>
                request.system?.startsWith("REVIEW_POLICY")
            )
        ).toHaveLength(1);
    });

    it("asks for approval after fast and strong denial, then executes", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write completed" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs explicit approval")
                    : deny("still risky")
        );
        const running = await daemon(server);
        expect((await postInbound(running, "write it", "a-1")).status).toBe(
            202
        );
        const first = await waitForOutbound(running, 0, 15);
        const prompt = first.items.find(
            (item) => item.kind === "interaction" && item.text.includes("🔐")
        );
        expect(prompt).toBeDefined();
        expect(prompt?.text).toContain("工具：write");
        expect(prompt?.text).toContain("动作：write");
        expect(prompt?.text).toContain("still risky");
        expect((await status(running)).pendingInteractions).toBe(1);
        const promptSeq = first.items.at(-1)?.seq ?? 0;

        expect((await postInbound(running, "允许", "a-2")).status).toBe(202);
        const decided = await waitForOutbound(running, promptSeq, 15);
        expect(
            decided.items.some((item) => item.text === "write completed")
        ).toBe(true);
        const { readFile } = await import("node:fs/promises");
        await expect(
            readFile(join(running.home, "workspace/probe.txt"), "utf8")
        ).resolves.toBe("written\n");
        expect((await status(running)).pendingInteractions).toBe(0);
        expect(
            server.requests
                .filter((request) =>
                    request.system?.startsWith("REVIEW_POLICY")
                )
                .map((request) => request.model)
        ).toEqual(["review-fast", "review-strong"]);
    });

    it("fails the tool after the user rejects", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write rejected" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs explicit approval")
                    : deny("still risky")
        );
        const running = await daemon(server);
        await postInbound(running, "write it", "r-1");
        const first = await waitForOutbound(running, 0, 15);
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        await postInbound(running, "拒绝", "r-2");
        const final = await waitForOutbound(running, promptSeq, 15);
        expect(final.items.some((item) => item.text === "write rejected")).toBe(
            true
        );
        const { access } = await import("node:fs/promises");
        await expect(
            access(join(running.home, "workspace/probe.txt"))
        ).rejects.toThrow();
    });

    it("allows without asking when strong review overturns fast", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write completed" },
            (_request, tier) =>
                tier === "fast" ? deny("fast was unsure") : allow()
        );
        const running = await daemon(server);
        await postInbound(running, "write it", "s-1");
        const items = await waitForOutbound(running, 0, 15);
        expect(
            items.items.some((item) => item.text === "write completed")
        ).toBe(true);
        expect(
            items.items.some(
                (item) =>
                    item.kind === "interaction" && item.text.includes("🔐")
            )
        ).toBe(false);
        const { readFile } = await import("node:fs/promises");
        await expect(
            readFile(join(running.home, "workspace/probe.txt"), "utf8")
        ).resolves.toBe("written\n");
    });

    it("fails closed when the reviewer returns invalid JSON", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write failed" },
            () => review("not-json")
        );
        const running = await daemon(server);
        await postInbound(running, "write it", "f-1");
        const items = await waitForOutbound(running, 0, 15);
        expect(items.items.some((item) => item.text === "write failed")).toBe(
            true
        );
        expect(
            items.items.some(
                (item) =>
                    item.kind === "interaction" && item.text.includes("🔐")
            )
        ).toBe(false);
        const { access } = await import("node:fs/promises");
        await expect(
            access(join(running.home, "workspace/probe.txt"))
        ).rejects.toThrow();
    });

    it("rejects automatically when approval times out", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write timed out" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs approval")
                    : deny("needs approval")
        );
        const running = await daemon(server, {
            NOKORIBI_APPROVAL_TIMEOUT_MS: "800",
        });
        await postInbound(running, "write it", "t-1");
        const first = await waitForOutbound(running, 0, 15);
        expect(
            first.items.some(
                (item) =>
                    item.kind === "interaction" && item.text.includes("🔐")
            )
        ).toBe(true);
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        const timedOut = await waitForOutbound(running, promptSeq, 15);
        expect(
            timedOut.items.some((item) => item.text.includes("审批超时"))
        ).toBe(true);
        const final = await waitForOutbound(
            running,
            timedOut.items.at(-1)?.seq ?? promptSeq,
            15
        );
        expect(
            final.items.some((item) => item.text === "write timed out")
        ).toBe(true);
        expect((await status(running)).pendingInteractions).toBe(0);
        const { access } = await import("node:fs/promises");
        await expect(
            access(join(running.home, "workspace/probe.txt"))
        ).rejects.toThrow();
    });

    it("asks a structured question and returns the selected answer", async () => {
        const server = await scripted((_request, index) =>
            index === 0
                ? {
                      kind: "tool-call",
                      name: "ask_user_question",
                      arguments: {
                          questions: [
                              {
                                  id: "q1",
                                  question: "Choose one",
                                  options: [
                                      { label: "Alpha" },
                                      { label: "Beta" },
                                  ],
                              },
                          ],
                      },
                  }
                : { kind: "text", text: "question answered" }
        );
        const running = await daemon(server);
        await postInbound(running, "ask me", "q-1");
        const first = await waitForOutbound(running, 0, 15);
        const prompt = first.items.find(
            (item) => item.kind === "interaction" && item.text.includes("❓")
        );
        expect(prompt?.text).toContain("1. Alpha");
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        await postInbound(running, "1", "q-2");
        const final = await waitForOutbound(running, promptSeq, 15);
        expect(
            final.items.some((item) => item.text === "question answered")
        ).toBe(true);
        expect((await status(running)).pendingInteractions).toBe(0);
    });

    it("lets /steer bypass an active approval and keeps it pending", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "write completed" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs approval")
                    : deny("needs approval")
        );
        const running = await daemon(server);
        await postInbound(running, "write it", "b-1");
        const first = await waitForOutbound(running, 0, 15);
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        await postInbound(running, "/steer focus", "b-2");
        const steered = await waitForOutbound(running, promptSeq, 10);
        expect(steered.items.some((item) => item.text === "已 steer")).toBe(
            true
        );
        expect((await status(running)).pendingInteractions).toBe(1);
        const steerSeq = steered.items.at(-1)?.seq ?? promptSeq;
        await postInbound(running, "允许", "b-3");
        const final = await waitForOutbound(running, steerSeq, 15);
        expect(
            final.items.some((item) => item.text === "write completed")
        ).toBe(true);
    });

    it("aborts an active approval with /stop", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0
                    ? writeCall()
                    : { kind: "text", text: "unexpected" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs approval")
                    : deny("needs approval")
        );
        const running = await daemon(server);
        await postInbound(running, "write it", "x-1");
        const first = await waitForOutbound(running, 0, 15);
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        await postInbound(running, "/stop", "x-2");
        const stopped = await waitForOutbound(running, promptSeq, 15);
        expect(stopped.items.some((item) => item.text === "已停止")).toBe(true);
        expect(
            stopped.items.some((item) =>
                item.text.includes("待审批/提问已中止")
            )
        ).toBe(true);
        expect((await status(running)).pendingInteractions).toBe(0);
    });

    it("aborts a pending approval when /clear creates a new session", async () => {
        const server = await scripted(
            (_request, index) =>
                index === 0 ? writeCall() : { kind: "text", text: "old turn" },
            (_request, tier) =>
                tier === "fast"
                    ? deny("needs approval")
                    : deny("needs approval")
        );
        const running = await daemon(server);
        const before = (await status(running)).mainSessionId;
        await postInbound(running, "write it", "c-1");
        const first = await waitForOutbound(running, 0, 15);
        const promptSeq = first.items.at(-1)?.seq ?? 0;
        await postInbound(running, "/clear", "c-2");
        const cleared = await waitForOutbound(running, promptSeq, 15);
        expect(
            cleared.items.some((item) =>
                item.text.includes("待审批/提问已随会话切换中止")
            )
        ).toBe(true);
        expect(
            cleared.items.some((item) => item.text.includes("已新建会话"))
        ).toBe(true);
        expect((await status(running)).pendingInteractions).toBe(0);
        expect((await status(running)).mainSessionId).not.toBe(before);
        const clearedSeq = cleared.items.at(-1)?.seq ?? promptSeq;
        await postInbound(running, "/permission", "c-3");
        const permission = await waitForOutbound(running, clearedSeq, 10);
        expect(permission.items[0]?.text).toContain("permission: auto");
        const { access } = await import("node:fs/promises");
        await expect(
            access(join(running.home, "workspace/probe.txt"))
        ).rejects.toThrow();
    });

    it("clears a stale interaction from the previous process", async () => {
        const home = await tempHome();
        homes.push(home);
        await appendPendingInteraction(home, "stale prompt", "i-stale");
        const server = await scripted(() => ({
            kind: "text",
            text: "unused",
        }));
        const running = await startDaemon({
            home,
            token: `m2-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: server.baseURL,
        });
        daemons.push(running);
        const items = await waitForOutbound(running, 0, 15);
        expect(
            items.items.some((item) => item.text.includes("待审批/提问"))
        ).toBe(true);
        const { readFile } = await import("node:fs/promises");
        const outbox = JSON.parse(
            await readFile(join(home, "state/outbox.json"), "utf8")
        ) as { items: { interactionId?: string; state: string }[] };
        expect(
            outbox.items.find((item) => item.interactionId === "i-stale")?.state
        ).toBe("failed");
        expect((await status(running)).pendingInteractions).toBe(0);
    });
});
