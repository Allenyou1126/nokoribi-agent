import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

export interface ScriptedRequest {
    readonly model: string;
    readonly system: string | undefined;
    readonly body: Record<string, unknown>;
}

export type ScriptedResponse =
    | { readonly kind: "text"; readonly text: string }
    | {
          readonly kind: "tool-call";
          readonly name: string;
          readonly arguments: Record<string, unknown>;
      }
    | {
          readonly kind: "error";
          readonly status: number;
          readonly message: string;
          readonly code?: string;
      };

export interface ScriptedLlmOptions {
    /** Main-agent response by request order (0-based). */
    readonly main: (
        request: ScriptedRequest,
        index: number
    ) => ScriptedResponse;
    /** Reviewer response by tier and request order. */
    readonly review?: (
        request: ScriptedRequest,
        tier: "fast" | "strong",
        index: number
    ) => ScriptedResponse;
}

export interface ScriptedLlmServer {
    readonly baseURL: string;
    readonly requests: ScriptedRequest[];
    close(): Promise<void>;
}

const DEFAULT_REVIEW: ScriptedResponse = {
    kind: "text",
    text: '{"risk":"low","decision":"allow"}',
};

async function readBody(
    request: IncomingMessage
): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return {};
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("request body must be a JSON object");
    }
    return value as Record<string, unknown>;
}

function writeSse(
    response: ServerResponse,
    type: string,
    payload: unknown
): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(
    response: ServerResponse,
    status: number,
    payload: unknown
): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
}

function sendError(
    response: ServerResponse,
    status: number,
    message: string,
    code: string
): void {
    sendJson(response, status, {
        error: { message, type: "mock_error", code },
    });
}

function sendText(response: ServerResponse, model: string, text: string): void {
    response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    response.flushHeaders();
    writeSse(response, "message_start", {
        type: "message_start",
        message: {
            id: "scripted-message",
            type: "message",
            role: "assistant",
            model,
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
        },
    });
    writeSse(response, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
    });
    writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
    });
    writeSse(response, "content_block_stop", {
        type: "content_block_stop",
        index: 0,
    });
    writeSse(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: Array.from(text).length },
    });
    writeSse(response, "message_stop", { type: "message_stop" });
    response.end();
}

function sendToolCall(
    response: ServerResponse,
    model: string,
    call: { name: string; arguments: Record<string, unknown> },
    index: number
): void {
    const args = JSON.stringify(call.arguments);
    const midpoint = Math.max(1, Math.floor(args.length / 2));
    response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    response.flushHeaders();
    writeSse(response, "message_start", {
        type: "message_start",
        message: {
            id: "scripted-message",
            type: "message",
            role: "assistant",
            model,
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
        },
    });
    writeSse(response, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
            type: "tool_use",
            id: `scripted-call-${index}`,
            name: call.name,
            input: {},
        },
    });
    for (const partial of [args.slice(0, midpoint), args.slice(midpoint)]) {
        writeSse(response, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: partial },
        });
    }
    writeSse(response, "content_block_stop", {
        type: "content_block_stop",
        index: 0,
    });
    writeSse(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
    });
    writeSse(response, "message_stop", { type: "message_stop" });
    response.end();
}

/** Start a route-aware scripted Messages endpoint for M2 process tests. */
export async function startScriptedLlm(
    options: ScriptedLlmOptions
): Promise<ScriptedLlmServer> {
    const requests: ScriptedRequest[] = [];
    let mainIndex = 0;
    let fastIndex = 0;
    let strongIndex = 0;
    let server: Server;
    const handler = async (
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> => {
        try {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                request.method !== "POST" ||
                !url.pathname.endsWith("/v1/messages")
            ) {
                sendError(response, 404, "not found", "not_found");
                return;
            }
            const body = await readBody(request);
            const scripted: ScriptedRequest = {
                model: typeof body.model === "string" ? body.model : "",
                system:
                    typeof body.system === "string" ? body.system : undefined,
                body,
            };
            requests.push(scripted);
            const isReview =
                scripted.system?.startsWith("REVIEW_POLICY") === true;
            let result: ScriptedResponse;
            if (isReview) {
                const tier = scripted.model.includes("strong")
                    ? "strong"
                    : "fast";
                const index = tier === "strong" ? strongIndex++ : fastIndex++;
                result =
                    options.review?.(scripted, tier, index) ?? DEFAULT_REVIEW;
            } else {
                result = options.main(scripted, mainIndex++);
            }
            if (result.kind === "error") {
                sendError(
                    response,
                    result.status,
                    result.message,
                    result.code ?? "scripted_error"
                );
                return;
            }
            if (result.kind === "text") {
                sendText(response, scripted.model, result.text);
                return;
            }
            sendToolCall(
                response,
                scripted.model,
                { name: result.name, arguments: result.arguments },
                requests.length
            );
        } catch (error) {
            if (!response.headersSent) {
                sendError(
                    response,
                    500,
                    error instanceof Error ? error.message : String(error),
                    "scripted_internal"
                );
            } else {
                response.destroy();
            }
        }
    };
    server = createServer((request, response) => {
        void handler(request, response);
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
