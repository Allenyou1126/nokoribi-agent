import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-tools";

import { formatToolSummary } from "./interaction-format.js";

interface ToolCallData {
    readonly callId?: unknown;
    readonly name?: unknown;
    readonly arguments?: unknown;
}

interface PtcStartData {
    readonly subCallId?: unknown;
    readonly name?: unknown;
    readonly arguments?: unknown;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function argumentsText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value === undefined) return undefined;
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

/**
 * Find the pending tool call in the session log and summarize its arguments.
 * Auto-review passes a native or PTC inner call id; either lifecycle event can
 * carry the action, and a missing record only omits the optional summary.
 */
export function summarizeToolCall(
    agent: Agent,
    callId: string | undefined
): string | undefined {
    if (callId === undefined) return undefined;
    const events = agent.session.snapshotEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (event.type === "tool/call") {
            const data = event.data as unknown as ToolCallData;
            if (data.callId !== callId) continue;
            const name = stringValue(data.name);
            if (name === undefined) return undefined;
            return formatToolSummary(name, argumentsText(data.arguments));
        }
        if (event.type === "tool/ptc-dispatch-start") {
            const data = event.data as unknown as PtcStartData;
            if (data.subCallId !== callId) continue;
            const name = stringValue(data.name);
            if (name === undefined) return undefined;
            return formatToolSummary(name, argumentsText(data.arguments));
        }
    }
    return undefined;
}
