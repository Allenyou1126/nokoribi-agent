import { createLogger } from "@nokoribi/shared";
import type {
    ChatScope,
    InteractionEvent,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { FakeWsServer } from "../../../tests/support/fake-ws.js";
import type { QqBotConfig, QqCredentials } from "../src/config.js";
import {
    buildReconnectDelays,
    QqGateway,
    QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS,
    QQ_GROUP_AND_C2C_INTENTS,
    QQ_INTERACTION_INTENT,
} from "../src/gateway.js";
import type { QqGatewayHandlers, QqRestClient } from "../src/transport.js";

const config: QqBotConfig = {
    enabled: true,
    appId: "app-1",
    clientSecretEnv: "SECRET",
    markdown: "basic",
    maxTextLength: 4500,
    maxRepliesPerReply: 4,
    c2cReplyWindowSeconds: 3600,
    groupReplyWindowSeconds: 300,
    requestTimeoutMs: 1000,
    connectTimeoutMs: 2000,
    activeMessageFallback: "auto",
    approvalButtons: true,
    reconnectBaseMs: 10,
    reconnectMaxMs: 50,
};

const credentials: QqCredentials = {
    appId: "app-1",
    clientSecret: "secret-1",
};

class FakeRest implements QqRestClient {
    constructor(private readonly gatewayUrl: string) {}

    async send(
        _scope: ChatScope,
        _targetId: string,
        _body: Record<string, unknown>
    ): Promise<MessageResponse> {
        return { id: "sent", timestamp: 0 };
    }

    async ackInteraction(): Promise<void> {}

    async getGatewayUrl(): Promise<string> {
        return this.gatewayUrl;
    }

    async getAccessToken(): Promise<string> {
        return "token-1";
    }

    clearTokenCache(): void {}
    stop(): void {}
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("condition timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const servers: FakeWsServer[] = [];
const gateways: QqGateway[] = [];

afterEach(async () => {
    await Promise.all(
        gateways.splice(0).map(async (gateway) => {
            await gateway.stop().catch(() => undefined);
        })
    );
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface StartOptions {
    readonly approvalButtons?: boolean;
    readonly questionButtons?: boolean;
    /** Close any Identify carrying the interaction intent with this code. */
    readonly rejectInteractionIntents?: number;
}

async function startGateway(options: StartOptions = {}): Promise<{
    server: FakeWsServer;
    gateway: QqGateway;
    identify: () => Record<string, unknown> | undefined;
    identifies: readonly Record<string, unknown>[];
}> {
    const server = await FakeWsServer.start();
    servers.push(server);
    const identifies: Record<string, unknown>[] = [];
    server.onConnection = (connection) => {
        connection.sendJson({
            op: 10,
            d: { heartbeat_interval: 50 },
        });
    };
    server.onText = (text, connection) => {
        const payload = JSON.parse(text) as {
            op?: number;
            d?: Record<string, unknown>;
        };
        if (payload.op === 1) {
            connection.sendJson({ op: 11 });
            return;
        }
        if (payload.op !== 2) return;
        const identify = payload.d ?? {};
        identifies.push(identify);
        const intents =
            typeof identify.intents === "number" ? identify.intents : 0;
        if (
            options.rejectInteractionIntents !== undefined &&
            (intents & QQ_INTERACTION_INTENT) !== 0
        ) {
            connection.sendClose(
                options.rejectInteractionIntents,
                "interaction intent rejected"
            );
            return;
        }
        connection.sendJson({
            op: 0,
            s: 1,
            t: "READY",
            d: {
                session_id: "session-1",
                user: { id: "bot" },
                shard: [0, 1],
            },
        });
    };
    const gateway = new QqGateway({
        config: {
            ...config,
            approvalButtons: options.approvalButtons ?? true,
            questionButtons: options.questionButtons ?? true,
        },
        credentials,
        rest: new FakeRest(server.url),
        logger: createLogger("qq-gateway-test", () => undefined),
    });
    gateways.push(gateway);
    return {
        server,
        gateway,
        identify: () => identifies.at(-1),
        identifies,
    };
}

function interactionEvent(): InteractionEvent {
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
            },
        },
    };
}

function handlers(
    received: string[],
    interactions: InteractionEvent[] = []
): QqGatewayHandlers {
    return {
        onInbound: (message) => {
            received.push(message.rawEventType);
        },
        onInteraction: (event) => {
            interactions.push(event);
        },
    };
}

describe("qq gateway wrapper", () => {
    it("identifies with both intents, then goes online", async () => {
        const { gateway, identify } = await startGateway();
        await gateway.start(handlers([]));
        expect(gateway.health().state).toBe("online");
        expect(identify()).toMatchObject({
            token: "QQBot token-1",
            intents: QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS,
        });
        expect(QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS).toBe(
            (1 << 25) | (1 << 26)
        );
    });

    it("subscribes only to message intents when buttons are disabled", async () => {
        const { gateway, identify } = await startGateway({
            approvalButtons: false,
            questionButtons: false,
        });
        await gateway.start(handlers([]));
        expect(identify()).toMatchObject({
            intents: QQ_GROUP_AND_C2C_INTENTS,
        });
        expect(gateway.interactionAvailable()).toBe(false);
        expect(gateway.health().state).toBe("online");
    });

    it("subscribes to interactions when only question buttons are enabled", async () => {
        const { gateway, identify } = await startGateway({
            approvalButtons: false,
            questionButtons: true,
        });
        await gateway.start(handlers([]));
        expect(identify()).toMatchObject({
            intents: QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS,
        });
        expect(gateway.interactionAvailable()).toBe(true);
    });

    it("forwards normalized messages and interactions", async () => {
        const { gateway, server } = await startGateway();
        const received: string[] = [];
        const interactions: InteractionEvent[] = [];
        await gateway.start(handlers(received, interactions));
        server.connection?.sendJson({
            op: 0,
            s: 2,
            t: "C2C_MESSAGE_CREATE",
            d: {
                id: "msg-1",
                author: { user_openid: "user-1" },
                content: "hello",
                timestamp: "2026-10-27T12:00:00Z",
            },
        });
        server.connection?.sendJson({
            op: 0,
            s: 3,
            t: "INTERACTION_CREATE",
            d: interactionEvent(),
        });
        await waitFor(() => received.length > 0 && interactions.length > 0);
        expect(received[0]).toBe("C2C_MESSAGE_CREATE");
        expect(interactions[0]?.id).toBe("interaction-1");
    });

    it("stops the connection and health", async () => {
        const { gateway } = await startGateway();
        await gateway.start(handlers([]));
        await gateway.stop();
        expect(gateway.health().state).toBe("offline");
        await gateway.stop();
    });

    it("degrades on 4014 before READY and keeps text approvals available", async () => {
        const { gateway, identify, identifies } = await startGateway({
            rejectInteractionIntents: 4014,
        });
        await gateway.start(handlers([]));
        await waitFor(() => gateway.health().state === "online");
        expect(identifies).toHaveLength(2);
        expect(identify()).toMatchObject({
            intents: QQ_GROUP_AND_C2C_INTENTS,
        });
        expect(gateway.interactionAvailable()).toBe(false);
        expect(gateway.health().detail).toContain(
            "interaction-intent-unavailable"
        );
    });

    it("degrades on 4914 before READY", async () => {
        const { gateway, identify } = await startGateway({
            rejectInteractionIntents: 4914,
        });
        await gateway.start(handlers([]));
        await waitFor(() => gateway.health().state === "online");
        expect(identify()).toMatchObject({
            intents: QQ_GROUP_AND_C2C_INTENTS,
        });
        expect(gateway.interactionAvailable()).toBe(false);
    });

    it("does not degrade when a fatal close arrives after READY", async () => {
        const { gateway, server } = await startGateway();
        await gateway.start(handlers([]));
        server.connection?.sendClose(4914, "offline");
        await waitFor(() => gateway.health().state === "offline");
        expect(gateway.health().state).toBe("offline");
        expect(gateway.interactionAvailable()).toBe(true);
    });

    it("builds geometric reconnect delays", () => {
        expect(buildReconnectDelays(1000, 60000)).toEqual([
            1000, 2000, 4000, 8000, 16000, 32000, 60000,
        ]);
        expect(buildReconnectDelays(500, 500)).toEqual([500]);
    });
});
