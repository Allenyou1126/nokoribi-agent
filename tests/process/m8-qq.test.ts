import {
    startMockLlmServer,
    type MockLlmServer,
} from "@deepseek-ai/dsh-llm-mock-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    cleanupHome,
    postInbound,
    startDaemon,
    status,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import { c2cEvent, FakeQqBot, groupAtEvent } from "./support/fake-qq-bot.js";

let mock: MockLlmServer;

beforeAll(async () => {
    mock = await startMockLlmServer({
        host: "127.0.0.1",
        port: 0,
        sequence: ["success"],
        repeatLast: true,
        successText: "pong from mock",
    });
});

afterAll(async () => {
    await mock.close();
});

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const fakes: FakeQqBot[] = [];

async function daemon(): Promise<{
    running: DaemonHandle;
    fake: FakeQqBot;
}> {
    const fake = await FakeQqBot.start({ heartbeatMs: 200 });
    fakes.push(fake);
    const home = await tempHome();
    homes.push(home);
    const running = await startDaemon({
        home,
        token: `tok-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: mock.baseURL,
        extraEnv: {
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
    return { running, fake };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeferred(
    running: DaemonHandle,
    count: number,
    timeoutMs = 15000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await status(running)).deferredNotices !== count) {
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for ${String(count)} deferred notices`
            );
        }
        await delay(25);
    }
}

async function waitForSendCount(
    fake: FakeQqBot,
    count: number,
    timeoutMs = 15000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (fake.outbound.length < count) {
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for ${String(count)} QQ sends; got ${String(
                    fake.outbound.length
                )}`
            );
        }
        await delay(25);
    }
}

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
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

describe("M8 QQ bot process scenarios", () => {
    it("answers a C2C message with a passive reply", async () => {
        const { running, fake } = await daemon();
        fake.pushC2C({ id: "c2c-1", userId: "user-1", content: "hello" });
        const send = await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-1/messages")
        );
        expect(send.body).toMatchObject({
            msg_id: "c2c-1",
            msg_seq: 1,
            msg_type: 2,
        });
        const markdown = send.body.markdown as { content?: string };
        expect(markdown.content).toContain("pong from mock");
        expect((await status(running)).ready).toBe(true);
    });

    it("answers a group @ mention and ignores group full messages", async () => {
        const { fake } = await daemon();
        const before = fake.outbound.length;
        fake.pushEvent(
            "GROUP_MESSAGE_CREATE",
            groupAtEvent({ id: "full-1", groupOpenid: "group-1" })
        );
        await delay(200);
        expect(fake.outbound.length).toBe(before);

        fake.pushGroupAt({
            id: "group-msg-1",
            groupOpenid: "group-1",
            memberOpenid: "member-1",
            content: "hello group",
        });
        const send = await fake.waitForSend((item) =>
            item.path.includes("/v2/groups/group-1/messages")
        );
        expect(send.body).toMatchObject({
            msg_id: "group-msg-1",
            msg_seq: 1,
        });
    });

    it("deduplicates repeated event ids across the channel", async () => {
        const { fake } = await daemon();
        const event = c2cEvent({ id: "dup-1", userId: "user-2" });
        fake.pushEvent("C2C_MESSAGE_CREATE", event);
        await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-2")
        );
        const count = fake.outbound.length;
        fake.pushEvent("C2C_MESSAGE_CREATE", event);
        await delay(300);
        expect(fake.outbound.length).toBe(count);
    });

    it("falls back to an active message when the passive window expired", async () => {
        const { fake } = await daemon();
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        fake.pushC2C({
            id: "old-1",
            userId: "user-3",
            content: "late",
            timestamp: old,
        });
        const send = await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-3")
        );
        expect(send.body.msg_id).toBeUndefined();
        expect(send.body.msg_seq).toBeUndefined();
    });

    it("defers a failed active reply and replays it on the next inbound", async () => {
        const { running, fake } = await daemon();
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        fake.failNextSend({ bizCode: 40034105 });
        fake.pushC2C({
            id: "active-fail-1",
            userId: "user-4",
            content: "late",
            timestamp: old,
        });
        await waitForDeferred(running, 1);
        fake.pushC2C({
            id: "active-fail-2",
            userId: "user-4",
            content: "again",
        });
        const replay = await fake.waitForSend((item) =>
            JSON.stringify(item.body).includes("补发")
        );
        expect(replay.body.msg_id).toBe("active-fail-2");
    });

    it("retries as active after a passive-expiry rejection", async () => {
        const { running, fake } = await daemon();
        fake.failNextSend({ bizCode: 40034128 });
        fake.pushC2C({ id: "expired-1", userId: "user-5" });
        try {
            await waitForSendCount(fake, 1);
        } catch (error) {
            process.stderr.write(running.output());
            throw error;
        }
        const send = fake.outbound[0];
        expect(send?.body.msg_id).toBeUndefined();
    });

    it("refreshes the token after a 401 and sends successfully", async () => {
        const { fake } = await daemon();
        fake.rejectNextSend();
        fake.pushC2C({ id: "token-1", userId: "user-6" });
        const send = await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-6")
        );
        expect(send.body.msg_id).toBe("token-1");
        expect(fake.tokenRequests.length).toBeGreaterThanOrEqual(2);
    });

    it("reconnects after a gateway drop and keeps receiving", async () => {
        const { running, fake } = await daemon();
        fake.pushC2C({ id: "reconnect-1", userId: "user-7" });
        await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-7")
        );
        fake.dropConnection(1000);
        await fake.waitForResume();
        fake.pushC2C({ id: "reconnect-2", userId: "user-7" });
        await waitForSendCount(fake, 2);
        expect((await status(running)).ready).toBe(true);
    });

    it("exits cleanly on SIGTERM without leaking the client secret", async () => {
        const { running } = await daemon();
        const exitCode = await running.stop();
        expect(exitCode).toBe(0);
        expect(running.output()).not.toContain("qq-secret");
    });

    it("routes local-test inbound to local-test and QQ inbound to QQ", async () => {
        const { running, fake } = await daemon();
        expect(
            (await postInbound(running, "local hello", "local-1")).status
        ).toBe(202);
        const local = await waitForOutbound(running, 0);
        expect(local.items[0]).toMatchObject({
            kind: "reply",
            text: "pong from mock",
        });
        const before = fake.outbound.length;
        fake.pushC2C({ id: "dual-1", userId: "user-8" });
        const send = await fake.waitForSend((item) =>
            item.path.includes("/v2/users/user-8")
        );
        expect(send.body.msg_id).toBe("dual-1");
        expect(fake.outbound.length).toBe(before + 1);
    });
});
