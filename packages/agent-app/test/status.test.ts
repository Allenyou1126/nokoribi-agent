import type { DaemonStatus, FullStatusDetails } from "@nokoribi/channel-core";
import { describe, expect, it } from "vitest";

import {
    formatFullStatus,
    formatSandboxDetail,
    formatStatusSummary,
    normalizeSandboxStatus,
} from "../src/status.js";

const memory = {
    activeEntries: 3,
    archivedEntries: 1,
    invalidEntries: 0,
    bytes: 123,
    pinnedEntries: 2,
    snapshotChars: 456,
    inject: "enabled" as const,
};

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
    memory,
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

/** Internal status field names that must never reach IM text (D186). */
const INTERNAL_FIELD_NAMES =
    /activeCommands|backgroundCommands|terminalSessions|snapshotChars|pinnedEntries|nextOutboxSeq|idleTtlMs|lastUsedAt|childStatus|roundsStarted|outboxLength|pendingInteractions|deferredNotices|agentStatus|lastRestartReason/;

const status: DaemonStatus = {
    version: "0.1.0",
    uptimeSec: 3661,
    mainSessionId: "main-1",
    agentStatus: "idle",
    goals: [{ phase: "active" }, { phase: "complete" }, { phase: "complete" }],
    pendingInteractions: 1,
    outboxLength: 2,
    permission: "auto",
    lastRestartReason: "clean",
    ready: true,
    channels: [{ id: "qq-bot", state: "online" }],
    deferredNotices: 3,
};

describe("status summary", () => {
    it("renders Chinese labels, counts, duration, and channels", () => {
        const text = formatStatusSummary(status, "deepseek/deepseek-chat");
        expect(text.startsWith("📊 运行状态\n")).toBe(true);
        expect(text).toContain("主会话状态：空闲");
        expect(text).toContain("版本：0.1.0 · 已运行 1 小时 1 分");
        expect(text).toContain("主会话：main-1");
        expect(text).toContain("模型：deepseek/deepseek-chat");
        expect(text).toContain("权限：auto（自动审查）");
        expect(text).toContain("Goal：3 个（运行中 1 · 已完成 2）");
        expect(text).toContain(
            "待处理：审批/提问 1 条 · 待发送 2 条 · 延后通知 3 条"
        );
        expect(text).toContain("频道：qq-bot 在线");
        expect(text).toContain("上次重启：正常退出");
        expect(text).not.toMatch(INTERNAL_FIELD_NAMES);
    });

    it("falls back for startup, empty collections, and unknown values", () => {
        const text = formatStatusSummary(
            {
                ...status,
                agentStatus: "starting",
                mainSessionId: null,
                goals: [],
                permission: null,
                lastRestartReason: null,
                channels: [],
                deferredNotices: undefined,
            },
            "p/m"
        );
        expect(text).toContain("主会话状态：启动中");
        expect(text).toContain("主会话：未就绪");
        expect(text).toContain("权限：未就绪");
        expect(text).toContain("Goal：0 个");
        expect(text).toContain("延后通知 0 条");
        expect(text).toContain("频道：（无）");
        expect(text).toContain("上次重启：无记录");
        expect(text).not.toMatch(INTERNAL_FIELD_NAMES);
    });
});

describe("full status", () => {
    it("renders environment, versions, model, memory, and errors", () => {
        const text = formatFullStatus(details);
        expect(text.startsWith("📋 详细状态")).toBe(true);
        expect(text).toContain("工作目录：/work");
        expect(text).toContain("状态文件：/home/state/agent-state.json");
        expect(text).toContain("DSH：0.2.1-rc.3 · 应用：0.1.0");
        expect(text).toContain("上次重启：正常退出");
        expect(text).toContain("主模型：p/m");
        expect(text).toContain(
            "审查模型：快速 p/fast · 强化 p/strong · 超时 30 秒"
        );
        expect(text).toContain(
            "条目：活跃 3 · 归档 1 · 无效 0 · 占用 123 字节"
        );
        expect(text).toContain("快照：已 pin 2 条 · 456 字");
        expect(text).toContain("自动注入：已开启");
        expect(text).toContain("下一条待发送序号：7");
        expect(text).not.toMatch(INTERNAL_FIELD_NAMES);
    });

    it("renders goals, schedules, and sandboxes without raw JSON", () => {
        const text = formatFullStatus(details);
        expect(text).toContain(
            "· goal-a1b：运行中 · 轮次 2/9 · 子会话 空闲 · 模型 p/m · " +
                "沙箱第 2 代（活动命令 0） · 目标：probe"
        );
        expect(text).toContain(
            "· s1：喝水 · 延时提醒 · " +
                "触发 2026-01-01T00:00:00.000Z · 已排定"
        );
        expect(text).toContain(
            "· sandbox:default / main-1：第 1 代 · 目录存在 · " +
                "活动命令 1 · 后台命令 0 · 持久终端 2 · " +
                "空闲回收 2 秒 · 临时包：（无） · 最近使用 无记录"
        );
        expect(text).toContain(
            "· 2026-01-01T00:00:00.000Z 警告 probe：careful"
        );
        expect(text).not.toContain('"generation"');
        expect(text).not.toContain('"dir"');
    });

    it("renders empty sections and failed sandbox reads", () => {
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
        expect(empty).toContain("【Goal】\n（无）");
        expect(empty).toContain("【定时任务】\n（无）");
        expect(empty).toContain("· sandbox:default / main-1：读取失败（boom）");
        expect(empty).toContain("【最近错误】\n（无）");
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

describe("sandbox detail", () => {
    it("describes one sandbox without internal field names", () => {
        const sandbox = normalizeSandboxStatus("sandbox:default", "s", {
            dir: "/sb",
            exists: true,
            generation: 3,
            packages: ["nixpkgs#hello", "nixpkgs#jq"],
            idleTtlMs: 90_000,
            activeCommands: 1,
            backgroundCommands: 2,
            terminalSessions: 1,
            lastUsedAt: "2026-01-01T00:00:00.000Z",
        });
        const text = formatSandboxDetail(sandbox);
        expect(text).toBe(
            "第 3 代 · 目录存在 · 活动命令 1 · 后台命令 2 · " +
                "持久终端 1 · 空闲回收 1 分 30 秒 · " +
                "临时包：2 个（nixpkgs#hello、nixpkgs#jq） · " +
                "最近使用 2026-01-01T00:00:00.000Z"
        );
        expect(text).not.toMatch(/generation|activeCommands|idleTtl/);
    });

    it("keeps the failure reason for a failed read", () => {
        expect(
            formatSandboxDetail({
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
                error: "boom",
            })
        ).toBe("读取失败（boom）");
    });
});
