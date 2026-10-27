import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
    type ChannelHealth,
    type InboundMessage,
    type OutboundContent,
} from "@nokoribi/channel-core";
import { createLogger } from "@nokoribi/shared";
import type {
    InboundMessage as SdkInboundMessage,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { describe, expect, it } from "vitest";

import type { QqBotConfig } from "../src/config.js";
import { QqBotDriver } from "../src/driver.js";
import { SendLimiter } from "../src/limiter.js";
import type { QqGatewayClient, QqRestClient } from "../src/transport.js";

interface SentRequest {
    readonly scope: "c2c" | "group";
    readonly targetId: string;
    readonly body: Record<string, unknown>;
}

class FakeRest implements QqRestClient {
    readonly requests: SentRequest[] = [];
    readonly errors: unknown[] = [];

    async send(
        scope: "c2c" | "group",
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse> {
        this.requests.push({ scope, targetId, body });
        const error = this.errors.shift();
        if (error !== undefined) throw error;
        return {
            id: `sent-${String(this.requests.length)}`,
            timestamp: 0,
        };
    }

    async getGatewayUrl(): Promise<string> {
        return "ws://127.0.0.1/websocket";
    }

    async getAccessToken(): Promise<string> {
        return "token";
    }

    clearTokenCache(): void {}

    stop(): void {}
}

class FakeGateway implements QqGatewayClient {
    handler: ((message: SdkInboundMessage) => void) | undefined;
    state: ChannelHealth["state"] = "online";

    async start(
        onInbound: (message: SdkInboundMessage) => void
    ): Promise<void> {
        this.handler = onInbound;
    }

    async stop(): Promise<void> {
        this.state = "offline";
    }

    health(): ChannelHealth {
        return { state: this.state };
    }
}

function baseConfig(overrides: Partial<QqBotConfig> = {}): QqBotConfig {
    return {
        enabled: true,
        appId: "app",
        clientSecretEnv: "SECRET",
        markdown: "basic",
        maxTextLength: 4500,
        maxRepliesPerReply: 4,
        c2cReplyWindowSeconds: 3600,
        groupReplyWindowSeconds: 300,
        requestTimeoutMs: 1000,
        connectTimeoutMs: 1000,
        activeMessageFallback: "auto",
        reconnectBaseMs: 100,
        reconnectMaxMs: 1000,
        activeMessageDisableMs: 1000,
        replyWindowMarginMs: 0,
        ...overrides,
    };
}

function apiError(bizCode: number): unknown {
    return { name: "ApiError", httpStatus: 200, bizCode };
}

function sdkMessage(
    overrides: Partial<SdkInboundMessage> = {}
): SdkInboundMessage {
    return {
        rawEventType: "C2C_MESSAGE_CREATE",
        kind: "c2c",
        senderId: "u1",
        content: "hello",
        messageId: "in-1",
        timestamp: "2026-10-27T12:00:00Z",
        raw: {} as SdkInboundMessage["raw"],
        ...overrides,
    };
}

function content(overrides: Partial<OutboundContent> = {}): OutboundContent {
    return {
        kind: "reply",
        text: "hello",
        deliveryId: 1,
        attempt: 0,
        ...overrides,
    };
}

function setup(
    options: {
        config?: Partial<QqBotConfig>;
        now?: () => number;
    } = {}
): {
    driver: QqBotDriver;
    rest: FakeRest;
    gateway: FakeGateway;
    now: () => number;
} {
    let now = 1_000_000;
    const clock = options.now ?? (() => now);
    const rest = new FakeRest();
    const gateway = new FakeGateway();
    const limiter = new SendLimiter({
        now: clock,
        c2cPerSecond: 1000,
        groupPerMinute: 1000,
        relationPerMinute: 1000,
        globalPerSecond: 1000,
    });
    const driver = new QqBotDriver({
        config: baseConfig(options.config),
        rest,
        gateway,
        logger: createLogger("qq-test", () => undefined),
        now: clock,
        limiter,
    });
    return {
        driver,
        rest,
        gateway,
        now: () => {
            now += 0;
            return clock();
        },
    };
}

describe("qq bot driver", () => {
    it("sends a passive reply with a stable msg_seq", async () => {
        const { driver, rest } = setup();
        await driver.send(
            "c2c:u1",
            content({
                reply: { messageId: "in-1", receivedAt: 1_000_000, seq: 1 },
            })
        );
        expect(rest.requests[0]).toMatchObject({
            scope: "c2c",
            targetId: "u1",
            body: {
                msg_type: 2,
                msg_id: "in-1",
                msg_seq: 1,
                markdown: { content: "hello" },
            },
        });
    });

    it("uses the group endpoint and text mode when configured", async () => {
        const { driver, rest } = setup({
            config: { markdown: "none" },
        });
        await driver.send("group:g1", content());
        expect(rest.requests[0]).toMatchObject({
            scope: "group",
            targetId: "g1",
            body: { msg_type: 0, content: "hello" },
        });
        expect(rest.requests[0]?.body.msg_id).toBeUndefined();
    });

    it("rejects an expired or over-limit passive context", async () => {
        const { driver } = setup();
        await expect(
            driver.send(
                "c2c:u1",
                content({
                    reply: {
                        messageId: "in-1",
                        receivedAt: 1_000_000 - 3_600_001,
                        seq: 1,
                    },
                })
            )
        ).rejects.toBeInstanceOf(PassiveReplyExpiredError);
        await expect(
            driver.send(
                "c2c:u1",
                content({
                    reply: { messageId: "in-1", receivedAt: 1_000_000, seq: 5 },
                })
            )
        ).rejects.toBeInstanceOf(PassiveReplyExpiredError);
    });

    it("refuses active messages when the fallback is off", async () => {
        const { driver } = setup({ config: { activeMessageFallback: "off" } });
        expect(driver.canDeliver("c2c:u1", { kind: "notice" })).toBe(false);
        await expect(driver.send("c2c:u1", content())).rejects.toMatchObject({
            name: "NonRetryableDeliveryError",
            reason: "active-unavailable",
        });
    });

    it("marks active messages unavailable after a platform rejection", async () => {
        let now = 1_000_000;
        const { driver, rest } = setup({ now: () => now });
        rest.errors.push(apiError(40034105));
        await expect(driver.send("c2c:u1", content())).rejects.toBeInstanceOf(
            NonRetryableDeliveryError
        );
        expect(driver.canDeliver("c2c:u1", { kind: "notice" })).toBe(false);
        expect(driver.health().detail).toContain("active-messages-unavailable");
        now += 1001;
        expect(driver.canDeliver("c2c:u1", { kind: "notice" })).toBe(true);
    });

    it("treats a duplicate platform rejection as success", async () => {
        const { driver, rest } = setup();
        rest.errors.push(apiError(40054005));
        const sent = await driver.send(
            "c2c:u1",
            content({
                reply: { messageId: "in-1", receivedAt: 1_000_000, seq: 1 },
            })
        );
        expect(sent.messageId).toBe("in-1");
    });

    it("retries once with a truncated body on length errors", async () => {
        const { driver, rest } = setup({ config: { markdown: "none" } });
        rest.errors.push(apiError(40054007));
        await driver.send("c2c:u1", content({ text: "x".repeat(100) }));
        expect(rest.requests).toHaveLength(2);
        expect(rest.requests[1]?.body.content).toBe(`${"x".repeat(90)}…`);
    });

    it("retries once as text when markdown is rejected", async () => {
        const { driver, rest } = setup();
        rest.errors.push(apiError(40034127));
        await driver.send("c2c:u1", content({ text: "**hello**" }));
        expect(rest.requests).toHaveLength(2);
        expect(rest.requests[1]?.body).toMatchObject({
            msg_type: 0,
            content: "**hello**",
        });
    });

    it("maps a platform passive-expiry rejection", async () => {
        const { driver, rest } = setup();
        rest.errors.push(apiError(40034128));
        await expect(
            driver.send(
                "c2c:u1",
                content({
                    reply: { messageId: "in-1", receivedAt: 1_000_000, seq: 1 },
                })
            )
        ).rejects.toBeInstanceOf(PassiveReplyExpiredError);
    });

    it("rejects invalid chat ids, empty text and sends after stop", async () => {
        const { driver } = setup();
        await expect(driver.send("local", content())).rejects.toMatchObject({
            reason: "invalid-chat-id",
        });
        await expect(
            driver.send("c2c:u1", content({ text: "  " }))
        ).rejects.toMatchObject({ reason: "empty-text" });
        await driver.stop();
        await expect(driver.send("c2c:u1", content())).rejects.toThrow(
            /stopped/
        );
    });

    it("maps SDK messages to core inbound messages on start", async () => {
        const { driver, gateway } = setup();
        const received: InboundMessage[] = [];
        await driver.start({
            onInbound: (message) => {
                received.push(message);
            },
        });
        gateway.handler?.(sdkMessage());
        gateway.handler?.(sdkMessage({ content: "" }));
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            channelId: "qq-bot",
            chatId: "c2c:u1",
            messageId: "in-1",
        });
    });

    it("reports gateway health and active-message detail", async () => {
        const now = 1_000_000;
        const { driver, gateway, rest } = setup({ now: () => now });
        expect(driver.health()).toEqual({ state: "online" });
        rest.errors.push(apiError(40034105));
        await expect(driver.send("c2c:u1", content())).rejects.toBeInstanceOf(
            NonRetryableDeliveryError
        );
        gateway.state = "connecting";
        expect(driver.health()).toEqual({
            state: "connecting",
            detail: "active-messages-unavailable",
        });
    });
});
