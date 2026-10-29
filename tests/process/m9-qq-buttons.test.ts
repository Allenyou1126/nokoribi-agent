import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    startDaemon,
    status,
    tempHome,
    type DaemonHandle,
    type Status,
} from "./harness.js";
import { FakeQqBot, type FakeQqSend } from "./support/fake-qq-bot.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

interface KeyboardButton {
    readonly id: string;
    readonly action: { readonly data: string };
}

function keyboardButtons(body: Record<string, unknown>): KeyboardButton[] {
    const keyboard = body.keyboard as
        | {
              content: {
                  rows: { buttons: KeyboardButton[] }[];
              };
          }
        | undefined;
    return keyboard?.content.rows.flatMap((row) => row.buttons) ?? [];
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

function deny(reason: string): ScriptedResponse {
    return {
        kind: "text",
        text: JSON.stringify({ risk: "medium", decision: "deny", reason }),
    };
}

interface Scenario {
    readonly running: DaemonHandle;
    readonly fake: FakeQqBot;
    readonly llm: ScriptedLlmServer;
    readonly home: string;
}

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const fakes: FakeQqBot[] = [];
const servers: ScriptedLlmServer[] = [];

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(
        fakes.splice(0).map(async (fake) => {
            await fake.close().catch(() => undefined);
        })
    );
    await Promise.all(
        servers.splice(0).map(async (server) => {
            await server.close().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

async function startScenario(
    options: {
        readonly home?: string;
        readonly fake?: FakeQqBot;
        readonly llm?: ScriptedLlmServer;
        readonly rejectInteractionIntent?: number;
        readonly finalText?: string;
    } = {}
): Promise<Scenario> {
    const fake =
        options.fake ??
        (await FakeQqBot.start({
            heartbeatMs: 200,
            ...(options.rejectInteractionIntent === undefined
                ? {}
                : { rejectInteractionIntent: options.rejectInteractionIntent }),
        }));
    if (options.fake === undefined) fakes.push(fake);
    const llm =
        options.llm ??
        (await startScriptedLlm({
            main: (_request, index) =>
                index === 0
                    ? writeCall()
                    : {
                          kind: "text",
                          text: options.finalText ?? "write completed",
                      },
            review: (_request, tier) =>
                deny(
                    tier === "fast" ? "needs approval" : "still needs approval"
                ),
        }));
    if (options.llm === undefined) servers.push(llm);
    const home = options.home ?? (await tempHome());
    if (options.home === undefined) homes.push(home);
    const running = await startDaemon({
        home,
        token: `m9-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: llm.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_REVIEW_FAST_MODEL: "review-fast",
            NOKORIBI_REVIEW_STRONG_MODEL: "review-strong",
            NOKORIBI_QQ_BOT_ENABLED: "true",
            NOKORIBI_QQ_BOT_APP_ID: "app-1",
            NOKORIBI_QQ_BOT_CLIENT_SECRET: "qq-secret",
            NOKORIBI_QQ_BOT_API_BASE: fake.apiUrl,
            NOKORIBI_QQ_BOT_TOKEN_BASE: fake.apiUrl,
            NOKORIBI_QQ_BOT_GATEWAY_URL: fake.wsUrl,
            NOKORIBI_QQ_BOT_REQUEST_TIMEOUT_MS: "2000",
            NOKORIBI_QQ_BOT_CONNECT_TIMEOUT_MS: "3000",
            NOKORIBI_QQ_BOT_RECONNECT_BASE_MS: "50",
            NOKORIBI_QQ_BOT_RECONNECT_MAX_MS: "100",
            NOKORIBI_QQ_BOT_MAX_REPLIES: "4",
        },
    });
    daemons.push(running);
    await fake.waitForIdentify();
    return { running, fake, llm, home };
}

async function waitForKeyboardPrompt(
    fake: FakeQqBot,
    timeoutMs = 15000
): Promise<FakeQqSend> {
    return await fake.waitForSend(
        (send) =>
            send.body.keyboard !== undefined &&
            keyboardButtons(send.body).length === 2,
        timeoutMs
    );
}

async function waitForText(
    fake: FakeQqBot,
    text: string,
    timeoutMs = 15000
): Promise<void> {
    await fake.waitForSend(
        (send) => JSON.stringify(send.body).includes(text),
        timeoutMs
    );
}

async function waitForFile(path: string, content: string): Promise<void> {
    const deadline = Date.now() + 15000;
    for (;;) {
        try {
            expect(await readFile(path, "utf8")).toBe(content);
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function waitForChannelDetail(
    running: DaemonHandle,
    text: string,
    timeoutMs = 15000
): Promise<Status> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const current = await status(running);
        const channel = (
            current.channels as { id: string; detail?: string }[] | undefined
        )?.find((entry) => entry.id === "qq-bot");
        if (channel?.detail?.includes(text) === true) return current;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for channel detail ${text}; got ${JSON.stringify(
                    current.channels
                )}`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("M9 QQ button approval process scenarios", () => {
    it("executes once after a C2C allow click without a confirmation message", async () => {
        const scenario = await startScenario();
        scenario.fake.pushC2C({
            id: "c2c-1",
            userId: "user-1",
            content: "write it",
        });
        const prompt = await waitForKeyboardPrompt(scenario.fake);
        const allow = keyboardButtons(prompt.body)[0];
        expect(allow).toBeDefined();
        scenario.fake.pushInteraction({
            id: "interaction-allow-1",
            userId: "user-1",
            buttonData: allow?.action.data ?? "",
            buttonId: allow?.id ?? "",
        });
        const ack = await scenario.fake.waitForInteractionAck(
            "interaction-allow-1"
        );
        expect(ack.code).toBe(0);
        await waitForFile(
            join(scenario.home, "workspace/probe.txt"),
            "written\n"
        );
        await waitForText(scenario.fake, "write completed");
        expect(
            scenario.fake.outbound.some((send) =>
                JSON.stringify(send.body).includes("已允许")
            )
        ).toBe(false);
        expect(
            scenario.fake.outbound.some((send) =>
                JSON.stringify(send.body).includes("已拒绝")
            )
        ).toBe(false);
    });

    it("fails the tool after a C2C deny click", async () => {
        const scenario = await startScenario({ finalText: "write rejected" });
        scenario.fake.pushC2C({
            id: "c2c-deny-1",
            userId: "user-2",
            content: "write it",
        });
        const prompt = await waitForKeyboardPrompt(scenario.fake);
        const denyButton = keyboardButtons(prompt.body)[1];
        expect(denyButton).toBeDefined();
        scenario.fake.pushInteraction({
            id: "interaction-deny-1",
            userId: "user-2",
            buttonData: denyButton?.action.data ?? "",
            buttonId: denyButton?.id ?? "",
        });
        expect(
            (await scenario.fake.waitForInteractionAck("interaction-deny-1"))
                .code
        ).toBe(0);
        await waitForText(scenario.fake, "write rejected");
        expect(
            await fileExists(join(scenario.home, "workspace/probe.txt"))
        ).toBe(false);
    });

    it("still allows a plain C2C text reply", async () => {
        const scenario = await startScenario();
        scenario.fake.pushC2C({
            id: "c2c-text-1",
            userId: "user-3",
            content: "write it",
        });
        await waitForKeyboardPrompt(scenario.fake);
        scenario.fake.pushC2C({
            id: "c2c-text-2",
            userId: "user-3",
            content: "允许",
        });
        await waitForFile(
            join(scenario.home, "workspace/probe.txt"),
            "written\n"
        );
    });

    it("expires old buttons after a daemon restart", async () => {
        const first = await startScenario();
        first.fake.pushC2C({
            id: "c2c-restart-1",
            userId: "user-4",
            content: "write it",
        });
        const prompt = await waitForKeyboardPrompt(first.fake);
        const allow = keyboardButtons(prompt.body)[0];
        expect(allow).toBeDefined();
        const firstHome = first.home;
        const fake = first.fake;
        const llm = first.llm;
        await first.running.stop();

        const second = await startScenario({
            home: firstHome,
            fake,
            llm,
        });
        await fake.waitForIdentifyCount(2);
        fake.pushInteraction({
            id: "interaction-restart-1",
            userId: "user-4",
            buttonData: allow?.action.data ?? "",
            buttonId: allow?.id ?? "",
        });
        expect(
            (await fake.waitForInteractionAck("interaction-restart-1")).code
        ).toBe(0);
        await waitForText(fake, "按钮已失效");
        expect(await fileExists(join(second.home, "workspace/probe.txt"))).toBe(
            false
        );
    });

    it("keeps group approvals textual and accepts a numbered reply", async () => {
        const scenario = await startScenario();
        scenario.fake.pushGroupAt({
            id: "group-1",
            groupOpenid: "group-1",
            memberOpenid: "member-1",
            content: "write it",
        });
        const prompt = await scenario.fake.waitForSend(
            (send) =>
                send.path.includes("/v2/groups/group-1/messages") &&
                send.body.keyboard === undefined
        );
        expect(prompt.body.keyboard).toBeUndefined();
        scenario.fake.pushGroupAt({
            id: "group-2",
            groupOpenid: "group-1",
            memberOpenid: "member-1",
            content: "1",
        });
        await waitForFile(
            join(scenario.home, "workspace/probe.txt"),
            "written\n"
        );
    });

    it("degrades to text approvals when the interaction intent is rejected", async () => {
        const scenario = await startScenario({ rejectInteractionIntent: 4014 });
        await scenario.fake.waitForIdentifyCount(2);
        const identify = scenario.fake.identifyRequests.at(-1);
        expect((identify?.intents as number | undefined) ?? 0).toBe(1 << 25);
        await waitForChannelDetail(
            scenario.running,
            "interaction-intent-unavailable"
        );
        scenario.fake.pushC2C({
            id: "c2c-degraded-1",
            userId: "user-5",
            content: "write it",
        });
        const prompt = await scenario.fake.waitForSend(
            (send) => send.body.keyboard === undefined,
            15000
        );
        expect(prompt.body.keyboard).toBeUndefined();
        scenario.fake.pushC2C({
            id: "c2c-degraded-2",
            userId: "user-5",
            content: "允许",
        });
        await waitForFile(
            join(scenario.home, "workspace/probe.txt"),
            "written\n"
        );
    });
});
