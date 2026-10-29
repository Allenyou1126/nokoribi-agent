import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TerminalSessionSnapshot } from "@deepseek-ai/dsh-terminal";
import { describe, expect, it } from "vitest";

import {
    killTerminalsForAgent,
    killTerminalsForSession,
    type CleanupLogger,
    type TerminalCleanupAgents,
    type TerminalCleanupContext,
    type TerminalCleanupTerminals,
} from "../src/terminal-cleanup.js";

interface RecordingLogger extends CleanupLogger {
    readonly warnings: string[];
}

function recordingLogger(): RecordingLogger {
    const warnings: string[] = [];
    return {
        debug: () => undefined,
        warn: (message) => {
            warnings.push(message);
        },
        warnings,
    };
}

function fakeAgent(id: string): Agent {
    return { id } as unknown as Agent;
}

function snapshot(id: string): TerminalSessionSnapshot {
    return {
        sessionId: id as TerminalSessionSnapshot["sessionId"],
        type: "local",
        status: { kind: "running" },
    };
}

interface FakeServices {
    readonly terminals?: TerminalCleanupTerminals;
    readonly agents?: TerminalCleanupAgents;
}

function fakeContext(services: FakeServices): TerminalCleanupContext {
    return {
        get(name: "terminals" | "agents") {
            return name === "terminals" ? services.terminals : services.agents;
        },
    } as unknown as TerminalCleanupContext;
}

describe("terminal cleanup", () => {
    it("is a no-op when the terminal service is not mounted", async () => {
        const agent = fakeAgent("main-1");
        await expect(
            killTerminalsForAgent(fakeContext({}), agent)
        ).resolves.toBeUndefined();
        const agents: TerminalCleanupAgents = { get: () => agent };
        await expect(
            killTerminalsForSession(fakeContext({ agents }), "main-1")
        ).resolves.toBeUndefined();
    });

    it("kills every snapshot owned by the agent", async () => {
        const agent = fakeAgent("main-1");
        const listed: Agent[] = [];
        const killed: {
            readonly owner: Agent;
            readonly sessionId: string;
            readonly reason: string | undefined;
        }[] = [];
        const terminals: TerminalCleanupTerminals = {
            list(owner) {
                listed.push(owner);
                return [snapshot("pty-1"), snapshot("pty-2")];
            },
            async kill(owner, id, reason) {
                killed.push({
                    owner,
                    sessionId: String(id),
                    reason,
                });
                return true;
            },
        };
        const logger = recordingLogger();
        await killTerminalsForAgent(fakeContext({ terminals }), agent, {
            logger,
        });
        expect(listed).toEqual([agent]);
        expect(killed.map((call) => call.sessionId)).toEqual([
            "pty-1",
            "pty-2",
        ]);
        expect(killed.every((call) => call.owner === agent)).toBe(true);
        expect(killed.every((call) => call.reason === "cleanup")).toBe(true);
        expect(logger.warnings).toEqual([]);
    });

    it("resolves the live owner before killing session terminals", async () => {
        const agent = fakeAgent("main-1");
        let lookups = 0;
        let lists = 0;
        const killed: string[] = [];
        const agents: TerminalCleanupAgents = {
            get(id) {
                lookups += 1;
                return String(id) === "main-1" ? agent : undefined;
            },
        };
        const terminals: TerminalCleanupTerminals = {
            list(owner) {
                lists += 1;
                return owner === agent ? [snapshot("pty-9")] : [];
            },
            async kill(owner, id) {
                killed.push(`${owner.id}:${String(id)}`);
                return true;
            },
        };
        const ctx = fakeContext({ terminals, agents });
        await killTerminalsForSession(ctx, "main-1");
        expect(lookups).toBe(1);
        expect(lists).toBe(1);
        expect(killed).toEqual(["main-1:pty-9"]);

        await killTerminalsForSession(ctx, "missing");
        expect(lookups).toBe(2);
        expect(lists).toBe(1);
        expect(killed).toEqual(["main-1:pty-9"]);
    });

    it("matches the owner snapshots by exact agent identity", async () => {
        const agent = fakeAgent("main-1");
        const other = fakeAgent("goal-1");
        const killed: string[] = [];
        const terminals: TerminalCleanupTerminals = {
            list(owner) {
                if (owner !== agent) return [];
                return [snapshot("pty-a")];
            },
            async kill(owner, id) {
                killed.push(`${owner.id}:${String(id)}`);
                return true;
            },
        };
        const ctx = fakeContext({ terminals });
        await killTerminalsForAgent(ctx, other);
        expect(killed).toEqual([]);
        await killTerminalsForAgent(ctx, agent);
        expect(killed).toEqual(["main-1:pty-a"]);
    });

    it("tolerates kill failures and bounds an unresponsive kill", async () => {
        const agent = fakeAgent("main-1");
        const attempted: string[] = [];
        const terminals: TerminalCleanupTerminals = {
            list() {
                return [
                    snapshot("pty-fail"),
                    snapshot("pty-hang"),
                    snapshot("pty-never"),
                ];
            },
            async kill(_owner, id) {
                attempted.push(String(id));
                if (String(id) === "pty-fail") {
                    throw new Error("backend gone");
                }
                return await new Promise<boolean>(() => undefined);
            },
        };
        const logger = recordingLogger();
        const started = Date.now();
        await killTerminalsForAgent(fakeContext({ terminals }), agent, {
            logger,
            timeoutMs: 30,
        });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(attempted).toEqual(["pty-fail", "pty-hang"]);
        expect(logger.warnings).toContain("failed to kill terminal session");
        expect(logger.warnings).toContain("terminal cleanup timed out");
    });

    it("warns instead of throwing when listing terminals fails", async () => {
        const terminals: TerminalCleanupTerminals = {
            list() {
                throw new Error("registry unavailable");
            },
            async kill() {
                return false;
            },
        };
        const logger = recordingLogger();
        await expect(
            killTerminalsForAgent(fakeContext({ terminals }), fakeAgent("a"), {
                logger,
            })
        ).resolves.toBeUndefined();
        expect(logger.warnings).toContain("terminal cleanup failed");
    });
});
