import { createLogger } from "@nokoribi/shared";
import type {
    ChatScope,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { FakeWsServer } from "../../../tests/support/fake-ws.js";
import type { QqBotConfig, QqCredentials } from "../src/config.js";
import {
    buildReconnectDelays,
    QqGateway,
    QQ_GROUP_AND_C2C_INTENTS,
} from "../src/gateway.js";
import type { QqRestClient } from "../src/transport.js";

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
    timeoutMs = 2000
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

async function startGateway(): Promise<{
    server: FakeWsServer;
    gateway: QqGateway;
    identify: () => Record<string, unknown> | undefined;
}> {
    const server = await FakeWsServer.start();
    servers.push(server);
    let identify: Record<string, unknown> | undefined;
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
        if (payload.op === 2) {
            identify = payload.d;
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
        } else if (payload.op === 1) {
            connection.sendJson({ op: 11 });
        }
    };
    const gateway = new QqGateway({
        config,
        credentials,
        rest: new FakeRest(server.url),
        logger: createLogger("qq-gateway-test", () => undefined),
    });
    gateways.push(gateway);
    return {
        server,
        gateway,
        identify: () => identify,
    };
}

describe("qq gateway wrapper", () => {
    it("identifies with the documented token and intents, then goes online", async () => {
        const { gateway, identify } = await startGateway();
        await gateway.start(() => undefined);
        expect(gateway.health().state).toBe("online");
        expect(identify()).toMatchObject({
            token: "QQBot token-1",
            intents: QQ_GROUP_AND_C2C_INTENTS,
        });
        expect(QQ_GROUP_AND_C2C_INTENTS).toBe(1 << 25);
    });

    it("forwards normalized messages and sends heartbeats", async () => {
        const { gateway, server } = await startGateway();
        const received: string[] = [];
        await gateway.start((message) => {
            received.push(message.rawEventType);
        });
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
        await waitFor(() => received.length > 0);
        expect(received[0]).toBe("C2C_MESSAGE_CREATE");
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(server.connection).toBeDefined();
    });

    it("stops the connection and health", async () => {
        const { gateway } = await startGateway();
        await gateway.start(() => undefined);
        await gateway.stop();
        expect(gateway.health().state).toBe("offline");
        await gateway.stop();
    });

    it("marks fatal closes offline without reconnecting", async () => {
        const { gateway, server } = await startGateway();
        await gateway.start(() => undefined);
        server.connection?.sendClose(4914, "offline");
        await waitFor(() => gateway.health().state === "offline");
        expect(gateway.health().state).toBe("offline");
    });

    it("builds geometric reconnect delays", () => {
        expect(buildReconnectDelays(1000, 60000)).toEqual([
            1000, 2000, 4000, 8000, 16000, 32000, 60000,
        ]);
        expect(buildReconnectDelays(500, 500)).toEqual([500]);
    });
});
