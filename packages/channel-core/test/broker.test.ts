import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { createLogger, type OutboundAction } from "@nokoribi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InteractionBroker } from "../src/broker.js";

interface Prompt {
    readonly text: string;
    readonly interactionId: string;
    readonly actions?: readonly OutboundAction[];
    readonly actionKind?: "approval" | "question";
}

function fakeAgent(id = "main-1", origin?: "subagent"): Agent {
    return {
        id,
        session: {
            header: {
                ...(origin === undefined ? {} : { origin }),
                ...(origin === "subagent" ? { parentSession: "parent-1" } : {}),
            },
            snapshotEvents: () => [],
        },
    } as unknown as Agent;
}

function approval(
    agent: Agent = fakeAgent(),
    signal?: AbortSignal
): ApprovalRequest {
    return {
        agent,
        toolName: "write",
        reason: "Auto review denied this call: irreversible",
        ...(signal === undefined ? {} : { signal }),
    } as ApprovalRequest;
}

function question(
    agent: Agent = fakeAgent(),
    signal?: AbortSignal
): AskUserQuestionRequest {
    return {
        agent,
        questions: [
            {
                id: "q1",
                header: "Choose",
                question: "Which option?",
                options: [
                    { label: "Alpha", description: "first" },
                    { label: "Beta" },
                ],
            },
            {
                id: "q2",
                question: "Pick several",
                multiSelect: true,
                options: [
                    { label: "One" },
                    { label: "Two" },
                    { label: "Three" },
                ],
            },
        ],
        ...(signal === undefined ? {} : { signal }),
    } as AskUserQuestionRequest;
}

function questionRequest(
    questions: readonly {
        readonly id: string;
        readonly question: string;
        readonly multiSelect?: boolean;
        readonly options?: readonly { readonly label: string }[];
    }[]
): AskUserQuestionRequest {
    return {
        agent: fakeAgent(),
        questions: [...questions],
    } as unknown as AskUserQuestionRequest;
}

interface Fixture {
    readonly broker: InteractionBroker;
    readonly prompts: Prompt[];
    readonly notices: string[];
    readonly terminal: string[];
    failPrompt?: Error;
}

function fixture(
    overrides: Partial<{
        approvalTimeoutMs: number;
        questionTimeoutMs: number;
        failPrompt: Error;
    }> = {}
): Fixture {
    const prompts: Prompt[] = [];
    const notices: string[] = [];
    const terminal: string[] = [];
    const fixtureValue: Fixture = {
        broker: undefined as unknown as InteractionBroker,
        prompts,
        notices,
        terminal,
    };
    const broker = new InteractionBroker({
        approvalTimeoutMs: overrides.approvalTimeoutMs ?? 60_000,
        questionTimeoutMs: overrides.questionTimeoutMs ?? 300_000,
        logger: createLogger("broker-test", () => undefined),
        sendPrompt: async (input) => {
            if (overrides.failPrompt !== undefined) {
                throw overrides.failPrompt;
            }
            prompts.push(input);
        },
        sendNotice: async (text) => {
            notices.push(text);
        },
        onTerminal: (id) => {
            terminal.push(id);
        },
    });
    (fixtureValue as { broker: InteractionBroker }).broker = broker;
    return fixtureValue;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function promptActions(prompt: Prompt | undefined): readonly OutboundAction[] {
    expect(prompt?.actions).toBeDefined();
    return prompt?.actions ?? [];
}

function actionByLabel(
    prompt: Prompt | undefined,
    label: string
): OutboundAction {
    const action = promptActions(prompt).find((entry) => entry.label === label);
    expect(action).toBeDefined();
    return action as OutboundAction;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("InteractionBroker approvals", () => {
    it("prompts once and accepts allow", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        expect(fx.broker.pendingCount).toBe(1);
        expect(fx.prompts[0]?.text).toContain("🔐 审批（主会话）");
        expect(fx.prompts[0]?.text).toContain("工具：write");
        expect(fx.prompts[0]?.text).toContain("允许 / 拒绝");
        await expect(fx.broker.handleReply("允许")).resolves.toBe(true);
        await expect(pending).resolves.toBe("allowed-once");
        expect(fx.broker.pendingCount).toBe(0);
        expect(fx.terminal).toHaveLength(1);
    });

    it("accepts reject and numeric replies", async () => {
        const first = fixture();
        const firstPending = first.broker.requestApproval(approval());
        await flush();
        await first.broker.handleReply("2");
        await expect(firstPending).resolves.toBe("rejected");

        const second = fixture();
        const secondPending = second.broker.requestApproval(approval());
        await flush();
        await second.broker.handleReply("deny");
        await expect(secondPending).resolves.toBe("rejected");
    });

    it("reprompts invalid replies without resetting the deadline", async () => {
        vi.useFakeTimers();
        const fx = fixture({ approvalTimeoutMs: 1000 });
        const pending = fx.broker.requestApproval(approval());
        await vi.advanceTimersByTimeAsync(0);
        expect(fx.prompts).toHaveLength(1);
        await fx.broker.handleReply("maybe");
        expect(fx.prompts).toHaveLength(2);
        expect(fx.prompts[1]?.text).toContain("无效回复");
        await vi.advanceTimersByTimeAsync(400);
        expect(fx.broker.pendingCount).toBe(1);
        await vi.advanceTimersByTimeAsync(700);
        await expect(pending).resolves.toBe("rejected");
        expect(fx.notices).toContain("审批超时，已拒绝。");
    });

    it("rejects on approval timeout", async () => {
        vi.useFakeTimers();
        const fx = fixture({ approvalTimeoutMs: 500 });
        const pending = fx.broker.requestApproval(approval());
        await vi.advanceTimersByTimeAsync(200);
        expect(fx.broker.pendingCount).toBe(1);
        await vi.advanceTimersByTimeAsync(400);
        await expect(pending).resolves.toBe("rejected");
        expect(fx.notices).toContain("审批超时，已拒绝。");
        expect(fx.broker.pendingCount).toBe(0);
    });

    it("cancels on abort signal and abortAll", async () => {
        const controller = new AbortController();
        const fx = fixture();
        const pending = fx.broker.requestApproval(
            approval(fakeAgent(), controller.signal)
        );
        await flush();
        controller.abort();
        await expect(pending).resolves.toBe("cancelled");

        const second = fixture();
        const secondPending = second.broker.requestApproval(approval());
        await flush();
        await second.broker.abortAll("user-stop", true);
        await expect(secondPending).resolves.toBe("cancelled");
        expect(second.notices).toEqual(["待审批/提问已中止。"]);
    });

    it("fails closed when the prompt cannot be sent", async () => {
        const fx = fixture({ failPrompt: new Error("no channel") });
        const pending = fx.broker.requestApproval(approval());
        await expect(pending).resolves.toBe("unavailable");
    });

    it("serializes multiple requests in FIFO order", async () => {
        const fx = fixture();
        const first = fx.broker.requestApproval(approval());
        const second = fx.broker.requestApproval(approval());
        await flush();
        expect(fx.prompts).toHaveLength(1);
        expect(fx.broker.pendingCount).toBe(2);
        await fx.broker.handleReply("允许");
        await expect(first).resolves.toBe("allowed-once");
        await flush();
        expect(fx.prompts).toHaveLength(2);
        await fx.broker.handleReply("拒绝");
        await expect(second).resolves.toBe("rejected");
    });

    it("labels child approvals with the goal short id", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(
            approval(fakeAgent("goal-a1b2c3d4-child", "subagent"))
        );
        await flush();
        expect(fx.prompts[0]?.text).toContain("🔐 审批（goal a1b2c3d4）");
        await fx.broker.handleReply("允许");
        await expect(pending).resolves.toBe("allowed-once");
    });

    it("generates two callback actions for an approval prompt", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        const actions = promptActions(fx.prompts[0]);
        expect(actions).toHaveLength(2);
        expect(actions.map((action) => action.label)).toEqual([
            "允许一次",
            "拒绝",
        ]);
        expect(actions.map((action) => action.kind)).toEqual([
            "callback",
            "callback",
        ]);
        expect(actions.map((action) => action.style)).toEqual([
            "primary",
            "danger",
        ]);
        expect(new Set(actions.map((action) => action.id)).size).toBe(2);
        for (const action of actions) {
            expect(action.id.length).toBeGreaterThan(10);
            const payload = JSON.parse(action.payload ?? "") as {
                k?: string;
                t?: string;
            };
            expect(payload.k).toBe(action.id);
            expect(payload.t).toBe(action.label);
        }
        await fx.broker.handleReply("拒绝");
        await expect(pending).resolves.toBe("rejected");
    });

    it("settles an approval from an action token", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        const allow = actionByLabel(fx.prompts[0], "允许一次");
        await expect(
            fx.broker.handleAction({
                id: allow.id,
                payload: allow.payload,
            })
        ).resolves.toBe(true);
        await expect(pending).resolves.toBe("allowed-once");
        expect(fx.broker.pendingCount).toBe(0);
        expect(fx.terminal).toHaveLength(1);
    });

    it("generates buttons only for single-select questions", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion(question());
        await flush();
        expect(fx.prompts[0]?.actionKind).toBe("question");
        expect(fx.prompts[0]?.actions).toHaveLength(2);
        await fx.broker.handleReply("1");
        await flush();
        // The second question is multi-select, so its text fallback has no
        // buttons and the first question's tokens are gone.
        expect(fx.prompts[1]?.actions).toBeUndefined();
        expect(fx.prompts[1]?.actionKind).toBeUndefined();
        await fx.broker.handleReply("1,3");
        await expect(pending).resolves.toEqual({
            answers: [
                { id: "q1", selected: ["Alpha"] },
                { id: "q2", selected: ["One", "Three"] },
            ],
        });
        await expect(
            fx.broker.handleAction({
                id: fx.prompts[0]?.actions?.[0]?.id ?? "",
            })
        ).resolves.toBe(false);
    });

    it("rejects unknown, malformed and repeated actions without guessing", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        const allow = actionByLabel(fx.prompts[0], "允许一次");
        await expect(fx.broker.handleAction({ id: "unknown" })).resolves.toBe(
            false
        );
        await expect(
            fx.broker.handleAction({
                id: "unknown",
                payload: JSON.stringify({ t: "允许" }),
            })
        ).resolves.toBe(false);
        expect(fx.broker.pendingCount).toBe(1);
        await expect(
            fx.broker.handleAction({ id: allow.id, payload: allow.payload })
        ).resolves.toBe(true);
        await expect(pending).resolves.toBe("allowed-once");
        await expect(
            fx.broker.handleAction({ id: allow.id, payload: allow.payload })
        ).resolves.toBe(false);
    });

    it("falls back to the action id when payload is missing or invalid", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        const deny = actionByLabel(fx.prompts[0], "拒绝");
        await expect(
            fx.broker.handleAction({
                id: deny.id,
                payload: "not-json",
            })
        ).resolves.toBe(true);
        await expect(pending).resolves.toBe("rejected");
    });

    it("reuses approval actions on reprompt", async () => {
        const fx = fixture();
        const pending = fx.broker.requestApproval(approval());
        await flush();
        const first = fx.prompts[0]?.actions;
        await fx.broker.handleReply("maybe");
        expect(fx.prompts).toHaveLength(2);
        expect(fx.prompts[1]?.actions).toEqual(first);
        await fx.broker.handleReply("允许");
        await expect(pending).resolves.toBe("allowed-once");
    });

    it("cleans action tokens after timeout and abort", async () => {
        vi.useFakeTimers();
        const timeoutFx = fixture({ approvalTimeoutMs: 100 });
        const timedOut = timeoutFx.broker.requestApproval(approval());
        await vi.advanceTimersByTimeAsync(150);
        await expect(timedOut).resolves.toBe("rejected");
        const timeoutAction = actionByLabel(timeoutFx.prompts[0], "允许一次");
        await expect(
            timeoutFx.broker.handleAction({
                id: timeoutAction.id,
                payload: timeoutAction.payload,
            })
        ).resolves.toBe(false);

        vi.useRealTimers();
        const abortFx = fixture();
        const controller = new AbortController();
        const aborted = abortFx.broker.requestApproval(
            approval(fakeAgent(), controller.signal)
        );
        await flush();
        const abortAction = actionByLabel(abortFx.prompts[0], "允许一次");
        controller.abort();
        await expect(aborted).resolves.toBe("cancelled");
        await expect(
            abortFx.broker.handleAction({
                id: abortAction.id,
                payload: abortAction.payload,
            })
        ).resolves.toBe(false);
    });
});

describe("InteractionBroker questions", () => {
    it("asks questions one at a time and returns the batch", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion(question());
        await flush();
        expect(fx.prompts[0]?.text).toContain("❓ 提问（主会话）(1/2)");
        expect(fx.prompts[0]?.text).toContain("1. Alpha — first");
        await fx.broker.handleReply("1");
        await flush();
        expect(fx.prompts[1]?.text).toContain("(2/2)");
        expect(fx.prompts[1]?.text).toContain("多选可用 1,3");
        await fx.broker.handleReply("1,3");
        await expect(pending).resolves.toEqual({
            answers: [
                { id: "q1", selected: ["Alpha"] },
                { id: "q2", selected: ["One", "Three"] },
            ],
        });
    });

    it("accepts custom text and labels", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion({
            agent: fakeAgent(),
            questions: [
                {
                    id: "q1",
                    question: "Name it",
                    options: [{ label: "Alpha" }],
                },
            ],
        } as AskUserQuestionRequest);
        await flush();
        await fx.broker.handleReply("something else");
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: [], custom: "something else" }],
        });
    });

    it("fails the tool on question timeout", async () => {
        vi.useFakeTimers();
        const fx = fixture({ questionTimeoutMs: 500 });
        const pending = fx.broker.requestQuestion(question());
        const expectation = expect(pending).rejects.toMatchObject({
            code: "ASK_ABORTED",
        });
        await vi.advanceTimersByTimeAsync(600);
        await expectation;
        expect(fx.notices).toContain("提问超时，已取消。");
    });

    it("fails closed when the question prompt cannot be sent", async () => {
        const fx = fixture({ failPrompt: new Error("no channel") });
        const pending = fx.broker.requestQuestion(question());
        await expect(pending).rejects.toMatchObject({ code: "ASK_ABORTED" });
    });

    it("settles a question from an option button click", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion(
            questionRequest([
                {
                    id: "q1",
                    question: "Which option?",
                    options: [{ label: "Alpha" }, { label: "Beta" }],
                },
            ])
        );
        await flush();
        const actions = promptActions(fx.prompts[0]);
        expect(actions).toHaveLength(2);
        expect(actions[0]).toMatchObject({
            label: "Alpha",
            kind: "callback",
            style: "default",
        });
        const beta = actionByLabel(fx.prompts[0], "Beta");
        await expect(
            fx.broker.handleAction({ id: beta.id, payload: beta.payload })
        ).resolves.toBe(true);
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: ["Beta"] }],
        });
        expect(fx.broker.pendingCount).toBe(0);
        await expect(
            fx.broker.handleAction({ id: beta.id, payload: beta.payload })
        ).resolves.toBe(false);
    });

    it("keeps text fallback for multi-select, optionless and over-cap questions", async () => {
        const overCap = Array.from({ length: 11 }, (_value, index) => ({
            label: `Option ${String(index + 1)}`,
        }));
        for (const questions of [
            [
                {
                    id: "q1",
                    question: "Pick several",
                    multiSelect: true,
                    options: [{ label: "One" }, { label: "Two" }],
                },
            ],
            [{ id: "q1", question: "Free text?" }],
            [{ id: "q1", question: "Too many?", options: overCap }],
        ]) {
            const fx = fixture();
            const pending = fx.broker.requestQuestion(
                questionRequest(questions)
            );
            await flush();
            expect(fx.prompts[0]?.actions).toBeUndefined();
            expect(fx.prompts[0]?.text).toContain("❓ 提问");
            await expect(fx.broker.handleReply("whatever")).resolves.toBe(true);
            await expect(pending).resolves.toMatchObject({
                answers: [{ id: "q1", selected: [] }],
            });
        }
    });

    it("truncates long option labels to the keyboard limit", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion(
            questionRequest([
                {
                    id: "q1",
                    question: "Pick",
                    options: [
                        { label: "这是一个非常非常长的选项标签" },
                        { label: "Short" },
                    ],
                },
            ])
        );
        await flush();
        const actions = promptActions(fx.prompts[0]);
        const longLabel = actions[0]?.label ?? "";
        expect(Array.from(longLabel)).toHaveLength(10);
        expect(longLabel.endsWith("…")).toBe(true);
        const payload = JSON.parse(actions[0]?.payload ?? "{}") as Record<
            string,
            unknown
        >;
        expect(payload["t"]).toBe(longLabel);
        await fx.broker.handleAction({
            id: actions[0]?.id ?? "",
            payload: actions[0]?.payload,
        });
        await expect(pending).resolves.toEqual({
            answers: [{ id: "q1", selected: ["这是一个非常非常长的选项标签"] }],
        });
    });

    it("scopes question clicks to the current question", async () => {
        const fx = fixture();
        const pending = fx.broker.requestQuestion(question());
        await flush();
        const alpha = actionByLabel(fx.prompts[0], "Alpha");
        await fx.broker.handleAction({ id: alpha.id, payload: alpha.payload });
        expect(fx.prompts[1]?.text).toContain("(2/2)");
        expect(fx.prompts[1]?.actions).toBeUndefined();
        // The first question's token is stale once the batch advanced.
        await expect(
            fx.broker.handleAction({ id: alpha.id, payload: alpha.payload })
        ).resolves.toBe(false);
        await fx.broker.handleReply("1,3");
        await expect(pending).resolves.toEqual({
            answers: [
                { id: "q1", selected: ["Alpha"] },
                { id: "q2", selected: ["One", "Three"] },
            ],
        });
    });

    it("cleans question action tokens after timeout", async () => {
        vi.useFakeTimers();
        const fx = fixture({ questionTimeoutMs: 100 });
        const pending = fx.broker.requestQuestion(
            questionRequest([
                {
                    id: "q1",
                    question: "Pick",
                    options: [{ label: "Alpha" }, { label: "Beta" }],
                },
            ])
        );
        const failure = expect(pending).rejects.toMatchObject({
            code: "ASK_ABORTED",
        });
        await vi.advanceTimersByTimeAsync(150);
        await failure;
        const alpha = actionByLabel(fx.prompts[0], "Alpha");
        await expect(
            fx.broker.handleAction({ id: alpha.id, payload: alpha.payload })
        ).resolves.toBe(false);
    });
});
