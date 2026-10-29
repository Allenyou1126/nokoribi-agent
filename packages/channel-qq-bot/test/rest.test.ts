import { createServer, type IncomingMessage, type Server } from "node:http";

import { createLogger } from "@nokoribi/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { QqBotConfig, QqCredentials } from "../src/config.js";
import { QqRest } from "../src/rest.js";

interface RecordedRequest {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown>;
}

interface FakeServer {
    readonly url: string;
    readonly requests: RecordedRequest[];
    readonly tokens: string[];
    failNextSend: boolean;
    close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function startServer(): Promise<FakeServer> {
    const requests: RecordedRequest[] = [];
    const tokens: string[] = [];
    let failNextSend = false;
    const server: Server = createServer((request, response) => {
        void (async () => {
            const raw = await readBody(request);
            const body =
                raw.trim() === ""
                    ? {}
                    : (JSON.parse(raw) as Record<string, unknown>);
            const path = request.url ?? "/";
            requests.push({
                method: request.method ?? "GET",
                path,
                body,
            });
            if (path === "/app/getAppAccessToken") {
                const token = `token-${String(tokens.length + 1)}`;
                tokens.push(token);
                response.writeHead(200, {
                    "content-type": "application/json",
                });
                response.end(
                    JSON.stringify({
                        access_token: token,
                        expires_in: 7200,
                    })
                );
                return;
            }
            if (path === "/gateway") {
                response.writeHead(200, {
                    "content-type": "application/json",
                });
                response.end(JSON.stringify({ url: "wss://gateway.test" }));
                return;
            }
            if (failNextSend) {
                failNextSend = false;
                response.writeHead(401, {
                    "content-type": "application/json",
                });
                response.end(JSON.stringify({ code: 11241 }));
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({ id: "out-1", timestamp: "2026-10-27" })
            );
        })().catch((error: unknown) => {
            response.destroy(error instanceof Error ? error : undefined);
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("server did not bind a TCP port");
    }
    return {
        url: `http://127.0.0.1:${String(address.port)}`,
        requests,
        tokens,
        get failNextSend(): boolean {
            return failNextSend;
        },
        set failNextSend(value: boolean) {
            failNextSend = value;
        },
        async close(): Promise<void> {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}

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
    connectTimeoutMs: 1000,
    activeMessageFallback: "auto",
    approvalButtons: true,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
};

const credentials: QqCredentials = {
    appId: "app-1",
    clientSecret: "secret-1",
};

const servers: FakeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function rest(): Promise<{ rest: QqRest; server: FakeServer }> {
    const server = await startServer();
    servers.push(server);
    return {
        server,
        rest: new QqRest({
            config: {
                ...config,
                apiBaseUrl: server.url,
                tokenBaseUrl: server.url,
                gatewayUrl: "",
            },
            credentials,
            logger: createLogger("qq-rest-test", () => undefined),
        }),
    };
}

describe("qq REST wrapper", () => {
    it("caches the access token across sends and forwards the body", async () => {
        const { rest: client, server } = await rest();
        await client.send("c2c", "user-1", {
            msg_type: 0,
            content: "hello",
            msg_id: "in-1",
            msg_seq: 1,
        });
        await client.send("group", "group-1", {
            msg_type: 0,
            content: "hi",
        });
        expect(server.tokens).toHaveLength(1);
        const sends = server.requests.filter((request) =>
            request.path.includes("/messages")
        );
        expect(sends.map((request) => request.path)).toEqual([
            "/v2/users/user-1/messages",
            "/v2/groups/group-1/messages",
        ]);
        expect(sends[0]?.body).toMatchObject({
            msg_id: "in-1",
            msg_seq: 1,
        });
    });

    it("refreshes the token once after an auth failure", async () => {
        const { rest: client, server } = await rest();
        server.failNextSend = true;
        const response = await client.send("c2c", "user-1", {
            msg_type: 0,
            content: "hello",
        });
        expect(response.id).toBe("out-1");
        expect(server.tokens).toHaveLength(2);
        const sends = server.requests.filter((request) =>
            request.path.includes("/messages")
        );
        expect(sends).toHaveLength(2);
    });

    it("resolves the gateway URL from the API or an override", async () => {
        const { rest: client, server } = await rest();
        expect(await client.getGatewayUrl()).toBe("wss://gateway.test");
        expect(
            server.requests.some((request) => request.path === "/gateway")
        ).toBe(true);

        const fixed = new QqRest({
            config: {
                ...config,
                apiBaseUrl: server.url,
                tokenBaseUrl: server.url,
                gatewayUrl: "ws://fixed.test/websocket",
            },
            credentials,
            logger: createLogger("qq-rest-test", () => undefined),
        });
        expect(await fixed.getGatewayUrl()).toBe("ws://fixed.test/websocket");
        fixed.stop();
    });

    it("acknowledges interactions with the documented PUT body", async () => {
        const { rest: client, server } = await rest();
        await client.ackInteraction("interaction-1", 0);
        await client.ackInteraction("interaction-2", 1);
        const acks = server.requests.filter((request) =>
            request.path.startsWith("/interactions/")
        );
        expect(acks).toEqual([
            {
                method: "PUT",
                path: "/interactions/interaction-1",
                body: { code: 0 },
            },
            {
                method: "PUT",
                path: "/interactions/interaction-2",
                body: { code: 1 },
            },
        ]);
    });

    it("stops without throwing when called twice", async () => {
        const { rest: client } = await rest();
        client.stop();
        client.stop();
    });
});
