import { describe, expect, it } from "vitest";

import {
    AGENT_STATUS_LABELS,
    formatBytes,
    formatDuration,
    GOAL_PHASE_LABELS,
    labelOf,
} from "../src/labels.js";

describe("labelOf", () => {
    it("returns the mapped Chinese label", () => {
        expect(labelOf(AGENT_STATUS_LABELS, "running")).toBe("运行中");
        expect(labelOf(GOAL_PHASE_LABELS, "complete")).toBe("已完成");
    });

    it("keeps an unmapped code visible instead of dropping it", () => {
        expect(labelOf(GOAL_PHASE_LABELS, "archived")).toBe("未知（archived）");
        expect(labelOf(GOAL_PHASE_LABELS, "  ")).toBe("未知");
    });
});

describe("formatDuration", () => {
    it("renders seconds, minutes, hours, and days", () => {
        expect(formatDuration(0)).toBe("不到 1 秒");
        expect(formatDuration(-5)).toBe("不到 1 秒");
        expect(formatDuration(Number.NaN)).toBe("不到 1 秒");
        expect(formatDuration(59)).toBe("59 秒");
        expect(formatDuration(60)).toBe("1 分");
        expect(formatDuration(61)).toBe("1 分 1 秒");
        expect(formatDuration(3600)).toBe("1 小时");
        expect(formatDuration(3661)).toBe("1 小时 1 分");
        expect(formatDuration(86_400)).toBe("1 天");
        expect(formatDuration(90_000)).toBe("1 天 1 小时");
    });
});

describe("formatBytes", () => {
    it("renders bytes, KiB, and MiB", () => {
        expect(formatBytes(0)).toBe("0 字节");
        expect(formatBytes(-1)).toBe("0 字节");
        expect(formatBytes(1023)).toBe("1023 字节");
        expect(formatBytes(1024)).toBe("1.0 KiB");
        expect(formatBytes(1536)).toBe("1.5 KiB");
        expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    });
});
