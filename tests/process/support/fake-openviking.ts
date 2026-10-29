import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

/** One recorded OpenViking HTTP request. */
export interface FakeOpenVikingRequest {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown>;
}

/** Marker text returned as the server-assembled recall digest. */
export const FAKE_OPENVIKING_RECALL =
    "FAKE-VIKING-RECALL: user prefers concise Chinese replies";

/** Fake OpenViking HTTP/REST server for M17 process tests. */
export interface FakeOpenVikingServer {
    /** Base URL without a trailing slash. */
    readonly baseURL: string;
    readonly requests: FakeOpenVikingRequest[];
    close(): Promise<void>;
}

async function readBody(
    request: IncomingMessage
): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return {};
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function sendJson(
    response: ServerResponse,
    status: number,
    payload: unknown
): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
}

function ok(response: ServerResponse, result: unknown): void {
    sendJson(response, 200, { status: "ok", result });
}

/**
 * Start a zero-dependency fake OpenViking server covering the endpoints the
 * `@openviking/dsh-memory-plugin` bundle touches during startup, recall,
 * capture and commit. Every request is recorded for assertions.
 * @returns the fake server, its base URL and its recorded requests.
 */
export async function startFakeOpenViking(): Promise<FakeOpenVikingServer> {
    const requests: FakeOpenVikingRequest[] = [];
    const server: Server = createServer((request, response) => {
        void (async () => {
            try {
                const url = new URL(request.url ?? "/", "http://127.0.0.1");
                const path = url.pathname;
                const method = request.method ?? "GET";
                const body =
                    method === "GET" || method === "HEAD"
                        ? {}
                        : await readBody(request);
                requests.push({ method, path, body });

                if (method === "GET" && path === "/health") {
                    ok(response, { status: "ok", version: "fake" });
                    return;
                }
                if (method === "GET" && path === "/api/v1/system/status") {
                    ok(response, { user: "default", status: "ok" });
                    return;
                }
                if (method === "GET" && path === "/api/v1/fs/ls") {
                    ok(response, []);
                    return;
                }
                if (method === "GET" && path === "/api/v1/content/read") {
                    ok(response, "");
                    return;
                }
                if (method === "GET" && path === "/api/v1/skills") {
                    ok(response, []);
                    return;
                }
                if (method === "POST" && path === "/api/v1/search/search") {
                    ok(response, {
                        rendered: "",
                        entries: [],
                        digest: FAKE_OPENVIKING_RECALL,
                        stats: { rewrite: "off", used_tokens: 42 },
                    });
                    return;
                }
                if (method === "POST" && path === "/api/v1/search/find") {
                    ok(response, {
                        memories: [],
                        events: [],
                        entities: [],
                        preferences: [],
                        experiences: [],
                        skills: [],
                    });
                    return;
                }
                if (method === "POST" && path === "/api/v1/search/recall") {
                    ok(response, {
                        rendered: "",
                        entries: [],
                        stats: { rewrite: "off" },
                    });
                    return;
                }
                if (method === "POST" && path === "/api/v1/sessions") {
                    ok(response, {});
                    return;
                }
                if (
                    method === "GET" &&
                    /^\/api\/v1\/sessions\/[^/]+$/.test(path)
                ) {
                    ok(response, { session_id: path.split("/").pop() });
                    return;
                }
                if (
                    method === "POST" &&
                    /^\/api\/v1\/sessions\/[^/]+\/messages$/.test(path)
                ) {
                    ok(response, { status: "ok" });
                    return;
                }
                if (
                    method === "POST" &&
                    /^\/api\/v1\/sessions\/[^/]+\/commit$/.test(path)
                ) {
                    ok(response, { status: "ok" });
                    return;
                }
                if (method === "POST" && path === "/mcp") {
                    sendJson(response, 404, {
                        error: { message: "MCP endpoint not implemented" },
                    });
                    return;
                }
                sendJson(response, 404, {
                    error: { message: `no fake route for ${method} ${path}` },
                });
            } catch (error) {
                sendJson(response, 500, {
                    error: {
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
        })();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", rejectListen);
            resolveListen();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("fake OpenViking server did not bind a TCP port");
    }
    return {
        baseURL: `http://127.0.0.1:${String(address.port)}`,
        requests,
        async close(): Promise<void> {
            await new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
            });
        },
    };
}
