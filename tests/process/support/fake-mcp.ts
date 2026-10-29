/**
 * Zero-dependency fake MCP server for M13 process tests.
 *
 * Runs as a stdio child of `@deepseek-ai/dsh-mcp-client` and speaks
 * newline-delimited JSON-RPC 2.0 implementing the subset the client needs:
 * initialize, notifications/initialized, tools/list and tools/call. The exposed
 * `echo` tool returns `echo:<text>` so a process test can prove that the
 * model-facing `mcp__fake__echo` bridge executed a real round trip.
 *
 * Kept as plain JavaScript syntax inside a `.ts` file so Node 24 can run it
 * directly with type stripping (no build step, no dependencies).
 */
import { createInterface } from "node:readline";

/** Tools the fake server advertises. */
const tools = [
    {
        name: "echo",
        description: "Echo the given text back with a prefix.",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
        },
    },
];

/** Write one JSON-RPC frame. */
function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Reply to a request, preserving the request id. */
function respond(id, result) {
    send({ jsonrpc: "2.0", id, result });
}

/** Reply with a JSON-RPC error. */
function failRequest(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

const input = createInterface({ input: process.stdin });
input.on("close", () => {
    process.exit(0);
});

input.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (message === null || typeof message !== "object") return;
    // Notifications (including notifications/initialized) have no id.
    if (message.id === undefined || message.id === null) return;
    const id = message.id;
    switch (message.method) {
        case "initialize": {
            const requested = message.params?.protocolVersion;
            respond(id, {
                protocolVersion:
                    typeof requested === "string" ? requested : "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-mcp", version: "0.0.0" },
            });
            break;
        }
        case "ping":
            respond(id, {});
            break;
        case "tools/list":
            respond(id, { tools });
            break;
        case "tools/call": {
            const name = message.params?.name;
            const args = message.params?.arguments ?? {};
            if (name !== "echo") {
                failRequest(id, -32602, `unknown tool ${String(name)}`);
                break;
            }
            respond(id, {
                content: [
                    {
                        type: "text",
                        text: `echo:${String(args.text ?? "")}`,
                    },
                ],
            });
            break;
        }
        default:
            failRequest(
                id,
                -32601,
                `method not found: ${String(message.method)}`
            );
    }
});
