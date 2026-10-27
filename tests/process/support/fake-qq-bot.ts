import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

import { FakeWsServer, type FakeWsConnection } from "../../support/fake-ws.js";

/** One HTTP request received by the fake QQ OpenAPI server. */
export interface FakeQqRequest {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown>;
}

/** One recorded outbound message. */
export interface FakeQqSend {
    readonly path: string;
    readonly body: Record<string, unknown>;
}

/** One scripted REST failure. */
export interface FakeQqFailure {
    readonly httpStatus?: number;
    readonly bizCode?: number;
}

interface FakeQqBotOptions {
    readonly heartbeatMs?: number;
}

/** Build a C2C event body with sensible defaults. */
export function c2cEvent(
    overrides: {
        readonly id?: string;
        readonly userId?: string;
        readonly content?: string;
        readonly timestamp?: string;
    } = {}
): Record<string, unknown> {
    return {
        id: overrides.id ?? `c2c-${String(Date.now())}`,
        author: { user_openid: overrides.userId ?? "user-1" },
        content: overrides.content ?? "hello",
        timestamp: overrides.timestamp ?? new Date().toISOString(),
        message_scene: { source: "default", ext: [] },
    };
}

/** Build a group @ event body with sensible defaults. */
export function groupAtEvent(
    overrides: {
        readonly id?: string;
        readonly groupOpenid?: string;
        readonly memberOpenid?: string;
        readonly content?: string;
        readonly timestamp?: string;
    } = {}
): Record<string, unknown> {
    return {
        id: overrides.id ?? `group-${String(Date.now())}`,
        group_openid: overrides.groupOpenid ?? "group-1",
        author: { member_openid: overrides.memberOpenid ?? "member-1" },
        content: overrides.content ?? "hello",
        timestamp: overrides.timestamp ?? new Date().toISOString(),
        message_scene: { source: "default", ext: [] },
    };
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Zero-dependency fake QQ Bot server: token, gateway URL, message sends and a
 * WebSocket gateway that speaks just enough of the protocol for the driver.
 */
export class FakeQqBot {
    private readonly api: Server;
    private readonly ws: FakeWsServer;
    private readonly heartbeatMs: number;
    private readonly failures: FakeQqFailure[] = [];
    private readonly requests: FakeQqRequest[] = [];
    private readonly sends: FakeQqSend[] = [];
    private readonly tokens: string[] = [];
    private readonly identifies: Record<string, unknown>[] = [];
    private readonly resumes: Record<string, unknown>[] = [];
    private readonly connections: FakeWsConnection[] = [];
    private rejectNext = false;
    private sequence = 1;

    private constructor(
        api: Server,
        ws: FakeWsServer,
        options: FakeQqBotOptions
    ) {
        this.api = api;
        this.ws = ws;
        this.heartbeatMs = options.heartbeatMs ?? 1000;
    }

    static async start(options: FakeQqBotOptions = {}): Promise<FakeQqBot> {
        const api = createServer();
        const ws = await FakeWsServer.start();
        const fake = new FakeQqBot(api, ws, options);
        api.on("request", (request, response) => {
            void fake.handleRequest(request, response);
        });
        await new Promise<void>((resolve) => {
            api.listen(0, "127.0.0.1", resolve);
        });
        fake.wireWebSocket();
        return fake;
    }

    get apiUrl(): string {
        const address = this.api.address();
        if (address === null || typeof address === "string") {
            throw new Error("fake QQ API server is not listening");
        }
        return `http://127.0.0.1:${String(address.port)}`;
    }

    get wsUrl(): string {
        return this.ws.url;
    }

    get outbound(): readonly FakeQqSend[] {
        return this.sends;
    }

    get httpRequests(): readonly FakeQqRequest[] {
        return this.requests;
    }

    get tokenRequests(): readonly string[] {
        return this.tokens;
    }

    get identifyRequests(): readonly Record<string, unknown>[] {
        return this.identifies;
    }

    get resumeRequests(): readonly Record<string, unknown>[] {
        return this.resumes;
    }

    /** Queue one failure for the next message send. */
    failNextSend(failure: FakeQqFailure): void {
        this.failures.push(failure);
    }

    /** Reject the next send with HTTP 401 so the client refreshes its token. */
    rejectNextSend(): void {
        this.rejectNext = true;
    }

    /** Wait until a matching outbound message is recorded. */
    async waitForSend(
        predicate: (send: FakeQqSend) => boolean,
        timeoutMs = 15000
    ): Promise<FakeQqSend> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.sends.find(predicate);
            if (found !== undefined) return found;
            if (Date.now() > deadline) {
                throw new Error(
                    `timed out waiting for QQ send; got ${JSON.stringify(
                        this.sends.map((send) => send.path)
                    )}`
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    /** Wait until a WebSocket connection has sent IDENTIFY. */
    async waitForIdentify(timeoutMs = 15000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.identifies.length === 0) {
            if (Date.now() > deadline) {
                throw new Error("timed out waiting for QQ identify");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    /** Wait until the gateway has reconnected and sent RESUME. */
    async waitForResume(timeoutMs = 15000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.resumes.length === 0) {
            if (Date.now() > deadline) {
                throw new Error("timed out waiting for QQ resume");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    /** Push one raw dispatch event to the latest gateway connection. */
    pushEvent(type: string, data: Record<string, unknown>): void {
        const connection = this.latestConnection();
        if (connection === undefined) {
            throw new Error("no fake QQ websocket connection");
        }
        this.sequence += 1;
        connection.sendJson({
            op: 0,
            s: this.sequence,
            t: type,
            d: data,
        });
    }

    /** Push one C2C message event. */
    pushC2C(
        overrides: {
            readonly id?: string;
            readonly userId?: string;
            readonly content?: string;
            readonly timestamp?: string;
        } = {}
    ): void {
        this.pushEvent("C2C_MESSAGE_CREATE", c2cEvent(overrides));
    }

    /** Push one group @ message event. */
    pushGroupAt(
        overrides: {
            readonly id?: string;
            readonly groupOpenid?: string;
            readonly memberOpenid?: string;
            readonly content?: string;
            readonly timestamp?: string;
        } = {}
    ): void {
        this.pushEvent("GROUP_AT_MESSAGE_CREATE", groupAtEvent(overrides));
    }

    /** Drop the current gateway connection with a resumable close code. */
    dropConnection(code = 4009): void {
        this.latestConnection()?.sendClose(code, "test drop");
    }

    async close(): Promise<void> {
        await this.ws.close();
        await new Promise<void>((resolve) => {
            this.api.close(() => resolve());
        });
    }

    private latestConnection(): FakeWsConnection | undefined {
        return this.connections[this.connections.length - 1];
    }

    private wireWebSocket(): void {
        this.ws.onConnection = (connection) => {
            this.connections.push(connection);
            connection.sendJson({
                op: 10,
                d: { heartbeat_interval: this.heartbeatMs },
            });
        };
        this.ws.onText = (text, connection) => {
            const payload = JSON.parse(text) as {
                op?: number;
                d?: Record<string, unknown>;
            };
            if (payload.op === 1) {
                connection.sendJson({ op: 11 });
                return;
            }
            if (payload.op === 2) {
                this.identifies.push(payload.d ?? {});
                this.sequence = 1;
                connection.sendJson({
                    op: 0,
                    s: this.sequence,
                    t: "READY",
                    d: {
                        session_id: "session-1",
                        user: { id: "bot-1" },
                        shard: [0, 1],
                    },
                });
                return;
            }
            if (payload.op === 6) {
                this.resumes.push(payload.d ?? {});
                this.sequence += 1;
                connection.sendJson({
                    op: 0,
                    s: this.sequence,
                    t: "RESUMED",
                    d: {},
                });
            }
        };
    }

    private async handleRequest(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        const raw = await readBody(request);
        const body =
            raw.trim() === ""
                ? {}
                : (JSON.parse(raw) as Record<string, unknown>);
        const path = request.url ?? "/";
        this.requests.push({
            method: request.method ?? "GET",
            path,
            body,
        });
        if (path === "/app/getAppAccessToken") {
            const token = `token-${String(this.tokens.length + 1)}`;
            this.tokens.push(token);
            this.json(response, 200, {
                access_token: token,
                expires_in: 7200,
            });
            return;
        }
        if (path === "/gateway") {
            this.json(response, 200, { url: this.ws.url });
            return;
        }
        if (path.endsWith("/messages")) {
            if (this.rejectNext) {
                this.rejectNext = false;
                this.json(response, 401, { code: 11241 });
                return;
            }
            const failure = this.failures.shift();
            if (failure !== undefined) {
                if (failure.httpStatus !== undefined) {
                    this.json(response, failure.httpStatus, {
                        code: failure.bizCode ?? 0,
                    });
                } else {
                    this.json(response, 200, {
                        code: failure.bizCode ?? 0,
                        message: "scripted failure",
                    });
                }
                return;
            }
            this.sends.push({ path, body });
            this.json(response, 200, {
                id: `out-${String(this.sends.length)}`,
                timestamp: new Date().toISOString(),
            });
            return;
        }
        this.json(response, 404, { message: "not found" });
    }

    private json(
        response: ServerResponse,
        status: number,
        body: unknown
    ): void {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    }
}
