import type { FullStatusDetails } from "@nokoribi/channel-core";
import { describe, expect, it } from "vitest";

import { formatFullStatus, normalizeSandboxStatus } from "../src/status.js";

const details: FullStatusDetails = {
    workspace: "/work",
    state: "/home/state/agent-state.json",
    lock: "/home/run/agent.lock",
    storage: "/home/storage",
    nextOutboxSeq: 7,
    dshVersion: "0.2.1-rc.3",
    appVersion: "0.1.0",
    model: { provider: "p", model: "m" },
    reviewer: {
        fast: { provider: "p", model: "fast" },
        strong: { provider: "p", model: "strong" },
        timeoutMs: 30000,
    },
    goals: [
        {
            shortId: "goal-a1b",
            sessionId: "goal-a1b2",
            goalId: "g1",
            objective: "probe",
            phase: "active",
            roundsStarted: 2,
            maxGoalRounds: 9,
            model: "p/m",
            childStatus: "idle",
            sandbox: normalizeSandboxStatus("sandbox:default", "goal-a1b2", {
                dir: "/sb",
                exists: true,
                generation: 2,
                packages: ["nixpkgs#hello"],
                idleTtlMs: 1000,
                activeCommands: 0,
                backgroundCommands: 1,
                terminalSessions: 1,
            }),
        },
    ],
    schedules: [
        {
            id: "s1",
            title: "喝水",
            kind: "after",
            scheduledAt: "2026-01-01T00:00:00.000Z",
            state: "scheduled",
        },
    ],
    sandboxes: [
        normalizeSandboxStatus("sandbox:default", "main-1", {
            dir: "/sb-main",
            exists: true,
            generation: 1,
            packages: [],
            idleTtlMs: 2000,
            activeCommands: 1,
            backgroundCommands: 0,
            terminalSessions: 2,
        }),
    ],
    memory: {
        activeEntries: 3,
        archivedEntries: 1,
        invalidEntries: 0,
        bytes: 123,
    },
    recentErrors: [
        {
            at: "2026-01-01T00:00:00.000Z",
            level: "warn",
            module: "probe",
            message: "careful",
        },
    ],
    lastVersion: "0.1.0",
    lastStartedAt: "2026-01-01T00:00:00.000Z",
    restartReason: "clean",
};

describe("full status", () => {
    it("renders goals, schedules, sandboxes, memory, and errors", () => {
        const text = formatFullStatus(details);
        expect(text).toContain("workspace: /work");
        expect(text).toContain("dsh: 0.2.1-rc.3");
        expect(text).toContain(
            "memory: active=3 archived=1 invalid=0 bytes=123"
        );
        expect(text).toContain("goal-a1b phase=active rounds=2/9");
        expect(text).toContain("sandbox=gen=2");
        expect(text).toContain(
            "background=0 terminals=2 ttl=2000 packages=(none)"
        );
        expect(text).toContain("[after] 喝水");
        expect(text).toContain("probe careful");
        expect(text).toContain("reviewer: fast=p/fast strong=p/strong");
    });

    it("renders empty collections and failed sandbox reads", () => {
        const empty = formatFullStatus({
            ...details,
            goals: [],
            schedules: [],
            sandboxes: [
                {
                    host: "sandbox:default",
                    sessionId: "main-1",
                    dir: "",
                    exists: false,
                    generation: 0,
                    packages: [],
                    createdAt: null,
                    lastUsedAt: null,
                    idleTtlMs: 0,
                    activeCommands: 0,
                    backgroundCommands: 0,
                    terminalSessions: 0,
                    error: "boom",
                },
            ],
            recentErrors: [],
        });
        expect(empty).toContain("goals:\n- (none)");
        expect(empty).toContain("schedules:\n- (none)");
        expect(empty).toContain("sandbox:default/main-1 error=boom");
        expect(empty).toContain("recentErrors:\n- (none)");
    });

    it("normalizes malformed provider status safely", () => {
        expect(normalizeSandboxStatus("sandbox:default", "s", "bad")).toEqual({
            host: "sandbox:default",
            sessionId: "s",
            dir: "",
            exists: false,
            generation: 0,
            packages: [],
            createdAt: null,
            lastUsedAt: null,
            idleTtlMs: 0,
            activeCommands: 0,
            backgroundCommands: 0,
            terminalSessions: 0,
        });
    });
});
