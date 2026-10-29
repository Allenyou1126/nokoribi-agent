import type { LlmRuntime, StreamChunk } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";
import {
    createPolicy,
    isPrivilegedAction,
    parseDecision,
} from "../src/policy.js";
import type {
    AutoReviewConfig,
    ReviewAction,
    ReviewSnapshot,
} from "../src/types.js";

function snapshot(action?: Partial<ReviewAction>): ReviewSnapshot {
    return {
        provider: "main-provider",
        model: "main-model",
        cwd: "/workspace",
        projectInstructions: [],
        history: [],
        action: {
            mode: "native",
            name: "bash",
            description: "Run a command",
            parameters: { type: "object" },
            arguments: { command: "echo hi" },
            ...action,
        },
    };
}

function textStream(text: string): AsyncIterable<StreamChunk> {
    return (async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text },
        };
        yield { type: "finish", reason: { kind: "stop" } };
    })();
}

interface FakeLlm {
    readonly llm: LlmRuntime;
    readonly calls: {
        provider: string;
        model: string;
        text: string;
    }[];
}

function fakeLlm(respond: (model: string) => string, delayMs = 0): FakeLlm {
    const calls: FakeLlm["calls"] = [];
    const llm = {
        stream(options: {
            provider: string;
            model: string;
            messages: unknown;
        }) {
            calls.push({
                provider: options.provider,
                model: options.model,
                text: JSON.stringify(options.messages),
            });
            if (delayMs === 0) return textStream(respond(options.model));
            return (async function* () {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                yield* textStream(respond(options.model));
            })();
        },
    } as unknown as LlmRuntime;
    return { llm, calls };
}

const config: AutoReviewConfig = {
    fast: { provider: "fast-provider", model: "fast-model" },
    strong: { provider: "strong-provider", model: "strong-model" },
    timeoutMs: 500,
    exemptTools: [],
};

describe("parseDecision", () => {
    it("accepts the closed protocol", () => {
        expect(parseDecision('{"risk":"low","decision":"allow"}')).toEqual({
            risk: "low",
            decision: "allow",
        });
        expect(
            parseDecision('{"risk":"medium","decision":"deny","reason":"no"}')
        ).toEqual({
            risk: "medium",
            decision: "deny",
            reason: "no",
        });
    });

    it("rejects invalid combinations and duplicate members", () => {
        expect(() => parseDecision('{"risk":"low","decision":"deny"}')).toThrow(
            /protocol/
        );
        expect(() =>
            parseDecision('{"risk":"high","decision":"allow"}')
        ).toThrow(/protocol/);
        expect(() =>
            parseDecision('{"risk":"low","decision":"allow","reason":"why"}')
        ).toThrow(/protocol/);
        expect(() =>
            parseDecision('{"risk":"low","risk":"low","decision":"allow"}')
        ).toThrow(/repeats/);
        expect(() => parseDecision("not json")).toThrow();
    });
});

describe("isPrivilegedAction", () => {
    it.each([
        "sudo apt-get install x",
        "echo hi && sudo systemctl restart nginx",
        "nixos-rebuild switch",
        "systemctl edit nokoribi-agent",
        "visudo",
        "chmod 4755 /tmp/tool",
        "dd if=/dev/zero of=/dev/sda",
        "rm -rf /etc",
    ])("escalates %s", (command) => {
        expect(
            isPrivilegedAction(snapshot({ arguments: { command } }).action)
        ).toBe(true);
    });

    it.each([
        "npm run build",
        "git status",
        "git push --force-with-lease",
        "systemctl status nokoribi-agent",
        "chmod 755 /tmp/tool",
        "echo 'use sudo carefully'",
    ])("does not escalate %s", (command) => {
        expect(
            isPrivilegedAction(snapshot({ arguments: { command } }).action)
        ).toBe(false);
    });

    it("escalates sensitive paths and command fields", () => {
        expect(
            isPrivilegedAction(
                snapshot({
                    name: "write",
                    arguments: { path: "/etc/sudoers", content: "x" },
                }).action
            )
        ).toBe(true);
        expect(
            isPrivilegedAction(
                snapshot({
                    name: "write",
                    arguments: { path: "/workspace/README.md" },
                }).action
            )
        ).toBe(false);
    });
});

describe("createPolicy", () => {
    it("allows without strong review when fast allows", async () => {
        const fake = fakeLlm(() => '{"risk":"low","decision":"allow"}');
        const policy = createPolicy(fake.llm, config);
        const decision = await policy.review(
            snapshot(),
            new AbortController().signal
        );
        expect(decision).toEqual({ risk: "low", decision: "allow" });
        expect(fake.calls.map((call) => call.model)).toEqual(["fast-model"]);
    });

    it("protects a fast denial with strong allow", async () => {
        const fake = fakeLlm((model) =>
            model === "fast-model"
                ? '{"risk":"medium","decision":"deny","reason":"needs review"}'
                : '{"risk":"medium","decision":"allow"}'
        );
        const policy = createPolicy(fake.llm, config);
        const decision = await policy.review(
            snapshot(),
            new AbortController().signal
        );
        expect(decision).toEqual({ risk: "medium", decision: "allow" });
        expect(fake.calls.map((call) => call.model)).toEqual([
            "fast-model",
            "strong-model",
        ]);
    });

    it("returns a strong denial", async () => {
        const fake = fakeLlm(() =>
            JSON.stringify({
                risk: "medium",
                decision: "deny",
                reason: "irreversible",
            })
        );
        const policy = createPolicy(fake.llm, config);
        const decision = await policy.review(
            snapshot(),
            new AbortController().signal
        );
        expect(decision).toEqual({
            risk: "medium",
            decision: "deny",
            reason: "irreversible",
        });
        expect(fake.calls).toHaveLength(2);
    });

    it("still requires strong review after fast allows a privileged action", async () => {
        const fake = fakeLlm(() => '{"risk":"medium","decision":"allow"}');
        const policy = createPolicy(fake.llm, config);
        const decision = await policy.review(
            snapshot({ arguments: { command: "sudo true" } }),
            new AbortController().signal
        );
        expect(decision).toEqual({ risk: "medium", decision: "allow" });
        expect(fake.calls.map((call) => call.model)).toEqual([
            "fast-model",
            "strong-model",
        ]);
    });

    it("fails closed on malformed fast output without strong retry", async () => {
        const fake = fakeLlm(() => "not json");
        const policy = createPolicy(fake.llm, config);
        await expect(
            policy.review(snapshot(), new AbortController().signal)
        ).rejects.toThrow(/fast reviewer failed/);
        expect(fake.calls).toHaveLength(1);
    });

    it("fails closed when strong review fails after a fast denial", async () => {
        let calls = 0;
        const llm = {
            stream: () =>
                textStream(
                    calls++ === 0
                        ? '{"risk":"medium","decision":"deny","reason":"check"}'
                        : "not json"
                ),
        } as unknown as LlmRuntime;
        const policy = createPolicy(llm, config);
        await expect(
            policy.review(snapshot(), new AbortController().signal)
        ).rejects.toThrow(/strong reviewer failed/);
        expect(calls).toBe(2);
    });

    it("fails closed on reviewer timeout", async () => {
        const fake = fakeLlm(() => '{"risk":"low","decision":"allow"}', 1000);
        const policy = createPolicy(fake.llm, {
            ...config,
            timeoutMs: 10,
        });
        await expect(
            policy.review(snapshot(), new AbortController().signal)
        ).rejects.toThrow(/timed out/);
    });
});

describe("Config", () => {
    it("applies the reviewer timeout default", () => {
        const parsed = Config({
            fast: { provider: "p", model: "m" },
            strong: { provider: "p", model: "m2" },
        }) as unknown as AutoReviewConfig;
        expect(parsed.timeoutMs).toBe(30000);
    });
});
