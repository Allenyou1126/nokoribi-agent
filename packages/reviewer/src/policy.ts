import { BlockAssembler, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createLogger } from "@nokoribi/shared";

import { REVIEW_POLICY, reviewUserText } from "../vendor/auto-review.js";
import type {
    AutoReviewConfig,
    ReviewAction,
    ReviewDecision,
    ReviewPolicy,
    ReviewSnapshot,
    ReviewerRoute,
} from "./types.js";

const logger = createLogger("reviewer");

const COMMAND_PATTERNS: readonly RegExp[] = [
    /(?:^|[\n;&|()`])\s*sudo(?:\s|$)/,
    /(?:^|[\n;&|()`])\s*doas(?:\s|$)/,
    /(?:^|[\n;&|()`])\s*pkexec(?:\s|$)/,
    /(?:^|[\n;&|()`])\s*su\s+-/,
    /\bnixos-rebuild\b/,
    /\bsystemctl\s+(?:edit|daemon-reload|enable|disable|mask|unmask|start|stop|restart|reload|set-property)\b/,
    /\b(?:useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|visudo|chpasswd)\b/,
    /\bsetcap\b/,
    /\bchmod\s+(?:[0-7]*[4-7][0-7]{3}|[ugoa]*[+=]s)\b/,
    /\bchown\s+(?:root|0)(?::|\s)/,
    /\b(?:mount|umount|swapon|swapoff|modprobe|insmod|rmmod)\b/,
    /\b(?:iptables|nft|ufw|firewall-cmd)\b/,
    /\/etc\/(?:sudoers|systemd|nixos|ssh|passwd|shadow|fstab|hosts|pam\.d)\b/,
    /\bdd\s+[^;\n]*\bof=\/dev\//,
    /\bmkfs(?:\.[a-z0-9]+)?\b/,
    /\b(?:fdisk|parted|gdisk|sfdisk)\b/,
    /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(?:etc|usr|var|boot|nix|home|root)\b/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionText(action: ReviewAction): string {
    const parts: string[] = [action.name];
    const args = action.arguments;
    if (typeof args === "string") {
        parts.push(args);
    } else if (isRecord(args)) {
        for (const key of [
            "command",
            "host",
            "path",
            "file_path",
            "filePath",
            "content",
            "text",
        ]) {
            const value = args[key];
            if (typeof value === "string") parts.push(value);
        }
        if (parts.length === 1) parts.push(JSON.stringify(args));
    } else if (args !== undefined) {
        parts.push(JSON.stringify(args));
    }
    return parts.join("\n");
}

/** Whether an action requires strong review even when fast allows it. */
export function isPrivilegedAction(action: ReviewAction): boolean {
    const text = actionText(action);
    return COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

/** Count members in the raw top-level JSON object. */
function topLevelMemberCount(text: string): number {
    const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, "");
    let depth = 0;
    let count = 0;
    for (const char of syntax) {
        switch (char) {
            case "{":
            case "[":
                depth += 1;
                break;
            case "}":
            case "]":
                depth -= 1;
                break;
            case ":":
                if (depth === 1) count += 1;
                break;
        }
    }
    return count;
}

/** Parse the closed risk/decision protocol and its fixed safety combinations. */
export function parseDecision(text: string): ReviewDecision {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
        throw new Error("reviewer output must be one JSON object");
    }
    const keys = Object.keys(value);
    if (topLevelMemberCount(text) !== keys.length) {
        throw new Error("reviewer output repeats a JSON member");
    }
    const risk = value["risk"];
    const decision = value["decision"];
    if (
        keys.length === 2 &&
        decision === "allow" &&
        (risk === "low" || risk === "medium")
    ) {
        return { risk, decision: "allow" };
    }
    if (
        keys.length === 2 &&
        decision === "deny" &&
        (risk === "medium" || risk === "high")
    ) {
        return { risk, decision: "deny" };
    }
    if (
        decision === "deny" &&
        (risk === "medium" || risk === "high") &&
        keys.length === 3 &&
        Object.hasOwn(value, "reason") &&
        typeof value["reason"] === "string"
    ) {
        return { risk, decision: "deny", reason: value["reason"] };
    }
    throw new Error(
        "reviewer output does not match the risk/decision protocol"
    );
}

/** Consume zero or more reasoning blocks, one JSON text block, and one terminal stop. */
async function readDecision(
    stream: AsyncIterable<import("@deepseek-ai/dsh-llm").StreamChunk>
): Promise<ReviewDecision> {
    const assembler = new BlockAssembler();
    let finished = false;
    for await (const chunk of stream) {
        if (finished) {
            throw new Error("reviewer emitted data after its terminal finish");
        }
        assembler.push(chunk);
        if (chunk.type === "finish") {
            finished = true;
            if (
                chunk.reason.kind === "error" ||
                chunk.reason.kind === "aborted"
            ) {
                const { code, message } = chunk.reason.failure;
                throw new Error(
                    `reviewer ended with ${chunk.reason.kind} ${code}: ${message}`
                );
            }
            if (chunk.reason.kind !== "stop") {
                throw new Error(`reviewer ended with ${chunk.reason.kind}`);
            }
        }
    }
    if (!finished) throw new Error("reviewer emitted no terminal finish");
    const blocks = assembler.blocks();
    const final = blocks.at(-1);
    if (
        final?.type !== "text" ||
        blocks.slice(0, -1).some((block) => block.type !== "reasoning")
    ) {
        throw new Error(
            "reviewer must emit zero or more reasoning blocks followed by exactly one text block"
        );
    }
    return parseDecision(final.text);
}

function abortReason(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason : new Error("reviewer aborted");
}

/** Race a reviewer stream against the combined cancellation/timeout signal. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}

function routeOf(
    route: ReviewerRoute,
    snapshot: ReviewSnapshot
): { provider: string; model: string; reasoningEffort?: string } {
    return {
        provider:
            route.provider.trim() === "" ? snapshot.provider : route.provider,
        model: route.model.trim() === "" ? snapshot.model : route.model,
        ...(route.reasoningEffort === undefined ||
        route.reasoningEffort.trim() === ""
            ? {}
            : { reasoningEffort: route.reasoningEffort }),
    };
}

async function callReviewer(
    llm: import("@deepseek-ai/dsh-llm").LlmRuntime,
    route: ReviewerRoute,
    snapshot: ReviewSnapshot,
    signal: AbortSignal,
    timeoutMs: number,
    stage: "fast" | "strong"
): Promise<ReviewDecision> {
    if (signal.aborted) throw new Error(`${stage} reviewer was aborted`);
    const resolved = routeOf(route, snapshot);
    const deadline = new AbortController();
    const timer = setTimeout(() => {
        deadline.abort(new Error(`timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const startedAt = Date.now();
    const options: GenerateOptions = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined
            ? {}
            : {
                  reasoningEffort:
                      resolved.reasoningEffort as GenerateOptions["reasoningEffort"],
              }),
        system: REVIEW_POLICY,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: reviewUserText(snapshot),
                    },
                ],
            },
        ],
        temperature: 0,
        signal: combined,
    };
    try {
        const decision = await raceSignal(
            readDecision(llm.stream(options)),
            combined
        );
        logger.info("review decision", {
            tool: snapshot.action.name,
            stage,
            risk: decision.risk,
            decision: decision.decision,
            durationMs: Date.now() - startedAt,
        });
        return decision;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("review failed", {
            tool: snapshot.action.name,
            stage,
            durationMs: Date.now() - startedAt,
            error: message,
        });
        throw new Error(`${stage} reviewer failed: ${message}`, {
            cause: error,
        });
    } finally {
        clearTimeout(timer);
    }
}

/** Build the two-tier review policy over one LLM runtime. */
export function createPolicy(
    llm: import("@deepseek-ai/dsh-llm").LlmRuntime,
    config: AutoReviewConfig
): ReviewPolicy {
    return {
        async review(
            snapshot: ReviewSnapshot,
            signal: AbortSignal
        ): Promise<ReviewDecision> {
            const privileged = isPrivilegedAction(snapshot.action);
            const fast = await callReviewer(
                llm,
                config.fast,
                snapshot,
                signal,
                config.timeoutMs,
                "fast"
            );
            if (!privileged && fast.decision === "allow") return fast;
            logger.info(
                privileged
                    ? "privileged action escalated to strong review"
                    : "fast review denied; escalating",
                { tool: snapshot.action.name }
            );
            return await callReviewer(
                llm,
                config.strong,
                snapshot,
                signal,
                config.timeoutMs,
                "strong"
            );
        },
    };
}
