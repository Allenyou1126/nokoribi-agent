import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

/** One Messages request received by the fake DeepSeek search endpoint. */
export interface FakeSearchRequest {
    readonly url: string;
    readonly body: Record<string, unknown>;
}

/** Fake DeepSeek search endpoint for M10 process tests. */
export interface FakeSearchServer {
    /** Base URL including `/v1`; the provider appends `/messages`. */
    readonly baseURL: string;
    readonly requests: FakeSearchRequest[];
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
    return text.trim() === ""
        ? {}
        : (JSON.parse(text) as Record<string, unknown>);
}

function sendJson(
    response: ServerResponse,
    status: number,
    payload: unknown
): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
}

/**
 * Start a fake Anthropic-compatible Messages endpoint that returns one native
 * `web_search_tool_result` plus a citation for every search request.
 * @returns the fake server and its recorded requests.
 */
export async function startFakeWebSearch(): Promise<FakeSearchServer> {
    const requests: FakeSearchRequest[] = [];
    const server: Server = createServer((request, response) => {
        void (async () => {
            try {
                const url = new URL(request.url ?? "/", "http://127.0.0.1");
                if (
                    request.method !== "POST" ||
                    !url.pathname.endsWith("/messages")
                ) {
                    sendJson(response, 404, { error: "not found" });
                    return;
                }
                const body = await readBody(request);
                requests.push({ url: url.pathname, body });
                sendJson(response, 200, {
                    id: "fake-search",
                    type: "message",
                    role: "assistant",
                    model: "deepseek-v4-flash",
                    content: [
                        {
                            type: "web_search_tool_result",
                            content: [
                                {
                                    type: "web_search_result",
                                    url: "https://example.test/m10",
                                    title: "M10 terminal and web",
                                    page_age: "2026-10-29",
                                },
                            ],
                        },
                        {
                            type: "text",
                            text: "M10 summary",
                            citations: [
                                {
                                    url: "https://example.test/m10",
                                    cited_text:
                                        "persistent terminal and web search",
                                },
                            ],
                        },
                    ],
                    usage: { input_tokens: 1, output_tokens: 1 },
                });
            } catch (error) {
                if (!response.headersSent) {
                    sendJson(response, 500, {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                } else {
                    response.destroy();
                }
            }
        })();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port =
        typeof address === "object" && address !== null ? address.port : 0;
    return {
        baseURL: `http://127.0.0.1:${String(port)}/v1`,
        requests,
        async close(): Promise<void> {
            server.closeAllConnections?.();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
