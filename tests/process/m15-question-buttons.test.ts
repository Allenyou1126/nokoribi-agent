import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    startDaemon,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
} from "./support/scripted-llm.js";

interface OutboundActionJson {
    readonly id: string;
    readonly label: string;
    readonly payload?: string;
}

interface OutboundItem {
    readonly seq: number;
    readonly kind: string;
    readonly text: string;
    readonly actions?: readonly OutboundActionJson[];
}

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(
        servers.splice(0).map(async (server) => {
            await server.close().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

interface Scenario {
    readonly running: DaemonHandle;
    readonly llm: ScriptedLlmServer;
}

async function startScenario(): Promise<Scenario> {
    const llm = await startScriptedLlm({
        main: (_request, index) =>
            index === 0
                ? {
                      kind: "tool-call",
                      name: "ask_user_question",
                      arguments: {
                          questions: [
                              {
                                  id: "q1",
                                  question: "Which option?",
                                  options: [
                                      { label: "Alpha" },
                                      { label: "Beta" },
                                  ],
                              },
                          ],
                      },
                  }
                : { kind: "text", text: "question answered" },
    });
    servers.push(llm);
    const home = await tempHome();
    homes.push(home);
    const running = await startDaemon({
        home,
        token: `m15-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: llm.baseURL,
        extraEnv: { NOKORIBI_MODEL: "main-model" },
    });
    daemons.push(running);
    return { running, llm };
}

async function postInbound(
    running: DaemonHandle,
    body: Record<string, unknown>
): Promise<Response> {
    return await fetch(`http://127.0.0.1:${running.port}/v1/inbound`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${running.token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

async function outbound(
    running: DaemonHandle,
    after: number,
    timeoutSeconds = 10
): Promise<{ items: OutboundItem[]; nextSeq: number }> {
    return (await waitForOutbound(
        running,
        after,
        timeoutSeconds
    )) as unknown as { items: OutboundItem[]; nextSeq: number };
}

async function waitForQuestionPrompt(
    running: DaemonHandle,
    after: number
): Promise<OutboundItem> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const result = await outbound(running, after, 1);
        const prompt = result.items.find(
            (item) =>
                item.kind === "interaction" &&
                item.actions !== undefined &&
                item.actions.length > 0
        );
        if (prompt !== undefined) return prompt;
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for question prompt actions");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function waitForReply(
    running: DaemonHandle,
    after: number
): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const result = await outbound(running, after, 1);
        if (result.items.some((item) => item.text === "question answered")) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for question answer reply");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe("M15 question button process scenarios", () => {
    it("answers ask_user_question from an action callback", async () => {
        const scenario = await startScenario();
        expect(
            (
                await postInbound(scenario.running, {
                    messageId: "ask-1",
                    text: "ask me",
                })
            ).status
        ).toBe(202);
        const prompt = await waitForQuestionPrompt(scenario.running, 0);
        const actions = prompt.actions ?? [];
        expect(actions.map((action) => action.label)).toEqual([
            "Alpha",
            "Beta",
        ]);
        const beta = actions[1];
        expect(beta).toBeDefined();
        expect(
            (
                await postInbound(scenario.running, {
                    messageId: "question-click-1",
                    action: {
                        id: beta?.id ?? "",
                        ...(beta?.payload === undefined
                            ? {}
                            : { payload: beta.payload }),
                    },
                })
            ).status
        ).toBe(202);
        await waitForReply(scenario.running, prompt.seq);
        const requests = JSON.stringify(scenario.llm.requests);
        expect(requests).toContain("Beta");
    });

    it("still accepts a numbered text answer", async () => {
        const scenario = await startScenario();
        expect(
            (
                await postInbound(scenario.running, {
                    messageId: "ask-2",
                    text: "ask me",
                })
            ).status
        ).toBe(202);
        const prompt = await waitForQuestionPrompt(scenario.running, 0);
        expect(
            (
                await postInbound(scenario.running, {
                    messageId: "question-text-1",
                    text: "2",
                })
            ).status
        ).toBe(202);
        await waitForReply(scenario.running, prompt.seq);
        const requests = JSON.stringify(scenario.llm.requests);
        expect(requests).toContain("Beta");
    });
});
