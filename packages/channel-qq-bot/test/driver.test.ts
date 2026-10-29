import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
    type ChannelHealth,
    type InboundMessage,
    type OutboundContent,
} from "@nokoribi/channel-core";
import { createLogger, type OutboundAction } from "@nokoribi/shared";
import type {
    InboundMessage as SdkInboundMessage,
    InteractionEvent,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { describe, expect, it } from "vitest";

import type { QqBotConfig } from "../src/config.js";
import { QqBotDriver } from "../src/driver.js";
import { SendLimiter } from "../src/limiter.js";
import type {
    QqGatewayClient,
    QqGatewayHandlers,
    QqRestClient,
} from "../src/transport.js";

interface SentRequest {
    readonly scope: "c2c" | "group";
    readonly targetId: string;
    readonly body: Record<string, unknown>;
}

class FakeRest implements QqRestClient {
    readonly requests: SentRequest[] = [];
    readonly acks: { interactionId: string; code: 0 | 1 }[] = [];
    readonly errors: unknown[] = [];
    ackError: unknown;

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

    async ackInteraction(interactionId: string, code: 0 | 1): Promise<void> {
        this.acks.push({ interactionId, code });
        if (this.ackError !== undefined) throw this.ackError;
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
    handlers: QqGatewayHandlers | undefined;
    state: ChannelHealth["state"] = "online";
    interactions = true;

    async start(handlers: QqGatewayHandlers): Promise<void> {
        this.handlers = handlers;
    }

    async stop(): Promise<void> {
        this.state = "offline";
    }

    health(): ChannelHealth {
        return { state: this.state };
    }

    interactionAvailable(): boolean {
        return this.interactions && this.state === "online";
    }

    emitInteraction(event: InteractionEvent): void | Promise<void> {
        return this.handlers?.onInteraction(event);
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
        approvalButtons: true,
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

function actions(
    overrides: readonly Partial<OutboundAction>[] = [{}, {}]
): readonly OutboundAction[] {
    return overrides.map((override, index) => ({
        id: `token-${String(index + 1)}`,
        label: index === 0 ? "允许一次" : "拒绝",
        kind: "callback" as const,
        payload: JSON.stringify({
            k: `token-${String(index + 1)}`,
            t: index === 0 ? "允许一次" : "拒绝",
        }),
        style: index === 0 ? ("primary" as const) : ("danger" as const),
        ...override,
    }));
}

function interactionEvent(
    overrides: Partial<InteractionEvent> = {}
): InteractionEvent {
    return {
        id: "interaction-1",
        type: 11,
        scene: "c2c",
        chat_type: 2,
        timestamp: "2026-10-27T12:00:00Z",
        user_openid: "u1",
        version: 1,
        data: {
            type: 11,
            resolved: {
                button_data: JSON.stringify({ k: "token-1", t: "允许一次" }),
                button_id: "token-1",
                message_id: "bot-message-1",
            },
        },
        ...overrides,
    };
}

function keyboardOf(body: Record<string, unknown>):
    | {
          content: { rows: { buttons: Record<string, unknown>[] }[] };
      }
    | undefined {
    const keyboard = body.keyboard;
    if (typeof keyboard !== "object" || keyboard === null) return undefined;
    return keyboard as {
        content: { rows: { buttons: Record<string, unknown>[] }[] };
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
        gateway.handlers?.onInbound(sdkMessage());
        gateway.handlers?.onInbound(sdkMessage({ content: "" }));
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            channelId: "qq-bot",
            chatId: "c2c:u1",
            messageId: "in-1",
        });
    });

    it("renders C2C approval actions as one keyboard row", async () => {
        const { driver, rest } = setup();
        await driver.send("c2c:u1", content({ actions: actions() }));
        const body = rest.requests[0]?.body;
        expect(body?.msg_type).toBe(2);
        const keyboard = keyboardOf(body ?? {});
        expect(keyboard?.content.rows).toHaveLength(1);
        const buttons = keyboard?.content.rows[0]?.buttons ?? [];
        expect(buttons).toHaveLength(2);
        expect(buttons[0]).toMatchObject({
            id: "token-1",
            render_data: {
                label: "允许一次",
                visited_label: "允许一次",
                style: 4,
            },
            action: { type: 1, permission: { type: 2 } },
        });
        expect(buttons[1]).toMatchObject({
            id: "token-2",
            render_data: { label: "拒绝", style: 3 },
            action: { type: 1, permission: { type: 2 } },
        });
        const firstAction = buttons[0]?.action as
            | { data?: unknown }
            | undefined;
        expect(firstAction).toBeDefined();
        const payload = JSON.parse(String(firstAction?.data)) as {
            k?: string;
            t?: string;
        };
        expect(payload).toMatchObject({ k: "token-1", t: "允许一次" });
    });

    it("keeps keyboards in text mode and across markdown/length retries", async () => {
        const textMode = setup({ config: { markdown: "none" } });
        await textMode.driver.send("c2c:u1", content({ actions: actions() }));
        expect(textMode.rest.requests[0]?.body.msg_type).toBe(0);
        expect(keyboardOf(textMode.rest.requests[0]?.body ?? {})).toBeDefined();

        const markdownFallback = setup();
        markdownFallback.rest.errors.push(apiError(40034127));
        await markdownFallback.driver.send(
            "c2c:u1",
            content({ text: "**hello**", actions: actions() })
        );
        expect(markdownFallback.rest.requests).toHaveLength(2);
        expect(markdownFallback.rest.requests[1]?.body.msg_type).toBe(0);
        expect(
            keyboardOf(markdownFallback.rest.requests[1]?.body ?? {})
        ).toBeDefined();

        const lengthFallback = setup({ config: { markdown: "none" } });
        lengthFallback.rest.errors.push(apiError(40054007));
        await lengthFallback.driver.send(
            "c2c:u1",
            content({ text: "x".repeat(100), actions: actions() })
        );
        expect(lengthFallback.rest.requests).toHaveLength(2);
        expect(
            keyboardOf(lengthFallback.rest.requests[1]?.body ?? {})
        ).toBeDefined();
    });

    it("strips actions for group chats and unsupported actions", async () => {
        const { driver, rest } = setup();
        await driver.send("group:g1", content({ actions: actions() }));
        expect(rest.requests[0]?.body.keyboard).toBeUndefined();

        const filtered = setup();
        await filtered.driver.send(
            "c2c:u1",
            content({
                actions: [
                    ...actions([{ kind: "link" }, { disabled: true }]),
                    ...actions([{ label: "x".repeat(12) }]),
                ],
            })
        );
        const buttons =
            keyboardOf(filtered.rest.requests[0]?.body ?? {})?.content.rows[0]
                ?.buttons ?? [];
        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.render_data).toMatchObject({
            label: "x".repeat(10),
        });
    });

    it("acknowledges before ingress and survives ack failures", async () => {
        const { driver, rest, gateway } = setup();
        const received: InboundMessage[] = [];
        await driver.start({
            onInbound: (message) => {
                received.push(message);
            },
        });
        await gateway.emitInteraction(interactionEvent());
        expect(rest.acks).toEqual([
            { interactionId: "interaction-1", code: 0 },
        ]);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            chatId: "c2c:u1",
            messageId: "interaction-1",
            text: "允许一次",
            action: {
                id: "token-1",
                messageId: "interaction-1",
            },
        });

        rest.ackError = new Error("ack failed");
        await gateway.emitInteraction(
            interactionEvent({ id: "interaction-2" })
        );
        expect(received).toHaveLength(2);
    });

    it("acknowledges unsupported interactions without ingress", async () => {
        const { driver, rest, gateway } = setup();
        const received: InboundMessage[] = [];
        await driver.start({
            onInbound: (message) => {
                received.push(message);
            },
        });
        await gateway.emitInteraction(
            interactionEvent({ chat_type: 1, group_openid: "g1" })
        );
        await gateway.emitInteraction(
            interactionEvent({
                id: "interaction-3",
                data: { type: 11, resolved: {} },
            })
        );
        expect(rest.acks).toEqual([
            { interactionId: "interaction-1", code: 1 },
            { interactionId: "interaction-3", code: 1 },
        ]);
        expect(received).toHaveLength(0);
    });

    it("disables action capabilities and rendering when buttons are off", async () => {
        const { driver, gateway, rest } = setup({
            config: { approvalButtons: false },
        });
        expect(driver.capabilities.outboundActions).toBe(false);
        expect(driver.capabilities.inboundActions).toBe(false);
        expect(gateway.interactions).toBe(true);
        await driver.send("c2c:u1", content({ actions: actions() }));
        expect(rest.requests[0]?.body.keyboard).toBeUndefined();
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
